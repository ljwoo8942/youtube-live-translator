import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import ts from "typescript";
import { getVideoPage, isChzzkVideoId, VIDEO_SITE_MATCHES } from "../src/shared/videoSites.ts";

function functions(path, names, context) {
  const source = ts.createSourceFile(path, readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const selected = source.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(selected.length, names.length);
  vm.runInNewContext(ts.transpileModule(selected.map((node) => node.getText(source).replace(/^export /, "")).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText.replaceAll("exports.", "globalThis."), context);
  return context;
}

test("lyric streaming uses the selected language and leaves automatic language detection available", () => {
  const { streamUrl } = functions("src/offscreen/index.ts", ["streamUrl"], { URL });
  const config = { endpoint: "ws://127.0.0.1:8765/v1/audio/stream", contentMode: "lyrics", model: "qwen3-asr-1.7b" };
  assert.equal(new URL(streamUrl({ ...config, sourceLanguage: "ja" })).searchParams.get("language"), "ja");
  assert.equal(new URL(streamUrl({ ...config, sourceLanguage: "auto" })).searchParams.get("language"), null);
});

function streamHarness() {
  const pending = [], sent = [];
  const context = functions("src/background/index.ts", ["translateStreamSegment", "translateQueuedStreamSegment", "audioRequestController"], {
    AbortController, streamTranslationQueuesByTab: new Map(), audioRequestControllers: new Map(),
    activeAudioTabId: 1, activeAudioVideoId: "v",
    loadSettingsSnapshot: async () => ({ settings: { enabled: true }, translationConfigRevision: 1 }),
    matchUserCorrection: async () => undefined,
    segmentWithAudioContext: (_, segment) => segment,
    translateAndRespond: (segment, signal) => new Promise((resolve) => pending.push({ segment, signal, resolve })),
    notifyTab: async (_, message) => sent.push(message), rememberAudioContext() {},
    isBlockedHallucinationError: () => false, shouldStopCaptureAfterApiError: () => false
  });
  return { context, pending, sent };
}
const segment = (id) => ({ id, text: `speech ${id}`, source: "audioStt", startMs: 0, endMs: 1000 });
const result = (text) => ({ ok: true, translatedText: text, provider: "test" });

test("audio start accepts CHZZK playback and rejects a listing, stale video ID or unrelated origin", async () => {
  let url = "https://chzzk.naver.com/video/123456?from=live";
  let permissionChecks = 0;
  const c = functions("src/background/index.ts", ["startAudioCaptureInternal"], {
    getVideoPage, isChzzkVideoId,
    getTabUrl: async () => url,
    ensureTabCapturePermission: async () => { permissionChecks++; return false; }
  });
  const accepted = await c.startAudioCaptureInternal(7, undefined, "chzzk:video:123456");
  assert.match(accepted.error, /캡처 권한/);
  assert.equal(permissionChecks, 1);
  assert.equal((await c.startAudioCaptureInternal(7, undefined, "chzzk:video:654321")).ok, false);
  url = "https://chzzk.naver.com/lives";
  assert.equal((await c.startAudioCaptureInternal(7, undefined, "chzzk:video:123456")).ok, false);
  url = "https://chzzk.naver.com.example.com/video/123456";
  assert.equal((await c.startAudioCaptureInternal(7, undefined, "chzzk:video:123456")).ok, false);
  assert.equal(permissionChecks, 1);
});

test("a CHZZK capture keeps its lease on another CHZZK video and stops on listings or site changes", async () => {
  const stopped = [];
  const oldVideoId = "chzzk:video:123456";
  const c = functions("src/background/index.ts", ["stopAudioCaptureOutsideVideoSite", "stopStaleAudioCaptureOnStartup"], {
    getVideoPage, isChzzkVideoId, activeAudioTabId: 7, activeAudioVideoId: oldVideoId,
    stopAudioCapture: async (...args) => stopped.push(args),
    getTabUrl: async () => "https://www.youtube.com/watch?v=example",
    getOffscreenAudioState: async () => ({ recording: true, activeTabId: 7, activeVideoId: oldVideoId })
  });
  await c.stopAudioCaptureOutsideVideoSite(7, `https://chzzk.naver.com/live/${"a".repeat(32)}`);
  assert.deepEqual(stopped, []);
  await c.stopAudioCaptureOutsideVideoSite(7, "https://chzzk.naver.com/lives");
  assert.deepEqual(stopped, [[7, oldVideoId]]);
  c.activeAudioTabId = c.activeAudioVideoId = undefined;
  await c.stopStaleAudioCaptureOnStartup();
  assert.deepEqual(stopped, [[7, oldVideoId], [7, oldVideoId]]);
});

test("CHZZK hybrid mode starts audio after playback begins and caption-only mode stays silent", async () => {
  const requests = [];
  const videoId = "chzzk:video:123456";
  let playing = false;
  const c = functions("src/content/index.ts", ["startAudioFallbackIfNeeded", "shouldStartAudioFallback"], {
    isYouTubeSite: false, activeVideoId: videoId, currentWatchVideoId: () => videoId,
    settings: { enabled: true, inputMode: "captionsThenAudio" }, document: { visibilityState: "visible" },
    audioCaptureRequested: false, audioCaptureSuppressed: false, audioStopRequested: false,
    stoppingAudioCapture: false, manualAudioStartPendingUntil: 0, audioStartBlockedUntil: 0,
    videoCanProduceAudio: () => playing, setAudioControlStatus: () => {},
    chrome: { runtime: { sendMessage: async (message) => { requests.push(message); return { ok: true }; } } }
  });
  await c.startAudioFallbackIfNeeded();
  playing = true;
  c.settings.inputMode = "captions";
  await c.startAudioFallbackIfNeeded();
  assert.equal(requests.length, 0);
  c.settings.inputMode = "captionsThenAudio";
  await c.startAudioFallbackIfNeeded();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, "START_AUDIO_CAPTURE");
  assert.equal(requests[0].videoId, videoId);
});

test("continuous input does not starve slow translations and only the latest partial waits", async () => {
  const { context: c, pending, sent } = streamHarness();
  const task = c.translateStreamSegment(1, "v", segment("first"), false, 1);
  await setImmediate();
  for (let i = 0; i < 6; i++) await c.translateStreamSegment(1, "v", segment(String(i)), false, 1);
  assert.equal(pending.length, 1);
  pending[0].resolve(result("first completed"));
  await setImmediate();
  assert.equal(sent[0].translatedText, "first completed");
  assert.equal(pending.length, 2);
  assert.equal(pending[1].segment.id, "5");
  pending[1].resolve(result("latest"));
  await task;
  assert.equal(sent.length, 2);
  assert.equal(sent[1].translationConfigRevision, 1);
  assert.equal(c.streamTranslationQueuesByTab.size, 0);
});

test("a final transcript waits ahead of newer partials without being overwritten", async () => {
  const { context: c, pending, sent } = streamHarness();
  const task = c.translateStreamSegment(1, "v", segment("start"), false, 1);
  await setImmediate();
  await c.translateStreamSegment(1, "v", segment("final"), true, 1);
  await c.translateStreamSegment(1, "v", segment("next"), false, 1);
  pending[0].resolve(result("start"));
  await setImmediate();
  assert.equal(pending[1].segment.id, "final");
  pending[1].resolve(result("final"));
  await setImmediate();
  assert.equal(pending[2].segment.id, "next");
  pending[2].resolve(result("next"));
  await task;
  assert.equal(sent[1].provider, "test");
});

test("an old session response cannot enter a restarted session for the same video", async () => {
  const { context: c, pending, sent } = streamHarness();
  const old = c.translateStreamSegment(1, "v", segment("old"), false, 1);
  await setImmediate();
  c.audioRequestControllers.get(1).abort();
  c.audioRequestControllers.delete(1);
  c.streamTranslationQueuesByTab.delete(1);
  const current = c.translateStreamSegment(1, "v", segment("new"), false, 1);
  await setImmediate();
  pending[0].resolve(result("stale"));
  pending[1].resolve(result("current"));
  await Promise.all([old, current]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].translatedText, "current");
});

test("queued work from old translation settings never starts a provider request", async () => {
  const { context: c, pending, sent } = streamHarness();
  await c.translateStreamSegment(1, "v", segment("old settings"), true, 0);
  assert.equal(pending.length, 0);
  assert.equal(sent.length, 0);
});

test("cache pruning removes expired records and the oldest excess records", async () => {
  const now = Date.now();
  const records = [now - 100, now - 9, now - 8, now - 7, now - 6];
  const removed = [];
  let position = 0;
  const store = {
    count() { const request = { result: records.length }; queueMicrotask(() => request.onsuccess()); return request; },
    index() {
      return { openCursor() {
        const request = {};
        const step = () => {
          request.result = position < records.length ? {
            key: records[position], delete() { removed.push(records[position]); },
            continue() { position++; queueMicrotask(step); }
          } : null;
          request.onsuccess();
        };
        queueMicrotask(step);
        return request;
      } };
    }
  };
  const c = functions("src/background/captionCache.ts", ["pruneCaptionCache"], {
    CACHE_MAX_ENTRIES: 2, CACHE_MAX_AGE_MS: 50, Date: { now: () => now }
  });
  await c.pruneCaptionCache(store);
  assert.deepEqual(removed, records.slice(0, 3));
  removed.length = 0;
  position = 0;
  c.CACHE_MAX_ENTRIES = 10;
  await c.pruneCaptionCache(store);
  assert.deepEqual(removed, [records[0]]);
});

test("unavailable IndexedDB cannot stop translating or publishing a completed translation", async () => {
  const c = functions("src/background/captionCache.ts", ["getCachedCaptionTranslations", "putCachedCaptionTranslations"], {
    openDb: async () => { throw new Error("quota / unavailable"); }, console: { warn() {} }
  });
  assert.equal((await c.getCachedCaptionTranslations({}, [segment("one")])).size, 0);
  await c.putCachedCaptionTranslations({}, [{ id: "one", translatedText: "valid" }], [segment("one")]);
});

test("cancelling pretranslation keeps the same visible translation request alive", async () => {
  let finish, providerSignal, calls = 0;
  const c = functions("src/background/index.ts", ["translateAndRespond"], {
    AbortController, translationInFlight: new Map(), hasCorruptedSubtitleText: () => false,
    cacheKey: () => "same", getMemoryCachedTranslation: () => undefined, rememberTranslation() {},
    sanitizeTranslatedSubtitle: (_, text) => text, getErrorMessage: (error) => error.message,
    translateSegment: async (_, __, ___, signal) => {
      calls++; providerSignal = signal;
      return new Promise((resolve, reject) => {
        finish = () => resolve({ translatedText: "shared", provider: "test" });
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  });
  const a = new AbortController(), b = new AbortController();
  const settings = { enabled: true, contentMode: "spoken" };
  const pretranslation = c.translateAndRespond(segment("same"), a.signal, settings);
  const visible = c.translateAndRespond(segment("same"), b.signal, settings);
  a.abort();
  await assert.rejects(pretranslation, { name: "AbortError" });
  assert.equal(providerSignal.aborted, false);
  finish();
  assert.equal((await visible).translatedText, "shared");
  assert.equal(calls, 1);
  assert.equal(c.translationInFlight.size, 0);
});

test("closing the last translation consumer aborts the provider fetch", async () => {
  let providerSignal;
  const c = functions("src/background/index.ts", ["translateAndRespond"], {
    AbortController, translationInFlight: new Map(), hasCorruptedSubtitleText: () => false,
    cacheKey: () => "same", getMemoryCachedTranslation: () => undefined,
    getErrorMessage: (error) => error.message,
    translateSegment: (_, __, ___, signal) => {
      providerSignal = signal;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
  });
  const controller = new AbortController();
  const request = c.translateAndRespond(segment("same"), controller.signal, { enabled: true });
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  assert.equal(providerSignal.aborted, true);
  assert.equal(c.translationInFlight.size, 0);
});

test("the first changed-settings broadcast cancels work in a restarted service worker", async () => {
  const caption = new AbortController(), audio = new AbortController(), job = new AbortController();
  const c = functions("src/background/index.ts", ["broadcastContentSettings"], {
    lastBroadcastSettingsRevision: -1, lastTranslationConfigRevision: undefined,
    captionRequestControllers: new Map([[1, caption]]), audioRequestControllers: new Map([[1, audio]]),
    pretranslateJobs: new Map([["job", { controller: job, cancelled: false }]]),
    clearAudioQueue: () => audio.abort(), chrome: { tabs: { query: async () => [] } },
    VIDEO_SITE_MATCHES, toContentSettings: (settings) => settings, notifyTab: async () => {}
  });
  await c.broadcastContentSettings({ enabled: true }, 2, 1);
  assert.equal(caption.signal.aborted, true);
  assert.equal(audio.signal.aborted, true);
  assert.equal(job.signal.aborted, true);
});

test("pretranslation cancelled during lyrics assistance cannot admit a stale API job", async () => {
  const admission = new AbortController();
  let finish;
  const c = functions("src/background/index.ts", ["handlePretranslateCaptions"], {
    captionRequestController: () => admission, lastTranslationConfigRevision: undefined,
    loadSettingsSnapshot: async () => ({ settings: { enabled: true, pretranslateEnabled: true }, translationConfigRevision: 1 }),
    addCaptionLyricsAssist: () => new Promise((resolve) => { finish = resolve; })
  });
  const request = c.handlePretranslateCaptions({ videoId: "v", translationConfigRevision: 1, segments: [] }, 1);
  await setImmediate();
  admission.abort();
  finish([]);
  assert.equal((await request).ok, false);
});

function audioStopHarness({ liveTabs = [], state, activeTab, activeVideo, offscreen = false } = {}) {
  const sent = [], notices = [], cleared = [], cancelled = [];
  const context = functions("src/background/index.ts", ["stopAudioCaptureInternal", "getOffscreenAudioState"], {
    activeAudioTabId: activeTab, activeAudioVideoId: activeVideo,
    liveCapturedTabIds: async () => liveTabs,
    hasOffscreenDocument: async () => offscreen,
    chrome: { runtime: { sendMessage: async (message) => {
      if (message.type === "GET_OFFSCREEN_AUDIO_STATE") return state ? { ok: true, ...state } : undefined;
      sent.push(message);
      return { ok: true };
    } } },
    notifyTab: async (tabId, message) => notices.push({ tabId, message }),
    clearAudioQueue: (tabId) => cleared.push(tabId), loadSettings: async () => ({ enabled: false }),
    cancelTabPretranslationJobs: (tabId) => cancelled.push(tabId)
  });
  return { context, sent, notices, cleared, cancelled };
}

test("stopping before the first audio session is an idempotent success", async () => {
  for (const offscreen of [false, true]) {
    const { context: c, sent, cleared } = audioStopHarness({ offscreen });
    assert.equal((await c.stopAudioCaptureInternal()).ok, true);
    assert.equal((await c.stopAudioCaptureInternal()).ok, true);
    assert.equal(sent.length, offscreen ? 2 : 0);
    assert.equal(cleared.length, 0);
  }
});

test("disabling or saving caption-only settings succeeds without an offscreen session", async () => {
  for (const settings of [{ enabled: false, inputMode: "captionsThenAudio" }, { enabled: true, inputMode: "captions" }]) {
    const { context: c, sent } = audioStopHarness();
    functions("src/background/index.ts", ["saveSettingsPatch"], c);
    const snapshot = { settings, revision: 2, translationConfigRevision: 1 };
    c.patchSettings = async () => snapshot;
    c.pretranslateJobs = new Map();
    c.correctionSessionsByTab = new Map();
    c.broadcastContentSettings = async () => {};
    c.stopAudioCapture = () => c.stopAudioCaptureInternal();
    assert.equal(await c.saveSettingsPatch(settings), snapshot);
    assert.equal(sent.length, 0);
  }
});

test("a missing offscreen response still cleans up the background audio session", async () => {
  const { context: c, notices, cleared, cancelled } = audioStopHarness({ activeTab: 7, activeVideo: "video" });
  assert.equal((await c.stopAudioCaptureInternal()).ok, true);
  assert.equal(c.activeAudioTabId, undefined);
  assert.equal(c.activeAudioVideoId, undefined);
  assert.deepEqual(cleared, [7]);
  assert.deepEqual(cancelled, [7]);
  assert.equal(notices[0].message.videoId, "video");
});

test("an idle offscreen document is stopped even when no capture tab is recorded", async () => {
  const { context: c, sent } = audioStopHarness({ state: { recording: false }, offscreen: true });
  assert.equal((await c.stopAudioCaptureInternal()).ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "STOP_AUDIO_CAPTURE");
  assert.equal(sent[0].target, "offscreen");
});

test("stale stop commands cannot terminate a newer video session", async () => {
  const { context: c, sent, cleared } = audioStopHarness({
    liveTabs: [7], activeTab: 7, activeVideo: "old-video", offscreen: true,
    state: { recording: true, activeTabId: 7, activeVideoId: "new-video" }
  });
  assert.equal((await c.stopAudioCaptureInternal(7, "old-video")).ok, true);
  assert.equal(sent.length, 0);
  assert.equal(cleared.length, 0);
  assert.equal((await c.stopAudioCaptureInternal(7, "new-video")).ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].videoId, "new-video");
  assert.deepEqual(cleared, [7]);
});

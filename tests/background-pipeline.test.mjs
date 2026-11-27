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

test("the popup requests only the needed permissions from the click before awaiting the active tab", async () => {
  const url = "https://chzzk.naver.com/video/123456";
  const page = getVideoPage(url);
  const requested = [];
  let tabUrl = url;
  const popup = functions("src/popup/index.ts", ["ensureTabCapturePermission", "prepareAudioCapture"], {
    currentTabId: 7, currentTabPage: page, settings: { sttProvider: "whisper" },
    needsNativeSttPermission: true, usesNativeSttEndpoint: ({ sttProvider }) => sttProvider === "whisper",
    activeTab: async () => ({ id: 7, url: tabUrl }), getVideoPage,
    chrome: {
      permissions: {
        request({ permissions }) {
          requested.push(Array.from(permissions));
          return Promise.resolve(true);
        }
      },
      tabs: { sendMessage: async () => ({ ok: true, videoId: page.videoId }) }
    }
  });
  const local = popup.prepareAudioCapture();
  assert.deepEqual(requested[0], ["tabCapture", "nativeMessaging"]);
  assert.equal((await local).videoId, page.videoId);
  await popup.prepareAudioCapture("openai");
  assert.deepEqual(requested[1], ["tabCapture"]);
  tabUrl = "https://chzzk.naver.com/video/654321";
  await assert.rejects(popup.prepareAudioCapture(), /영상이 바뀌었습니다/);
});

test("lyric streaming uses the selected language and leaves automatic language detection available", () => {
  const { streamUrl } = functions("src/offscreen/index.ts", ["streamUrl"], { URL });
  const config = { endpoint: "ws://127.0.0.1:8765/v1/audio/stream", contentMode: "lyrics", model: "qwen3-asr-1.7b" };
  assert.equal(new URL(streamUrl({ ...config, sourceLanguage: "ja" })).searchParams.get("language"), "ja");
  assert.equal(new URL(streamUrl({ ...config, sourceLanguage: "auto" })).searchParams.get("language"), null);
});

function streamHarness(settings = { enabled: true }) {
  const pending = [], sent = [];
  settings = { lmStudio: { baseUrl: "http://127.0.0.1:1234/v1" }, ollama: { baseUrl: "http://127.0.0.1:11434" }, ...settings };
  const context = functions("src/background/index.ts", [
    "audioTransportConfig", "processStreamTranscript", "shouldTranslateStreamPartial", "normalizeText",
    "translateStreamSegment", "translateQueuedStreamSegment", "audioRequestController", "isActiveAudioSession"
  ], {
    AbortController, AbortSignal, streamTranslationQueuesByTab: new Map(), audioRequestControllers: new Map(),
    activeAudioTabId: 1, activeAudioVideoId: "v",
    lastTranslationConfigRevision: undefined, lastPartialTranslationByTab: new Map(), lastFinalTranscriptByTab: new Map(),
    lyricsAssistByTab: new Map(), sanitizeAudioTranscript: (text) => text, assistLyricsSegment: (_, segment) => segment,
    notifyLyricsAssistStatus() {},
    correctionSessionsByTab: new Map(),
    isLocalBaseUrl: (url) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname),
    STREAM_PARTIAL_TRANSLATION_MIN_CHARACTERS: 5, STREAM_PARTIAL_TRANSLATION_MIN_INTERVAL_MS: 1250,
    MIN_STABLE_AUDIO_CHUNK_MS: 8000,
    loadSettingsSnapshot: async () => ({ settings, translationConfigRevision: 1 }),
    matchUserCorrection: async () => undefined,
    segmentWithAudioContext: (_, segment) => segment,
    translateAndRespond: (segment, signal, _settings, draft) => new Promise((resolve, reject) => {
      pending.push({ segment, signal, resolve, draft });
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    notifyTab: async (_, message) => sent.push(message), rememberAudioContext() {},
    isBlockedHallucinationError: () => false, shouldStopCaptureAfterApiError: () => false
  });
  return { context, pending, sent };
}
const segment = (id) => ({ id, text: `speech ${id}`, source: "audioStt", startMs: 0, endMs: 1000 });
const result = (text) => ({ ok: true, translatedText: text, provider: "test" });

test("legacy STT lyric examples are blocked before translation", () => {
  const source = readFileSync(new URL("../src/background/index.ts", import.meta.url), "utf8");
  const [, parts] = source.match(/^const PROBABLE_AUDIO_PROMPT_LEAK_PARTS = (\[[\s\S]*?\]);/m);
  const c = functions("src/background/index.ts", ["speechKey", "isProbableAudioHallucination"], {
    PROBABLE_AUDIO_HALLUCINATION_KEYS: new Set(),
    PROBABLE_AUDIO_PROMPT_LEAK_PARTS: vm.runInNewContext(parts),
    isProbableCreditHallucination: () => false
  });
  assert.equal(c.isProbableAudioHallucination("ラララ、ああ、wow、yeah、baby。"), true);
  assert.equal(c.isProbableAudioHallucination("ラララ、君と歌う。Wow, baby!"), false);
});

test("pausing the current video resets its buffer and blocks audio subtitles until resume", async () => {
  const video = { paused: false };
  const sent = [];
  const c = functions("src/content/index.ts", ["shouldAcceptAudioSegment", "resetPausedAudioBuffer"], {
    settings: { enabled: true, inputMode: "audio" },
    activeVideoId: "v",
    audioCaptureRequested: true, audioStopRequested: false, audioCaptureSuppressed: false,
    findVideoElement: () => video, currentWatchVideoId: () => "v",
    chrome: { runtime: { sendMessage: async (message) => { sent.push(message); } } }
  });
  assert.equal(c.shouldAcceptAudioSegment(segment("before pause")), true);
  video.paused = true;
  c.resetPausedAudioBuffer({ target: { paused: true } });
  c.resetPausedAudioBuffer({ target: video });
  await setImmediate();
  assert.deepEqual(sent.map((message) => [message.type, message.videoId]), [["RESET_AUDIO_CAPTURE_BUFFER", "v"]]);
  assert.equal(c.shouldAcceptAudioSegment(segment("late result")), false);
  assert.equal(c.shouldAcceptAudioSegment({ source: "officialCaption" }), true);
  video.paused = false;
  assert.equal(c.shouldAcceptAudioSegment(segment("after resume")), true);
});

test("tab capture stays active near the end of a video and stops when playback has ended", async () => {
  let video = null;
  let stops = 0;
  const content = functions("src/content/index.ts", ["videoPlaybackEnded", "tick"], {
    activeVideoId: "chzzk:video:123456", audioCaptureRequested: true,
    settings: { enabled: true, inputMode: "audio" }, isYouTubeSite: false,
    findVideoElement: () => video, handleUrlChange() {}, handleVideoElementChange() {},
    stopAudioFallback: async () => { stops++; },
    startAudioFallbackIfNeeded: async () => {}
  });

  await content.tick();
  assert.equal(stops, 0);

  video = { duration: 25, currentTime: 24.8, ended: false, loop: true };
  await content.tick();
  assert.equal(stops, 0);

  video.loop = false;
  await content.tick();
  assert.equal(stops, 0);

  video.ended = true;
  await content.tick();
  assert.equal(stops, 1);
});

test("a recorder chunk that finishes encoding after reset is discarded", async () => {
  const sent = [];
  let finishEncoding;
  const c = functions("src/offscreen/index.ts", ["sendAudioBlob", "discardActiveRecorder"], {
    recorderRevision: 0, mediaRecorder: undefined, cyclingRecorder: false,
    clearChunkTimer() {},
    blobToBase64: () => new Promise((resolve) => { finishEncoding = resolve; }),
    chrome: { runtime: { sendMessage: async (message) => { sent.push(message); } } }
  });
  const blob = { size: 3, type: "audio/webm" };
  const oldChunk = c.sendAudioBlob(blob, blob.type, 1, "v", 0);
  c.discardActiveRecorder();
  finishEncoding("AQID");
  await oldChunk;
  assert.equal(sent.length, 0);

  const newChunk = c.sendAudioBlob(blob, blob.type, 1, "v", c.recorderRevision);
  finishEncoding("BAUG");
  await newChunk;
  assert.equal(sent[0].audioBase64, "BAUG");
});

test("a delayed stream notification cannot start a translation after its buffer was reset", async () => {
  const { context: c, pending } = streamHarness();
  let finishNotification;
  c.notifyTab = () => new Promise((resolve) => { finishNotification = resolve; });
  const processing = c.processStreamTranscript({
    type: "STREAM_STT_TRANSCRIPT", tabId: 1, videoId: "v", segment: segment("old buffer"), isFinal: true
  });
  await setImmediate();
  c.audioRequestControllers.get(1)?.abort();
  c.audioRequestControllers.delete(1);
  finishNotification();
  await setImmediate();
  assert.equal(pending.length, 0);
  await processing;
});

test("a local preview can display while progress and dictionary lookup are pending", async () => {
  const { context: c, pending, sent } = streamHarness({ enabled: true, contentMode: "spoken", translationProvider: "lmStudio" });
  let finishProgress, finishCorrection;
  c.notifyTab = async (_, message) => {
    sent.push(message);
    if (message.type === "STREAM_STT_TRANSCRIPT") {
      await new Promise((resolve) => { finishProgress = resolve; });
    }
  };
  c.matchUserCorrection = () => new Promise((resolve) => { finishCorrection = resolve; });
  const transcript = { type: "STREAM_STT_TRANSCRIPT", tabId: 1, videoId: "v", segment: segment("utterance"), isFinal: false };
  const preview = c.processStreamTranscript(transcript);
  await setImmediate();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].draft, true);
  pending[0].resolve(result("임시 번역"));
  await setImmediate();
  assert.equal(sent.at(-1).translatedText, "임시 번역");
  finishProgress();
  await preview;

  const confirmed = c.processStreamTranscript({ ...transcript, isFinal: true });
  await setImmediate();
  finishCorrection({ translatedText: "교정된 번역", provider: "사용자 교정" });
  await confirmed;
  assert.equal(sent.at(-1).translatedText, "교정된 번역");
  assert.equal(pending.length, 1);
});

test("a confirmed local transcript supersedes a pending preview of the same text", async () => {
  const { context: c, pending, sent } = streamHarness({ enabled: true, contentMode: "spoken", translationProvider: "ollama" });
  const line = segment("same utterance");
  const preview = c.translateStreamSegment(1, "v", line, false, 1);
  await setImmediate();
  await c.translateStreamSegment(1, "v", line, true, 1);
  await setImmediate();
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(pending.length, 2);
  pending[1].resolve(result("확정 번역"));
  await preview;
  assert.deepEqual(sent.map((message) => message.translatedText), ["확정 번역"]);
});

for (const [model, translationProvider] of [
  ["qwen3-asr-0.6b", "ollama"], ["qwen3-asr-1.7b", "lmStudio"], ["base", "lmStudio"], ["small", "ollama"]
]) {
  test(`${model} sends a provisional ${translationProvider} translation and then its final subtitle`, async () => {
    const settings = {
      enabled: true, sttProvider: "whisper", whisper: { model }, audioChunkMs: 8000,
      contentMode: "spoken", streamingSttEnabled: true, translationProvider
    };
    const { context: c, pending, sent } = streamHarness(settings);
    const transport = c.audioTransportConfig(settings);
    assert.equal(transport.useStreaming, true);
    assert.equal(transport.streamingSttModel, model);
    const http = c.audioTransportConfig({ ...settings, contentMode: "lyrics", streamingSttEnabled: false });
    assert.equal(http.useStreaming, false);
    assert.equal(http.audioChunkMs, 14000);

    const message = { type: "STREAM_STT_TRANSCRIPT", tabId: 1, videoId: "v", segment: segment("first"), isFinal: false };
    const provisional = c.processStreamTranscript(message);
    await setImmediate();
    assert.equal(sent[0].type, "STREAM_STT_TRANSCRIPT");
    assert.equal(pending.length, 1);
    pending[0].resolve(result("임시 번역"));
    await provisional;

    const confirmed = c.processStreamTranscript({ ...message, segment: segment("confirmed"), isFinal: true });
    await setImmediate();
    assert.equal(pending[1].segment.text, "speech confirmed");
    pending[1].resolve(result("확정 번역"));
    await confirmed;
    const translations = sent.filter(({ type }) => type === "TRANSLATION_READY");
    assert.deepEqual(translations.map(({ segment, provider, translatedText }) => [segment.text, provider, translatedText]), [
      ["speech first", "test (partial)", "임시 번역"],
      ["speech confirmed", "test", "확정 번역"]
    ]);
  });
}

test("lyrics wait for confirmed recognition before displaying or translating a subtitle", async () => {
  for (const contentMode of ["lyrics", "auto"]) {
    const { context: c, pending, sent } = streamHarness({ enabled: true, contentMode, translationProvider: "lmStudio" });
    const line = contentMode === "auto"
      ? { ...segment("guessed lyric"), detectedContentMode: "lyrics" }
      : segment("guessed lyric");
    const message = { type: "STREAM_STT_TRANSCRIPT", tabId: 1, videoId: "v", segment: line, isFinal: false };
    void c.processStreamTranscript(message);
    await setImmediate();
    assert.equal(sent.length, 0);
    assert.equal(pending.length, 0);

    const confirmed = c.processStreamTranscript({ ...message, isFinal: true });
    await setImmediate();
    assert.equal(pending.length, 1);
    pending[0].resolve(result("확정 가사"));
    await confirmed;
    assert.equal(sent.at(-1).translatedText, "확정 가사");
  }
});

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

test("a final transcript cancels a different in-flight partial and takes priority over newer partials", async () => {
  const { context: c, pending, sent } = streamHarness();
  const task = c.translateStreamSegment(1, "v", segment("start"), false, 1);
  await setImmediate();
  await c.translateStreamSegment(1, "v", segment("final"), true, 1);
  await c.translateStreamSegment(1, "v", segment("next"), false, 1);
  await setImmediate();
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(pending[1].segment.id, "final");
  pending[1].resolve(result("final"));
  await setImmediate();
  assert.equal(pending[2].segment.id, "next");
  pending[2].resolve(result("next"));
  await task;
  assert.deepEqual(sent.map(({ provider, translatedText }) => [provider, translatedText]), [
    ["test", "final"], ["test (partial)", "next"]
  ]);
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

test("an accepted draft does not seed the confirmed translation cache", async () => {
  const memo = new Map();
  const outputs = ["임시 번역", "확정 번역"];
  const c = functions("src/background/index.ts", ["translateAndRespond"], {
    AbortController, translationInFlight: new Map(), hasCorruptedSubtitleText: () => false,
    cacheKey: () => "same", getMemoryCachedTranslation: (key) => memo.get(key),
    rememberTranslation: (key, text) => memo.set(key, text),
    sanitizeTranslatedSubtitle: (_, text) => text, getErrorMessage: (error) => error.message,
    translateSegment: async () => result(outputs.shift())
  });
  const settings = { enabled: true, contentMode: "spoken" };
  const line = segment("same");
  assert.equal((await c.translateAndRespond(line, undefined, settings, true)).translatedText, "임시 번역");
  assert.equal(memo.size, 0);
  assert.equal((await c.translateAndRespond(line, undefined, settings)).translatedText, "확정 번역");
  assert.equal((await c.translateAndRespond(line, undefined, settings)).provider, "cache");
  assert.equal(outputs.length, 0);
});

test("a rejected draft skips the repair request until confirmation", async () => {
  const guides = [];
  const c = functions("src/background/index.ts", ["translateAndRespond"], {
    AbortController, translationInFlight: new Map(), hasCorruptedSubtitleText: () => false,
    cacheKey: () => "same", getMemoryCachedTranslation: () => undefined, rememberTranslation() {},
    BLOCKED_HALLUCINATION_ERROR: "blocked",
    sanitizeTranslatedSubtitle: (_, text) => text === "incorrect" ? "" : text,
    translationCorrectionGuidance: () => "repair",
    getErrorMessage: (error) => error.message,
    translateSegment: async (_, __, guide) => {
      guides.push(guide);
      return result(guide ? "검증된 번역" : "incorrect");
    }
  });
  const settings = { enabled: true, contentMode: "spoken" };
  const line = segment("same");
  assert.equal((await c.translateAndRespond(line, undefined, settings, true)).ok, false);
  assert.deepEqual(guides, [undefined]);
  assert.equal((await c.translateAndRespond(line, undefined, settings)).translatedText, "검증된 번역");
  assert.deepEqual(guides, [undefined, undefined, "repair"]);
});

test("Japanese to Korean wording rules preserve a correct English translation", () => {
  const c = functions("src/background/index.ts", [
    "translationCorrectionGuidance", "sanitizeTranslatedSubtitle", "normalizeSubtitleLines",
    "isKoreanTargetLanguage", "polishKoreanSubtitleDiction", "polishJapaneseKoreanMeaning",
    "isUnsupportedJapaneseTelepathyTranslation", "isUnsupportedJapanesePregnancyTranslation",
    "isUnsupportedJapaneseAddedAction", "isUnsupportedJapaneseDislikeRelation", "isUnsupportedJapaneseGoalTranslation"
  ], {
    console: { debug() {} }, hasCorruptedSubtitleText: () => false, isModelRefusalOrMetaText: () => false,
    hasExcessiveTextRepetition: () => false, isProbableGeneratedBoilerplate: () => false,
    isProbableCtaHallucination: () => false, restoreSourceEdgeMarkers: (_, text) => text,
    sanitizeAudioTranscript: (text) => text
  });
  const line = { ...segment("sense"), text: "テレパシーが通じた。" };
  const english = { contentMode: "spoken", targetLanguage: "en" };
  const korean = { ...english, targetLanguage: "ko" };
  assert.equal(c.sanitizeTranslatedSubtitle(line, "Telepathy worked.", english), "Telepathy worked.");
  assert.equal(c.translationCorrectionGuidance(line, "Telepathy worked.", english), undefined);
  assert.equal(c.sanitizeTranslatedSubtitle(line, "마음이 통했어.", korean), "");
  assert.equal(c.sanitizeTranslatedSubtitle(line, "텔레파시가 통했어.", korean), "텔레파시가 통했어.");
});

test("translation cache distinguishes capitalization and speaker turns", () => {
  const { cacheKey } = functions("src/background/index.ts", ["cacheKey", "normalizeText", "normalizeSubtitleLines"], {
    TRANSLATION_PROMPT_VERSION: "test"
  });
  const settings = { translationProvider: "ollama", ollama: { baseUrl: "http://localhost:11434", model: "test" } };
  const line = segment("key");
  assert.notEqual(cacheKey(settings, { ...line, text: "IT works." }), cacheKey(settings, { ...line, text: "It works." }));
  assert.notEqual(cacheKey(settings, { ...line, text: "Wait.\nGo now." }), cacheKey(settings, { ...line, text: "Wait. Go now." }));
  assert.notEqual(cacheKey(settings, line), cacheKey(settings, { ...line, source: "youtubeTimedText" }));
});

test("confirmed local audio repairs a plausible mistranslation that passed the existing rules", async () => {
  const reviews = [];
  const c = functions("src/background/index.ts", ["translateAndRespond"], {
    AbortController, translationInFlight: new Map(), hasCorruptedSubtitleText: () => false,
    cacheKey: () => "meeting", getMemoryCachedTranslation: () => undefined, rememberTranslation() {},
    sanitizeTranslatedSubtitle: (_, translation) => translation, getErrorMessage: (error) => error.message,
    translateSegment: async () => result("내일 회의에 갈 거예요."),
    reviewLocalAudioTranslation: async (_, line, translation, guidance) => {
      reviews.push({ text: line.text, translation, guidance });
      return { decision: "correct", translation: "내일 회의에 가지 않을 거예요." };
    }
  });
  const settings = { enabled: true, contentMode: "spoken", translationProvider: "lmStudio" };
  const line = { ...segment("meeting"), text: "明日は会議に行きません。" };
  assert.equal((await c.translateAndRespond(line, undefined, settings, true)).translatedText, "내일 회의에 갈 거예요.");
  assert.equal(reviews.length, 0);
  const confirmed = await c.translateAndRespond(line, undefined, settings);
  assert.equal(confirmed.translatedText, "내일 회의에 가지 않을 거예요.");
  assert.equal(confirmed.provider, "로컬 교정");
  assert.deepEqual(reviews, [{ text: line.text, translation: "내일 회의에 갈 거예요.", guidance: undefined }]);
});

test("a local review preserves the accepted translation on keep or a changed source number", async () => {
  const valid = "회의에 15명이 왔어.";
  for (const [review, provider] of [
    [{ decision: "keep" }, "로컬 검토 완료"],
    [{ decision: "correct", translation: "회의에 50명이 왔어." }, "test"]
  ]) {
    const c = functions("src/background/index.ts", ["translateAndRespond"], {
      AbortController, translationInFlight: new Map(), hasCorruptedSubtitleText: () => false,
      cacheKey: () => "attendance", getMemoryCachedTranslation: () => undefined, rememberTranslation() {},
      sanitizeTranslatedSubtitle: (_, translation) => translation, getErrorMessage: (error) => error.message,
      translateSegment: async () => result(valid), reviewLocalAudioTranslation: async () => review
    });
    const settings = { enabled: true, translationProvider: "ollama" };
    const line = { ...segment("attendance"), text: "会議には15人が来た。" };
    const confirmed = await c.translateAndRespond(line, undefined, settings);
    assert.equal(confirmed.provider, provider);
    assert.equal(confirmed.translatedText, valid);
  }
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

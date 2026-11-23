import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const workerScript = buildSync({
  entryPoints: [fileURLToPath(new URL("../src/background/index.ts", import.meta.url))],
  bundle: true, format: "iife", platform: "browser", write: false
}).outputFiles[0].text;

const extensionId = "a".repeat(32);
const popup = { id: extensionId, url: `chrome-extension://${extensionId}/popup.html` };

function event() {
  const listeners = new Set();
  return {
    addListener: (handler) => listeners.add(handler),
    removeListener: (handler) => listeners.delete(handler),
    emit: (...args) => { for (const handler of listeners) handler(...args); }
  };
}

function workerHarness({
  model = "qwen3-asr-0.6b", baseUrl = "http://127.0.0.1:8765/v1", hostError,
  sttProvider = "whisper", initiallyListening = false, nativePermission = true, navigateWhenReady = false
} = {}) {
  const commands = [];
  const events = [];
  let listening = initiallyListening;
  let tabUrl = "https://chzzk.naver.com/video/123456";
  let offscreenOpen = false;
  let capture;
  let port;
  const runtime = {
    id: extensionId,
    getURL: (path) => `chrome-extension://${extensionId}/${path}`,
    getContexts: async () => offscreenOpen ? [{}] : [],
    onMessage: event(),
    async sendMessage(message) {
      if (message.type === "GET_OFFSCREEN_AUDIO_STATE") return { ok: true, recording: Boolean(capture), ...capture };
      if (message.type === "START_AUDIO_CAPTURE" && message.target === "offscreen") {
        events.push("capture");
        capture = { mode: "stream", activeTabId: message.tabId, activeVideoId: message.videoId };
      }
      if (message.type === "RECONFIGURE_AUDIO_CAPTURE" && message.target === "offscreen") {
        events.push("reconfigure");
        return { ok: true, mode: capture?.mode };
      }
      return { ok: true };
    },
    connectNative(application) {
      assert.equal(application, "com.yt_live_translator.stt");
      port = {
        onMessage: event(),
        onDisconnect: event(),
        disconnect() { this.onDisconnect.emit(); },
        postMessage(command) {
          commands.push(JSON.parse(JSON.stringify(command)));
          queueMicrotask(() => {
            if (hostError) {
              runtime.lastError = { message: hostError };
              this.onDisconnect.emit();
              delete runtime.lastError;
            } else if (command.action === "start") {
              listening = true;
              if (navigateWhenReady) tabUrl = "https://chzzk.naver.com/video/654321";
              events.push("server ready");
              this.onMessage.emit({ ok: true, state: "running", model: command.model, device: "cuda", computeType: "float16" });
            } else {
              listening = false;
              this.onMessage.emit({ ok: true, state: "stopped" });
            }
          });
        }
      };
      return port;
    }
  };
  const storage = {
    translatorSettings: {
      officialCaptionPolicyVersion: 1, sttProvider, whisper: { model, baseUrl }, openai: { apiKey: "test-key" }
    },
    translatorSettingsRevision: 1,
    translatorTranslationConfigRevision: 1
  };
  const chrome = {
    runtime,
    storage: { local: { setAccessLevel: async () => {}, get: async () => storage }, onChanged: event() },
    tabs: {
      query: async () => [], get: (id, callback) => callback({ id, url: tabUrl }), sendMessage: async () => ({ ok: true }),
      onActivated: event(), onUpdated: event(), onRemoved: event()
    },
    offscreen: { createDocument: async () => { offscreenOpen = true; } },
    permissions: { contains: async ({ permissions }) => !permissions.includes("nativeMessaging") || nativePermission },
    tabCapture: {
      getCapturedTabs: (callback) => callback(capture ? [{ tabId: capture.activeTabId, status: "active" }] : []),
      async getMediaStreamId() { events.push("stream ID"); return "stream-id"; }
    }
  };
  vm.runInNewContext(workerScript, {
    chrome, console, URL, AbortController, DOMException, TypeError, Response, setTimeout, clearTimeout,
    fetch: async (target) => {
      const path = new URL(target).pathname;
      events.push(path);
      if (!listening) throw new TypeError("Failed to fetch");
      return new Response('{"ok":true}');
    }
  });
  return {
    commands, events,
    closeServer: () => { listening = false; },
    disconnect: () => port.onDisconnect.emit(),
    capture: (sender = popup) => new Promise((resolve) => {
      runtime.onMessage.emit({
        type: "START_AUDIO_CAPTURE", tabId: 7, videoId: "chzzk:video:123456", ensureTabCapturePermission: true
      }, sender, resolve);
    }),
    send: (action, sender = popup, payload = {}) => new Promise((resolve) => {
      runtime.onMessage.emit({ type: "LOCAL_STT_SERVER", action, ...payload }, sender, resolve);
    })
  };
}

test("one popup request starts the selected native model before it captures the tab", async () => {
  for (const model of ["qwen3-asr-1.7b", "base"]) {
    const worker = workerHarness({ model });
    const responses = await Promise.all([worker.capture(), worker.capture()]);
    assert.ok(responses.every((response) => response.ok && response.mode === "stream"));
    assert.deepEqual(worker.commands, [{ action: "start", model }]);
    assert.deepEqual(worker.events, ["/v1/models", "server ready", "/health", "stream ID", "capture"]);
  }
});

test("the unified start reuses running STT and leaves external providers in control", async () => {
  for (const config of [
    { initiallyListening: true, nativePermission: false },
    { baseUrl: "http://127.0.0.1:8080/v1", initiallyListening: true, nativePermission: false },
    { sttProvider: "openai", nativePermission: false }
  ]) {
    const worker = workerHarness(config);
    assert.equal((await worker.capture()).ok, true);
    assert.deepEqual(worker.commands, []);
    assert.equal(worker.events.at(-1), "capture");
  }
});

test("the unified start restores a stopped local server for an existing tab capture", async () => {
  const worker = workerHarness({ initiallyListening: true });
  assert.equal((await worker.capture()).ok, true);
  worker.closeServer();
  assert.equal((await worker.capture()).ok, true);
  assert.deepEqual(worker.commands, [{ action: "start", model: "qwen3-asr-0.6b" }]);
  assert.equal(worker.events.filter((event) => event === "stream ID").length, 1);
  assert.equal(worker.events.at(-1), "reconfigure");
});

test("native startup requires popup authorization and skips capture if the video has changed", async () => {
  const denied = workerHarness({ nativePermission: false });
  const response = await denied.capture();
  assert.equal(response.ok, false);
  assert.equal(response.needsNativeSttPermission, true);
  assert.deepEqual(denied.commands, []);
  assert.equal(denied.events.includes("stream ID"), false);

  const content = workerHarness();
  assert.equal((await content.capture({ id: extensionId, url: "https://chzzk.naver.com/video/123456", tab: { id: 7 } })).ok, false);
  assert.deepEqual(content.commands, []);

  const navigated = workerHarness({ navigateWhenReady: true });
  assert.equal((await navigated.capture()).ok, false);
  assert.deepEqual(navigated.commands, [{ action: "start", model: "qwen3-asr-0.6b" }]);
  assert.equal(navigated.events.includes("stream ID"), false);
});

for (const model of ["qwen3-asr-1.7b", "base", "large-v3-turbo"]) {
  test(`popup starts the saved ${model} model once and can stop it after reopening`, { timeout: 2000 }, async () => {
    const worker = workerHarness({ model });
    assert.equal((await worker.send("status")).state, "stopped");
    const started = await worker.send("start", popup, { model: "rejected-value" });
    assert.equal(started.state, "running");
    assert.equal(started.model, model);
    assert.equal((await worker.send("status")).device, "cuda");
    assert.equal((await worker.send("start")).state, "running");
    assert.equal((await worker.send("stop")).state, "stopped");
    assert.equal((await worker.send("stop")).state, "stopped");
    assert.deepEqual(worker.commands, [{ action: "start", model }, { action: "stop" }]);
  });
}

test("content scripts, foreign senders and incompatible settings cannot start the host", { timeout: 2000 }, async () => {
  const worker = workerHarness();
  assert.equal((await worker.send("start", { id: extensionId, url: "https://www.youtube.com/watch?v=abc" })).ok, false);
  assert.equal((await worker.send("start", { ...popup, id: "b".repeat(32) })).ok, false);
  assert.equal((await worker.send("arbitrary-command")).ok, false);
  assert.deepEqual(worker.commands, []);
  for (const configured of [
    workerHarness({ model: "other/model" }),
    workerHarness({ baseUrl: "http://127.0.0.1:8080/v1" }),
    workerHarness({ baseUrl: "https://example.test/v1" })
  ]) {
    assert.equal((await configured.send("start")).ok, false);
    assert.deepEqual(configured.commands, []);
  }
});

test("missing host gives registration instructions and a lost connection clears server state", { timeout: 2000 }, async () => {
  const missing = workerHarness({ hostError: "Specified native messaging host not found." });
  const failed = await missing.send("start");
  assert.equal(failed.ok, false);
  assert.match(failed.error, /npm run stt:native:install/);
  assert.equal((await missing.send("status")).state, "stopped");

  const worker = workerHarness();
  assert.equal((await worker.send("start")).state, "running");
  worker.disconnect();
  assert.equal((await worker.send("status")).state, "stopped");
  assert.equal((await worker.send("start")).state, "running");
  assert.equal((await worker.send("stop")).state, "stopped");
});

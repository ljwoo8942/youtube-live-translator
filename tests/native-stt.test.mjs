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

function workerHarness({ model = "qwen3-asr-0.6b", baseUrl = "http://127.0.0.1:8765/v1", hostError } = {}) {
  const commands = [];
  let port;
  const runtime = {
    id: extensionId,
    getURL: (path) => `chrome-extension://${extensionId}/${path}`,
    getContexts: async () => [],
    onMessage: event(),
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
              this.onMessage.emit({ ok: true, state: "running", model: command.model, device: "cuda", computeType: "float16" });
            } else {
              this.onMessage.emit({ ok: true, state: "stopped" });
            }
          });
        }
      };
      return port;
    }
  };
  const storage = {
    translatorSettings: { officialCaptionPolicyVersion: 1, whisper: { model, baseUrl } },
    translatorSettingsRevision: 1,
    translatorTranslationConfigRevision: 1
  };
  const chrome = {
    runtime,
    storage: { local: { setAccessLevel: async () => {}, get: async () => storage }, onChanged: event() },
    tabs: { query: async () => [], onActivated: event(), onUpdated: event(), onRemoved: event() }
  };
  vm.runInNewContext(workerScript, { chrome, console, URL, AbortController, setTimeout, clearTimeout });
  return {
    commands,
    disconnect: () => port.onDisconnect.emit(),
    send: (action, sender = popup, payload = {}) => new Promise((resolve) => {
      runtime.onMessage.emit({ type: "LOCAL_STT_SERVER", action, ...payload }, sender, resolve);
    })
  };
}

test("popup starts the saved Qwen model once and can stop it after reopening", { timeout: 2000 }, async () => {
  const worker = workerHarness({ model: "qwen3-asr-1.7b" });
  assert.equal((await worker.send("status")).state, "stopped");
  const started = await worker.send("start", popup, { model: "rejected-value" });
  assert.equal(started.state, "running");
  assert.equal(started.model, "qwen3-asr-1.7b");
  assert.equal((await worker.send("status")).device, "cuda");
  assert.equal((await worker.send("start")).state, "running");
  assert.equal((await worker.send("stop")).state, "stopped");
  assert.equal((await worker.send("stop")).state, "stopped");
  assert.deepEqual(worker.commands, [{ action: "start", model: "qwen3-asr-1.7b" }, { action: "stop" }]);
});

test("content scripts, foreign senders and incompatible settings cannot start the host", { timeout: 2000 }, async () => {
  const worker = workerHarness();
  assert.equal((await worker.send("start", { id: extensionId, url: "https://www.youtube.com/watch?v=abc" })).ok, false);
  assert.equal((await worker.send("start", { ...popup, id: "b".repeat(32) })).ok, false);
  assert.equal((await worker.send("arbitrary-command")).ok, false);
  assert.deepEqual(worker.commands, []);
  for (const configured of [
    workerHarness({ model: "small" }),
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

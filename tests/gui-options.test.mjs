import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import ts from "typescript";
import { DEFAULT_SETTINGS } from "../src/shared/defaults.ts";

const source = readFileSync(new URL("../src/options/index.ts", import.meta.url), "utf8");
function functions(names, globals) {
  const ast = ts.createSourceFile("options.ts", source, ts.ScriptTarget.Latest, true);
  const selected = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(selected.length, names.length);
  const code = selected.map((node) => node.getText(ast)).join("\n");
  return vm.runInNewContext(`${ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}\n({${names.join(",")}})`, globals);
}

function currentSettings() {
  const next = structuredClone(DEFAULT_SETTINGS);
  next.enabled = false;
  next.translationProvider = "ollama";
  next.contentMode = "lyrics";
  next.whisper.model = "qwen3-asr-1.7b";
  return next;
}

test("translation diagnostic uses current unsaved settings without saving or enabling", async () => {
  const next = currentSettings(), before = structuredClone(next), sent = [], statuses = [];
  const { testTranslation } = functions(["testTranslation"], {
    collectSettings: () => next, setStatus: (value) => statuses.push(value),
    chrome: { runtime: { sendMessage: async (message) => { sent.push(message); return { ok: true, translatedText: "test" }; } } },
    saveCurrentSettings: () => assert.fail("diagnostic saved settings"),
    setInput: () => assert.fail("diagnostic changed a field")
  });
  await testTranslation();
  assert.equal(sent[0].type, "TEST_TRANSLATION");
  assert.equal(sent[0].settings, next);
  assert.equal(sent[0].settings.enabled, false);
  assert.deepEqual(next, before);
  assert.match(statuses.at(-1), /연결 테스트 성공/);
});

test("failed diagnostic preserves unsaved settings and surfaces the connection error", async () => {
  const next = currentSettings(), before = structuredClone(next);
  const { testTranslation } = functions(["testTranslation"], {
    collectSettings: () => next, setStatus() {},
    chrome: { runtime: { sendMessage: async () => ({ ok: false, error: "offline" }) } },
    saveCurrentSettings: () => assert.fail("failure saved settings"), setInput: () => assert.fail("failure changed form")
  });
  await assert.rejects(testTranslation(), /offline/);
  assert.deepEqual(next, before);
});

test("pipeline diagnostic shares STT routing and reports its limited connection scope", async () => {
  const next = currentSettings(), before = structuredClone(next), calls = [], statuses = [];
  const { testLocalPipeline } = functions(["testLocalPipeline"], {
    collectSettings: () => next, isLocalBaseUrl: () => true, probeFasterWhisper: async (value) => calls.push(["health", value]),
    createSilentWavBlob: () => ({ arrayBuffer: async () => new ArrayBuffer(8) }),
    transcribeAudio: async (value) => { calls.push(["stt", value]); return ""; },
    testTranslation: async (value) => calls.push(["translation", value]), setStatus: (value) => statuses.push(value),
    saveCurrentSettings: () => assert.fail("pipeline saved"), setInput: () => assert.fail("pipeline changed form")
  });
  await testLocalPipeline();
  assert.deepEqual(calls.map(([name]) => name), ["health", "stt", "translation"]);
  assert.ok(calls.every(([, value]) => value === next));
  assert.deepEqual(next, before);
  assert.match(statuses.at(-1), /무음 STT/);
  assert.match(statuses.at(-1), /실제 탭 캡처·음성 인식 정확도/);
});

test("local server probe reports unprepared selection without replacing model or provider", async () => {
  const next = currentSettings(), statuses = [];
  const { probeFasterWhisper } = functions(["probeFasterWhisper"], {
    collectSettings: () => next, normalizeOpenAiBaseUrl: (value) => value,
    joinUrl: (base, tail) => base + tail, LOCAL_STT_START_HINT: "hint",
    fetchText: async (url) => ({ response: { ok: true }, text: JSON.stringify(url.endsWith("/health")
      ? { ok: true, loaded_model: "small", cached_models: ["small"], backend: "faster-whisper", device: "cpu", compute_type: "int8" }
      : { data: [{ id: "small" }] }) }), stringArray: (value) => value ?? [],
    setStatus: (value) => statuses.push(value), setInput: () => assert.fail("probe changed selection")
  });
  await probeFasterWhisper();
  assert.equal(next.whisper.model, "qwen3-asr-1.7b");
  assert.match(statuses.at(-1), /선택 모델 준비 필요/);
});

test("a failed STT connection does not run a translation request or change settings", async () => {
  const next = currentSettings(), before = structuredClone(next);
  const { testLocalPipeline } = functions(["testLocalPipeline"], {
    collectSettings: () => next, isLocalBaseUrl: () => true, probeFasterWhisper: async () => {}, createSilentWavBlob: () => ({ arrayBuffer: async () => new ArrayBuffer(8) }),
    transcribeAudio: async () => { throw new Error("STT offline"); }, setStatus() {},
    testTranslation: () => assert.fail("translation ran after failed STT"), setInput: () => assert.fail("test changed form")
  });
  await assert.rejects(testLocalPipeline(), /STT offline/);
  assert.deepEqual(next, before);
});

test("pipeline permission requests include only used STT routes and configured fallbacks", () => {
  const next = currentSettings(), calls = [];
  const { runPipelineTest } = functions(["runPipelineTest"], {
    collectSettings: () => next, runProviderAction: (_, urls, ws) => calls.push({ urls, ws })
  });
  next.sttProvider = "lmStudio";
  next.lmStudio.tryStt = false;
  runPipelineTest();
  assert.deepEqual([...calls[0].urls], [next.ollama.baseUrl, next.whisper.baseUrl]);
  next.lmStudio.tryStt = true;
  runPipelineTest();
  assert.deepEqual([...calls[1].urls], [next.ollama.baseUrl, next.lmStudio.baseUrl, next.whisper.baseUrl]);
  assert.equal(calls[1].ws, undefined);
});

test("caption-only current-settings test requests only translation access and never contacts STT", async () => {
  const next = currentSettings(), permissions = [], translations = [], statuses = [];
  next.inputMode = "captions";
  const before = structuredClone(next);
  let action;
  const code = functions(["runPipelineTest", "testLocalPipeline"], {
    collectSettings: () => next, runProviderAction: (callback, urls) => { action = callback; permissions.push([...urls]); },
    testTranslation: async (value) => translations.push(value), setStatus: (value) => statuses.push(value),
    probeFasterWhisper: () => assert.fail("caption mode contacted STT health"),
    transcribeAudio: () => assert.fail("caption mode sent STT audio"),
    createSilentWavBlob: () => assert.fail("caption mode created an audio probe")
  });
  code.runPipelineTest();
  await action();
  assert.deepEqual(permissions, [[next.ollama.baseUrl]]);
  assert.equal(translations[0], next);
  assert.match(statuses.at(-1), /공식 자막 모드/);
  assert.deepEqual(next, before);
});

test("remote Whisper-compatible pipeline needs only its transcription API, not a local health route", async () => {
  const next = currentSettings(), stt = [], translated = [];
  next.whisper.baseUrl = "https://speech.example/v1";
  const code = functions(["testLocalPipeline"], {
    collectSettings: () => next, isLocalBaseUrl: () => false,
    probeFasterWhisper: () => assert.fail("remote compatible API incorrectly required /health"),
    createSilentWavBlob: () => ({ arrayBuffer: async () => new ArrayBuffer(8) }),
    transcribeAudio: async (value) => stt.push(value), testTranslation: async (value) => translated.push(value), setStatus() {}
  });
  await code.testLocalPipeline();
  assert.equal(stt[0], next);
  assert.equal(translated[0], next);
});

test("explicit API and local audio diagnostics still run STT in caption-only mode without changing the form", async () => {
  const next = currentSettings(), handlers = new Map(), pending = [], stt = [], permissions = [];
  next.inputMode = "captions";
  const before = structuredClone(next);
  const code = functions(["bindActions", "runPipelineTest", "testLocalPipeline"], {
    byId: (id) => ({ addEventListener: (_, callback) => handlers.set(id, callback) }),
    collectSettings: () => next, isLocalBaseUrl: () => true, probeFasterWhisper: async () => {},
    runProviderAction: (callback, urls) => { permissions.push([...urls]); pending.push(callback()); },
    createSilentWavBlob: () => ({ arrayBuffer: async () => new ArrayBuffer(8) }),
    transcribeAudio: async (value) => stt.push(value), testTranslation: async () => {}, setStatus() {},
    setInput: () => assert.fail("explicit diagnostic changed form")
  });
  code.bindActions();
  handlers.get("apiPipelineTest")();
  await pending[0];
  handlers.get("localPipelineTest")();
  await pending[1];
  assert.deepEqual(stt.map((value) => [value.sttProvider, value.inputMode]), [["openai", "audio"], ["whisper", "audio"]]);
  assert.deepEqual(permissions, [[next.ollama.baseUrl, next.apiStt.baseUrl], [next.ollama.baseUrl, next.whisper.baseUrl]]);
  assert.deepEqual(next, before);
});

test("diagnostic buttons do not apply presets and ask only for the HTTP origins they use", () => {
  const next = currentSettings(), handlers = new Map(), actions = [], pipelines = [];
  const globals = {
    byId: (id) => ({ addEventListener: (_, action) => handlers.set(id, action) }),
    collectSettings: () => next, runSettingsAction: () => assert.fail("test used save workflow"),
    runPipelineTest: (value) => pipelines.push(value ?? next),
    runProviderAction: (action, urls) => actions.push({ action, urls }),
    testTranslation() {}, testLmStudioTranslation() {},
    inputValue: () => next.lmStudio.baseUrl, DEFAULT_SETTINGS,
    setInput: () => assert.fail("test changed a field"), applyLocalGpuPreset: () => assert.fail("test applied preset")
  };
  functions(["bindActions"], globals).bindActions();
  handlers.get("heroPipelineTest")();
  handlers.get("apiPipelineTest")();
  handlers.get("localPipelineTest")();
  handlers.get("test")();
  handlers.get("lmStudioProbe")();
  assert.equal(pipelines[0], next);
  assert.equal(pipelines[1].sttProvider, "openai");
  assert.equal(pipelines[2].sttProvider, "whisper");
  assert.equal(pipelines[1].inputMode, "audio");
  assert.equal(pipelines[2].inputMode, "audio");
  assert.equal(next.translationProvider, "ollama");
  assert.deepEqual([...actions[0].urls], [next.ollama.baseUrl]);
  assert.deepEqual([...actions[1].urls], [next.lmStudio.baseUrl]);
});

test("async actions suppress duplicates, expose busy state, and restore previous control states", async () => {
  let focused = 0;
  const controls = [{ disabled: false, id: "test", isConnected: true, focus() { focused++; } }, { disabled: true }], status = { textContent: "" }, attrs = {};
  const document = { activeElement: controls[0], body: {} };
  let finish, calls = 0;
  const globals = {
    actionPending: false, document, app: { querySelectorAll: () => controls, setAttribute: (name, value) => { attrs[name] = value; } },
    byId: () => status, setStatus: (value) => { status.textContent = value; }, getErrorMessage: (error) => error.message
  };
  const { runAction } = functions(["runAction"], globals);
  const action = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  runAction(action); runAction(action);
  assert.equal(calls, 1);
  assert.ok(controls.every((control) => control.disabled));
  assert.equal(attrs["aria-busy"], "true");
  document.activeElement = document.body;
  finish(); await setImmediate();
  assert.deepEqual(controls.map((control) => control.disabled), [false, true]);
  assert.equal(attrs["aria-busy"], "false");
  assert.equal(globals.actionPending, false);
  assert.equal(focused, 1);
  assert.match(status.textContent, /완료/);
  runAction(async () => { throw new Error("offline"); });
  await setImmediate();
  assert.equal(status.textContent, "offline");
  assert.equal(globals.actionPending, false);
  assert.deepEqual(controls.map((control) => control.disabled), [false, true]);
});

test("reset requires confirmation and keeps complete API connections, keys, and routing", async () => {
  const stored = currentSettings();
  stored.translationProvider = "ollama";
  stored.sttProvider = "openai";
  stored.streamingSttEndpoint = "wss://stream.example/v1";
  stored.streamingSttEnabled = false;
  stored.openai = { ...stored.openai, baseUrl: "https://gateway.example/v1", apiKey: "saved-key", authHeaderMode: "x-api-key", model: "custom" };
  stored.apiStt.apiKey = "speech-key";
  stored.lmStudio.apiKey = "local-key";
  stored.whisper.apiKey = "whisper-key";
  stored.overlayStyle.fontSize = 42;
  const handlers = new Map(), writes = [], statuses = [];
  let consent = false, pending;
  const globals = {
    DEFAULT_SETTINGS, structuredClone, settings: structuredClone(stored),
    byId: (id) => ({ addEventListener: (_, action) => handlers.set(id, action) }),
    window: { confirm: () => consent }, loadSettings: async () => structuredClone(stored),
    runAction: (action) => { pending = action(); }, diffSettings: (_, value) => value,
    saveSettingsPatch: async (value) => { writes.push(value); return value; }, render() {}, setStatus: (value) => statuses.push(value)
  };
  functions(["bindActions"], globals).bindActions();
  handlers.get("restore")(); await pending;
  assert.equal(writes.length, 0);
  consent = true;
  handlers.get("restore")(); await pending;
  assert.equal(writes.length, 1);
  for (const provider of ["openai", "apiStt", "lmStudio", "whisper", "ollama"]) assert.deepEqual(writes[0][provider], stored[provider]);
  for (const key of ["translationProvider", "sttProvider", "streamingSttEndpoint", "streamingSttEnabled"]) assert.equal(writes[0][key], stored[key]);
  assert.equal(writes[0].overlayStyle.fontSize, DEFAULT_SETTINGS.overlayStyle.fontSize);
  assert.equal(writes[0].contentMode, DEFAULT_SETTINGS.contentMode);
  assert.match(statuses.at(-1), /API 연결·모델·키는 유지/);
});

test("options status is a persistent accessible live region", () => {
  assert.match(source, /id="status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
});

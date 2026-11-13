import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { mergeBulkCorrectionLines } from "../src/shared/corrections.ts";
import { DEFAULT_SETTINGS } from "../src/shared/defaults.ts";
import { providerOrigins, requestProviderPermissions } from "../src/shared/providerPermissions.ts";

function functions(path, names, globals) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const code = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
    .map((node) => node.getText(ast)).join("\n");
  assert.equal(ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).length, names.length);
  return vm.runInNewContext(`${ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}\n({${names.join(",")}})`, globals);
}

test("bulk reapply, reorder, and translation edits preserve line metadata and IDs", () => {
  const previous = [
    { id: "a", source: "first", translation: "one", startMs: 100, endMs: 200, note: "keep" },
    { id: "b", source: "second", translation: "two", startMs: 300 }
  ];
  assert.deepEqual(mergeBulkCorrectionLines(previous, ["first", "second"], ["one", "two"]), previous);
  const changed = mergeBulkCorrectionLines(previous, ["inserted", "second", "first"], ["new", "edited", "one"]);
  assert.notEqual(changed[0].id, "a");
  assert.notEqual(changed[0].id, "b");
  assert.deepEqual(changed[1], { ...previous[1], translation: "edited" });
  assert.deepEqual(changed[2], previous[0]);
});

test("bulk duplicate lines reserve unchanged translations before edited copies", () => {
  const previous = [
    { id: "a", source: "hook", translation: "one", startMs: 100 },
    { id: "b", source: "hook", translation: "two", startMs: 300 }
  ];
  const changed = mergeBulkCorrectionLines(previous, ["hook", "hook", "hook"], ["edited", "one", "new"]);
  assert.deepEqual(changed.map((line) => line.id).slice(0, 2), ["b", "a"]);
  assert.equal(changed[0].startMs, 300);
  assert.equal(new Set(changed.map((line) => line.id)).size, 3);
});

test("bulk deletion never reuses a removed line ID for a different source", () => {
  const previous = [{ id: "cover-base", source: "removed", translation: "one" }];
  const [changed] = mergeBulkCorrectionLines(previous, ["replacement"], ["two"]);
  assert.notEqual(changed.id, "cover-base");
});

test("bulk UI requires consent before removing timing and keeps detached cover text", () => {
  const handlers = new Map();
  let consent = false;
  const selected = {
    lines: [{ id: "old", source: "old source", translation: "original", startMs: 100 }],
    variants: [{ lineOverrides: [{ id: "cover", baseLineId: "old", source: "cover source", translation: "cover text" }] }]
  };
  const globals = {
    document: { querySelector: (id) => ({ addEventListener: (_, handler) => handlers.set(id, handler) }) },
    selected, mergeBulkCorrectionLines, inputValue: (id) => id === "bulkSource" ? "replacement" : "new translation",
    window: { confirm: () => consent }, renderLines: () => {}, renderVariants: () => {}, setStatus: () => {}
  };
  functions("../src/corrections/index.ts", ["bindEvents"], globals).bindEvents();
  handlers.get("#applyBulk")();
  assert.equal(selected.lines[0].id, "old");
  assert.equal(selected.variants[0].lineOverrides[0].baseLineId, "old");
  consent = true;
  handlers.get("#applyBulk")();
  assert.notEqual(selected.lines[0].id, "old");
  assert.equal(selected.variants[0].lineOverrides[0].baseLineId, undefined);
  assert.equal(selected.variants[0].lineOverrides[0].source, "cover source");
  assert.equal(selected.variants[0].lineOverrides[0].translation, "cover text");
});

test("translation revision changes for language and lyrics behavior but not overlay settings", async () => {
  const stored = { translatorSettings: { ...structuredClone(DEFAULT_SETTINGS), officialCaptionPolicyVersion: 1 }, translatorSettingsRevision: 1, translatorTranslationConfigRevision: 4 };
  const source = readFileSync(new URL("../src/shared/storage.ts", import.meta.url), "utf8");
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports,
    require: () => ({ DEFAULT_SETTINGS, SETTINGS_KEY: "translatorSettings" }),
    chrome: { storage: { local: { get: async () => structuredClone(stored), set: async (value) => Object.assign(stored, value) } } }
  });
  let expected = 4;
  for (const patch of [{ targetLanguage: "en" }, { sourceLanguage: "ja" }, { contentMode: "lyrics" }, { lyricsAssistEnabled: false }]) {
    assert.equal((await module.exports.patchSettings(patch)).translationConfigRevision, ++expected);
  }
  assert.equal((await module.exports.patchSettings({ overlayStyle: { fontSize: 42 } })).translationConfigRevision, expected);
});

test("late caption result cannot repopulate cache after language change", async () => {
  let finish;
  const translations = new Map();
  const displayed = [];
  const globals = {
    settings: { enabled: true, translationConfigRevision: 1 }, activeVideoId: "video",
    currentWatchVideoId: () => "video", chrome: { runtime: { sendMessage: () => new Promise((resolve) => { finish = resolve; }) } },
    timedTextSegmentIndexById: new Map([["line", 0]]), timedTextTranslations: translations,
    shouldDisplayCaptionTranslation: () => true, translatedSegmentDisplayKey: () => "key",
    overlay: { showTranslation: (...args) => displayed.push(args) }
  };
  const { sendSegment } = functions("../src/content/index.ts", ["sendSegment"], globals);
  const pending = sendSegment({ type: "CAPTION_SEGMENT", segment: { id: "line", source: "youtubeTimedText" } });
  globals.settings.translationConfigRevision = 2;
  finish({ ok: true, translatedText: "old language", provider: "test" });
  assert.equal(await pending, "blocked");
  assert.equal(translations.size, 0);
  assert.equal(displayed.length, 0);
});

test("late failed caption request cannot change current retry state or display errors", async () => {
  let fail;
  const globals = {
    settings: { enabled: true, translationConfigRevision: 1 }, activeVideoId: "video", segmentKey: (text) => text,
    lastCaptionSeenAt: 0, captionRequestsInFlight: new Set(), blockedCaptionRequestKeys: new Set(), captionRequestRetryAfter: new Map(),
    CAPTION_TRANSLATION_RETRY_MS: 1000, sendSegment: () => new Promise((_, reject) => { fail = reject; }),
    overlay: { showError: () => assert.fail("stale error displayed") }
  };
  const { captionRequestKey, processCaptionSegment } = functions("../src/content/index.ts", ["captionRequestKey", "processCaptionSegment"], globals);
  const segment = { id: "line", source: "youtubeTimedText", text: "original" };
  const pending = processCaptionSegment(segment);
  globals.settings.translationConfigRevision = 2;
  const currentKey = captionRequestKey(segment);
  globals.captionRequestsInFlight.add(currentKey);
  fail(new Error("old request failed"));
  await pending;
  assert.equal(globals.captionRequestsInFlight.has(currentKey), true);
  assert.equal(globals.captionRequestRetryAfter.size, 0);
});

test("permission requests use exact configured secure origins and permit local HTTP/WS", () => {
  assert.deepEqual(providerOrigins(["https://api.example.com/v1", "https://api.example.com/other", "http://127.0.0.1:8765/v1"], "ws://localhost:8765/stream"), ["https://api.example.com/*"]);
  assert.deepEqual(providerOrigins([], "wss://speech.example.com/v1/stream"), ["https://speech.example.com/*"]);
  for (const url of ["http://remote.example/v1", "file:///tmp/model", "https://user:secret@api.example/v1", "https://*.example.com/v1"]) {
    assert.throws(() => providerOrigins([url]));
  }
  assert.throws(() => providerOrigins([], "ws://remote.example/stream"));
  assert.throws(() => providerOrigins([], "https://remote.example/stream"));
});

test("permission request starts synchronously and denial prevents the API action", async () => {
  const previous = globalThis.chrome;
  const calls = [];
  globalThis.chrome = { permissions: { request: (value) => { calls.push(value); return Promise.resolve(false); } } };
  try {
    const pending = requestProviderPermissions(["https://api.example.com/v1"]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { origins: ["https://api.example.com/*"] });
    await assert.rejects(pending, /권한/);
  } finally {
    globalThis.chrome = previous;
  }
});

test("options save and model-list actions wait for their configured host permissions", async () => {
  const handlers = new Map();
  const requests = [];
  let finish;
  let saves = 0;
  let modelLoads = 0;
  const statuses = [];
  const next = structuredClone(DEFAULT_SETTINGS);
  next.openai.baseUrl = "https://gateway.example/v1";
  next.whisper.baseUrl = "https://speech.example/v1";
  next.streamingSttEndpoint = "wss://stream.example/v1";
  next.inputMode = "captions";
  const globals = {
    DEFAULT_SETTINGS,
    byId: (id) => ({ addEventListener: (_, handler) => handlers.set(id, handler) }),
    collectSettings: () => next,
    inputValue: () => next.openai.baseUrl,
    setStatus: (value) => statuses.push(value), getErrorMessage: (error) => error.message,
    saveCurrentSettings: async () => { saves++; }, loadOpenAiModels: async () => { modelLoads++; },
    requestProviderPermissions: (urls, streamingUrl) => {
      requests.push({ urls, streamingUrl });
      return new Promise((resolve, reject) => { finish = { resolve, reject }; });
    }
  };
  const code = functions("../src/options/index.ts", ["bindActions", "runAction", "runProviderAction", "runSettingsAction"], globals);
  code.bindActions();
  handlers.get("save")();
  assert.deepEqual([...requests[0].urls], ["https://gateway.example/v1", "https://speech.example/v1"]);
  assert.equal(requests[0].streamingUrl, "wss://stream.example/v1");
  assert.equal(saves, 0);
  finish.resolve();
  await new Promise(setImmediate);
  assert.equal(saves, 1);
  handlers.get("loadOpenAiModels")();
  assert.deepEqual([...requests[1].urls], ["https://gateway.example/v1"]);
  assert.equal(requests[1].streamingUrl, undefined);
  finish.reject(new Error("denied"));
  await new Promise(setImmediate);
  assert.equal(modelLoads, 0);
  assert.deepEqual(statuses, ["denied"]);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

function harness() {
  const source = ts.createSourceFile("background.ts", readFileSync(new URL("../src/background/index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const node = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "handleTestTranslation");
  assert.ok(node);
  const calls = [];
  const context = {
    chrome: { runtime: { id: "test-extension", getURL: (path) => `chrome-extension://test-extension/${path}` } },
    assertTranslationReady: (settings) => { assert.equal(settings.openai.model, "unsaved-model"); },
    translateSegment: async (settings, segment) => {
      calls.push({ settings, segment });
      return { translatedText: "translated", provider: settings.translationProvider };
    },
    sanitizeTranslatedSubtitle: (_, text) => text,
    BLOCKED_HALLUCINATION_ERROR: "blocked"
  };
  vm.runInNewContext(ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { handle: context.handleTestTranslation, calls, context };
}
const settings = { enabled: false, translationProvider: "openai", openai: { model: "unsaved-model", apiKey: "test-only" } };
const message = { type: "TEST_TRANSLATION", settings, segment: { id: "test", text: "hello", source: "youtubeDom", startMs: 0, endMs: 1000 } };
const sender = { id: "test-extension", url: "chrome-extension://test-extension/options.html" };

test("diagnostics use unsaved settings without enabling or persisting the extension and bypass caches", async () => {
  const { handle, calls } = harness();
  assert.equal((await handle(message, sender)).ok, true);
  assert.equal((await handle(message, sender)).ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].settings.enabled, true);
  assert.equal(settings.enabled, false);
  assert.equal(calls[0].settings.openai.model, "unsaved-model");
});

test("content scripts and other pages cannot submit diagnostic provider settings", async () => {
  const { handle, calls } = harness();
  for (const blocked of [
    { ...sender, url: "https://www.youtube.com/watch?v=test" },
    { ...sender, id: "other-extension" },
    { ...sender, url: "chrome-extension://test-extension/options.html.evil" },
    { ...sender, url: "chrome-extension://test-extension/popup.html" },
    { id: sender.id }
  ]) assert.equal((await handle(message, blocked)).ok, false);
  assert.equal(calls.length, 0);
});

test("diagnostics retain translation output validation and provider errors", async () => {
  const { handle, context } = harness();
  context.sanitizeTranslatedSubtitle = () => "";
  assert.equal((await handle(message, sender)).error, "blocked");
  context.translateSegment = async () => { throw new Error("connection failed"); };
  await assert.rejects(handle(message, sender), /connection failed/);
});

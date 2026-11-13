import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createEmptySongCorrection, normalizeSongCorrection } from "../src/shared/corrections.ts";

const source = readFileSync(new URL("../src/corrections/index.ts", import.meta.url), "utf8");
function functions(names, globals) {
  const ast = ts.createSourceFile("corrections.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(declarations.length, names.length);
  vm.runInNewContext(ts.transpileModule(declarations.map((node) => node.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, globals);
  return globals;
}

const dirtyFunctions = ["inputValue", "splitList", "syncMetadataFromForm", "bulkEditorState", "hasUnsavedChanges", "updateDirtyState", "confirmDiscardChanges"];
const editorFunctions = [...dirtyFunctions, "field", "cloneSong", "renderEditor", "resetEditor"];
function harness(song = { ...createEmptySongCorrection(), title: "Song One", artist: "Artist One", lines: [{ id: "one", source: "original", translation: "translation" }] }) {
  const nodes = new Map(), windowHandlers = new Map();
  function element(tag = "input") {
    return {
      tag, value: "", textContent: "", disabled: false, hidden: false, isConnected: true, dataset: {}, children: [], attributes: {}, handlers: {},
      addEventListener(type, callback) { this.handlers[type] = callback; },
      setAttribute(name, value) { this.attributes[name] = value; },
      append(...children) { this.children.push(...children); },
      replaceChildren() { this.children = []; },
      focus() { c.document.activeElement = this; this.focusCount = (this.focusCount ?? 0) + 1; }, scrollIntoView() {}
    };
  }
  const getNode = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, { ...element(selector.includes("Song") ? "button" : "input"), id: selector.startsWith("#") ? selector.slice(1) : "" });
    return nodes.get(selector);
  };
  const c = {
    nodes, getNode, windowHandlers, selected: structuredClone(song), selectedIsNew: false,
    songs: [structuredClone(song)], searchText: "", savedEditorState: JSON.stringify(song),
    savedBulkState: JSON.stringify(["", ""]), actionPending: false, disabledControls: new Map(),
    structuredClone, crypto: globalThis.crypto, createEmptySongCorrection, consent: false, confirmations: [],
    window: {
      confirm: (text) => { c.confirmations.push(text); return c.consent; },
      addEventListener: (type, callback) => windowHandlers.set(type, callback)
    },
    document: {
      querySelector: getNode,
      getElementById: (id) => getNode(`#${id}`),
      querySelectorAll: () => [...nodes.values()],
      createElement: element
    },
    renderLines() {}, renderVariants() {}, renderSongList() {}, focusLine() {},
    setStatus(text) { getNode("#status").textContent = text; },
    getErrorMessage: (error) => error.message,
    setControlsBusy() {}
  };
  c.document.body = element("body");
  c.document.activeElement = c.document.body;
  const values = {
    title: song.title, artist: song.artist, composer: song.composer ?? "", aliases: song.aliases.join(", "),
    sourceLanguage: song.sourceLanguage, targetLanguage: song.targetLanguage,
    durationSeconds: song.durationSeconds?.toString() ?? "", videoIds: song.videoIds.join("\n"),
    bulkSource: "", bulkTranslation: ""
  };
  for (const [id, value] of Object.entries(values)) getNode(`#${id}`).value = value;
  functions(editorFunctions, c);
  return c;
}

test("a loaded zero-duration song starts clean after the form normalizes optional metadata", () => {
  const c = harness({ ...createEmptySongCorrection(), title: "Live song", artist: "Artist", durationSeconds: 0 });
  c.resetEditor();
  assert.equal(c.hasUnsavedChanges(), false);
  assert.equal(c.getNode("#unsavedChanges").hidden, true);
});

test("metadata, lyric, cover and unapplied bulk drafts are all protected", () => {
  const c = harness();
  assert.equal(c.hasUnsavedChanges(), false);
  c.getNode("#title").value = "typed title";
  assert.equal(c.hasUnsavedChanges(), true);
  c.updateDirtyState();
  assert.equal(c.getNode("#unsavedChanges").hidden, false);
  assert.equal(c.confirmDiscardChanges(), false);
  c.getNode("#title").value = "Song One";
  c.selected.lines[0].translation = "edited lyric";
  assert.equal(c.hasUnsavedChanges(), true);
  c.selected.lines[0].translation = "translation";
  c.selected.variants.push({ id: "cover", name: "new cover", videoIds: [], lineOverrides: [] });
  assert.equal(c.hasUnsavedChanges(), true);
  c.selected.variants = [];
  c.getNode("#bulkTranslation").value = "unapplied draft";
  assert.equal(c.hasUnsavedChanges(), true);
  c.getNode("#bulkTranslation").value = "";
  assert.equal(c.hasUnsavedChanges(), false);
});

test("song switching cancels without losing drafts and accepted discard loads the next song", () => {
  const c = harness();
  c.songs.push({ ...structuredClone(c.selected), id: "two", title: "Song Two" });
  functions(["renderSongList"], c);
  c.renderSongList();
  c.getNode("#title").value = "keep typed title";
  c.getNode("#songList").children[1].handlers.click();
  assert.equal(c.selected.id, c.songs[0].id);
  assert.equal(c.getNode("#title").value, "keep typed title");
  assert.equal(c.confirmations.length, 1);
  c.consent = true;
  c.getNode("#songList").children[1].handlers.click();
  assert.equal(c.selected.id, "two");
  assert.equal(c.getNode("#title").value, "Song Two");
  assert.equal(c.hasUnsavedChanges(), false);
});

test("new song and page exit protect unsaved changes but clean pages can close", () => {
  const c = harness();
  functions(["bindEvents"], c).bindEvents();
  let prevented = false;
  const event = { preventDefault() { prevented = true; } };
  c.windowHandlers.get("beforeunload")(event);
  assert.equal(prevented, false);
  c.getNode("#artist").value = "edited artist";
  c.getNode("#newSong").handlers.click();
  assert.equal(c.getNode("#artist").value, "edited artist");
  c.windowHandlers.get("beforeunload")(event);
  assert.equal(prevented, true);
  assert.equal(event.returnValue, "");
  c.consent = true;
  c.getNode("#newSong").handlers.click();
  assert.equal(c.selectedIsNew, true);
  assert.equal(c.hasUnsavedChanges(), false);
});

test("media import fills empty metadata without overwriting values typed before or during its wait", async () => {
  const c = harness({ ...createEmptySongCorrection(), title: "", artist: "" });
  c.selectedIsNew = true;
  let finish;
  let loads = 0;
  c.loadCurrentMedia = () => { loads++; return new Promise((resolve) => { finish = resolve; }); };
  functions(["bindEvents", "runAction", "setControlsBusy"], c).bindEvents();
  c.getNode("#title").value = "my typed title";
  c.getNode("#importCurrent").handlers.click();
  c.getNode("#importCurrent").handlers.click();
  assert.equal(loads, 1);
  assert.equal(c.getNode("#title").disabled, true);
  c.getNode("#title").value = "latest typed title";
  finish({ title: "imported title", author: "imported author", durationSeconds: 120, videoId: "video" });
  await new Promise(setImmediate);
  assert.equal(c.getNode("#title").value, "latest typed title");
  assert.equal(c.getNode("#artist").value, "imported author");
  assert.deepEqual([...c.selected.videoIds], ["video"]);
  assert.equal(c.getNode("#title").disabled, false);
  assert.equal(c.getNode("#deleteSong").disabled, true);
  assert.equal(c.hasUnsavedChanges(), true);
});

test("a pending save blocks duplicate submissions and resets dirty state only on success", async () => {
  const c = harness();
  c.selectedIsNew = true;
  c.getNode("#deleteSong").disabled = true;
  let finish, writes = 0;
  const stored = { ...structuredClone(c.selected), title: "saved title", version: 2 };
  c.putSongCorrection = () => { writes++; return new Promise((resolve) => { finish = resolve; }); };
  c.listSongCorrections = async () => [stored];
  c.notifyLibraryUpdated = async () => {};
  functions(["saveSelected", "runAction", "setControlsBusy"], c);
  c.getNode("#title").value = "saved title";
  c.runAction(c.saveSelected);
  c.runAction(c.saveSelected);
  assert.equal(writes, 1);
  assert.equal(c.getNode("#title").disabled, true);
  assert.equal(c.document.querySelector(".workspace").attributes["aria-busy"], "true");
  finish(stored);
  await new Promise(setImmediate);
  assert.equal(c.hasUnsavedChanges(), false);
  assert.equal(c.getNode("#title").disabled, false);
  assert.equal(c.getNode("#deleteSong").disabled, false);
  assert.equal(c.getNode("#status").textContent, "교정 사전을 저장했습니다.");
  assert.equal(c.document.querySelector(".workspace").attributes["aria-busy"], "false");
});

test("a failed save restores controls and keeps the draft protected", async () => {
  const c = harness();
  c.putSongCorrection = async () => { throw new Error("disk full"); };
  functions(["saveSelected", "runAction", "setControlsBusy"], c);
  c.getNode("#title").value = "not saved";
  c.runAction(c.saveSelected);
  await new Promise(setImmediate);
  assert.equal(c.hasUnsavedChanges(), true);
  assert.equal(c.getNode("#title").disabled, false);
  assert.equal(c.getNode("#status").textContent, "disk full");
});

test("saving cannot silently discard an unapplied bulk draft", async () => {
  const c = harness();
  c.putSongCorrection = async () => assert.fail("unapplied draft must not be written");
  functions(["saveSelected", "runAction", "setControlsBusy"], c);
  c.getNode("#bulkSource").value = "new bulk source";
  c.getNode("#bulkTranslation").value = "new bulk translation";
  c.runAction(c.saveSelected);
  await new Promise(setImmediate);
  assert.equal(c.hasUnsavedChanges(), true);
  assert.equal(c.getNode("#bulkSource").value, "new bulk source");
  assert.equal(c.getNode("#bulkTranslation").value, "new bulk translation");
  assert.match(c.getNode("#status").textContent, /일괄 반영/);
});

test("loading current lines cannot overwrite an unapplied bulk draft without consent", () => {
  const c = harness();
  functions(["bindEvents"], c).bindEvents();
  c.getNode("#bulkSource").value = "draft source";
  c.getNode("#bulkTranslation").value = "draft translation";
  c.getNode("#loadBulk").handlers.click();
  assert.equal(c.getNode("#bulkSource").value, "draft source");
  assert.equal(c.getNode("#bulkTranslation").value, "draft translation");
  c.consent = true;
  c.getNode("#loadBulk").handlers.click();
  assert.equal(c.getNode("#bulkSource").value, "original");
  assert.equal(c.getNode("#bulkTranslation").value, "translation");
  assert.equal(c.hasUnsavedChanges(), false);
});

test("file import cannot replace a draft when discard is declined", async () => {
  const c = harness();
  functions(["importFile"], c);
  c.getNode("#title").value = "keep this";
  let read = false;
  await c.importFile({ name: "replace.json", text: async () => { read = true; throw new Error("should not read"); } });
  assert.equal(read, false);
  assert.equal(c.getNode("#title").value, "keep this");
  assert.equal(c.confirmations.length, 1);
});

test("accepted LRC and SRT imports clear old bulk drafts and allow saving imported translations", async () => {
  for (const [name, text] of [["song.lrc", "[00:01.00]imported source"], ["song.srt", "1\n00:00:01,000 --> 00:00:03,000\nimported source\n"]]) {
    const c = harness();
    functions(["importFile", "parseLrc", "parseSrt", "saveSelected"], c);
    c.consent = true;
    c.getNode("#bulkSource").value = "discarded old source";
    c.getNode("#bulkTranslation").value = "discarded old translation";
    await c.importFile({ name, text: async () => text });
    assert.equal(c.getNode("#bulkSource").value, "");
    assert.equal(c.getNode("#bulkTranslation").value, "");
    assert.equal(c.selected.lines[0].source, "imported source");
    c.selected.lines[0].translation = "imported translation";
    let saved, writes = 0;
    c.putSongCorrection = async (value) => { writes++; saved = normalizeSongCorrection(value); return saved; };
    c.listSongCorrections = async () => [saved];
    c.notifyLibraryUpdated = async () => {};
    await c.saveSelected();
    assert.equal(writes, 1);
    assert.equal(saved.lines[0].translation, "imported translation");
    assert.equal(c.hasUnsavedChanges(), false);
  }
});

test("invalid lyric imports preserve the old unapplied bulk draft", async () => {
  const c = harness();
  functions(["importFile", "parseLrc", "parseSrt"], c);
  c.consent = true;
  c.getNode("#bulkSource").value = "keep source";
  c.getNode("#bulkTranslation").value = "keep translation";
  await assert.rejects(c.importFile({ name: "empty.lrc", text: async () => "not a lyric" }), /가사 줄/);
  assert.equal(c.getNode("#bulkSource").value, "keep source");
  assert.equal(c.getNode("#bulkTranslation").value, "keep translation");
});

test("async completion and errors restore button focus without stealing explicit row focus", async () => {
  const c = harness();
  functions(["runAction", "setControlsBusy"], c);
  const button = c.getNode("#saveSong");
  c.document.activeElement = button;
  let finish;
  c.runAction(() => new Promise((resolve) => { finish = resolve; }));
  c.document.activeElement = c.document.body;
  finish();
  await new Promise(setImmediate);
  assert.equal(c.document.activeElement, button);
  assert.equal(button.focusCount, 1);
  c.runAction(async () => { throw new Error("failed"); });
  c.document.activeElement = c.document.body;
  await new Promise(setImmediate);
  assert.equal(c.document.activeElement, button);
  assert.equal(button.focusCount, 2);
  c.runAction(() => new Promise((resolve) => { finish = resolve; }));
  const newRow = c.getNode("#newRow");
  c.document.activeElement = newRow;
  finish();
  await new Promise(setImmediate);
  assert.equal(c.document.activeElement, newRow);
  assert.equal(button.focusCount, 2);
});

test("focus restoration finds the replacement button after rendering", async () => {
  const c = harness();
  functions(["runAction", "setControlsBusy"], c);
  const oldButton = c.getNode("#saveSong");
  c.document.activeElement = oldButton;
  let finish;
  c.runAction(() => new Promise((resolve) => { finish = resolve; }));
  oldButton.isConnected = false;
  c.nodes.delete("#saveSong");
  const replacement = c.getNode("#saveSong");
  c.document.activeElement = c.document.body;
  finish();
  await new Promise(setImmediate);
  assert.equal(c.document.activeElement, replacement);
  assert.equal(replacement.focusCount, 1);
});

test("correction status and cover inputs have explicit accessible names", () => {
  const globals = {};
  const shell = functions(["staticShell"], globals).staticShell();
  assert.match(shell, /id="status"[^>]+role="status"[^>]+aria-live="polite"[^>]+aria-atomic="true"/);
  for (const text of ["커버 이름", "커버 가수", "커버 영상 길이(초)", "커버 YouTube 영상 ID"]) {
    assert.ok(source.includes(text), text);
  }
});

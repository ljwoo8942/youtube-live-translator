import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import ts from "typescript";

function popupFunctions(names, context) {
  const path = "src/popup/index.ts";
  const source = ts.createSourceFile(path, readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const declarations = source.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(declarations.length, names.length);
  vm.runInNewContext(ts.transpileModule(declarations.map((node) => node.getText(source)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, context);
  return context;
}

function actionHarness() {
  const controls = [{ disabled: false }, { disabled: true }, { disabled: false }];
  const status = { textContent: "" };
  const attributes = {};
  const timers = [];
  const context = popupFunctions(["runAction", "setStatus", "getErrorMessage", "closePopupAfterSuccess"], {
    actionPending: false, popupClosing: false, Error,
    app: { setAttribute: (name, value) => { attributes[name] = value; } },
    document: { querySelectorAll: () => controls, querySelector: () => status },
    window: { setTimeout: (callback, delay) => { timers.push({ callback, delay }); }, close() {} }
  });
  return { context, controls, status, attributes, timers };
}

test("popup actions start inside the user gesture and suppress duplicate pending actions", async () => {
  const { context: c, controls, status, attributes } = actionHarness();
  let finish, calls = 0;
  c.runAction(() => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  });
  assert.equal(calls, 1);
  assert.equal(attributes["aria-busy"], "true");
  assert.equal(controls.every((control) => control.disabled), true);
  c.runAction(async () => { calls++; });
  assert.equal(calls, 1);
  finish();
  await setImmediate();
  assert.equal(attributes["aria-busy"], "false");
  assert.deepEqual(controls.map((control) => control.disabled), [false, true, false]);
  assert.equal(status.textContent, "완료했습니다.");
});

test("popup failures announce their error and allow retry without closing", async () => {
  const { context: c, controls, status, timers } = actionHarness();
  c.runAction(async () => { throw new Error("서버 연결 실패"); });
  await setImmediate();
  assert.equal(status.textContent, "서버 연결 실패");
  assert.equal(timers.length, 0);
  assert.deepEqual(controls.map((control) => control.disabled), [false, true, false]);
  let retried = false;
  c.runAction(async () => { retried = true; });
  await setImmediate();
  assert.equal(retried, true);
});

test("successful popup closing cannot launch another action before its close timer", async () => {
  const { context: c, controls, timers } = actionHarness();
  c.runAction(async () => { c.closePopupAfterSuccess(); });
  await setImmediate();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 120);
  assert.equal(controls.every((control) => control.disabled), true);
  let repeated = false;
  c.runAction(async () => { repeated = true; });
  assert.equal(repeated, false);
});

test("popup retry restores focus lost through disabling but keeps a user's new focus", async () => {
  const { context: c, controls } = actionHarness();
  const doc = c.document;
  doc.body = {};
  const button = controls[0];
  button.isConnected = true;
  button.focus = () => { doc.activeElement = button; };
  let disabled = false;
  Object.defineProperty(button, "disabled", {
    get: () => disabled,
    set: (value) => {
      disabled = value;
      if (value && doc.activeElement === button) doc.activeElement = doc.body;
    }
  });
  doc.activeElement = button;
  c.runAction(async () => { throw new Error("다시 시도하세요"); });
  assert.equal(doc.activeElement, doc.body);
  await setImmediate();
  assert.equal(doc.activeElement, button);
  let finish;
  c.runAction(() => new Promise((resolve) => { finish = resolve; }));
  const other = {};
  doc.activeElement = other;
  finish();
  await setImmediate();
  assert.equal(doc.activeElement, other);
});

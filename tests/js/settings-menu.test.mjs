import { installEditorHandler } from "./editor-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { bindSettingsMenu } from "../../src/js/settings-menu.mjs";
import { clearSavedEditorSettings, editorSettingKey } from "../../src/js/settings-storage.mjs";
import { createUnsavedChangesGuard } from "../../src/js/unsaved-changes.mjs";

class Control extends EventTarget {
  attrs = new Map();
  hidden = false;
  setAttribute(name, value) { this.attrs.set(name, value); }
  focus() { this.focused = true; }
}

test("設定を開くとダウンロードを閉じ、Escとメニュー外の操作で閉じる", () => {
  const trigger = new Control(), menu = new Control(), reset = new Control();
  const settingsActions = { contains: target => [trigger, menu, reset].includes(target) };
  const previousDocument = globalThis.document;
  globalThis.document = new EventTarget();
  let closedDownloads = 0, resets = 0;
  menu.hidden = true;
  try {
    bindSettingsMenu({ "settings-menu-toggle": trigger, "settings-menu": menu,
      "reset-settings": reset, "settings-actions": settingsActions },
    () => closedDownloads++, () => resets++);
    trigger.dispatchEvent(new Event("click"));
    assert.equal(menu.hidden, false);
    assert.equal(trigger.attrs.get("aria-expanded"), "true");
    assert.equal(reset.focused, true);
    assert.equal(closedDownloads, 1);
    const escape = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
    document.dispatchEvent(escape);
    assert.equal(menu.hidden, true);
    assert.equal(trigger.focused, true);
    assert.equal(escape.defaultPrevented, true);
    trigger.dispatchEvent(new Event("click"));
    document.dispatchEvent(new Event("pointerdown"));
    assert.equal(menu.hidden, true);
    trigger.dispatchEvent(new Event("click"));
    reset.dispatchEvent(new Event("click"));
    assert.equal(menu.hidden, true);
    assert.equal(trigger.attrs.get("aria-expanded"), "false");
    assert.equal(resets, 1);
  } finally {
    globalThis.document = previousDocument;
  }
});


test("確認を断ると設定を保ち、承認後はアプリの旧設定も消して二重確認なしで再読み込みする", () => {
  const settings = new Map([
    ["pdf-page-editor.pane-width", "60"],
    ["other-tool.settings", "keep"],
    ["pdf-page-editor.view-sizes", "{}"],
    ["pdf-page-editor.styles.v3", "{}"],
    ["pdf-page-editor.styles.v2", "{}"],
    ["pdf-page-editor.styles.v1", "{}"],
    [editorSettingKey("future-setting"), "custom"],
    ["pdf-page-editor2.settings", "also keep"],
  ]);
  const window = new EventTarget();
  window.localStorage = {
    get length() { return settings.size; },
    key: index => [...settings.keys()][index],
    removeItem: key => settings.delete(key),
  };
  const state = { pages: [], settings: {} };
  const guard = createUnsavedChangesGuard(window, () => state);
  state.pages = [{}];
  const confirmMessages = [];
  let accepted = false, reloads = 0, resets = 0;
  window.confirm = message => { confirmMessages.push(message); return accepted; };
  window.location = { reload() {
    const leave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leave);
    assert.equal(leave.defaultPrevented, false);
    reloads++;
  } };
  const context = vm.createContext({ window, clearSavedEditorSettings, unsavedChanges: guard, pointerOperation: null,
    workspace: { busy: false }, downloadPanel: { reset() { resets++; } } });
  installEditorHandler(context, "resetEditorSettings");
  context.resetEditorSettings();
  assert.equal(settings.size, 8);
  assert.equal(reloads, 0);
  assert.equal(resets, 0);
  accepted = true;
  context.resetEditorSettings();
  assert.equal(confirmMessages.length, 2);
  assert.match(confirmMessages[1], /未保存の編集/);
  assert.deepEqual([...settings], [["other-tool.settings", "keep"], ["pdf-page-editor2.settings", "also keep"]]);
  assert.equal(reloads, 1);
  assert.equal(resets, 1);
});

test("ブラウザの保存領域にアクセスできない場合は再読み込みせずエラーを表示する", () => {
  const messages = [];
  const window = { confirm: () => true, get localStorage() { throw new Error("storage unavailable"); } };
  const context = vm.createContext({ window, clearSavedEditorSettings, pointerOperation: null,
    workspace: { busy: false }, console: { error() {} }, showStatus: message => messages.push(message) });
  installEditorHandler(context, "resetEditorSettings");
  context.resetEditorSettings();
  assert.deepEqual(messages, ["ブラウザに保存した設定を初期化できませんでした。"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { resolveEditorShortcut } from "../../src/js/editor-shortcuts.mjs";

const ready = { scope: "annotations", hasPages: true, hasActivePage: true,
  hasAnnotationSelection: true, hasPageSelection: true, annotationToolsVisible: true };
const key = (key, extra = {}) => ({ key, ...extra });

test("コピー・貼り付け・Undo/RedoはWindows/Macで共通、文字選択中のコピーはブラウザへ渡す", () => {
  for (const modifier of ["ctrlKey", "metaKey"]) {
    const event = (value, extra) => key(value, { [modifier]: true, ...extra });
    assert.equal(resolveEditorShortcut(event("a"), ready), "select-all-annotations");
    assert.equal(resolveEditorShortcut(event("c"), ready), "copy-annotations");
    assert.equal(resolveEditorShortcut(event("v"), ready), "paste-annotations");
    assert.equal(resolveEditorShortcut(event("z"), ready), "undo");
    assert.equal(resolveEditorShortcut(event("z", { shiftKey: true }), ready), "redo");
    assert.equal(resolveEditorShortcut(event("y"), ready), "redo");
    assert.equal(resolveEditorShortcut(event("c"), { ...ready, textSelected: true }), null);
  }
});
test("書き込みツールを閉じた状態ではテキストの全選択を抑止し、ページ一覧の全選択は受け付ける", () => {
  const closed = { ...ready, annotationToolsVisible: false };
  for (const modifier of ["ctrlKey", "metaKey"]) {
    const command = value => key(value, { [modifier]: true });
    assert.equal(resolveEditorShortcut(command("a"), closed), "prevent-native-select-all");
    const pageList = { ...closed, scope: "pages" };
    assert.equal(resolveEditorShortcut(command("a"), pageList), "select-all-pages");
    assert.equal(resolveEditorShortcut(command("a"), { ...pageList, hasPages: false }), "prevent-native-select-all");
    for (const flag of ["busy", "operationInProgress", "exportMenuOpen"]) {
      assert.equal(resolveEditorShortcut(command("a"), { ...pageList, [flag]: true }), "prevent-native-select-all");
    }
    for (const value of ["c", "v"]) assert.equal(resolveEditorShortcut(command(value), closed), null);
  }
  for (const value of ["Delete", "Backspace", "Escape"]) assert.equal(resolveEditorShortcut(key(value), closed), null);
  assert.equal(resolveEditorShortcut(key("Delete"), { ...closed, scope: "pages" }), "delete-pages");
});

test("入力欄のCtrl／Command+Aは書き込みツールを閉じていてもブラウザに委ねる", () => {
  const target = { closest: () => ({}) };
  for (const modifier of ["ctrlKey", "metaKey"]) {
    const event = key("a", { [modifier]: true, target });
    assert.equal(resolveEditorShortcut(event, { ...ready, annotationToolsVisible: false }), null);
    assert.equal(resolveEditorShortcut(event, { ...ready, annotationToolsVisible: false, exportMenuOpen: true }), null);
  }
});
test("ドラッグ中・書き出し中の全選択/貼り付け/Undoで、確定前の編集状態を変更しない", () => {
  for (const flag of ["busy", "operationInProgress"]) for (const value of ["a", "v", "z", "y", "Delete", "ArrowLeft"]) {
    const event = key(value, { ctrlKey: value.length === 1 });
    assert.equal(resolveEditorShortcut(event, { ...ready, [flag]: true }), null);
  }
});
test("Escは書き出しメニューを先に閉じ、入力欄・IME・ダイアログでは編集コマンドを動かさない", () => {
  assert.equal(resolveEditorShortcut(key("Escape"), { ...ready, exportMenuOpen: true }), "close-export-menu");
  assert.equal(resolveEditorShortcut(key("Delete"), { ...ready, exportMenuOpen: true }), null);
  assert.equal(resolveEditorShortcut(key("Escape"), ready), "clear-annotation-selection");
  for (const extra of [{ isComposing: true }, { defaultPrevented: true }, { target: { closest: () => ({}) } }]) {
    assert.equal(resolveEditorShortcut(key("Delete", extra), ready), null);
  }
  assert.equal(resolveEditorShortcut(key("Escape"), { ...ready, dialogOpen: true }), null);
});

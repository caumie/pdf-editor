import { installEditorHandler } from "./editor-fixture.mjs";
import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { bindPreviewTouchGestures } from "../../src/js/preview-gestures.mjs";
import { clampPreviewZoom } from "../../src/js/view-sizes.mjs";
import { adjacentPreviewIndex, previewPageIndexes } from "../../src/js/preview-layout.mjs";

import { resolveEditorShortcut } from "../../src/js/editor-shortcuts.mjs";

class Surface extends EventTarget {
  captures = new Set();
  dataset = {};
  classList = { contains: () => false };
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
  closest() { return null; }
}
function pointer(stage, type, id, x = 0, y = 0, pointerType = "touch") {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerId: id, pointerType, clientX: x, clientY: y, button: 0 });
  stage.dispatchEvent(event);
  if (type === "pointerup" || type === "pointercancel") stage.captures.delete(id);
  return event;
}
function keyboardFixture() {
  const calls = [];
  const context = vm.createContext({
    documentHistory: { pages: [] }, document: { getSelection: () => null }, resolveEditorShortcut,
    ui: { "export-form": { hidden: true }, "mark-dialog": { open: false }, "preview-edit-bars": { hidden: false } },
    workspace: { busy: false }, annotationEditor: { tool: "select" }, pointerOperation: null,
    shortcutScope: "pages", pageView: { selectedPageIds: new Set(["page1", "page2"]) },
    adjacentPreviewIndex, previewPageIndexes, previewDisplay: { mode: "single", cover: true, direction: "left" },
    selectedAnnotation: () => ({ id: 1 }), hasAnnotationGroupSelection: () => false,
    removeSelectedPages: () => calls.push("pages"), removeSelectedAnnotations: () => calls.push("annotations"),
    activePreviewPage: () => ({}), stepPreview() {},
  });
  installEditorHandler(context, "handleKeyboardShortcut");
  installEditorHandler(context, "navigateFromKeyboard");
  function press(key, target = new Surface(), extra = {}) {
    const event = { key, target, preventDefault() { this.defaultPrevented = true; }, ...extra };
    context.handleKeyboardShortcut(event);
    return event;
  }
  return { context, calls, press };
}

test("編集ツールと注釈選択が残っていても、ページ一覧のDeleteは選択ページを削除する", () => {
  const { calls, press } = keyboardFixture();
  assert.equal(press("Delete").defaultPrevented, true);
  assert.deepEqual(calls, ["pages"]);
});
test("ページのチェックボックスにフォーカスがあっても、DeleteとMacのBackspaceで削除できる", () => {
  const { calls, press } = keyboardFixture();
  const check = { closest: () => ({}), classList: { contains: value => value === "page-check" } };
  press("Delete", check); press("Backspace", check);
  assert.deepEqual(calls, ["pages", "pages"]);
});
test("ページ一覧の矢印キーはプレビューと選択対象を一緒に移し、表示とDelete対象をずらさない", () => {
  const { context, calls, press } = keyboardFixture();
  Object.assign(context, {
    documentHistory: { pages: [{ id: "page1" }, { id: "page2" }] },
    pageView: { previewPageId: "page1", selectedPageIds: new Set(["page1"]) },
    activePreviewPageIndex: () => 0, selectAnnotation() {}, refreshPageSelection() {},
    thumbnailCards: new Map([["page2", { pick: { focus() {} }, element: { scrollIntoView() {} } }]]),
  });
  context.scrollPreviewPagesIntoView = () => {};
  for (const name of ["pickPage", "previewPageIds"]) installEditorHandler(context, name);
  press("ArrowRight");
  assert.equal(context.pageView.previewPageId, "page2");
  assert.deepEqual([...context.pageView.selectedPageIds], ["page2"]);
  press("Delete"); assert.deepEqual(calls, ["pages"]);
});

function spreadFixture() {
  const { context: c, press } = keyboardFixture();
  const pages = Array.from({ length: 6 }, (_, i) => ({ id: "page" + (i + 1) }));
  Object.assign(c, {
    documentHistory: { pages },
    pageView: { previewPageId: "page1", selectedPageIds: new Set(["page1"]) },
    previewDisplay: { mode: "spread", cover: true, direction: "left" },
    thumbnailCards: new Map(pages.map((page, i) => {
      const classes = new Set();
      return [page.id, { classes, check: {}, pick: { focus() { c.focusedPage = page.id; }, setAttribute() {} },
        element: { classList: { toggle(name, flag) { if (flag) classes.add(name); else classes.delete(name); } },
          getBoundingClientRect() {
            const top = i * 110 - c.ui["page-area"].scrollTop;
            return { top, bottom: top + 100 };
          } } }];
    })),
    selectAnnotation() {}, updatePreviewPageInfo() {}, updateControls() {}, renderPreview() {}, renderVisibleThumbnails() {},
  });
  c.ui["page-selection-count"] = {};
  c.ui["page-area"] = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 250, height: 250 }) };
  for (const name of ["pickPage", "activePreviewPageIndex", "previewPageIds", "scrollPreviewPagesIntoView", "updateSelection", "refreshPageSelection", "goToPreview", "stepPreview"]) {
    installEditorHandler(c, name);
  }
  return { c, press };
}

test("一覧の矢印キーとプレビューの前後ボタンは見開き単位で選び、往復しても同じページを起点にする", () => {
  const { c, press } = spreadFixture();
  const check = (...ids) => {
    assert.equal(c.pageView.previewPageId, ids[0]);
    assert.deepEqual([...c.pageView.selectedPageIds], ids);
    for (const [id, card] of c.thumbnailCards) {
      assert.equal(card.classes.has("previewing"), ids.includes(id));
      assert.equal(card.check.checked, ids.includes(id));
    }
  };
  press("ArrowRight");
  check("page2", "page3");
  assert.equal(c.focusedPage, "page2");
  assert.equal(c.ui["page-area"].scrollTop, 79);
  press("ArrowRight"); check("page4", "page5");
  press("ArrowLeft"); check("page2", "page3");
  assert.equal(c.focusedPage, "page2");
  press("ArrowLeft"); check("page1");
  c.stepPreview(1); check("page2", "page3");
  c.stepPreview(1); check("page4", "page5");
  c.stepPreview(1); check("page6");
  c.stepPreview(1); check("page6");
  c.previewDisplay.direction = "right";
  c.shortcutScope = "annotations";
  press("ArrowRight"); check("page4", "page5");
  assert.equal(c.shortcutScope, "annotations");
  c.previewDisplay.direction = "vertical";
  press("ArrowLeft"); check("page2", "page3");
  press("ArrowRight"); check("page4", "page5");
});

test("サムネイルのクリックは見開きを選び、追加選択の操作ではページを個別に指定できる", () => {
  const { c } = spreadFixture();
  c.pickPage("page3");
  assert.equal(c.pageView.previewPageId, "page3");
  assert.deepEqual([...c.pageView.selectedPageIds], ["page2", "page3"]);
  c.pickPage("page2", true);
  assert.deepEqual([...c.pageView.selectedPageIds], ["page3"]);
  assert.equal(c.thumbnailCards.get("page2").check.checked, false);
  assert.equal(c.thumbnailCards.get("page2").classes.has("previewing"), true);
  c.goToPreview(2);
  assert.equal(c.pageView.previewPageId, "page3");
  assert.deepEqual([...c.pageView.selectedPageIds], ["page3"]);
  c.pickPage("page5", false, true);
  assert.deepEqual([...c.pageView.selectedPageIds], ["page3", "page4", "page5"]);
});

test("表示方法を切り替えると表示に連動した選択が広がり、明示した複数選択は保たれる", () => {
  const { c } = spreadFixture();
  Object.assign(c, {
    preview: {}, previewTouches: null, cancelPointerOperation() {}, stopPreviewZoom() {}, replacePreviewRender() {},
    requestAnimationFrame: callback => callback(),
  });
  c.ui["preview-layout"] = { value: "spread" };
  c.ui["preview-cover"] = { checked: true };
  c.ui["preview-direction"] = { value: "vertical" };
  c.previewDisplay.mode = "single";
  c.pickPage("page3");
  installEditorHandler(c, "applyPreviewDisplay");
  c.applyPreviewDisplay();
  assert.equal(c.previewDisplay.direction, "vertical");
  assert.deepEqual([...c.pageView.selectedPageIds], ["page2", "page3"]);
  c.pickPage("page6", true);
  c.ui["preview-layout"].value = "single";
  c.applyPreviewDisplay();
  assert.deepEqual([...c.pageView.selectedPageIds], ["page2", "page3", "page6"]);
  assert.equal(c.thumbnailCards.get("page3").classes.has("previewing"), false);
  assert.equal(c.thumbnailCards.get("page6").classes.has("previewing"), true);
});
test("プレビューのDeleteは注釈だけを削除し、注釈未選択ならページを消さない", () => {
  const { context, calls, press } = keyboardFixture();
  context.shortcutScope = "annotations";
  press("Delete");
  context.selectedAnnotation = () => null;
  assert.equal(press("Delete").defaultPrevented, undefined);
  assert.deepEqual(calls, ["annotations"]);
});
test("クリックした領域とTabで移った領域に従ってDeleteの対象が切り替わる", () => {
  const { context, calls, press } = keyboardFixture();
  for (const id of ["pages-panel", "preview-panel", "thumbnail-size", "file-input", "undo", "redo", "rotate-pages-left", "rotate-pages-right", "move-pages-earlier", "move-pages-later", "remove-pages", "select-all-pages", "clear-page-selection", "clear-document"]) {
    context.ui[id] = new Surface();
  }
  Object.assign(context, { filePickerButtons: [], thumbnailSize: "medium", updateThumbnailSize() {}, restoreDocumentRevision() {}, clearDocument() {} });
  installEditorHandler(context, "bindPageControls");
  context.bindPageControls();
  context.ui["preview-panel"].dispatchEvent(new Event("focusin")); press("Delete");
  context.ui["pages-panel"].dispatchEvent(new Event("pointerdown")); press("Delete");
  context.ui["preview-panel"].dispatchEvent(new Event("focusin")); press("Delete");
  assert.deepEqual(calls, ["annotations", "pages", "annotations"]);
});
test("文字入力・ダイアログ・IME変換中・操作中は削除ショートカットで文書を変更しない", () => {
  const { context, calls, press } = keyboardFixture();
  press("Delete", { closest: () => ({}), classList: { contains: () => false } });
  press("Backspace", new Surface(), { isComposing: true });
  context.ui["mark-dialog"].open = true; press("Delete");
  context.ui["mark-dialog"].open = false;
  context.pointerOperation = { kind: "pinch" }; press("Delete");
  context.pointerOperation = null; context.workspace.busy = true; press("Delete");
  assert.deepEqual(calls, []);
});

test("1本指は通常の操作へ通し、2本指から拡大縮小し、残った指で誤描画しない", () => {
  const stage = new Surface(), changes = []; let starts = 0, ends = 0, ordinaryUps = 0;
  bindPreviewTouchGestures(stage, { canStart: () => true,
    start: () => { starts++; }, move: point => changes.push(point), end: () => { ends++; } });
  stage.addEventListener("pointerup", () => { ordinaryUps++; });
  assert.equal(pointer(stage, "pointerdown", 1, 100, 100).defaultPrevented, false);
  assert.equal(pointer(stage, "pointerdown", 2, 200, 100).defaultPrevented, true);
  pointer(stage, "pointermove", 2, 300, 100);
  assert.equal(changes[0].distance, 200);
  assert.equal(changes[0].clientX, 200);
  pointer(stage, "pointerup", 2, 300, 100);
  pointer(stage, "pointermove", 1, 130, 100);
  pointer(stage, "pointerup", 1, 130, 100);
  assert.equal(starts, 1); assert.equal(ends, 1); assert.equal(ordinaryUps, 0);
  const click = new Event("click", { cancelable: true }); stage.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  pointer(stage, "pointerdown", 3, 150, 150);
  const nextClick = new Event("click", { cancelable: true }); stage.dispatchEvent(nextClick);
  assert.equal(nextClick.defaultPrevented, false);
});
test("指の入れ替え・キャンセル・画面切替の後も次のピンチを開始できる", () => {
  const stage = new Surface(); let starts = 0, ends = 0;
  const gesture = bindPreviewTouchGestures(stage, { canStart: () => true, start: () => { starts++; }, move() {}, end: () => { ends++; } });
  pointer(stage, "pointerdown", 1, 0, 100); pointer(stage, "pointerdown", 2, 100, 100);
  pointer(stage, "pointerdown", 3, 200, 100); pointer(stage, "pointerup", 1);
  assert.equal(starts, 2);
  pointer(stage, "pointercancel", 2); pointer(stage, "pointercancel", 3);
  assert.equal(ends, 1);
  pointer(stage, "pointerdown", 4); pointer(stage, "pointerdown", 5, 100);
  gesture.reset(); assert.equal(ends, 2); assert.equal(stage.captures.size, 0);
  pointer(stage, "pointerdown", 6); pointer(stage, "pointerdown", 7, 100);
  pointer(stage, "pointerup", 7); pointer(stage, "pointerdown", 8, 200);
  assert.equal(starts, 5);
});
test("子キャンバスからのキャプチャ移譲を、指が離れたイベントとして扱わない", () => {
  const stage = new Surface(); let changes = 0;
  bindPreviewTouchGestures(stage, { canStart: () => true, start() {}, move: () => { changes++; }, end() {} });
  pointer(stage, "pointerdown", 1, 100, 100); pointer(stage, "pointerdown", 2, 200, 100);
  const lost = new Event("lostpointercapture");
  Object.assign(lost, { pointerId: 1 });
  Object.defineProperty(lost, "target", { value: new Surface() });
  stage.dispatchEvent(lost);
  pointer(stage, "pointermove", 2, 250, 100);
  assert.equal(changes, 1);
});

test("すべてのツールで同じピンチを使い、途中の描画・移動を取り消して倍率と中心点を更新する", () => {
  for (const tool of [null, "select", "pen", "line", "rect", "text", "note", "highlight"]) {
    const stage = new Surface(), cancelled = [], layouts = [];
    const controls = new Map();
    const ui = new Proxy({}, { get: (_, id) => {
      if (!controls.has(id)) controls.set(id, new Surface());
      return controls.get(id);
    } });
    ui["mark-dialog"].open = false;
    const context = vm.createContext({
      ui, previewStage: stage, previewTouches: null, window: new EventTarget(),
      clampPreviewZoom,
      bindPreviewTouchGestures, workspace: { busy: false }, annotationEditor: { tool },
      preview: { bitmap: { displayZoom: 1, key: "page" }, requestedZoom: 1 },
      pointerOperation: { kind: tool === "select" ? "edit" : "draw", pointerId: 1 },
      suppressPreviewClick: false,
      applyPreviewDisplay() {}, togglePreviewTools() {},
      bindPaneSeparator() {}, fitPreviewToStage() {}, resizePreviewStage() {},
      endStroke(event, cancel) { cancelled.push(cancel); context.pointerOperation = null; },
      endAnnotationDrag(event, cancel) { cancelled.push(cancel); context.pointerOperation = null; },
      resetPointerOperation() { context.pointerOperation = null; },
      finishZoomForPointer() {}, stopPreviewZoom() {}, replacePreviewRender() {}, setPreviewHover() {},
      captureZoomAnchor: point => ({ point: [10, 20], pageId: "page", x: point.clientX, y: point.clientY }),
      layoutPreviewPage(zoom, anchor) { context.preview.bitmap.displayZoom = zoom; layouts.push({ zoom, x: anchor.x, y: anchor.y }); },
      updateZoomControls() {}, refinePreviewAfterZoom() {},
      ResizeObserver: class { observe() {} },
      startPreviewPan() {}, movePreviewPan() {}, endPreviewPan() {}, updateFitButton() {},
    });
    installEditorHandler(context, "cancelPointerOperation");
    installEditorHandler(context, "bindPreviewControls");
    context.bindPreviewControls();
    pointer(stage, "pointerdown", 1, 100, 100); pointer(stage, "pointerdown", 2, 200, 100);
    pointer(stage, "pointermove", 1, 50, 100); pointer(stage, "pointermove", 2, 250, 100);
    assert.equal(context.preview.requestedZoom, 2, String(tool));
    assert.deepEqual(layouts.at(-1), { zoom: 2, x: 150, y: 100 });
    assert.deepEqual(cancelled, [true]);
    assert.equal(context.annotationEditor.tool, tool);
    pointer(stage, "pointerup", 1); pointer(stage, "pointerup", 2);
    assert.equal(context.pointerOperation, null);
  }
});

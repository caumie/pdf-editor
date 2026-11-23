import { installEditorHandler } from "./editor-fixture.mjs";
import fs from "node:fs";
import { annotationSelectionLock, setAnnotationsLocked } from "../../src/js/annotation-locks.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { annotationBounds, translateAnnotation } from "../../src/js/annotations.mjs";
import { annotationGroupBounds, translateAnnotationGroup, arrangeAnnotations } from "../../src/js/annotation-layout.mjs";
import { createAnnotationCopies } from "../../src/js/annotation-clipboard.mjs";
import { createDocumentHistory } from "../../src/js/document-history.mjs";
import { changeDocumentAnnotations } from "../../src/js/document-pages.mjs";

import { annotationsInSelectionBox, hitTestAnnotation, pointInBounds } from "../../src/js/annotation-interaction.mjs";
import { clientToPdfPoint } from "../../src/js/page-coordinates.mjs";
import { resolveEditorShortcut } from "../../src/js/editor-shortcuts.mjs";

const viewport = { viewBox: [0, 0, 300, 400], convertToViewportPoint: (x, y) => [x, 400 - y], convertToPdfPoint: (x, y) => [x, 400 - y] };
const rotated = { viewBox: viewport.viewBox, convertToViewportPoint: (x, y) => [y, x], convertToPdfPoint: (x, y) => [y, x] };
const rect = (id, x, y, width = 20, height = 20) => ({ id, kind: "rect", points: [[x, y], [x + width, y + height]], width: 2, color: "#ff0000" });
const originals = () => [rect(1, 10, 10), rect(2, 60, 50, 30, 10),
  { id: 3, kind: "external", subtype: "Stamp", rect: [110, 90, 140, 120], offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 }];
const plain = value => JSON.parse(JSON.stringify(value));
function screenBox(annotation, view) {
  const b = annotationBounds(annotation);
  const points = [[b.left, b.top], [b.left, b.bottom], [b.right, b.top], [b.right, b.bottom]].map(([x, y]) => view.convertToViewportPoint(x, y));
  return { left: Math.min(...points.map(p => p[0])), right: Math.max(...points.map(p => p[0])),
    top: Math.min(...points.map(p => p[1])), bottom: Math.max(...points.map(p => p[1])) };
}

test("複数移動はページ端でも相対位置を保ち、外部注釈の変換を一度だけ合成する", () => {
  const source = originals(), before = plain(source);
  const moved = translateAnnotationGroup(source, 1000, -1000, viewport.viewBox);
  const bounds = annotationGroupBounds(moved);
  assert.equal(bounds.right, 300); assert.equal(bounds.bottom, 0);
  assert.equal(moved[0].points[0][0] - source[0].points[0][0], moved[2].rect[0] - source[2].rect[0]);
  assert.equal(moved[2].offsetX, 160); assert.equal(moved[2].offsetY, -10);
  assert.deepEqual(source, before);
  assert.equal(moved[0].width, source[0].width);
});
test("6方向の整列はページ回転にかかわらず画面の向きに従い、重なり順と元データを変えない", () => {
  for (const view of [viewport, rotated]) for (const action of ["left", "center", "right", "top", "middle", "bottom"]) {
    const source = originals(), before = plain(source);
    const output = arrangeAnnotations(source, action, view);
    const boxes = output.map(annotation => screenBox(annotation, view));
    const edge = box => action === "center" ? (box.left + box.right) / 2 : action === "middle" ? (box.top + box.bottom) / 2 : box[action];
    assert(boxes.every(box => Math.abs(edge(box) - edge(boxes[0])) < 1e-7), action);
    assert.deepEqual(output.map(annotation => annotation.id), [1, 2, 3]);
    assert.deepEqual(source, before);
  }
});
test("等間隔は幅の異なる注釈の外端を固定し、両端の中心間に等分する", () => {
  for (const view of [viewport, rotated]) for (const action of ["distribute-x", "distribute-y"]) {
    const source = [...originals(), rect(4, 95, 65, 10, 15)];
    const output = arrangeAnnotations(source, action, view);
    const horizontal = action === "distribute-x";
    const low = horizontal ? "left" : "top", high = horizontal ? "right" : "bottom";
    const before = source.map(annotation => screenBox(annotation, view));
    const [start, end] = [before[0], before[2]].map(box => (box[low] + box[high]) / 2).sort((a, b) => a - b);
    const centers = output.filter(annotation => [2, 4].includes(annotation.id))
      .map(annotation => screenBox(annotation, view)).map(box => (box[low] + box[high]) / 2).sort((a, b) => a - b);
    assert(centers.every((center, i) => Math.abs(center - (start + (i + 1) * (end - start) / 3)) < 1e-7));
    assert.equal(output[0], source[0]);
    assert.equal(output[2], source[2]);
    assert.deepEqual(output.map(annotation => annotation.id), [1, 2, 3, 4]);
    assert.equal(arrangeAnnotations(output, action, view), output);
  }
  const pair = originals().slice(0, 2); assert.equal(arrangeAnnotations(pair, "distribute-x", viewport), pair);
});

test("同じ外端に接する注釈を固定し、中間は同じ中心を一つの位置として並べる", () => {
  const source = [
    rect(1, 10, 10, 10), rect(2, 10, 45, 24),
    rect(3, 58, 10, 4), rect(4, 30, 40, 60), rect(5, 30, 25, 10),
    rect(6, 65, 40, 75), rect(7, 117, 20, 23),
  ];
  for (const [view, action, low, high] of [
    [viewport, "distribute-x", "left", "right"],
    [rotated, "distribute-y", "top", "bottom"],
  ]) {
    const result = arrangeAnnotations(source, action, view);
    const boxes = result.map(annotation => screenBox(annotation, view));
    for (const index of [0, 1, 5, 6]) assert.equal(result[index], source[index]);
    const center = index => (boxes[index][low] + boxes[index][high]) / 2;
    assert.equal(center(2), center(3));
    assert(Math.abs(center(4) - (center(0) * 2 + center(6)) / 3) < 1e-7);
    assert(Math.abs(center(2) - (center(0) + center(6) * 2) / 3) < 1e-7);
    assert.equal(arrangeAnnotations(result, action, view), result);
  }
  const twoPositions = [source[0], source[1], source[5], source[6]];
  assert.equal(arrangeAnnotations(twoPositions, "distribute-x", viewport), twoPositions);
});

test("一つの注釈が両端を占めても、内側の注釈を中心順で配置する", () => {
  const source = [rect(1, 10, 10, 120), rect(2, 64, 10, 10), rect(3, 25, 10, 70)];
  const result = arrangeAnnotations(source, "distribute-x", viewport);
  assert.equal(result[0], source[0]);
  const centers = result.slice(1).map(annotation => {
    const { left, right } = annotationBounds(annotation);
    return (left + right) / 2;
  });
  assert.deepEqual(centers, [90, 50]);
  assert.equal(arrangeAnnotations(result, "distribute-x", viewport), result);
});

test("中間に幅の大きい注釈がある場合は、両端を越えない共通の中心間隔を使う", () => {
  const source = [rect(1, 0, 10, 15), rect(2, 4, 10, 180), rect(3, 105, 10, 10),
    rect(4, 130, 10, 15), rect(5, 180, 10, 20)];
  const result = arrangeAnnotations(source, "distribute-x", viewport);
  assert.equal(result[0], source[0]);
  assert.equal(result[4], source[4]);
  const boxes = result.slice(1, 4).map(annotationBounds);
  const centers = boxes.map(box => (box.left + box.right) / 2);
  assert(boxes.every(box => 0 < box.left && box.right < 200));
  assert(Math.abs(centers[1] - centers[0] - 10) < 1e-6);
  assert(Math.abs(centers[2] - centers[1] - 10) < 1e-6);
  assert.equal(centers[1], 100);
  assert.equal(arrangeAnnotations(result, "distribute-x", viewport), result);
});

class Control extends EventTarget {
  dataset = {}; style = {}; attrs = new Map(); captures = new Set(); hidden = false; open = false; value = "";
  classes = new Set();
  classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name), contains: name => this.classes.has(name) };
  setAttribute(name, value) { this.attrs.set(name, value); }
  getAttribute(name) { return this.attrs.get(name); }
  querySelector() { if (!this.child) this.child = new Control(); return this.child; }
  replaceChildren() {}
  focus() { this.focused = true; }
  closest() { return null; }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
}
function fixture() {
  const controls = new Map();
  const ui = new Proxy({}, { get(_, id) { if (!controls.has(id)) controls.set(id, new Control()); return controls.get(id); } });
  ui["export-form"].hidden = ui["settings-menu"].hidden = true;
  const history = createDocumentHistory(); history.commit([{ id: "p", sourcePdfId: 1, annotations: originals() }]);
  const body = new Control(), masthead = new Control(), document = new Control();
  document.getSelection = () => null;
  document.body = body; document.querySelector = () => masthead;
  const released = [];
  const context = vm.createContext({
    ui, document, documentPropertiesUi: { reset() {}, update() {} }, unsavedChanges: { markSaved() {} }, annotationSelectionLock, setAnnotationsLocked, changeAnnotationLock() {}, window: { confirm: () => true }, workspace: { ready: true, busy: false, sourcePdfs: new Map([[1, {
      externalRenderer: { destroy: () => { released.push("external"); return Promise.resolve(); } },
      loadingTask: { destroy: () => { released.push("source"); return Promise.resolve(); } },
    }]]) },
    documentHistory: history, pageView: { previewPageId: "p", selectedPageIds: new Set(["p"]) },
    preview: { bitmap: { pageId: "p", viewport }, requestedZoom: 1 },
    previewDisplay: { mode: "single", cover: true, direction: "left" },
    annotationEditor: { tool: null, selectedIds: new Set(), hoveredId: null, multiSelect: false },
    annotationClipboard: { annotations: originals(), sourcePageId: "p", pasteCounts: new Map([["p", 1]]) },
    downloadPanel: { setOpen() {}, reset() {
      ui["export-form"].hidden = true;
      ui["export-format"].value = "pdf"; ui["output-name"].value = "";
    } },
    previewStage: new Control(), annotationOverlay: new Control(), previewTextLayer: new Control(),
    previewTouches: { reset() {} }, pointerOperation: null, previewHoverPointer: null, shortcutScope: "annotations", suppressPreviewClick: false,
    previewModeButtons: [], annotationAlignButtons: [],
    annotationGroupBounds, translateAnnotationGroup, arrangeAnnotations, changeDocumentAnnotations, annotationsInSelectionBox, pointInBounds, clientToPdfPoint, resolveEditorShortcut,
    displayToolStyle() {}, updateAnnotationControls() {}, drawPreviewAnnotations() {}, refreshHighlightTextLayer() {}, updateZoomControls() {},
    finishZoomForPointer() {}, stopPreviewZoom() {}, replacePreviewRender() {},
    pointerToPdfPoint: event => [event.clientX, event.clientY], pdfToPreviewScale: () => 1,
    annotationAt: () => context.hit?.annotation, editTargetAt: () => context.hit,
    setPreviewHover() {}, updatePreviewHover() {}, beginStroke() {}, endStroke() {},
    beginAnnotationDrag() {}, moveAnnotationDrag() {}, endAnnotationDrag() {},
    applySelectedHighlight() {}, updateHighlightAction() {}, commitToolStyle() {},
    doubleClickPreview() {}, submitTextEditor() {}, copySelectedAnnotations() {}, pasteAnnotations() {},
    requestAnimationFrame: fn => fn(), renderPreview() {}, renderPageGrid() {}, refreshPageSelection() {}, showStatus() {},
  });
  context.commitDocumentRevision = pages => { history.commit(pages); context.commits = (context.commits ?? 0) + 1; };
  for (const name of ["ensureAnnotationsUnlocked", "changeAnnotationLock", "workspaceAvailable", "activePreviewPage", "findAnnotation", "selectedAnnotation", "hasAnnotationGroupSelection", "selectedAnnotations", "setPreviewTool", "selectAnnotation", "setAnnotationSelection", "toggleAnnotationSelection", "toggleMultiSelection", "toggleRangeSelection", "annotationSelectionGesture", "refreshPreviewHoverModifiers", "selectAllPageAnnotations", "updatePageAnnotations", "resetPointerOperation", "cancelPointerOperation", "beginRangeSelection", "moveRangeSelection", "endRangeSelection", "beginAnnotationGroupDrag", "moveAnnotationGroupDrag", "endAnnotationGroupDrag", "arrangeSelectedAnnotations", "clickPreview", "removeSelectedAnnotations", "bindAnnotationControls", "releaseUnusedSourcePdfs", "clearDocument", "navigateFromKeyboard", "handleKeyboardShortcut"]) {
    installEditorHandler(context, name);
  }
  context.bindAnnotationControls();
  ui["preview-selection-box"].hidden = true;
  function pointer(type, x = 0, y = 0, extra = {}) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { button: 0, pointerId: 1, pointerType: "mouse", clientX: x, clientY: y, ...extra });
    context.annotationOverlay.dispatchEvent(event);
  }
  return { context, history, ui, body, masthead, released, pointer };
}

test("範囲選択で接触する注釈を選び、通常のドラッグで選んだ注釈を一括移動できる", () => {
  const { context: c, history, ui, pointer } = fixture();
  const original = history.pages[0];
  c.preview.bitmap.viewport = { ...rotated, width: 400, height: 300 };
  c.annotationOverlay.getBoundingClientRect = () => ({ left: 100, top: 50, width: 800, height: 600 });
  installEditorHandler(c, "pointerToPdfPoint");
  c.setPreviewTool("select");
  ui["mark-range-select"].dispatchEvent(new Event("click"));
  pointer("pointerdown", 220, 216);
  pointer("pointermove", 130, 80);
  assert.equal(ui["preview-selection-box"].hidden, false);
  assert.deepEqual({ ...ui["preview-selection-box"].style },
    { left: "3.75%", top: "5%", width: "11.25%", height: "22.666666666666664%" });
  pointer("pointerup", 130, 80);
  pointer("click", 130, 80);
  assert.equal(ui["preview-selection-box"].hidden, true);
  assert.deepEqual(plain(c.selectedAnnotations().map(a => a.id)), [1, 2]);
  assert.equal(history.pages[0], original);

  pointer("pointerdown", 296, 306, { shiftKey: true });
  pointer("pointerup", 282, 284);
  assert.deepEqual(plain(c.selectedAnnotations().map(a => a.id)), [1, 2, 3]);
  ui["mark-range-select"].dispatchEvent(new Event("click"));
  c.hit = { annotation: original.annotations[0], handle: null };
  pointer("pointerdown", 140, 90);
  pointer("pointerup", 160, 110);
  assert.deepEqual(plain(history.pages[0].annotations[0].points), [[20, 20], [40, 40]]);
  assert.equal(c.commits, 1);
});

test("タッチの範囲選択は離した時に確定し、キャンセルで既存の選択を保つ", () => {
  const { context: c, history, ui, pointer } = fixture();
  c.preview.bitmap.viewport = { ...rotated, width: 400, height: 300 };
  c.setPreviewTool("select");
  c.toggleRangeSelection();
  const touch = { pointerType: "touch" };
  c.setAnnotationSelection([3]);
  pointer("pointerdown", 5, 5, touch);
  pointer("pointermove", 65, 65, touch);
  pointer("pointercancel", 65, 65, touch);
  assert.equal(ui["preview-selection-box"].hidden, true);
  assert.deepEqual(plain(c.selectedAnnotations().map(a => a.id)), [3]);
  pointer("pointerdown", 5, 5, touch);
  pointer("pointerup", 65, 65, touch);
  assert.deepEqual(plain(c.selectedAnnotations().map(a => a.id)), [1, 2]);
  pointer("pointerdown", 5, 5, touch);
  pointer("pointermove", 65, 65, touch);
  c.handleKeyboardShortcut({ key: "Escape", preventDefault() {} });
  assert.equal(ui["preview-selection-box"].hidden, true);
  assert.deepEqual(plain(c.selectedAnnotations().map(a => a.id)), [1, 2]);
  assert.equal(history.pages[0].annotations.length, 3);
});

test("Shiftドラッグで範囲内の選択だけを反転し、Shiftを途中で離しても同じ範囲操作を完了する", () => {
  const { context: c, history, ui, pointer } = fixture();
  c.preview.bitmap.viewport = { ...rotated, width: 400, height: 300 };
  c.setPreviewTool("select");
  c.setAnnotationSelection([1, 3]);
  pointer("pointerdown", 20, 20, { shiftKey: true });
  pointer("pointermove", 80, 65);
  assert.equal(ui["preview-selection-box"].hidden, false);
  assert.deepEqual(plain(c.selectedAnnotations().map(a => a.id)), [1, 3]);
  pointer("pointerup", 80, 65);
  pointer("click", 80, 65);
  assert.equal(ui["preview-selection-box"].hidden, true);
  assert.deepEqual(plain(c.selectedAnnotations().map(a => a.id)), [2, 3]);
  assert.equal(c.annotationEditor.rangeSelect, false);
  assert.equal(history.pages[0].annotations.length, 3);
  assert.equal(c.commits, undefined);
});

test("枠が斜線の外接領域や複数行ハイライトの行間にあるだけでは選択しない", () => {
  const line = { id: 1, kind: "line", points: [[0, 0], [40, 40]], width: 2 };
  const highlight = { id: 2, kind: "highlight", quads: [
    [[10, 40], [30, 40], [10, 42], [30, 42]], [[10, 50], [30, 50], [10, 52], [30, 52]],
  ] };
  assert.deepEqual(annotationsInSelectionBox([line, highlight], [20, 44], [21, 47]), []);
  assert.deepEqual(annotationsInSelectionBox([line, highlight], [9, 20], [12, 23]), []);
  assert.deepEqual(annotationsInSelectionBox([line, highlight], [22, 21], [21, 20]), [line]);
  assert.deepEqual(annotationsInSelectionBox([line, highlight], [29, 41], [34, 44]), [highlight]);
});

test("Shift・Ctrl・MacのCommandと追加選択ボタンで選択を追加・解除できる", () => {
  const { context: c, pointer } = fixture(); c.setPreviewTool("select");
  c.selectAnnotation(c.activePreviewPage().annotations[0]);
  for (const modifier of ["shiftKey", "ctrlKey", "metaKey"]) {
    c.hit = { annotation: c.activePreviewPage().annotations[1], handle: null };
    pointer("pointerdown", 65, 55, { [modifier]: true }); pointer("pointerup", 65, 55); pointer("click", 65, 55);
    assert.deepEqual(plain(c.selectedAnnotations().map(a => a.id)), [1, 2]);
    pointer("pointerdown", 65, 55, { [modifier]: true }); pointer("pointerup", 65, 55); pointer("click", 65, 55);
    assert.equal(c.selectedAnnotation().id, 1);
  }
  c.toggleMultiSelection(); pointer("pointerdown", 65, 55); pointer("click", 65, 55);
  assert.equal(c.selectedAnnotations().length, 2);
  c.toggleMultiSelection(); assert.equal(c.annotationEditor.multiSelect, false);
  assert.equal(c.selectedAnnotations().length, 2);
});

test("複数選択中はCtrl／Commandでポインター下の候補を表示し、その注釈を追加できる", () => {
  const { context: c, pointer } = fixture();
  Object.assign(c, { annotationBounds, hitTestAnnotation,
    renderTextAnnotationImage() {},
    drawAnnotationsOnCanvas(_canvas, _viewport, _annotations, selection) { c.selectionDrawing = selection; },
  });
  for (const name of ["annotationAt", "visibleHandleAnnotationId", "drawPreviewAnnotations", "setPreviewHover", "updatePreviewHover"]) {
    installEditorHandler(c, name);
  }
  c.setPreviewTool("select");
  c.setAnnotationSelection([1, 2]);
  pointer("pointermove", 125, 105);
  assert.equal(c.selectionDrawing.candidateId, null);
  const key = (type, name, modifiers = {}) => {
    c.document.dispatchEvent(Object.assign(new Event(type), { key: name, ...modifiers }));
  };
  key("keydown", "Control", { ctrlKey: true });
  assert.equal(c.selectionDrawing.candidateId, 3);
  assert.deepEqual([...c.selectionDrawing.ids], [1, 2]);
  assert.equal(c.selectionDrawing.id, null);
  assert.equal(c.annotationOverlay.style.cursor, "pointer");
  key("keyup", "Control");
  assert.equal(c.selectionDrawing.candidateId, null);
  key("keydown", "Meta", { metaKey: true });
  assert.equal(c.selectionDrawing.candidateId, 3);
  pointer("pointerleave");
  assert.equal(c.selectionDrawing.candidateId, null);
  pointer("pointerenter", 125, 105, { metaKey: true });
  assert.equal(c.selectionDrawing.candidateId, 3);
  pointer("pointerdown", 125, 105, { metaKey: true });
  pointer("pointerup", 125, 105);
  pointer("click", 125, 105);
  assert.deepEqual(plain(c.selectedAnnotations().map(a => a.id)), [1, 2, 3]);
});

test("同じ注釈を繰り返しペーストした列に等間隔を適用しても、両端の余白と履歴が変わらない", () => {
  const { context: c, history } = fixture();
  const annotation = rect(1, 40, 200, 11, 11);
  history.commit([{ ...history.pages[0], annotations: [annotation] }]);
  c.preview.bitmap.viewport = { ...viewport, transform: [1, 0, 0, -1, 0, 400] };
  c.annotationEditor.nextId = 2;
  Object.assign(c, { createAnnotationCopies, structuredClone });
  for (const name of ["canPasteAnnotations", "copySelectedAnnotations", "pasteAnnotations"]) {
    installEditorHandler(c, name);
  }
  c.setPreviewTool("select");
  c.setAnnotationSelection([1]);
  assert(c.copySelectedAnnotations());
  for (let i = 0; i < 6; i++) assert(c.pasteAnnotations());
  c.selectAllPageAnnotations();
  const pasted = history.pages[0];
  const boxes = pasted.annotations.map(annotationBounds);
  assert.equal(boxes.length, 7);
  for (let i = 1; i < boxes.length; i++) {
    assert.equal(boxes[i].left - boxes[i - 1].right, 1);
    assert.equal(boxes[i - 1].bottom - boxes[i].top, 1);
  }
  const commits = c.commits;
  for (const action of ["distribute-x", "distribute-y"]) {
    c.arrangeSelectedAnnotations(action);
    assert.equal(history.pages[0], pasted, action);
    assert.equal(c.commits, commits, action);
  }
});

test("等間隔をクリックすると一回だけ編集履歴に入り、二度目は位置も履歴も変わらない", () => {
  const { context: c, history } = fixture();
  history.commit([{ ...history.pages[0], annotations: [rect(1, 10, 10, 130), rect(2, 60, 50, 30, 10), rect(3, 95, 90, 20)] }]);
  const original = history.pages[0];
  const distribute = new Control();
  distribute.dataset.align = "distribute-x";
  c.annotationAlignButtons = [distribute];
  c.bindAnnotationControls();
  c.setPreviewTool("select");
  c.setAnnotationSelection([1, 2, 3]);
  distribute.dispatchEvent(new Event("click"));
  const arranged = history.pages[0];
  assert.equal(arranged.annotations[0], original.annotations[0]);
  assert(Math.abs(annotationBounds(arranged.annotations[1]).left + 15 - (10 + 130 / 3)) < 1e-7);
  assert(Math.abs(annotationBounds(arranged.annotations[2]).left + 10 - (10 + 260 / 3)) < 1e-7);
  assert.equal(c.commits, 1);
  distribute.dispatchEvent(new Event("click"));
  assert.equal(history.pages[0], arranged);
  assert.equal(c.commits, 1);
  history.step("undo");
  assert.equal(history.pages[0], original);
});
test("移動モードから全選択しても、全体をドラッグでき、1回のUndoで相対配置ごと戻せる", () => {
  const { context: c, history, pointer } = fixture(); const original = history.pages[0];
  c.selectAllPageAnnotations(); assert.equal(c.annotationEditor.tool, "select");
  c.hit = { annotation: original.annotations[0], handle: null };
  pointer("pointerdown", 20, 20); pointer("pointermove", 60, 50); pointer("pointerup", 60, 50); pointer("click", 60, 50);
  const moved = history.pages[0].annotations;
  assert.deepEqual(plain(moved[0].points), [[50, 40], [70, 60]]);
  assert.deepEqual(plain(moved[2].rect), [150, 120, 180, 150]);
  assert.equal(moved[2].offsetX, 40); assert.equal(moved[2].offsetY, 30);
  assert.equal(c.selectedAnnotations().length, 3); assert.equal(c.commits, 1);
  history.step("undo"); assert.equal(history.pages[0], original);
  history.step("redo"); assert.equal(history.pages[0].annotations[2].offsetX, 40);
});
test("複数移動のキャンセルと整列も一括処理し、未選択オブジェクトを変更しない", () => {
  const { context: c, history, pointer } = fixture(); const original = history.pages[0];
  c.setPreviewTool("select"); c.setAnnotationSelection([1, 2]);
  c.hit = { annotation: original.annotations[0], handle: null };
  pointer("pointerdown", 20, 20); pointer("pointermove", 60, 50); pointer("pointercancel", 60, 50);
  assert.equal(history.pages[0], original); assert.equal(c.commits, undefined);
  pointer("pointerdown", 20, 20); pointer("pointermove", 60, 50);
  c.handleKeyboardShortcut({ key: "Escape", preventDefault() {} });
  pointer("pointerup", 60, 50); pointer("click", 60, 50);
  assert.equal(c.pointerOperation, null);
  assert.equal(c.annotationEditor.tool, "select");
  assert.equal(history.pages[0], original);
  c.arrangeSelectedAnnotations("left");
  assert.equal(history.pages[0].annotations[2], original.annotations[2]);
  assert.equal(annotationBounds(history.pages[0].annotations[0]).left, annotationBounds(history.pages[0].annotations[1]).left);
  assert.equal(c.commits, 1); history.step("undo"); assert.equal(history.pages[0], original);
});
test("Ctrl+Aはプレビューではツールが見えているときだけ注釈を選び、ページ一覧ではページを選ぶ", () => {
  const { context: c, history } = fixture();
  history.commit([...history.pages, { id: "q", sourcePdfId: 1, annotations: [] }]);
  const event = () => ({ key: "a", ctrlKey: true, target: new Control(), preventDefault() { this.defaultPrevented = true; } });
  c.ui["preview-edit-bars"].hidden = true;
  const closed = event();
  c.handleKeyboardShortcut(closed);
  assert.equal(closed.defaultPrevented, true);
  assert.equal(c.pageView.selectedPageIds.size, 1);
  assert.equal(c.selectedAnnotations().length, 0);
  assert.equal(c.annotationEditor.tool, null);
  c.shortcutScope = "pages"; c.handleKeyboardShortcut(event()); assert.equal(c.pageView.selectedPageIds.size, 2);
  c.ui["preview-edit-bars"].hidden = false;
  c.setPreviewTool("pen");
  c.handleKeyboardShortcut(event()); assert.equal(c.selectedAnnotations().length, 3);
  assert.equal(c.annotationEditor.tool, "pen"); assert.equal(history.pages.length, 2);
});

test("書き込みツールを閉じると注釈のコピー・貼り付け・削除を止め、開くと現在のツールのまま使える", () => {
  const { context: c, history } = fixture();
  const annotation = history.pages[0].annotations[0];
  history.commit([{ ...history.pages[0], annotations: [annotation] }]);
  c.preview.bitmap.viewport = { ...viewport, transform: [1, 0, 0, -1, 0, 400] };
  c.preview.bitmap.rasterZoom = c.preview.requestedZoom = 1;
  c.annotationEditor.nextId = 2;
  Object.assign(c, { createAnnotationCopies, structuredClone, saveViewPreferences() {}, thumbnailSize: "medium",
    captureZoomAnchor() {}, layoutPreviewPage() {}, updateFitButton() {},
  });
  for (const name of ["canPasteAnnotations", "copySelectedAnnotations", "pasteAnnotations", "setPreviewToolsVisible", "togglePreviewTools"]) {
    installEditorHandler(c, name);
  }
  function press(key, extra = {}) {
    const event = { key, preventDefault() { this.defaultPrevented = true; }, ...extra };
    c.handleKeyboardShortcut(event);
    return Boolean(event.defaultPrevented);
  }
  c.setPreviewTool("select");
  c.selectAnnotation(annotation);
  assert(press("c", { ctrlKey: true }));
  c.togglePreviewTools();
  assert.equal(c.ui["preview-edit-bars"].hidden, true);
  const before = history.pages;
  assert.equal(press("v", { ctrlKey: true }), false);
  assert.equal(press("c", { metaKey: true }), false);
  assert.equal(press("a", { ctrlKey: true }), true);
  assert.equal(press("Delete"), false);
  assert.equal(c.canPasteAnnotations(), false);
  assert.equal(history.pages, before);
  assert.equal(c.annotationEditor.tool, null);
  assert.equal(c.selectedAnnotations().length, 0);
  c.togglePreviewTools();
  assert(press("v", { metaKey: true }));
  assert.equal(c.annotationEditor.tool, null);
  assert.equal(history.pages[0].annotations.length, 2);
  assert.deepEqual(plain(c.selectedAnnotations().map(a => a.id)), [2]);
  assert(press("Delete"));
  assert.deepEqual(plain(history.pages[0].annotations.map(a => a.id)), [1]);
  c.setPreviewTool("pen");
  assert(press("a", { ctrlKey: true }));
  assert(press("Escape"));
  assert.equal(c.annotationEditor.tool, "pen");
  assert.equal(c.selectedAnnotations().length, 0);
});
test("クリアのキャンセルは編集を保ち、実行時はPDF・履歴・クリップボードを初期化する", () => {
  const { context: c, history, released } = fixture(); const original = history.pages[0];
  c.window.confirm = () => false; c.clearDocument(); assert.equal(history.pages[0], original);
  installEditorHandler(c, "setPreviewToolsVisible");
  c.setPreviewToolsVisible(true);
  c.ui["thumbnail-size"].value = "large";
  c.preview.requestedZoom = 2.5;
  const fitSize = c.preview.fitSize = { width: 500, height: 600 };
  c.window.confirm = () => true; c.clearDocument();
  assert.equal(history.pages.length, 0); assert.equal(history.canUndo, false); assert.equal(history.canRedo, false);
  assert.equal(c.workspace.sourcePdfs.size, 0); assert.deepEqual(released.sort(), ["external", "source"]);
  assert.equal(c.annotationClipboard.annotations.length, 0);
  assert.equal(c.preview.requestedZoom, 2.5); assert.equal(c.preview.bitmap, null);
  assert.equal(c.preview.fitSize, fitSize); assert.equal(c.ui["thumbnail-size"].value, "large");
  assert.equal(c.annotationEditor.tool, null); assert.equal(c.shortcutScope, "pages");
  assert.equal(c.ui["preview-edit-bars"].hidden, false);
  assert.equal(c.ui["preview-panel"].dataset.toolsHidden, "false");
  assert.equal(c.ui["preview-tools-toggle"].getAttribute("aria-expanded"), "true");
  assert.equal(c.ui["export-format"].value, "pdf"); assert.equal(c.ui["output-name"].value, "");
});

test("書き込みツールを開いた状態では空のプレビューにも設定行が残る", () => {
  const { context: c, history } = fixture();
  const html = fs.readFileSync(new URL("../../src/index.html", import.meta.url), "utf8");
  const settingsTag = html.match(/<div[^>]+id="mark-settings"[^>]*>/)[0];
  assert.doesNotMatch(settingsTag, /\shidden\b/);
  for (const name of ["activePreviewPageIndex", "setPreviewToolsVisible", "updatePreviewMeta", "updatePreviewPageInfo"]) {
    installEditorHandler(c, name);
  }
  c.setPreviewToolsVisible(true);
  c.updatePreviewPageInfo();
  assert.equal(c.ui["mark-settings"].hidden, false);
  history.clear();
  c.pageView.previewPageId = null;
  c.updatePreviewPageInfo();
  assert.equal(c.ui["preview-footer"].hidden, true);
  assert.equal(c.ui["preview-edit-bars"].hidden, false);
  assert.equal(c.ui["mark-settings"].hidden, false);
});


test("ロックを含む複数選択は全体の移動・整列・Deleteを止め、一括解除を一回のUndoで戻す", () => {
  const { context: c, history, pointer, ui } = fixture();
  c.activePreviewPage().annotations[0].locked = true;
  c.setPreviewTool("select"); c.setAnnotationSelection([1, 2]);
  const original = plain(history.pages);
  c.arrangeSelectedAnnotations("left");
  assert.deepEqual(plain(history.pages), original);
  c.removeSelectedAnnotations();
  assert.deepEqual(plain(history.pages), original);
  c.hit = { annotation: c.activePreviewPage().annotations[0], handle: null };
  pointer("pointerdown", 15, 15); pointer("pointermove", 80, 60); pointer("pointerup", 80, 60); pointer("click", 80, 60);
  assert.deepEqual(plain(history.pages), original);
  assert.deepEqual(plain(c.selectedAnnotations().map(a => a.id)), [1, 2]);
  ui["mark-locked"].checked = false;
  c.changeAnnotationLock();
  assert.equal(c.activePreviewPage().annotations[0].locked, false);
  assert.equal(c.commits, 1);
  history.step("undo");
  assert.equal(c.activePreviewPage().annotations[0].locked, true);
  history.step("redo");
  assert.equal(c.activePreviewPage().annotations[0].locked, false);
  c.removeSelectedAnnotations();
  assert.deepEqual(c.activePreviewPage().annotations.map(a => a.id), [3]);
});

test("選択は一つのID集合で管理し、単独・複数・削除後・ページ切替を判定する", () => {
  const { context: c, history } = fixture();
  c.workspace.sourcePdfs.get(1).file = { name: "source.pdf" };
  installEditorHandler(c, "activePreviewPageIndex");
  installEditorHandler(c, "updatePreviewMeta");
  installEditorHandler(c, "updatePreviewPageInfo");
  c.setAnnotationSelection([1]);
  assert.equal(c.selectedAnnotation().id, 1);
  assert.equal(c.hasAnnotationGroupSelection(), false);
  c.setAnnotationSelection([1, 2, 3]);
  assert.equal(c.selectedAnnotation(), undefined);
  assert.equal(c.hasAnnotationGroupSelection(), true);
  const page = history.pages[0];
  const styles = [];
  c.displayToolStyle = (kind, annotation) => styles.push({ kind, annotation });
  history.commit([{ ...page, annotations: page.annotations.slice(0, 1) }]);
  c.updatePreviewPageInfo();
  assert.equal(c.selectedAnnotation().id, 1);
  assert.equal(c.hasAnnotationGroupSelection(), false);
  assert.deepEqual([...c.annotationEditor.selectedIds], [1]);
  assert.equal(styles.length, 1);
  assert.equal(styles[0].kind, "rect");
  assert.equal(styles[0].annotation, c.selectedAnnotation());
  history.commit([...history.pages, { id: "q", sourcePdfId: 1, sourceIndex: 0, annotations: [] }]);
  c.pageView.previewPageId = "q";
  c.updatePreviewPageInfo();
  assert.equal(c.annotationEditor.selectedIds.size, 0);
  assert.equal(c.selectedAnnotation(), undefined);
  assert.deepEqual(plain(c.selectedAnnotations()), []);
  assert.equal(styles.length, 2);
  assert.equal(styles[1].kind, c.annotationEditor.tool);
  assert.equal(styles[1].annotation, undefined);
});

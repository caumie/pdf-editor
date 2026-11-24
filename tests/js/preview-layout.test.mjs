import { createThumbnailCache } from "../../src/js/thumbnail-cache.mjs";
import { installEditorHandler } from "./editor-fixture.mjs";
import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { previewPageIndexes, adjacentPreviewIndex, fitPreviewPages } from "../../src/js/preview-layout.mjs";
import { renderPdfPreviewPages } from "../../src/js/pdf-preview.mjs";
import { clampPreviewZoom, thumbnailSizes } from "../../src/js/view-sizes.mjs";

import { mountPreviewPages } from "../../src/js/preview-view.mjs";

const left = { mode: "spread", cover: true, direction: "left" };
test("先頭単独・先頭からの見開き・左右と上下の開き方で、すべてのページを重複なく組にする", () => {
  assert.deepEqual(previewPageIndexes(6, 0, left), [0]);
  assert.deepEqual(previewPageIndexes(6, 1, left), [1, 2]);
  assert.deepEqual(previewPageIndexes(6, 2, left), [1, 2]);
  assert.deepEqual(previewPageIndexes(6, 5, left), [5, null]);
  assert.deepEqual(previewPageIndexes(6, 1, { ...left, direction: "right" }), [2, 1]);
  assert.deepEqual(previewPageIndexes(6, 5, { ...left, direction: "right" }), [null, 5]);
  assert.deepEqual(previewPageIndexes(6, 2, { ...left, direction: "vertical" }), [1, 2]);
  assert.deepEqual(previewPageIndexes(6, 5, { ...left, direction: "vertical" }), [5, null]);
  assert.deepEqual(previewPageIndexes(6, 0, { ...left, cover: false }), [0, 1]);
  assert.deepEqual(previewPageIndexes(6, 3, { ...left, mode: "single" }), [3]);
  for (const cover of [false, true]) for (const direction of ["left", "right", "vertical"]) for (const count of [1, 2, 3, 6, 7]) {
    const seen = [];
    for (let index = 0; index < count; index = adjacentPreviewIndex(count, index, { ...left, cover, direction }, 1)) {
      seen.push(...previewPageIndexes(count, index, { ...left, cover, direction }).filter(i => i !== null));
    }
    assert.deepEqual(seen.sort((a, b) => a - b), Array.from({ length: count }, (_, i) => i));
  }
});
test("上下開きはページを上から順に配置し、中央揃えと共通倍率を保つ", () => {
  const a = { width: 300, height: 400 }, b = { width: 600, height: 200 };
  for (const [width, height] of [[1000, 600], [350, 800]]) {
    const fitted = fitPreviewPages([a, b], width, height, 1, "vertical");
    const [top, bottom] = fitted.boxes;
    assert(fitted.width <= width + 1e-8 && fitted.height <= height + 1e-8);
    assert.equal(top.y, 0);
    assert.equal(bottom.y, top.height + 16 / 3);
    assert.equal(bottom.x, 0);
    assert.equal(top.x, top.width / 2);
    assert.equal(bottom.height, top.height / 2);
    const zoomed = fitPreviewPages([a, b], width, height, 2, "vertical");
    assert.equal(zoomed.boxes[1].y, bottom.y * 2);
    assert.equal(zoomed.width, fitted.width * 2);
    assert.equal(zoomed.height, fitted.height * 2);
  }
  const last = fitPreviewPages([a, null], 1000, 600, 1, "vertical");
  const pair = fitPreviewPages([a, a], 1000, 600, 1, "vertical");
  assert.deepEqual(last, pair);
  assert.deepEqual(fitPreviewPages([a], 1000, 600, 1, "vertical"), fitPreviewPages([a], 1000, 600));
});
test("前後の表示は組単位で進み、先頭単独との境界も往復できる", () => {
  assert.equal(adjacentPreviewIndex(7, 0, left, 1), 1);
  assert.equal(adjacentPreviewIndex(7, 1, left, -1), 0);
  assert.equal(adjacentPreviewIndex(7, 2, left, 1), 3);
  assert.equal(adjacentPreviewIndex(7, 3, left, -1), 1);
  assert.equal(adjacentPreviewIndex(6, 5, { ...left, direction: "right" }, -1), 3);
  assert.equal(adjacentPreviewIndex(6, 2, { ...left, cover: false }, -1), 0);
  assert.equal(adjacentPreviewIndex(7, 5, left, 1), 7);
  assert.equal(adjacentPreviewIndex(7, 0, left, -1), -1);
});
test("100%は見開き全体をフィットし、異なるページ寸法の比率と末尾の空き幅を維持する", () => {
  const a = { width: 300, height: 400 }, b = { width: 600, height: 400 };
  const fitted = fitPreviewPages([a, b], 1000, 600);
  assert(fitted.width <= 1000 + 1e-8 && fitted.height <= 600);
  assert.equal(fitted.boxes[1].x, fitted.boxes[0].width + 16 / 3);
  assert.equal(fitted.boxes[1].width / fitted.boxes[0].width, 2);
  const zoomed = fitPreviewPages([a, b], 1000, 600, 2);
  assert.equal(zoomed.width, fitted.width * 2);
  assert.equal(zoomed.boxes[1].x, fitted.boxes[1].x * 2);
  const last = fitPreviewPages([a, null], 1000, 600);
  const pair = fitPreviewPages([a, a], 1000, 600);
  assert.equal(last.scale, pair.scale); assert.equal(last.width, pair.width);
});

class Element extends EventTarget {
  style = { setProperty(name, value) { this[name] = value; } }; dataset = {}; children = []; attrs = new Map();
  clientWidth = 1000; clientHeight = 700; width = 0; height = 0;
  setAttribute(name, value) { this.attrs.set(name, value); }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  getContext() { return { drawImage() {} }; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
}
const document = { createElement: () => new Element() };
globalThis.document = document; globalThis.window = { devicePixelRatio: 2 };
function sourcePage(id, width, height, renders, cancels) {
  return { id, rotate: 0, getViewport({ scale, rotation }) {
    return { width: width * scale, height: height * scale, scale, rotation, userUnit: 1, rawDims: { pageWidth: width, pageHeight: height }, viewBox: [0, 0, width, height], transform: [scale, 0, 0, -scale, 0, height * scale],
      convertToViewportPoint: (x, y) => [x * scale, (height - y) * scale], convertToPdfPoint: (x, y) => [x / scale, height - y / scale] };
  }, render({ canvas }) { renders.push(id); canvas.bodyId = id; return { promise: Promise.resolve(), cancel() { cancels.push(id); } }; } };
}
test("2ページの描画は同じ倍率を使い、キャンセルは両方の描画タスクへ伝わる", async () => {
  const renders = [], cancels = [];
  const output = renderPdfPreviewPages([sourcePage("a", 300, 400, renders, cancels), sourcePage("b", 600, 400, renders, cancels)], [0, 0], 1000, 600);
  await output.task.promise;
  assert.equal(output.entries[0].viewport.scale, output.entries[1].viewport.scale);
  assert.equal(output.entries[1].viewport.width, output.entries[0].viewport.width * 2);
  output.task.cancel(); assert.deepEqual(cancels, ["a", "b"]);
});

for (const direction of ["left", "right", "vertical"]) test("見開きのページと影をそれぞれ配置し、クリックで編集対象を切り替える（" + direction + "）", async () => {
  const controls = new Map();
  const ui = new Proxy({}, { get(_, key) { if (!controls.has(key)) controls.set(key, new Element()); return controls.get(key); } });
  const renders = [], cancels = [], marks = [];
  const sources = [sourcePage("a", 300, 400, renders, cancels), sourcePage("b", 600, 400, renders, cancels)];
  const pages = [{ id: "a", sourcePdfId: 1, addedRotation: 0, annotations: [{ id: 1, kind: "rect" }] },
    { id: "b", sourcePdfId: 1, addedRotation: 0, annotations: [{ id: 2, kind: "rect" }] }];
  const context = vm.createContext({
    ui, document, console, previewStage: new Element(), annotationOverlay: new Element(), previewTextLayer: new Element(),
    preview: { renderVersion: 0, requestedZoom: 1, zoomFrame: null, bitmap: null, centerOnRender: true },
    previewDisplay: { ...left, cover: false, direction }, previewAnnotationVersions: new WeakMap(), nextPreviewAnnotationVersion: 1,
    documentHistory: { pages }, pageView: { previewPageId: "a" }, annotationEditor: {}, workspace: { busy: false, sourcePdfs: new Map([[1, {}]]) },
    previewTouches: { reset() {} }, previewPageIndexes, renderPdfPreviewPages, suppressPreviewClick: false,
    mountPreviewPages: (...args) => mountPreviewPages(...args, (canvas, viewport, annotations) => marks.push(annotations.map(a => a.id))),
    loadSourcePage: model => Promise.resolve(sources.find(source => source.id === model.id)),
    drawAnnotationsOnCanvas: (canvas, viewport, annotations) => marks.push(annotations.map(a => a.id)),
    stopPreviewZoom() {}, drawPreviewAnnotations() {}, refreshHighlightTextLayer() {}, resetPointerOperation() {}, showPreviewMessage() {},
    capturePagePosition: () => ({ x: 0, y: 0 }), captureZoomAnchor: () => null, updateFitButton() {}, updateAnnotationControls() {}, workspaceAvailable: () => true, renderVisibleThumbnails() {},
    goToPreview: index => { context.pageView.previewPageId = pages[index].id; },
  });
  for (const fn of ["replacePreviewRender", "activePreviewPageIndex", "activePreviewPage", "layoutPreviewPage", "previewFitBounds", "updatePreviewMeta", "renderPreview"]) installEditorHandler(context, fn);
  function assertShadows(activeSlot) {
    const shadows = ui["preview-shadows"].children;
    const companion = ui["preview-companions"].children[0];
    const geometry = element => ["left", "top", "width", "height"].map(key => element.style[key]);
    assert.equal(shadows.length, 2);
    assert(shadows.every(shadow => shadow.className === "preview-page-shadow"));
    assert.deepEqual(geometry(shadows[activeSlot]), geometry(ui["preview-active-page"]));
    assert.deepEqual(geometry(shadows[1 - activeSlot]), geometry(companion));
  }
  await context.renderPreview();
  assert.equal(context.preview.bitmap.pageId, "a");
  assert.equal(ui["preview-meta"].textContent, "1ページ目 / 10.58 × 14.11 cm / 書き込み 1件");
  assert.equal(context.previewStage.scrollLeft, 500);
  assert.equal(context.previewStage.scrollTop, 350);
  assert.deepEqual(context.preview.bitmap.viewport.viewBox, [0, 0, 300, 400]);
  assert.deepEqual(marks[0], [2]);
  assert.equal(ui["preview-base"].children[0].bodyId, "a");
  assert.equal(ui["preview-companions"].children.length, 1);
  assertShadows(direction === "right" ? 1 : 0);
  if (direction === "vertical") {
    assert.equal(ui["preview-active-page"].style.top, "0%");
    assert(parseFloat(ui["preview-companions"].children[0].style.top) > parseFloat(ui["preview-active-page"].style.height));
    assert.equal(ui["preview-companions"].children[0].style.left, "0%");
  }
  assert.equal(context.annotationOverlay.width, ui["preview-base"].children[0].width);
  // アクティブページの通常の編集だけでは、PDF本文を描画し直さない。
  pages[0] = { ...pages[0], annotations: [{ id: 9, kind: "rect" }] };
  await context.renderPreview(); assert.equal(renders.length, 2);
  const click = new Event("click"); Object.assign(click, { detail: 1 });
  ui["preview-companions"].children[0].dispatchEvent(click);
  await context.renderPreview();
  assert.equal(context.preview.bitmap.pageId, "b");
  assert.equal(ui["preview-meta"].textContent, "2ページ目 / 21.17 × 14.11 cm / 書き込み 1件");
  assert.deepEqual(context.preview.bitmap.viewport.viewBox, [0, 0, 600, 400]);
  assert.deepEqual(marks.at(-1), [9]);
  assert.equal(ui["preview-base"].children[0].bodyId, "b");
  assertShadows(direction === "right" ? 0 : 1);
  if (direction === "vertical") {
    assert(context.preview.bitmap.spread.y > 0);
    assert.equal(ui["preview-companions"].children[0].style.top, "0%");
  }
  assert.equal(context.preview.centerOnRender, false);
});
test("ズームの基準点は見開き内のページ位置を含めて保持する", () => {
  const controls = new Map();
  const ui = new Proxy({}, { get(_, key) { if (!controls.has(key)) controls.set(key, new Element()); return controls.get(key); } });
  const stage = new Element();
  const c = vm.createContext({ ui, previewStage: stage, previewTextLayer: new Element(), preview: { bitmap: {
    viewport: { width: 450, height: 600, convertToViewportPoint: (x, y) => [x, 600 - y] },
    rasterZoom: 1, pageId: "right", spread: { width: 916, height: 600, x: 466, y: 0 },
  } } });
  installEditorHandler(c, "layoutPreviewPage");
  c.layoutPreviewPage(2, { pageId: "right", point: [10, 20], x: 300, y: 300 });
  assert.equal(stage.scrollLeft, 1165); assert.equal(stage.scrollTop, 1223);
});

test("小サイズの表示でも大サイズでサムネイルを描いてPNGに変換する", async () => {
  const { renderPdfThumbnail } = await import("../../src/js/pdf-preview.mjs");
  const renders = [], cancels = [], marks = [];
  const page = { id: "a", sourcePdfId: 1, sourceIndex: 0, addedRotation: 0, annotations: [] };
  const card = { page, frame: new Element(), pending: false, renderedPage: null };
  const context = vm.createContext({
    console, URL, document, thumbnailSize: "small", thumbnailSizes, activeThumbnailRenders: 0,
    thumbnailCards: new Map([["a", card]]), visibleThumbnails: new Set([card]),
    workspace: { sourcePdfs: new Map([[1, {}]]) },
    renderPdfThumbnail(...args) {
      const rendered = renderPdfThumbnail(...args);
      rendered.canvas.toBlob = (callback, type) => {
        assert.equal(type, "image/png");
        assert(Math.abs(rendered.viewport.height - 218) < 0.01);
        assert.equal(rendered.canvas.height, Math.ceil(rendered.viewport.height * 2));
        callback(new Blob(["png"], { type }));
      };
      return rendered;
    },
    loadSourcePage: async () => sourcePage("a", 300, 400, renders, cancels),
    drawAnnotationsOnCanvas: (canvas, viewport, annotations) => marks.push(annotations), renderVisibleThumbnails() {},
  });
  for (const name of ["thumbnailStillCurrent", "mountThumbnail", "drawThumbnail"]) installEditorHandler(context, name);
  await context.drawThumbnail(card);
  try {
    assert.deepEqual(renders, ["a"]); assert.equal(marks.length, 1);
    assert.equal(card.frame.children[0].src, card.thumbnail.url); assert.equal(card.renderedPage, page);
    assert.equal(card.thumbnail.bytes, 3);
    assert.equal(card.pending, false); assert.equal(context.activeThumbnailRenders, 0);
  } finally {
    if (card.thumbnail) URL.revokeObjectURL(card.thumbnail.url);
  }
});

test("スクロールで描画済みサムネイルを再利用し、古い画像や上限を超えた画像は破棄する", () => {
  const cards = new Map(["a", "b", "c"].map(id => {
    const element = new Element();
    element.dataset.id = id;
    element.remove = () => {};
    const frame = new Element();
    Object.defineProperty(frame, "firstElementChild", { get: () => frame.children[0] });
    return [id, { element, frame, number: {}, sourceLabel: {}, check: new Element(),
      page: { id, sourcePdfId: 1, annotations: [] }, renderedPage: null }];
  }));
  const controls = new Map();
  const ui = new Proxy({}, { get(_, key) { if (!controls.has(key)) controls.set(key, new Element()); return controls.get(key); } });
  ui["page-grid"].insertBefore = () => {};
  const renders = [], revoked = [];
  const c = vm.createContext({
    ui, document, URL: { revokeObjectURL: url => revoked.push(url) },
    thumbnailCards: cards, visibleThumbnails: new Set(),
    thumbnailCache: createThumbnailCache(800, url => revoked.push(url)), thumbnailSize: "medium", thumbnailSizes, activeThumbnailRenders: 0,
    preview: { rendering: false }, thumbnailObserver: { unobserve() {} },
    documentHistory: { pages: [...cards.values()].map(card => card.page) },
    workspace: { sourcePdfs: new Map([[1, { file: { name: "test.pdf" } }]]) },
    drawThumbnail(card) {
      renders.push(card.page.id);
      c.mountThumbnail(card, { url: card.page.id + "-" + renders.length, bytes: card.page.id === "b" ? 550 : 250 });
    },
  });
  for (const name of ["mountThumbnail", "clearThumbnail", "onThumbnailsVisible",
    "renderVisibleThumbnails", "updateThumbnailSize", "renderPageGrid"]) installEditorHandler(c, name);
  const show = (card, isIntersecting = true) => c.onThumbnailsVisible([{ target: card.element, isIntersecting }]);
  const [a, b, third] = cards.values();
  show(a);
  const original = a.thumbnail;
  show(a, false); show(a);
  assert.equal(a.thumbnail, original);
  c.updateThumbnailSize("large");
  assert.equal(a.thumbnail, original);
  assert.deepEqual(renders, ["a"]);
  show(a, false); show(b);
  const outdated = b.thumbnail;
  show(b, false); show(third); show(third, false);
  assert.deepEqual(revoked, [original.url]);
  c.documentHistory.pages[1] = { ...b.page, addedRotation: 90, annotations: [{ id: "new" }] };
  c.renderPageGrid();
  assert.deepEqual(revoked, [original.url, outdated.url]);
  show(b); show(third);
  assert.deepEqual(renders, ["a", "b", "c", "b"]);
  const removed = third.thumbnail;
  show(third, false);
  c.documentHistory.pages.pop();
  c.renderPageGrid();
  assert.deepEqual(revoked, [original.url, outdated.url, removed.url]);
  const cached = b.thumbnail;
  show(b, false);
  c.updateThumbnailSize("small");
  show(b);
  assert.equal(b.thumbnail, cached);
  assert.deepEqual(renders, ["a", "b", "c", "b"]);
});

test("領域を変更しページを追加してもプレビューの倍率とフィット基準を保つ", async () => {
  const controls = new Map();
  const ui = new Proxy({}, { get(_, key) { if (!controls.has(key)) controls.set(key, new Element()); return controls.get(key); } });
  const bars = ui["preview-edit-bars"]; bars.hidden = false;
  const stage = new Element();
  Object.defineProperty(stage, "clientHeight", { get: () => bars.hidden ? 799 : 700 });
  const renders = [], cancels = [];
  const saved = [];
  const page = { id: "a", sourcePdfId: 1, addedRotation: 0, annotations: [] };
  const source = sourcePage("a", 300, 900, renders, cancels);
  const navigateButton = new Element(); navigateButton.dataset.tool = "navigate";
  const penButton = new Element(); penButton.dataset.tool = "pen";
  const c = vm.createContext({
    ui, document, console, clearTimeout, previewStage: stage, annotationOverlay: new Element(), previewTextLayer: new Element(),
    thumbnailSize: "large", clampPreviewZoom, saveViewPreferences: (...values) => saved.push(values),
    preview: { renderVersion: 0, requestedZoom: 2, zoomFrame: null, bitmap: null, fitSize: null },
    previewDisplay: { mode: "single" }, previewAnnotationVersions: new WeakMap(), nextPreviewAnnotationVersion: 1,
    documentHistory: { pages: [page] }, pageView: { previewPageId: "a" },
    annotationEditor: { tool: "pen", selectedIds: new Set(["note"]), multiSelect: true, hoveredId: "note" },
    previewModeButtons: [navigateButton, penButton], displayToolStyle() {}, shortcutScope: "annotations", suppressPreviewClick: false,
    workspace: { busy: false, sourcePdfs: new Map([[1, {}]]) }, pointerOperation: null,
    previewTouches: { reset() {} }, previewPageIndexes, renderPdfPreviewPages, mountPreviewPages,
    loadSourcePage: async () => source, stopPreviewZoom() {}, drawPreviewAnnotations() {}, refreshHighlightTextLayer() {}, resetPointerOperation() {}, showPreviewMessage() {},
    capturePagePosition: () => ({ x: 0, y: 0 }), captureZoomAnchor: () => ({ pageId: "a", point: [150, 450], x: 300, y: 300 }),
    updateFitButton() {}, updateAnnotationControls() {}, workspaceAvailable: () => true, renderVisibleThumbnails() {},
    updateZoomControls() {}, refinePreviewAfterZoom() {},
  });
  for (const name of ["replacePreviewRender", "activePreviewPageIndex", "activePreviewPage", "layoutPreviewPage", "previewFitBounds", "updatePreviewMeta", "renderPreview", "setPreviewTool", "setPreviewToolsVisible", "togglePreviewTools", "setZoom", "resizePreviewStage", "fitPreviewToStage"]) installEditorHandler(c, name);
  await c.renderPreview();
  const dimensions = ui["preview-meta"].textContent.split(" / ")[1];
  const width = ui["preview-surface"].style.width, height = ui["preview-surface"].style.height;
  const scale = c.preview.bitmap.viewport.scale;
  c.togglePreviewTools();
  assert.equal(bars.hidden, true); assert.equal(c.preview.requestedZoom, 2); assert.equal(c.annotationEditor.tool, null);
  assert.equal(stage.dataset.navigation, "true");
  assert.equal(navigateButton.attrs.get("aria-pressed"), "true"); assert.equal(penButton.attrs.get("aria-pressed"), "false");
  assert.equal(c.annotationEditor.selectedIds.size, 0);
  assert.equal(c.annotationEditor.multiSelect, false); assert.equal(c.annotationEditor.hoveredId, null);
  assert.equal(c.preview.fitSize.height, 700 - 26);
  assert.equal(ui["preview-surface"].style.width, width); assert.equal(ui["preview-surface"].style.height, height);
  assert.equal(ui["preview-tools-toggle"].attrs.get("aria-expanded"), "false");
  await c.renderPreview(); assert.equal(renders.length, 1);
  // 拡大の描き直しも、バーを隠したことだけではフィット基準を変えない。
  c.setZoom(3); await c.renderPreview();
  assert(Math.abs(c.preview.bitmap.viewport.scale / scale - 1.5) < 1e-12);
  c.setZoom(2); await c.renderPreview();
  c.togglePreviewTools(); await c.renderPreview();
  assert.equal(bars.hidden, false); assert.equal(c.preview.fitSize.height, 700 - 26);
  assert.equal(ui["preview-surface"].style.width, width); assert.equal(ui["preview-surface"].style.height, height);
  assert.equal(ui["preview-tools-toggle"].attrs.get("aria-expanded"), "true");
  assert.equal(c.annotationEditor.tool, null);
  c.togglePreviewTools();
  stage.clientWidth = 200;
  c.resizePreviewStage();
  await c.renderPreview();
  assert.equal(c.preview.bitmap.viewport.scale, scale);
  assert.equal(ui["preview-surface"].style.width, width);
  c.documentHistory.pages = [page, { ...page, id: "new-file" }];
  c.pageView.previewPageId = "new-file";
  await c.renderPreview();
  assert.equal(c.preview.bitmap.pageId, "new-file");
  assert.equal(c.preview.requestedZoom, 2);
  assert.equal(c.preview.bitmap.viewport.scale, scale);
  assert.equal(ui["preview-surface"].style.width, width);
  c.setZoom(1); await c.renderPreview();
  assert.equal(c.preview.bitmap.viewport.scale, scale / 2);
  await c.fitPreviewToStage();
  assert.equal(c.preview.requestedZoom, 1); assert.equal(c.preview.fitSize.width, 200 - 26);
  assert.equal(c.preview.bitmap.viewport.scale, (200 - 26) / 300);
  assert.equal(ui["preview-meta"].textContent, "2ページ目 / " + dimensions);
  c.workspace.busy = true; c.togglePreviewTools(); assert.equal(bars.hidden, true);
  assert.deepEqual(saved, [["large", false], ["large", true], ["large", false]]);
});

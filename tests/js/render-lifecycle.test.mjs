import { installEditorHandler } from "./editor-fixture.mjs";
import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { previewPageIndexes } from "../../src/js/preview-layout.mjs";
import { renderPdfPreviewPages, openSourcePdf } from "../../src/js/pdf-preview.mjs";
import { openExternalAnnotationRenderer } from "../../src/js/external-annotations.mjs";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture() {
  const nodes = new Map(), mounted = [], prepared = [];
  const ui = new Proxy({}, { get(_, id) { if (!nodes.has(id)) nodes.set(id, { style: {} }); return nodes.get(id); } });
  const c = vm.createContext({
    ui, console: { warn() {} }, previewStage: { clientWidth: 1000, clientHeight: 700 }, annotationOverlay: { style: {} },
    preview: { renderVersion: 0, requestedZoom: 1, zoomFrame: null, bitmap: null },
    previewDisplay: { mode: "single" }, previewAnnotationVersions: new WeakMap(), nextPreviewAnnotationVersion: 1,
    pageView: { previewPageId: "a" }, documentHistory: { pages: ["a", "b"].map(id => ({ id, sourcePdfId: 1, addedRotation: 0, annotations: [] })) },
    annotationEditor: {}, previewTouches: { reset() {} }, previewPageIndexes,
    workspace: { sourcePdfs: new Map([[1, { externalRenderer: { prepare: async annotations => prepared.push(annotations) } }]]) },
    loadSourcePage: async model => model,
    renderPdfPreviewPages: pages => ({ width: 300, height: 400,
      entries: pages.map(() => ({ canvas: {}, viewport: { width: 300, height: 400, scale: 1 } })),
      task: { promise: Promise.resolve(), cancel() {} } }),
    mountPreviewPages: () => mounted.push(c.preview.bitmap.pageId),
    stopPreviewZoom() {}, drawPreviewAnnotations() {}, refreshHighlightTextLayer() {}, resetPointerOperation() {}, showPreviewMessage() {},
    captureZoomAnchor: () => null, layoutPreviewPage() {}, updateFitButton() {}, updateAnnotationControls() {},
    workspaceAvailable: () => true, renderVisibleThumbnails() {},
  });
  for (const name of ["activePreviewPageIndex", "activePreviewPage", "updatePreviewMeta", "replacePreviewRender", "previewFitBounds", "renderPreview"]) {
    installEditorHandler(c, name);
  }
  return { c, mounted, prepared };
}

test("一時的な描画エラー後も、同じページと倍率で再試行できる", async () => {
  const { c, mounted } = fixture(); let attempts = 0; const render = c.renderPdfPreviewPages;
  c.renderPdfPreviewPages = (...args) => { if (++attempts === 1) throw Error("temporary"); return render(...args); };
  await c.renderPreview(); assert.equal(c.preview.renderKey, null); assert.equal(c.preview.rendering, false);
  await c.renderPreview(); assert.equal(attempts, 2); assert.deepEqual(mounted, ["a"]);
});
test("ページ取得中に切り替えた古い要求は、注釈の追加描画や表示の上書きをしない", async () => {
  const { c, mounted, prepared } = fixture(), old = deferred();
  c.loadSourcePage = model => model.id === "a" ? old.promise : Promise.resolve(model);
  const pending = c.renderPreview(); c.pageView.previewPageId = "b";
  await c.renderPreview(); old.resolve({}); await pending;
  assert.deepEqual(mounted, ["b"]); assert.equal(prepared.length, 1); assert.equal(c.preview.bitmap.pageId, "b");
  assert.equal(c.ui["preview-meta"].textContent, "2ページ目 / 10.58 × 14.11 cm");
});
test("描画待ちにクリアした場合、遅れて完了してもページを復活させない", async () => {
  const { c, mounted } = fixture(), draw = deferred(); let cancelled = 0;
  const render = c.renderPdfPreviewPages;
  c.renderPdfPreviewPages = (...args) => ({ ...render(...args), task: { promise: draw.promise, cancel() { cancelled++; } } });
  const pending = c.renderPreview();
  // ページ取得と外部注釈準備の後、描画待ちまで進める。
  for (let attempt = 0; attempt < 20 && !c.preview.renderTask; attempt++) await Promise.resolve();
  assert(c.preview.renderTask, "描画タスクが開始されること");
  c.replacePreviewRender(null); c.documentHistory.pages = []; c.preview.bitmap = null;
  draw.resolve(); await pending;
  assert.equal(cancelled, 1); assert.equal(c.preview.bitmap, null); assert.deepEqual(mounted, []);
});
test("PDF本体と外部注釈用PDFは、読み込み失敗時にタスクを破棄して元のエラーを返す", async () => {
  for (const external of [false, true]) {
    const error = Error("invalid PDF"); let destroyed = 0;
    const pdfjs = { getDocument: () => ({ promise: Promise.reject(error), destroy: async () => { destroyed++; } }) };
    await assert.rejects(() => external ? openExternalAnnotationRenderer(pdfjs, new Uint8Array([1]), 1) : openSourcePdf(pdfjs, new Blob(["broken"])), value => value === error);
    assert.equal(destroyed, 1);
  }
});

function fakePage(render) {
  return { rotate: 0, getViewport: ({ scale }) => ({ width: 300 * scale, height: 400 * scale }), render };
}
globalThis.document = { createElement: () => ({ style: {}, setAttribute() {} }) };
globalThis.window = { devicePixelRatio: 1 };
test("見開きの片側が非同期に失敗したときは、もう片側の描画もキャンセルする", async () => {
  const error = Error("render failed"), other = deferred(); let cancelled = 0;
  const pages = [fakePage(() => ({ promise: Promise.reject(error), cancel() {} })),
    fakePage(() => ({ promise: other.promise, cancel() { cancelled++; other.reject(Error("cancelled")); } }))];
  const output = renderPdfPreviewPages(pages, [0, 0], 1000, 700);
  await assert.rejects(output.task.promise, value => value === error); assert.equal(cancelled, 1);
});
test("見開きの後半が描画開始時に失敗しても、先に開始した描画を残さない", () => {
  const other = deferred(); let cancelled = 0;
  const pages = [fakePage(() => ({ promise: other.promise, cancel() { cancelled++; other.reject(Error("cancelled")); } })),
    fakePage(() => { throw Error("cannot start"); })];
  assert.throws(() => renderPdfPreviewPages(pages, [0, 0], 1000, 700), /cannot start/);
  assert.equal(cancelled, 1);
});

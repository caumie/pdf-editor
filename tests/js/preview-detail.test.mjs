import assert from "node:assert/strict";
import test from "node:test";
import { createPreviewDetail } from "../../src/js/preview-detail.mjs";
import { renderPdfPreviewPages } from "../../src/js/pdf-preview.mjs";
import { clampPreviewZoom } from "../../src/js/view-sizes.mjs";

function fixture(t, { defer = false } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.window = { devicePixelRatio: 2 };
  globalThis.document = { createElement: () => ({
    style: {}, setAttribute() {},
    remove() { this.parent?.children.delete(this); },
    getContext() { return context; },
  }) };
  const stage = {
    clientLeft: 2, clientTop: 2, clientWidth: 1000, clientHeight: 700,
    getBoundingClientRect: () => ({ left: 98, top: 48 }),
  };
  let canRefine = true;
  const detail = createPreviewDetail(stage, () => canRefine);
  const base = [], crops = [], annotationTransforms = [];
  const context = {
    save() {}, restore() {}, fill() {}, beginPath() {}, rect() {}, clip() {}, fillRect() {},
    setTransform(...values) { annotationTransforms.push(values); },
  };
  const source = {
    rotate: 0,
    getViewport({ scale, rotation }) {
      return { width: 600 * scale, height: 800 * scale, scale, rotation,
        transform: [0, scale, scale, 0, 0, 0] };
    },
    render(options) {
      const isCrop = options.transform?.slice(4).some(offset => offset !== 0);
      if (!isCrop) {
        base.push(options);
        return { promise: Promise.resolve(), cancel() {} };
      }
      const crop = { ...options };
      crops.push(crop);
      return {
        promise: defer ? new Promise(resolve => { crop.finish = resolve; }) : Promise.resolve(),
        cancel() { crop.cancelled = true; },
      };
    },
  };
  function mount(zoom, annotations) {
    const { entries } = renderPdfPreviewPages([source], [90], 1000, 800, zoom);
    const [entry] = entries;
    const layer = { children: new Set(), append(canvas) {
      canvas.parent = this;
      this.children.add(canvas);
    } };
    const rect = { left: -200 * zoom, top: -150 * zoom, width: entry.width, height: entry.height };
    detail.setPages([{ element: { getBoundingClientRect: () => rect }, layer, entry, annotations }]);
    return { layer, rect };
  }
  return { detail, crops, base, annotationTransforms, mount, setRefinement: enabled => { canRefine = enabled; }, async settle() {
    detail.schedule();
    t.mock.timers.tick(100);
    await Promise.resolve();
  } };
}

test("ズームは10000%を上限として留める", () => {
  assert.equal(clampPreviewZoom(5.6), 5.6);
  assert.equal(clampPreviewZoom(29.9), 29.9);
  assert.equal(clampPreviewZoom(99.9), 99.9);
  assert.equal(clampPreviewZoom(100), 100);
  assert.equal(clampPreviewZoom(101), 100);
  assert.equal(clampPreviewZoom(0.3), 0.4);
});

test("ページ全体で足りる間は再描画せず、高倍率では実際の倍率で表示範囲だけを描く", async t => {
  const f = fixture(t);
  f.mount(1);
  await f.settle();
  assert.equal(f.crops.length, 0);

  for (const zoom of [3, 5, 7, 30, 100]) {
    const { layer } = f.mount(zoom);
    await f.settle();
    const crop = f.crops.at(-1);
    assert.equal(crop.canvas.width, (1000 + 2 * 96) * 2);
    assert.equal(crop.canvas.height, (700 + 2 * 96) * 2);
    assert.deepEqual(crop.transform, [2, 0, 0, 2, -(100 + 200 * zoom - 96) * 2, -(50 + 150 * zoom - 96) * 2]);
    assert.equal(crop.viewport.scale, zoom);
    assert.equal(crop.viewport.rotation, 90);
    assert.deepEqual([...layer.children], [crop.canvas]);
  }
  assert.equal(f.crops.length, 5);
  assert.equal(f.base.length, 6);
});

test("表示範囲が描画済み領域に収まる間は再利用し、パン・縮小・ページ切替時に古い描画を解放する", async t => {
  const f = fixture(t, { defer: true });
  const { rect, layer } = f.mount(7);
  await f.settle();
  const first = f.crops[0];
  first.finish();
  await Promise.resolve();
  rect.left -= 45;
  await f.settle();
  assert.equal(f.crops.length, 1);
  assert(layer.children.has(first.canvas));

  rect.left -= 110;
  await f.settle();
  const previous = f.crops[1];
  rect.left -= 110;
  await f.settle();
  const current = f.crops[2];
  assert(previous.cancelled);
  previous.finish();
  await Promise.resolve();
  assert.equal(previous.canvas.width, 0);
  assert(layer.children.has(first.canvas));
  current.finish();
  await Promise.resolve();
  assert.equal(first.canvas.width, 0);
  assert.deepEqual([...layer.children], [current.canvas]);

  f.mount(1);
  await f.settle();
  assert.equal(current.canvas.width, 0);
  assert.equal(f.crops.length, 3);
});

test("切り出し領域に重ねる書き込みにPDF本体と同じ回転とオフセットを適用する", async t => {
  const f = fixture(t);
  f.mount(7, [{ kind: "highlight", quads: [] }]);
  await f.settle();
  const crop = f.crops[0];
  const [sx, , , sy, tx, ty] = crop.transform;
  assert.deepEqual(f.annotationTransforms, [[0, sy * 7, sx * 7, 0, tx, ty]]);
});

test("ズームが確定するまでは補助描画を始めない", async t => {
  const f = fixture(t);
  f.mount(7);
  f.setRefinement(false);
  await f.settle();
  assert.equal(f.crops.length, 0);
  f.setRefinement(true);
  await f.settle();
  assert.equal(f.crops.length, 1);
});

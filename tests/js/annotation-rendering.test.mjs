import assert from "node:assert/strict";
import test from "node:test";
import { drawAnnotationsOnCanvas, releaseExternalAnnotationRasters, setExternalAnnotationRaster } from "../../src/js/annotations.mjs";

// Canvasの状態スタックを再現し、外部注釈の画像へ渡る描画状態を検査する。
function recordingCanvas() {
  const stack = [], images = [], filledRects = [], strokedRects = [];
  const state = {
    globalAlpha: 1, globalCompositeOperation: "source-over",
    save() { stack.push({ globalAlpha: this.globalAlpha, globalCompositeOperation: this.globalCompositeOperation }); },
    restore() { Object.assign(this, stack.pop()); },
    drawImage() { images.push({ alpha: this.globalAlpha, composite: this.globalCompositeOperation }); },
    fillRect(...bounds) { filledRects.push(bounds); },
    strokeRect(...bounds) { strokedRects.push(bounds); },
  };
  const ctx = new Proxy(state, { get: (target, key) => key in target ? target[key] : () => {} });
  return { width: 100, height: 100, getContext: () => ctx, images, filledRects, strokedRects, state };
}

test("複数選択の枠と、ポインター下の選択候補の四隅を同時に描画する", () => {
  const selected = { id: 1, kind: "external", rect: [10, 10, 20, 20] };
  const candidate = { id: 2, kind: "external", rect: [30, 40, 50, 60], locked: true };
  const viewport = { width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100] };
  const canvas = recordingCanvas();
  drawAnnotationsOnCanvas(canvas, viewport, [selected, candidate], { ids: new Set([1]), candidateId: 2 });
  assert.deepEqual(canvas.strokedRects.slice(0, 2), [[6, 6, 18, 18], [26, 36, 28, 28]]);
  assert.deepEqual(canvas.filledRects, [[23, 33, 6, 6], [23, 61, 6, 6], [51, 33, 6, 6], [51, 61, 6, 6]]);
});

test("外部ハイライトの透明度は、直前の自作ハイライトや別レイヤーの有無に依存しない", () => {
  const native = { kind: "highlight", color: "#ffff00", fillTransparency: 80,
    quads: [[ [0, 20], [20, 20], [0, 0], [20, 0] ]] };
  const external = { kind: "external", subtype: "Highlight", appearanceKey: "render-test:1", rect: [30, 0, 50, 20] };
  const viewport = { width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100] };
  setExternalAnnotationRaster(external.appearanceKey, { canvas: {}, scale: 3 });
  try {
    for (const separate of [false, true]) for (const annotations of [[native, external], [external, native]]) {
      const canvas = recordingCanvas(), layer = separate ? recordingCanvas() : null;
      drawAnnotationsOnCanvas(canvas, viewport, annotations, null, 3, layer);
      assert.deepEqual((layer ?? canvas).images, [{ alpha: 1, composite: "multiply" }]);
      assert.equal(canvas.state.globalAlpha, 1);
      assert.equal(canvas.state.globalCompositeOperation, "source-over");
      if (layer) assert.equal(layer.state.globalAlpha, 1);
    }
  } finally {
    releaseExternalAnnotationRasters("render-test");
  }
});

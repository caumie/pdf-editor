import assert from "node:assert/strict";
import test from "node:test";
import { annotationBounds, textAnnotationPadding } from "../../src/js/annotations.mjs";
import { findAnnotationHandle, annotationDragCursor, transformAnnotationDrag, constrainAnnotationMove, fitAnnotationToPage, hitTestAnnotation } from "../../src/js/annotation-interaction.mjs";

const pageBox = [10, 20, 310, 420];
const rect = { id: 1, kind: "rect", points: [[30, 50], [90, 100]], width: 2, useFillTransparency: true, fillTransparency: 100 };
const external = { id: 2, kind: "external", rect: [100, 120, 140, 160], offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };

test("単独移動と位置補正は切り抜き範囲を守り、元の座標・線幅を変えない", () => {
  const moved = constrainAnnotationMove(rect, -1000, 1000, pageBox);
  assert.deepEqual(annotationBounds(moved), { left: 10, right: 70, bottom: 370, top: 420, width: 60, height: 50 });
  assert.deepEqual(rect.points, [[30, 50], [90, 100]]); assert.equal(moved.width, 2);
  assert.equal(fitAnnotationToPage(rect), rect);
  assert.equal(fitAnnotationToPage(rect, pageBox), rect);
});
test("端点・矩形・外部注釈の変形は独立し、Shiftでは外部注釈の比率を固定する", () => {
  const line = { kind: "line", width: 2, points: [[30, 50], [90, 100]] };
  assert.deepEqual(transformAnnotationDrag({ original: line, handle: { action: "endpoint", index: 1 } }, 10, 20, pageBox).points, [[30, 50], [100, 120]]);
  const handle = { action: "resize", anchorX: 100, anchorY: 120, cornerX: 140, cornerY: 160 };
  const stretched = transformAnnotationDrag({ original: external, handle }, 40, 20, pageBox);
  assert.deepEqual(stretched.rect, [100, 120, 180, 180]);
  assert.equal(stretched.scaleX, 2); assert.equal(stretched.scaleY, 1.5);
  const uniform = transformAnnotationDrag({ original: external, handle }, 40, 20, pageBox, true);
  assert.deepEqual(uniform.rect, [100, 120, 180, 200]); assert.equal(uniform.scaleY, 2);
  assert.deepEqual(external.rect, [100, 120, 140, 160]);
  const minimum = transformAnnotationDrag({ original: external, handle }, -100, -100, pageBox);
  assert.equal(minimum.rect[2] - minimum.rect[0], 1);
});
test("テキストの幅変更はESモジュールでも実行でき、回転・余白・最小幅とページ幅を反映する", () => {
  for (const kind of ["text", "note"]) for (const rotation of [0, 90, 180, 270]) {
    const original = { kind, rotation, size: 12, boxBorder: true, boxBorderWidth: 2 };
    const angle = rotation * Math.PI / 180;
    const drag = { original, handle: { action: "wrap" }, textWidth: 100 };
    const resized = transformAnnotationDrag(drag, 40 * Math.cos(angle), 40 * Math.sin(angle), pageBox);
    assert.equal(resized.wrapWidth, 140);
    const minimum = transformAnnotationDrag(drag, -1000 * Math.cos(angle), -1000 * Math.sin(angle), pageBox);
    assert.equal(minimum.wrapWidth, original.size + 2 * textAnnotationPadding(original));
    const maximum = transformAnnotationDrag(drag, 1000 * Math.cos(angle), 1000 * Math.sin(angle), pageBox);
    assert.equal(maximum.wrapWidth, rotation % 180 ? 400 : 300);
  }
});
test("当たり判定は重なり順・線と塗り・回転文字・ハイライト・外部選択の制限を保つ", () => {
  const measure = () => ({ width: 60, height: 20 });
  const hit = (annotations, point, includeExternal = false) => hitTestAnnotation(annotations, point, 2, includeExternal, measure);
  assert.equal(hit([rect], [60, 75]), null);
  assert.equal(hit([{ ...rect, fillColor: "#ffffff", useFillTransparency: false }], [60, 75])?.id, 1);
  assert.equal(hit([external], [110, 130]), null); assert.equal(hit([external], [110, 130], true), external);
  const text = { kind: "text", x: 30, y: 50, rotation: 90 };
  assert.equal(hit([text], [40, 80]), text); assert.equal(hit([text], [60, 80]), null);
  const highlight = { kind: "highlight", quads: [[[20, 30], [80, 30], [20, 40], [80, 40]]] };
  assert.equal(hit([highlight], [40, 35]), highlight);
  const line = { kind: "line", width: 2, points: [[20, 30], [80, 30]] };
  assert.equal(hit([line, highlight], [40, 30]), highlight);
});
test("ハンドルの検出距離とカーソル方向は表示倍率・回転に合わせる", () => {
  const handle = findAnnotationHandle(rect, [30, 50], 2);
  assert.equal(handle.action, "resize"); assert.equal(findAnnotationHandle(rect, [24, 50], 2), null);
  const viewport = { rotation: 90, convertToViewportPoint: (x, y) => [y, x] };
  assert.equal(annotationDragCursor({ annotation: { kind: "text", rotation: 90 }, handle: { action: "wrap" } }, viewport), "ew-resize");
  assert.equal(annotationDragCursor({ annotation: rect, handle }, viewport), "nwse-resize");
});

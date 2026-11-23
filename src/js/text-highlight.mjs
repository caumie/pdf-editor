import { clientToPdfPoint } from "./page-coordinates.mjs";

// PDF.jsが配置した透明な文字層の選択範囲を、PDF座標の四辺形に変換する。
export function selectedPageText(selection, layer) {
  if (layer.hidden || !selection?.rangeCount || selection.isCollapsed) return false;
  for (let i = 0; i < selection.rangeCount; i++) {
    if (!layer.contains(selection.getRangeAt(i).commonAncestorContainer)) return false;
  }
  return Boolean(selection.toString().trim());
}

export function selectedHighlightQuads(selection, layer, surface, viewport) {
  if (!selectedPageText(selection, layer)) return [];
  const bounds = surface.getBoundingClientRect();
  if (!(bounds.width > 0 && bounds.height > 0)) return [];
  const rectangles = [];
  for (let i = 0; i < selection.rangeCount; i++) {
    for (const rect of selection.getRangeAt(i).getClientRects()) {
      const box = {
        left: Math.max(rect.left, bounds.left), right: Math.min(rect.right, bounds.right),
        top: Math.max(rect.top, bounds.top), bottom: Math.min(rect.bottom, bounds.bottom),
      };
      if (box.right - box.left > .1 && box.bottom - box.top > .1) rectangles.push(box);
    }
  }
  if (rectangles.length > 1500) return [];
  // Elementとそのテキストが同じ範囲を返す場合は重ねない。
  const unique = [];
  for (const rect of rectangles) {
    if (unique.some(other => containsRect(other, rect))) continue;
    for (let i = unique.length - 1; i >= 0; i--) {
      if (containsRect(rect, unique[i])) unique.splice(i, 1);
    }
    unique.push(rect);
  }
  const point = (x, y) => clientToPdfPoint(x, y, bounds, viewport);
  return unique.map(({ left, top, right, bottom }) => [
    point(left, top), point(right, top), point(left, bottom), point(right, bottom),
  ]);
}

function containsRect(outer, inner) {
  const tolerance = .25;
  return inner.left >= outer.left - tolerance && inner.right <= outer.right + tolerance
    && inner.top >= outer.top - tolerance && inner.bottom <= outer.bottom + tolerance;
}

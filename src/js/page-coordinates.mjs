export function normalizeRotation(angle) {
  return ((angle % 360) + 360) % 360;
}

// CSS上の座標を、PDF.jsのビューポートを使って文書の座標へ変換する。
export function clientToPdfPoint(x, y, bounds, viewport, bounded = false) {
  if (!(bounds.width > 0 && bounds.height > 0)) return null;
  let left = (x - bounds.left) / bounds.width;
  let top = (y - bounds.top) / bounds.height;
  if (bounded) {
    left = Math.min(1, Math.max(0, left));
    top = Math.min(1, Math.max(0, top));
  }
  return viewport.convertToPdfPoint(left * viewport.width, top * viewport.height);
}

export function pdfViewportScale(viewport) {
  return Math.hypot(viewport.transform[0], viewport.transform[1]);
}

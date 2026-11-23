import { isTextAnnotation, annotationBounds, annotationHandles, translateAnnotation, resizeExternalAnnotation, annotationFillOpacity, textAnnotationPadding, lineArrowPoints } from "./annotations.mjs";

export function pointInBounds([x, y], bounds, margin = 0) {
  return x >= bounds.left - margin && x <= bounds.right + margin
    && y >= bounds.bottom - margin && y <= bounds.top + margin;
}

export function annotationsInSelectionBox(annotations, start, end) {
  const box = { left: Math.min(start[0], end[0]), right: Math.max(start[0], end[0]),
    bottom: Math.min(start[1], end[1]), top: Math.max(start[1], end[1]) };
  function overlaps(bounds, padding = 0) {
    return bounds.left - padding <= box.right && bounds.right + padding >= box.left
      && bounds.bottom - padding <= box.top && bounds.top + padding >= box.bottom;
  }
  return annotations.filter(annotation => {
    if (annotation.kind === "highlight") return annotation.quads.some(points => overlaps(annotationBounds({ points })));
    const stroke = ["pen", "line", "rect"].includes(annotation.kind) ? annotation.width / 2 : 0;
    if (!overlaps(annotationBounds(annotation), stroke)) return false;
    if (annotation.kind !== "pen" && annotation.kind !== "line") return true;
    const points = annotation.points;
    if (points.some((point, index) => segmentIntersectsBox(point, points[index + 1] ?? point, box, stroke))) return true;
    const arrow = lineArrowPoints(annotation);
    return arrow.length > 0 && overlaps(annotationBounds({ points: arrow }));
  });
}

// 各軸で矩形の内側を通る線分上の区間を求め、区間が共通するかを調べる。
function segmentIntersectsBox(start, end, box, padding) {
  let enter = 0, leave = 1;
  for (const [axis, low, high] of [[0, box.left - padding, box.right + padding], [1, box.bottom - padding, box.top + padding]]) {
    const origin = start[axis];
    const delta = end[axis] - origin;
    if (!delta) {
      if (origin < low || origin > high) return false;
      continue;
    }
    const first = (low - origin) / delta, second = (high - origin) / delta;
    enter = Math.max(enter, Math.min(first, second));
    leave = Math.min(leave, Math.max(first, second));
    if (enter > leave) return false;
  }
  return true;
}

export function findAnnotationHandle(annotation, [x, y], scale) {
  let nearest = null;
  let distance = 11 / scale;
  for (const handle of annotationHandles(annotation, scale)) {
    const gap = Math.hypot(x - handle.x, y - handle.y);
    if (gap < distance) {
      nearest = handle;
      distance = gap;
    }
  }
  return nearest;
}

export function annotationDragCursor({ annotation, handle }, viewport) {
  if (annotation.kind === "highlight") return "pointer";
  if (!handle) return "move";
  if (handle.action === "endpoint") return "crosshair";
  if (handle.action === "wrap") return (annotation.rotation - viewport.rotation) % 180 ? "ns-resize" : "ew-resize";
  const [x, y] = viewport.convertToViewportPoint(handle.cornerX, handle.cornerY);
  const [ax, ay] = viewport.convertToViewportPoint(handle.anchorX, handle.anchorY);
  return (x - ax) * (y - ay) > 0 ? "nwse-resize" : "nesw-resize";
}

export function transformAnnotationDrag({ original, handle, textWidth }, dx, dy, viewBox, keepAspect = false) {
  switch (handle?.action) {
    case "endpoint":
      return { ...original, points: original.points.map(([x, y], index) =>
        index === handle.index ? [x + dx, y + dy] : [x, y]) };
    case "resize": {
      const { anchorX, anchorY, cornerX, cornerY } = handle;
      let scaleX = resizeScale(cornerX - anchorX, dx);
      let scaleY = resizeScale(cornerY - anchorY, dy);
      if (original.kind === "external") {
        if (keepAspect) {
          const scale = Math.abs(scaleX - 1) >= Math.abs(scaleY - 1) ? scaleX : scaleY;
          scaleX = scaleY = Math.max(scale, 1 / Math.min(Math.abs(cornerX - anchorX), Math.abs(cornerY - anchorY)));
        }
        return resizeExternalAnnotation(original, anchorX, anchorY, scaleX, scaleY);
      }
      return { ...original, points: original.points.map(([x, y]) =>
        [anchorX + (x - anchorX) * scaleX, anchorY + (y - anchorY) * scaleY]) };
    }
    case "wrap": {
      const angle = original.rotation * Math.PI / 180;
      const width = textWidth + dx * Math.cos(angle) + dy * Math.sin(angle);
      const [left, bottom, right, top] = viewBox;
      const edge = original.rotation % 180 ? top - bottom : right - left;
      return { ...original, wrapWidth: Math.max(original.size + 2 * textAnnotationPadding(original), Math.min(edge, Math.round(width))) };
    }
    default:
      return constrainAnnotationMove(original, dx, dy, viewBox);
  }
}

function resizeScale(size, offset) {
  return Math.max(1, Math.abs(size) + Math.sign(size) * offset) / Math.abs(size);
}

export function constrainAnnotationMove(annotation, dx, dy, viewBox) {
  const [left, bottom, right, top] = viewBox;
  const bounds = annotationBounds(annotation);
  if (bounds.width <= right - left) dx = Math.max(left - bounds.left, Math.min(right - bounds.right, dx));
  if (bounds.height <= top - bottom) dy = Math.max(bottom - bounds.bottom, Math.min(top - bounds.top, dy));
  return translateAnnotation(annotation, dx, dy);
}

export function fitAnnotationToPage(annotation, viewBox) {
  if (!viewBox) return annotation;
  const bounds = annotationBounds(annotation);
  const [minX, minY, maxX, maxY] = viewBox;
  const dx = Math.max(minX - bounds.left, Math.min(0, maxX - bounds.right));
  const dy = Math.max(minY - bounds.bottom, Math.min(0, maxY - bounds.top));
  return translateAnnotation(annotation, dx, dy);
}

export function hitTestAnnotation(annotations, point, scale, includeExternal, measureText) {
  const tolerance = 7 / scale;
  for (let index = annotations.length - 1; index >= 0; index--) {
    const annotation = annotations[index];
    if (annotation.kind === "external") {
      if (includeExternal && pointInBounds(point, annotationBounds(annotation), tolerance)) return annotation;
    } else if (isTextAnnotation(annotation.kind)) {
      const { width, height } = measureText(annotation);
      const angle = annotation.rotation * Math.PI / 180;
      const dx = point[0] - annotation.x;
      const dy = point[1] - annotation.y;
      const x = dx * Math.cos(angle) + dy * Math.sin(angle);
      const y = dx * Math.sin(angle) - dy * Math.cos(angle);
      if (x >= -tolerance && x <= width + tolerance && y >= -tolerance && y <= height + tolerance) return annotation;
    } else if (annotation.kind === "highlight") {
      if (annotation.quads.some(points => pointInBounds(point, annotationBounds({ points }), tolerance))) return annotation;
    } else if (annotation.kind === "rect") {
      const bounds = annotationBounds(annotation);
      const margin = tolerance + annotation.width / 2;
      if (!pointInBounds(point, bounds, margin)) continue;
      const [x, y] = point;
      if (annotationFillOpacity(annotation) > 0 || Math.min(x - bounds.left, bounds.right - x, y - bounds.bottom, bounds.top - y) <= margin) return annotation;
    } else {
      for (let i = 0; i < annotation.points.length; i++) {
        if (distanceFromSegment(point, annotation.points[i], annotation.points[i + 1] ?? annotation.points[i])
            <= annotation.width / 2 + tolerance) return annotation;
      }
    }
  }
  return null;
}

function distanceFromSegment([x, y], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

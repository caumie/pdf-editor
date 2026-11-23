import { annotationBounds, translateAnnotation } from "./annotations.mjs";

const alignmentTolerance = 1e-7;

export function annotationGroupBounds(annotations) {
  if (!annotations.length) return null;
  const boxes = annotations.map(annotationBounds);
  return { left: Math.min(...boxes.map(box => box.left)), right: Math.max(...boxes.map(box => box.right)),
    bottom: Math.min(...boxes.map(box => box.bottom)), top: Math.max(...boxes.map(box => box.top)) };
}

// ページ端で個別に止めると配置関係が壊れるため、全体に同じ移動量を適用する。
export function translateAnnotationGroup(annotations, dx, dy, viewBox) {
  const bounds = annotationGroupBounds(annotations);
  if (!bounds) return annotations;
  const [left, bottom, right, top] = viewBox;
  if (bounds.right - bounds.left <= right - left) dx = Math.max(left - bounds.left, Math.min(right - bounds.right, dx));
  if (bounds.top - bounds.bottom <= top - bottom) dy = Math.max(bottom - bounds.bottom, Math.min(top - bounds.top, dy));
  return annotations.map(annotation => translateAnnotation(annotation, dx, dy));
}

// 整列方向はPDF座標ではなく画面上の左右・上下。回転したページでも同じ操作になる。
export function arrangeAnnotations(annotations, action, viewport) {
  if (annotations.length < (action.startsWith("distribute-") ? 3 : 2)) return annotations;
  const horizontal = ["left", "center", "right", "distribute-x"].includes(action);
  if (!["left", "center", "right", "top", "middle", "bottom", "distribute-x", "distribute-y"].includes(action)) return annotations;
  const items = annotations.map(annotation => {
    const b = annotationBounds(annotation);
    const corners = [[b.left, b.bottom], [b.left, b.top], [b.right, b.bottom], [b.right, b.top]]
      .map(point => viewport.convertToViewportPoint(...point));
    const axis = horizontal ? 0 : 1;
    const start = Math.min(...corners.map(point => point[axis]));
    const end = Math.max(...corners.map(point => point[axis]));
    return { annotation, start, end };
  });
  const low = Math.min(...items.map(item => item.start));
  const high = Math.max(...items.map(item => item.end));
  let shifts;
  if (action.startsWith("distribute-")) {
    shifts = distributionShifts(items, low, high);
    if (!shifts.size) return annotations;
  } else {
    shifts = new Map();
    const position = ["left", "top"].includes(action) ? low : ["right", "bottom"].includes(action) ? high : (low + high) / 2;
    for (const item of items) {
      const edge = ["left", "top"].includes(action) ? item.start : ["right", "bottom"].includes(action) ? item.end : (item.start + item.end) / 2;
      const delta = position - edge;
      if (Math.abs(delta) >= alignmentTolerance) shifts.set(item.annotation.id, delta);
    }
  }
  const [originX, originY] = viewport.convertToPdfPoint(0, 0);
  return annotations.map(annotation => {
    const delta = shifts.get(annotation.id);
    if (!delta) return annotation;
    const [x, y] = viewport.convertToPdfPoint(horizontal ? delta : 0, horizontal ? 0 : delta);
    return translateAnnotation(annotation, x - originX, y - originY);
  });
}

function distributionShifts(items, low, high) {
  const shifts = new Map();
  const middle = [];
  let firstCenter = Infinity;
  let lastCenter = -Infinity;
  // 同じ外端の注釈はすべて固定し、その側で最も外にある中心を基準にする。
  for (const item of items) {
    const radius = (item.end - item.start) / 2;
    const center = item.start + radius;
    const first = item.start - low <= alignmentTolerance;
    const last = high - item.end <= alignmentTolerance;
    if (first) firstCenter = Math.min(firstCenter, center);
    if (last) lastCenter = Math.max(lastCenter, center);
    if (!first && !last) middle.push({ annotation: item.annotation, center, radius });
  }
  if (!middle.length) return shifts;

  // 中間の並び順と重複の判定には中心を使う。
  middle.sort((a, b) => a.center - b.center);
  const groups = [];
  for (const item of middle) {
    const group = groups.at(-1);
    if (group && item.center - group.center < alignmentTolerance) {
      group.radius = Math.max(group.radius, item.radius);
      group.items.push(item);
    } else {
      groups.push({ center: item.center, radius: item.radius, items: [item] });
    }
  }

  const midIndex = (groups.length - 1) / 2;
  const centerSpan = lastCenter - firstCenter;
  let step = centerSpan / (groups.length + 1);
  let midpoint = firstCenter + centerSpan / 2;
  const edgeMargin = 2 * alignmentTolerance;
  const fits = groups.every((group, index) => {
    const target = midpoint + (index - midIndex) * step;
    return Math.min(target - low, high - target) >= group.radius + edgeMargin;
  });
  // 端の中心が重なる場合や中間の注釈が外端を越える場合は、選択全体の中央に等間隔で収める。
  if (centerSpan <= edgeMargin || !fits) {
    const halfSpan = (high - low) / 2;
    midpoint = low + halfSpan;
    if (centerSpan <= edgeMargin) step = (high - low) / (groups.length + 1);
    for (const [index, group] of groups.entries()) {
      const distance = Math.abs(index - midIndex);
      if (distance === 0) continue;
      const reach = Math.max(0, halfSpan - group.radius - edgeMargin);
      step = Math.min(step, reach / distance);
    }
  }
  // 許容誤差に近い間隔は同じ中心に揃えて、次の操作でも同じ配置単位にする。
  if (step <= 2 * alignmentTolerance) step = 0;

  let moved = false;
  for (const [index, group] of groups.entries()) {
    const target = midpoint + (index - midIndex) * step;
    for (const item of group.items) {
      const delta = target - item.center;
      shifts.set(item.annotation.id, delta);
      if (Math.abs(delta) >= alignmentTolerance) moved = true;
    }
  }
  // 一つでも動かすときは、丸め誤差で位置決めや履歴が分割されないよう全員を計算済みの位置に置く。
  return moved ? shifts : new Map();
}

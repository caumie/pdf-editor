import { currentOriginalAppearance } from "./annotation-state.mjs";

const textAnnotationImages = new WeakMap();
const defaultTextRasterScale = 3;
const externalAnnotationRasters = new Map();

export function setExternalAnnotationRaster(key, raster) {
  const previous = externalAnnotationRasters.get(key);
  if (previous && previous !== raster) previous.canvas.width = previous.canvas.height = 0;
  externalAnnotationRasters.set(key, raster);
}

export function releaseExternalAnnotationRasters(sourceId) {
  for (const [key, raster] of externalAnnotationRasters) {
    if (!key.startsWith(sourceId + ":")) continue;
    raster.canvas.width = raster.canvas.height = 0;
    externalAnnotationRasters.delete(key);
  }
}

export function lineArrowPoints(annotation) {
  if (annotation.kind !== "line" || !annotation.arrowEnd || annotation.points.length < 2) return [];
  const [start, end] = annotation.points;
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  if (!length) return [];
  const size = Math.min(Math.max(8, annotation.width * 4), length * .6);
  const ux = (end[0] - start[0]) / length;
  const uy = (end[1] - start[1]) / length;
  return [end, [end[0] - size * ux - size * .45 * uy, end[1] - size * uy + size * .45 * ux],
    [end[0] - size * ux + size * .45 * uy, end[1] - size * uy - size * .45 * ux]];
}

function isHighlightAnnotation(annotation) {
  return annotation.kind === "highlight" || (annotation.kind === "external" && annotation.subtype === "Highlight");
}

export function isTextAnnotation(kind) {
  return kind === "text" || kind === "note";
}

export function textBoxPointToPdf(annotation, x, y) {
  const angle = annotation.rotation * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [annotation.x + x * cos + y * sin, annotation.y + x * sin - y * cos];
}

export function annotationBounds(annotation) {
  if (annotation.kind === "external") {
    const [left, bottom, right, top] = annotation.rect;
    return { left, bottom, right, top, width: right - left, height: top - bottom };
  }
  let points = annotation.kind === "highlight" ? annotation.quads.flat() : annotation.points;
  if (annotation.kind === "line" && annotation.arrowEnd) points = [...points, ...lineArrowPoints(annotation)];
  if (isTextAnnotation(annotation.kind)) {
    const { width, height } = renderTextAnnotationImage(annotation);
    points = [[0, 0], [width, 0], [0, height], [width, height]]
      .map(([x, y]) => textBoxPointToPdf(annotation, x, y));
  }
  let [[left, bottom]] = points;
  let right = left;
  let top = bottom;
  for (const [x, y] of points) {
    left = Math.min(left, x);
    right = Math.max(right, x);
    bottom = Math.min(bottom, y);
    top = Math.max(top, y);
  }
  return { left, bottom, right, top, width: right - left, height: top - bottom };
}

export function annotationHandles(annotation, scale) {
  if (annotation.locked) return [];
  if (annotation.kind === "highlight") return [];
  if (isTextAnnotation(annotation.kind)) {
    const { width, height } = renderTextAnnotationImage(annotation);
    const [x, y] = textBoxPointToPdf(annotation, width, height / 2);
    return [{ action: "wrap", x, y }];
  }
  const handles = [];
  if (annotation.kind !== "external" && annotation.kind !== "rect" && annotation.points.length > 1) {
    for (const index of [0, annotation.points.length - 1]) {
      const [x, y] = annotation.points[index];
      handles.push({ action: "endpoint", index, x, y });
    }
  }
  if (annotation.kind === "line" || (annotation.kind !== "external" && annotation.points.length === 1)) return handles;

  const { left, right, bottom, top, width, height } = annotationBounds(annotation);
  if (width < 0.1 || height < 0.1) return handles;
  const pad = annotation.kind === "pen" ? 10 / scale : 0;
  for (const [x, anchorX] of [[left, right], [right, left]]) {
    for (const [y, anchorY] of [[bottom, top], [top, bottom]]) {
      handles.push({
        action: "resize", anchorX, anchorY, cornerX: x, cornerY: y,
        x: x + Math.sign(x - anchorX) * pad,
        y: y + Math.sign(y - anchorY) * pad,
      });
    }
  }
  return handles;
}

export function resizeExternalAnnotation(annotation, anchorX, anchorY, scaleX, scaleY) {
  // 元PDFの座標から現在の座標への変換を合成し、保存のたびに変形が重ならないようにする。
  return {
    ...annotation,
    rect: annotation.rect.map((value, index) => index % 2
      ? anchorY + (value - anchorY) * scaleY : anchorX + (value - anchorX) * scaleX),
    scaleX: (annotation.scaleX ?? 1) * scaleX,
    scaleY: (annotation.scaleY ?? 1) * scaleY,
    offsetX: anchorX + (annotation.offsetX - anchorX) * scaleX,
    offsetY: anchorY + (annotation.offsetY - anchorY) * scaleY,
  };
}

export function translateAnnotation(annotation, dx, dy) {
  if (!dx && !dy) return annotation;
  if (annotation.kind === "external") {
    return { ...annotation, rect: annotation.rect.map((value, index) => value + (index % 2 ? dy : dx)),
      offsetX: annotation.offsetX + dx, offsetY: annotation.offsetY + dy };
  }
  if (annotation.kind === "highlight") {
    return { ...annotation, quads: annotation.quads.map(quad => quad.map(([x, y]) => [x + dx, y + dy])) };
  }
  if (isTextAnnotation(annotation.kind)) {
    const moved = { ...annotation, x: annotation.x + dx, y: annotation.y + dy };
    textAnnotationImages.set(moved, renderTextAnnotationImage(annotation));
    return moved;
  }
  return { ...annotation, points: annotation.points.map(([x, y]) => [x + dx, y + dy]) };
}

export function opacityFromTransparency(transparency) {
  return (100 - transparency) / 100;
}

export function annotationFillOpacity(annotation) {
  return annotation.useFillTransparency ? opacityFromTransparency(annotation.fillTransparency) : 1;
}

export function drawAnnotationsOnCanvas(canvas, viewport, annotations, selection = null, requestedTextScale = defaultTextRasterScale, highlightCanvas = null) {
  if (!selection && !annotations.length) return;
  const ctx = canvas.getContext("2d");
  ctx.save();
  if (selection) ctx.clearRect(0, 0, canvas.width, canvas.height);
  applyAnnotationTransform(ctx, viewport, canvas);
  const highlights = annotations.filter(isHighlightAnnotation);
  if (highlightCanvas) {
    highlightCanvas.hidden = !highlights.length;
    if (highlights.length) {
      if (highlightCanvas.width !== canvas.width || highlightCanvas.height !== canvas.height) {
        highlightCanvas.width = canvas.width;
        highlightCanvas.height = canvas.height;
      }
      const highlightContext = highlightCanvas.getContext("2d");
      highlightContext.save();
      highlightContext.clearRect(0, 0, highlightCanvas.width, highlightCanvas.height);
      applyAnnotationTransform(highlightContext, viewport, highlightCanvas);
      drawHighlightMarks(highlightContext, highlights);
      highlightContext.restore();
    } else if (highlightCanvas.width) {
      highlightCanvas.width = highlightCanvas.height = 0;
    }
  } else if (highlights.length) {
    drawHighlightMarks(ctx, highlights);
  }
  const textScale = Math.max(defaultTextRasterScale, requestedTextScale);
  for (const annotation of annotations) {
    if (!isHighlightAnnotation(annotation)) drawAnnotation(ctx, annotation, textScale);
  }
  if (selection) {
    const [a, b] = viewport.transform;
    const scale = Math.hypot(a, b);
    if (selection.ids?.size) {
      for (const annotation of annotations) {
        if (selection.ids.has(annotation.id)) drawAnnotationOutline(ctx, annotation, scale);
      }
    } else {
      const id = selection.id;
      const selected = annotations.find(annotation => annotation.id === id);
      if (selected) drawAnnotationHandles(ctx, selected, scale);
    }
    if (selection.candidateId != null) {
      const candidate = annotations.find(annotation => annotation.id === selection.candidateId);
      if (candidate) drawSelectionCandidate(ctx, candidate, scale);
    }
  }
  ctx.restore();
}

function applyAnnotationTransform(ctx, viewport, canvas) {
  const sx = canvas.width / viewport.width;
  const sy = canvas.height / viewport.height;
  const [a, b, c, d, e, f] = viewport.transform;
  ctx.setTransform(sx * a, sy * b, sx * c, sy * d, sx * e, sy * f);
}

function drawHighlightMarks(ctx, highlights) {
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  for (const annotation of highlights) {
    if (annotation.kind === "external") {
      // 外部画像には透明度が焼き込まれているため、直前の注釈のalphaを重ねない。
      ctx.globalAlpha = 1;
      drawAnnotation(ctx, annotation, defaultTextRasterScale);
      continue;
    }
    ctx.globalAlpha = 1;
    if (drawOriginalAppearance(ctx, annotation)) continue;
    ctx.globalAlpha = opacityFromTransparency(annotation.fillTransparency);
    ctx.fillStyle = annotation.color;
    ctx.beginPath();
    for (const [tl, tr, bl, br] of annotation.quads) {
      ctx.moveTo(...tl);
      ctx.lineTo(...tr);
      ctx.lineTo(...br);
      ctx.lineTo(...bl);
      ctx.closePath();
    }
    ctx.fill();
  }
  ctx.restore();
}

export function renderTextAnnotationImage(annotation, requestedScale = defaultTextRasterScale) {
  const cacheable = requestedScale === defaultTextRasterScale;
  const cached = textAnnotationImages.get(annotation);
  if (cacheable && cached) return cached;
  const canvas = document.createElement("canvas");
  const layout = cached?.layout ?? layoutAnnotationText(canvas, annotation);
  const { font, pad, lines, lineHeight, firstBaseline, width, height } = layout;
  const note = annotation.kind === "note";
  const resolution = Math.min(requestedScale, 8192 / Math.max(width, height), Math.sqrt(14_000_000 / (width * height)));
  canvas.width = Math.ceil(width * resolution);
  canvas.height = Math.ceil(height * resolution);
  // リサイズでコンテキストの設定が初期化される。
  const paint = canvas.getContext("2d");
  paint.scale(canvas.width / width, canvas.height / height);
  const fillOpacity = annotationFillOpacity(annotation);
  if (note && fillOpacity > 0) {
    paint.save();
    paint.globalAlpha = fillOpacity;
    paint.fillStyle = annotation.color;
    paint.fillRect(0, 0, width, height);
    paint.fillStyle = "rgba(0, 0, 0, .16)";
    paint.beginPath();
    paint.moveTo(width - 10, height);
    paint.lineTo(width, height - 10);
    paint.lineTo(width, height);
    paint.fill();
    paint.restore();
  }
  paint.font = font;
  paint.textBaseline = "alphabetic";
  paint.fillStyle = note ? noteInkColor(annotation.color, fillOpacity) : annotation.color;
  lines.forEach((line, index) => paint.fillText(line, pad, firstBaseline + index * lineHeight));
  const raster = { canvas, width, height, layout };
  if (cacheable) textAnnotationImages.set(annotation, raster);
  return raster;
}

function layoutAnnotationText(canvas, annotation) {
  const ctx = canvas.getContext("2d");
  const font = (annotation.bold ? "700 " : "400 ") + annotation.size
    + 'px "Noto Sans JP", "Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic", Meiryo, sans-serif';
  ctx.font = font;
  ctx.textBaseline = "alphabetic";
  const pad = textAnnotationPadding(annotation);
  const wrap = annotation.wrapWidth ? Math.max(annotation.size, annotation.wrapWidth - 2 * pad) : 232;
  const lines = wrapAnnotationText(ctx, annotation.text, wrap);
  const lineHeight = annotation.size * 1.38;
  const { widestLine, top, bottom } = measureAnnotationLines(ctx, lines, lineHeight, annotation.size);
  const width = Math.ceil(Math.max(annotation.wrapWidth ?? (annotation.kind === "note" ? 94 : 4), widestLine + 2 * pad));

  // 和文と欧文が混ざる行ではフォントの測定値と描画結果がずれることがある。
  // 文字を一度描画し、背景を描く前に上下の実際の境界を求める。
  const samplePad = Math.max(pad, annotation.size);
  const sampleHeight = Math.ceil(bottom - top + 2 * samplePad);
  const scale = Math.min(3, 8192 / Math.max(width, sampleHeight), Math.sqrt(2_000_000 / (width * sampleHeight)));
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(sampleHeight * scale);
  const scaleY = canvas.height / sampleHeight;
  const sample = canvas.getContext("2d");
  const sampleBaseline = samplePad - top;
  sample.scale(canvas.width / width, scaleY);
  sample.font = font;
  sample.textBaseline = "alphabetic";
  lines.forEach((line, index) => sample.fillText(line, pad, sampleBaseline + index * lineHeight));
  const rgba = sample.getImageData(0, 0, canvas.width, canvas.height).data;
  const firstRow = findAnnotationInkRow(rgba, canvas.width, 0, canvas.height, 1);
  const lastRow = findAnnotationInkRow(rgba, canvas.width, canvas.height - 1, -1, -1);
  const inkTop = firstRow === undefined ? top : firstRow / scaleY - sampleBaseline;
  const inkHeight = firstRow === undefined ? bottom - top : (lastRow + 1 - firstRow) / scaleY;
  const height = Math.ceil(inkHeight + 2 * pad);
  const firstBaseline = (height - inkHeight) / 2 - inkTop;
  return { font, pad, lines, lineHeight, firstBaseline, width, height };
}

function findAnnotationInkRow(rgba, width, start, end, direction) {
  const step = 4 * width;
  for (let row = start; row !== end; row += direction) {
    for (let offset = row * step + 3; offset < (row + 1) * step; offset += 4) {
      if (rgba[offset] >= 16) return row;
    }
  }
  return undefined;
}

function measureAnnotationLines(ctx, lines, lineHeight, size) {
  let widestLine = 0;
  let top = Infinity;
  let bottom = -Infinity;
  for (const [index, line] of lines.entries()) {
    const metrics = ctx.measureText(line);
    widestLine = Math.max(widestLine, metrics.width);
    if (!line.trim()) continue;
    const ascent = metrics.actualBoundingBoxAscent ?? size * .8;
    const descent = metrics.actualBoundingBoxDescent ?? size * .2;
    if (!(ascent + descent > 0)) continue;
    const baseline = index * lineHeight;
    top = Math.min(top, baseline - ascent);
    bottom = Math.max(bottom, baseline + descent);
  }
  // 外側の空行は見た目の余白に含めず、文字の間にある空行は行送りに残す。
  return Number.isFinite(top) ? { widestLine, top, bottom }
    : { widestLine, top: -size * .8, bottom: size * .2 };
}

export function colorChannels(hex) {
  return [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
}

function drawOriginalAppearance(ctx, annotation) {
  const original = currentOriginalAppearance(annotation);
  const raster = original && externalAnnotationRasters.get(annotation.appearanceKey);
  if (!raster) return false;
  const [left, bottom, right, top] = original.rect;
  ctx.save();
  ctx.translate(left, top);
  ctx.scale(1, -1);
  ctx.drawImage(raster.canvas, 0, 0, right - left, top - bottom);
  ctx.restore();
  return true;
}

function drawAnnotation(ctx, annotation, textScale) {
  if (drawOriginalAppearance(ctx, annotation)) return;
  ctx.save();
  if (annotation.kind === "external") {
    const raster = externalAnnotationRasters.get(annotation.appearanceKey);
    if (raster) {
      const { left, top, width, height } = annotationBounds(annotation);
      ctx.translate(left, top);
      ctx.scale(1, -1);
      if (annotation.subtype === "Highlight") ctx.globalCompositeOperation = "multiply";
      ctx.drawImage(raster.canvas, 0, 0, width, height);
    }
  } else if (isTextAnnotation(annotation.kind)) {
    const { canvas, width, height } = renderTextAnnotationImage(annotation, textScale);
    ctx.translate(annotation.x, annotation.y);
    ctx.rotate(annotation.rotation * Math.PI / 180);
    ctx.scale(1, -1);
    if (annotation.kind === "text") {
      const opacity = annotationFillOpacity(annotation);
      if (annotation.boxFill && opacity > 0) {
        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.fillStyle = annotation.boxFillColor;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
      }
      if (annotation.boxBorder) {
        const inset = annotation.boxBorderWidth / 2;
        ctx.save();
        ctx.globalAlpha = opacityFromTransparency(annotation.strokeTransparency);
        ctx.strokeStyle = annotation.boxBorderColor;
        ctx.lineWidth = annotation.boxBorderWidth;
        ctx.strokeRect(inset, inset, width - 2 * inset, height - 2 * inset);
        ctx.restore();
      }
    }
    ctx.drawImage(canvas, 0, 0, width, height);
    if (textScale > defaultTextRasterScale) canvas.width = canvas.height = 0;
  } else if (annotation.kind === "rect") {
    const { left, bottom, width, height } = annotationBounds(annotation);
    const fillOpacity = annotationFillOpacity(annotation);
    if (fillOpacity > 0) {
      ctx.save();
      ctx.globalAlpha = fillOpacity;
      ctx.fillStyle = annotation.fillColor;
      ctx.fillRect(left, bottom, width, height);
      ctx.restore();
    }
    ctx.globalAlpha = opacityFromTransparency(annotation.strokeTransparency);
    ctx.lineWidth = annotation.width;
    ctx.strokeStyle = annotation.color;
    ctx.strokeRect(left, bottom, width, height);
  } else {
    const [[x, y]] = annotation.points;
    ctx.globalAlpha = opacityFromTransparency(annotation.strokeTransparency);
    ctx.lineWidth = annotation.width;
    ctx.strokeStyle = annotation.color;
    ctx.fillStyle = annotation.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    if (annotation.points.length === 1) {
      ctx.arc(x, y, annotation.width / 2, 0, 2 * Math.PI);
      ctx.fill();
    } else {
      ctx.moveTo(x, y);
      const arrow = lineArrowPoints(annotation);
      const geometry = arrow.length ? [annotation.points[0],
        [(arrow[1][0] + arrow[2][0]) / 2, (arrow[1][1] + arrow[2][1]) / 2]] : annotation.points;
      for (const [px, py] of geometry.slice(1)) ctx.lineTo(px, py);
      ctx.stroke();
      if (arrow.length) {
        ctx.beginPath();
        ctx.moveTo(...arrow[0]);
        for (const point of arrow.slice(1)) ctx.lineTo(...point);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

function drawAnnotationOutline(ctx, annotation, scale) {
  const boxes = annotation.kind === "highlight"
    ? annotation.quads.map(points => annotationBounds({ points }))
    : [annotationBounds(annotation)];
  ctx.strokeStyle = "#1659bc";
  ctx.lineWidth = 1.5 / scale;
  ctx.setLineDash([4 / scale, 3 / scale]);
  for (const { left, bottom, width, height } of boxes) {
    const pad = (annotation.kind === "pen" && width > 0.1 && height > 0.1 ? 10 : 4) / scale;
    ctx.strokeRect(left - pad, bottom - pad, width + 2 * pad, height + 2 * pad);
  }
  ctx.setLineDash([]);
}

function drawAnnotationHandles(ctx, annotation, scale) {
  drawAnnotationOutline(ctx, annotation, scale);
  ctx.fillStyle = "#ffffff";
  const radius = 4.5 / scale;
  for (const handle of annotationHandles(annotation, scale)) {
    if (handle.action === "endpoint") {
      ctx.beginPath();
      ctx.arc(handle.x, handle.y, radius, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(handle.x - radius, handle.y - radius, 2 * radius, 2 * radius);
      ctx.strokeRect(handle.x - radius, handle.y - radius, 2 * radius, 2 * radius);
    }
  }
}

function drawSelectionCandidate(ctx, annotation, scale) {
  const { left, bottom, right, top } = annotationBounds(annotation);
  const pad = 4 / scale;
  const size = 6 / scale;
  ctx.strokeStyle = "#1659bc";
  ctx.fillStyle = "#ffffff";
  ctx.lineWidth = 1.5 / scale;
  ctx.strokeRect(left - pad, bottom - pad, right - left + 2 * pad, top - bottom + 2 * pad);
  for (const x of [left - pad, right + pad]) {
    for (const y of [bottom - pad, top + pad]) {
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
      ctx.strokeRect(x - size / 2, y - size / 2, size, size);
    }
  }
}

export function textAnnotationPadding(annotation) {
  if (annotation.kind === "note") return 10;
  if (annotation.boxBorder) return Math.ceil(Math.max(8, annotation.boxBorderWidth + 3));
  return annotation.boxFill ? 8 : 2;
}

function wrapAnnotationText(ctx, text, width) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const character of paragraph) {
      if (line && ctx.measureText(line + character).width > width) {
        lines.push(line);
        line = "";
      }
      line += character;
    }
    lines.push(line);
  }
  return lines;
}

export function noteInkColor(hex, fillOpacity) {
  const [r, g, b] = colorChannels(hex);
  const luminance = r * 0.299 + g * 0.587 + b * 0.114;
  return 1 - fillOpacity * (1 - luminance) >= 0.53 ? "#242234" : "#ffffff";
}

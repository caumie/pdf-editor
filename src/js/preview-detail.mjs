import { cappedRasterScale, previewPixelRatio, renderPdfPreviewRegion } from "./pdf-preview.mjs";
import { drawAnnotationsOnCanvas } from "./annotations.mjs";

const settleDelayMs = 100;
const panMargin = 96;

function visibleRegion(page, stage) {
  const x = Math.max(0, stage.left - page.left);
  const y = Math.max(0, stage.top - page.top);
  const right = Math.min(page.width, stage.right - page.left);
  const bottom = Math.min(page.height, stage.bottom - page.top);
  return right > x && bottom > y ? { x, y, right, bottom } : null;
}

function withPanMargin(visible, page) {
  const x = Math.max(0, Math.floor(visible.x - panMargin));
  const y = Math.max(0, Math.floor(visible.y - panMargin));
  return {
    x, y,
    width: Math.min(page.width, Math.ceil(visible.right + panMargin)) - x,
    height: Math.min(page.height, Math.ceil(visible.bottom + panMargin)) - y,
  };
}

function covers(draw, bounds, ratio, visible) {
  if (!draw || draw.pageWidth !== bounds.width || draw.pageHeight !== bounds.height || draw.requestedRatio !== ratio) return false;
  const { x, y, width, height } = draw.region;
  return x <= visible.x && y <= visible.y && x + width >= visible.right && y + height >= visible.bottom;
}

function releaseCanvas(canvas) {
  canvas.remove();
  canvas.width = canvas.height = 0;
}

function resetPage(page) {
  const pending = page.pending;
  page.pending = null;
  pending?.task.cancel();
  if (page.displayed) releaseCanvas(page.displayed.canvas);
  page.displayed = null;
}

// 用紙全体の画像を下に残し、画面内で画素が足りない部分だけを高精細に描く。
export function createPreviewDetail(stage, canRefine) {
  let pages = [];
  let timer;

  function clear() {
    clearTimeout(timer);
    pages.forEach(resetPage);
    pages = [];
  }

  function setPages(layers) {
    clear();
    pages = layers.map(layer => ({ ...layer, pending: null, displayed: null }));
  }

  async function refinePage(page, stageBounds, requestedRatio) {
    const bounds = page.element.getBoundingClientRect();
    const visible = visibleRegion(bounds, stageBounds);
    const baseRatio = page.entry.ratio * page.entry.viewport.width / bounds.width;
    if (!visible || baseRatio >= requestedRatio * 0.98) {
      resetPage(page);
      return;
    }
    if (covers(page.pending, bounds, requestedRatio, visible)) return;
    if (page.pending) {
      const obsolete = page.pending;
      page.pending = null;
      obsolete.task.cancel();
    }
    if (covers(page.displayed, bounds, requestedRatio, visible)) return;

    const region = withPanMargin(visible, bounds);
    const ratio = cappedRasterScale(region, requestedRatio);
    if (ratio <= baseRatio) return;
    let draw;
    try {
      const raster = renderPdfPreviewRegion(page.entry, bounds.width, region, ratio);
      const { canvas } = raster;
      draw = { ...raster, region, requestedRatio, pageWidth: bounds.width, pageHeight: bounds.height };
      page.pending = draw;
      await draw.task.promise;
      if (page.pending !== draw) return;
      if (page.annotations?.length) drawAnnotationsOnCanvas(canvas, draw.viewport, page.annotations);
      canvas.className = "preview-detail";
      canvas.style.left = region.x / bounds.width * 100 + "%";
      canvas.style.top = region.y / bounds.height * 100 + "%";
      canvas.style.width = region.width / bounds.width * 100 + "%";
      canvas.style.height = region.height / bounds.height * 100 + "%";
      page.layer.append(canvas);
      if (page.displayed) releaseCanvas(page.displayed.canvas);
      page.displayed = draw;
    } catch (error) {
      if (error.name !== "RenderingCancelledException") console.warn(error);
    } finally {
      if (draw && page.pending === draw) page.pending = null;
      if (draw && page.displayed !== draw) releaseCanvas(draw.canvas);
    }
  }

  function refine() {
    if (!canRefine()) return;
    const box = stage.getBoundingClientRect();
    const left = box.left + stage.clientLeft;
    const top = box.top + stage.clientTop;
    const bounds = { left, top, right: left + stage.clientWidth, bottom: top + stage.clientHeight };
    const ratio = previewPixelRatio();
    for (const page of pages) refinePage(page, bounds, ratio);
  }

  function schedule() {
    if (!pages.length) return;
    clearTimeout(timer);
    timer = setTimeout(refine, settleDelayMs);
  }

  return { clear, setPages, schedule };
}

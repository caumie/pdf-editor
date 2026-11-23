import { normalizeRotation } from "./page-coordinates.mjs";
import { PdfResources } from "./libraries.mjs";
import { fitPreviewPages } from "./preview-layout.mjs";

// PDF.js の AnnotationMode.ENABLE_STORAGE。復元済み注釈の noView を反映する。
const annotationModeWithStorage = 3;

export async function openSourcePdf(pdfjs, file, password = "") {
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    password,
    BinaryDataFactory: PdfResources,
    useWorkerFetch: false,
    disableWorkerRendering: true,
  });
  try {
    const reader = await loadingTask.promise;
    if (!reader.numPages) throw new Error("ページがありません。");
    return { file, reader, loadingTask, password };
  } catch (error) {
    await loadingTask.destroy().catch(console.warn);
    throw error;
  }
}

export function renderPdfThumbnail(sourcePage, addedRotation, maxWidth, maxHeight, zoom = 1) {
  const rotation = normalizeRotation(sourcePage.rotate + addedRotation);
  const natural = sourcePage.getViewport({ scale: 1, rotation });
  const scale = Math.min(maxWidth / natural.width, maxHeight / natural.height) * zoom;
  const viewport = sourcePage.getViewport({ scale, rotation });
  const ratio = cappedRasterScale(viewport, Math.min(window.devicePixelRatio || 1, 2));
  return renderPageCanvas(sourcePage, viewport, ratio);
}

export function renderPdfPreviewPages(sourcePages, addedRotations, maxWidth, maxHeight, zoom = 1, direction = "left") {
  const rotations = sourcePages.map((page, index) => page && normalizeRotation(page.rotate + addedRotations[index]));
  const sizes = sourcePages.map((page, index) => page?.getViewport({ scale: 1, rotation: rotations[index] }) ?? null);
  const layout = fitPreviewPages(sizes, maxWidth, maxHeight, zoom, direction);
  const ratio = cappedRasterScale(layout, previewPixelRatio());
  const entries = [];
  try {
    for (const [index, page] of sourcePages.entries()) {
      if (!page) { entries.push(null); continue; }
      const viewport = page.getViewport({ scale: layout.scale, rotation: rotations[index] });
      entries.push({ ...renderPageCanvas(page, viewport, ratio), ...layout.boxes[index], sourcePage: page, ratio });
    }
  } catch (error) {
    // 途中で描画開始に失敗しても、先に開始したページを残さない。
    for (const entry of entries.filter(Boolean)) {
      entry.task.promise.catch(() => {});
      entry.task.cancel();
    }
    throw error;
  }
  const tasks = entries.filter(Boolean).map(entry => entry.task);
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    tasks.forEach(item => item.cancel());
  };
  const promise = Promise.all(tasks.map(item => item.promise)).catch(error => {
    cancel();
    throw error;
  });
  const task = { promise, cancel };
  return { width: layout.width, height: layout.height, entries, task };
}

export function cappedRasterScale({ width, height }, requestedScale) {
  return Math.min(requestedScale, 8192 / Math.max(width, height), Math.sqrt(14_000_000 / (width * height)));
}

export function previewPixelRatio() {
  return Math.min(window.devicePixelRatio || 1, 2);
}

export function renderPdfPreviewRegion(entry, displayWidth, region, ratio) {
  const viewport = entry.sourcePage.getViewport({
    scale: entry.viewport.scale * displayWidth / entry.viewport.width,
    rotation: entry.viewport.rotation,
  });
  const { x, y, width, height } = region;
  const raster = renderPageCanvas(entry.sourcePage, viewport, ratio, undefined, region);
  const [a, b, c, d, e, f] = viewport.transform;
  // 見開きの非編集ページでは、切り出した用紙に対応する座標で書き込みも重ねる。
  return { ...raster, viewport: { width, height, transform: [a, b, c, d, e - x, f - y] } };
}

export function renderPageCanvas(sourcePage, viewport, ratio, background, region) {
  const canvas = document.createElement("canvas");
  const { width, height } = region ?? viewport;
  canvas.width = Math.max(1, Math.ceil(width * ratio));
  canvas.height = Math.max(1, Math.ceil(height * ratio));
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";
  let transform = ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0];
  if (region) {
    // 端数の丸めを含めてPDF本体、書き込み、CSS表示の座標を合わせる。
    const sx = canvas.width / width;
    const sy = canvas.height / height;
    transform = [sx, 0, 0, sy, -region.x * sx, -region.y * sy];
  }
  canvas.setAttribute("aria-hidden", "true");
  const task = sourcePage.render({
    canvas,
    viewport,
    background,
    annotationMode: annotationModeWithStorage,
    transform,
  });
  return { canvas, task, viewport };
}

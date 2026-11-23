import { normalizeRotation, pdfViewportScale } from "./page-coordinates.mjs";
import { drawAnnotationsOnCanvas } from "./annotations.mjs";
import { renderPageCanvas } from "./pdf-preview.mjs";

const jpegQuality = 0.92;
const maxJpegSide = 16_384;
const maxJpegPixels = 80_000_000;

export class JpegExportError extends Error {}

export async function exportPageJpeg(sourcePage, page, dpi) {
  // PDFの1ポイントは1/72インチ。表示倍率や端末の画素密度から独立させる。
  const rotation = normalizeRotation(sourcePage.rotate + page.addedRotation);
  const viewport = sourcePage.getViewport({ scale: dpi / 72, rotation });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  if (!(width > 0 && height > 0 && width <= maxJpegSide && height <= maxJpegSide && width * height <= maxJpegPixels)) {
    throw new JpegExportError(dpi + " DPIでは " + width + " × " + height + " px になり、書き出し上限を超えます。DPIを下げてください。");
  }

  let raster;
  try {
    raster = renderPageCanvas(sourcePage, viewport, 1, "#ffffff");
    await raster.task.promise;
    const textScale = pdfViewportScale(viewport);
    drawAnnotationsOnCanvas(raster.canvas, viewport, page.annotations, null, textScale);
    const jpeg = await encodeCanvasJpeg(raster.canvas);
    return await writeJpegDensity(jpeg, dpi);
  } catch (error) {
    throw new JpegExportError(dpi + " DPIの画像を生成できませんでした。DPIを下げると書き出せる場合があります。", { cause: error });
  } finally {
    if (raster) raster.canvas.width = raster.canvas.height = 0;
  }
}

function encodeCanvasJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob?.type === "image/jpeg") resolve(blob);
      else reject(new Error("ページをJPEGに変換できませんでした。"));
    }, "image/jpeg", jpegQuality);
  });
}

async function writeJpegDensity(jpeg, dpi) {
  // Canvasの既定の解像度を置き換える。圧縮済みの画像データはそのまま使う。
  const header = new Uint8Array(await jpeg.slice(0, 20).arrayBuffer());
  if (header[0] !== 0xff || header[1] !== 0xd8) throw new Error("JPEGのヘッダーを読み込めません。");
  const jfifId = [0x4a, 0x46, 0x49, 0x46, 0x00];
  const density = new Uint8Array(5);
  const view = new DataView(density.buffer);
  view.setUint8(0, 1); // インチあたりの画素数
  view.setUint16(1, dpi);
  view.setUint16(3, dpi);

  const hasJfif = header.length >= 20 && header[2] === 0xff && header[3] === 0xe0
    && ((header[4] << 8) | header[5]) >= 16 && jfifId.every((byte, i) => header[6 + i] === byte);
  if (hasJfif) {
    return new Blob([jpeg.slice(0, 13), density, jpeg.slice(18)], { type: jpeg.type });
  }
  const jfif = new Uint8Array([0xff, 0xe0, 0, 16, ...jfifId, 1, 1, ...density, 0, 0]);
  return new Blob([jpeg.slice(0, 2), jfif, jpeg.slice(2)], { type: jpeg.type });
}

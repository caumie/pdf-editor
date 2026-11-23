import { normalizeRotation, pdfViewportScale } from "./page-coordinates.mjs";
import { drawAnnotationsOnCanvas } from "./annotations.mjs";
import { renderPageCanvas } from "./pdf-preview.mjs";

const maxImageSide = 16_384;
const maxImagePixels = 80_000_000;

export class ImageExportError extends Error {}

export async function exportPageImage(sourcePage, page, { extension, dpi, jpegQuality = 92 }) {
  const jpeg = extension === "jpg";
  const mimeType = jpeg ? "image/jpeg" : "image/png";
  const formatLabel = jpeg ? "JPEG" : "PNG";
  // PDFの1ポイントは1/72インチ。表示倍率や端末の画素密度から独立させる。
  const rotation = normalizeRotation(sourcePage.rotate + page.addedRotation);
  const viewport = sourcePage.getViewport({ scale: dpi / 72, rotation });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  if (!(width > 0 && height > 0 && width <= maxImageSide && height <= maxImageSide && width * height <= maxImagePixels)) {
    throw new ImageExportError(dpi + " DPIでは " + width + " × " + height + " px になり、書き出し上限を超えます。DPIを下げてください。");
  }

  let raster;
  try {
    raster = renderPageCanvas(sourcePage, viewport, 1, "#ffffff");
    await raster.task.promise;
    const textScale = pdfViewportScale(viewport);
    drawAnnotationsOnCanvas(raster.canvas, viewport, page.annotations, null, textScale);
    const image = await new Promise((resolve, reject) => {
      raster.canvas.toBlob(blob => {
        if (blob?.type === mimeType) resolve(blob);
        else reject(new Error("ページを" + formatLabel + "に変換できませんでした。"));
      }, mimeType, jpeg ? jpegQuality / 100 : undefined);
    });
    return await (jpeg ? writeJpegDensity(image, dpi) : writePngDensity(image, dpi));
  } catch (error) {
    throw new ImageExportError(formatLabel + "（" + dpi + " DPI）を生成できませんでした。DPIを下げると書き出せる場合があります。", { cause: error });
  } finally {
    if (raster) raster.canvas.width = raster.canvas.height = 0;
  }
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

async function writePngDensity(png, dpi) {
  // pHYsだけを更新し、圧縮済みの画素データはそのまま使う。
  const density = new DataView(new ArrayBuffer(21));
  density.setUint32(0, 9);
  density.setUint32(4, 0x70485973); // pHYs
  const pixelsPerMeter = Math.round(dpi / 0.0254);
  density.setUint32(8, pixelsPerMeter);
  density.setUint32(12, pixelsPerMeter);
  density.setUint8(16, 1); // メートル
  let crc = 0xffffffff;
  for (let index = 4; index < 17; index++) {
    crc ^= density.getUint8(index);
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  density.setUint32(17, crc ^ 0xffffffff);

  // Canvasが記録した既定値を置き換える。既定値がなければ最初のIDATの手前に入れる。
  for (let offset = 8; offset + 12 <= png.size;) {
    const header = new DataView(await png.slice(offset, offset + 8).arrayBuffer());
    const end = offset + header.getUint32(0) + 12;
    if (end > png.size) break;
    const type = header.getUint32(4);
    if (type === 0x70485973 || type === 0x49444154) {
      return new Blob([png.slice(0, offset), density.buffer, png.slice(type === 0x70485973 ? end : offset)], { type: png.type });
    }
    offset = end;
  }
  throw new Error("PNGの画像データを読み込めません。");
}

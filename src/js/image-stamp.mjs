import { readImageDpi } from "./image-import.mjs";

const stampBitmaps = new WeakMap();
const stampDpi = new WeakMap();

export function stampBitmap(bytes) {
  return stampBitmaps.get(bytes);
}

export async function prepareStampBitmap(bytes) {
  if (!stampBitmaps.has(bytes)) {
    stampBitmaps.set(bytes, await createImageBitmap(new Blob([bytes], { type: "image/png" })));
  }
}

export async function loadStampImage(file) {
  const source = new Uint8Array(await file.arrayBuffer());
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => source[index] === byte);
  const jpeg = source[0] === 255 && source[1] === 216 && source[2] === 255;
  if (!png && !jpeg) throw new Error("PNGまたはJPEGを選んでください。");
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const encoded = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    if (!encoded) throw new Error("画像を変換できません。");
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    stampBitmaps.set(bytes, canvas);
    stampDpi.set(bytes, readImageDpi(source, png ? "PNG" : "JPEG"));
    return bytes;
  } finally {
    bitmap.close();
  }
}

export function placeImageStamp(image, point, viewport) {
  const { width, height } = stampBitmap(image);
  const rotation = viewport.rotation;
  const sideways = rotation % 180 !== 0;
  const [left, bottom, right, top] = viewport.viewBox;
  const pageWidth = right - left, pageHeight = top - bottom;
  const [dpiX, dpiY] = stampDpi.get(image) ?? [96, 96];
  const unitsPerInch = 72 / (viewport.userUnit ?? 1);
  const naturalWidth = width / dpiX * unitsPerInch;
  const naturalHeight = height / dpiY * unitsPerInch;
  const stampWidth = sideways ? naturalHeight : naturalWidth;
  const stampHeight = sideways ? naturalWidth : naturalHeight;
  const scale = Math.min(1, pageWidth / stampWidth, pageHeight / stampHeight);
  const halfWidth = stampWidth * scale / 2;
  const halfHeight = stampHeight * scale / 2;
  const [x, y] = point;
  return { kind: "stamp", image, rotation,
    points: [[x - halfWidth, y - halfHeight], [x + halfWidth, y + halfHeight]] };
}

export function sourceImageFormat(file) {
  const type = file.type?.toLowerCase();
  if (type === "image/jpeg") return "JPEG";
  if (type === "image/png") return "PNG";
  if (/\.jpe?g$/i.test(file.name)) return "JPEG";
  if (/\.png$/i.test(file.name)) return "PNG";
  return null;
}

function* jpegSegments(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return;
  for (let offset = 2; offset + 4 <= bytes.length && bytes[offset] === 0xff;) {
    const marker = bytes[offset + 1];
    if (marker === 0xff) { offset++; continue; }
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 1 || marker >= 0xd0 && marker <= 0xd7) { offset += 2; continue; }
    const length = view.getUint16(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > bytes.length) break;
    yield { marker, start: offset + 4, end };
    offset = end;
  }
}

function readJpegOrientation(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const { marker, start, end } of jpegSegments(bytes)) {
    const tiff = start + 6;
    if (marker === 0xe1 && tiff + 8 <= end && view.getUint32(start) === 0x45786966 && view.getUint16(start + 4) === 0) {
      const order = view.getUint16(tiff);
      const little = order === 0x4949;
      if ((little || order === 0x4d4d) && view.getUint16(tiff + 2, little) === 42) {
        const directory = tiff + view.getUint32(tiff + 4, little);
        if (directory >= tiff + 8 && directory + 2 <= end) {
          const count = view.getUint16(directory, little);
          for (let index = 0, entry = directory + 2; index < count && entry + 12 <= end; index++, entry += 12) {
            if (view.getUint16(entry, little) !== 0x0112 || view.getUint16(entry + 2, little) !== 3
                || view.getUint32(entry + 4, little) !== 1) continue;
            const orientation = view.getUint16(entry + 8, little);
            if (orientation >= 2 && orientation <= 8) {
              // PDFの描画命令で向きを指定するため、埋め込み用のコピーではEXIFによる補正を無効にする。
              view.setUint16(entry + 8, 1, little);
              return orientation;
            }
            return 1;
          }
        }
      }
    }
  }
  return 1;
}

// JPEG内のICCをPDFの画像色空間からも参照する。圧縮済みJPEG自体は再エンコードしない。
function readJpegIcc(bytes) {
  const id = new TextEncoder().encode("ICC_PROFILE\0");
  const parts = new Map();
  let count = 0, length = 0;
  for (const { marker, start, end } of jpegSegments(bytes)) {
    if (marker !== 0xe2 || end - start < 14 || !id.every((value, i) => bytes[start + i] === value)) continue;
    const index = bytes[start + 12], total = bytes[start + 13];
    if (!index || index > total || (count && total !== count) || parts.has(index)) return null;
    count = total;
    const chunk = bytes.subarray(start + 14, end);
    parts.set(index, chunk);
    length += chunk.length;
  }
  if (!count || parts.size !== count || length < 132) return null;
  const profile = new Uint8Array(length);
  let offset = 0;
  for (let index = 1; index <= count; index++) {
    const chunk = parts.get(index);
    profile.set(chunk, offset); offset += chunk.length;
  }
  const view = new DataView(profile.buffer);
  if (view.getUint32(0) !== length || view.getUint32(36) !== 0x61637370) return null;
  const signatures = new Map([[0x47524159, ["DeviceGray", 1]], [0x52474220, ["DeviceRGB", 3]], [0x434d594b, ["DeviceCMYK", 4]]]);
  const color = signatures.get(view.getUint32(16));
  const tags = view.getUint32(128);
  if (!color || !tags || tags > Math.floor((length - 132) / 12)) return null;
  for (let i = 0; i < tags; i++) {
    const data = view.getUint32(132 + 12 * i + 4), size = view.getUint32(132 + 12 * i + 8);
    if (data < 132 + tags * 12 || data + size > length || size < 8) return null;
  }
  return { profile, colorSpace: color[0], components: color[1] };
}

function orientImage(pdfLib, orientation, width, height) {
  const matrix = {
    2: [-1, 0, 0, 1, width, 0],
    3: [-1, 0, 0, -1, width, height],
    4: [1, 0, 0, -1, 0, height],
    5: [0, -1, -1, 0, height, width],
    6: [0, -1, 1, 0, 0, width],
    7: [0, 1, 1, 0, 0, 0],
    8: [0, 1, -1, 0, height, 0],
  }[orientation];
  return pdfLib.concatTransformationMatrix(...matrix);
}

export async function createImagePdf(pdfLib, file, format) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const orientation = format === "JPEG" ? readJpegOrientation(bytes) : 1;
  const document = await pdfLib.PDFDocument.create({ updateMetadata: false });
  const image = await (format === "JPEG" ? document.embedJpg(bytes) : document.embedPng(bytes));
  if (!(image.width > 0 && image.height > 0)) throw new Error("画像の寸法が無効です。");
  const swapped = orientation >= 5;
  const width = swapped ? image.height : image.width;
  const height = swapped ? image.width : image.height;
  const a4 = pdfLib.PageSizes.A4;
  const bounds = width > height ? [a4[1], a4[0]] : a4;
  // 96 px/inで換算し、大きな画像は縦横比を保ったままA4に収める。埋め込む画素はそのまま使う。
  const scale = Math.min(72 / 96, bounds[0] / width, bounds[1] / height);
  const page = document.addPage([width * scale, height * scale]);
  const drawnWidth = image.width * scale;
  const drawnHeight = image.height * scale;
  if (orientation !== 1) page.pushOperators(pdfLib.pushGraphicsState(), orientImage(pdfLib, orientation, drawnWidth, drawnHeight));
  page.drawImage(image, { x: 0, y: 0, width: drawnWidth, height: drawnHeight });
  if (orientation !== 1) page.pushOperators(pdfLib.popGraphicsState());
  const embeddedIcc = format === "JPEG" ? readJpegIcc(bytes) : null;
  if (embeddedIcc) {
    await image.embed();
    const stream = document.context.lookup(image.ref);
    const name = pdfLib.PDFName.of;
    const alternate = name(embeddedIcc.colorSpace);
    if (stream?.dict.lookup(name("ColorSpace")) === alternate) {
      const profile = document.context.flateStream(embeddedIcc.profile, { N: embeddedIcc.components, Alternate: alternate });
      stream.dict.set(name("ColorSpace"), document.context.obj(["ICCBased", document.context.register(profile)]));
    }
  }
  return {
    pdfFile: new Blob([await document.save()], { type: "application/pdf" }),
    image: { format, width, height },
  };
}

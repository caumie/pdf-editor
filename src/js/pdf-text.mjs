// PDF 2.0のUTF-8テキスト文字列だけを判別する。名前やバイナリの文字列には使わない。
const utf8 = new TextDecoder("utf-8", { fatal: true });

function pdfUtf8Text(pdfLib, value) {
  if (!(value instanceof pdfLib.PDFString || value instanceof pdfLib.PDFHexString)) return undefined;
  const bytes = value.asBytes();
  if (bytes[0] !== 0xef || bytes[1] !== 0xbb || bytes[2] !== 0xbf) return undefined;
  try { return utf8.decode(bytes); } catch { return undefined; }
}

export function decodePdfText(pdfLib, value) {
  return pdfUtf8Text(pdfLib, value) ?? value?.decodeText();
}

export function compatiblePdfText(pdfLib, value) {
  const text = pdfUtf8Text(pdfLib, value);
  return text === undefined ? undefined : pdfLib.PDFHexString.fromText(text);
}

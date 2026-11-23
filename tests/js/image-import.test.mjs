import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { sourceImageFormat } from "../../src/js/image-import.mjs";
import { createPdfExporter } from "../../src/js/pdf-export.mjs";

const require = createRequire(import.meta.url);
const lib = require("../../src/vendor/cantoo-pdf-lib/pdf-lib.min.js");

test("透過PNGを画像の縦横比で1ページにし、出力時も透過画像と通常のPDFページをまとめられる", async () => {
  const exporter = createPdfExporter(lib);
  const rgbaPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAG0lEQVR4nDXBwQEAAAQEoI7Fbc5LZRkob5lUOzBIAwgymkXyAAAAAElFTkSuQmCC", "base64");
  const file = new File([rgbaPng], "透過.PNG");
  const imageSource = await exporter.convertImage(file, sourceImageFormat(file));
  assert.deepEqual(imageSource.image, { format: "PNG", width: 2, height: 3 });
  const native = await lib.PDFDocument.create();
  native.addPage([100, 200]);
  const nativeFile = new File([await native.save()], "document.pdf");
  const reader = { numPages: 1 };
  const sources = await exporter.loadExportSourcePdfs(new Map([
    [1, { ...imageSource, file, reader }], [2, { file: nativeFile, reader }],
  ]));
  const pages = [2, 1].map(sourcePdfId => ({ id: String(sourcePdfId), sourcePdfId, sourceIndex: 0, addedRotation: 0, annotations: [] }));
  const result = await lib.PDFDocument.load(await exporter.assembleOutputPdf(pages, sources));
  assert.deepEqual(result.getPages().map(page => page.getSize()), [{ width: 100, height: 200 }, { width: 1.5, height: 2.25 }]);
  const pdfName = lib.PDFName.of;
  const images = result.getPage(1).node.Resources().lookup(pdfName("XObject"), lib.PDFDict);
  assert(images.lookup(images.keys()[0]).dict.has(pdfName("SMask")));
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), rgbaPng);
});

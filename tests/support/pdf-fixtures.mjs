import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { createPdfExporter } from "../../src/js/pdf-export.mjs";

export const pdfLib = createRequire(import.meta.url)("../../src/vendor/cantoo-pdf-lib/pdf-lib.min.js");
export const fixture = name => new URL("../fixtures/" + name, import.meta.url);

export async function openFixture(input, fileName = "fixture.pdf") {
  const bytes = input instanceof URL ? await readFile(input) : input;
  const file = new File([bytes], input instanceof URL ? basename(input.pathname) : fileName, { type: "application/pdf" });
  const parsed = await pdfLib.PDFDocument.load(bytes, { password: "", updateMetadata: false });
  const reader = { numPages: parsed.getPageCount(), annotationStorage: { setValue() {} } };
  const exporter = createPdfExporter(pdfLib);
  const restored = await exporter.readSourceForEditing(file, reader);
  const sources = await exporter.loadExportSourcePdfs(new Map([[0, { file, reader, restoredAnnotations: restored.annotations }]]));
  let nextId = 0;
  const pages = Array.from({ length: reader.numPages }, (_, sourceIndex) => ({
    id: String(sourceIndex), sourcePdfId: 0, sourceIndex, addedRotation: 0,
    annotations: (restored.annotations.get(sourceIndex) ?? []).map(({ annotation }) => ({
      ...annotation, id: ++nextId,
      ...(annotation.kind === "external" ? { appearanceKey: `0:${annotation.externalRefId}` } : {}),
    })),
  }));
  return { bytes, pages, save: (selection = pages) => exporter.assembleOutputPdf(selection, sources) };
}

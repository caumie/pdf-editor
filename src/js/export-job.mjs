import { ExportSourceError } from "./pdf-export.mjs";
import { exportPageImage, ImageExportError } from "./image-export.mjs";

function cleanExportStem(value) {
  const stem = value.trim()
    .replace(/\.(pdf|zip|jpe?g|png)$/i, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/^[. ]+|[. ]+$/g, "");
  // 拡張子やページ番号を付けても、一般的なファイル名の長さ上限に収める。
  const encoder = new TextEncoder();
  let result = "";
  let bytes = 0;
  for (const char of stem) {
    bytes += encoder.encode(char).length;
    if (bytes > 224) break;
    result += char;
  }
  return result.trimEnd();
}

export function defaultExportName(pages, sources) {
  const ids = [...new Set(pages.map(page => page.sourcePdfId))].sort((a, b) => a - b);
  const stem = cleanExportStem(sources.get(ids[0])?.file.name ?? "") || "編集済み";
  return stem + (ids.length > 1 ? "+" + (ids.length - 1) : "") + "_edit";
}

export function exportTargetPages(pages, selectedIds, selectionOnly) {
  return selectionOnly ? pages.filter(page => selectedIds.has(page.id)) : pages;
}

export function createExportPlan(pages, selectedIds, sources, options) {
  const output = [...exportTargetPages(pages, selectedIds, options.selectionOnly)];
  const inputs = new Map(output.map(page => [page.sourcePdfId, sources.get(page.sourcePdfId)]));
  return {
    pages: output,
    sources: inputs,
    name: cleanExportStem(options.customName) || defaultExportName(output, sources),
    extension: options.extension,
    layout: options.extension === "pdf" && options.layout === "combined" ? "combined" : "zip",
    dpi: options.imageDpi,
    jpegQuality: options.jpegQuality,
    pdfSettings: options.pdfSettings ? structuredClone(options.pdfSettings) : undefined,
  };
}

function exportResultFilename(plan) {
  return plan.name + (plan.layout === "zip" ? ".zip" : ".pdf");
}

export function sameExportPlan(previous, next) {
  if (previous.name !== next.name || previous.layout !== next.layout || previous.extension !== next.extension
      || previous.pages.length !== next.pages.length || previous.sources.size !== next.sources.size) return false;
  if (next.extension === "pdf" ? JSON.stringify(previous.pdfSettings) !== JSON.stringify(next.pdfSettings)
    : previous.dpi !== next.dpi) return false;
  if (next.extension === "jpg" && previous.jpegQuality !== next.jpegQuality) return false;
  return previous.pages.every((page, index) => page === next.pages[index])
    && [...previous.sources].every(([id, source]) => next.sources.get(id) === source);
}

function exportPageName({ name, pages, extension }, index) {
  const digits = Math.max(2, String(pages.length).length);
  const number = String(index + 1).padStart(digits, "0");
  return name + "_" + number + "." + extension;
}

async function createPageArchive(fflate, plan, createFile, report) {
  const chunks = [];
  const archive = new fflate.Zip((error, chunk) => {
    if (error) throw error;
    if (chunk.length) chunks.push(chunk);
  });
  for (const [index, page] of plan.pages.entries()) {
    report("ZIPを作成中 " + (index + 1) + " / " + plan.pages.length);
    let blob;
    try {
      blob = await createFile([page]);
    } catch (error) {
      const detail = error instanceof ImageExportError || error instanceof ExportSourceError ? "\n" + error.message : "";
      throw new ExportSourceError("「" + exportPageName(plan, index) + "」を作成できませんでした。" + detail, { cause: error });
    }
    // PDF、JPEG、PNGはZIPにそのまま格納する。
    const entry = new fflate.ZipPassThrough(exportPageName(plan, index));
    archive.add(entry);
    entry.push(new Uint8Array(await blob.arrayBuffer()), true);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  archive.end();
  return new Blob(chunks, { type: "application/zip" });
}

export function createExportRunner(pdfExporter, fflate) {
  return async function runExportPlan(plan, output) {
    const { pages, sources, layout, extension, dpi } = plan;
    const report = output.report ?? (() => {});
    const image = extension !== "pdf";
    const inputPdfs = image ? null : await pdfExporter.loadExportSourcePdfs(sources);
    const createFile = image
      ? async ([page]) => {
        const source = sources.get(page.sourcePdfId);
        await source.externalRenderer?.prepare(page.annotations, dpi / 72);
        const sourcePage = await source.reader.getPage(page.sourceIndex + 1);
        return exportPageImage(sourcePage, page, plan);
      }
      : async outputPages => new Blob([await pdfExporter.assembleOutputPdf(outputPages, inputPdfs, plan.pdfSettings)], { type: "application/pdf" });

    if (layout === "zip") {
      output.download(await createPageArchive(fflate, plan, createFile, report), exportResultFilename(plan));
    } else {
      report("PDFを作成中…");
      output.download(await createFile(pages), exportResultFilename(plan));
    }
  };
}

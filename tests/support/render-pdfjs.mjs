import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DOMMatrix, ImageData, Path2D, createCanvas } from "@napi-rs/canvas";

// Load the same renderer and bundled resources as the app, without host fonts.
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
const vendor = new URL("../../src/vendor/pdfjs/", import.meta.url);
const pdfjs = await import(new URL("build/pdf.min.mjs", vendor));
pdfjs.GlobalWorkerOptions.workerSrc = new URL("build/pdf.worker.min.mjs", vendor).href;
const resource = name => fileURLToPath(new URL(name + "/", vendor));

export async function renderStats(bytes, selection) {
  const task = pdfjs.getDocument({
    data: Uint8Array.from(bytes),
    cMapUrl: resource("cmaps"), cMapPacked: true,
    standardFontDataUrl: resource("standard_fonts"), wasmUrl: resource("wasm"),
    useSystemFonts: false, isEvalSupported: false,
  });
  try {
    const document = await task.promise;
    const pages = [];
    for (const number of selection ?? Array.from({ length: document.numPages }, (_, i) => i + 1)) {
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d");
      try {
        await page.render({ canvasContext: ctx, viewport }).promise;
        const { width, height } = canvas;
        const hash = createHash("sha256").update(ctx.getImageData(0, 0, width, height).data).digest("hex");
        pages.push({ width, height, hash });
      } finally {
        canvas.width = canvas.height = 1;
        page.cleanup();
      }
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

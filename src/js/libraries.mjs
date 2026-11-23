// 配布形式ごとの違いは、ライブラリと補助データの取得方法に限る。
const libraryFiles = {
  "vendor-pdfjs": "pdfjs/build/pdf.min.mjs",
  "vendor-pdf-worker": "pdfjs/build/pdf.worker.min.mjs",
  "vendor-pdf-lib": "cantoo-pdf-lib/pdf-lib.min.js",
  "vendor-fflate": "fflate/index.js",
};

const pdfResourceDirectories = {
  cMapUrl: "cmaps",
  standardFontDataUrl: "standard_fonts",
  wasmUrl: "wasm",
};

function hasEmbeddedLibraries() {
  return document.getElementById("vendor-pdfjs") !== null;
}

function embeddedBytes(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error("同梱データが見つかりません " + id);
  const base64 = element.textContent.trim();
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(base64);
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

function vendorUrl(relativePath) {
  return new URL("./vendor/" + relativePath, document.baseURI).href;
}

function libraryUrl(id, embedded) {
  return embedded
    ? URL.createObjectURL(new Blob([embeddedBytes(id)], { type: "text/javascript" }))
    : vendorUrl(libraryFiles[id]);
}

export class PdfResources {
  async fetch({ kind, filename }) {
    if (!Object.hasOwn(pdfResourceDirectories, kind) || !/^[\w-][\w.-]*$/.test(filename)) {
      throw new Error("PDF.jsの補助データ名が無効です。");
    }
    if (hasEmbeddedLibraries()) return embeddedBytes("pdf-resource-" + kind + "-" + filename);

    const directory = pdfResourceDirectories[kind];
    const response = await fetch(vendorUrl("pdfjs/" + directory + "/" + filename));
    if (!response.ok) throw new Error("PDF.jsの補助データを読み込めません " + filename);
    return new Uint8Array(await response.arrayBuffer());
  }
}

function loadClassicScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.onload = resolve;
    script.onerror = () => reject(new Error("ライブラリを読み込めません " + url));
    document.head.append(script);
  });
}

export async function loadLibraries() {
  const embedded = hasEmbeddedLibraries();
  const startupUrls = [];
  try {
    for (const id of ["vendor-pdfjs", "vendor-pdf-lib", "vendor-fflate"]) {
      startupUrls.push(libraryUrl(id, embedded));
    }
    const [moduleUrl, pdfLibUrl, zipUrl] = startupUrls;
    const [pdfjs] = await Promise.all([
      import(moduleUrl),
      loadClassicScript(pdfLibUrl),
      loadClassicScript(zipUrl),
    ]);
    const { PDFLib: pdfLib, fflate } = window;
    if (!pdfLib || !fflate) throw new Error("ライブラリの初期化に失敗しました。");
    pdfjs.GlobalWorkerOptions.workerSrc = libraryUrl("vendor-pdf-worker", embedded);
    return { pdfjs, pdfLib, fflate };
  } finally {
    if (embedded) startupUrls.forEach(url => URL.revokeObjectURL(url));
  }
}

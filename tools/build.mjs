// Build the standalone HTML without changing the separately publishable src/ tree.
import { Buffer } from "node:buffer";
import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const src = new URL("src/", root);
const vendor = new URL("vendor/", src);
const output = new URL("dist/pdf-editor.html", root);
const read = (file, base = src) => readFileSync(new URL(file, base), "utf8").replace(/\r\n?/g, "\n");
const entry = '<script type="module" src="./js/editor.mjs"></script>';
const serverCsp = "script-src 'self' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self';";
const offlineCsp = "script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline'; worker-src blob:;";
const moduleImport = /^import \{ (\w+(?:, \w+)*) \} from "\.\/([\w-]+\.mjs)";$/;
const moduleExport = /^export (?:async function|function|class|const) (\w+)/;
const libraries = {
  "vendor-pdfjs": "pdfjs/build/pdf.min.mjs",
  "vendor-pdf-worker": "pdfjs/build/pdf.worker.min.mjs",
  "vendor-pdf-lib": "cantoo-pdf-lib/pdf-lib.min.js",
  "vendor-fflate": "fflate/index.js",
};
// These names are shared with src/js/libraries.mjs. Embed CMaps, fonts and WASM
// as data, so opening the standalone file never needs a network request.
const resourcePatterns = {
  cMapUrl: ["cmaps", "*.bcmap"],
  standardFontDataUrl: ["standard_fonts", "*"],
  wasmUrl: ["wasm", "*.wasm"],
};

function inlineModules(start) {
  const pending = new Set();
  const identifiers = new Map();
  const modules = [];
  function visit(name) {
    if (identifiers.has(name)) return identifiers.get(name);
    if (pending.has(name)) throw new Error("循環するモジュール: " + name);
    pending.add(name);
    const imports = [], exports = [], body = [];
    for (const line of read("js/" + name).split("\n")) {
      const match = moduleImport.exec(line);
      if (match) imports.push(`const { ${match[1]} } = ${visit(match[2])};`);
      else if (/^\s*import\s+(?!\()/.test(line)) throw new Error("ビルド対象外の import: " + name);
      else if (line.startsWith("export ")) {
        const declaration = moduleExport.exec(line);
        if (!declaration) throw new Error("ビルド対象外の export: " + name);
        exports.push(declaration[1]);
        body.push(line.slice(7));
      } else body.push(line);
    }
    pending.delete(name);
    const id = "_pdfEditorModule" + modules.length;
    identifiers.set(name, id);
    // Preserve each module's scope without adding a bundler or changing the readable source.
    const prefix = exports.length ? `const ${id} = ` : "";
    const suffix = exports.length ? ["", `return { ${exports.join(", ")} };`] : [];
    const code = [...imports, "", body.join("\n").trim(), ...suffix].join("\n").trim();
    modules.push(`// src/js/${name}\n${prefix}(() => {\n${code}\n})();`);
    return id;
  }
  visit(start);
  return modules.join("\n\n");
}

function script(type, id, content) {
  if (/<\/script/i.test(content)) throw new Error("インライン化できないスクリプト: " + (id ?? "editor"));
  const attribute = id ? ` id="${id}"` : "";
  return `<script type="${type}"${attribute}>\n${content}\n</script>`;
}

function embeddedVendor() {
  const files = { ...libraries };
  for (const [kind, [directory, pattern]] of Object.entries(resourcePatterns)) {
    const cwd = new URL(`pdfjs/${directory}/`, vendor);
    for (const file of globSync(pattern, { cwd, withFileTypes: true }).filter(item => item.isFile()).map(item => item.name).sort()) {
      files[`pdf-resource-${kind}-${file}`] = `pdfjs/${directory}/${file}`;
    }
  }
  const tags = [script("text/plain", "vendor-licenses", read("LICENSES.txt", vendor).trim())];
  for (const [id, file] of Object.entries(files)) {
    const encoded = readFileSync(new URL(file, vendor)).toString("base64");
    tags.push(script("application/octet-stream", id, (encoded.match(/.{1,120}/g) ?? []).join("\n")));
  }
  return tags.join("\n");
}

function replaceOnce(html, marker, replacement) {
  if (html.split(marker).length !== 2) throw new Error("差し替え箇所を特定できません: " + marker);
  // A replacement callback preserves literal dollars in the bundled source.
  return html.replace(marker, () => replacement);
}

let html = read("index.html");
const iconPath = "./pdf-editor.svg";
const iconUrl = "data:image/svg+xml;base64," + readFileSync(new URL(iconPath, src)).toString("base64");
html = replaceOnce(html, `href="${iconPath}"`, `href="${iconUrl}"`);
html = replaceOnce(html, `src="${iconPath}"`, `src="${iconUrl}"`);
html = html.replace(/<link rel="stylesheet" href="\.\/(css\/[\w-]+\.css)">/g, (_, file) => {
  const css = read(file).trim();
  if (/<\/style/i.test(css)) throw new Error("インライン化できないスタイル: " + file);
  return `<style>\n${css}\n</style>`;
});
html = replaceOnce(html, entry, script("module", null, inlineModules("editor.mjs")));
html = replaceOnce(html, serverCsp, offlineCsp);
html = replaceOnce(html, "img-src 'self' blob: data:;", "img-src blob: data:;");
html = replaceOnce(html, "</body>", `<!-- 外部ライブラリと補助データ -->\n${embeddedVendor()}\n</body>`);
const result = Buffer.from(html);
if (process.argv.includes("--check")) {
  if (!existsSync(output) || !readFileSync(output).equals(result)) {
    throw new Error("dist/pdf-editor.html を npm run build で再生成してください。");
  }
} else {
  mkdirSync(new URL("./", output), { recursive: true });
  writeFileSync(output, result);
}
console.log(fileURLToPath(output));

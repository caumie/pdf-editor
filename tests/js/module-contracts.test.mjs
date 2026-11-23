import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const js = new URL("../../src/js/", import.meta.url);
const html = await fs.readFile(new URL("../../src/index.html", import.meta.url), "utf8");

test("分割モジュールの名前付きimportは、単一HTMLの偶然の同名関数に頼らず解決する", async () => {
  const files = (await fs.readdir(js)).filter(file => file.endsWith(".mjs"));
  for (const file of files) {
    const source = await fs.readFile(new URL(file, js), "utf8");
    for (const match of source.matchAll(/^import \{ ([\w, ]+) \} from "(\.\/[\w-]+\.mjs)";$/gm)) {
      const exports = await import(new URL(match[2], js));
      for (const name of match[1].split(", ")) assert(name in exports, file + " imports missing " + name);
    }
  }
});
test("画面IDは重複せず、ラベルと固定UI参照はすべて実在する", async () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const [, references] of html.matchAll(/\s(?:for|aria-labelledby|aria-describedby|aria-controls)="([^"]+)"/g)) {
    for (const id of references.split(/\s+/)) assert(ids.includes(id), "Missing label or control target: " + id);
  }
  for (const file of (await fs.readdir(js)).filter(file => file.endsWith(".mjs"))) {
    const source = await fs.readFile(new URL(file, js), "utf8");
    for (const match of source.matchAll(/\bui(?:\["([^"]+)"\]|\.([A-Za-z]\w*))/g)) {
      assert(ids.includes(match[1] ?? match[2]), file + ": missing UI element: " + (match[1] ?? match[2]));
    }
  }
});

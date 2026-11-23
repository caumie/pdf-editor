import assert from "node:assert/strict";
import test from "node:test";
import { loadDrawingStyles, normalizeDrawingStyle, saveDrawingStyles } from "../../src/js/drawing-styles.mjs";
import { annotationFillOpacity } from "../../src/js/annotations.mjs";
import { clearSavedEditorSettings } from "../../src/js/settings-storage.mjs";

test("設定値は色・数値・真偽を検証し、古い版の未知ツールでも起動を妨げない", () => {
  const pen = normalizeDrawingStyle("pen", { width: 1000, color: "invalid", strokeTransparency: -10 });
  assert.equal(pen.width, 24); assert.equal(pen.color, "#ff0000"); assert.equal(pen.strokeTransparency, 0);
  const highlight = normalizeDrawingStyle("highlight", { color: "#ABCDEF", fillTransparency: 55 }, true);
  assert.equal(highlight.color, "#abcdef"); assert.equal(highlight.fillTransparency, 55);
});
test("設定は旧版から読み戻せ、保存領域が使えない場合も初期値で起動する", () => {
  const data = new Map([["pdf-page-editor.styles.v1", JSON.stringify({ pen: { width: 7 }, highlight: { color: "#abcdef" } })]]);
  globalThis.window = { localStorage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) } };
  const loaded = loadDrawingStyles(); assert.equal(loaded.pen.width, 7); assert.equal(loaded.highlight.color, "#abcdef");
  saveDrawingStyles(loaded); assert(data.has("pdf-page-editor.styles.v3"));
  window.localStorage.getItem = () => { throw Error("blocked"); };
  assert.equal(loadDrawingStyles().text.size, 12);
});

test("初期化後の直線は矢印付き、矩形の塗りは完全に透明になる", () => {
  const values = new Map([["pdf-page-editor.styles.v3", JSON.stringify({
    line: { arrowEnd: false }, rect: { useFillTransparency: false, fillTransparency: 70 },
  })]]);
  const storage = {
    get length() { return values.size; },
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => values.delete(key),
  };
  globalThis.window = { localStorage: storage };
  const saved = loadDrawingStyles();
  assert.equal(saved.line.arrowEnd, false);
  assert.equal(annotationFillOpacity(saved.rect), 1);
  clearSavedEditorSettings(storage);
  const defaults = loadDrawingStyles();
  assert.equal(defaults.line.arrowEnd, true);
  assert.equal(defaults.rect.useFillTransparency, true);
  assert.equal(defaults.rect.fillTransparency, 100);
  assert.equal(annotationFillOpacity(defaults.rect), 0);
});

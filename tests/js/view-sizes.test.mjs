import assert from "node:assert/strict";
import test from "node:test";
import { loadViewPreferences, saveViewPreferences } from "../../src/js/view-sizes.mjs";

test("サムネイルサイズと書き込みツールの開閉だけを復元し、古い倍率の設定は取り除く", () => {
  const storage = new Map();
  const storageKey = "pdf-page-editor.view-sizes";
  globalThis.window = { localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  } };
  assert.deepEqual(loadViewPreferences(), { thumbnailSize: "medium", toolsVisible: false });
  saveViewPreferences("large", true);
  assert.deepEqual(loadViewPreferences(), { thumbnailSize: "large", toolsVisible: true });
  saveViewPreferences("large", false);
  assert.deepEqual(loadViewPreferences(), { thumbnailSize: "large", toolsVisible: false });
  storage.set(storageKey, '{"thumbnailSize":"small","previewZoom":0.6}');
  assert.deepEqual(loadViewPreferences(), { thumbnailSize: "small", toolsVisible: false });
  assert.deepEqual(JSON.parse(storage.get(storageKey)), { thumbnailSize: "small", toolsVisible: false });
  Object.defineProperty(window, "localStorage", { get() { throw new Error("storage disabled"); } });
  assert.doesNotThrow(() => saveViewPreferences("small", true));
  assert.deepEqual(loadViewPreferences(), { thumbnailSize: "medium", toolsVisible: false });
});

import assert from "node:assert/strict";
import test from "node:test";
import { createDownloadPanel } from "../../src/js/download-panel.mjs";
import { createExportPlan } from "../../src/js/export-job.mjs";

class Control extends EventTarget {
  value = ""; hidden = false; disabled = false; options = [{}];
  attrs = new Map();
  setAttribute(key, value) { this.attrs.set(key, value); }
  focus() { this.focused = true; }
  contains(target) { return target === this; }
}

function fixture() {
  const controls = new Map();
  const ui = new Proxy({}, { get(_, id) {
    if (!controls.has(id)) controls.set(id, new Control());
    return controls.get(id);
  } });
  ui["export-format"].value = "pdf";
  ui["export-scope"].value = "all";
  ui["jpeg-dpi"].value = "150";
  ui["export-form"].hidden = true;
  const downloads = [];
  const doc = new Control();
  doc.body = { append() {} };
  doc.createElement = () => ({ click() { downloads.push([this.href, this.download]); }, remove() {} });
  globalThis.document = doc;
  const state = { pages: [{ id: "page1", sourcePdfId: 1 }, { id: "page2", sourcePdfId: 1 }], selectedIds: new Set(),
    sources: new Map([[1, { file: { name: "sample.pdf" } }]]), available: true };
  const settings = { userPasswordEnabled: false, userPassword: "" };
  let submissions = 0;
  const panel = createDownloadPanel(ui, { update() {}, settings: () => settings },
    () => state, event => { event.preventDefault(); submissions++; });
  const change = (id, value) => {
    ui[id].value = value;
    const event = new Event("change"); Object.defineProperty(event, "target", { value: ui[id] });
    ui["export-form"].dispatchEvent(event);
  };
  return { panel, ui, state, settings, downloads, change, submissions: () => submissions };
}

test("保存形式を往復してもPDFのまとめ方を保ち、対象数と操作可否は現在の文書から読む", () => {
  const { panel, ui, state, settings, change } = fixture();
  panel.update();
  assert.equal(ui["output-name"].placeholder, "sample_edit.pdf");
  assert.equal(ui["export-menu-count"].textContent, "書き出し対象 2ページ");
  assert.equal(ui["export-submit"].disabled, false);
  change("export-layout", "zip");
  change("export-format", "jpg");
  assert.equal(ui["jpeg-dpi"].hidden, false);
  assert.equal(ui["export-layout"].options[0].hidden, true);
  assert.equal(panel.options().layout, "zip");
  change("export-format", "pdf");
  assert.equal(panel.options().layout, "zip");
  assert.equal(ui["jpeg-dpi"].hidden, true);
  change("export-scope", "selected");
  assert.equal(ui["export-submit"].disabled, true);
  state.selectedIds.add("page1"); panel.update();
  assert.equal(ui["export-submit"].disabled, false);
  assert.equal(ui["export-menu-count"].textContent, "書き出し対象 1ページ");
  assert.equal(panel.options().pdfSettings, settings);
  state.available = false; panel.update();
  assert.equal(ui["export-menu-toggle"].disabled, true);
  assert.equal(ui["export-submit"].disabled, true);
});

test("開閉・送信・進捗とリセットを扱い、クリア後は初期の保存設定に戻る", () => {
  const { panel, ui, change, submissions } = fixture();
  ui["export-menu-toggle"].dispatchEvent(new Event("click"));
  assert.equal(ui["export-form"].hidden, false);
  assert.equal(ui["export-scope"].focused, true);
  assert.equal(ui["export-menu-toggle"].attrs.get("aria-expanded"), "true");
  ui["export-form"].dispatchEvent(new Event("submit", { cancelable: true }));
  assert.equal(submissions(), 1);
  panel.setOpen(false, true);
  assert.equal(ui["export-menu-toggle"].focused, true);
  panel.setProgress(true);
  assert.equal(ui["export-spinner"].hidden, false);
  assert.equal(ui["export-menu-label"].textContent, "書き出し中…");
  panel.setProgress(false);
  assert.equal(ui["export-spinner"].hidden, true);
  change("export-layout", "zip");
  change("export-format", "jpg");
  ui["output-name"].value = "changed";
  panel.reset();
  assert.equal(ui["export-form"].hidden, true);
  assert.equal(panel.options().extension, "pdf");
  assert.equal(panel.options().layout, "combined");
  assert.equal(panel.options().customName, "");
  assert.equal(panel.options().jpegDpi, 150);
});

test("同じ書き出し設定と文書では再利用し、ファイル名・編集・設定が変われば新しく書き出す", () => {
  const { panel, state, settings, downloads } = fixture();
  const plan = () => createExportPlan(state.pages, state.selectedIds, state.sources, panel.options());
  const originalRevoke = URL.revokeObjectURL;
  const revoked = [];
  URL.revokeObjectURL = url => { revoked.push(url); originalRevoke(url); };
  try {
    panel.save(plan(), new Blob(["first"]), "sample_edit.pdf");
    const firstUrl = downloads[0][0];
    assert.equal(panel.reuse(plan()), true);
    assert.deepEqual(downloads[1], [firstUrl, "sample_edit.pdf"]);
    assert.equal(panel.reuse({ ...plan(), name: "another" }), false);
    assert.equal(panel.reuse({ ...plan(), layout: "zip" }), false);
    settings.userPasswordEnabled = true;
    settings.userPassword = "different";
    assert.equal(panel.reuse(plan()), false);
    settings.userPasswordEnabled = false;
    settings.userPassword = "";
    state.pages[0] = { ...state.pages[0], addedRotation: 90 };
    assert.equal(panel.reuse(plan()), false);
    panel.save(plan(), new Blob(["second"]), "second.pdf");
    const secondUrl = downloads[2][0];
    assert.notEqual(firstUrl, secondUrl);
    assert.deepEqual(revoked, [firstUrl]);
    panel.reset();
    assert.deepEqual(revoked, [firstUrl, secondUrl]);
    assert.equal(panel.reuse(plan()), false);
    assert.equal(downloads.length, 3);
  } finally { URL.revokeObjectURL = originalRevoke; }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createDocumentPropertiesUi } from "../../src/js/document-properties-panel.mjs";
import { normalizePdfPermissions, pdfPermissionFields } from "../../src/js/pdf-properties.mjs";
import { createUnsavedChangesGuard } from "../../src/js/unsaved-changes.mjs";

// DOMの表示寸法ではなく、画面設定と文書情報の状態遷移を確認する。
class Element extends EventTarget {
  children = []; value = ""; checked = false; disabled = false; hidden = false; textContent = "";
  style = { setProperty(key, value) { this[key] = value; } };
  focus() { this.focused = true; }
  append(...children) { this.children.push(...children); }
  setAttribute() {}
  replaceChildren(...children) { this.children = children; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const html = fs.readFileSync(new URL("../../src/index.html", import.meta.url), "utf8");
function fixture() {
  globalThis.document = { createElement: () => new Element(), createTextNode: value => ({ textContent: value }) };
  const ui = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  ui["export-format"].value = "pdf"; ui["export-layout"].value = "combined";
  const source = name => ({ file: { name, size: 1024 }, reader: { numPages: 1 }, properties: {
    info: { CreationDate: "D:20200102030405Z", EncryptFilterName: "Standard" }, title: name + "のタイトル", author: "元の著者", subject: "件名", keywords: "語句",
    notes: "元の備考", version: "1.7", metadataKnown: true, permissionsKnown: true, encrypted: true,
    permissions: { ...normalizePdfPermissions(null), annotating: false },
  } });
  const sources = new Map([[1, source("first.pdf")]]);
  let pages = [{ sourcePdfId: 1 }], available = true;
  const panel = createDocumentPropertiesUi(ui, () => sources, () => pages, () => available);
  panel.setOutputVersions({ plain: "1.7", encrypted: "1.7 拡張レベル8" });
  panel.initializeSource(sources.get(1));
  return { ui, panel, sources, source, pages: value => { pages = value; }, available: value => { available = value; } };
}

test("タイトルは最初のPDF、権限は全許可で初期化し、手入力後は原稿追加や削除で上書きしない", () => {
  const { panel, ui, sources, source, pages } = fixture();
  assert.equal(panel.settings().title, "first.pdfのタイトル"); assert.equal(panel.settings().author, "");
  assert.deepEqual(panel.settings().permissions, normalizePdfPermissions(null));
  const annotationPermission = ui["pdf-permissions"].children[pdfPermissionFields.findIndex(field => field.key === "annotating")].children[0];
  annotationPermission.checked = false; annotationPermission.dispatchEvent(new Event("change"));
  ui["pdf-title"].value = "自分で指定"; ui["pdf-author"].value = "自分の名前";
  sources.set(2, source("second.pdf")); panel.initializeSource(sources.get(2));
  pages([{ sourcePdfId: 2 }, { sourcePdfId: 1 }]); panel.update();
  assert.equal(panel.settings().title, "自分で指定"); assert.equal(panel.settings().author, "自分の名前");
  assert.equal(panel.settings().notes, "元の備考\n\n結合元PDF：\nfirst.pdf\nsecond.pdf");
  sources.delete(1); pages([{ sourcePdfId: 2 }]); panel.update();
  assert.equal(panel.settings().title, "自分で指定"); assert.equal(panel.settings().permissions.annotating, false);
});

test("備考を編集した後は自動生成で上書きせず、パスワードはオフで無視・解除時に消去する", () => {
  const { panel, ui, sources, source, pages } = fixture();
  ui["pdf-notes"].value = "任意の備考"; ui["pdf-notes"].dispatchEvent(new Event("input"));
  sources.set(2, source("second.pdf")); pages([{ sourcePdfId: 1 }, { sourcePdfId: 2 }]); panel.update();
  assert.equal(panel.settings().notes, "任意の備考");
  ui["pdf-user-password"].value = "disabled-value";
  assert.equal(panel.settings().userPassword, ""); assert(!("ownerPassword" in panel.settings()));
  const toggle = ui["pdf-user-password-enabled"];
  toggle.checked = true; panel.update();
  assert.equal(ui["pdf-user-password"].disabled, false);
  assert.equal(panel.settings().userPassword, "disabled-value");
  toggle.checked = false;
  const event = new Event("change"); Object.defineProperty(event, "target", { value: toggle });
  ui["pdf-output-settings"].dispatchEvent(event);
  assert.equal(ui["pdf-user-password"].value, ""); assert.equal(ui["pdf-user-password"].disabled, true);
  panel.reset(); assert.equal(panel.settings().title, ""); assert.equal(panel.settings().author, "");
  assert.equal(panel.settings().userPasswordEnabled, false);
});

test("元PDF情報は複数ファイルを比較表示し、JPEGではPDFの設定を隠す", () => {
  const { panel, ui, sources, source, available } = fixture();
  sources.set(2, source("<second>.pdf"));
  ui["source-properties"].dispatchEvent(new Event("click"));
  assert.equal(ui["source-properties-dialog"].open, true);
  const table = ui["source-properties-content"].children[0];
  assert.equal(table.children[1].children[0].children[2].textContent, "<second>.pdf");
  assert(table.children[2].children.some(row => row.children[0].textContent === "注釈の追加・変更"));
  ui["export-format"].value = "jpg"; panel.update();
  assert.equal(ui["pdf-output-settings"].hidden, true);
  available(false); panel.update(); assert.equal(ui["source-properties"].disabled, true);
});


test("プリセットを使わず権限を個別編集でき、パスワード設定は独立して保持する", () => {
  const { panel, ui } = fixture();
  const permissionInputs = ui["pdf-permissions"].children.map(label => label.children[0]);
  assert(!html.includes('id="pdf-permission-preset"'));
  assert(permissionInputs.every(input => input.checked && !input.disabled));
  ui["pdf-user-password-enabled"].checked = true;
  ui["pdf-user-password"].value = "keep-user";
  assert(!html.includes('id="pdf-owner-password"'));
  const change = (key, checked) => {
    const input = permissionInputs[pdfPermissionFields.findIndex(field => field.key === key)];
    input.checked = checked; input.dispatchEvent(new Event("change"));
  };
  change("printing", false);
  assert.equal(panel.settings().permissions.highQualityPrinting, false);
  change("highQualityPrinting", true);
  assert.equal(panel.settings().permissions.printing, true);
  change("annotating", false);
  assert.equal(panel.settings().permissions.annotating, false);
  assert.equal(panel.settings().userPassword, "keep-user");
  assert(!("ownerPasswordEnabled" in panel.settings()));
});

test("元PDFの権限に関係なく全許可で初期化し、プロパティと権限は折りたたむ", () => {
  const { panel, ui, sources } = fixture();
  for (const original of [normalizePdfPermissions(null), normalizePdfPermissions([4, 2048, 512]), normalizePdfPermissions([])]) {
    panel.reset();
    const source = sources.get(1);
    source.properties.permissions = original;
    panel.initializeSource(source);
    assert.deepEqual(panel.settings().permissions, normalizePdfPermissions(null));
    assert.deepEqual(source.properties.permissions, original);
    assert.equal(ui["pdf-metadata-details"].open, false);
    assert.equal(ui["pdf-permission-details"].open, false);
    assert.equal(panel.settings().userPasswordEnabled, false);
    assert(!("ownerPasswordEnabled" in panel.settings()));
  }
});

test("プロパティと権限の展開状態は通常更新で変わらず、パスワードも消さない", () => {
  const { panel, ui } = fixture();
  ui["pdf-metadata-details"].open = true;
  ui["pdf-permission-details"].open = true;
  ui["pdf-user-password-enabled"].checked = true;
  ui["pdf-user-password"].value = "keep";
  panel.update();
  assert.equal(ui["pdf-metadata-details"].open, true);
  assert.equal(ui["pdf-permission-details"].open, true);
  ui["pdf-permission-details"].open = false;
  panel.update();
  assert.equal(ui["pdf-permission-details"].open, false);
  assert.equal(panel.settings().userPassword, "keep");
});

test("対象ページによる自動備考の変化は未保存扱いにせず、手入力のプロパティ変更は検出する", () => {
  const { panel, ui, sources, source, pages } = fixture();
  sources.set(2, source("second.pdf"));
  const documentPages = [{ sourcePdfId: 1 }, { sourcePdfId: 2 }];
  pages(documentPages); panel.update();
  const guard = createUnsavedChangesGuard(new EventTarget(), () => ({ pages: documentPages, settings: panel.revisionSettings() }));
  pages([documentPages[0]]); panel.update();
  assert.equal(guard.hasChanges(), false);
  ui["pdf-title"].value = "edited";
  assert.equal(guard.hasChanges(), true);
  guard.markSaved();
  ui["pdf-notes"].value = "explicit notes";
  ui["pdf-notes"].dispatchEvent(new Event("input"));
  assert.equal(guard.hasChanges(), true);
});

test("10・20ファイルの比較表は全列・全項目を持ち、再表示時にスクロールを先頭へ戻す", () => {
  const { ui, sources, source } = fixture();
  for (const count of [10, 20]) {
    sources.clear();
    for (let index = 1; index <= count; index++) sources.set(index, source("文書" + index + ".pdf"));
    ui["source-properties-content"].scrollTop = 300;
    ui["source-properties-content"].scrollLeft = 1200;
    ui["source-properties"].dispatchEvent(new Event("click"));
    const table = ui["source-properties-content"].children[0];
    const [columns, head, body] = table.children;
    assert.equal(columns.children.length, count + 1);
    assert.equal(head.children[0].children.length, count + 1);
    assert.equal(head.children[0].children[count].textContent, "文書" + count + ".pdf");
    assert(body.children.length >= 20);
    assert(body.children.every(row => row.children.length === count + 1));
    assert.equal(table.style.width, (112 + 176 * count) + "px");
    assert.equal(columns.children[0].style.width, "112px");
    assert.equal(columns.children[count].style.width, "176px");
    assert.equal(ui["source-properties-content"].scrollLeft, 0);
    assert.equal(ui["source-properties-content"].scrollTop, 0);
    assert.equal(ui["source-properties-content"].focused, true);
    assert.equal(ui["source-properties-count"].textContent, count + "ファイル");
  }
});


test("生成後に取得したバージョンを表示し、元PDFの宣言や更新日時を転記しない", () => {
  const { panel, ui, sources } = fixture();
  sources.get(1).properties.version = "2.0";
  panel.setOutputVersions({ plain: "1.7", encrypted: "1.7 拡張レベル8" });
  assert.equal(ui["pdf-version"].value, "1.7");
  assert.equal(ui["pdf-modification-date"].value, "<保存時に設定>");
  ui["pdf-user-password-enabled"].checked = true;
  ui["pdf-user-password"].value = "reader";
  panel.update();
  assert.equal(ui["pdf-version"].value, "1.7 拡張レベル8");
  ui["pdf-user-password-enabled"].checked = false;
  panel.update();
  assert.equal(ui["pdf-version"].value, "1.7");
  // 生成ライブラリ側の結果が変われば、UIはその値を使う。
  panel.setOutputVersions({ plain: "2.0", encrypted: "2.0" });
  assert.equal(ui["pdf-version"].value, "2.0");
});

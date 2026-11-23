import { test, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture, pdfLib } from "../support/pdf-fixtures.mjs";

const app = new URL("../../dist/pdf-editor.html", import.meta.url);
const staticRoot = fileURLToPath(new URL("../../src/", import.meta.url));
const mime = {
  ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript",
  ".css": "text/css", ".wasm": "application/wasm",
};
const input = page => page.locator("#file-input");
const cards = page => page.locator("#page-grid .page-card");
const download = page => page.locator("#export-menu-toggle");
const banner = page => page.locator("#editor-toast");
const message = page => page.locator("#toast-message");

async function openApp(page, url = app.href) {
  await page.goto(url);
  await expect(page.locator("#add-files")).toBeEnabled();
}

async function documentFile(name, { width = 240, password, field, script, invalidAnnots } = {}) {
  const doc = await pdfLib.PDFDocument.create();
  const pdfPage = doc.addPage([width, 300]);
  pdfPage.drawText("Synthetic browser fixture", { x: 12, y: 255, size: 13 });
  if (field) {
    const value = doc.getForm().createTextField(field);
    value.setText(name);
    value.addToPage(pdfPage, { x: 20, y: 180, width: 160, height: 18 });
  }
  if (script) doc.catalog.set(pdfLib.PDFName.of("Names"), doc.context.obj({ JavaScript: {
    Names: [pdfLib.PDFString.of("synthetic"), { S: "JavaScript", JS: pdfLib.PDFString.of("") }],
  } }));
  if (invalidAnnots) pdfPage.node.set(pdfLib.PDFName.of("Annots"), doc.context.register(doc.context.obj({})));
  if (password) doc.encrypt({ algorithm: "AES-256", userPassword: password, ownerPassword: "synthetic-owner" });
  return { name, mimeType: "application/pdf", buffer: Buffer.from(await doc.save()) };
}

async function save(page) {
  const completed = page.waitForEvent("download");
  await page.locator("#export-submit").click();
  const result = await completed;
  return { name: result.suggestedFilename(), bytes: await readFile(await result.path()) };
}

for (const mode of ["standalone", "static"]) {
  test(`起動・読込・書き出し: ${mode}`, async ({ page }) => {
    if (mode === "standalone") {
      await page.context().setOffline(true);
      await openApp(page);
    } else {
      // Simulate a static host at a subpath. No web server is shipped or needed for this test.
      const base = "https://pdf-editor.test/tool/";
      await page.context().route(base + "**", async route => {
        const relative = new URL(route.request().url()).pathname.slice("/tool/".length);
        const path = resolve(staticRoot, relative || "index.html");
        if (!path.startsWith(staticRoot.endsWith(sep) ? staticRoot : staticRoot + sep)) return route.abort();
        await route.fulfill({ path, contentType: mime[extname(path)] ?? "application/octet-stream" });
      });
      await openApp(page, base);
    }
    const source = fixture("annotations/embedded-font-annotation.pdf");
    await input(page).setInputFiles(fileURLToPath(source));
    await expect(page.locator("#preview-sheet")).toBeVisible();
    await download(page).click();
    const result = await save(page);
    const original = await pdfLib.PDFDocument.load(await readFile(source));
    const doc = await pdfLib.PDFDocument.load(result.bytes);
    assert.equal(doc.getPageCount(), original.getPageCount());
    for (const [i, saved] of doc.getPages().entries()) {
      assert.equal(saved.node.Annots()?.size(), original.getPage(i).node.Annots()?.size());
    }
    await expect(banner(page)).toBeHidden();
  });
}

for (const [width, height] of [[1220, 800], [390, 600]]) {
  test(`注意とエラーは作業領域を動かさない: ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openApp(page);
    const layout = () => page.locator("#workspace").boundingBox();
    const invalid = { name: "invalid.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a PDF") };
    const before = await layout();
    await input(page).setInputFiles(invalid);
    await expect(banner(page)).toHaveClass("editor-toast error");
    assert.deepEqual(await layout(), before);
    await page.locator("#dismiss-toast").click();
    assert.deepEqual(await layout(), before);

    await input(page).setInputFiles(await documentFile("first.pdf", { field: "customer", script: true }));
    await expect(message(page)).toContainText("フォーム");
    await expect(message(page)).toContainText("スクリプト");
    await input(page).setInputFiles(await documentFile("second.pdf", { field: "customer" }));
    await expect(message(page)).toContainText("「customer」：first.pdf、second.pdf");
    await expect(cards(page)).toHaveCount(2);
    const visible = await layout();
    await message(page).focus();
    await page.keyboard.press("Delete");
    await expect(cards(page)).toHaveCount(2);
    await page.locator("#dismiss-toast").click();
    assert.deepEqual(await layout(), visible);
    await expect(download(page)).toBeFocused();
    await download(page).click();
    await page.locator("#export-layout").selectOption("zip");
    assert.match((await save(page)).name, /\.zip$/);
    await expect(banner(page)).toBeHidden();
  });
}

test("書き出し失敗はトーストで伝え、編集画面を使い続けられる", async ({ page }) => {
  await openApp(page);
  await input(page).setInputFiles(await documentFile("invalid-annots.pdf", { invalidAnnots: true }));
  await download(page).click();
  await page.locator("#export-submit").click();
  await expect(banner(page)).toHaveClass("editor-toast error");
  await expect(message(page)).toContainText("書き出しに失敗しました");
  await expect(message(page)).toContainText("注釈一覧を読み取れません");
  await expect(cards(page)).toHaveCount(1);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(download(page)).toBeEnabled();
});

for (const width of [1220, 320]) {
  test(`進捗は読み込み中だけ表示し、入力・キャンセル後に消える: ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await openApp(page);
    const heading = page.locator("#pages-panel > header");
    const count = heading.locator("#page-import-count");
    const filename = heading.locator("#page-import-filename");
    const before = await heading.boundingBox();
    await expect(count).toBeEmpty();
    const firstName = "first-" + "long".repeat(40) + ".pdf";
    await input(page).setInputFiles([
      await documentFile(firstName, { password: "reader-pass" }),
      await documentFile("second.pdf", { password: "other-pass" }),
    ]);
    const password = page.locator("#source-password");
    await expect(password).toBeFocused();
    await expect(count).toHaveText("読み込み中 1/2件");
    await expect(filename).toHaveText(firstName);
    const indicator = await count.boundingBox();
    assert(indicator.width > 0 && indicator.x + indicator.width <= before.x + before.width);
    assert.deepEqual(await heading.boundingBox(), before);
    await password.fill("reader-pass");
    await password.press("Enter");
    await expect(count).toHaveText("読み込み中 2/2件");
    await expect(filename).toHaveText("second.pdf");
    await expect(password).toBeFocused();
    await password.press("Escape");
    await expect(page.locator("#source-password-dialog")).toBeHidden();
    await expect(cards(page)).toHaveCount(1);
    await expect(count).toBeEmpty();
    await expect(filename).toBeEmpty();
    assert.deepEqual(await heading.boundingBox(), before);
  });
}

test("選択ページのファイル名と出力内容が一致する", async ({ page }) => {
  await openApp(page);
  await input(page).setInputFiles([
    await documentFile("A.pdf", { width: 100 }),
    await documentFile("B.pdf", { width: 200 }),
  ]);
  await expect(cards(page)).toHaveCount(2);
  await page.locator(".page-pick").nth(1).click();
  await download(page).click();
  await page.locator("#export-scope").selectOption("selected");
  await expect(page.locator("#output-name")).toHaveAttribute("placeholder", "B_edit.pdf");
  const result = await save(page);
  assert.equal(result.name, "B_edit.pdf");
  const doc = await pdfLib.PDFDocument.load(result.bytes);
  assert.deepEqual(doc.getPages().map(p => p.getWidth()), [200]);
});

test("高さの限られた画面でも書き込みツールを開ける", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 220 });
  await openApp(page);
  await input(page).setInputFiles(fileURLToPath(fixture("regression/rich-boxes.pdf")));
  await expect(cards(page)).toHaveCount(4);
  await page.locator("#preview-tools-toggle").click();
  await expect(page.locator("#preview-edit-bars")).toBeVisible();
});

test("画面で追加した矩形がPDFの注釈として出力される", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await openApp(page);
  await input(page).setInputFiles(await documentFile("drawing.pdf"));
  await expect(page.locator("#preview-sheet")).toBeVisible();
  await page.locator("#preview-tools-toggle").click();
  await page.locator('[data-tool="rect"]').click();
  const overlay = await page.locator("#preview-overlay").boundingBox();
  assert.ok(overlay);
  const x = overlay.x + overlay.width * .25, y = overlay.y + overlay.height * .25;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 48, y + 38, { steps: 5 });
  await page.mouse.up();
  await download(page).click();
  const doc = await pdfLib.PDFDocument.load((await save(page)).bytes);
  const annotations = doc.getPage(0).node.Annots();
  assert.equal(annotations.size(), 1);
  assert.equal(annotations.lookup(0).lookup(pdfLib.PDFName.of("Subtype")).toString(), "/Square");
});

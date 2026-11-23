import { installEditorHandler } from "./editor-fixture.mjs";
import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { duplicatePdfFormWarning, unsupportedPdfWarning } from "../../src/js/pdf-feature-policy.mjs";
import { sourceImageFormat } from "../../src/js/image-import.mjs";
import { previewPageIndexes } from "../../src/js/preview-layout.mjs";

function fixture(features) {
  const messages = [], reads = [], warnings = [];
  const context = vm.createContext({
    workspace: { sourcePdfs: new Map(), nextSourcePdfId: 1 }, documentHistory: { pages: [] }, annotationEditor: { nextId: 1 },
    workspaceAvailable: () => true, runWorkspaceJob: job => job(() => {}), sourceImageFormat,
    previewPageIndexes, previewDisplay: { mode: "single", cover: true, direction: "left" },
    openPdfForImport: async file => ({ file, password: "", reader: { numPages: file.pages ?? 2 } }),
    readSourcePdfProperties: async () => ({}),
    pdfExporter: { readSourceForEditing: async (file, reader, prepareExternal, password) => {
      reads.push({ file, password });
      return { annotations: new Map(), unsupportedFeatures: features[file.name] ?? [] };
    } },
    duplicatePdfFormWarning, unsupportedPdfWarning, showStatus: (message, options) => messages.push({ message, ...options }),
    documentPropertiesUi: { initializeSource() {} }, unsavedChanges: { markSaved() {} },
    commitDocumentRevision(pages, selection) { context.documentHistory.pages = pages; context.latestSelection = selection; },
    console: { warn: error => warnings.push(error) },
  });
  for (const name of ["previewPageIds", "importDocumentFiles"]) installEditorHandler(context, name);
  return { context, messages, reads, warnings };
}

test("非対応機能は読み込み単位で一度に通知し、ページごとの警告や読み込み時の変換を行わない", async () => {
  const { context: c, messages, reads } = fixture({ "a.pdf": ["フォーム", "スクリプト"], "b.pdf": ["埋め込みメディア・3D"] });
  const files = [{ name: "a.pdf", pages: 4 }, { name: "b.pdf", pages: 3 }];
  await c.importDocumentFiles(files);
  const notices = messages;
  assert.equal(notices.length, 1);
  assert.equal(notices[0].error, false);
  assert.equal(notices[0].message.split("a.pdf").length - 1, 1);
  assert.equal(notices[0].message.split("b.pdf").length - 1, 1);
  assert(notices[0].message.includes("PDF保存時"));
  assert.equal(reads.length, 2);
  assert.equal(c.documentHistory.pages.length, 7);
  assert.equal(c.workspace.sourcePdfs.get(1).file, files[0]);
  assert.equal(c.workspace.sourcePdfs.get(2).file, files[1]);
});

test("通常PDFの読み込みでは非対応の通知を出さない", async () => {
  const { context: c, messages } = fixture({});
  await c.importDocumentFiles([{ name: "plain.pdf" }]);
  assert.deepEqual(messages, []);
});

test("見開き表示中に読み込んだときは、最初に表示する組を選択する", async () => {
  const { context: c } = fixture({});
  c.previewDisplay = { mode: "spread", cover: false, direction: "right" };
  await c.importDocumentFiles([{ name: "sample.pdf", pages: 3 }]);
  assert.deepEqual([...c.latestSelection.selectedPageIds], ["1:0", "1:1"]);
  assert.equal(c.latestSelection.previewPageId, "1:0");
});

test("警告と読み込み失敗が混在しても、成功したファイルを残して両方の理由を通知する", async () => {
  const { context: c, messages } = fixture({ "a.pdf": ["フォーム"] });
  c.openPdfForImport = async file => {
    if (file.name === "bad.pdf") throw Error("invalid");
    return { file, reader: { numPages: 1 } };
  };
  await c.importDocumentFiles([{ name: "a.pdf" }, { name: "bad.pdf" }]);
  assert.equal(c.documentHistory.pages.length, 1);
  assert.equal(messages.length, 1);
  const last = messages[0]; assert(last.error);
  assert(last.message.includes("a.pdf")); assert(last.message.includes("bad.pdf"));
});

test("PDFと画像を入力順で取り込み、画像の元ファイル名は変換後も保持する", async () => {
  const { context: c, reads, messages } = fixture({});
  const pdfFile = new Blob(["generated"]);
  c.pdfjs = {};
  c.openSourcePdf = async (_pdfjs, file) => ({ file, reader: { numPages: 1 } });
  c.pdfExporter.convertImage = async (file, format) => {
    if (file.name === "bad.png") throw Error("invalid");
    return { pdfFile, image: { format, width: 400, height: 300 } };
  };
  const photo = { name: "PHOTO.JPG" }, pdf = { name: "document.pdf" }, screenshot = { name: "screenshot.png", type: "image/png" };
  await c.importDocumentFiles([photo, { name: "bad.png" }, pdf, screenshot]);
  assert.deepEqual(Array.from(c.documentHistory.pages, page => page.sourcePdfId), [1, 2, 2, 3]);
  assert.deepEqual(reads.map(entry => entry.file), [pdf]);
  assert.equal(c.workspace.sourcePdfs.get(1).file, photo);
  assert.equal(c.workspace.sourcePdfs.get(1).pdfFile, pdfFile);
  assert.equal(c.workspace.sourcePdfs.get(3).image.format, "PNG");
  assert.match(messages.at(-1).message, /bad\.png.*PNG画像として開けませんでした/);
});

test("トーストは新しい通知に差し替え、閉じると読み上げ用の内容も消す", () => {
  const classes = new Set(), toast = { classList: { toggle: (key, on) => on ? classes.add(key) : classes.delete(key) } };
  const ui = { "editor-toast": toast, "toast-message": {}, "toast-title": {}, "toast-live": {} };
  const c = vm.createContext({ ui });
  installEditorHandler(c, "showStatus");
  c.showStatus("書き出せませんでした", { error: true });
  assert.equal(ui["toast-title"].textContent, "エラー");
  assert(classes.has("error"));
  c.showStatus("フォーム非対応");
  assert.equal(ui["toast-title"].textContent, "注意");
  assert.equal(ui["toast-message"].textContent, "フォーム非対応");
  assert(!classes.has("error"));
  c.showStatus("");
  assert(toast.hidden);
  assert.equal(ui["toast-live"].textContent, "");
});

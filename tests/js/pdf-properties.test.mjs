import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readSourcePdfProperties, initialOutputProperties, normalizePdfPermissions, validatePdfOutputSettings, mergedSourceNotes } from "../../src/js/pdf-properties.mjs";
import { annotationLockMask, annotationSelectionLock, setAnnotationsLocked } from "../../src/js/annotation-locks.mjs";
import { createPdfExporter } from "../../src/js/pdf-export.mjs";
import { generatedPdfVersionLabel } from "../../src/js/pdf-document.mjs";
import { createPdfAnnotationCodec } from "../../src/js/pdf-annotations.mjs";
import { createExternalAnnotationCodec } from "../../src/js/external-annotations.mjs";
import { createExportPlan } from "../../src/js/export-job.mjs";

const require = createRequire(import.meta.url);
const lib = require("../../src/vendor/cantoo-pdf-lib/pdf-lib.min.js");
const n = lib.PDFName.of;
const reader = { numPages: 1, annotationStorage: { setValue() {} } };
const model = (id, annotations = []) => ({ id: id + ":0", sourcePdfId: id, sourceIndex: 0, addedRotation: 0, annotations });
async function input(title, date = new Date("2020-01-02T03:04:05Z")) {
  const doc = await lib.PDFDocument.create(); doc.addPage([300, 400]).drawText("Original body");
  doc.setTitle(title); doc.setAuthor("Original author"); doc.setCreationDate(date);
  return { file: new File([await doc.save()], title + ".pdf"), reader };
}

test("元PDFの権限はSet・配列・制限なし・取得失敗を区別し、失敗しても注釈の読込を止めない", async () => {
  for (const raw of [new Set([4, 16]), [4, 16], null]) {
    const properties = await readSourcePdfProperties({ getMetadata: async () => ({ info: { Title: "最初", Author: "元の著者", EncryptFilterName: "Standard" } }), getPermissions: async () => raw });
    assert.equal(properties.permissions.annotating, raw === null);
    assert.equal(properties.permissions.printing, true);
    const initial = initialOutputProperties(properties);
    assert.equal(initial.title, "最初"); assert.equal(initial.author, "");
    assert.deepEqual(initial.permissions, normalizePdfPermissions(null));
    initial.permissions.copying = false;
    assert.equal(properties.permissions.copying, true);
  }
  const unknown = await readSourcePdfProperties({ getMetadata: () => { throw Error("metadata unavailable"); }, getPermissions: async () => { throw Error("permissions unavailable"); } });
  assert.equal(unknown.permissions, null); assert.equal(unknown.encrypted, null); assert.equal(unknown.metadataKnown, false);
  assert.equal((await readSourcePdfProperties({})).permissionsKnown, false);
});

test("3種のロックは標準注釈・外部APとも復元でき、解除保存で全ロックを取り除く", async () => {
  for (const external of [false, true]) for (const flag of [64, 128, 512, annotationLockMask]) {
    const doc = await lib.PDFDocument.create(), page = doc.addPage([300, 400]);
    const ap = doc.context.register(doc.context.formXObject([], { BBox: [0, 0, 80, 30], Resources: {} }));
    const ref = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Line", Rect: [20, 20, 100, 50],
      F: flag | 4 | 256, L: [20, 20, 100, 50], C: [0, 0, 0], AP: { N: ap }, BS: { W: 2, S: external ? "D" : "S" } }));
    page.node.addAnnot(ref);
    const file = new File([await doc.save()], "lock.pdf");
    const exporter = createPdfExporter(lib);
    const restored = (await exporter.readSourceForEditing(file, reader)).annotations;
    const annotation = restored.get(0)[0].annotation;
    assert.equal(annotation.locked, true); assert.equal(annotation.kind, external ? "external" : "line");
    const pdfs = await exporter.loadExportSourcePdfs(new Map([[1, { file, reader, restoredAnnotations: restored }]]));
    for (const locked of [true, false]) {
      const result = await lib.PDFDocument.load(await exporter.assembleOutputPdf([model(1, [{ ...annotation, locked }])], pdfs), { updateMetadata: false });
      const flags = result.getPage(0).node.Annots().lookup(0).lookup(n("F")).asNumber();
      assert.equal(Boolean(flags & annotationLockMask), locked);
      assert.equal(flags & (4 | 256), 4 | 256);
      const codec = external ? createExternalAnnotationCodec(lib) : createPdfAnnotationCodec(lib);
      assert.equal(codec.read(result.getPage(0), result.getPage(0).node.Annots().get(0)).annotation.locked, locked);
    }
  }
});

test("複数ロック解除は未選択を変更せず、解除状態は元の配列を書き換えない", () => {
  const originals = [{ id: 1, locked: true }, { id: 2 }, { id: 3, locked: true }];
  assert.deepEqual(annotationSelectionLock(originals), { any: true, all: false, mixed: true, count: 2 });
  const output = setAnnotationsLocked(originals, new Set([1, 2]), false);
  assert.equal(output[0].locked, false); assert.equal(output[1], originals[1]); assert.equal(output[2], originals[2]);
  assert.equal(originals[0].locked, true);
});

test("文書情報は出力設定と一致し、単一原稿の作成日時を保持して結合時は生成日時にする", async () => {
  const exporter = createPdfExporter(lib);
  const sources = new Map([[1, await input("最初の原稿")], [2, await input("別の原稿")]]);
  const pdfs = await exporter.loadExportSourcePdfs(sources);
  const settings = { title: '日本語<&"タイトル', author: "指定した著者", subject: "件名", keywords: "語句, abc", notes: "結合元PDF：\n原稿.pdf" };
  for (const ids of [[1], [2, 1]]) {
    const bytes = await exporter.assembleOutputPdf(ids.map(id => model(id)), pdfs, settings);
    const out = await lib.PDFDocument.load(bytes, { updateMetadata: false });
    assert.equal(out.getTitle(), settings.title); assert.equal(out.getAuthor(), settings.author);
    assert.equal(out.getSubject(), settings.subject); assert.equal(out.getKeywords(), settings.keywords);
    assert.equal(out.context.lookup(out.context.trailerInfo.Info).lookup(n("Notes")).decodeText(), settings.notes);
    if (ids.length === 1) assert.equal(out.getCreationDate().toISOString(), "2020-01-02T03:04:05.000Z");
    else assert(Math.abs(out.getCreationDate().getTime() - Date.now()) < 3000);
    const xmp = new TextDecoder().decode(lib.decodePDFRawStream(out.catalog.lookup(n("Metadata"))).decode());
    assert(xmp.includes("日本語&lt;&amp;&quot;タイトル")); assert(xmp.includes("指定した著者"));
    assert.equal(xmp.includes("pdfaid:"), false);
  }
});

test("保護なし・権限のみ・閲覧用を別々に書き出し、閲覧パスワードで開ける", async () => {
  const exporter = createPdfExporter(lib);
  const pdfs = await exporter.loadExportSourcePdfs(new Map([[1, await input("body")]]));
  const full = normalizePdfPermissions(null);
  const variants = [
    { permissions: full },
    { permissions: { ...full, annotating: false } },
    { permissions: full, userPasswordEnabled: true, userPassword: "閲覧-password" },
    { permissions: { ...full, printing: false, highQualityPrinting: false } },
    { permissions: { ...full, annotating: false }, userPasswordEnabled: true, userPassword: "reader" },
  ];
  for (const settings of variants) {
    const bytes = await exporter.assembleOutputPdf([model(1)], pdfs, settings);
    const raw = await lib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const encrypted = raw.context.trailerInfo.Encrypt != null;
    assert.equal(encrypted, settings !== variants[0]);
    const opened = await lib.PDFDocument.load(bytes, { password: settings.userPasswordEnabled ? settings.userPassword : "", updateMetadata: false });
    assert.equal(opened.getPageCount(), 1);
    if (encrypted) {
      const security = raw.context.lookup(raw.context.trailerInfo.Encrypt);
      assert.equal(security.lookup(n("R")).asNumber(), 6);
      const flags = security.lookup(n("P")).asNumber();
      assert.equal(Boolean(flags & 32), settings.permissions.annotating);
      assert.equal(Boolean(flags & 4), settings.permissions.printing);
    }
    if (settings.userPasswordEnabled) {
      await assert.rejects(() => lib.PDFDocument.load(bytes, { password: "" }), /NEEDS PASSWORD/);
      await assert.rejects(() => lib.PDFDocument.load(bytes, { password: "incorrect" }), /Password incorrect/);
    }

  }
});

test("パスワード空欄は保護オン時のみ拒否し、出力設定と備考は書き出し開始時に固定する", () => {
  assert.throws(() => validatePdfOutputSettings({ userPasswordEnabled: true, userPassword: "" }), /入力/);
  validatePdfOutputSettings({ userPasswordEnabled: false, userPassword: "" });
  assert.throws(() => validatePdfOutputSettings({ userPasswordEnabled: true, userPassword: "あ".repeat(43) }), /127/);
  const settings = { title: "最初", author: "", permissions: normalizePdfPermissions(null), userPasswordEnabled: false };
  const plan = createExportPlan([model(1)], new Set(), new Map(), { extension: "pdf", layout: "combined", customName: "test", pdfSettings: settings });
  settings.title = "後から変更"; settings.permissions.annotating = false;
  assert.equal(plan.pdfSettings.title, "最初"); assert.equal(plan.pdfSettings.permissions.annotating, true);
  assert.equal(mergedSourceNotes("元の備考", new Map([[1, { file: { name: "first.pdf" } }], [2, { file: { name: "second.pdf" } }]])), "元の備考\n\n結合元PDF：\nfirst.pdf\nsecond.pdf");
});


test("出力バージョンは実保存から取得し、元文書のヘッダーやカタログバージョンを流用しない", async () => {
  const exporter = createPdfExporter(lib);
  const labels = await exporter.outputVersionLabels();
  assert.equal(labels.plain, "1.7");
  assert.equal(labels.encrypted, "1.7 拡張レベル8");
  for (const version of ["1.4", "1.7", "2.0"]) {
    const original = await lib.PDFDocument.create(); original.addPage();
    const [major, minor] = version.split(".").map(Number);
    original.context.header = lib.PDFHeader.forVersion(major, minor);
    original.catalog.set(n("Version"), n("2.0"));
    const sources = await exporter.loadExportSourcePdfs(new Map([[1, { file: new Blob([await original.save()]), reader }]]));
    for (const encrypted of [false, true]) {
      const permissions = normalizePdfPermissions(null);
      if (encrypted) permissions.annotating = false;
      const bytes = await exporter.assembleOutputPdf([model(1)], sources, { permissions });
      assert.equal(new TextDecoder().decode(bytes.slice(0, 8)), "%PDF-1.7");
      const saved = await lib.PDFDocument.load(bytes, { password: "", updateMetadata: false });
      assert.equal(generatedPdfVersionLabel(lib, saved), labels[encrypted ? "encrypted" : "plain"]);
      assert.equal(saved.catalog.has(n("Version")), false);
    }
  }
});

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createPdfFeaturePolicy, unsupportedPdfWarning } from "../../src/js/pdf-feature-policy.mjs";
import { createPdfExporter } from "../../src/js/pdf-export.mjs";

const require = createRequire(import.meta.url);
const lib = require("../../src/vendor/cantoo-pdf-lib/pdf-lib.min.js");
const { PDFDocument, PDFName, PDFDict, PDFRawStream, PDFString } = lib;
const name = PDFName.of;
const policy = createPdfFeaturePolicy(lib);
const model = index => ({ id: "1:" + index, sourcePdfId: 1, sourceIndex: index, addedRotation: 0, annotations: [] });
const reader = { numPages: 1, annotationStorage: { setValue() {} } };
const text = doc => doc.context.enumerateIndirectObjects().map(([, object]) => {
  if (object instanceof PDFRawStream) {
    try { return new TextDecoder().decode(lib.decodePDFRawStream(object).decode()); } catch { return ""; }
  }
  return object.toString();
}).join("\n");
async function output(doc) {
  const exporter = createPdfExporter(lib), bytes = await doc.save({ updateFieldAppearances: false });
  const file = new File([bytes], "input.pdf");
  const imported = await exporter.readSourceForEditing(file, { ...reader, numPages: doc.getPageCount() });
  const sources = await exporter.loadExportSourcePdfs(new Map([[1, { file, reader: { ...reader, numPages: doc.getPageCount() }, restoredAnnotations: imported.annotations }]]));
  const saved = await exporter.assembleOutputPdf(doc.getPages().map((_, i) => model(i)), sources);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes, "読み込み用の元ファイルは変更しない");
  return { imported, doc: await PDFDocument.load(saved), bytes: saved };
}
function appearance(doc, content = "0 0 1 rg 0 0 10 20 re f", extra = {}) {
  return doc.context.register(doc.context.flateStream(content, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 20], Resources: {}, ...extra }));
}
function widget(doc, page, extra = {}) {
  const ref = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Widget", Rect: [20, 30, 60, 90], F: 4,
    AP: { N: appearance(doc) }, ...extra }));
  page.node.addAnnot(ref); return doc.context.lookup(ref);
}

test("通常のPDFでは注意喚起せず、読み込み用の元データを変更しない", async () => {
  const doc = await PDFDocument.create(); doc.addPage().drawText("STATIC_BODY");
  doc.catalog.set(name("AcroForm"), doc.context.obj({ Fields: [] }));
  assert.deepEqual(policy.inspect(doc), []);
  const result = await output(doc);
  assert.deepEqual(result.imported.unsupportedFeatures, []);
  assert.equal(unsupportedPdfWarning("plain.pdf", []), "");
  assert(!result.doc.context.enumerateIndirectObjects().some(([, o]) => o instanceof PDFRawStream && o.dict.get(name("Subtype")) === name("Image")));
});

test("フォームの表示ストリーム・座標・フォント・値・フラグを加工せずにコピーする", async () => {
  const doc = await PDFDocument.create(), p = doc.addPage([300, 400]);
  p.drawText("ORIGINAL_BODY");
  const ref = appearance(doc, "VECTOR_AP_MARKER 0 0 1 rg 5 7 20 10 re f", { BBox: [5, 7, 25, 17], Matrix: [0, 2, -3, 0, 40, 10] });
  const original = widget(doc, p, { FT: "Tx", T: PDFString.of("unchanged"), V: PDFString.of("original value"), Ff: 2,
    Rect: [20, 30, 80, 110], AP: { N: ref } });
  const fieldRef = p.node.Annots().get(0);
  doc.catalog.set(name("AcroForm"), doc.context.obj({ Fields: [fieldRef], DA: PDFString.of("/Original 12 Tf 0 g"), DR: { Font: {} } }));
  const result = await output(doc), out = result.doc, copied = out.getPage(0).node.Annots().lookup(0, PDFDict);
  assert(result.imported.unsupportedFeatures.includes("フォーム")); assert.equal(result.imported.annotations.size, 0);
  for (const key of ["Rect", "F", "Ff", "V", "FT", "T"]) assert.equal(copied.get(name(key)).toString(), original.get(name(key)).toString(), key);
  const ap = copied.lookup(name("AP")).lookup(name("N")), before = doc.context.lookup(ref);
  assert.deepEqual([...ap.getContents()], [...before.getContents()]);
  for (const key of ["BBox", "Matrix", "Resources"]) assert.equal(ap.dict.get(name(key)).toString(), before.dict.get(name(key)).toString(), key);
  assert.equal(out.catalog.lookup(name("AcroForm")).get(name("DA")).toString(), doc.catalog.lookup(name("AcroForm")).get(name("DA")).toString());
  assert(!text(out).includes("StaticAppearance"));
});

test("チェック状態や入力値の不整合は修復せず、そのまま引き継ぐ", async () => {
  const doc = await PDFDocument.create(), p = doc.addPage();
  widget(doc, p, { AS: "On", V: name("Off"), AP: { N: { On: appearance(doc, "AP_ON_MARKER"), Off: appearance(doc, "AP_OFF_MARKER") } } });
  const result = await output(doc), copied = result.doc.getPage(0).node.Annots().lookup(0);
  assert.equal(copied.get(name("AS")), name("On")); assert.equal(copied.get(name("V")), name("Off"));
  assert(text(result.doc).includes("AP_ON_MARKER")); assert(text(result.doc).includes("AP_OFF_MARKER"));
});

test("表示データがないフォームも作り直さず、既存の更新フラグを保持する", async () => {
  const doc = await PDFDocument.create(), p = doc.addPage(); widget(doc, p, { AP: {} });
  doc.catalog.set(name("AcroForm"), doc.context.obj({ Fields: [], XFA: PDFString.of("XFA_PAYLOAD"), NeedAppearances: true }));
  const result = await output(doc), features = result.imported.unsupportedFeatures;
  assert(features.includes("フォーム")); assert(features.includes("XFAフォーム"));
  const warning = unsupportedPdfWarning("input.pdf", features);
  assert(warning.includes("再生成・修復せず")); assert(warning.includes("出力後の表示・動作をご確認"));
  assert.equal(result.doc.getPage(0).node.Annots().size(), 1);
  assert.equal(result.doc.catalog.lookup(name("AcroForm")).lookup(name("NeedAppearances")).asBoolean(), true);
  assert(!text(result.doc).includes("XFA_PAYLOAD"));
});

test("NoRotateや表示・印刷・レイヤー条件を、補正や別表現への置換なしで保持する", async () => {
  const doc = await PDFDocument.create(), p = doc.addPage(); p.setRotation(lib.degrees(90));
  const group = doc.context.register(doc.context.obj({ Type: "OCG", Name: PDFString.of("Original hidden layer") }));
  doc.catalog.set(name("OCProperties"), doc.context.obj({ OCGs: [group], D: { OFF: [group] } }));
  for (const flags of [4 | 16, 0, 4 | 32, 2]) widget(doc, p, { F: flags, OC: group });
  const result = await output(doc), out = result.doc;
  const annots = out.getPage(0).node.Annots();
  assert.equal(annots.size(), 4);
  for (const [i, flags] of [4 | 16, 0, 4 | 32, 2].entries()) assert.equal(annots.lookup(i).lookup(name("F")).asNumber(), flags);
  assert.equal(out.catalog.lookup(name("OCProperties")).lookup(name("OCGs")).size(), 1);
  assert(!text(out).includes("StaticAppearance")); assert(!text(out).includes("StaticVisibility"));
});

test("文書・ページ・注釈・Next・しおりのスクリプトと外部動作を除去する", async () => {
  const doc = await PDFDocument.create(), p = doc.addPage(); p.drawText("BODY");
  const js = doc.context.register(doc.context.obj({ S: "JavaScript", JS: doc.context.register(doc.context.flateStream("REMOVED_SCRIPT_PAYLOAD")) }));
  doc.context.lookup(js).set(name("Next"), doc.context.obj([js]));
  doc.catalog.set(name("OpenAction"), js);
  doc.catalog.set(name("Names"), doc.context.obj({ JavaScript: { Names: [PDFString.of("init"), js] } }));
  p.node.set(name("AA"), doc.context.obj({ O: js })); p.node.set(name("Trans"), doc.context.obj({ S: "Dissolve" }));
  for (const type of ["JavaScript", "Launch", "SubmitForm", "ImportData", "GoToR", "GoToE", "URI", "SetOCGState", "Rendition", "CustomAction"]) {
    p.node.addAnnot(doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 20, 20],
      A: { S: type, JS: PDFString.of("REMOVED_ACTION_PAYLOAD"), F: PDFString.of("file://secret"), Next: js }, AA: { E: js } })));
  }
  const outlines = doc.context.register(doc.context.obj({ Type: "Outlines" }));
  const child = doc.context.register(doc.context.obj({ Title: PDFString.of("script"), Parent: outlines, A: js }));
  doc.context.lookup(outlines).set(name("First"), child); doc.catalog.set(name("Outlines"), outlines);
  const result = await output(doc), out = result.doc;
  assert(result.imported.unsupportedFeatures.includes("スクリプト"));
  for (const key of ["OpenAction", "AA", "Outlines"]) assert(!out.catalog.has(name(key)));
  assert.equal(out.getPage(0).node.Annots().size(), 0);
  for (const token of ["REMOVED_SCRIPT_PAYLOAD", "REMOVED_ACTION_PAYLOAD", "/JavaScript", "/Launch", "/SubmitForm", "/Trans"]) assert(!text(out).includes(token), token);
});

test("メディアの表示APは加工せず、再生用データ・添付・外部動作を除去する", async () => {
  const doc = await PDFDocument.create(), p = doc.addPage();
  const payload = doc.context.register(doc.context.flateStream("REMOVED_ATTACHMENT_PAYLOAD", { Type: "EmbeddedFile" }));
  const file = doc.context.register(doc.context.obj({ Type: "Filespec", F: PDFString.of("payload.bin"), EF: { F: payload } }));
  doc.catalog.set(name("Names"), doc.context.obj({ EmbeddedFiles: { Names: [PDFString.of("payload"), file] } }));
  doc.catalog.set(name("AF"), doc.context.obj([file])); p.node.set(name("AF"), doc.context.obj([file]));
  const appearances = [];
  for (const subtype of ["Screen", "RichMedia", "Movie", "Sound", "3D", "FileAttachment"]) {
    const ap = appearance(doc, "STATIC_POSTER_" + subtype); appearances.push(doc.context.lookup(ap).getContents());
    p.node.addAnnot(doc.context.register(doc.context.obj({ Type: "Annot", Subtype: subtype, Rect: [20, 30, 60, 90], F: 4,
      AP: { N: ap }, FS: file, Sound: payload, RichMediaContent: { Assets: file } })));
  }
  const result = await output(doc), out = result.doc, annots = out.getPage(0).node.Annots();
  assert.equal(result.imported.annotations.size, 0);
  assert(result.imported.unsupportedFeatures.includes("添付ファイル"));
  assert(result.imported.unsupportedFeatures.includes("埋め込みメディア・3D"));
  assert.equal(annots.size(), 6);
  for (let i = 0; i < 6; i++) assert.deepEqual([...annots.lookup(i).lookup(name("AP")).lookup(name("N")).getContents()], [...appearances[i]]);
  for (const token of ["REMOVED_ATTACHMENT_PAYLOAD", "/EmbeddedFile", "/Filespec", "/RichMediaContent", "/AF"]) assert(!text(out).includes(token), token);
  assert(!text(out).includes("StaticAppearance"));
});

test("A・AAという名前の描画資源を、アクションと取り違えて削除しない", async () => {
  const doc = await PDFDocument.create(), p = doc.addPage();
  const font = await doc.embedFont(lib.StandardFonts.Helvetica);
  p.node.Resources().set(name("Font"), doc.context.obj({ A: font.ref, AA: font.ref }));
  p.node.set(name("Contents"), doc.context.register(doc.context.flateStream("BT /A 12 Tf 10 10 Td (A_FONT_TEXT) Tj /AA 12 Tf (AA_FONT_TEXT) Tj ET")));
  const result = await output(doc), fonts = result.doc.getPage(0).node.Resources().lookup(name("Font"));
  assert(fonts.lookup(name("A")) instanceof PDFDict); assert(fonts.lookup(name("AA")) instanceof PDFDict);
  assert(text(result.doc).includes("AA_FONT_TEXT"));
});


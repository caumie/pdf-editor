import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createPdfExporter } from "../../src/js/pdf-export.mjs";

const require = createRequire(import.meta.url);
const lib = require("../../src/vendor/cantoo-pdf-lib/pdf-lib.min.js");
const { PDFDocument, PDFName, PDFString, PDFDict } = lib;
const name = PDFName.of;
const selected = (id, index) => ({ id: id + ":" + index, sourcePdfId: id, sourceIndex: index, addedRotation: 0, annotations: [] });
async function inputs(exporter, documents) {
  return exporter.loadExportSourcePdfs(new Map(await Promise.all(documents.map(async (doc, index) => [index + 1, {
    file: new File([await doc.save()], "source" + index + ".pdf"),
    reader: { numPages: doc.getPageCount(), annotationStorage: { setValue() {} } },
  }]))));
}
const load = bytes => PDFDocument.load(bytes, { updateMetadata: false });
const refString = value => value?.toString();
const pageObjects = doc => doc.context.enumerateIndirectObjects().filter(([, value]) =>
  value instanceof PDFDict && value.get(name("Type")) === name("Page"));
function decodedStreams(doc) {
  return doc.context.enumerateIndirectObjects().flatMap(([, value]) => {
    if (!(value instanceof lib.PDFRawStream)) return [];
    try { return [new TextDecoder().decode(lib.decodePDFRawStream(value).decode())]; } catch { return []; }
  }).join("\n");
}
function link(doc, page, target, key = "Dest") {
  const value = doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 20, 20] });
  value.set(name(key), target);
  page.node.addAnnot(doc.context.register(value));
  return value;
}

test("削除先への直接・名前付き・追加アクション参照を除き、削除ページの本文を保存しない", async () => {
  const doc = await PDFDocument.create();
  const a = doc.addPage(), b = doc.addPage();
  a.node.set(name("Contents"), doc.context.register(doc.context.flateStream("VISIBLE_PAGE_MARKER")));
  b.node.set(name("Contents"), doc.context.register(doc.context.flateStream("REMOVED_PAGE_SECRET_MARKER")));
  doc.catalog.set(name("Names"), doc.context.obj({ Dests: { Names: [PDFString.of("removed"), [b.ref, "Fit"]] } }));
  link(doc, a, doc.context.obj([b.ref, "Fit"]));
  link(doc, a, PDFString.of("removed"));
  link(doc, a, doc.context.obj({ S: "GoTo", D: [b.ref, "Fit"] }), "A");
  const external = link(doc, a, doc.context.obj({ S: "URI", URI: PDFString.of("https://example.com"),
    Next: { S: "GoTo", D: [b.ref, "Fit"] } }), "A");
  external.set(name("AA"), doc.context.obj({ E: { S: "GoTo", D: [b.ref, "Fit"] } }));
  const exporter = createPdfExporter(lib), sources = await inputs(exporter, [doc]);
  const out = await load(await exporter.assembleOutputPdf([selected(1, 0)], sources));
  assert.equal(out.getPageCount(), 1);
  assert.equal(pageObjects(out).length, 1);
  assert(!decodedStreams(out).includes("REMOVED_PAGE_SECRET_MARKER"));
  assert(decodedStreams(out).includes("VISIBLE_PAGE_MARKER"));
  const annotations = out.getPage(0).node.Annots();
  assert.equal(annotations.size(), 0);
});

test("並べ替え後も名前付きリンク・しおりは出力ページを指し、同じ入力から再保存できる", async () => {
  const doc = await PDFDocument.create(), a = doc.addPage(), b = doc.addPage();
  const dest = doc.context.obj([b.ref, "Fit"]);
  doc.catalog.set(name("Names"), doc.context.obj({ Dests: { Kids: [{ Names: [PDFString.of("second"), { D: dest }] }] } }));
  link(doc, a, name("second"));
  const root = doc.context.register(doc.context.obj({ Type: "Outlines" }));
  const child = doc.context.register(doc.context.obj({ Title: PDFString.of("second"), Parent: root, Dest: PDFString.of("second") }));
  doc.context.lookup(root).set(name("First"), child); doc.context.lookup(root).set(name("Last"), child);
  doc.catalog.set(name("Outlines"), root);
  const exporter = createPdfExporter(lib), sources = await inputs(exporter, [doc]);
  for (const order of [[1, 0], [0, 1], [0], [1, 0]]) {
    const out = await load(await exporter.assembleOutputPdf(order.map(i => selected(1, i)), sources));
    assert.equal(pageObjects(out).length, order.length);
    if (order.includes(1)) {
      const target = out.getPage(order.indexOf(1)).ref.toString();
      const bookmark = out.catalog.lookup(name("Outlines")).lookup(name("First"));
      assert.equal(refString(bookmark.lookup(name("Dest")).get(0)), target);
      const pairs = out.catalog.lookup(name("Names")).lookup(name("Dests")).lookup(name("Names"));
      assert.equal(refString(pairs.lookup(1).get(0)), target);
      const origin = out.getPage(order.indexOf(0));
      assert.equal(refString(origin.node.Annots().lookup(0).lookup(name("Dest")).get(0)), target);
    } else {
      assert(!out.catalog.has(name("Outlines")));
      assert(!out.catalog.has(name("Names")));
      assert.equal(out.getPage(0).node.Annots().size(), 0);
    }
  }
  assert.equal(sources.get(1).getPage(0).node.Annots().size(), 1);
  assert.equal(sources.get(1).getPage(0).node.Annots().lookup(0).get(name("Dest")), name("second"));
});

test("同名の名前付き移動先を結合しても各リンクが自分の元PDFのページを指す", async () => {
  const docs = [];
  for (let i = 0; i < 2; i++) {
    const doc = await PDFDocument.create(), p = doc.addPage();
    doc.catalog.set(name("Dests"), doc.context.obj({ same: [p.ref, "Fit"] }));
    link(doc, p, name("same")); docs.push(doc);
  }
  const exporter = createPdfExporter(lib), sources = await inputs(exporter, docs);
  const out = await load(await exporter.assembleOutputPdf([selected(1, 0), selected(2, 0)], sources));
  const pairs = out.catalog.lookup(name("Names")).lookup(name("Dests")).lookup(name("Names"));
  assert.deepEqual([pairs.lookup(0).decodeText(), pairs.lookup(2).decodeText()], ["same", "same_2"]);
  for (const p of out.getPages()) assert.equal(refString(p.node.Annots().lookup(0).lookup(name("Dest")).get(0)), p.ref.toString());
});

test("フォームは構造を引き継ぎ、範囲外のページ本文を持ち込まない", async () => {
  const doc = await PDFDocument.create(), a = doc.addPage(), b = doc.addPage();
  const form = doc.getForm();
  const retained = form.createTextField("group.retained"); retained.setText("Alice"); retained.addToPage(a);
  const removed = form.createTextField("group.removed"); removed.setText("REMOVED_FIELD_SECRET"); removed.addToPage(b);
  const shared = form.createCheckBox("shared"); shared.addToPage(a); shared.addToPage(b); shared.check();
  doc.catalog.lookup(name("AcroForm")).set(name("CO"), doc.context.obj([retained.acroField.ref, removed.acroField.ref]));
  const exporter = createPdfExporter(lib), sources = await inputs(exporter, [doc]);
  for (const order of [[0], [1, 0], [0]]) {
    const out = await load(await exporter.assembleOutputPdf(order.map(i => selected(1, i)), sources));
    assert(out.catalog.has(name("AcroForm")));
    const acroForm = out.catalog.lookup(name("AcroForm"));
    function validFields(refs) {
      for (const ref of refs.asArray()) {
        const field = out.context.lookup(ref);
        assert(field instanceof lib.PDFDict, "Fields/Kids must contain existing field dictionaries, not Null");
        if (field.has(name("Kids"))) validFields(field.lookup(name("Kids")));
      }
    }
    validFields(acroForm.lookup(name("Fields")));
    assert.deepEqual(out.getForm().getFields().map(field => field.getName()).sort(),
      order.length === 1 ? ["group.retained", "shared"] : ["group.removed", "group.retained", "shared"]);
    assert.equal(acroForm.lookup(name("CO")).size(), order.length === 1 ? 1 : 2);
    assert(out.getPages().every(p => p.node.Annots().size() === 2));
    for (const p of out.getPages()) for (const ref of p.node.Annots().asArray()) {
      assert.equal(refString(out.context.lookup(ref).get(name("P"))), p.ref.toString());
    }
    assert.equal(pageObjects(out).length, order.length);
    assert(decodedStreams(out).includes("416C696365")); // 元の表示ストリームにあるAlice。
    if (order.length === 1) {
      assert(!decodedStreams(out).includes("REMOVED_FIELD_SECRET"));
      assert(!decodedStreams(out).includes(Buffer.from("REMOVED_FIELD_SECRET").toString("hex").toUpperCase()));
    }
  }
});

test("同名フォームを結合しても、各表示のフォントと描画データを保つ", async () => {
  const docs = [];
  for (const [i, fontName] of [lib.StandardFonts.Helvetica, lib.StandardFonts.Courier].entries()) {
    const doc = await PDFDocument.create(), p = doc.addPage();
    const field = doc.getForm().createTextField("name"); field.setText("value" + i); field.addToPage(p);
    const font = await doc.embedFont(fontName); field.updateAppearances(font); docs.push(doc);
  }
  const exporter = createPdfExporter(lib), sources = await inputs(exporter, docs);
  const out = await load(await exporter.assembleOutputPdf([selected(1, 0), selected(2, 0)], sources));
  assert(out.catalog.has(name("AcroForm")));
  for (const [i, p] of out.getPages().entries()) {
    const stream = p.node.Annots().lookup(0).lookup(name("AP")).lookup(name("N"));
    const fonts = stream.dict.lookup(name("Resources")).lookup(name("Font"));
    assert.equal(fonts.lookup(fonts.keys()[0]).get(name("BaseFont")), name(i ? "Courier" : "Helvetica"));
    assert(decodedStreams(out).includes(Buffer.from("value" + i).toString("hex").toUpperCase()));
  }
});

test("XFAの動作データは除去し、署名を含むフォームの値は加工せず引き継ぐ", async () => {
  const doc = await PDFDocument.create(), p = doc.addPage();
  const signature = doc.context.register(doc.context.obj({ FT: "Sig", T: PDFString.of("signature"), Type: "Annot", Subtype: "Widget",
    Rect: [0, 0, 100, 20], P: p.ref, V: { Type: "Sig", Contents: PDFString.of("OLD_SIGNATURE_BYTES") } }));
  p.node.addAnnot(signature); doc.catalog.set(name("AcroForm"), doc.context.obj({ Fields: [signature], XFA: PDFString.of("XFA_CONTENT") }));
  const exporter = createPdfExporter(lib), sources = await inputs(exporter, [doc]);
  const out = await load(await exporter.assembleOutputPdf([selected(1, 0)], sources));
  assert(out.catalog.has(name("AcroForm")));
  assert.equal(out.getPage(0).node.Annots().size(), 1);
  assert.equal(out.getPage(0).node.Annots().lookup(0).lookup(name("V")).lookup(name("Contents")).decodeText(), "OLD_SIGNATURE_BYTES");
  assert(!out.context.enumerateIndirectObjects().some(([, value]) => value.toString().includes("XFA_CONTENT")));
});

test("編集で削除した注釈の本文と表示ストリームも未参照データとして除去する", async () => {
  const doc = await PDFDocument.create(), p = doc.addPage();
  const ref = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Line", Rect: [10, 20, 100, 60], L: [10, 20, 100, 60],
    NM: PDFString.of("private-line"), Contents: PDFString.of("REMOVED_ANNOTATION_COMMENT"), BS: { W: 2 }, F: 4,
    AP: { N: doc.context.register(doc.context.flateStream("REMOVED_ANNOTATION_AP", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 100] })) } }));
  p.node.addAnnot(ref);
  const exporter = createPdfExporter(lib);
  const file = new File([await doc.save()], "annotated.pdf"), reader = { numPages: 1, annotationStorage: { setValue() {} } };
  const restoredAnnotations = (await exporter.readSourceForEditing(file, reader)).annotations;
  const sources = await exporter.loadExportSourcePdfs(new Map([[1, { file, reader, restoredAnnotations }]]));
  const out = await load(await exporter.assembleOutputPdf([selected(1, 0)], sources));
  assert.equal(out.getPage(0).node.Annots().size(), 0);
  assert(!decodedStreams(out).includes("REMOVED_ANNOTATION_AP"));
  assert(!out.context.enumerateIndirectObjects().some(([, value]) => value.toString().includes("REMOVED_ANNOTATION_COMMENT")));
});

test("同名フォームは名前や値を修復せずコピーし、スクリプトだけを除去する", async () => {
  const docs = [];
  for (let i = 0; i < 2; i++) {
    const doc = await PDFDocument.create(), p = doc.addPage();
    const field = doc.getForm().createTextField("same"); field.addToPage(p); field.setText("before" + i);
    field.acroField.dict.set(name("AA"), doc.context.obj({ C: { S: "JavaScript", JS: PDFString.of('event.value = "DO_NOT_EXECUTE";') } }));
    docs.push(doc);
  }
  const exporter = createPdfExporter(lib), sources = await inputs(exporter, docs);
  for (const order of [[selected(1, 0), selected(2, 0)], [selected(2, 0)]]) {
    const out = await load(await exporter.assembleOutputPdf(order, sources));
    assert(out.catalog.has(name("AcroForm")));
    const fields = out.catalog.lookup(name("AcroForm")).lookup(name("Fields"));
    assert.equal(fields.size(), order.length);
    for (const ref of fields.asArray()) assert.equal(out.context.lookup(ref).lookup(name("T")).decodeText(), "same");
    assert(!out.context.enumerateIndirectObjects().some(([, value]) => value.toString().includes("DO_NOT_EXECUTE")));
  }
});

test("OpenActionと循環するNext内の初期化スクリプトも保存時に除去する", async () => {
  for (const chained of [false, true]) {
    const doc = await PDFDocument.create(), p = doc.addPage();
    doc.getForm().createTextField("initialized").addToPage(p);
    const script = doc.context.register(doc.context.obj({ S: "JavaScript", JS: PDFString.of('this.getField("initialized").value = "ready";') }));
    const action = chained ? doc.context.register(doc.context.obj({ S: "Named", N: "FirstPage", Next: [script] })) : script;
    if (chained) doc.context.lookup(script).set(name("Next"), action);
    doc.catalog.set(name("OpenAction"), action);
    const exporter = createPdfExporter(lib), sources = await inputs(exporter, [doc]);
    const out = await load(await exporter.assembleOutputPdf([selected(1, 0)], sources));
    assert(!out.catalog.has(name("OpenAction")));
    assert(out.catalog.has(name("AcroForm")));
  }
});

test("スクリプトを含まないOpenActionも除去し、フォームの表示は保存する", async () => {
  const doc = await PDFDocument.create(), p = doc.addPage();
  const field = doc.getForm().createTextField("value"); field.addToPage(p); field.setText("retained");
  doc.catalog.set(name("OpenAction"), doc.context.obj([p.ref, "Fit"]));
  const exporter = createPdfExporter(lib), sources = await inputs(exporter, [doc]);
  const out = await load(await exporter.assembleOutputPdf([selected(1, 0)], sources));
  assert(decodedStreams(out).includes(Buffer.from("retained").toString("hex").toUpperCase()));
  assert(!out.catalog.has(name("OpenAction")));
});

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createPdfExporter } from "../../src/js/pdf-export.mjs";
import { duplicatePdfFormWarning, unsupportedPdfWarning } from "../../src/js/pdf-feature-policy.mjs";

const lib = createRequire(import.meta.url)("../../src/vendor/cantoo-pdf-lib/pdf-lib.min.js");
const { PDFDocument, PDFName, PDFDict, PDFString, PDFHexString, PDFHeader } = lib;
const name = PDFName.of;
const annotation = (doc, page, data) => {
  const item = doc.context.obj({ Type: "Annot", Rect: [10, 10, 90, 90], F: 4, ...data });
  page.node.addAnnot(doc.context.register(item));
  return item;
};
const bytesOf = (doc, stream) => [...lib.decodePDFRawStream(doc.context.lookup(stream)).decode()];

async function open(...docs) {
  const exporter = createPdfExporter(lib), sources = new Map(), pages = [], imports = [];
  for (const [id, doc] of docs.entries()) {
    const file = new File([await doc.save({ updateFieldAppearances: false })], `${id}.pdf`);
    const reader = { numPages: doc.getPageCount(), annotationStorage: { setValue() {} } };
    const imported = await exporter.readSourceForEditing(file, reader);
    imports.push(imported);
    sources.set(id, { file, reader, restoredAnnotations: imported.annotations, formFieldPages: imported.formFieldPages });
    for (const [sourceIndex] of doc.getPages().entries()) {
      const annotations = (imported.annotations.get(sourceIndex) ?? []).map(({ annotation }, i) => ({ ...annotation, id: i + 1 }));
      pages.push({ id: `${id}:${sourceIndex}`, sourcePdfId: id, sourceIndex, annotations });
    }
  }
  const inputs = await exporter.loadExportSourcePdfs(sources);
  return { pages, sources, imports, async save(selected = pages) { return PDFDocument.load(await exporter.assembleOutputPdf(selected, inputs)); } };
}

test("同じNMを持つ注釈でも未編集のAPは両方保持し、編集や削除の対象を取り違えない", async () => {
  const doc = await PDFDocument.create(), page = doc.addPage([200, 200]);
  const original = [0, 1].map(i => annotation(doc, page, { Subtype: "Square", NM: PDFString.of("duplicate"),
    Rect: [10 + 80 * i, 10, 70 + 80 * i, 80], BS: { W: 2 },
    AP: { N: doc.context.register(doc.context.flateStream(`${i} 0 1 rg 0 0 60 70 re f`, {
      Type: "XObject", Subtype: "Form", BBox: [0, 0, 60, 70], Resources: {},
    })) } }));
  const stream = item => item.lookup(name("AP")).get(name("N"));
  const expected = original.map(item => bytesOf(doc, stream(item)));
  const session = await open(doc);
  const [model] = session.pages;
  const save = async annotations => {
    const out = await session.save([{ ...model, annotations }]);
    const refs = out.getPage(0).node.Annots().asArray();
    return { out, items: refs.map(ref => out.context.lookup(ref, PDFDict)) };
  };
  const initial = await save(model.annotations);
  assert.deepEqual(initial.items.map(item => bytesOf(initial.out, stream(item))), expected);
  const [left, right] = model.annotations;
  const moved = await save([{ ...left, width: 6 }, right]);
  assert.equal(moved.items[0].lookup(name("BS")).lookup(name("W")).asNumber(), 6);
  assert.deepEqual(bytesOf(moved.out, stream(moved.items[1])), expected[1]);
  assert(!moved.items[0].lookup(name("PDFPageEditorV1")).decodeText().includes("sourceAnnotationRef"));
  const removed = await save([right]);
  assert.equal(removed.items.length, 1);
  assert.deepEqual(bytesOf(removed.out, stream(removed.items[0])), expected[1]);
});

test("間接参照のGoToとUTF-8の名前付き移動先はページを並べ替えても残り、除外先へのリンクは消える", async () => {
  const doc = await PDFDocument.create(), first = doc.addPage([200, 200]), target = doc.addPage([250, 200]);
  doc.context.header = PDFHeader.forVersion(2, 0);
  const inputTitle = "第1章：移動先";
  const utf8 = PDFHexString.of("EFBBBF" + Buffer.from(inputTitle).toString("hex"));
  const action = doc.context.register(doc.context.obj({ S: doc.context.register(name("GoTo")), D: utf8 }));
  doc.catalog.set(name("Names"), doc.context.obj({ Dests: { Names: [utf8, [target.ref, "Fit"]] } }));
  const root = doc.context.obj({ Type: "Outlines" }), rootRef = doc.context.register(root);
  root.set(name("First"), doc.context.register(doc.context.obj({ Title: utf8, A: action, Parent: rootRef })));
  doc.catalog.set(name("Outlines"), rootRef);
  annotation(doc, first, { Subtype: doc.context.register(name("Link")), A: action });
  annotation(doc, first, { Subtype: "FreeText", Contents: utf8, DA: PDFString.of("/Helv 10 Tf 0 g") });
  const session = await open(doc);
  const [linkPage, destPage] = session.pages;
  assert.equal(linkPage.annotations[0].text, inputTitle);
  const output = await session.save([destPage, linkPage]);
  const annotations = output.getPage(1).node.Annots();
  const dest = annotations.lookup(0).lookup(name("A")).lookup(name("D"));
  assert.equal(dest.get(0), output.getPage(0).ref);
  assert.equal(annotations.lookup(1).lookup(name("Contents")).decodeText(), inputTitle);
  const outline = output.catalog.lookup(name("Outlines")).lookup(name("First"));
  assert.equal(outline.lookup(name("Title")).decodeText(), inputTitle);
  assert.equal(outline.lookup(name("A")).lookup(name("D")).get(0), output.getPage(0).ref);
  const names = output.catalog.lookup(name("Names")).lookup(name("Dests")).lookup(name("Names"));
  assert.equal(names.lookup(0).decodeText(), inputTitle);
  const extracted = await session.save([linkPage]);
  assert.equal(extracted.getPage(0).node.Annots().size(), 1);
  assert(!extracted.catalog.has(name("Names")));
});

test("目的地を除去しても、見えるリンクのAPや明示的な枠は非動作の注釈として残る", async () => {
  const doc = await PDFDocument.create(), page = doc.addPage(), excluded = doc.addPage();
  const ap = doc.context.register(doc.context.flateStream("0 0 1 rg 0 0 80 80 re f", {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 80, 80], Resources: {},
  }));
  const action = { S: "URI", URI: PDFString.of("https://example.org/") };
  annotation(doc, page, { Subtype: "Link", A: action, AP: { N: ap }, Border: [0, 0, 0] });
  annotation(doc, page, { Subtype: "Link", Dest: [excluded.ref, "Fit"], Border: [0, 0, 3], C: [1, 0, 0] });
  annotation(doc, page, { Subtype: "Link", A: action, Border: [0, 0, 0] });
  const session = await open(doc);
  const output = await session.save([session.pages[0]]);
  const refs = output.getPage(0).node.Annots();
  assert.equal(refs.size(), 2);
  for (const i of [0, 1]) {
    assert(!refs.lookup(i).has(name("A")));
    assert(!refs.lookup(i).has(name("Dest")));
  }
  assert.deepEqual(bytesOf(output, refs.lookup(0).lookup(name("AP")).get(name("N"))), bytesOf(doc, ap));
  assert.equal(refs.lookup(1).lookup(name("Border")).lookup(2).asNumber(), 3);
});

test("注釈配列が壊れたページ以外を抽出でき、壊れたページを選んだ保存は理由を返して失敗する", async () => {
  const doc = await PDFDocument.create(), damaged = doc.addPage([120, 200]), healthy = doc.addPage([150, 200]);
  damaged.node.set(name("Annots"), doc.context.register(doc.context.obj({})));
  annotation(doc, healthy, { Subtype: "Square", BS: { W: 2 } });
  const session = await open(doc);
  const out = await session.save([session.pages[1]]);
  assert.equal(out.getPage(0).getWidth(), 150);
  assert.equal(out.getPage(0).node.Annots().size(), 1);
  await assert.rejects(session.save(), /1 ページ目の注釈一覧を読み取れません/);
});

test("タグと記事の非対応を知らせ、ページや注釈に参照の切れた構造番号や記事ビーズを残さない", async () => {
  const doc = await PDFDocument.create(), page = doc.addPage();
  doc.catalog.set(name("StructTreeRoot"), doc.context.obj({ Type: "StructTreeRoot" }));
  doc.catalog.set(name("MarkInfo"), doc.context.obj({ Marked: true }));
  doc.catalog.set(name("Threads"), doc.context.obj([]));
  page.node.set(name("StructParents"), lib.PDFNumber.of(0));
  page.node.set(name("B"), doc.context.obj([]));
  annotation(doc, page, { Subtype: "Square", StructParent: 4 });
  const session = await open(doc);
  const warning = unsupportedPdfWarning("tagged.pdf", session.imports[0].unsupportedFeatures);
  assert.match(warning, /読み上げ用タグ/);
  assert.match(warning, /タグは引き継がれません/);
  assert.match(warning, /記事スレッド/);
  const out = await session.save();
  for (const key of ["StructTreeRoot", "Threads"]) assert(!out.catalog.has(name(key)));
  for (const key of ["StructParents", "B"]) assert(!out.getPage(0).node.has(name(key)));
  assert(!out.getPage(0).node.Annots().lookup(0).has(name("StructParent")));
});

test("フォーム欄の完全名と実際の対象ページで衝突を見つけ、先行の空フォームが既定資源を上書きしない", async () => {
  const empty = await PDFDocument.create(); empty.addPage();
  empty.catalog.set(name("AcroForm"), empty.context.obj({ Fields: [], DA: PDFString.of("EMPTY") }));
  const filled = await PDFDocument.create(); filled.addPage(); filled.addPage();
  const repeated = await PDFDocument.create(); repeated.addPage();
  for (const [doc, pageIndex, label] of [[filled, 1, "first"], [repeated, 0, "second"]]) {
    const field = doc.getForm().createTextField("office.customer");
    field.setText(label); field.addToPage(doc.getPage(pageIndex));
  }
  const different = repeated.getForm().createTextField("other.customer");
  different.addToPage(repeated.getPage(0));
  const form = filled.catalog.lookup(name("AcroForm"));
  form.set(name("DA"), PDFString.of("/Kept 12 Tf 0 g"));
  form.set(name("DR"), filled.context.obj({ Font: { Kept: (await filled.embedFont(lib.StandardFonts.Helvetica)).ref } }));
  const s = await open(empty, filled, repeated);
  assert.equal(duplicatePdfFormWarning([s.pages[0], s.pages[1], s.pages[3]], s.sources), "");
  assert.equal(duplicatePdfFormWarning(s.pages, s.sources, new Set([0])), "");
  const warning = duplicatePdfFormWarning(s.pages, s.sources, new Set([2]));
  assert.match(warning, /「office\.customer」：1\.pdf、2\.pdf/);
  assert(!warning.includes("other.customer"));
  const out = await s.save([s.pages[0], s.pages[2]]);
  const outputForm = out.catalog.lookup(name("AcroForm"));
  assert.equal(outputForm.lookup(name("DA")).decodeText(), "/Kept 12 Tf 0 g");
  assert.equal(outputForm.lookup(name("DR")).lookup(name("Font")).lookup(name("Kept")).lookup(name("BaseFont"), PDFName), name("Helvetica"));
  assert.equal(out.getForm().getTextField("office.customer").getText(), "first");
});

test("同一PDFからの保存では代替レイヤー設定を維持して、ページと同じOCGを参照する", async () => {
  const doc = await PDFDocument.create(), page = doc.addPage();
  const group = doc.context.register(doc.context.obj({ Type: "OCG", Name: PDFString.of("translation") }));
  page.node.Resources().set(name("Properties"), doc.context.obj({ Layer: group }));
  doc.catalog.set(name("OCProperties"), doc.context.obj({ OCGs: [group], D: { BaseState: "OFF" },
    Configs: [{ Name: PDFString.of("translation on"), BaseState: "OFF", ON: [group] }] }));
  const session = await open(doc), out = await session.save();
  const properties = out.catalog.lookup(name("OCProperties"));
  const config = properties.lookup(name("Configs")).lookup(0);
  const ref = out.getPage(0).node.Resources().lookup(name("Properties")).get(name("Layer"));
  assert.equal(config.lookup(name("Name")).decodeText(), "translation on");
  assert.equal(config.lookup(name("ON")).get(0), ref);
  assert.equal(properties.lookup(name("D")).lookup(name("OFF")).get(0), ref);
});

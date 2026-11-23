import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createPdfExporter } from "../../src/js/pdf-export.mjs";
import { createAnnotationCopies } from "../../src/js/annotation-clipboard.mjs";

const require = createRequire(import.meta.url);
const lib = require("../../src/vendor/cantoo-pdf-lib/pdf-lib.min.js");
const { PDFDocument, PDFName, PDFString, PDFDict, PDFArray, PDFRef, PDFRawStream } = lib;
const name = PDFName.of;
const reader = count => ({ numPages: count, annotationStorage: { setValue() {} } });

// 比較は参照番号から独立させ、APの圧縮バイトと辞書も含める。
function snapshot(value, seen = new Set()) {
  if (value instanceof PDFRef) {
    const key = value.toString();
    if (seen.has(key)) return "cycle";
    return key;
  }
  if (value instanceof PDFArray) return value.asArray().map(v => snapshot(value.context.lookup(v), seen));
  if (value instanceof PDFRawStream) return { bytes: [...value.getContents()], dict: snapshot(value.dict, seen) };
  if (value instanceof PDFDict) {
    return Object.fromEntries(value.entries().filter(([key]) => !["/P", "/Parent", "/Length"].includes(key.toString()))
      .map(([key, v]) => [key.toString(), snapshot(value.context.lookup(v), seen)]).sort(([a], [b]) => a.localeCompare(b)));
  }
  return value?.toString();
}

async function fixture() {
  const doc = await PDFDocument.create();
  const p = doc.addPage([320, 420]);
  p.drawText("Unchanged page body", { x: 20, y: 390 });
  const defs = [
    { Subtype: "Square", Rect: [20, 30, 150, 110], RD: [2, 3, 4, 5], C: [1, 0, 0], BS: { W: 1 } },
    { Subtype: "Line", Rect: [18, 28, 152, 112], L: [20, 30, 150, 110], C: [0, 1, 0], BS: { W: 2 } },
    { Subtype: "Ink", Rect: [20, 30, 150, 110], InkList: [[20, 30, 60, 80, 150, 110]], BS: { W: 2 } },
    { Subtype: "Highlight", Rect: [20, 30, 150, 60], QuadPoints: [20, 60, 150, 60, 20, 30, 150, 30], C: [1, 1, 0] },
    { Subtype: "FreeText", Rect: [20, 150, 220, 190], Contents: PDFString.of("Keep the original glyphs"), DA: PDFString.of("/Helv 13 Tf 0 g"), BS: { W: 0 } },
    { Subtype: "Stamp", Rect: [180, 40, 280, 100], F: 4 | 64 },
    { Subtype: "Square", Rect: [180, 130, 280, 200], F: 4 | 64, RD: [1, 1, 1, 1] },
  ];
  for (const [i, def] of defs.entries()) {
    const ap = doc.context.register(doc.context.flateStream("q 0.2 0.4 0.8 rg 3 5 80 40 re f Q\n", {
      Type: "XObject", Subtype: "Form", BBox: [3, 5, 83, 45], Matrix: [1, .1, 0, 1, 0, 0], Resources: {},
    }));
    const dict = doc.context.obj({ Type: "Annot", F: 4, ...def, AP: { N: ap },
      T: PDFString.of("Original reviewer"), Subj: PDFString.of("Original subject"),
      M: PDFString.of("D:20200102030405Z"), CustomVendorValue: PDFString.of("untouched-" + i) });
    // i=0にNMを付けず、読み込み時に生成した名前を書き戻さないことも試す。
    if (i) dict.set(name("NM"), PDFString.of("original-" + i));
    if (i === 2) dict.delete(name("F"));
    p.node.addAnnot(doc.context.register(dict));
  }
  return { doc, file: new Blob([await doc.save()]) };
}

async function open(exporter, file) {
  const doc = await PDFDocument.load(await file.arrayBuffer(), { updateMetadata: false });
  const view = reader(doc.getPageCount());
  const imported = await exporter.readSourceForEditing(file, view, async () => {});
  const inputs = await exporter.loadExportSourcePdfs(new Map([[1, { file, reader: view, restoredAnnotations: imported.annotations }]]));
  const annotations = (imported.annotations.get(0) ?? []).map(({ annotation }, i) => ({ ...structuredClone(annotation), id: i + 1,
    ...(annotation.kind === "external" ? { appearanceKey: "1:" + annotation.externalRefId } : {}) }));
  return { doc, imported, inputs, annotations, page: { id: "1:0", sourcePdfId: 1, sourceIndex: 0, addedRotation: 0, annotations } };
}

const dicts = doc => doc.getPage(0).node.Annots().asArray().map(ref => doc.context.lookup(ref, PDFDict));

test("既存の矩形・線・筆跡・ハイライト・文字・外部注釈は、無編集なら辞書とAPを3回保存しても保つ", async () => {
  let { file } = await fixture();
  const original = await PDFDocument.load(await file.arrayBuffer(), { updateMetadata: false });
  const expected = dicts(original).map(d => snapshot(d));
  for (let round = 0; round < 3; round++) {
    const exporter = createPdfExporter(lib);
    const session = await open(exporter, file);
    assert.equal(session.annotations.length, 7);
    assert(session.annotations.some(a => a.kind === "text"));
    assert(session.annotations.some(a => a.kind === "external"));
    const output = await exporter.assembleOutputPdf([session.page], session.inputs);
    const doc = await PDFDocument.load(output, { updateMetadata: false });
    assert.deepEqual(dicts(doc).map(d => snapshot(d)), expected);
    assert.equal(dicts(doc)[0].has(name("NM")), false);
    assert.equal(dicts(doc)[2].has(name("F")), false);
    assert.equal(dicts(doc)[5].lookup(name("F")).asNumber(), 4 | 64);
    assert(dicts(doc).every(d => d.get(name("P")).toString() === doc.getPage(0).ref.toString()));
    file = new Blob([output]);
  }
});

test("描画を変更した1件だけ再生成し、隣の未編集注釈は元のAP・未知の属性を保持する", async () => {
  const { file } = await fixture(); const exporter = createPdfExporter(lib);
  const session = await open(exporter, file);
  const before = dicts(session.doc).map(d => snapshot(d));
  session.annotations[0] = { ...session.annotations[0], width: 5 };
  const doc = await PDFDocument.load(await exporter.assembleOutputPdf([session.page], session.inputs), { updateMetadata: false });
  const out = dicts(doc);
  assert.equal(out[0].lookup(name("BS")).lookup(name("W")).asNumber(), 5);
  assert.notDeepEqual(snapshot(out[0].lookup(name("AP"))), before[0]["/AP"]);
  assert.equal(out[0].lookup(name("T")).decodeText(), "Original reviewer");
  assert.deepEqual(out.slice(1).map(d => snapshot(d)), before.slice(1));
});

test("ロックの変更だけなら、ネイティブと外部注釈のAP・座標・コメントを再生成しない", async () => {
  const { file } = await fixture(); const exporter = createPdfExporter(lib);
  const session = await open(exporter, file);
  const originals = dicts(session.doc);
  session.annotations = session.annotations.map(a => ({ ...a, locked: !a.locked }));
  const doc = await PDFDocument.load(await exporter.assembleOutputPdf([{ ...session.page, annotations: session.annotations }], session.inputs));
  dicts(doc).forEach((d, i) => {
    assert.deepEqual(snapshot(d.lookup(name("AP"))), snapshot(originals[i].lookup(name("AP"))));
    assert.deepEqual(snapshot(d.lookup(name("Rect"))), snapshot(originals[i].lookup(name("Rect"))));
    const old = snapshot(originals[i]), next = snapshot(d); delete old["/F"]; delete next["/F"];
    assert.deepEqual(next, old);
  });
});

test("座標変更をUndoで元へ戻した場合と、UI識別子だけの変更では元の注釈を保持する", async () => {
  const { file } = await fixture(); const exporter = createPdfExporter(lib);
  const session = await open(exporter, file);
  const initial = structuredClone(session.annotations[0]);
  session.annotations[0].points[0][0] += 20;
  session.annotations[0] = { ...initial, id: 999 };
  session.annotations[5].appearanceKey = "different-cache-key";
  session.annotations[5].appearancePageIndex = 99;
  // プロパティ順も変え、値の比較であることを確認する。
  session.annotations[1] = Object.fromEntries(Object.entries(session.annotations[1]).reverse());
  const doc = await PDFDocument.load(await exporter.assembleOutputPdf([session.page], session.inputs));
  assert.deepEqual(dicts(doc).map(d => snapshot(d)), dicts(session.doc).map(d => snapshot(d)));
});

test("読み込み後に座標配列を直接変更しても、変更前の状態と比較して編集を保存する", async () => {
  const { file } = await fixture(); const exporter = createPdfExporter(lib);
  const view = reader(1), imported = await exporter.readSourceForEditing(file, view);
  const a = imported.annotations.get(0)[0].annotation;
  const oldX = a.points[0][0]; a.points[0][0] += 17;
  const inputs = await exporter.loadExportSourcePdfs(new Map([[1, { file, reader: view, restoredAnnotations: imported.annotations }]]));
  const annotations = imported.annotations.get(0).map(e => e.annotation);
  const doc = await PDFDocument.load(await exporter.assembleOutputPdf([{ id: "1:0", sourcePdfId: 1, sourceIndex: 0, annotations, addedRotation: 0 }], inputs));
  assert.equal(dicts(doc)[0].lookup(name("Rect")).get(0).asNumber(), oldX + 17 - a.width / 2);
});

test("削除と新規追加は保存され、その他の既存注釈はそのまま残る", async () => {
  const { file } = await fixture(); const exporter = createPdfExporter(lib);
  const session = await open(exporter, file);
  const [fresh] = createAnnotationCopies([session.annotations[0]], {
    viewBox: [0, 0, 320, 420], transform: [1, 0, 0, -1, 0, 420], convertToPdfPoint: (x, y) => [x, 420 - y],
  }, 10, () => 99);
  const annotations = [...session.annotations.slice(1), fresh];
  const doc = await PDFDocument.load(await exporter.assembleOutputPdf([{ ...session.page, annotations }], session.inputs));
  assert.equal(dicts(doc).length, 7);
  assert.deepEqual(dicts(doc).slice(0, 6).map(d => snapshot(d)), dicts(session.doc).slice(1).map(d => snapshot(d)));
  assert(dicts(doc).some(d => d.lookup(name("NM")).decodeText() === fresh.nativeName));
});

test("他文書との結合・ページ回転でも、未編集注釈は元の表示データを保持する", async () => {
  const { file } = await fixture(); const exporter = createPdfExporter(lib);
  const session = await open(exporter, file);
  const blank = await PDFDocument.create(); blank.addPage([200, 200]);
  const other = new Blob([await blank.save()]);
  const inputs = await exporter.loadExportSourcePdfs(new Map([
    [0, { file: other, reader: reader(1) }],
    [1, { file, reader: reader(1), restoredAnnotations: session.imported.annotations }],
  ]));
  const bytes = await exporter.assembleOutputPdf([
    { id: "0:0", sourcePdfId: 0, sourceIndex: 0, annotations: [], addedRotation: 0 },
    { ...session.page, addedRotation: 90 },
  ], inputs);
  const doc = await PDFDocument.load(bytes);
  const copied = doc.getPage(1).node.Annots().asArray().map(ref => doc.context.lookup(ref));
  assert.deepEqual(copied.map(d => snapshot(d)), dicts(session.doc).map(d => snapshot(d)));
  assert.equal(doc.getPage(1).getRotation().angle, 90);
  assert(copied.every(d => d.get(name("P")).toString() === doc.getPage(1).ref.toString()));
  // 同じ入力から再び単独出力しても、結合出力の変更が逆流しない。
  const solo = await PDFDocument.load(await exporter.assembleOutputPdf([session.page], inputs));
  assert.equal(solo.getPage(0).getRotation().angle, 0);
  assert.deepEqual(dicts(solo).map(d => snapshot(d)), dicts(session.doc).map(d => snapshot(d)));
});

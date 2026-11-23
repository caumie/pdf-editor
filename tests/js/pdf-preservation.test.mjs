import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createPdfExporter } from "../../src/js/pdf-export.mjs";
import { createPdfAnnotationCodec } from "../../src/js/pdf-annotations.mjs";
import { pdfGeneratorName } from "../../src/js/pdf-document.mjs";

const require = createRequire(import.meta.url);
const lib = require("../../src/vendor/cantoo-pdf-lib/pdf-lib.min.js");
const { PDFDocument, PDFName, PDFString, PDFDict } = lib;
const name = PDFName.of;
const reader = numPages => ({ numPages, annotationStorage: { setValue() {} } });

async function layered(label, baseState = "ON", explicitOff = true) {
  const doc = await PDFDocument.create();
  doc.setCreator(label);
  const group = doc.context.register(doc.context.obj({ Type: "OCG", Name: PDFString.of("同じ名前"),
    Usage: { Print: { PrintState: "OFF" } } }));
  const page = doc.addPage([300, 400]);
  page.drawText(label, { x: 20, y: 300 });
  page.node.Resources().set(name("Properties"), doc.context.obj({ Hidden: group }));
  doc.catalog.set(name("OCProperties"), doc.context.obj({ OCGs: [group], D: {
    BaseState: baseState, ...(explicitOff ? { OFF: [group] } : {}), Order: [group], Locked: [group],
    AS: [{ Event: "Print", Category: ["Print"], OCGs: [group] }],
  } }));
  const icc = doc.context.register(doc.context.flateStream("profile:" + label, { N: 3 }));
  doc.catalog.set(name("OutputIntents"), doc.context.obj([{ Type: "OutputIntent", S: "GTS_PDFX",
    OutputConditionIdentifier: PDFString.of(label), DestOutputProfile: icc }]));
  doc.catalog.set(name("ViewerPreferences"), doc.context.obj({ PrintScaling: "None" }));
  doc.catalog.set(name("Metadata"), doc.context.register(doc.context.flateStream("metadata:" + label, { Type: "Metadata", Subtype: "XML" })));
  return doc;
}
async function source(doc) {
  const file = new Blob([await doc.save()]);
  return { file, reader: reader(doc.getPageCount()) };
}
const page = (sourcePdfId, sourceIndex = 0) => ({ id: sourcePdfId + ":" + sourceIndex, sourcePdfId, sourceIndex, addedRotation: 0, annotations: [] });
const numbers = array => array.asArray().map(value => value.asNumber());

test("出力文書とXMPはツール自身が生成し、ICC・レイヤー・本文は取り込む", async () => {
  const original = await layered("BASE");
  original.setAuthor("Original author");
  original.catalog.set(name("OpenAction"), original.context.obj([original.getPage(0).ref, "Fit"]));
  original.catalog.set(name("AcroForm"), original.context.obj({ Fields: [] }));
  original.catalog.set(name("Outlines"), original.context.obj({ Type: "Outlines", Count: 0 }));
  const exporter = createPdfExporter(lib);
  const inputs = await exporter.loadExportSourcePdfs(new Map([[1, await source(original)]]));
  const output = await PDFDocument.load(await exporter.assembleOutputPdf([page(1)], inputs), { updateMetadata: false });
  for (const key of ["OCProperties", "OutputIntents", "ViewerPreferences", "Metadata"]) assert(output.catalog.has(name(key)));
  assert.equal(output.catalog.lookup(name("OutputIntents")).lookup(0).lookup(name("OutputConditionIdentifier")).decodeText(), "BASE");
  assert.deepEqual([...output.catalog.lookup(name("OutputIntents")).lookup(0).lookup(name("DestOutputProfile")).getContents()],
    [...original.catalog.lookup(name("OutputIntents")).lookup(0).lookup(name("DestOutputProfile")).getContents()]);
  assert.equal(output.getCreator(), pdfGeneratorName);
  assert.equal(output.getProducer(), pdfGeneratorName);
  assert.equal(output.getAuthor(), "");
  const metadata = new TextDecoder().decode(lib.decodePDFRawStream(output.catalog.lookup(name("Metadata"))).decode());
  assert(metadata.includes("<xmp:CreatorTool>" + pdfGeneratorName + "</xmp:CreatorTool>"));
  assert(!metadata.includes("metadata:BASE"));
  assert(!metadata.includes("pdfaid:") && !metadata.includes("pdfxid:"));
  for (const key of ["OpenAction", "Outlines"]) assert.equal(output.catalog.has(name(key)), false);
  assert.equal(output.catalog.lookup(name("AcroForm")).lookup(name("Fields")).size(), 0);
  assert.equal(output.catalog.lookup(name("ViewerPreferences")).lookup(name("PrintScaling")).decodeText(), "None");
  assert.deepEqual([...output.getPage(0).node.Contents().lookup(0).getContents()], [...original.getPage(0).node.Contents().lookup(0).getContents()]);
});

test("結合でも文書情報はツールが生成し、ICCは先頭元PDF、レイヤー状態は各元PDFから取り込む", async () => {
  const exporter = createPdfExporter(lib);
  const inputs = await exporter.loadExportSourcePdfs(new Map([
    [1, await source(await layered("FIRST", "ON", true))],
    [2, await source(await layered("SECOND", "OFF", false))],
    [3, await source(await layered("THIRD", "ON", false))],
  ]));
  for (const order of [[1, 2, 3], [2, 3, 1]]) {
    const output = await PDFDocument.load(await exporter.assembleOutputPdf(order.map(id => page(id)), inputs));
    assert.equal(output.getCreator(), pdfGeneratorName);
    assert.equal(output.catalog.lookup(name("OutputIntents")).lookup(0).lookup(name("OutputConditionIdentifier")).decodeText(),
      ["FIRST", "SECOND", "THIRD"][order[0] - 1]);
    const properties = output.catalog.lookup(name("OCProperties"));
    const groups = properties.lookup(name("OCGs")).asArray();
    const config = properties.lookup(name("D"));
    assert.equal(groups.length, 3);
    assert.equal(new Set(groups.map(group => group.toString())).size, 3);
    for (const [index, id] of order.entries()) {
      const ref = output.getPage(index).node.Resources().lookup(name("Properties")).get(name("Hidden"));
      assert.equal(groups[index].toString(), ref.toString());
      const off = config.lookup(name("OFF")).asArray().some(group => group.toString() === ref.toString());
      const on = config.lookupMaybe(name("ON"), lib.PDFArray)?.asArray().some(group => group.toString() === ref.toString());
      assert.equal(off || (!on && config.lookup(name("BaseState")).decodeText() === "OFF"), id !== 3);
      const printRule = config.lookup(name("AS")).lookup(index);
      assert.equal(printRule.lookup(name("OCGs")).get(0).toString(), ref.toString());
    }
  }
  // 結合後に同じ入力から単独保存しても、結合した設定が入力へ逆流しない。
  const solo = await PDFDocument.load(await exporter.assembleOutputPdf([page(1)], inputs), { updateMetadata: false });
  assert.equal(solo.catalog.lookup(name("OCProperties")).lookup(name("OCGs")).size(), 1);
});

test("先頭PDFにレイヤーがなくても、後続PDFのOFF設定を取り込む", async () => {
  const plain = await PDFDocument.create(); plain.addPage();
  const exporter = createPdfExporter(lib);
  const inputs = await exporter.loadExportSourcePdfs(new Map([[1, await source(plain)], [2, await source(await layered("HIDDEN", "OFF", false))]]));
  const out = await PDFDocument.load(await exporter.assembleOutputPdf([page(1), page(2)], inputs));
  const properties = out.catalog.lookup(name("OCProperties"));
  const ref = out.getPage(1).node.Resources().lookup(name("Properties")).get(name("Hidden"));
  assert.equal(properties.lookup(name("D")).lookup(name("OFF")).get(0).toString(), ref.toString());
  assert.equal(out.catalog.has(name("OutputIntents")), false);
});

test("未対応・不正なICC設定は採用せず、本文とレイヤーは書き出せる", async () => {
  for (const entry of [{ DestOutputProfileRef: { F: PDFString.of("external.icc") } }, { DestOutputProfile: { N: 3 } }]) {
    const original = await layered("NO EMBEDDED ICC");
    original.catalog.set(name("OutputIntents"), original.context.obj([{ Type: "OutputIntent", S: "GTS_PDFX", ...entry }]));
    const exporter = createPdfExporter(lib);
    const inputs = await exporter.loadExportSourcePdfs(new Map([[1, await source(original)]]));
    const out = await PDFDocument.load(await exporter.assembleOutputPdf([page(1)], inputs), { updateMetadata: false });
    assert.equal(out.catalog.has(name("OutputIntents")), false);
    assert.equal(out.getPageCount(), 1);
    assert.equal(out.catalog.lookup(name("OCProperties")).lookup(name("D")).lookup(name("OFF")).size(), 1);
  }
});

test("ページを並べ替え・削除しても、継承属性と選択したページの本文を保持する", async () => {
  const doc = await PDFDocument.create();
  for (let index = 0; index < 3; index++) doc.addPage([200 + index, 300 + index]).drawText("PAGE " + index);
  const tree = doc.catalog.Pages();
  tree.set(name("Rotate"), lib.PDFNumber.of(90));
  const exporter = createPdfExporter(lib);
  const inputs = await exporter.loadExportSourcePdfs(new Map([[1, await source(doc)]]));
  const out = await PDFDocument.load(await exporter.assembleOutputPdf([page(1, 2), page(1, 0)], inputs));
  assert.deepEqual(out.getPages().map(p => numbers(p.node.MediaBox())), [[0, 0, 202, 302], [0, 0, 200, 300]]);
  assert.deepEqual(out.getPages().map(p => p.getRotation().angle), [90, 90]);
});

test("他ツールの標準注釈は私有識別子なしで復元し、未対応属性とレイヤー付き注釈は本文に残す", async () => {
  const doc = await PDFDocument.create(); const p = doc.addPage([300, 400]);
  const codec = createPdfAnnotationCodec(lib);
  const freeText = doc.context.obj({ Type: "Annot", Subtype: "FreeText", Rect: [20, 40, 200, 100],
    NM: PDFString.of("foreign-text"), Contents: lib.PDFHexString.fromText("日本語の注釈"), DA: PDFString.of("/UnknownFont 16 Tf 0 g"), BS: { W: 0 } });
  const textRef = doc.context.register(freeText); p.node.addAnnot(textRef);
  const restored = codec.read(p, textRef).annotation;
  assert.equal(restored.kind, "text"); assert.equal(restored.text, "日本語の注釈");
  assert.equal(restored.nativeName, "foreign-text"); assert.equal(restored.size, 16);
  const line = doc.context.obj({ Type: "Annot", Subtype: "Line", Rect: [10, 20, 120, 130], L: [10, 20, 120, 130],
    C: [0, 1, 1, 0], BS: { W: 3 }, LE: ["None", "ClosedArrow"] });
  const ref = doc.context.register(line); p.node.addAnnot(ref);
  assert.equal(codec.read(p, ref).annotation.arrowEnd, true);
  assert.equal(codec.read(p, ref).annotation.color, "#ff0000");
  line.delete(name("LE"));
  assert.equal(codec.read(p, ref).annotation.arrowEnd, false);
  const square = doc.context.obj({ Type: "Annot", Subtype: "Square", Rect: [20, 40, 200, 100], IC: [0, 1, 0] });
  const squareRef = doc.context.register(square); p.node.addAnnot(squareRef);
  const filled = codec.read(p, squareRef).annotation;
  assert.equal(filled.fillColor, "#00ff00");
  assert.equal(filled.useFillTransparency, false);
  square.delete(name("IC"));
  const unfilled = codec.read(p, squareRef).annotation;
  assert.equal(unfilled.useFillTransparency, true);
  assert.equal(unfilled.fillTransparency, 100);
  freeText.set(name("OC"), doc.context.obj({ Type: "OCG", Name: PDFString.of("hidden") }));
  assert.equal(codec.read(p, textRef), null);
  line.lookup(name("BS")).set(name("S"), name("D"));
  assert.equal(codec.read(p, ref), null);
});

test("標準注釈の置換でも参照・コメント作者・ポップアップを保ち、削除時は関連注釈も除く", async () => {
  const doc = await PDFDocument.create(); const p = doc.addPage();
  const native = doc.context.obj({ Type: "Annot", Subtype: "Line", Rect: [10, 20, 100, 60], L: [10, 20, 100, 60],
    NM: PDFString.of("foreign-line"), Contents: PDFString.of("review comment"), T: PDFString.of("reviewer"), BS: { W: 2 }, F: 4 });
  const ref = doc.context.register(native); p.node.addAnnot(ref);
  const popup = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Popup", Parent: ref, Rect: [100, 100, 200, 200] }));
  p.node.addAnnot(popup); native.set(name("Popup"), popup);
  const exporter = createPdfExporter(lib); const s = await source(doc);
  s.restoredAnnotations = (await exporter.readSourceForEditing(s.file, s.reader)).annotations;
  const annotation = s.restoredAnnotations.get(0)[0].annotation;
  assert.equal(annotation.kind, "line");
  const inputs = await exporter.loadExportSourcePdfs(new Map([[1, s]]));
  const out = await PDFDocument.load(await exporter.assembleOutputPdf([{ ...page(1), annotations: [{ ...annotation, width: 4 }] }], inputs));
  const refs = out.getPage(0).node.Annots(); const annot = refs.lookup(0, PDFDict);
  assert.equal(annot.lookup(name("T")).decodeText(), "reviewer");
  assert.equal(annot.lookup(name("Contents")).decodeText(), "review comment");
  assert.equal(annot.lookup(name("BS")).lookup(name("W")).asNumber(), 4);
  assert.equal(refs.lookup(1).get(name("Parent")).toString(), refs.get(0).toString());
  const deleted = await PDFDocument.load(await exporter.assembleOutputPdf([page(1)], inputs), { updateMetadata: false });
  assert.equal(deleted.getPage(0).node.Annots().size(), 0);
  const blank = await PDFDocument.create(); blank.addPage();
  const mergedInputs = await exporter.loadExportSourcePdfs(new Map([[0, await source(blank)], [1, s]]));
  const merged = await PDFDocument.load(await exporter.assembleOutputPdf([
    page(0), { ...page(1), annotations: [{ ...annotation, width: 5 }] },
  ], mergedInputs));
  const imported = merged.getPage(1); const importedRefs = imported.node.Annots();
  assert.equal(importedRefs.lookup(0).get(name("P")).toString(), imported.ref.toString());
  assert.equal(importedRefs.lookup(1).get(name("Parent")).toString(), importedRefs.get(0).toString());
  assert.equal(importedRefs.lookup(0).lookup(name("BS")).lookup(name("W")).asNumber(), 5);
});

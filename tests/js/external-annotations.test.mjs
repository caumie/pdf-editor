import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createPdfExporter } from "../../src/js/pdf-export.mjs";
import { createExternalAnnotationCodec } from "../../src/js/external-annotations.mjs";
import { createPdfAnnotationCodec, makeAnnotationName } from "../../src/js/pdf-annotations.mjs";
import { annotationBounds, annotationHandles, lineArrowPoints, translateAnnotation, resizeExternalAnnotation } from "../../src/js/annotations.mjs";

const require = createRequire(import.meta.url);
const lib = require("../../src/vendor/cantoo-pdf-lib/pdf-lib.min.js");
const { PDFDocument, PDFName, PDFNumber, PDFString, PDFDict } = lib;
const name = PDFName.of;

async function fixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([320, 420]);
  page.drawText("Keep page content", { x: 20, y: 395 });
  const appearance = doc.context.register(doc.context.flateStream("0 0 1 RG 3 w 0 0 m 100 30 l S", {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 30], Resources: {},
  }));
  const annotation = doc.context.obj({
    Type: "Annot", Subtype: "Line", Rect: [18, 28, 122, 62], L: [20, 30, 120, 60], F: 4,
    NM: PDFString.of("Acrobat-line-1"), T: PDFString.of("Reviewer"),
    Contents: PDFString.of("Original comment"), C: [0, 0, 1], BS: { W: 3, S: "D", D: [3, 2] },
    LE: ["None", "ClosedArrow"], AP: { N: appearance },
  });
  const ref = doc.context.register(annotation);
  page.node.addAnnot(ref);
  const popup = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Popup", Rect: [140, 40, 260, 180], Parent: ref }));
  annotation.set(name("Popup"), popup);
  page.node.addAnnot(popup);
  return { doc, page, annotation, ref };
}

function reader(numPages = 1) {
  return { numPages, annotationStorage: { setValue() {} } };
}

test("外部の注釈は元の表示・コメント属性を保持して移動し、往復後も移動量を重ねない", async () => {
  const { doc } = await fixture();
  const file = new Blob([await doc.save()]);
  const exporter = createPdfExporter(lib);
  const restored = (await exporter.readSourceForEditing(file, reader())).annotations;
  const entry = restored.get(0)[0];
  assert.equal(entry.annotation.kind, "external");
  assert.equal(entry.annotation.subtype, "Line");
  const moved = translateAnnotation(entry.annotation, 25, -10);
  const sources = await exporter.loadExportSourcePdfs(new Map([[1, { file, reader: reader(), restoredAnnotations: restored }]]));
  const pages = [{ id: "1:0", sourcePdfId: 1, sourceIndex: 0, addedRotation: 90, annotations: [moved] }];
  const bytes = await exporter.assembleOutputPdf(pages, sources);
  const reopened = await PDFDocument.load(bytes);
  const out = reopened.getPage(0);
  const native = out.node.Annots().lookup(0, PDFDict);
  assert.deepEqual(native.lookup(name("L")).asArray().map(value => value.asNumber()), [45, 20, 145, 50]);
  assert.equal(native.lookup(name("NM")).decodeText(), "Acrobat-line-1");
  assert.equal(native.lookup(name("Contents")).decodeText(), "Original comment");
  assert.equal(native.lookup(name("T")).decodeText(), "Reviewer");
  assert.equal(native.lookup(name("F")).asNumber(), 4);
  assert.deepEqual([...native.lookup(name("AP")).lookup(name("N")).getContents()],
    [...(await PDFDocument.load(await file.arrayBuffer())).getPage(0).node.Annots().lookup(0).lookup(name("AP")).lookup(name("N")).getContents()]);
  assert.equal(out.getRotation().angle, 90);
  const secondFile = new Blob([bytes]);
  const secondRestored = (await exporter.readSourceForEditing(secondFile, reader())).annotations;
  assert.equal(secondRestored.get(0)[0].annotation.offsetX, 0);
  assert.deepEqual(secondRestored.get(0)[0].annotation.rect, moved.rect);
  const secondInputs = await exporter.loadExportSourcePdfs(new Map([[1, { file: secondFile, reader: reader(), restoredAnnotations: secondRestored }]]));
  const second = await PDFDocument.load(await exporter.assembleOutputPdf([
    { ...pages[0], addedRotation: 0, annotations: [secondRestored.get(0)[0].annotation] },
  ], secondInputs));
  assert.deepEqual(second.getPage(0).node.Annots().lookup(0).lookup(name("L")).asArray().map(value => value.asNumber()), [45, 20, 145, 50]);
  const deleted = await PDFDocument.load(await exporter.assembleOutputPdf([{ ...pages[0], annotations: [] }], sources));
  assert.equal(deleted.getPage(0).node.Annots().size(), 0);
});

test("ReadOnly・Locked・LockedContentsは選択可能なロックとして復元し、非表示は除外する", async () => {
  const { doc, annotation } = await fixture();
  const exporter = createPdfExporter(lib);
  for (const flag of [1, 2, 32]) {
    annotation.set(name("F"), PDFNumber.of(4 | flag));
    assert.equal(((await exporter.readSourceForEditing(new Blob([await doc.save()]), reader())).annotations).size, 0);
  }
  for (const flag of [64, 128, 512, 64 | 128 | 512]) {
    annotation.set(name("F"), PDFNumber.of(4 | flag));
    const restored = (await exporter.readSourceForEditing(new Blob([await doc.save()]), reader())).annotations;
    assert.equal(restored.get(0)[0].annotation.locked, true);
    assert.equal(restored.get(0)[0].annotation.kind, "external");
  }
});

test("表示専用PDFの生成は元のAPと複数の筆跡を保持する", async () => {
  const { doc, annotation } = await fixture();
  annotation.set(name("Subtype"), name("Ink"));
  annotation.set(name("InkList"), doc.context.obj([[20, 30, 40, 50], [70, 40, 120, 60]]));
  const file = new Blob([await doc.save()]);
  const exporter = createPdfExporter(lib);
  let appearanceBytes;
  const restored = (await exporter.readSourceForEditing(file, reader(), bytes => { appearanceBytes = bytes; })).annotations;
  assert.equal(restored.get(0)[0].annotation.appearancePageIndex, 0);
  const appearances = await PDFDocument.load(appearanceBytes);
  assert.equal(appearances.getPageCount(), 1);
  assert.equal(appearances.getPage(0).node.Annots(), undefined);
  const inputs = await exporter.loadExportSourcePdfs(new Map([[1, { file, reader: reader(), restoredAnnotations: restored }]]));
  const result = await PDFDocument.load(await exporter.assembleOutputPdf([
    { id: "1:0", sourcePdfId: 1, sourceIndex: 0, addedRotation: 0, annotations: [translateAnnotation(restored.get(0)[0].annotation, 5, 6)] },
  ], inputs));
  const ink = result.getPage(0).node.Annots().lookup(0).lookup(name("InkList"));
  assert.deepEqual(ink.asArray().map(stroke => stroke.asArray().map(value => value.asNumber())), [[25, 36, 45, 56], [75, 46, 125, 66]]);
});

test("範囲外の注釈も表示データから選択でき、リンク・フォームとポップアップは独立操作しない", async () => {
  const { doc, annotation } = await fixture();
  const exporter = createPdfExporter(lib);
  for (const subtype of ["Circle", "Stamp", "Polygon", "PolyLine", "Underline", "Squiggly", "StrikeOut", "Caret", "CustomMarkup"]) {
    annotation.set(name("Subtype"), name(subtype));
    const restored = (await exporter.readSourceForEditing(new Blob([await doc.save()]), reader())).annotations;
    assert.equal(restored.get(0)[0].annotation.subtype, subtype);
    assert.equal(annotationHandles(restored.get(0)[0].annotation, 1).length, 4);
  }
  for (const subtype of ["Link", "Widget", "Popup"]) {
    annotation.set(name("Subtype"), name(subtype));
    assert.equal(((await exporter.readSourceForEditing(new Blob([await doc.save()]), reader())).annotations).size, 0);
  }
});

test("変形と移動を合成して保存し、APは保持したまま座標を一度だけ変換する", async () => {
  const { doc } = await fixture();
  const file = new Blob([await doc.save()]);
  const exporter = createPdfExporter(lib);
  const restored = (await exporter.readSourceForEditing(file, reader())).annotations;
  const original = restored.get(0)[0].annotation;
  const moved = translateAnnotation(original, 7, -5);
  const scaled = resizeExternalAnnotation(moved, 25, 23, 2, .5);
  const current = translateAnnotation(scaled, 3, 4);
  assert.deepEqual(current.rect, [28, 27, 236, 44]);
  assert.equal(current.scaleX, 2);
  assert.equal(current.scaleY, .5);
  assert.deepEqual(original.rect, [18, 28, 122, 62]);
  const sources = await exporter.loadExportSourcePdfs(new Map([[1, { file, reader: reader(), restoredAnnotations: restored }]]));
  const page = { id: "1:0", sourcePdfId: 1, sourceIndex: 0, addedRotation: 0, annotations: [current] };
  const bytes = await exporter.assembleOutputPdf([page], sources);
  const result = await PDFDocument.load(bytes);
  const native = result.getPage(0).node.Annots().lookup(0);
  assert.deepEqual(native.lookup(name("Rect")).asArray().map(number => number.asNumber()), current.rect);
  assert.deepEqual(native.lookup(name("L")).asArray().map(number => number.asNumber()), [32, 28, 232, 43]);
  const originalDoc = await PDFDocument.load(await file.arrayBuffer());
  assert.deepEqual([...native.lookup(name("AP")).lookup(name("N")).getContents()],
    [...originalDoc.getPage(0).node.Annots().lookup(0).lookup(name("AP")).lookup(name("N")).getContents()]);
  assert.equal(native.lookup(name("Contents")).decodeText(), "Original comment");
  const reloadedFile = new Blob([bytes]);
  const reloaded = (await exporter.readSourceForEditing(reloadedFile, reader())).annotations;
  assert.equal(reloaded.get(0)[0].annotation.scaleX, 1);
  assert.equal(reloaded.get(0)[0].annotation.scaleY, 1);
  assert.equal(reloaded.get(0)[0].annotation.offsetX, 0);
  const again = await exporter.loadExportSourcePdfs(new Map([[1, { file: reloadedFile, reader: reader(), restoredAnnotations: reloaded }]]));
  const unchanged = await PDFDocument.load(await exporter.assembleOutputPdf([
    { ...page, annotations: [reloaded.get(0)[0].annotation] },
  ], again));
  assert.deepEqual(unchanged.getPage(0).node.Annots().lookup(0).lookup(name("L")).asArray().map(number => number.asNumber()), [32, 28, 232, 43]);
});

test("矢印は標準Line注釈の終点属性と表示データの両方に保存される", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const codec = createPdfAnnotationCodec(lib);
  const annotation = { kind: "line", id: 1, nativeName: makeAnnotationName("line"), points: [[30, 50], [170, 50]],
    width: 3, color: "#ff0000", strokeTransparency: 25, arrowEnd: true };
  assert.equal(lineArrowPoints(annotation).length, 3);
  assert(annotationBounds(annotation).height > 0);
  await codec.write(doc, page, annotation);
  const ref = page.node.Annots().get(0);
  const native = doc.context.lookup(ref);
  assert.deepEqual(native.lookup(name("LE")).asArray().map(value => value.decodeText()), ["None", "ClosedArrow"]);
  assert.equal(codec.read(page, ref).annotation.arrowEnd, true);
  const bounds = native.lookup(name("Rect")).asArray().map(value => value.asNumber());
  assert(bounds[3] > bounds[1]);
  assert.equal(createExternalAnnotationCodec(lib).read(page, ref).annotation.subtype, "Line");
});


test("PDF.jsのSet型権限でも、許可された標準・外部注釈を初回から復元する", async () => {
  for (const external of [false, true]) {
    const { doc, annotation } = await fixture();
    if (!external) annotation.set(name("BS"), doc.context.obj({ W: 3, S: "S" }));
    const file = new Blob([await doc.save()]);
    const exporter = createPdfExporter(lib);
    for (const permissions of [[4, 16, 32], new Set([4, 16, 32])]) {
      const restored = (await exporter.readSourceForEditing(file, { ...reader(), getPermissions: async () => permissions })).annotations;
      assert.equal(restored.get(0).length, 1);
      assert.equal(restored.get(0)[0].annotation.kind, external ? "external" : "line");
    }
  }
});
test("文書の注釈変更権限がなくても、標準・外部注釈を初回から復元する", async () => {
  const { doc } = await fixture();
  const exporter = createPdfExporter(lib);
  for (const permissions of [new Set([4, 16]), new Set(), [4, 16], null]) {
    const restored = (await exporter.readSourceForEditing(new Blob([await doc.save()]), { ...reader(), getPermissions: async () => permissions })).annotations;
    assert.equal(restored.get(0).length, 1);
  }
});

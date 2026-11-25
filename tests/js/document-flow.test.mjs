import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createContext } from "node:vm";
import { installEditorHandler } from "./editor-fixture.mjs";
import { createPageActions } from "../../src/js/page-actions.mjs";
import { createDocumentHistory } from "../../src/js/document-history.mjs";
import { changeDocumentAnnotations, placeDocumentPages, rotateDocumentPages } from "../../src/js/document-pages.mjs";
import { createExportPlan } from "../../src/js/export-job.mjs";
import { clientToPdfPoint } from "../../src/js/page-coordinates.mjs";
import { createPdfAnnotationCodec, makeAnnotationName } from "../../src/js/pdf-annotations.mjs";
import { createPdfExporter } from "../../src/js/pdf-export.mjs";
import { createAnnotationCopies } from "../../src/js/annotation-clipboard.mjs";

const require = createRequire(import.meta.url);
const pdfLib = require("../../src/vendor/cantoo-pdf-lib/pdf-lib.min.js");

test("コピーは別の注釈として保存され、ハイライトの座標も独立して複製される", async () => {
  const originals = [
    { id: 1, nativeName: makeAnnotationName("line"), kind: "line", points: [[30, 50], [80, 90]], color: "#ff0000", width: 2, strokeTransparency: 10 },
    { id: 2, nativeName: makeAnnotationName("highlight"), kind: "highlight", quads: [[[30, 120], [90, 120], [30, 110], [90, 110]]], color: "#ffe34f", fillTransparency: 45 },
  ];
  const viewport = { viewBox: [10, 20, 210, 320], transform: [1, 0, 0, -1, -10, 320], convertToPdfPoint: (x, y) => [x + 10, 320 - y] };
  let nextId = 3;
  const copies = createAnnotationCopies(originals, viewport, 12, () => nextId++);
  assert.deepEqual(copies[0].points, [[42, 38], [92, 78]]);
  assert.deepEqual(copies[1].quads[0][0], [42, 108]);
  assert.notEqual(copies[1].quads[0], originals[1].quads[0]);
  assert.notEqual(copies[0].points[0], originals[0].points[0]);
  assert.equal(new Set([...originals, ...copies].map(annotation => annotation.nativeName)).size, 4);
  assert.deepEqual(copies.map(annotation => annotation.id), [3, 4]);

  const doc = await pdfLib.PDFDocument.create();
  const page = doc.addPage([240, 340]);
  const codec = createPdfAnnotationCodec(pdfLib);
  for (const annotation of [...originals, ...copies]) await codec.write(doc, page, annotation);
  const file = new Blob([await doc.save()]);
  const exporter = createPdfExporter(pdfLib);
  const reader = { numPages: 1, annotationStorage: { setValue() {} } };
  const restored = (await exporter.readSourceForEditing(file, reader)).annotations;
  assert.equal(restored.get(0).length, 4);
  assert.deepEqual(restored.get(0)[3].annotation.quads, copies[1].quads);
  copies[1].quads[0][0][0] = 0;
  assert.equal(originals[1].quads[0][0][0], 30);
});

test("貼り付け位置は回転と切り抜き範囲に従い、複数の書き込みの間隔を保つ", () => {
  const originals = [
    { kind: "line", points: [[40, 50], [60, 70]] },
    { kind: "rect", points: [[70, 80], [90, 90]] },
  ];
  let nextId = 1;
  const rotated = { viewBox: [10, 20, 110, 120], transform: [0, 2, 2, 0, -40, -20], convertToPdfPoint: (x, y) => [y / 2 + 10, x / 2 + 20] };
  const copies = createAnnotationCopies(originals, rotated, 12, () => nextId++);
  assert.deepEqual(copies[0].points[0], [52, 62]);
  assert.deepEqual(copies[1].points[0], [82, 92]);
  const fitted = createAnnotationCopies(originals, rotated, 120, () => nextId++);
  assert.deepEqual(fitted[0].points[0], [60, 80]);
  assert.deepEqual(fitted[1].points[1], [110, 120]);
  assert.deepEqual(originals[0].points[0], [40, 50]);
});

test("文書の履歴はページの版だけを戻し、書き出しは確定したページを使う", () => {
  const history = createDocumentHistory();
  const sourceFiles = new Map([
    [1, { file: { name: "資料.pdf" } }],
    [2, { file: { name: "添付.pdf" } }],
  ]);
  const firstPage = { id: "a", sourcePdfId: 1, addedRotation: 0, annotations: [] };
  const secondPage = { id: "b", sourcePdfId: 2, addedRotation: 0, annotations: [] };
  const selected = new Set(["b"]);
  history.commit([firstPage, secondPage]);
  history.commit(placeDocumentPages(history.pages, selected, "a", false));
  history.commit(rotateDocumentPages(history.pages, selected, -90));
  history.commit(changeDocumentAnnotations(history.pages, "b", annotations => [...annotations, { id: 1 }]));

  const plan = createExportPlan(history.pages, selected, sourceFiles, {
    selectionOnly: true, customName: "", extension: "jpg", layout: "zip", imageDpi: 600,
  });
  assert.equal(plan.name, "添付_edit");
  assert.deepEqual([...plan.sources.keys()], [2]);
  assert.equal(plan.pages[0].addedRotation, 270);
  assert.equal(plan.dpi, 600);
  assert.equal(history.step("undo"), true);
  assert.equal(history.pages[0].annotations.length, 0);
  assert.equal(plan.pages[0].annotations.length, 1);
  assert.equal(history.step("redo"), true);
  assert.equal(history.pages[0].annotations.length, 1);
});

test("拡大表示中のCSS座標を、回転・切り抜き済みのPDF座標に戻す", () => {
  const viewport = { width: 120, height: 180, convertToPdfPoint: (x, y) => [y + 10, x + 30] };
  const bounds = { left: 20, top: 50, width: 240, height: 360 };
  assert.deepEqual(clientToPdfPoint(140, 230, bounds, viewport), [100, 90]);
  assert.deepEqual(clientToPdfPoint(500, 0, bounds, viewport, true), [10, 150]);
});

test("PDFのCreatorと補助情報が変わっても、注釈を識別して重複なく戻す", async () => {
  const { PDFDocument, PDFName, PDFHexString, PDFNumber } = pdfLib;
  const doc = await PDFDocument.create();
  doc.setCreator("Another PDF viewer");
  const page = doc.addPage([240, 340]);
  page.drawText("Keep this page content", { x: 12, y: 320 });
  const codec = createPdfAnnotationCodec(pdfLib);
  const nativeName = makeAnnotationName("line");
  await codec.write(doc, page, {
    id: 1, nativeName, kind: "line", points: [[15, 20], [95, 65]],
    color: "#ff0000", width: 2, strokeTransparency: 10,
  });
  const [ref] = page.node.Annots().asArray();
  const annot = doc.context.lookup(ref);
  annot.delete(PDFName.of("PDFPageEditorV1"));
  annot.set(PDFName.of("C"), doc.context.obj([0, 0, 1]));
  annot.set(PDFName.of("CA"), PDFNumber.of(0.6));
  const other = doc.context.register(doc.context.obj({
    Type: "Annot", Subtype: "Text", Rect: [2, 2, 10, 10],
    Contents: PDFHexString.fromText("An annotation from elsewhere"),
  }));
  page.node.addAnnot(other);

  const file = new Blob([await doc.save()]);
  const hidden = new Map();
  const reader = { numPages: 1, annotationStorage: { setValue: (id, value) => hidden.set(id, value) } };
  const exporter = createPdfExporter(pdfLib);
  const restored = (await exporter.readSourceForEditing(file, reader)).annotations;
  const [{ annotation, refId }] = restored.get(0);
  assert.equal(annotation.nativeName, nativeName);
  assert.equal(annotation.strokeTransparency, 40);
  assert.equal(annotation.color, "#0000ff");
  assert.deepEqual(hidden.get(refId), { noView: true });

  const sources = await exporter.loadExportSourcePdfs(new Map([
    [1, { file, reader, restoredAnnotations: restored }],
  ]));
  const bytes = await exporter.assembleOutputPdf([
    { id: "1:0", sourcePdfId: 1, sourceIndex: 0, addedRotation: 90, annotations: [annotation] },
  ], sources);
  const reopened = await PDFDocument.load(bytes);
  const outputPage = reopened.getPage(0);
  assert.equal(outputPage.getRotation().angle, 90);
  const refs = outputPage.node.Annots().asArray();
  assert.equal(refs.length, 2);
  const outputs = refs.map(ref => reopened.context.lookup(ref));
  assert.deepEqual(outputs.map(dict => dict.get(PDFName.of("Subtype")).decodeText()), ["Line", "Text"]);
  assert.equal(codec.read(outputPage, refs[0]).annotation.nativeName, nativeName);
});


test("挿入マーカーが消えた後にドロップしても、一覧と書き出し順を更新する", () => {
  const documentHistory = createDocumentHistory();
  documentHistory.commit(["a", "b", "c"].map(id => ({ id })));
  const pageView = { selectedPageIds: new Set(["a"]), previewPageId: "a" };
  const workspace = { busy: false };
  const updates = [];
  const actions = createPageActions({
    documentHistory, pageView, workspace,
    refreshDocumentViews: () => updates.push(documentHistory.pages.map(page => page.id)),
  });
  const listeners = new Map();
  const grid = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    contains: element => Boolean(element),
  };
  const context = createContext({ ui: { "page-grid": grid }, workspace, reorderPagesByDrop: actions.reorderPagesByDrop });
  installEditorHandler(context, "bindPageDrag");
  context.bindPageDrag();
  const card = id => ({ dataset: { id }, getBoundingClientRect: () => ({ left: 0, width: 100 }) });
  const source = card("a"), destination = card("c");
  const dataTransfer = { setData() {} };
  const emit = (type, target) => {
    const event = {
      target: { closest: () => target }, clientX: 75, dataTransfer,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
    };
    listeners.get(type)(event);
    return event;
  };
  emit("dragstart", source);
  assert.equal(emit("dragover", destination).stopped, true);
  assert.equal(dataTransfer.dropEffect, "move");
  assert.equal(destination.dataset.drop, "after");
  emit("dragleave", destination);
  assert.equal(destination.dataset.drop, undefined);
  assert.equal(emit("drop", destination).stopped, true);
  assert.deepEqual(updates, [["b", "c", "a"]]);
  assert.deepEqual(documentHistory.pages.map(page => page.id), ["b", "c", "a"]);
  assert.equal(pageView.previewPageId, "a");
  documentHistory.step("undo");
  assert.deepEqual(documentHistory.pages.map(page => page.id), ["a", "b", "c"]);
});

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createContext } from "node:vm";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { renderStats } from "../support/render-pdfjs.mjs";
import { installEditorHandler } from "./editor-fixture.mjs";
import { loadStampImage, placeImageStamp } from "../../src/js/image-stamp.mjs";
import { imageFormatForType, readImageDpi } from "../../src/js/image-import.mjs";
import { makeAnnotationName } from "../../src/js/pdf-annotations.mjs";
import { createPdfExporter } from "../../src/js/pdf-export.mjs";
import { clientToPdfPoint } from "../../src/js/page-coordinates.mjs";
import { translateAnnotation } from "../../src/js/annotations.mjs";

const lib = createRequire(import.meta.url)("../../src/vendor/cantoo-pdf-lib/pdf-lib.min.js");

test("一覧と用紙にだけファイルを振り分け、書き込み無効時と右へのPDF投入を無視する", async () => {
  const handlers = new Map(), imports = [], stamps = [];
  class Node {
    classList = new Set();
    focus() { this.focused = true; }
  }
  const list = new Node(), paper = new Node(), stage = new Node();
  for (const node of [list, paper, stage]) node.classList.remove = node.classList.delete.bind(node.classList);
  let editable = false;
  const context = createContext({
    Node, imageFormatForType,
    window: { addEventListener: (type, callback) => handlers.set(type, callback) },
    ui: { "page-area": list, "preview-stage": stage, "pages-panel": { contains: target => target === list } },
    workspaceAvailable: () => true,
    sourceImageFormat: file => file.type === "image/png" ? "PNG" : null,
    stampDropTarget: event => editable && event.target === paper ? { element: paper } : null,
    addDroppedStamp: async file => { stamps.push(file); },
    importDocumentFiles: async files => { imports.push(...files); },
  });
  installEditorHandler(context, "bindFileDrop");
  context.bindFileDrop();
  const image = { name: "mark.png", type: "image/png" };
  const pdf = { name: "pages.pdf", type: "application/pdf" };
  const send = async (type, target, ...files) => {
    const dataTransfer = { types: [], files,
      items: files.map(file => ({ kind: "file", type: file.type })) };
    await handlers.get(type)({ target, dataTransfer, preventDefault() {} });
    return dataTransfer.dropEffect;
  };
  assert.equal(await send("dragover", list, pdf), "copy");
  assert.equal(list.classList.has("file-drop-active"), true);
  assert.equal(await send("dragover", paper, image), "none");
  assert.equal(list.classList.has("file-drop-active"), false);
  await send("drop", paper, image);
  editable = true;
  assert.equal(await send("dragover", paper, pdf), "none");
  assert.equal(await send("dragover", paper, image, image), "none");
  await send("drop", paper, pdf);
  await send("drop", {}, pdf);
  assert.equal(await send("dragover", paper, image), "copy");
  assert.equal(stage.classList.has("file-drop-active"), true);
  assert.equal(paper.classList.has("file-drop-active"), false);
  assert.equal(await send("dragover", stage, image), "none");
  assert.equal(stage.classList.has("file-drop-active"), false);
  await send("dragover", paper, image);
  await send("drop", paper, image);
  assert.equal(stage.classList.has("file-drop-active"), false);
  await send("drop", list, pdf, image);
  assert.deepEqual(imports, [pdf, image]);
  const gif = { name: "animation.gif", type: "image/gif" };
  assert.equal(await send("dragover", list, gif), "none");
  assert.equal(await send("dragover", paper, gif), "none");
  const osImage = { name: "mark", type: "public.png" };
  assert.equal(await send("dragover", paper, osImage), "copy");
  await send("drop", paper, osImage);
  assert.deepEqual(stamps, [image, osImage]);
  assert.equal(list.focused, true);
});

test("外部ドロップのイベントが用紙以外を指していても、表示座標から用紙を選ぶ", () => {
  const stage = { clientWidth: 200, clientHeight: 100, getBoundingClientRect: () => ({ left: 300, top: 10 }) };
  const left = { getBoundingClientRect: () => ({ left: 320, top: 0, right: 390, bottom: 140, width: 70, height: 140 }) };
  const right = { getBoundingClientRect: () => ({ left: 400, top: 0, right: 510, bottom: 140, width: 110, height: 140 }) };
  const viewport = { width: 220, height: 280, convertToPdfPoint: (x, y) => [x, 280 - y] };
  const model = { id: "right", addedRotation: 0 };
  const context = createContext({
    ui: { "preview-sheet": { hidden: false }, "preview-edit-bars": { hidden: false }, "mark-dialog": { open: false } },
    previewStage: stage, documentHistory: { pages: [model] }, clientToPdfPoint,
    preview: { bitmap: {}, rendering: true, stampTargets: [
      { element: left, pageId: "left", addedRotation: 0, entry: { viewport } },
      { element: right, pageId: model.id, addedRotation: 0, entry: { viewport } },
    ] },
  });
  installEditorHandler(context, "stampDropTarget");
  const hit = (clientX, clientY) => context.stampDropTarget({ target: stage, clientX, clientY });
  assert.equal(hit(430, 50).element, right);
  assert(Math.abs(hit(430, 50).point[0] - 60) < 1e-9);
  assert.equal(hit(430, 50).point[1], 180);
  assert.equal(hit(395, 50), null);
  assert.equal(hit(505, 50), null);
  assert.equal(hit(430, 5), null);
  model.addedRotation = 90;
  assert.equal(hit(430, 50), null);
  model.addedRotation = 0;
  context.ui["preview-edit-bars"].hidden = true;
  assert.equal(hit(430, 50), null);
  context.ui["preview-edit-bars"].hidden = false;
  context.preview.bitmap = null;
  assert.equal(hit(430, 50), null);
});

test("PNGのpHYsとJPEGのJFIFからDPIを読み、単位がない場合は96 DPIとする", () => {
  const png = Buffer.alloc(29);
  png.writeUInt32BE(9, 8);
  png.write("pHYs", 12);
  png.writeUInt32BE(23622, 16);
  png.writeUInt32BE(11811, 20);
  png[24] = 1;
  assert.deepEqual(readImageDpi(png, "PNG").map(Math.round), [600, 300]);
  png[24] = 0;
  assert.deepEqual(readImageDpi(png, "PNG"), [96, 96]);

  const jpeg = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 1,
    2, 88, 1, 44, 0, 0, 255, 217]);
  assert.deepEqual(readImageDpi(jpeg, "JPEG"), [600, 300]);
  jpeg[13] = 2;
  assert.deepEqual(readImageDpi(jpeg, "JPEG"), [1524, 762]);

  const payload = Buffer.alloc(92);
  payload.set([255, 216, 255, 225, 0, 86]);
  payload.write("Exif\0\0", 6);
  payload.write("II", 12);
  payload.writeUInt16LE(42, 14);
  payload.writeUInt32LE(8, 16);
  payload.writeUInt16LE(4, 20);
  // 有理数はIFDの後に置く。オフセットの基準はTIFFヘッダー。
  const fields = [[0x0112, 3, 6], [0x011a, 5, 62], [0x011b, 5, 70], [0x0128, 3, 2]];
  for (const [index, [tag, type, value]] of fields.entries()) {
    const offset = 22 + index * 12;
    payload.writeUInt16LE(tag, offset);
    payload.writeUInt16LE(type, offset + 2);
    payload.writeUInt32LE(1, offset + 4);
    payload.writeUInt32LE(value, offset + 8);
  }
  payload.writeUInt32LE(600, 74);
  payload.writeUInt32LE(1, 78);
  payload.writeUInt32LE(300, 82);
  payload.writeUInt32LE(1, 86);
  assert.deepEqual(readImageDpi(payload, "JPEG"), [300, 600]);
});

test("画像は元の画素数で保持し、DPIで決めた寸法を用紙に合わせて縮める", async () => {
  const header = Buffer.alloc(29);
  header.set([137, 80, 78, 71, 13, 10, 26, 10]);
  header.writeUInt32BE(9, 8);
  header.write("pHYs", 12);
  header.writeUInt32BE(23622, 16);
  header.writeUInt32BE(23622, 20);
  header[24] = 1;
  const canvas = { getContext: () => ({ drawImage() {} }), toBlob: callback => callback(new Blob([header])) };
  globalThis.createImageBitmap = async () => ({ width: 3000, height: 1200, close() {} });
  globalThis.document = { createElement: () => canvas };
  try {
    const image = await loadStampImage(new Blob([header]));
    assert.equal(canvas.width, 3000);
    assert.equal(canvas.height, 1200);
    const stamp = placeImageStamp(image, [0, 0], { rotation: 0, viewBox: [0, 0, 500, 500] });
    assert(Math.abs(stamp.points[1][0] * 2 - 360) < 0.01);
    assert(Math.abs(stamp.points[1][1] * 2 - 144) < 0.01);
    const fitted = placeImageStamp(image, [0, 0], { rotation: 90, userUnit: 2, viewBox: [0, 0, 500, 125] });
    assert.deepEqual(fitted.points, [[-25, -62.5], [25, 62.5]]);
  } finally {
    delete globalThis.createImageBitmap;
    delete globalThis.document;
  }
});

test("回転ページの透明PNGをPDFスタンプとして描画し、再読込して移動できる", async () => {
  globalThis.createImageBitmap = async blob => loadImage(Buffer.from(await blob.arrayBuffer()));
  const canvas = createCanvas(80, 40);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "red";
  ctx.fillRect(0, 0, 40, 40);
  const image = new Uint8Array(canvas.toBuffer("image/png"));
  const doc = await lib.PDFDocument.create();
  const page = doc.addPage([200, 300]);
  page.setRotation(lib.degrees(90));
  const blank = await doc.save();
  const exporter = createPdfExporter(lib);

  async function session(bytes) {
    const file = new Blob([bytes]);
    const reader = { numPages: 1, annotationStorage: { setValue() {} } };
    const restored = await exporter.readSourceForEditing(file, reader, async () => {});
    const inputs = await exporter.loadExportSourcePdfs(new Map([[1, { file, reader, restoredAnnotations: restored.annotations }]]));
    return { inputs, annotations: (restored.annotations.get(0) ?? []).map(entry => entry.annotation) };
  }

  const { prepareStampBitmap } = await import("../../src/js/image-stamp.mjs");
  await prepareStampBitmap(image);
  const stamp = { ...placeImageStamp(image, [100, 140], { rotation: 90, viewBox: [0, 0, 200, 300] }),
    nativeName: makeAnnotationName("stamp") };
  const model = { id: "1:0", sourcePdfId: 1, sourceIndex: 0, addedRotation: 0, annotations: [stamp] };
  const first = await exporter.assembleOutputPdf([model], (await session(blank)).inputs);
  assert.notDeepEqual(await renderStats(first), await renderStats(blank));
  const restored = await session(first);
  assert.equal(restored.annotations.length, 1);
  assert.equal(restored.annotations[0].kind, "stamp");
  assert.equal(restored.annotations[0].rotation, 90);
  assert.deepEqual(restored.annotations[0].image, image);
  assert.deepEqual(restored.annotations[0].points, stamp.points);
  const moved = translateAnnotation(restored.annotations[0], 10, 20);
  const second = await exporter.assembleOutputPdf([{ ...model, annotations: [moved] }], restored.inputs);
  const reopened = await session(second);
  assert.equal(reopened.annotations.length, 1);
  assert.deepEqual(reopened.annotations[0].points, moved.points);
  assert.notDeepEqual(await renderStats(second), await renderStats(first));

  const copied = { ...translateAnnotation(stamp, 10, 20), nativeName: makeAnnotationName("stamp") };
  const duplicates = await exporter.assembleOutputPdf([
    { ...model, annotations: [stamp, copied] },
  ], (await session(blank)).inputs);
  const saved = await lib.PDFDocument.load(duplicates);
  const refs = saved.getPage(0).node.Annots();
  const sourceKey = lib.PDFName.of("PPEStampImage");
  assert.equal(refs.size(), 2);
  assert.equal(refs.lookup(0).get(sourceKey).toString(), refs.lookup(1).get(sourceKey).toString());
  const appearanceImage = annotation => annotation.lookup(lib.PDFName.of("AP"))
    .lookup(lib.PDFName.of("N")).dict.lookup(lib.PDFName.of("Resources"))
    .lookup(lib.PDFName.of("XObject")).get(lib.PDFName.of("StampImage")).toString();
  assert.equal(appearanceImage(refs.lookup(0)), appearanceImage(refs.lookup(1)));
});

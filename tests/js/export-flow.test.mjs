import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { crc32 } from "node:zlib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createPdfExporter } from "../../src/js/pdf-export.mjs";
import { createExportPlan, createExportRunner, sameExportPlan } from "../../src/js/export-job.mjs";
import { exportPageImage, ImageExportError } from "../../src/js/image-export.mjs";

const require = createRequire(import.meta.url);
const pdfLib = require("../../src/vendor/cantoo-pdf-lib/pdf-lib.min.js");
const fflate = require("../../src/vendor/fflate/index.js");

test("結合PDF・ページ別ZIPの書き出しは、対象・順序・回転・ファイル名を保つ", async () => {
  const original = await pdfLib.PDFDocument.create();
  original.addPage([300, 400]); original.addPage([500, 600]);
  const bytes = await original.save();
  const file = new File([bytes], "原稿.pdf", { type: "application/pdf" });
  const sources = new Map([[1, { file, reader: { numPages: 2 } }]]);
  const page = (index, rotation = 0) => ({ id: "p" + index, sourcePdfId: 1, sourceIndex: index, addedRotation: rotation, annotations: [] });
  const pages = [page(1, 90), page(0)];
  const runner = createExportRunner(createPdfExporter(pdfLib), fflate);
  for (const layout of ["combined", "zip"]) {
    const files = [], progress = [];
    const plan = createExportPlan(pages, new Set(["p1"]), sources, { extension: "pdf", layout, customName: "試作.pdf" });
    await runner(plan, { report: value => progress.push(value), download: (blob, name) => files.push({ blob, name }) });
    assert(progress.length > 0);
    let outputs;
    if (layout === "zip") {
      const unpacked = fflate.unzipSync(new Uint8Array(await files[0].blob.arrayBuffer()));
      assert.equal(files[0].name, "試作.zip"); assert.deepEqual(Object.keys(unpacked), ["試作_01.pdf", "試作_02.pdf"]);
      outputs = await Promise.all(Object.values(unpacked).map(bytes => pdfLib.PDFDocument.load(bytes)));
    } else {
      assert.deepEqual(files.map(file => file.name), ["試作.pdf"]);
      outputs = await Promise.all(files.map(async file => pdfLib.PDFDocument.load(await file.blob.arrayBuffer())));
    }
    const actualPages = outputs.flatMap(doc => doc.getPages());
    assert.deepEqual(actualPages.map(page => page.getWidth()), [500, 300]);
    assert.deepEqual(actualPages.map(page => page.getRotation().angle), [90, 0]);
  }
  const selected = createExportPlan(pages, new Set(["p1"]), sources, { selectionOnly: true, extension: "pdf", layout: "combined", customName: "" });
  assert.deepEqual(selected.pages.map(page => page.id), ["p1"]);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
});

test("ICCは投入順や選択クリック順ではなく、各出力PDFで一覧の先頭に残るページの元PDFから採用する", async () => {
  const sources = new Map(), profiles = new Map();
  const n = pdfLib.PDFName.of;
  for (const [id, label] of [[1, "A"], [2, "B"], [3, null]]) {
    const doc = await pdfLib.PDFDocument.create();
    doc.addPage([id * 100, 400]); doc.addPage([id * 100 + 1, 400]);
    if (label) {
      // 識別用ストリームで採用元とバイト保持を検査する。ICC規格適合・色再現の試験ではない。
      const profile = doc.context.register(doc.context.flateStream("profile:" + label, { N: 3 }));
      profiles.set(id, [...doc.context.lookup(profile).getContents()]);
      doc.catalog.set(n("OutputIntents"), doc.context.obj([{ Type: "OutputIntent", S: "GTS_PDFX",
        OutputConditionIdentifier: pdfLib.PDFString.of(label), DestOutputProfile: profile }]));
    }
    sources.set(id, { file: new File([await doc.save()], (label ?? "no-profile") + ".pdf"), reader: { numPages: 2 } });
  }
  const a0 = { id: "a0", sourcePdfId: 1, sourceIndex: 0, addedRotation: 0, annotations: [] };
  const a1 = { ...a0, id: "a1", sourceIndex: 1 };
  const b0 = { ...a0, id: "b0", sourcePdfId: 2 };
  const b1 = { ...b0, id: "b1", sourceIndex: 1 };
  const c0 = { ...a0, id: "c0", sourcePdfId: 3 };
  const cases = [
    { label: "Bの途中ページだけ", pages: [a0, a1, b0, b1], selected: ["b1"], expected: [[b1]] },
    { label: "Bの複数ページだけ", pages: [a0, a1, b0, b1], selected: ["b1", "b0"], expected: [[b0, b1]] },
    { label: "Bを先にクリックしても一覧はAが先", pages: [a0, a1, b0, b1], selected: ["b1", "a1"], expected: [[a1, b1]] },
    { label: "一覧をB先頭へ並べ替え", pages: [b1, a1, b0, a0], selected: ["a1", "b1"], expected: [[b1, a1]] },
    { label: "未選択の一覧先頭Aを採用しない", pages: [a0, b1, a1, b0], selected: ["b0", "a1", "b1"], expected: [[b1, a1, b0]] },
    { label: "Aを除外して全残存ページ", pages: [b1, b0], expected: [[b1, b0]] },
    { label: "全ページ出力では選択に関係なく実際の先頭A", pages: [a0, b1], selected: ["b1"], all: true, expected: [[a0, b1]] },
    { label: "選択ページ別ZIPはPDFごと", pages: [a0, a1, b0, b1], selected: ["b1", "a1"], zip: true, expected: [[a1], [b1]] },
    { label: "並べ替えた全ページZIP", pages: [b1, a1, b0], zip: true, expected: [[b1], [a1], [b0]] },
    { label: "先頭にICCがなければ後続Aから借用しない", pages: [c0, a0], expected: [[c0, a0]] },
    { label: "ICCなしとありのZIP", pages: [c0, b1], zip: true, expected: [[c0], [b1]] },
  ];
  const results = [];
  for (const entry of cases) {
    const plan = createExportPlan(entry.pages, new Set(entry.selected ?? []), sources, {
      selectionOnly: !!entry.selected && !entry.all, extension: "pdf", layout: entry.zip ? "zip" : "combined", customName: "icc",
    });
    const downloads = [];
    await createExportRunner(createPdfExporter(pdfLib), fflate)(plan, { report() {}, download: blob => downloads.push(blob) });
    assert.equal(downloads.length, 1, entry.label);
    const bytes = new Uint8Array(await downloads[0].arrayBuffer());
    const outputs = entry.zip ? Object.values(fflate.unzipSync(bytes)) : [bytes];
    assert.equal(outputs.length, entry.expected.length, entry.label);
    const actualProfiles = [];
    for (const [index, data] of outputs.entries()) {
      const output = await pdfLib.PDFDocument.load(data, { updateMetadata: false });
      const expectedPages = entry.expected[index], sourceId = expectedPages[0].sourcePdfId;
      assert.deepEqual(output.getPages().map(page => page.getWidth()),
        expectedPages.map(page => page.sourcePdfId * 100 + page.sourceIndex), entry.label);
      const intents = output.catalog.lookupMaybe(n("OutputIntents"), pdfLib.PDFArray);
      if (sourceId === 3) { assert.equal(intents, undefined, entry.label); actualProfiles.push(null); }
      else {
        assert.equal(intents.size(), 1, entry.label);
        const intent = intents.lookup(0), expectedLabel = sourceId === 1 ? "A" : "B";
        assert.equal(intent.lookup(n("OutputConditionIdentifier")).decodeText(), expectedLabel, entry.label);
        assert.deepEqual([...intent.lookup(n("DestOutputProfile")).getContents()], profiles.get(sourceId), entry.label);
        actualProfiles.push(expectedLabel);
      }
    }
    results.push({ scenario: entry.label, outputProfiles: actualProfiles });
  }
  console.log("ICC selection scenarios: " + JSON.stringify(results));
});
test("ZIP作成の途中で失敗すると、不完全なファイルをダウンロードしない", async () => {
  let attempts = 0; const downloads = [];
  const runner = createExportRunner({ loadExportSourcePdfs: async () => new Map(), assembleOutputPdf: async () => {
    if (++attempts === 2) throw Error("failed"); return new Uint8Array([1]);
  } }, fflate);
  const plan = { pages: [{}, {}, {}], sources: new Map(), name: "試作", extension: "pdf", layout: "zip" };
  await assert.rejects(() => runner(plan, { report() {}, download: (_, name) => downloads.push(name) }), /試作_02.pdf/);
  assert.deepEqual(downloads, []); assert.equal(attempts, 2);
});
test("JPEGは表示倍率から独立したDPIと画素数で出力し、処理後にCanvasを解放する", async () => {
  const canvases = [];
  globalThis.document = { createElement() {
    const canvas = { style: {}, setAttribute() {}, toBlob(callback) {
      callback(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }));
    } };
    canvases.push(canvas); return canvas;
  } };
  for (const dpi of [72, 150, 300, 600]) {
    const dimensions = [];
    const sourcePage = { rotate: 0, getViewport({ scale }) { return { width: 144 * scale, height: 216 * scale, scale, userUnit: 1, transform: [scale, 0, 0, -scale, 0, 216 * scale] }; },
      render({ canvas }) { dimensions.push([canvas.width, canvas.height]); return { promise: Promise.resolve() }; } };
    const jpeg = await exportPageImage(sourcePage, { addedRotation: 0, annotations: [] }, { extension: "jpg", dpi });
    assert.deepEqual(dimensions, [[Math.ceil(144 * (dpi / 72)), Math.ceil(216 * (dpi / 72))]]);
    const bytes = new Uint8Array(await jpeg.arrayBuffer()); const data = new DataView(bytes.buffer);
    assert.equal(bytes[13], 1); assert.equal(data.getUint16(14), dpi); assert.equal(data.getUint16(16), dpi);
    assert.equal(canvases.at(-1).width, 0); assert.equal(canvases.at(-1).height, 0);
  }
  await assert.rejects(() => exportPageImage({ rotate: 0, getViewport: () => ({ width: 20000, height: 20000 }) }, { addedRotation: 0 }, { extension: "jpg", dpi: 600 }), ImageExportError);
});

test("ページ別PDFは1枚でも100枚でもZIPを1回だけ保存し、全ページを連番で収録する", async () => {
  for (const count of [1, 100]) {
    const files = [], created = [];
    const runner = createExportRunner({ loadExportSourcePdfs: async () => new Map(), assembleOutputPdf: async ([page]) => {
      created.push(page.id); return new Uint8Array([page.id]);
    } }, fflate);
    const pages = Array.from({ length: count }, (_, id) => ({ id, sourcePdfId: 1 }));
    const plan = createExportPlan(pages, new Set(), new Map(), { extension: "pdf", layout: "zip", customName: "pages" });
    await runner(plan, { report() {}, download: (blob, name) => files.push({ blob, name }) });
    assert.equal(files.length, 1); assert.equal(files[0].name, "pages.zip");
    const entries = fflate.unzipSync(new Uint8Array(await files[0].blob.arrayBuffer()));
    assert.equal(Object.keys(entries).length, count);
    const digits = Math.max(2, String(count).length);
    for (let i = 0; i < count; i++) assert.deepEqual([...entries["pages_" + String(i + 1).padStart(digits, "0") + ".pdf"]], [i]);
    assert.deepEqual(created, pages.map(page => page.id));
  }
});
test("JPEGは1枚でも複数枚でもZIPへまとめ、解像度とページ順を維持する", async () => {
  const qualities = [];
  globalThis.document = { createElement: () => ({ style: {}, setAttribute() {}, toBlob(callback, type, quality) {
    assert.equal(type, "image/jpeg");
    qualities.push(quality);
    callback(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }));
  } }) };
  for (const count of [1, 3]) {
    const files = [], loaded = [];
    const reader = { getPage: async index => {
      loaded.push(index);
      return { rotate: 0, getViewport: ({ scale }) => ({ width: 72 * scale, height: 72 * scale, transform: [scale, 0, 0, -scale, 0, 72 * scale] }),
        render: () => ({ promise: Promise.resolve() }) };
    } };
    const pages = Array.from({ length: count }, (_, index) => ({ id: index, sourcePdfId: 1, sourceIndex: count - index - 1, addedRotation: 0, annotations: [] }));
    const jpegQuality = count === 1 ? 0 : 100;
    const plan = createExportPlan(pages, new Set(), new Map([[1, { reader }]]), { extension: "jpg", layout: "combined", customName: "images", imageDpi: 300, jpegQuality });
    assert.equal(plan.layout, "zip");
    assert.equal(sameExportPlan(plan, { ...plan, jpegQuality: 92 }), false);
    await createExportRunner({}, fflate)(plan, { report() {}, download: (blob, name) => files.push({ blob, name }) });
    assert.equal(files.length, 1); assert.equal(files[0].name, "images.zip");
    const entries = fflate.unzipSync(new Uint8Array(await files[0].blob.arrayBuffer()));
    assert.deepEqual(Object.keys(entries), pages.map((_, index) => "images_" + String(index + 1).padStart(2, "0") + ".jpg"));
    assert.deepEqual(loaded, pages.map(page => page.sourceIndex + 1));
    for (const bytes of Object.values(entries)) { assert.equal(bytes[13], 1); assert.equal(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(14), 300); }
  }
  assert.deepEqual(qualities, [0, 1, 1, 1]);
});

test("PNGは描画済みの画素を保ち、指定DPIを記録してZIPに格納する", async () => {
  globalThis.document = { createElement() {
    return { style: {}, setAttribute() {}, toBlob(callback, type, quality) {
      assert.equal(type, "image/png");
      assert.equal(quality, undefined);
      callback(new Blob([this.image.toBuffer("image/png")], { type }));
    } };
  } };
  const reader = { async getPage() {
    return {
      rotate: 0,
      getViewport: ({ scale }) => ({ width: 72 * scale, height: 36 * scale, transform: [scale, 0, 0, -scale, 0, 36 * scale] }),
      render({ canvas, background }) {
        assert.equal(background, "#ffffff");
        canvas.image = createCanvas(canvas.width, canvas.height);
        const ctx = canvas.image.getContext("2d");
        ctx.fillStyle = "#3180cc";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        return { promise: Promise.resolve() };
      },
    };
  } };
  const page = { id: 1, sourcePdfId: 1, sourceIndex: 0, addedRotation: 0, annotations: [] };
  const plan = createExportPlan([page], new Set(), new Map([[1, { reader }]]),
    { extension: "png", layout: "combined", customName: "sample.png", imageDpi: 300, jpegQuality: 0 });
  assert.equal(sameExportPlan(plan, { ...plan, jpegQuality: 100 }), true);
  assert.equal(sameExportPlan(plan, { ...plan, dpi: 150 }), false);
  const downloads = [];
  await createExportRunner({}, fflate)(plan, { download: (blob, name) => downloads.push({ blob, name }) });
  assert.deepEqual(downloads.map(file => file.name), ["sample.zip"]);
  const entries = fflate.unzipSync(new Uint8Array(await downloads[0].blob.arrayBuffer()));
  assert.deepEqual(Object.keys(entries), ["sample_01.png"]);
  const png = Buffer.from(entries["sample_01.png"]);
  const density = png.indexOf("pHYs");
  assert(density > 0 && density < png.indexOf("IDAT"));
  assert.equal(png.readUInt32BE(density - 4), 9);
  assert.equal(png.readUInt32BE(density + 4), 11811);
  assert.equal(png.readUInt32BE(density + 8), 11811);
  assert.equal(png[density + 12], 1);
  assert.equal(png.readUInt32BE(density + 13), crc32(png.subarray(density, density + 13)));
  const image = await loadImage(png);
  assert.deepEqual([image.width, image.height], [300, 150]);
  const decoded = createCanvas(image.width, image.height).getContext("2d");
  decoded.drawImage(image, 0, 0);
  assert.deepEqual([...decoded.getImageData(100, 100, 1, 1).data], [49, 128, 204, 255]);
});

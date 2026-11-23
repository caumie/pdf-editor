import test from "node:test";
import assert from "node:assert/strict";
import { fixture, openFixture, pdfLib } from "../support/pdf-fixtures.mjs";
import { renderStats } from "../support/render-pdfjs.mjs";

// Compare the original and saved bytes in the same renderer/runtime; do not
// store screenshots or assume another PDF engine draws identical pixels.
const examples = [
  "graphics/font-truetype.pdf", "graphics/font-type1.pdf", "graphics/font-cff.pdf",
  "graphics/font-type0-japanese.pdf", "graphics/font-japanese-vertical.pdf",
  "graphics/image-softmask.pdf", "graphics/rasterized-image-softmask.pdf",
  "graphics/image-jpeg2000.pdf", "graphics/image-ccitt.pdf", "graphics/image-inline-binary.pdf",
  "graphics/shading-type7.pdf", "graphics/color-devicen.pdf", "graphics/pattern-paint2-tile3.pdf",
  "graphics/offset-cropbox.pdf", "graphics/complex-collage-1.pdf",
  "regression/form.pdf", "regression/rich-boxes.pdf", "regression/layers-annots.pdf", "regression/synthetic-mixed.pdf",
  "annotations/embedded-font-annotation.pdf", "annotations/independent-annotations.pdf", "annotations/tool-note-style.pdf",
];

for (const file of examples) {
  test("未編集PDFの保存前後の描画: " + file, async () => {
    const input = await openFixture(fixture(file));
    assert.deepEqual(await renderStats(await input.save()), await renderStats(input.bytes));
  });
}

test("ページの入れ替えと抽出が反映され、無編集の反復保存でも描画が変わらない", async () => {
  const input = await openFixture(fixture("regression/synthetic-mixed.pdf"));
  const expected = await renderStats(input.bytes, [8, 2, 5]);
  let bytes = await input.save([input.pages[7], input.pages[1], input.pages[4]]);
  for (let round = 0; round < 3; round++) {
    assert.deepEqual(await renderStats(bytes), expected, "保存 " + (round + 1));
    if (round < 2) bytes = await (await openFixture(bytes)).save();
  }
});

test("482ページから離れたページを抜き出し、選択外を含めない", async () => {
  const doc = await pdfLib.PDFDocument.create();
  for (let i = 1; i <= 482; i++) {
    const page = doc.addPage([200 + i, 300]);
    page.drawText("Synthetic page " + i, { x: 15, y: 250, size: 12 });
  }
  const input = await openFixture(await doc.save());
  const bytes = await input.save([input.pages[481], input.pages[230], input.pages[0]]);
  const saved = await pdfLib.PDFDocument.load(bytes);
  assert.deepEqual(saved.getPages().map(page => page.getWidth()), [682, 431, 201]);
  assert.deepEqual(await renderStats(bytes), await renderStats(input.bytes, [482, 231, 1]));
});

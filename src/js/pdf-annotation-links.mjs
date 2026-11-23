// 親注釈に追随するポップアップ・返信も、推移的に削除する。
// 注釈配列からの削除に限定し、本文や共有リソースには触れない。
export function removePdfAnnotationsAndReplies(pdfLib, page, removed) {
  const refs = page.node.Annots();
  if (!refs || !removed.size) return;
  let changed = true;
  while (changed) {
    changed = false;
    for (const ref of refs.asArray()) {
      const dict = page.doc.context.lookup(ref, pdfLib.PDFDict);
      const parent = dict.get(pdfLib.PDFName.of("Parent")) ?? dict.get(pdfLib.PDFName.of("IRT"));
      if (!removed.has(ref.toString()) && parent && removed.has(parent.toString())) {
        removed.add(ref.toString());
        changed = true;
      }
    }
  }
  for (let index = refs.size() - 1; index >= 0; index--) {
    if (removed.has(refs.get(index).toString())) refs.remove(index);
  }
}

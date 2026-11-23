import { compatiblePdfText, decodePdfText } from "./pdf-text.mjs";

// 元PDFは保存処理中に書き換えない。ページ別ZIPでも全ページの索引を繰り返し作らない。
export function indexPdfCopySource(pdfLib, source) {
  const { PDFArray, PDFDict, PDFName, PDFRef } = pdfLib;
  const name = PDFName.of;
  const read = value => source.context.lookup(value);
  const dict = value => { const object = read(value); return object instanceof PDFDict ? object : null; };
  const array = value => { const object = read(value); return object instanceof PDFArray ? object : null; };
  const textLabel = value => value instanceof PDFName || value instanceof pdfLib.PDFString || value instanceof pdfLib.PDFHexString
    ? decodePdfText(pdfLib, value) : undefined;
  const pages = source.getPages();
  const pageRefs = new Map(), byPageNode = new Map();
  const annotations = [];
  const blocked = new Set([source.context.trailerInfo.Root]);
  for (const [index, page] of pages.entries()) {
    pageRefs.set(page.ref, index);
    byPageNode.set(page.node, page.ref);
    const stored = page.node.get(name("Annots"));
    const list = array(stored);
    for (const ref of list?.asArray() ?? []) if (ref instanceof PDFRef) pageRefs.set(ref, index);
    annotations.push({ stored, list });
  }
  for (const [ref, object] of source.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict && read(object.get(name("Type"))) === name("Pages")) blocked.add(ref);
  }
  const named = new Map();
  const namesRoot = dict(source.catalog.get(name("Names")));
  const pending = [namesRoot?.get(name("Dests"))];
  const visited = new Set();
  while (pending.length) {
    const node = dict(pending.pop());
    if (!node || visited.has(node)) continue;
    visited.add(node);
    const pairs = array(node.get(name("Names")));
    for (let index = 0; index + 1 < (pairs?.size() ?? 0); index += 2) {
      const label = textLabel(read(pairs.get(index)));
      if (label !== undefined) named.set(label, pairs.get(index + 1));
    }
    pending.push(...(array(node.get(name("Kids")))?.asArray() ?? []));
  }
  const oldNames = dict(source.catalog.get(name("Dests")));
  for (const [label, value] of oldNames?.entries() ?? []) named.set(label.decodeText(), value);
  return { pages, pageRefs, byPageNode, annotations, blocked, named, read, dict, array, textLabel };
}

// 入力文書を変更せず、書き出すページだけを参照できるコピー用のビューを作る。
export function createPdfCopyGraph(pdfLib, source, indices, index = indexPdfCopySource(pdfLib, source)) {
  const { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFNull, PDFStream } = pdfLib;
  const name = PDFName.of;
  const { pages, pageRefs, byPageNode, annotations, blocked, named, read, dict, array, textLabel } = index;
  const selected = new Set(indices);
  const excluded = ref => blocked.has(ref) || (pageRefs.has(ref) && !selected.has(pageRefs.get(ref)));
  const overrides = new Map();
  const setOverride = (ref, value) => { if (ref instanceof PDFRef) overrides.set(ref, value); };
  function destination(value, seen = new Set()) {
    const object = read(value);
    if (!object || seen.has(object)) return null;
    seen.add(object);
    if (object instanceof PDFArray) {
      let target = object.get(0);
      if (target instanceof PDFNumber) target = pages[target.asNumber()]?.ref;
      if (!(target instanceof PDFRef)) target = byPageNode.get(read(target));
      if (!selected.has(pageRefs.get(target)) || pages[pageRefs.get(target)]?.ref !== target) return null;
      const copy = object.clone(); copy.set(0, target); return copy;
    }
    if (object instanceof PDFDict) return destination(object.get(name("D")), seen);
    const label = textLabel(object);
    return label !== undefined && named.has(label) ? destination(named.get(label), seen) : null;
  }

  function action(value) {
    const object = dict(value);
    // 出力に残す動作は同一PDF内のページ移動だけ。外部リンクやNext連鎖も引き継がない。
    if (!object || read(object.get(name("S"))) !== name("GoTo")) return null;
    const target = destination(object.get(name("D")));
    return target ? source.context.obj({ S: "GoTo", D: target }) : null;
  }

  function cleanActions(object) {
    const copy = object.clone();
    if (object.has(name("Dest"))) {
      const target = destination(object.get(name("Dest")));
      if (target) copy.set(name("Dest"), target); else copy.delete(name("Dest"));
    }
    if (object.has(name("A"))) {
      const value = action(object.get(name("A")));
      if (value) copy.set(name("A"), value); else copy.delete(name("A"));
    }
    copy.delete(name("AA"));
    return copy;
  }

  function hasLinkAppearance(object) {
    const ap = dict(object.get(name("AP")));
    const normal = read(ap?.get(name("N")));
    if (normal instanceof PDFStream || (normal instanceof PDFDict && read(normal.get(read(object.get(name("AS"))))) instanceof PDFStream)) return true;
    const bs = dict(object.get(name("BS")));
    const border = array(object.get(name("Border")));
    const width = read(bs?.get(name("W")) ?? (border?.size() >= 3 ? border.get(2) : undefined));
    return width instanceof PDFNumber && width.asNumber() > 0;
  }

  for (const pageIndex of selected) {
    const page = pages[pageIndex];
    const { stored, list } = annotations[pageIndex];
    const refs = list?.asArray() ?? [];
    if (stored && !list && read(stored) !== PDFNull) {
      throw new Error(`元PDFの ${pageIndex + 1} ページ目の注釈一覧を読み取れません。このページを除くと保存できます。`);
    }
    const kept = [];
    for (const ref of refs) {
      const object = dict(ref);
      if (!object) continue;
      const copy = cleanActions(object);
      // 行き先を失ったリンクでも、明示的な外観・枠線は動作なしで残す。
      if (read(object.get(name("Subtype"))) === name("Link")
          && (object.has(name("Dest")) || object.has(name("A")))
          && !copy.has(name("Dest")) && !copy.has(name("A")) && !hasLinkAppearance(object)) {
        setOverride(ref, PDFNull); continue;
      }
      for (const key of ["Contents", "T", "Subj", "NM", "RC"]) {
        const text = compatiblePdfText(pdfLib, read(copy.get(name(key))));
        if (text) copy.set(name(key), text);
      }
      copy.delete(name("StructParent"));
      copy.set(name("P"), page.ref);
      setOverride(ref, copy);
      kept.push(ref instanceof PDFRef ? ref : copy);
    }
    const copy = cleanActions(page.node);
    if (list) copy.set(name("Annots"), source.context.obj(kept));
    else copy.delete(name("Annots"));
    // 記事スレッドは書き出さないため、ページ側にも不完全なビーズの連鎖を残さない。
    copy.delete(name("B"));
    copy.delete(name("StructParents"));
    if (read(copy.get(name("Tabs"))) === name("S")) copy.delete(name("Tabs"));
    setOverride(page.ref, copy);
  }
  // 除外ページのWidgetをNullへ置換するだけでは、Fields/Kidsに無効な項目が残る。
  // 値やAPは作り直さず、出力に残るフィールドの枝だけをコピーする。
  const form = dict(source.catalog.get(name("AcroForm")))?.clone();
  const retainedFields = new Set();
  const fieldResults = new Map();
  function field(ref, ancestors = new Set()) {
    const original = dict(ref);
    if (!original || ancestors.has(original)) return null;
    if (fieldResults.has(original)) return fieldResults.get(original);
    if (overrides.get(ref) === PDFNull || (!overrides.has(ref) && excluded(ref))) return null;
    const children = array(original.get(name("Kids")));
    const lineage = new Set(ancestors); lineage.add(original);
    const kept = children?.asArray().map(child => field(child, lineage)).filter(Boolean);
    if (children?.size() && !kept.length) { fieldResults.set(original, null); return null; }
    const copy = overrides.get(ref) ?? original.clone();
    if (children) copy.set(name("Kids"), source.context.obj(kept));
    setOverride(ref, copy);
    const result = ref instanceof PDFRef ? ref : copy;
    retainedFields.add(ref); fieldResults.set(original, result);
    return result;
  }
  if (form) {
    const fields = array(form.get(name("Fields")));
    if (fields) form.set(name("Fields"), source.context.obj(fields.asArray().map(ref => field(ref)).filter(Boolean)));
    const calculationOrder = array(form.get(name("CO")));
    if (calculationOrder) form.set(name("CO"), source.context.obj(calculationOrder.asArray().filter(ref => retainedFields.has(ref))));
  }
  // 除外ページとページツリー等は必要になったときだけ遮断し、全ページを再走査しない。
  const context = Object.create(source.context);
  context.lookup = (ref, ...types) => overrides.has(ref) ? overrides.get(ref)
    : excluded(ref) ? PDFNull : source.context.lookup(ref, ...types);
  return { source, context, read, dict, array, destination, action, named, form };
}

// PDF-libは未参照オブジェクトも保存するため、最後に到達可能なデータだけを残す。
export function prunePdfObjects(pdfLib, output) {
  const pending = Object.values(output.context.trailerInfo).filter(Boolean);
  const refs = new Set();
  const objects = new Set();
  while (pending.length) {
    const object = pending.pop();
    if (object instanceof pdfLib.PDFRef) {
      const id = object.toString();
      if (refs.has(id)) continue;
      refs.add(id); pending.push(output.context.lookup(object)); continue;
    }
    if (!object || objects.has(object)) continue;
    objects.add(object);
    if (object instanceof pdfLib.PDFStream) pending.push(object.dict);
    else if (object instanceof pdfLib.PDFDict) pending.push(...object.values());
    else if (object instanceof pdfLib.PDFArray) pending.push(...object.asArray());
  }
  for (const [ref] of output.context.enumerateIndirectObjects()) if (!refs.has(ref.toString())) output.context.delete(ref);
}

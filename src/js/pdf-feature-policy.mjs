import { decodePdfText } from "./pdf-text.mjs";

// 非対応機能は通知し、表示の再生成やフォームの修復は行わない。
export function createPdfFeaturePolicy(pdfLib) {
  const { PDFArray, PDFDict, PDFName, PDFStream } = pdfLib;
  const name = PDFName.of;
  const dynamicAnnotations = new Set(["Widget", "Screen", "RichMedia", "Movie", "Sound", "3D", "FileAttachment"]);
  const actionTypes = new Set(["GoTo", "GoToR", "GoToE", "Launch", "Thread", "URI", "Sound", "Movie", "Hide", "Named", "SubmitForm", "ResetForm", "ImportData", "JavaScript", "SetOCGState", "Rendition", "Trans", "GoTo3DView", "RichMediaExecute"]);
  const value = (dict, key) => dict.context.lookup(dict.get(name(key)));
  const label = (dict, key) => value(dict, key) instanceof PDFName ? value(dict, key).decodeText() : undefined;
  function visit(doc, callback) {
    const pending = [doc.catalog, ...doc.context.enumerateIndirectObjects().map(([, object]) => object)];
    const seen = new Set();
    while (pending.length) {
      const object = doc.context.lookup(pending.pop());
      if (!object || seen.has(object)) continue;
      seen.add(object);
      if (object instanceof PDFStream) pending.push(object.dict);
      else if (object instanceof PDFDict) { callback(object); pending.push(...object.values()); }
      else if (object instanceof PDFArray) pending.push(...object.asArray());
    }
  }
  function isDynamicAnnotation(dict) {
    return dynamicAnnotations.has(label(dict, "Subtype"));
  }
  function inspect(doc) {
    const features = new Set();
    const form = value(doc.catalog, "AcroForm");
    const fields = form instanceof PDFDict ? value(form, "Fields") : null;
    if (form instanceof PDFDict && ((fields instanceof PDFArray && fields.size()) || form.has(name("XFA")))) {
      features.add("フォーム");
      if (form.has(name("XFA"))) features.add("XFAフォーム");
    }
    const names = value(doc.catalog, "Names");
    if (names instanceof PDFDict && names.has(name("JavaScript"))) features.add("スクリプト");
    if (names instanceof PDFDict && names.has(name("EmbeddedFiles"))) features.add("添付ファイル");
    if (doc.catalog.has(name("OpenAction"))) features.add("自動動作");
    if (doc.catalog.has(name("Threads"))) features.add("記事スレッド");
    if (value(doc.catalog, "StructTreeRoot") instanceof PDFDict
        || value(doc.catalog, "MarkInfo")?.get?.(name("Marked")) === pdfLib.PDFBool.True) features.add("読み上げ用タグ");
    visit(doc, dict => {
      const subtype = label(dict, "Subtype"), type = label(dict, "Type"), action = label(dict, "S");
      if (action === "JavaScript") features.add("スクリプト");
      else if (action !== "GoTo" && (actionTypes.has(action) || type === "Action")) features.add("外部リンク・その他の動作");
      if (label(dict, "FT") === "Sig" || type === "Sig") features.add("電子署名");
      if (type === "Filespec" && dict.has(name("EF"))) features.add("添付ファイル");
      if (subtype === "Widget") features.add("フォーム");
      else if (dynamicAnnotations.has(subtype)) features.add(subtype === "FileAttachment" ? "添付ファイル" : "埋め込みメディア・3D");
      if ((type === "Page" || type === "Annot" || dict === doc.catalog) && dict.has(name("AA"))) features.add("自動動作");
      const mainAction = value(dict, "A");
      if ((type === "Annot" || dict.has(name("Rect"))) && mainAction instanceof PDFDict && label(mainAction, "S") !== "GoTo") features.add("外部リンク・その他の動作");
      if (type === "Page" && ["Trans", "Dur", "PresSteps"].some(key => dict.has(name(key)))) features.add("ページの自動切替・演出");
      if (type === "Page" && dict.has(name("B"))) features.add("記事スレッド");
    });
    return [...features].sort();
  }
  function removeActiveContent(doc) {
    for (const key of ["OpenAction", "AA", "AF", "Collection", "Perms", "Requirements"]) doc.catalog.delete(name(key));
    const form = value(doc.catalog, "AcroForm");
    if (form instanceof PDFDict) form.delete(name("XFA")); // XML内の動作を解析・修復しない。
    const names = value(doc.catalog, "Names");
    if (names instanceof PDFDict) {
      names.delete(name("JavaScript")); names.delete(name("EmbeddedFiles"));
    }
    // A/AA等を無差別に消すと同名のフォント資源まで壊すため、意味を持つ辞書だけを対象にする。
    visit(doc, dict => {
      const type = label(dict, "Type"), subtype = label(dict, "Subtype"), action = label(dict, "S");
      if (type === "Action" || actionTypes.has(action)) {
        if (action === "GoTo") {
          for (const key of dict.keys()) if (!["S", "D"].includes(key.decodeText())) dict.delete(key);
        } else for (const key of dict.keys()) dict.delete(key);
      }
      if (type === "Page") for (const key of ["AA", "AF", "Trans", "Dur", "PresSteps"]) dict.delete(name(key));
      if (type === "Annot" || (subtype && dict.has(name("Rect")))) {
        for (const key of ["AA", "PA", "AF", "FS", "RichMediaContent", "RichMediaSettings", "Movie", "Sound", "3DD", "3DA", "3DV"]) dict.delete(name(key));
      }
      if (["Tx", "Btn", "Ch", "Sig"].includes(label(dict, "FT"))) dict.delete(name("AA"));
      if (type === "Filespec") for (const key of ["EF", "RF"]) dict.delete(name(key));
    });
  }
  function formFieldPages(doc) {
    const dictionary = ref => { const obj = doc.context.lookup(ref); return obj instanceof PDFDict ? obj : null; };
    const form = dictionary(doc.catalog.get(name("AcroForm")));
    const fields = form && value(form, "Fields");
    const result = new Map();
    if (!(fields instanceof PDFArray) || !fields.size()) return result;
    const widgets = new Map(), pageRefs = new Map();
    for (const [index, page] of doc.getPages().entries()) {
      pageRefs.set(page.ref, index);
      const annotations = value(page.node, "Annots");
      if (!(annotations instanceof PDFArray)) continue;
      for (const ref of annotations.asArray()) {
        const item = dictionary(ref);
        if (item && label(item, "Subtype") === "Widget") widgets.set(item, index);
      }
    }
    const seen = new Set();
    const pending = fields.asArray().map(ref => [ref, ""]);
    while (pending.length) {
      const [ref, parentName] = pending.pop();
      const item = dictionary(ref);
      if (!item || seen.has(item)) continue;
      seen.add(item);
      const part = value(item, "T");
      const ownName = part instanceof pdfLib.PDFString || part instanceof pdfLib.PDFHexString ? decodePdfText(pdfLib, part) : "";
      const fullName = ownName ? [parentName, ownName].filter(Boolean).join(".") : parentName;
      const children = value(item, "Kids");
      if (children instanceof PDFArray && children.size()) {
        for (const child of children.asArray()) pending.push([child, fullName]);
      } else if (fullName && result.get(fullName) !== null) {
        const pageIndex = widgets.get(item) ?? pageRefs.get(item.get(name("P")));
        if (pageIndex === undefined) {
          // ページにひも付かない欄は、ページを抜き出してもフォーム辞書に残る。
          result.set(fullName, null);
        } else {
          const indices = result.get(fullName) ?? new Set();
          indices.add(pageIndex);
          result.set(fullName, indices);
        }
      }
    }
    return result;
  }
  return { inspect, formFieldPages, isDynamicAnnotation, removeActiveContent };
}

export function unsupportedPdfWarning(fileName, features) {
  if (!features.length) return "";
  const lines = [fileName + "：" + features.join("、") + " は非対応です。"];
  if (features.includes("読み上げ用タグ")) lines.push("PDF保存時、読み上げ順や見出し等を記録したタグは引き継がれません。");
  if (features.some(feature => feature !== "読み上げ用タグ")) {
    lines.push("フォーム等の表示データは再生成・修復せず引き継ぎます。PDF保存時にスクリプト・外部動作・メディアの再生用データ・記事スレッド等を除去します。出力後の表示・動作をご確認ください。");
  }
  return lines.join("\n");
}

// 実際に一覧または出力対象にあるページだけを調べる。履歴にしかないPDFは参照しない。
export function duplicatePdfFormWarning(pages, sources, addedSourceIds) {
  if (sources.size < 2) return "";
  const bySource = new Map();
  for (const page of pages) {
    if (!bySource.has(page.sourcePdfId)) bySource.set(page.sourcePdfId, new Set());
    bySource.get(page.sourcePdfId).add(page.sourceIndex);
  }
  const matches = new Map();
  for (const [id, indices] of bySource) {
    for (const [field, fieldPages] of sources.get(id)?.formFieldPages ?? []) {
      if (fieldPages && ![...fieldPages].some(index => indices.has(index))) continue;
      if (!matches.has(field)) matches.set(field, []);
      matches.get(field).push(id);
    }
  }
  const duplicates = [...matches].filter(([, ids]) => ids.length > 1
    && (!addedSourceIds || ids.some(id => addedSourceIds.has(id))));
  if (!duplicates.length) return "";
  const lines = duplicates.slice(0, 10).map(([field, ids]) =>
    "「" + field + "」：" + ids.map(id => sources.get(id).file.name).join("、"));
  if (duplicates.length > 10) lines.push("ほか " + (duplicates.length - 10) + " 件");
  return "別々のPDFに同名のフォーム欄があります。結合すると、閲覧・集計ツールによって値を区別できないことがあります。必要なら別々に保存してください。\n"
    + lines.join("\n");
}

// 選択ページに残るフォーム辞書を引き継ぐ。名前・資源・表示の再生成は行わない。
export function copyPdfFormData(pdfLib, output, graphs) {
  const name = pdfLib.PDFName.of;
  let target;
  for (const graph of graphs) {
    const form = graph.form;
    if (!form) continue;
    const copied = graph.copier.copy(form);
    const fields = target && output.context.lookup(target.get(name("Fields")));
    const incoming = output.context.lookup(copied.get(name("Fields")));
    if (!target || ((!(fields instanceof pdfLib.PDFArray) || !fields.size())
        && incoming instanceof pdfLib.PDFArray && incoming.size())) {
      // 欄のないPDFの既定フォント等で、実際に残るフォームの設定を上書きしない。
      target = copied;
      output.catalog.set(name("AcroForm"), target);
    } else if (fields instanceof pdfLib.PDFArray && incoming instanceof pdfLib.PDFArray) {
      for (const ref of incoming.asArray()) fields.push(ref);
    }
  }
}

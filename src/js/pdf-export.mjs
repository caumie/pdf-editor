import { createPdfCopyGraph, indexPdfCopySource, prunePdfObjects } from "./pdf-copy-graph.mjs";
import { createPdfFeaturePolicy, copyPdfFormData } from "./pdf-feature-policy.mjs";
import { mergePdfNavigation } from "./pdf-navigation.mjs";
import { applyPdfOutputSecurity, normalizePdfPermissions } from "./pdf-properties.mjs";
import { removePdfAnnotationsAndReplies } from "./pdf-annotation-links.mjs";
import { createPdfAnnotationCodec } from "./pdf-annotations.mjs";
import { normalizeRotation } from "./page-coordinates.mjs";
import { createExternalAnnotationCodec } from "./external-annotations.mjs";
import { mergePdfLayers } from "./pdf-layers.mjs";
import { initializeGeneratedPdf, copyPdfOutputIntents, generatedPdfVersionLabel } from "./pdf-document.mjs";
import { createImagePdf } from "./image-import.mjs";
import { annotationAppearanceState, annotationSavedState } from "./annotation-state.mjs";
import { annotationOutputFlags } from "./annotation-locks.mjs";

export class ExportSourceError extends Error {}

export function createPdfExporter(pdfLib) {
  const annotationCodec = createPdfAnnotationCodec(pdfLib);
  const externalCodec = createExternalAnnotationCodec(pdfLib);
  const featurePolicy = createPdfFeaturePolicy(pdfLib);
  const trackedByPdf = new WeakMap();
  const indexByPdf = new WeakMap();

  async function readSourceForEditing(file, reader, prepareExternal, password = "") {
    const restored = new Map();
    // 文書全体の注釈変更権限は編集対象の復元を制限しない。
    const source = await pdfLib.PDFDocument.load(await file.arrayBuffer(), { password, updateMetadata: false });
    const unsupportedFeatures = featurePolicy.inspect(source);
    if (source.getPageCount() !== reader.numPages) return { annotations: restored, unsupportedFeatures };
    const formFieldPages = featurePolicy.formFieldPages(source);
    for (const [index, page] of source.getPages().entries()) {
      const refs = annotationCodec.annotationRefs(page);
      const annotations = [];
      for (const ref of refs?.asArray() ?? []) {
        const dict = source.context.lookup(ref);
        if (dict instanceof pdfLib.PDFDict && featurePolicy.isDynamicAnnotation(dict)) continue;
        const native = annotationCodec.read(page, ref);
        if (prepareExternal && native?.foreignAppearance) {
          const appearance = externalCodec.read(page, ref)?.annotation;
          if (appearance && !(appearance.pdfFlags & (8 | 16))) {
            native.annotation.originalAppearance = {
              rect: appearance.rect, state: annotationAppearanceState(native.annotation),
            };
          }
        }
        const restoredAnnotation = native ?? externalCodec.read(page, ref);
        if (restoredAnnotation) annotations.push(restoredAnnotation);
      }
      if (annotations.length) restored.set(index, annotations);
    }
    if (prepareExternal) {
      try {
        const bytes = await externalCodec.appearancePdf(file, restored, password);
        if (bytes) await prepareExternal(bytes);
      } catch (error) {
        // 表示データを保てない注釈は、元のPDFの描画に残す。
        console.warn("外部注釈の表示データを準備できませんでした。", error);
        for (const [index, annotations] of restored) {
          restored.set(index, annotations.filter(entry => entry.annotation.kind !== "external" && !entry.annotation.originalAppearance));
        }
      }
    }
    for (const [index, annotations] of restored) {
      const editable = annotations.filter(({ annotation }) => !prepareExternal
        || !(annotation.kind === "external" || annotation.originalAppearance)
        || annotation.appearancePageIndex !== undefined);
      restored.set(index, editable);
      for (const entry of editable) {
        // UIが座標配列を変更しても、比較の基準を読み込み時のまま残す。
        entry.savedState = annotationSavedState(entry.annotation);
        reader.annotationStorage.setValue(entry.refId, { noView: true });
      }
    }
    return { annotations: restored, unsupportedFeatures, formFieldPages };
  }

  async function loadExportSourcePdfs(inputSources) {
    const inputPdfs = new Map();
    for (const [id, { file, pdfFile = file, reader, restoredAnnotations, password = "" }] of inputSources) {
      try {
        const bytes = await pdfFile.arrayBuffer();
        // 閲覧時にパスワードを尋ねない暗号化PDFも、空の閲覧パスワードで復号して読み込む。
        const pdf = await pdfLib.PDFDocument.load(bytes, { password, updateMetadata: false });
        if (pdf.getPageCount() !== reader.numPages) {
          throw new ExportSourceError("「" + file.name + "」のページをすべて読み込めませんでした。");
        }
        // 表示データやフォーム構造は作り直さず、保存用の文書から動作情報だけを除く。
        featurePolicy.removeActiveContent(pdf);
        const trackedPages = new Map();
        for (const [index, entries] of restoredAnnotations ?? []) {
          const refs = annotationCodec.annotationRefs(pdf.getPage(index));
          if (!refs) continue;
          trackedPages.set(index, entries.map(entry => ({
            refId: entry.refId, annotation: entry.annotation,
            savedState: entry.savedState ?? annotationSavedState(entry.annotation),
            ref: refs.get(refs.indexOf(entry.ref)),
          })));
        }
        trackedByPdf.set(pdf, trackedPages);
        inputPdfs.set(id, pdf);
      } catch (error) {
        if (error instanceof ExportSourceError) throw error;
        throw new ExportSourceError("「" + file.name + "」を保存用に読み込めませんでした。", { cause: error });
      }
    }
    return inputPdfs;
  }

  async function assembleOutputPdf(pages, inputPdfs, settings = {}) {
    if (!pages.length) throw new ExportSourceError("保存するページがありません。");
    const result = await pdfLib.PDFDocument.create();
    const pagesBySource = new Map();
    for (const page of pages) {
      if (!pagesBySource.has(page.sourcePdfId)) pagesBySource.set(page.sourcePdfId, []);
      pagesBySource.get(page.sourcePdfId).push(page);
    }

    // すべての元PDFを同じ経路で取り込む。ページ・レイヤー・ICCは同じ参照変換を使う。
    const copiesById = new Map();
    const graphs = new Map();
    try {
      for (const [id, entries] of pagesBySource) {
        const source = inputPdfs.get(id);
        if (!indexByPdf.has(source)) indexByPdf.set(source, indexPdfCopySource(pdfLib, source));
        const graph = createPdfCopyGraph(pdfLib, source, entries.map(page => page.sourceIndex), indexByPdf.get(source));
        graph.copier = pdfLib.PDFObjectCopier.for(graph.context, result.context);
        graphs.set(id, graph);
      }
      copyPdfFormData(pdfLib, result, graphs.values());
    } catch (error) {
      throw new ExportSourceError(error.message, { cause: error });
    }
    for (const [id, entries] of pagesBySource) {
      const source = inputPdfs.get(id);
      const { copier } = graphs.get(id);
      for (const entry of entries) {
        const ref = copier.copy(source.getPage(entry.sourceIndex).ref);
        copiesById.set(entry.id, pdfLib.PDFPage.of(result.context.lookup(ref), ref, result));
      }
      mergePdfLayers(pdfLib, result, source, copier, { keepAlternateConfigurations: graphs.size === 1 });
      // OutputIntents は文書全体の設定。投入順やクリック順ではなく、今回の出力の先頭ページで決める。
      // ページ別ZIPでは各PDFの先頭がそのページになる。先頭の元PDFにICCがなければ他から借りない。
      if (id === pages[0].sourcePdfId) copyPdfOutputIntents(pdfLib, result, source, copier);
    }
    for (const page of pages) {
      const copy = copiesById.get(page.id);
      if (page.addedRotation) {
        copy.setRotation(pdfLib.degrees(normalizeRotation(copy.getRotation().angle + page.addedRotation)));
      }
      result.addPage(copy);
      const originalEntries = trackedByPdf.get(inputPdfs.get(page.sourcePdfId)).get(page.sourceIndex) ?? [];
      const refs = annotationCodec.annotationRefs(copy);
      const tracked = originalEntries.map(entry => {
        const ref = graphs.get(page.sourcePdfId).copier.copy(entry.ref);
        return { ...entry, ref, position: refs?.indexOf(ref) };
      }).filter(entry => entry.position !== undefined);
      const nativeEntries = tracked.filter(entry => entry.annotation.kind !== "external");
      externalCodec.applyChanges(copy, tracked.filter(entry => entry.annotation.kind === "external"), page.annotations);
      // /NMは入力PDFで重複しうる。元オブジェクトを識別子にして、別の注釈を更新しない。
      const originals = new Map(nativeEntries.map(entry => [entry.refId, entry]));
      const current = new Set(page.annotations.map(annotation => annotation.sourceAnnotationRef));
      const removed = new Set(nativeEntries.filter(entry => !current.has(entry.refId)).map(entry => entry.ref.toString()));
      for (const annotation of page.annotations) {
        if (annotation.kind !== "external") {
          const original = originals.get(annotation.sourceAnnotationRef);
          const state = annotationSavedState(annotation);
          // 未編集なら、元の辞書・AP・未知の属性をそのままコピーして使う。
          if (original && state === original.savedState) continue;
          // ロックだけの変更では、見た目を再生成せずフラグだけを更新する。
          if (original && state === annotationSavedState({ ...JSON.parse(original.savedState), locked: annotation.locked })) {
            const dict = result.context.lookup(original.ref, pdfLib.PDFDict);
            dict.set(pdfLib.PDFName.of("F"), pdfLib.PDFNumber.of(annotationOutputFlags(annotation)));
            continue;
          }
          await annotationCodec.write(result, copy, annotation, original?.ref);
        }
      }
      removePdfAnnotationsAndReplies(pdfLib, copy, removed);
    }
    const uniqueSources = [...pagesBySource.keys()];
    const first = inputPdfs.get(uniqueSources[0]);
    let originalCreationDate;
    try { if (uniqueSources.length === 1) originalCreationDate = first.getCreationDate(); } catch { /* 不正な日時は生成日時にする。 */ }
    // 新規文書のバージョンは生成ライブラリに任せ、元PDFの宣言を転記しない。
    try { mergePdfNavigation(pdfLib, result, [...graphs.values()]); }
    catch (error) { throw new ExportSourceError(error.message, { cause: error }); }
    initializeGeneratedPdf(pdfLib, result, { ...settings, creationDate: originalCreationDate });
    applyPdfOutputSecurity(result, settings);
    featurePolicy.removeActiveContent(result);
    await result.flush();
    prunePdfObjects(pdfLib, result);
    // フォームの値からAPを再生成すると、元のフォントや現在の見た目が変わりうる。
    return result.save({ updateFieldAppearances: false });
  }

  async function outputVersionLabels() {
    // 起動時に実際の保存経路を1回ずつ通し、UIへ固定値や入力バージョンを渡さない。
    const seed = await pdfLib.PDFDocument.create(); seed.addPage([1, 1]);
    trackedByPdf.set(seed, new Map());
    const inputs = new Map([[0, seed]]);
    const page = { id: "version-check", sourcePdfId: 0, sourceIndex: 0, addedRotation: 0, annotations: [] };
    const labels = {};
    for (const mode of ["plain", "encrypted"]) {
      const permissions = normalizePdfPermissions(null);
      if (mode === "encrypted") permissions.annotating = false;
      const bytes = await assembleOutputPdf([page], inputs, { permissions });
      const saved = await pdfLib.PDFDocument.load(bytes, { password: "", updateMetadata: false });
      labels[mode] = generatedPdfVersionLabel(pdfLib, saved);
    }
    return labels;
  }

  return { readSourceForEditing, loadExportSourcePdfs, assembleOutputPdf, outputVersionLabels,
    convertImage: (file, format) => createImagePdf(pdfLib, file, format) };
}

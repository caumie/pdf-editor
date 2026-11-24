import { createAnnotationGestures } from "./annotation-gestures.mjs";
import { drawingStyleRanges, loadDrawingStyles, normalizeDrawingStyle, saveDrawingStyles, styleInputProperties, toolStyleFields } from "./drawing-styles.mjs";
import { createAnnotationCopies } from "./annotation-clipboard.mjs";
import { annotationSelectionLock, setAnnotationsLocked } from "./annotation-locks.mjs";
import { drawAnnotationsOnCanvas, isTextAnnotation } from "./annotations.mjs";
import { selectedHighlightQuads, selectedPageText } from "./text-highlight.mjs";
import { makeAnnotationName } from "./pdf-annotations.mjs";
import { changeDocumentAnnotations } from "./document-pages.mjs";
import { arrangeAnnotations } from "./annotation-layout.mjs";
import { loadStampImage, placeImageStamp } from "./image-stamp.mjs";
import { fitAnnotationToPage } from "./annotation-interaction.mjs";

export function createAnnotationTools({
  activePreviewPage,
  annotationAlignButtons,
  annotationClipboard,
  annotationEditor,
  annotationOverlay,
  commitDocumentRevision,
  documentHistory,
  interaction,
  pageView,
  createTextLayer,
  preview,
  previewModeButtons,
  previewStage,
  previewTextLayer,
  resetPointerOperation,
  previewBitmapScale,
  finishZoomForPointer,
  showStatus,
  ui,
  workspace,
  workspaceAvailable,
}) {
  let highlightTextLayer = null;
  const drawingStyles = loadDrawingStyles();

  function findAnnotation(id) {
    return id == null ? undefined : activePreviewPage()?.annotations.find(annotation => annotation.id === id);
  }

  function selectedAnnotation() {
    if (annotationEditor.selectedIds.size === 1) return findAnnotation([...annotationEditor.selectedIds][0]);
  }

  function hasAnnotationGroupSelection() {
    return annotationEditor.selectedIds.size > 1;
  }

  function selectedAnnotations() {
    return activePreviewPage()?.annotations.filter(annotation => annotationEditor.selectedIds.has(annotation.id)) ?? [];
  }

  function canPasteAnnotations() {
    return !ui["preview-edit-bars"].hidden && workspaceAvailable() && !interaction.pointerOperation && annotationClipboard.annotations.length > 0
      && Boolean(activePreviewPage()) && preview.bitmap?.pageId === pageView.previewPageId
      && preview.bitmap.addedRotation === activePreviewPage().addedRotation;
  }

  function copySelectedAnnotations() {
    if (ui["preview-edit-bars"].hidden || !workspaceAvailable() || interaction.pointerOperation) return false;
    const annotations = selectedAnnotations();
    if (!annotations.length || annotations.some(annotation => annotation.kind === "external")) return false;
    annotationClipboard.annotations = annotations.map(annotation => annotation.kind === "stamp"
      ? annotation : structuredClone(annotation));
    annotationClipboard.sourcePageId = pageView.previewPageId;
    annotationClipboard.pasteCounts.clear();
    updateAnnotationControls();
    return true;
  }

  function pasteAnnotations({ activateSelectionTool = true } = {}) {
    if (!canPasteAnnotations()) return false;
    const pageId = pageView.previewPageId;
    const count = annotationClipboard.pasteCounts.get(pageId)
      ?? (pageId === annotationClipboard.sourcePageId ? 1 : 0);
    const annotations = createAnnotationCopies(annotationClipboard.annotations, preview.bitmap.viewport,
      12 * count, () => annotationEditor.nextId++);
    if (activateSelectionTool) setPreviewTool("select");
    interaction.shortcutScope = "annotations";
    annotationEditor.selectedIds = new Set(annotations.map(annotation => annotation.id));
    annotationEditor.hoveredId = null;
    updatePageAnnotations(pageId, existing => [...existing, ...annotations]);
    annotationClipboard.pasteCounts.set(pageId, count + 1);
    return true;
  }

  function persistDrawingStyle(kind, style) {
    drawingStyles[kind] = style;
    try {
      saveDrawingStyles(drawingStyles);
    } catch {
      showStatus("書き込み設定をブラウザーに保存できません。現在の画面には反映されています。", { error: true });
    }
  }

  function ensureAnnotationsUnlocked(annotations = selectedAnnotations()) {
    if (!annotationSelectionLock(annotations).any) return true;
    showStatus("ロック中の注釈が含まれています。選択後、書き込み設定の「ロック」を外してください。");
    return false;
  }

  function changeAnnotationLock() {
    if (!workspaceAvailable() || interaction.pointerOperation) return;
    const selected = selectedAnnotations();
    const ids = new Set(selected.map(annotation => annotation.id));
    if (!ids.size) return;
    const locked = ui["mark-locked"].checked;
    updatePageAnnotations(pageView.previewPageId, annotations => setAnnotationsLocked(annotations, ids, locked));
    updateAnnotationControls();
    drawPreviewAnnotations();
  }

  function updateAnnotationControls(available = !workspace.busy) {
    const selected = selectedAnnotation();
    const groupSelected = hasAnnotationGroupSelection();
    const kind = groupSelected ? null : selected?.kind ?? annotationEditor.tool;
    const text = kind === "text";
    const hasStroke = text || kind === "rect" || kind === "pen" || kind === "line";
    const hasFill = text || kind === "rect" || kind === "note";
    const hasText = isTextAnnotation(kind);
    const highlight = kind === "highlight";
    const annotations = selectedAnnotations();
    const selectionCount = annotations.length;
    const lock = annotationSelectionLock(annotations);
    const selectionAvailable = available;
    ui["mark-select-options"].hidden = annotationEditor.tool !== "select";
    ui["mark-range-select"].disabled = !selectionAvailable || !activePreviewPage();
    ui["mark-range-select"].setAttribute("aria-pressed", String(annotationEditor.rangeSelect));
    annotationOverlay.dataset.rangeSelect = String(annotationEditor.rangeSelect);
    ui["mark-lock-options"].hidden = !selectionCount;
    ui["mark-locked"].disabled = !available || !selectionCount || Boolean(interaction.pointerOperation);
    ui["mark-locked"].checked = lock.any;
    ui["mark-locked"].indeterminate = lock.mixed;
    ui["mark-lock-state"].textContent = lock.mixed ? "混在（ロック " + lock.count + "/" + selectionCount + "）"
      : lock.any ? "解除すると編集できます" : "";
    available = available && !lock.any;
    ui["mark-selection-count"].textContent = "選択 " + selectionCount;
    ui["mark-multiselect"].disabled = !selectionAvailable;
    ui["mark-multiselect"].setAttribute("aria-pressed", String(annotationEditor.multiSelect));
    ui["alignment-options"].hidden = selectionCount < 2;
    for (const button of annotationAlignButtons) button.disabled = !available || selectionCount < (button.dataset.align.startsWith("distribute-") ? 3 : 2);
    ui["external-options"].hidden = kind !== "external" && !annotations.some(annotation => annotation.kind === "external");
    ui["line-arrow-field"].hidden = kind !== "line";
    ui["line-arrow-enabled"].disabled = !available || kind !== "line";
    ui["highlight-options"].hidden = !highlight;
    ui["highlight-color"].disabled = !available || !highlight;
    ui["highlight-transparency"].disabled = !available || !highlight;
    ui["apply-highlight"].hidden = annotationEditor.tool !== "highlight";
    ui["highlight-message"].hidden = annotationEditor.tool !== "highlight";
    updateHighlightAction();

    ui["stroke-options"].hidden = !hasStroke;
    ui["stroke-heading"].textContent = text || kind === "rect" ? "枠線" : "線";
    ui["text-border-enabled"].hidden = !text;
    ui["text-border-enabled"].disabled = !available || !text;
    const strokeDisabled = !available || !hasStroke || (text && !ui["text-border-enabled"].checked);
    for (const id of ["mark-color", "mark-width", "stroke-transparency"]) ui[id].disabled = strokeDisabled;
    const minimumWidth = drawingStyleRanges[text ? "boxBorderWidth" : "width"][0];
    ui["mark-width"].min = ui["mark-width"].step = String(minimumWidth);

    ui["fill-options"].hidden = !hasFill;
    ui["text-fill-enabled"].hidden = !text;
    ui["text-fill-enabled"].disabled = !available || !text;
    const fillDisabled = !available || !hasFill || (text && !ui["text-fill-enabled"].checked);
    ui["mark-fill"].disabled = fillDisabled;
    ui["fill-transparency-toggle"].hidden = !hasFill;
    ui["fill-transparency-field"].hidden = !hasFill;
    ui["fill-transparency-enabled"].disabled = fillDisabled;
    ui["fill-transparency"].disabled = ui["fill-transparency-enabled"].disabled || !ui["fill-transparency-enabled"].checked;

    ui["text-options"].hidden = !hasText;
    ui["text-color-field"].hidden = !text;
    ui["mark-edit"].hidden = !selected || !hasText;
    for (const id of ["text-color", "mark-size", "mark-bold", "mark-edit"]) ui[id].disabled = !available;

    ui["mark-select-all"].disabled = !selectionAvailable || !activePreviewPage()?.annotations.length;
    ui["mark-copy"].disabled = !selectionAvailable || (!selected && !groupSelected)
      || annotations.some(annotation => annotation.kind === "external");
    ui["mark-paste"].disabled = !selectionAvailable || !canPasteAnnotations();
    ui["mark-remove"].disabled = !available || (!selected && !groupSelected);
    annotationOverlay.dataset.manipulating = String(selectionCount > 0);
  }

  function setPreviewTool(kind) {
    if (workspace.busy || (kind && ui["preview-edit-bars"].hidden)) return;
    interaction.previewTouches?.reset();
    interaction.shortcutScope = "annotations";
    displayToolStyle(kind);
    annotationEditor.tool = kind;
    annotationEditor.multiSelect = false;
    annotationEditor.rangeSelect = false;
    previewStage.dataset.navigation = String(!kind);
    annotationEditor.selectedIds.clear();
    annotationEditor.hoveredId = null;
    interaction.suppressPreviewClick = false;
    resetPointerOperation();
    annotationOverlay.dataset.tool = kind ?? "";
    annotationOverlay.style.cursor = "";
    for (const button of previewModeButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.tool === (kind ?? "navigate")));
    }
    updateAnnotationControls();
    refreshHighlightTextLayer();
    drawPreviewAnnotations();
  }

  function refreshHighlightTextLayer() {
    const bitmap = annotationEditor.tool === "highlight" && preview.bitmap;
    if (bitmap && highlightTextLayer?.viewport === bitmap.viewport) return;
    if (highlightTextLayer) {
      const selection = document.getSelection();
      if ((selection?.anchorNode && previewTextLayer.contains(selection.anchorNode))
        || (selection?.focusNode && previewTextLayer.contains(selection.focusNode))) selection.removeAllRanges();
      highlightTextLayer.task.cancel();
      highlightTextLayer = null;
    }
    previewTextLayer.replaceChildren();
    previewTextLayer.hidden = true;
    ui["highlight-message"].textContent = "";
    updateHighlightAction();
    if (!bitmap) return;

    const { sourcePage, viewport } = bitmap;
    const totalScale = viewport.scale * viewport.userUnit;
    const width = viewport.rawDims.pageWidth * totalScale;
    const height = viewport.rawDims.pageHeight * totalScale;
    previewTextLayer.style.setProperty("--total-scale-factor", String(totalScale));
    ui["highlight-message"].textContent = "文字を読み込み中…";
    const task = createTextLayer({
      textContentSource: sourcePage.streamTextContent(),
      container: previewTextLayer,
      viewport,
    });
    const rendering = { viewport, task };
    highlightTextLayer = rendering;
    previewTextLayer.style.width = width + "px";
    previewTextLayer.style.height = height + "px";
    previewTextLayer.hidden = false;
    task.render().then(() => {
      if (highlightTextLayer !== rendering) return;
      ui["highlight-message"].textContent = task.textContentItemsStr.some(value => value.trim())
        ? "PDFの文字をドラッグして選択" : "選択できる文字がありません";
      updateHighlightAction();
    }).catch(error => {
      if (highlightTextLayer !== rendering) return;
      previewTextLayer.hidden = true;
      ui["highlight-message"].textContent = "文字を読み込めませんでした";
      console.warn(error);
      updateHighlightAction();
    });
  }

  function updateHighlightAction() {
    ui["apply-highlight"].disabled = workspace.busy || annotationEditor.tool !== "highlight"
      || !selectedPageText(document.getSelection(), previewTextLayer);
  }

  function applySelectedHighlight() {
    if (workspace.busy || annotationEditor.tool !== "highlight" || preview.bitmap?.pageId !== pageView.previewPageId) return;
    const selection = document.getSelection();
    const quads = selectedHighlightQuads(selection, previewTextLayer, ui["preview-active-page"], preview.bitmap.viewport);
    if (!quads.length) return;
    const annotation = { ...readToolStyle("highlight"), id: annotationEditor.nextId++, nativeName: makeAnnotationName("highlight"), kind: "highlight", quads };
    updatePageAnnotations(pageView.previewPageId, annotations => [...annotations, annotation]);
    selection.removeAllRanges();
    updateHighlightAction();
  }

  function updatePageAnnotations(pageId, change) {
    if (workspace.busy || ui["preview-edit-bars"].hidden) return;
    commitDocumentRevision(changeDocumentAnnotations(documentHistory.pages, pageId, change));
  }

  async function addDroppedStamp(file, target) {
    const { model, viewport, point } = target;
    let image;
    try { image = await loadStampImage(file); }
    catch {
      showStatus("画像スタンプを読み込めませんでした。", { error: true });
      return;
    }
    const page = documentHistory.pages.find(page => page.id === model.id);
    if (!workspaceAvailable() || ui["preview-edit-bars"].hidden || ui["mark-dialog"].open || interaction.pointerOperation
        || !page || page.addedRotation !== model.addedRotation) return;
    const annotation = fitAnnotationToPage({
      ...placeImageStamp(image, point, viewport),
      id: annotationEditor.nextId++, nativeName: makeAnnotationName("stamp"),
    }, viewport.viewBox);
    setPreviewTool("select");
    commitDocumentRevision(changeDocumentAnnotations(documentHistory.pages, page.id, annotations => [...annotations, annotation]), {
      ...pageView, previewPageId: page.id,
    });
    selectAnnotation(annotation);
    previewStage.focus({ preventScroll: true });
  }

  function replacePageAnnotation(pageId, replacement) {
    updatePageAnnotations(pageId, annotations => annotations.map(annotation =>
      annotation.id === replacement.id ? replacement : annotation));
  }

  function readToolStyle(kind) {
    const values = {};
    for (const [key, id] of Object.entries(toolStyleFields[kind])) {
      const input = ui[id];
      values[key] = input[styleInputProperties[input.type]];
    }
    return normalizeDrawingStyle(kind, values);
  }

  function displayToolStyle(kind, style = drawingStyles[kind]) {
    if (!style || !toolStyleFields[kind]) return;
    for (const [key, id] of Object.entries(toolStyleFields[kind])) {
      const input = ui[id];
      input[styleInputProperties[input.type]] = style[key];
    }
  }

  function selectAnnotation(annotation) {
    setAnnotationSelection(annotation ? [annotation.id] : []);
  }

  function setAnnotationSelection(ids) {
    if (ids.length && ui["preview-edit-bars"].hidden) return;
    const selected = ids.map(findAnnotation).filter(Boolean);
    if (selected.length) interaction.shortcutScope = "annotations";
    annotationEditor.selectedIds = new Set(selected.map(annotation => annotation.id));
    annotationEditor.hoveredId = null;
    if (selected.length === 1) displayToolStyle(selected[0].kind, selected[0]);
    else displayToolStyle(annotationEditor.tool);
    updateAnnotationControls();
    drawPreviewAnnotations();
  }

  function selectAllPageAnnotations({ activateSelectionTool = true } = {}) {
    const page = activePreviewPage();
    if (workspace.busy || ui["preview-edit-bars"].hidden || !page?.annotations.length) return;
    if (activateSelectionTool) setPreviewTool("select");
    setAnnotationSelection(page.annotations.map(annotation => annotation.id));
  }

  function toggleAnnotationSelection(annotation) {
    if (!annotation) return;
    const ids = new Set(selectedAnnotations().map(item => item.id));
    if (ids.has(annotation.id)) ids.delete(annotation.id);
    else ids.add(annotation.id);
    setAnnotationSelection([...ids]);
  }

  function toggleMultiSelection() {
    const next = !annotationEditor.multiSelect;
    const ids = selectedAnnotations().map(annotation => annotation.id);
    if (annotationEditor.tool !== "select") setPreviewTool("select");
    annotationEditor.multiSelect = next;
    setAnnotationSelection(ids);
  }

  function toggleRangeSelection() {
    if (workspace.busy || interaction.pointerOperation || annotationEditor.tool !== "select") return;
    annotationEditor.rangeSelect = !annotationEditor.rangeSelect;
    annotationOverlay.style.cursor = "";
    setPreviewHover(null);
    updateAnnotationControls();
  }

  function annotationSelectionGesture(modifiers) {
    if (annotationEditor.tool !== "select") return null;
    if (modifiers.shiftKey) return "toggle-range";
    if (modifiers.ctrlKey || modifiers.metaKey) return "toggle-annotation";
    if (annotationEditor.rangeSelect) return annotationEditor.multiSelect ? "add-range" : "replace-range";
    return annotationEditor.multiSelect ? "toggle-annotation" : null;
  }

  function arrangeSelectedAnnotations(action) {
    if (workspace.busy || interaction.pointerOperation || preview.bitmap?.pageId !== pageView.previewPageId) return;
    const originals = selectedAnnotations();
    if (!ensureAnnotationsUnlocked(originals)) return;
    const placed = arrangeAnnotations(originals, action, preview.bitmap.viewport);
    if (!placed.some((annotation, index) => annotation !== originals[index])) return;
    const byId = new Map(placed.map(annotation => [annotation.id, annotation]));
    updatePageAnnotations(pageView.previewPageId, annotations => annotations.map(annotation => byId.get(annotation.id) ?? annotation));
  }

  function commitToolStyle() {
    const annotation = selectedAnnotation();
    const kind = annotation?.kind ?? annotationEditor.tool;
    if (workspace.busy || hasAnnotationGroupSelection() || !drawingStyles[kind]) return;
    if (annotation && !ensureAnnotationsUnlocked([annotation])) return;
    const style = readToolStyle(kind);
    displayToolStyle(kind, style);
    persistDrawingStyle(kind, style);
    if (annotation) {
      const edited = { ...annotation, ...style };
      const placed = isTextAnnotation(annotation.kind) ? fitAnnotationToPage(edited, preview.bitmap?.viewport.viewBox) : edited;
      replacePageAnnotation(pageView.previewPageId, placed);
    } else {
      updateAnnotationControls();
    }
  }

  function removeSelectedAnnotations() {
    if (workspace.busy || ui["preview-edit-bars"].hidden) return;
    const groupSelected = hasAnnotationGroupSelection();
    if (!groupSelected && !selectedAnnotation()) return;
    if (!ensureAnnotationsUnlocked()) return;
    const ids = new Set(selectedAnnotations().map(annotation => annotation.id));
    selectAnnotation(null);
    updatePageAnnotations(pageView.previewPageId, annotations => annotations.filter(annotation => !ids.has(annotation.id)));
  }

  function styleForNewAnnotation(kind) {
    // 別の書き込みを編集している間も、次に描くツールはそのツール固有の設定を使う。
    return selectedAnnotation() || hasAnnotationGroupSelection() ? drawingStyles[kind] : readToolStyle(kind);
  }

  function openTextEditor(annotation, editing) {
    if (editing && !ensureAnnotationsUnlocked([annotation])) return;
    annotationEditor.textEdit = { pageId: pageView.previewPageId, annotation, editing };
    ui["mark-dialog-title"].textContent = (annotation.kind === "note" ? "付箋" : "テキスト")
      + (editing ? "を編集" : "を追加");
    ui["mark-text"].value = annotation.text;
    ui["mark-dialog"].showModal();
    ui["mark-text"].focus();
  }

  function submitTextEditor(event) {
    event.preventDefault();
    const entry = annotationEditor.textEdit;
    const text = ui["mark-text"].value;
    if (entry?.editing && !ensureAnnotationsUnlocked([findAnnotation(entry.annotation.id) ?? entry.annotation])) return;
    if (event.submitter?.value === "save") {
      if (!entry || !text.trim()) {
        ui["mark-text"].focus();
        return;
      }
      const annotation = { ...entry.annotation, text };
      if (!entry.editing || text !== entry.annotation.text) {
        const enteredAt = new Date().toISOString();
        if (!entry.editing) annotation.createdAt = enteredAt;
        annotation.modifiedAt = enteredAt;
      }
      const placed = fitAnnotationToPage(annotation, preview.bitmap?.viewport.viewBox);
      if (entry.editing) replacePageAnnotation(entry.pageId, placed);
      else updatePageAnnotations(entry.pageId, annotations => [...annotations, placed]);
      annotationEditor.hoveredId = null;
      selectAnnotation(placed);
    }
    annotationEditor.textEdit = null;
    ui["mark-dialog"].close();
  }

  function drawPreviewAnnotations() {
    if (preview.bitmap?.pageId !== pageView.previewPageId) return;
    const page = activePreviewPage();
    if (!page) return;
    let annotations = page.annotations;
    if (interaction.pointerOperation?.pageId === page.id) {
      const { kind, original, draft } = interaction.pointerOperation;
      if (kind === "draw") annotations = [...annotations, draft];
      if (kind === "edit") annotations = annotations.map(annotation => annotation.id === original.id ? draft : annotation);
      if (kind === "group-edit") {
        const byId = new Map(interaction.pointerOperation.drafts.map(annotation => [annotation.id, annotation]));
        annotations = annotations.map(annotation => byId.get(annotation.id) ?? annotation);
      }
    }
    drawAnnotationsOnCanvas(annotationOverlay, preview.bitmap.viewport, annotations, {
      ids: hasAnnotationGroupSelection() ? annotationEditor.selectedIds : undefined,
      id: visibleHandleAnnotationId(),
      candidateId: annotationEditor.selectionHover ? annotationEditor.hoveredId : null,
    }, undefined, ui["preview-highlights"]);
  }

  const gestures = createAnnotationGestures({
    preview, pageView, annotationOverlay, interaction, ui, workspace,
    annotationEditor, previewModeButtons, previewTextLayer, annotationAlignButtons,
    activePreviewPage,
    resetPointerOperation,
    previewBitmapScale,
    finishZoomForPointer,
    setAnnotationSelection,
    toggleAnnotationSelection,
    styleForNewAnnotation,
    drawPreviewAnnotations,
    updatePageAnnotations,
    selectAnnotation,
    openTextEditor,
    ensureAnnotationsUnlocked,
    hasAnnotationGroupSelection,
    selectedAnnotation,
    findAnnotation,
    annotationSelectionGesture,
    selectedAnnotations,
    replacePageAnnotation,
    setPreviewTool,
    changeAnnotationLock,
    commitToolStyle,
    updateHighlightAction,
    applySelectedHighlight,
    submitTextEditor,
    selectAllPageAnnotations,
    toggleMultiSelection,
    toggleRangeSelection,
    arrangeSelectedAnnotations,
    copySelectedAnnotations,
    pasteAnnotations,
    removeSelectedAnnotations,
  });
  const { setPreviewHover, visibleHandleAnnotationId } = gestures;

  return {
    ...gestures,
    addDroppedStamp,
    selectedAnnotation,
    hasAnnotationGroupSelection,
    copySelectedAnnotations,
    pasteAnnotations,
    updateAnnotationControls,
    setPreviewTool,
    refreshHighlightTextLayer,
    displayToolStyle,
    selectAnnotation,
    selectAllPageAnnotations,
    removeSelectedAnnotations,
    drawPreviewAnnotations,
  };
}

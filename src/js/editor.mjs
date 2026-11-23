import { createDocumentHistory } from "./document-history.mjs";
import { loadViewPreferences } from "./view-sizes.mjs";
import { createDocumentPropertiesUi } from "./document-properties-panel.mjs";
import { createUnsavedChangesGuard } from "./unsaved-changes.mjs";
import { clearSavedEditorSettings } from "./settings-storage.mjs";
import { bindSettingsMenu } from "./settings-menu.mjs";
import { createDownloadPanel } from "./download-panel.mjs";
import { createEditorFiles } from "./editor-files.mjs";
import { createPageActions } from "./page-actions.mjs";
import { createPageList } from "./page-list.mjs";
import { createPreviewController } from "./preview-controller.mjs";
import { createAnnotationTools } from "./annotation-tools.mjs";
import { createEditorInput } from "./editor-input.mjs";

const ui = Object.fromEntries(
  Array.from(document.querySelectorAll("[id]"), node => [node.id, node])
);
const previewStage = ui["preview-stage"];
const annotationOverlay = ui["preview-overlay"];
const previewTextLayer = ui["preview-text-layer"];
const workspace = {
  sourcePdfs: new Map(),
  nextSourcePdfId: 1,
  ready: false,
  busy: false,
};
const documentHistory = createDocumentHistory();
const pageView = { selectedPageIds: new Set(), previewPageId: null };
const viewPreferences = loadViewPreferences();
const preferences = { thumbnailSize: viewPreferences.thumbnailSize };
const interaction = {
  pointerOperation: null,
  previewHoverPointer: null,
  previewTouches: null,
  shortcutScope: "pages",
  suppressPreviewClick: false,
};
const preview = {
  renderVersion: 0,
  renderTask: null,
  rendering: false,
  renderKey: null,
  bitmap: null,
  requestedZoom: 1,
  zoomAnchor: null,
  zoomFrame: null,
  refineTimer: null,
  centerOnRender: false,
  fitSize: null,
};
const previewDisplay = { mode: "single", cover: true, direction: "left" };
const annotationEditor = {
  nextId: 1,
  tool: null,
  selectedIds: new Set(),
  hoveredId: null,
  selectionHover: false,
  textEdit: null,
  multiSelect: false,
  rangeSelect: false,
};
const annotationClipboard = { annotations: [], sourcePageId: null, pasteCounts: new Map() };
const previewModeButtons = [...document.querySelectorAll("button[data-tool]")];
const annotationAlignButtons = [...document.querySelectorAll("button[data-align]")];
const filePickerButtons = document.querySelectorAll("[data-add]");
const documentPropertiesUi = createDocumentPropertiesUi(ui, () => workspace.sourcePdfs,
  () => ui["export-scope"].value === "selected" ? documentHistory.pages.filter(page => pageView.selectedPageIds.has(page.id)) : documentHistory.pages,
  workspaceAvailable);
const downloadPanel = createDownloadPanel(ui, documentPropertiesUi, () => ({
  pages: documentHistory.pages, selectedIds: pageView.selectedPageIds,
  sources: workspace.sourcePdfs, available: workspaceAvailable(),
}), event => files.downloadExport(event));
const unsavedChanges = createUnsavedChangesGuard(window, () => ({
  pages: documentHistory.pages,
  settings: documentPropertiesUi.revisionSettings(),
  pending: Boolean(annotationEditor.textEdit && ui["mark-text"].value !== annotationEditor.textEdit.annotation.text)
    || interaction.pointerOperation?.kind === "draw"
    || (interaction.pointerOperation?.kind === "edit" && interaction.pointerOperation.draft !== interaction.pointerOperation.original)
    || (interaction.pointerOperation?.kind === "group-edit" && interaction.pointerOperation.drafts !== interaction.pointerOperation.originals),
}));

const files = createEditorFiles({
  ui, documentPropertiesUi, workspace, workspaceAvailable, showStatus, updateControls, documentHistory,
  annotationEditor, interaction, unsavedChanges, downloadPanel, pageView,
  commitDocumentRevision: (...args) => pages.commitDocumentRevision(...args),
  previewPageIds: (...args) => previewUi.previewPageIds(...args),
});

const pages = createPageActions({
  pageView, documentHistory, refreshDocumentViews, workspace, interaction,
  refreshPageSelection,
  releaseUnusedSourcePdfs: files.releaseUnusedSourcePdfs,
  activePreviewPageIndex: (...args) => previewUi.activePreviewPageIndex(...args),
  previewPageIds: (...args) => previewUi.previewPageIds(...args),
  selectAnnotation: (...args) => tools.selectAnnotation(...args),
  scrollPreviewPagesIntoView: (...args) => list.scrollPreviewPagesIntoView(...args),
});

const list = createPageList({
  ui, documentHistory, workspace, preferences, preview, filePickerButtons,
  pageView,
  pickPage: pages.pickPage,
  reorderPagesByDrop: pages.reorderPagesByDrop,
  loadSourcePage: files.loadSourcePage,
  previewPageIds: (...args) => previewUi.previewPageIds(...args),
});

const previewUi = createPreviewController({
  documentHistory, preview, ui, annotationEditor, previewStage, previewDisplay,
  interaction, annotationOverlay, workspace, pageView, refreshPageSelection, previewTextLayer,
  previewModeButtons, preferences,
  displayToolStyle: (...args) => tools.displayToolStyle(...args),
  selectedAnnotation: (...args) => tools.selectedAnnotation(...args),
  drawPreviewAnnotations: (...args) => tools.drawPreviewAnnotations(...args),
  refreshHighlightTextLayer: (...args) => tools.refreshHighlightTextLayer(...args),
  updateAnnotationControls: (...args) => tools.updateAnnotationControls(...args),
  setPreviewTool: (...args) => tools.setPreviewTool(...args),
  loadSourcePage: files.loadSourcePage,
  workspaceAvailable,
  renderVisibleThumbnails: list.renderVisibleThumbnails,
  scrollPreviewPagesIntoView: list.scrollPreviewPagesIntoView,
  setPreviewHover: (...args) => tools.setPreviewHover(...args),
  endStroke: (...args) => tools.endStroke(...args),
  endAnnotationDrag: (...args) => tools.endAnnotationDrag(...args),
  endAnnotationGroupDrag: (...args) => tools.endAnnotationGroupDrag(...args),
});

const tools = createAnnotationTools({
  annotationEditor, ui, interaction, annotationClipboard, preview, pageView,
  showStatus, workspace, annotationOverlay, annotationAlignButtons, previewStage, previewModeButtons,
  previewTextLayer, documentHistory,
  activePreviewPage: previewUi.activePreviewPage,
  resetPointerOperation: previewUi.resetPointerOperation,
  workspaceAvailable,
  createTextLayer: files.createTextLayer,
  commitDocumentRevision: pages.commitDocumentRevision,
  previewBitmapScale: previewUi.previewBitmapScale,
  finishZoomForPointer: previewUi.finishZoomForPointer,
});

const keys = createEditorInput({
  ui, interaction, preferences, clearDocument, filePickerButtons, pageView,
  documentHistory, refreshPageSelection, workspace, downloadPanel, previewDisplay,
  updateThumbnailSize: list.updateThumbnailSize,
  focusPageCard: list.focusPageCard,
  importDocumentFiles: files.importDocumentFiles,
  restoreDocumentRevision: pages.restoreDocumentRevision,
  rotateSelectedPages: pages.rotateSelectedPages,
  moveSelectedPages: pages.moveSelectedPages,
  removeSelectedPages: pages.removeSelectedPages,
  pickPage: pages.pickPage,
  endRangeSelection: tools.endRangeSelection,
  cancelPointerOperation: previewUi.cancelPointerOperation,
  activePreviewPage: previewUi.activePreviewPage,
  stepPreview: previewUi.stepPreview,
  activePreviewPageIndex: previewUi.activePreviewPageIndex,
  selectedAnnotation: tools.selectedAnnotation,
  hasAnnotationGroupSelection: tools.hasAnnotationGroupSelection,
  copySelectedAnnotations: tools.copySelectedAnnotations,
  pasteAnnotations: tools.pasteAnnotations,
  selectAllPageAnnotations: tools.selectAllPageAnnotations,
  selectAnnotation: tools.selectAnnotation,
  removeSelectedAnnotations: tools.removeSelectedAnnotations,
});

function workspaceAvailable() {
  return workspace.ready && !workspace.busy;
}

function showStatus(message, { error = false } = {}) {
  const toast = ui["editor-toast"];
  const title = error ? "エラー" : "注意";
  const body = ui["toast-message"];
  toast.hidden = !message;
  toast.classList.toggle("error", !!message && error);
  ui["toast-title"].textContent = message ? title : "";
  body.textContent = message;
  body.scrollTop = 0;
  // 読み上げ用の要素は常時置き、通知の表示で編集中のフォーカスを奪わない。
  ui["toast-live"].textContent = message ? title + "。 " + message : "";
}

function updateControls() {
  const available = workspaceAvailable();
  list.updatePageControls(available);
  downloadPanel.update();
  previewUi.updatePreviewControls(available);
  ui["clear-document"].disabled = !available || workspace.sourcePdfs.size === 0;
  ui["settings-menu-toggle"].disabled = workspace.busy;
}

function refreshDocumentViews() {
  const annotation = tools.selectedAnnotation();
  if (annotation) tools.displayToolStyle(annotation.kind, annotation);
  list.renderPageGrid();
  refreshPageSelection();
}

function refreshPageSelection() {
  list.updateSelection(previewUi.previewPageIds());
  previewUi.updatePreviewPageInfo();
  updateControls();
  previewUi.renderPreview();
  list.renderVisibleThumbnails();
}

function clearDocument() {
  if (!workspaceAvailable() || !workspace.sourcePdfs.size) return;
  if (!window.confirm("読み込んだファイル・書き込み・編集履歴をクリアして初期画面に戻します。未保存の編集は失われます。")) return;
  interaction.previewTouches?.reset();
  previewUi.stopPreviewZoom();
  previewUi.replacePreviewRender(null);
  previewUi.resetPointerOperation();
  documentHistory.clear();
  pageView.selectedPageIds.clear();
  pageView.previewPageId = null;
  preview.bitmap = null;
  preview.centerOnRender = false;
  annotationEditor.textEdit = null;
  annotationClipboard.annotations = [];
  annotationClipboard.sourcePageId = null;
  annotationClipboard.pasteCounts.clear();
  downloadPanel.reset();
  documentPropertiesUi.reset();
  ui["file-input"].value = "";
  previewDisplay.mode = "single"; previewDisplay.cover = true; previewDisplay.direction = "left";
  ui["preview-shadows"].replaceChildren();
  ui["preview-companions"].replaceChildren();
  ui["preview-base"].replaceChildren();
  annotationOverlay.width = annotationOverlay.height = 0;
  ui["preview-highlights"].width = ui["preview-highlights"].height = 0;
  ui["preview-highlights"].hidden = true;
  tools.setPreviewTool(null);
  interaction.shortcutScope = "pages";
  files.releaseUnusedSourcePdfs();
  list.renderPageGrid();
  refreshPageSelection();
  showStatus("");
  unsavedChanges.markSaved();
  ui["add-files"].focus();
}

function resetEditorSettings() {
  if (workspace.busy || interaction.pointerOperation) return;
  const message = "設定をデフォルトに戻して再読み込みしますか？"
    + "\n開いているファイルは閉じられ、未保存の編集は失われます。";
  if (!window.confirm(message)) return;
  try {
    clearSavedEditorSettings(window.localStorage);
  } catch (error) {
    console.error(error);
    showStatus("ブラウザに保存した設定を初期化できませんでした。", { error: true });
    return;
  }
  downloadPanel.reset();
  // 確認済みの再読み込みなので、離脱時に同じ確認を出さない。
  unsavedChanges.dispose();
  window.location.reload();
}

previewUi.setPreviewToolsVisible(viewPreferences.toolsVisible);
keys.bindPageControls();
ui["source-password-cancel"].addEventListener("click", () => ui["source-password-dialog"].close("cancel"));
list.bindPageDrag();
files.bindFileDrop();
previewUi.bindPreviewControls();
tools.bindAnnotationControls();
bindSettingsMenu(ui, () => downloadPanel.setOpen(false), resetEditorSettings);
ui["dismiss-toast"].addEventListener("click", () => {
  const focused = ui["editor-toast"].contains(document.activeElement);
  showStatus("");
  if (focused) {
    const target = ui["export-menu-toggle"].disabled ? ui["add-files"] : ui["export-menu-toggle"];
    target.focus({ preventScroll: true });
  }
});
document.addEventListener("keydown", keys.handleKeyboardShortcut);
files.initialize();

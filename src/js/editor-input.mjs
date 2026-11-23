import { saveViewPreferences } from "./view-sizes.mjs";
import { resolveEditorShortcut } from "./editor-shortcuts.mjs";
import { adjacentPreviewIndex } from "./preview-layout.mjs";

export function createEditorInput({
  activePreviewPage,
  activePreviewPageIndex,
  cancelPointerOperation,
  clearDocument,
  copySelectedAnnotations,
  documentHistory,
  downloadPanel,
  endRangeSelection,
  filePickerButtons,
  hasAnnotationGroupSelection,
  importDocumentFiles,
  interaction,
  moveSelectedPages,
  pageView,
  pasteAnnotations,
  pickPage,
  preferences,
  previewDisplay,
  refreshPageSelection,
  removeSelectedAnnotations,
  removeSelectedPages,
  restoreDocumentRevision,
  rotateSelectedPages,
  selectAllPageAnnotations,
  selectAnnotation,
  selectedAnnotation,
  stepPreview,
  focusPageCard,
  ui,
  updateThumbnailSize,
  workspace,
}) {
  function bindPageControls() {
    for (const [id, scope] of [["pages-panel", "pages"], ["preview-panel", "annotations"]]) {
      for (const type of ["pointerdown", "focusin"]) {
        ui[id].addEventListener(type, () => { interaction.shortcutScope = scope; }, { capture: true });
      }
    }
    updateThumbnailSize(preferences.thumbnailSize);
    ui["thumbnail-size"].addEventListener("change", event => {
      updateThumbnailSize(event.currentTarget.value);
      saveViewPreferences(preferences.thumbnailSize, !ui["preview-edit-bars"].hidden);
    });
    ui["clear-document"].addEventListener("click", clearDocument);
    const fileInput = ui["file-input"];
    for (const button of filePickerButtons) {
      button.addEventListener("click", () => fileInput.click());
    }
    fileInput.addEventListener("change", () => {
      const files = [...fileInput.files];
      fileInput.value = "";
      importDocumentFiles(files);
    });
    ui.undo.addEventListener("click", () => restoreDocumentRevision("undo"));
    ui.redo.addEventListener("click", () => restoreDocumentRevision("redo"));
    ui["rotate-pages-left"].addEventListener("click", () => rotateSelectedPages(-90));
    ui["rotate-pages-right"].addEventListener("click", () => rotateSelectedPages(90));
    ui["move-pages-earlier"].addEventListener("click", () => moveSelectedPages(-1));
    ui["move-pages-later"].addEventListener("click", () => moveSelectedPages(1));
    ui["remove-pages"].addEventListener("click", removeSelectedPages);
    ui["select-all-pages"].addEventListener("click", () => {
      pageView.selectedPageIds = new Set(documentHistory.pages.map(page => page.id));
      pageView.previewPageId ??= documentHistory.pages[0]?.id ?? null;
      refreshPageSelection();
    });
    ui["clear-page-selection"].addEventListener("click", () => {
      pageView.selectedPageIds.clear();
      refreshPageSelection();
    });
  }

  function handleKeyboardShortcut(event) {
    if (event.defaultPrevented || event.isComposing || ui["settings-menu"]?.hidden === false) return;
    const annotationToolsVisible = !ui["preview-edit-bars"].hidden;
    if (annotationToolsVisible && event.key === "Escape"
        && ["range-select", "draw", "edit", "group-edit"].includes(interaction.pointerOperation?.kind)) {
      if (interaction.pointerOperation.kind === "range-select") endRangeSelection(interaction.pointerOperation, true);
      else cancelPointerOperation();
      interaction.suppressPreviewClick = true;
      event.preventDefault();
      return;
    }
    const action = resolveEditorShortcut(event, {
      exportMenuOpen: !ui["export-form"].hidden, dialogOpen: ui["mark-dialog"].open || ui["source-properties-dialog"]?.open || ui["source-password-dialog"]?.open,
      scope: interaction.shortcutScope, busy: workspace.busy, operationInProgress: Boolean(interaction.pointerOperation),
      hasPages: documentHistory.pages.length > 0, hasActivePage: Boolean(activePreviewPage()),
      hasPageSelection: pageView.selectedPageIds.size > 0,
      hasAnnotationSelection: Boolean(selectedAnnotation() || hasAnnotationGroupSelection()),
      annotationToolsVisible, textSelected: document.getSelection()?.isCollapsed === false,
    });
    if (!action) return;
    // コピー・貼り付けを実行できないときは、通常のブラウザ操作を妨げない。
    if (action === "copy-annotations") { if (copySelectedAnnotations()) event.preventDefault(); return; }
    if (action === "paste-annotations") { if (pasteAnnotations({ activateSelectionTool: false })) event.preventDefault(); return; }
    event.preventDefault();
    switch (action) {
      case "prevent-native-select-all": return;
      case "close-export-menu": downloadPanel.setOpen(false, true); break;
      case "select-all-pages":
        pageView.selectedPageIds = new Set(documentHistory.pages.map(page => page.id));
        refreshPageSelection();
        break;
      case "select-all-annotations": selectAllPageAnnotations({ activateSelectionTool: false }); break;
      case "clear-annotation-selection": selectAnnotation(null); break;
      case "undo": case "redo": restoreDocumentRevision(action); break;
      case "previous-page": case "next-page": navigateFromKeyboard(action === "previous-page" ? -1 : 1); break;
      case "delete-pages": removeSelectedPages(); break;
      case "delete-annotations": removeSelectedAnnotations(); break;
    }
  }

  function navigateFromKeyboard(amount) {
    if (interaction.shortcutScope !== "pages") {
      stepPreview(amount * (previewDisplay.mode === "spread" && previewDisplay.direction === "right" ? -1 : 1));
      return;
    }
    const index = adjacentPreviewIndex(documentHistory.pages.length, activePreviewPageIndex(), previewDisplay, amount);
    const next = documentHistory.pages[index];
    if (!next) return;
    pickPage(next.id);
    focusPageCard(next.id);
  }

  return {
    bindPageControls,
    handleKeyboardShortcut,
  };
}

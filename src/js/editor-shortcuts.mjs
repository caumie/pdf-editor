// キーの解釈だけを担当する。文書の変更・preventDefault・フォーカス移動は呼び出し元で行う。
export function resolveEditorShortcut(event, state) {
  if (event.defaultPrevented || event.isComposing || state.dialogOpen) return null;
  if (state.exportMenuOpen && event.key === "Escape") return "close-export-menu";
  if (event.target?.closest?.("input, select, textarea, [contenteditable], #editor-toast")
      && !event.target.classList?.contains("page-check")) return null;
  const command = (event.ctrlKey || event.metaKey) && !event.altKey;
  const key = event.key.toLowerCase();
  const blocked = state.exportMenuOpen || state.busy || state.operationInProgress;
  if (command && !event.shiftKey && key === "a") {
    if (!blocked && state.hasPages && state.scope === "pages") return "select-all-pages";
    if (!state.annotationToolsVisible) return "prevent-native-select-all";
    return !blocked && state.hasPages ? "select-all-annotations" : null;
  }
  if (state.exportMenuOpen) return null;
  if (event.key === "Escape" && state.annotationToolsVisible && state.hasAnnotationSelection) return "clear-annotation-selection";
  if (blocked) return null;
  if (command) {
    if (!event.shiftKey && state.annotationToolsVisible) {
      if (key === "c" && !state.textSelected) return "copy-annotations";
      if (key === "v") return "paste-annotations";
    }
    if (key === "z") return event.shiftKey ? "redo" : "undo";
    if (key === "y") return "redo";
    return null;
  }
  if (event.altKey) return null;
  if (!event.shiftKey && ["ArrowLeft", "ArrowRight"].includes(event.key) && state.hasActivePage) {
    return event.key === "ArrowLeft" ? "previous-page" : "next-page";
  }
  if (["Delete", "Backspace"].includes(event.key)) {
    if (state.scope === "pages" && state.hasPageSelection) return "delete-pages";
    if (state.scope === "annotations" && state.annotationToolsVisible && state.hasAnnotationSelection) return "delete-annotations";
  }
  return null;
}

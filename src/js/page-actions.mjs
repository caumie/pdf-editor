import { moveDocumentPages, placeDocumentPages, removeDocumentPages, rotateDocumentPages } from "./document-pages.mjs";

export function createPageActions({
  activePreviewPageIndex,
  documentHistory,
  interaction,
  pageView,
  previewPageIds,
  refreshPageSelection,
  releaseUnusedSourcePdfs,
  scrollPreviewPagesIntoView,
  selectAnnotation,
  refreshDocumentViews,
  workspace,
}) {
  function commitDocumentRevision(pages, selection = pageView) {
    if (pages === documentHistory.pages) return;
    const discarded = documentHistory.commit(pages);
    updateDocumentSelection(selection);
    if (discarded) releaseUnusedSourcePdfs();
  }

  function updateDocumentSelection({ selectedPageIds, previewPageId }) {
    const ids = new Set(documentHistory.pages.map(page => page.id));
    pageView.selectedPageIds = new Set([...selectedPageIds].filter(id => ids.has(id)));
    pageView.previewPageId = ids.has(previewPageId) ? previewPageId : null;
    refreshDocumentViews();
  }

  function restoreDocumentRevision(direction) {
    const previousIndex = activePreviewPageIndex();
    if (workspace.busy || !documentHistory.step(direction)) return;
    const pages = documentHistory.pages;
    const fallback = pages[Math.min(pages.length - 1, Math.max(0, previousIndex))];
    const activePageId = pages.some(page => page.id === pageView.previewPageId)
      ? pageView.previewPageId : fallback?.id;
    updateDocumentSelection({ selectedPageIds: pageView.selectedPageIds, previewPageId: activePageId });
  }

  function rotateSelectedPages(angle) {
    if (workspace.busy || !pageView.selectedPageIds.size) return;
    commitDocumentRevision(rotateDocumentPages(documentHistory.pages, pageView.selectedPageIds, angle));
  }

  function removeSelectedPages() {
    if (workspace.busy || !pageView.selectedPageIds.size) return;
    const firstRemoved = documentHistory.pages.findIndex(page => pageView.selectedPageIds.has(page.id));
    const pages = removeDocumentPages(documentHistory.pages, pageView.selectedPageIds);
    const next = pages[firstRemoved] ?? pages[pages.length - 1];
    commitDocumentRevision(pages, { selectedPageIds: new Set(), previewPageId: next?.id ?? null });
  }

  function moveSelectedPages(direction) {
    if (workspace.busy || !pageView.selectedPageIds.size) return;
    commitDocumentRevision(moveDocumentPages(documentHistory.pages, pageView.selectedPageIds, direction));
  }

  function reorderPagesByDrop(draggedId, targetPageId, after) {
    const moving = pageView.selectedPageIds.has(draggedId) ? pageView.selectedPageIds : new Set([draggedId]);
    const pages = placeDocumentPages(documentHistory.pages, moving, targetPageId, after);
    commitDocumentRevision(pages, { selectedPageIds: moving, previewPageId: draggedId });
  }

  function pickPage(id, extend = false, range = false) {
    const pages = documentHistory.pages;
    const index = pages.findIndex(page => page.id === id);
    if (workspace.busy || index < 0) return;
    interaction.shortcutScope = "pages";
    selectAnnotation(null);
    if (range && pageView.previewPageId) {
      const start = activePreviewPageIndex();
      if (start >= 0) {
        for (const page of pages.slice(Math.min(start, index), Math.max(start, index) + 1)) {
          pageView.selectedPageIds.add(page.id);
        }
      }
    } else if (extend) {
      if (pageView.selectedPageIds.has(id)) pageView.selectedPageIds.delete(id);
      else pageView.selectedPageIds.add(id);
    } else {
      pageView.selectedPageIds = new Set(previewPageIds(index));
    }
    pageView.previewPageId = id;
    refreshPageSelection();
    if (!extend && !range) scrollPreviewPagesIntoView();
  }

  return {
    commitDocumentRevision,
    restoreDocumentRevision,
    rotateSelectedPages,
    removeSelectedPages,
    moveSelectedPages,
    reorderPagesByDrop,
    pickPage,
  };
}

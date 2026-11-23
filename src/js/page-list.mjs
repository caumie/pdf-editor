import { createThumbnailCache } from "./thumbnail-cache.mjs";
import { thumbnailSizes } from "./view-sizes.mjs";
import { renderPdfThumbnail } from "./pdf-preview.mjs";
import { drawAnnotationsOnCanvas } from "./annotations.mjs";
import { canMoveDocumentPages } from "./document-pages.mjs";

export function createPageList({
  documentHistory,
  filePickerButtons,
  loadSourcePage,
  pageView,
  pickPage,
  preferences,
  preview,
  previewPageIds,
  reorderPagesByDrop,
  ui,
  workspace,
}) {
  const thumbnailCards = new Map();
  const visibleThumbnails = new Set();
  const thumbnailCache = createThumbnailCache(32_000_000, url => URL.revokeObjectURL(url));
  const thumbnailObserver = new IntersectionObserver(onThumbnailsVisible, {
    root: ui["page-area"],
    rootMargin: "170px",
  });
  let activeThumbnailRenders = 0;

  function renderPageGrid() {
    const activeIds = new Set(documentHistory.pages.map(page => page.id));
    for (const [id, card] of thumbnailCards) {
      if (activeIds.has(id)) continue;
      thumbnailObserver.unobserve(card.element);
      visibleThumbnails.delete(card);
      clearThumbnail(card);
      card.element.remove();
      thumbnailCards.delete(id);
    }

    let position = ui["page-grid"].firstElementChild;
    documentHistory.pages.forEach((page, index) => {
      let card = thumbnailCards.get(page.id);
      if (!card) {
        card = createPageCard(page);
        thumbnailCards.set(page.id, card);
        thumbnailObserver.observe(card.element);
      }
      if (card.page !== page) clearThumbnail(card);
      card.page = page;
      const source = workspace.sourcePdfs.get(page.sourcePdfId);
      card.number.textContent = String(index + 1);
      card.sourceLabel.textContent = source.file.name;
      card.sourceLabel.title = source.file.name + " / p." + (page.sourceIndex + 1)
        + (page.addedRotation ? " / " + page.addedRotation + "°" : "")
        + (page.annotations.length ? " / 書き込み " + page.annotations.length : "");
      card.check.setAttribute("aria-label", (index + 1) + "ページ目を選択");
      if (card.element !== position) ui["page-grid"].insertBefore(card.element, position);
      position = card.element.nextElementSibling;
    });

    ui["page-grid"].hidden = !documentHistory.pages.length;
    ui["page-list-empty"].hidden = documentHistory.pages.length > 0;
    const hasHistory = documentHistory.canUndo || documentHistory.canRedo;
    ui["page-list-empty-title"].textContent = hasHistory ? "ページ一覧は空です" : "PDF・画像を追加";
    ui["page-list-empty-description"].textContent = hasHistory
      ? "ページを戻すか、新しいファイルを追加できます。"
      : "PDF・JPEG・PNGをまとめてドロップできます。";
    const documents = new Set(documentHistory.pages.map(page => page.sourcePdfId)).size;
    ui["page-list-count"].textContent = documentHistory.pages.length + "ページ" + (documents ? " / " + documents + "文書" : "");
  }

  function createPageCard(page) {
    const element = document.createElement("li");
    element.className = "page-card";
    element.dataset.id = page.id;

    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "page-pick";
    const frame = document.createElement("span");
    frame.className = "page-thumbnail";
    const number = document.createElement("span");
    number.className = "page-number";
    const sourceLabel = document.createElement("span");
    sourceLabel.className = "page-source";
    pick.append(number, frame, sourceLabel);
    pick.addEventListener("click", event => pickPage(page.id, event.ctrlKey || event.metaKey, event.shiftKey));

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "page-check";
    check.addEventListener("change", () => pickPage(page.id, true));

    element.append(pick, check);
    return { element, pick, frame, number, sourceLabel, check, page, renderedPage: null, thumbnail: null, task: null, pending: false };
  }

  function mountThumbnail(card, thumbnail) {
    const image = document.createElement("img");
    image.alt = "";
    image.src = thumbnail.url;
    card.frame.replaceChildren(image);
    card.thumbnail = thumbnail;
    card.renderedPage = card.page;
  }

  function clearThumbnail(card, keepImage = false) {
    card.task?.cancel();
    card.frame.replaceChildren();
    thumbnailCache.discard(card);
    const thumbnail = card.thumbnail;
    if (thumbnail) {
      if (keepImage && card.renderedPage === card.page) {
        thumbnailCache.put(card, thumbnail);
      } else {
        URL.revokeObjectURL(thumbnail.url);
      }
    }
    card.thumbnail = null;
    card.renderedPage = null;
  }

  function updateThumbnailSize(size) {
    preferences.thumbnailSize = size;
    ui["thumbnail-size"].value = size;
    const [width, height] = thumbnailSizes[size];
    const gridStyle = ui["page-grid"].style;
    gridStyle.setProperty("--thumb-min-width", width + "px");
    gridStyle.setProperty("--thumb-height", height + "px");
  }

  function onThumbnailsVisible(entries) {
    for (const entry of entries) {
      const card = thumbnailCards.get(entry.target.dataset.id);
      if (!card || card.element !== entry.target) continue;
      if (entry.isIntersecting) {
        visibleThumbnails.add(card);
        const cached = thumbnailCache.take(card);
        if (cached) mountThumbnail(card, cached);
      } else if (visibleThumbnails.delete(card)) {
        clearThumbnail(card, true);
      }
    }
    renderVisibleThumbnails();
  }

  function renderVisibleThumbnails() {
    if (preview.rendering) return;
    for (const card of visibleThumbnails) {
      if (activeThumbnailRenders >= 2) return;
      if (card.pending || card.renderedPage === card.page) continue;
      drawThumbnail(card);
    }
  }

  async function drawThumbnail(card) {
    const page = card.page;
    const [width, height] = thumbnailSizes.large;
    let canvas;
    card.pending = true;
    activeThumbnailRenders += 1;
    try {
      const sourcePage = await loadSourcePage(page);
      await workspace.sourcePdfs.get(page.sourcePdfId).externalRenderer?.prepare(page.annotations);
      if (!thumbnailStillCurrent(card, page)) return;
      const rendered = renderPdfThumbnail(sourcePage, page.addedRotation, width + 44, height);
      canvas = rendered.canvas;
      card.task = rendered.task;
      await rendered.task.promise;
      card.task = null;
      if (!thumbnailStillCurrent(card, page)) return;
      drawAnnotationsOnCanvas(canvas, rendered.viewport, page.annotations);
      const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      if (thumbnailCards.get(page.id) !== card || card.page !== page) return;
      if (!png) throw new Error("サムネイルをPNGに変換できませんでした");
      const thumbnail = { url: URL.createObjectURL(png), bytes: png.size };
      if (visibleThumbnails.has(card)) mountThumbnail(card, thumbnail);
      else thumbnailCache.put(card, thumbnail);
    } catch (error) {
      if (error.name !== "RenderingCancelledException" && thumbnailStillCurrent(card, page)) {
        const note = document.createElement("span");
        note.className = "page-thumbnail-message";
        note.textContent = "表示できません";
        card.frame.replaceChildren(note);
        card.renderedPage = page;
        console.warn(error);
      }
    } finally {
      if (canvas) canvas.width = canvas.height = 0;
      card.task = null;
      card.pending = false;
      activeThumbnailRenders -= 1;
      renderVisibleThumbnails();
    }
  }

  function thumbnailStillCurrent(card, page) {
    return visibleThumbnails.has(card) && thumbnailCards.get(page.id) === card && card.page === page;
  }

  function updatePageControls(available) {
    for (const button of filePickerButtons) button.disabled = !available;
    ui.undo.disabled = !available || !documentHistory.canUndo;
    ui.redo.disabled = !available || !documentHistory.canRedo;
    const hasSelection = pageView.selectedPageIds.size > 0;
    for (const key of ["rotate-pages-left", "rotate-pages-right", "remove-pages", "clear-page-selection"]) {
      ui[key].disabled = !available || !hasSelection;
    }
    ui["select-all-pages"].disabled = !available || documentHistory.pages.length === pageView.selectedPageIds.size;
    ui["move-pages-earlier"].disabled = !available || !canMoveDocumentPages(documentHistory.pages, pageView.selectedPageIds, -1);
    ui["move-pages-later"].disabled = !available || !canMoveDocumentPages(documentHistory.pages, pageView.selectedPageIds, 1);
    for (const card of thumbnailCards.values()) {
      card.element.draggable = available;
      card.pick.disabled = !available;
      card.check.disabled = !available;
    }
  }

  function scrollPreviewPagesIntoView() {
    const activeCard = thumbnailCards.get(pageView.previewPageId)?.element;
    if (!activeCard) return;
    const area = ui["page-area"];
    const bounds = area.getBoundingClientRect();
    const cards = previewPageIds().map(id => thumbnailCards.get(id)?.element).filter(Boolean);
    const rects = cards.map(card => card.getBoundingClientRect());
    const top = Math.min(...rects.map(rect => rect.top));
    const bottom = Math.max(...rects.map(rect => rect.bottom));
    const margin = 9;
    const target = bottom - top + margin * 2 <= bounds.height ? { top, bottom } : activeCard.getBoundingClientRect();
    if (target.top < bounds.top) area.scrollTop += target.top - bounds.top - margin;
    else if (target.bottom > bounds.bottom) area.scrollTop += target.bottom - bounds.bottom + margin;
  }

  function bindPageDrag() {
    let draggedPageId = null;
    let markedDrop = null;
    const grid = ui["page-grid"];
    grid.addEventListener("dragstart", event => {
      const card = event.target.closest(".page-card");
      if (!card || workspace.busy) return;
      draggedPageId = card.dataset.id;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedPageId);
    });
    grid.addEventListener("dragover", event => {
      if (!draggedPageId || workspace.busy) return;
      const card = event.target.closest(".page-card");
      if (!card || card.dataset.id === draggedPageId) {
        clearDropMarker();
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (markedDrop !== card) clearDropMarker();
      markedDrop = card;
      const rect = card.getBoundingClientRect();
      card.dataset.drop = event.clientX >= rect.left + rect.width / 2 ? "after" : "before";
    });
    grid.addEventListener("dragleave", event => {
      if (!grid.contains(event.relatedTarget)) clearDropMarker();
    });
    grid.addEventListener("drop", event => {
      if (!draggedPageId || !markedDrop || workspace.busy) return;
      event.preventDefault();
      reorderPagesByDrop(draggedPageId, markedDrop.dataset.id, markedDrop.dataset.drop === "after");
      draggedPageId = null;
      clearDropMarker();
    });
    grid.addEventListener("dragend", () => {
      draggedPageId = null;
      clearDropMarker();
    });
    function clearDropMarker() {
      if (markedDrop) delete markedDrop.dataset.drop;
      markedDrop = null;
    }
  }

  function updateSelection(previewingPageIds) {
    const visibleIds = new Set(previewingPageIds);
    for (const [id, card] of thumbnailCards) {
      const selected = pageView.selectedPageIds.has(id);
      card.element.classList.toggle("selected", selected);
      card.element.classList.toggle("previewing", visibleIds.has(id));
      card.pick.setAttribute("aria-pressed", String(selected));
      card.check.checked = selected;
    }
    ui["page-selection-count"].textContent = "選択 " + pageView.selectedPageIds.size;
  }

  function focusPageCard(id) {
    thumbnailCards.get(id)?.pick.focus({ preventScroll: true });
  }

  return {
    updateSelection,
    focusPageCard,
    renderPageGrid,
    updateThumbnailSize,
    renderVisibleThumbnails,
    updatePageControls,
    scrollPreviewPagesIntoView,
    bindPageDrag,
  };
}

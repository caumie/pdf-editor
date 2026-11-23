import { adjacentPreviewIndex, previewPageIndexes } from "./preview-layout.mjs";
import { renderPdfPreviewPages } from "./pdf-preview.mjs";
import { mountPreviewPages } from "./preview-view.mjs";
import { clientToPdfPoint } from "./page-coordinates.mjs";
import { clampPreviewZoom, previewZoomLimits, saveViewPreferences } from "./view-sizes.mjs";
import { bindPreviewTouchGestures } from "./preview-gestures.mjs";
import { bindPaneSeparator } from "./pane-separator.mjs";
import { createPreviewDetail } from "./preview-detail.mjs";

export function createPreviewController({
  annotationEditor,
  annotationOverlay,
  displayToolStyle,
  documentHistory,
  drawPreviewAnnotations,
  endAnnotationDrag,
  endAnnotationGroupDrag,
  endStroke,
  interaction,
  loadSourcePage,
  pageView,
  preferences,
  preview,
  previewDisplay,
  previewModeButtons,
  previewStage,
  previewTextLayer,
  refreshHighlightTextLayer,
  refreshPageSelection,
  renderVisibleThumbnails,
  scrollPreviewPagesIntoView,
  selectedAnnotation,
  setPreviewHover,
  setPreviewTool,
  ui,
  updateAnnotationControls,
  workspace,
  workspaceAvailable,
}) {
  const previewDetail = createPreviewDetail(previewStage, () =>
    preview.bitmap?.rasterZoom === preview.requestedZoom && preview.bitmap.displayZoom === preview.requestedZoom);
  const previewAnnotationVersions = new WeakMap();
  let nextPreviewAnnotationVersion = 1;

  function updatePreviewMeta(index = activePreviewPageIndex()) {
    const page = documentHistory.pages[index];
    const bitmap = preview.bitmap;
    const items = [];
    if (page) {
      items.push((index + 1) + "ページ目");
      if (bitmap?.pageId === page.id && bitmap.addedRotation === page.addedRotation) {
        const { width, height, scale } = bitmap.viewport;
        // ビューポートの寸法には回転とUserUnitが反映済み。プレビューの拡大率だけを取り除く。
        const cmPerPixel = 2.54 / (72 * scale);
        items.push((width * cmPerPixel).toFixed(2) + " × " + (height * cmPerPixel).toFixed(2) + " cm");
      }
      if (page.addedRotation) items.push("回転 +" + page.addedRotation + "°");
      if (page.annotations.length) items.push("書き込み " + page.annotations.length + "件");
    }
    const meta = ui["preview-meta"];
    meta.textContent = meta.title = items.join(" / ");
  }

  function updatePreviewPageInfo() {
    const index = activePreviewPageIndex();
    const page = documentHistory.pages[index];
    ui["preview-footer"].hidden = !page;
    updatePreviewMeta(index);
    const hadSingleSelection = annotationEditor.selectedIds.size === 1;
    const ids = new Set(page?.annotations.map(annotation => annotation.id));
    annotationEditor.selectedIds = new Set([...annotationEditor.selectedIds].filter(id => ids.has(id)));
    if (hadSingleSelection && !annotationEditor.selectedIds.size) displayToolStyle(annotationEditor.tool);
    if (!hadSingleSelection && annotationEditor.selectedIds.size === 1) {
      const annotation = selectedAnnotation();
      displayToolStyle(annotation.kind, annotation);
    }
    if (!ids.has(annotationEditor.hoveredId)) annotationEditor.hoveredId = null;
  }

  function showPreviewMessage(message) {
    ui["preview-message"].textContent = message;
    ui["preview-message"].hidden = false;
  }

  function replacePreviewRender(key) {
    if (key === null) previewDetail.clear();
    preview.renderTask?.cancel();
    preview.renderTask = null;
    preview.renderKey = key;
    preview.rendering = false;
    return ++preview.renderVersion;
  }

  function previewFitBounds() {
    return { width: Math.max(1, previewStage.clientWidth - 26), height: Math.max(1, previewStage.clientHeight - 26) };
  }

  async function renderPreview() {
    const page = activePreviewPage();
    const indexes = previewPageIndexes(documentHistory.pages.length, activePreviewPageIndex(), previewDisplay);
    const models = indexes.map(index => index === null ? null : documentHistory.pages[index]);
    // ページの移動や追加でも、最後にフィットの基準にした表示領域を使う。
    if (page) preview.fitSize ??= previewFitBounds();
    const { width, height } = preview.fitSize ?? {};
    const samePage = page && preview.bitmap?.pageId === page.id;
    if (!samePage || page.addedRotation !== preview.bitmap.addedRotation) stopPreviewZoom();
    else if (preview.zoomFrame !== null) { drawPreviewAnnotations(); return; }
    const zoom = preview.requestedZoom;
    const revisions = models.map(model => {
      if (!model) return "blank";
      if (!previewAnnotationVersions.has(model.annotations)) previewAnnotationVersions.set(model.annotations, nextPreviewAnnotationVersion++);
      const annotationVersion = model.id === page?.id
        ? model.annotations.filter(annotation => annotation.kind === "external").map(annotation => [annotation.id, annotation.scaleX ?? 1, annotation.scaleY ?? 1].join(":")).join(",")
        : previewAnnotationVersions.get(model.annotations);
      return [model.id, model.addedRotation, annotationVersion].join(":");
    });
    const key = page ? [page.id, ...revisions, previewDisplay.mode, previewDisplay.cover, previewDisplay.direction, width, height, zoom].join("/") : "empty";
    if (preview.renderKey === key) {
      if (preview.centerOnRender) { centerPreview(); preview.centerOnRender = false; }
      drawPreviewAnnotations(); return;
    }
    const version = replacePreviewRender(key);
    if (!samePage || !page) {
      previewDetail.clear();
      interaction.previewTouches?.reset();
      preview.bitmap = null;
      refreshHighlightTextLayer();
      resetPointerOperation();
      annotationEditor.hoveredId = null;
      annotationOverlay.style.cursor = "";
      ui["preview-sheet"].hidden = true;
      showPreviewMessage(page ? "ページを描画中…" : "ページを選ぶと表示されます。");
    }
    if (!page) return;
    preview.rendering = true;
    try {
      // ページ移動や倍率変更が待機中に起きる。新しい表示を古い非同期結果で上書きしない。
      const sourcePages = await Promise.all(models.map(model => model ? loadSourcePage(model) : null));
      if (version !== preview.renderVersion) return;
      await Promise.all(models.filter(Boolean).map(model => workspace.sourcePdfs.get(model.sourcePdfId).externalRenderer?.prepare(model.annotations, Math.max(3, zoom * 2))));
      if (version !== preview.renderVersion) return;
      const rendered = renderPdfPreviewPages(sourcePages, models.map(model => model?.addedRotation ?? 0),
        width, height, zoom, previewDisplay.direction);
      preview.renderTask = rendered.task;
      await rendered.task.promise;
      if (version !== preview.renderVersion) return;
      const anchor = !preview.centerOnRender && samePage ? captureZoomAnchor() : null;
      const activeIndex = models.findIndex(model => model?.id === page.id);
      const active = rendered.entries[activeIndex];
      preview.bitmap = { pageId: page.id, addedRotation: page.addedRotation, sourcePage: sourcePages[activeIndex], viewport: active.viewport,
        key, rasterZoom: zoom, displayZoom: zoom, spread: { width: rendered.width, height: rendered.height, x: active.x, y: active.y } };
      updatePreviewMeta();
      const pageLayers = mountPreviewPages({ activePage: ui["preview-active-page"], base: ui["preview-base"],
        shadows: ui["preview-shadows"], companions: ui["preview-companions"], surface: ui["preview-surface"], overlay: annotationOverlay },
        rendered, models, indexes, activeIndex, (model, event) => {
          if (event.detail !== 0 && interaction.suppressPreviewClick) { interaction.suppressPreviewClick = false; return; }
          if (workspace.busy) return;
          interaction.previewTouches?.reset();
          goToPreview(documentHistory.pages.findIndex(page => page.id === model.id));
        });
      previewDetail.setPages(pageLayers);
      ui["preview-sheet"].hidden = false; ui["preview-message"].hidden = true;
      layoutPreviewPage(zoom, anchor);
      preview.centerOnRender = false;
      refreshHighlightTextLayer();
      updateFitButton();
      drawPreviewAnnotations();
    } catch (error) {
      // 失敗したキーを成功済みとして扱わず、同じページ・倍率でも再描画できるようにする。
      if (version === preview.renderVersion) preview.renderKey = null;
      if (version === preview.renderVersion && error.name !== "RenderingCancelledException") {
        previewDetail.clear();
        preview.bitmap = null;
        updatePreviewMeta();
        refreshHighlightTextLayer();
        ui["preview-sheet"].hidden = true;
        showPreviewMessage("このページを表示できませんでした。");
        console.warn(error);
      }
    } finally {
      if (version === preview.renderVersion) {
        preview.renderTask = null; preview.rendering = false;
        updateAnnotationControls(workspaceAvailable() && Boolean(activePreviewPage()));
        renderVisibleThumbnails();
      }
    }
  }

  function activePreviewPageIndex() {
    return documentHistory.pages.findIndex(page => page.id === pageView.previewPageId);
  }

  function activePreviewPage() {
    return documentHistory.pages.find(page => page.id === pageView.previewPageId);
  }

  function previewPageIds(index = activePreviewPageIndex(), pages = documentHistory.pages) {
    return previewPageIndexes(pages.length, index, previewDisplay)
      .filter(index => index !== null).sort((a, b) => a - b).map(index => pages[index].id);
  }

  function goToPreview(index, { selectSpread = false } = {}) {
    const page = documentHistory.pages[index];
    if (workspace.busy || !page || page.id === pageView.previewPageId) return;
    pageView.previewPageId = page.id;
    if (selectSpread && previewDisplay.mode === "spread") pageView.selectedPageIds = new Set(previewPageIds(index));
    refreshPageSelection();
    scrollPreviewPagesIntoView();
  }

  function stepPreview(amount) {
    const index = activePreviewPageIndex();
    goToPreview(adjacentPreviewIndex(documentHistory.pages.length, index, previewDisplay, amount), { selectSpread: true });
  }

  function captureZoomAnchor(point) {
    const stage = previewStage.getBoundingClientRect();
    const surface = ui["preview-active-page"].getBoundingClientRect();
    const x = point?.clientX ?? stage.left + stage.width / 2;
    const y = point?.clientY ?? stage.top + stage.height / 2;
    const anchor = clientToPdfPoint(x, y, surface, preview.bitmap.viewport);
    return anchor && { pageId: pageView.previewPageId, point: anchor, x, y };
  }

  function previewBitmapScale() {
    return preview.bitmap.displayZoom / preview.bitmap.rasterZoom;
  }

  function layoutPreviewPage(zoom, anchor) {
    const stage = previewStage;
    const sheet = ui["preview-sheet"];
    const surface = ui["preview-surface"];
    const { viewport } = preview.bitmap;
    const scale = zoom / preview.bitmap.rasterZoom;
    const width = (preview.bitmap.spread?.width ?? viewport.width) * scale;
    const height = (preview.bitmap.spread?.height ?? viewport.height) * scale;
    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    const stageRect = anchor ? stage.getBoundingClientRect() : null;
    // 画面いっぱいに収まる倍率でも動かせるよう、用紙の周囲に余白を取る。
    const sheetWidth = Math.ceil(Math.max(stageWidth, width + 26) + stageWidth);
    const sheetHeight = Math.ceil(Math.max(stageHeight, height + 26) + stageHeight);

    preview.bitmap.displayZoom = zoom;
    sheet.style.width = sheetWidth + "px";
    sheet.style.height = sheetHeight + "px";
    surface.style.width = width + "px";
    surface.style.height = height + "px";
    previewTextLayer.style.setProperty("--text-zoom", String(scale));
    if (anchor?.pageId === preview.bitmap.pageId) {
      const [x, y] = viewport.convertToViewportPoint(...anchor.point);
      stage.scrollLeft = (sheetWidth - width) / 2 + ((preview.bitmap.spread?.x ?? 0) + x) * scale - (anchor.x - stageRect.left);
      stage.scrollTop = (sheetHeight - height) / 2 + ((preview.bitmap.spread?.y ?? 0) + y) * scale - (anchor.y - stageRect.top);
    } else {
      stage.scrollLeft = (sheetWidth - stageWidth) / 2;
      stage.scrollTop = (sheetHeight - stageHeight) / 2;
    }
    previewDetail.schedule();
  }

  function stopPreviewZoom() {
    if (preview.zoomFrame !== null) cancelAnimationFrame(preview.zoomFrame);
    preview.zoomFrame = null;
    preview.zoomAnchor = null;
    clearTimeout(preview.refineTimer);
  }

  function refinePreviewAfterZoom() {
    clearTimeout(preview.refineTimer);
    preview.refineTimer = setTimeout(renderPreview, 100);
  }

  function animatePreviewZoom() {
    if (!preview.bitmap) {
      stopPreviewZoom();
      return;
    }
    // ズーム中は既存のキャンバスを拡縮し、停止後にPDFを高精細で描く。
    const visible = preview.bitmap.displayZoom;
    const gap = preview.requestedZoom - visible;
    if (Math.abs(gap) <= 0.005 * Math.max(1, preview.requestedZoom)) {
      layoutPreviewPage(preview.requestedZoom, preview.zoomAnchor);
      preview.zoomFrame = null;
      preview.zoomAnchor = null;
      updateFitButton();
      refinePreviewAfterZoom();
    } else {
      layoutPreviewPage(visible + gap * 0.46, preview.zoomAnchor);
      preview.zoomFrame = requestAnimationFrame(animatePreviewZoom);
    }
  }

  function finishZoomForPointer() {
    if (preview.zoomFrame === null) return;
    preview.requestedZoom = preview.bitmap.displayZoom;
    stopPreviewZoom();
    updateZoomControls();
    refinePreviewAfterZoom();
  }

  function setZoom(value, point) {
    if (workspace.busy || !preview.bitmap || interaction.pointerOperation) return;
    const next = clampPreviewZoom(value);
    if (next === preview.requestedZoom) return;
    clearTimeout(preview.refineTimer);
    // 前の倍率の描画が途中で完了して、表示を巻き戻さないようにする。
    replacePreviewRender(preview.bitmap.key);
    preview.requestedZoom = next;
    if (point) {
      preview.zoomAnchor = captureZoomAnchor(point);
      if (preview.zoomFrame === null) preview.zoomFrame = requestAnimationFrame(animatePreviewZoom);
    } else {
      stopPreviewZoom();
      layoutPreviewPage(next, captureZoomAnchor());
      refinePreviewAfterZoom();
    }
    updateZoomControls();
  }

  function fitPreviewToStage() {
    if (workspace.busy || !preview.bitmap || interaction.pointerOperation) return;
    stopPreviewZoom();
    preview.fitSize = null;
    preview.requestedZoom = 1;
    preview.centerOnRender = true;
    updateZoomControls();
    return renderPreview();
  }

  function resizePreviewStage() {
    if (preview.bitmap && !interaction.pointerOperation) {
      layoutPreviewPage(preview.bitmap.displayZoom, captureZoomAnchor());
    }
    updateFitButton();
  }

  function previewCenterScroll() {
    const stage = previewStage;
    return [Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2),
      Math.max(0, (stage.scrollHeight - stage.clientHeight) / 2)];
  }

  function centerPreview() {
    const stage = previewStage;
    [stage.scrollLeft, stage.scrollTop] = previewCenterScroll();
    updateFitButton();
  }

  function updateFitButton() {
    const fit = ui["zoom-fit"];
    if (!workspace.ready || workspace.busy || !pageView.previewPageId || preview.bitmap?.pageId !== pageView.previewPageId) {
      fit.disabled = true;
      return;
    }
    const bounds = previewFitBounds();
    if (preview.requestedZoom !== 1 || preview.fitSize?.width !== bounds.width || preview.fitSize?.height !== bounds.height) {
      fit.disabled = false;
      return;
    }
    const stage = previewStage;
    const [x, y] = previewCenterScroll();
    fit.disabled = Math.abs(stage.scrollLeft - x) <= 1 && Math.abs(stage.scrollTop - y) <= 1;
  }

  function startPreviewPan(event) {
    if (event.button !== 0 || annotationEditor.tool || !preview.bitmap || workspace.busy || interaction.pointerOperation) return;
    const stage = previewStage;
    const box = stage.getBoundingClientRect();
    if (event.clientX >= box.left + stage.clientWidth || event.clientY >= box.top + stage.clientHeight) return;
    interaction.suppressPreviewClick = false;
    finishZoomForPointer();
    interaction.pointerOperation = {
      kind: "pan",
      pointerId: event.pointerId,
      x: event.clientX, y: event.clientY,
      left: stage.scrollLeft, top: stage.scrollTop,
      moved: false,
    };
  }

  function movePreviewPan(event) {
    const pan = interaction.pointerOperation;
    if (pan?.kind !== "pan" || pan.pointerId !== event.pointerId) return;
    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    if (!pan.moved && Math.hypot(dx, dy) < 4) return;
    const stage = previewStage;
    if (!pan.moved) {
      pan.moved = true;
      stage.setPointerCapture(event.pointerId);
      stage.dataset.panning = "true";
      annotationOverlay.style.cursor = "";
      setPreviewHover(null);
    }
    stage.scrollLeft = pan.left - dx;
    stage.scrollTop = pan.top - dy;
    updateFitButton();
  }

  function resetPointerOperation() {
    const operation = interaction.pointerOperation;
    interaction.pointerOperation = null;
    delete previewStage.dataset.panning;
    if (operation?.kind === "range-select") {
      ui["preview-selection-box"].hidden = true;
      if (annotationOverlay.hasPointerCapture(operation.pointerId)) annotationOverlay.releasePointerCapture(operation.pointerId);
    }
  }

  function cancelPointerOperation() {
    const event = { pointerId: interaction.pointerOperation?.pointerId };
    if (interaction.pointerOperation?.kind === "draw") endStroke(event, true);
    else if (interaction.pointerOperation?.kind === "edit") endAnnotationDrag(event, true);
    else if (interaction.pointerOperation?.kind === "group-edit") endAnnotationGroupDrag(event, true);
    resetPointerOperation();
  }

  function endPreviewPan(event) {
    if (interaction.pointerOperation?.kind !== "pan" || interaction.pointerOperation.pointerId !== event.pointerId) return;
    if (interaction.pointerOperation.moved) interaction.suppressPreviewClick = true;
    resetPointerOperation();
  }

  function updateZoomControls(available = workspace.ready && !workspace.busy && Boolean(preview.bitmap)) {
    ui["zoom-out"].disabled = !available || preview.requestedZoom <= previewZoomLimits.min;
    ui["zoom-in"].disabled = !available || preview.requestedZoom >= previewZoomLimits.max;
    updateFitButton();
    ui["zoom-level"].textContent = Math.round(preview.requestedZoom * 100) + "%";
  }

  function updatePreviewControls(available) {
    const index = activePreviewPageIndex();
    const hasPage = available && index >= 0;
    ui["preview-prev"].disabled = !hasPage || adjacentPreviewIndex(documentHistory.pages.length, index, previewDisplay, -1) < 0;
    ui["preview-next"].disabled = !hasPage || adjacentPreviewIndex(documentHistory.pages.length, index, previewDisplay, 1) >= documentHistory.pages.length;
    ui["preview-tools-toggle"].disabled = !available;
    updatePreviewDisplayControls(hasPage);
    updateZoomControls(hasPage);
    for (const button of previewModeButtons) button.disabled = !hasPage;
    updateAnnotationControls(hasPage);
  }

  function updatePreviewDisplayControls(available) {
    ui["preview-layout"].value = previewDisplay.mode;
    ui["preview-layout"].disabled = !available;
    ui["preview-cover"].checked = previewDisplay.cover;
    ui["preview-direction"].value = previewDisplay.direction;
    ui["preview-cover"].disabled = ui["preview-direction"].disabled = !available || previewDisplay.mode !== "spread";
    ui["preview-view-options"].hidden = previewDisplay.mode !== "spread";
    const reversed = previewDisplay.mode === "spread" && previewDisplay.direction === "right";
    ui["preview-prev"].textContent = reversed ? "→" : "←";
    ui["preview-next"].textContent = reversed ? "←" : "→";
    ui["preview-prev"].title = "前の表示（" + (reversed ? "→" : "←") + "）";
    ui["preview-next"].title = "次の表示（" + (reversed ? "←" : "→") + "）";
  }

  function applyPreviewDisplay() {
    if (workspace.busy) return;
    const previousIds = previewPageIds();
    const selectionFollowsPreview = previousIds.length === pageView.selectedPageIds.size
      && previousIds.every(id => pageView.selectedPageIds.has(id));
    interaction.previewTouches?.reset();
    cancelPointerOperation();
    preview.fitSize = null;
    previewDisplay.mode = ui["preview-layout"].value === "spread" ? "spread" : "single";
    previewDisplay.cover = ui["preview-cover"].checked;
    const direction = ui["preview-direction"].value;
    previewDisplay.direction = ["left", "right", "vertical"].includes(direction) ? direction : "left";
    if (selectionFollowsPreview) pageView.selectedPageIds = new Set(previewPageIds());
    stopPreviewZoom();
    preview.requestedZoom = 1;
    preview.centerOnRender = true;
    replacePreviewRender(null);
    requestAnimationFrame(() => {
      refreshPageSelection();
      scrollPreviewPagesIntoView();
    });
  }

  function setPreviewToolsVisible(visible) {
    ui["preview-edit-bars"].hidden = !visible;
    ui["preview-panel"].dataset.toolsHidden = String(!visible);
    const button = ui["preview-tools-toggle"];
    button.setAttribute("aria-expanded", String(visible));
    button.setAttribute("aria-pressed", String(visible));
  }

  function togglePreviewTools() {
    if (workspace.busy || interaction.pointerOperation) return;
    const anchor = preview.bitmap ? captureZoomAnchor() : null;
    const visible = ui["preview-edit-bars"].hidden;
    setPreviewToolsVisible(visible);
    saveViewPreferences(preferences.thumbnailSize, visible);
    if (visible) updateAnnotationControls();
    else setPreviewTool(null);
    if (preview.bitmap) {
      stopPreviewZoom();
      layoutPreviewPage(preview.requestedZoom, anchor);
      if (preview.bitmap.rasterZoom !== preview.requestedZoom) refinePreviewAfterZoom();
      updateFitButton();
    }
  }

  function bindPreviewControls() {
    ui["preview-tools-toggle"].addEventListener("click", togglePreviewTools);
    for (const id of ["preview-layout", "preview-cover", "preview-direction"]) ui[id].addEventListener("change", applyPreviewDisplay);
    interaction.previewTouches = bindPreviewTouchGestures(previewStage, {
      canStart: () => Boolean(preview.bitmap) && !workspace.busy && !ui["mark-dialog"].open,
      start(point) {
        cancelPointerOperation();
        finishZoomForPointer();
        stopPreviewZoom();
        replacePreviewRender(preview.bitmap.key);
        interaction.pointerOperation = { kind: "pinch", zoom: preview.bitmap.displayZoom,
          distance: point.distance, anchor: captureZoomAnchor(point) };
        interaction.suppressPreviewClick = true;
        setPreviewHover(null);
      },
      move(point) {
        const gesture = interaction.pointerOperation;
        if (gesture?.kind !== "pinch") return;
        preview.requestedZoom = clampPreviewZoom(gesture.zoom * point.distance / gesture.distance);
        layoutPreviewPage(preview.requestedZoom, { ...gesture.anchor, x: point.clientX, y: point.clientY });
        updateZoomControls();
      },
      end() {
        if (interaction.pointerOperation?.kind !== "pinch") return;
        resetPointerOperation();
        updateZoomControls();
        refinePreviewAfterZoom();
      },
    });
    window.addEventListener("blur", () => {
      interaction.previewTouches.reset();
      cancelPointerOperation();
      interaction.previewHoverPointer = null;
      annotationOverlay.style.cursor = "";
      setPreviewHover(null);
    });
    bindPaneSeparator(ui["pane-separator"], ui["pages-panel"], ui["preview-panel"], ui.workspace);

    ui["preview-prev"].addEventListener("click", () => stepPreview(-1));
    ui["preview-next"].addEventListener("click", () => stepPreview(1));
    ui["zoom-out"].addEventListener("click", () => setZoom(preview.requestedZoom / 1.25));
    ui["zoom-in"].addEventListener("click", () => setZoom(preview.requestedZoom * 1.25));
    ui["zoom-fit"].addEventListener("click", fitPreviewToStage);
    previewStage.addEventListener("wheel", event => {
      if (!preview.bitmap || workspace.busy || interaction.pointerOperation || !event.deltaY) return;
      event.preventDefault();
      if (event.shiftKey) {
        const unit = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? previewStage.clientHeight : 1;
        previewStage.scrollTop += event.deltaY * unit;
        return;
      }
      const magnitude = Math.min(1, Math.abs(event.deltaY) * (event.deltaMode ? 0.25 : 0.012));
      setZoom(preview.requestedZoom * Math.pow(1.23, event.deltaY < 0 ? magnitude : -magnitude), event);
    }, { passive: false });
    new ResizeObserver(resizePreviewStage).observe(previewStage);

    previewStage.addEventListener("pointerdown", startPreviewPan);
    previewStage.addEventListener("pointermove", movePreviewPan);
    previewStage.addEventListener("pointerup", endPreviewPan);
    previewStage.addEventListener("pointercancel", endPreviewPan);
    previewStage.addEventListener("lostpointercapture", event => {
      if (event.target === previewStage) endPreviewPan(event);
    });
    previewStage.addEventListener("pointerleave", event => {
      if (!interaction.pointerOperation?.moved) endPreviewPan(event);
    });
    previewStage.addEventListener("scroll", () => {
      updateFitButton();
      previewDetail.schedule();
    });
  }

  return {
    updatePreviewPageInfo,
    replacePreviewRender,
    renderPreview,
    activePreviewPageIndex,
    activePreviewPage,
    previewPageIds,
    stepPreview,
    previewBitmapScale,
    stopPreviewZoom,
    finishZoomForPointer,
    resetPointerOperation,
    cancelPointerOperation,
    updatePreviewControls,
    bindPreviewControls,
    setPreviewToolsVisible,
  };
}

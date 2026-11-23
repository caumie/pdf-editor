import { clientToPdfPoint, pdfViewportScale } from "./page-coordinates.mjs";
import { annotationDragCursor, annotationsInSelectionBox, findAnnotationHandle, fitAnnotationToPage, hitTestAnnotation, pointInBounds, transformAnnotationDrag } from "./annotation-interaction.mjs";
import { makeAnnotationName } from "./pdf-annotations.mjs";
import { annotationBounds, isTextAnnotation, renderTextAnnotationImage } from "./annotations.mjs";
import { annotationGroupBounds, translateAnnotationGroup } from "./annotation-layout.mjs";
import { annotationSelectionLock } from "./annotation-locks.mjs";

export function createAnnotationGestures({
  activePreviewPage,
  annotationAlignButtons,
  annotationEditor,
  annotationOverlay,
  annotationSelectionGesture,
  applySelectedHighlight,
  arrangeSelectedAnnotations,
  changeAnnotationLock,
  commitToolStyle,
  copySelectedAnnotations,
  drawPreviewAnnotations,
  ensureAnnotationsUnlocked,
  findAnnotation,
  finishZoomForPointer,
  hasAnnotationGroupSelection,
  interaction,
  openTextEditor,
  pageView,
  pasteAnnotations,
  preview,
  previewBitmapScale,
  previewModeButtons,
  previewTextLayer,
  removeSelectedAnnotations,
  replacePageAnnotation,
  resetPointerOperation,
  selectAllPageAnnotations,
  selectAnnotation,
  selectedAnnotation,
  selectedAnnotations,
  setAnnotationSelection,
  setPreviewTool,
  styleForNewAnnotation,
  submitTextEditor,
  toggleAnnotationSelection,
  toggleMultiSelection,
  toggleRangeSelection,
  ui,
  updateHighlightAction,
  updatePageAnnotations,
  workspace,
}) {
  function pointerToPdfPoint(event, bounded = false) {
    if (preview.bitmap?.pageId !== pageView.previewPageId) return null;
    const box = annotationOverlay.getBoundingClientRect();
    return clientToPdfPoint(event.clientX, event.clientY, box, preview.bitmap.viewport, bounded);
  }

  function beginRangeSelection(event, point, gesture) {
    const page = activePreviewPage();
    if (!point || !page || preview.bitmap.addedRotation !== page.addedRotation) return;
    event.preventDefault();
    interaction.shortcutScope = "annotations";
    setPreviewHover(null);
    interaction.pointerOperation = {
      kind: "range-select", pointerId: event.pointerId, pageId: page.id, addedRotation: page.addedRotation,
      start: point, end: point, clientX: event.clientX, clientY: event.clientY, moved: false,
      gesture,
    };
    annotationOverlay.setPointerCapture(event.pointerId);
  }

  function moveRangeSelection(event) {
    const operation = interaction.pointerOperation;
    if (operation?.kind !== "range-select" || operation.pointerId !== event.pointerId) return;
    const end = pointerToPdfPoint(event, true);
    if (!end || operation.pageId !== pageView.previewPageId || operation.addedRotation !== preview.bitmap.addedRotation) return;
    if (!operation.moved && Math.hypot(event.clientX - operation.clientX, event.clientY - operation.clientY) < 4) return;
    operation.moved = true;
    operation.end = end;
    const viewport = preview.bitmap.viewport;
    const [x0, y0] = viewport.convertToViewportPoint(...operation.start);
    const [x1, y1] = viewport.convertToViewportPoint(...end);
    const box = ui["preview-selection-box"];
    box.style.left = Math.min(x0, x1) / viewport.width * 100 + "%";
    box.style.top = Math.min(y0, y1) / viewport.height * 100 + "%";
    box.style.width = Math.abs(x1 - x0) / viewport.width * 100 + "%";
    box.style.height = Math.abs(y1 - y0) / viewport.height * 100 + "%";
    box.hidden = false;
  }

  function endRangeSelection(event, cancel = false) {
    const operation = interaction.pointerOperation;
    if (operation?.kind !== "range-select" || operation.pointerId !== event.pointerId) return;
    if (!cancel) moveRangeSelection(event);
    resetPointerOperation();
    annotationOverlay.style.cursor = "";
    const page = activePreviewPage();
    if (!cancel && !workspace.busy && page?.id === operation.pageId && page.addedRotation === operation.addedRotation) {
      if (operation.moved) {
        const hits = annotationsInSelectionBox(page.annotations, operation.start, operation.end);
        const ids = new Set(operation.gesture === "replace-range" ? [] : annotationEditor.selectedIds);
        for (const { id } of hits) {
          if (operation.gesture === "toggle-range" && ids.has(id)) ids.delete(id);
          else ids.add(id);
        }
        setAnnotationSelection([...ids]);
      } else if (operation.gesture !== "replace-range") {
        toggleAnnotationSelection(annotationAt(operation.start));
      } else {
        clickPreview(event);
      }
    }
    interaction.suppressPreviewClick = true;
  }

  function beginStroke(event) {
    if (workspace.busy || event.button !== 0 || interaction.pointerOperation || !["pen", "line", "rect"].includes(annotationEditor.tool)) return;
    const point = pointerToPdfPoint(event, true);
    if (!point) return;
    event.preventDefault();
    interaction.pointerOperation = {
      kind: "draw",
      pointerId: event.pointerId,
      pageId: pageView.previewPageId,
      draft: {
        id: annotationEditor.nextId++, nativeName: makeAnnotationName(annotationEditor.tool),
        kind: annotationEditor.tool, points: [point], ...styleForNewAnnotation(annotationEditor.tool),
      },
    };
    annotationOverlay.setPointerCapture(event.pointerId);
    drawPreviewAnnotations();
  }

  function extendStroke(event) {
    if (interaction.pointerOperation?.kind !== "draw" || interaction.pointerOperation.pointerId !== event.pointerId) return;
    const point = pointerToPdfPoint(event, true);
    if (!point) return;
    const annotation = interaction.pointerOperation.draft;
    if (annotation.kind === "line" || annotation.kind === "rect") {
      if (annotation.kind === "rect" || annotation.points[0][0] !== point[0] || annotation.points[0][1] !== point[1]) {
        annotation.points[1] = point;
      } else {
        annotation.points.length = 1;
      }
    } else {
      const previous = annotation.points.at(-1);
      if (Math.hypot(point[0] - previous[0], point[1] - previous[1]) < 0.4 || annotation.points.length >= 6000) return;
      annotation.points.push(point);
    }
    drawPreviewAnnotations();
  }

  function endStroke(event, cancel = false) {
    if (interaction.pointerOperation?.kind !== "draw" || interaction.pointerOperation.pointerId !== event.pointerId) return;
    if (!cancel) extendStroke(event);
    const { pageId, draft: annotation } = interaction.pointerOperation;
    resetPointerOperation();
    if (cancel || (annotation.kind === "rect" && (annotationBounds(annotation).width < 1 || annotationBounds(annotation).height < 1))) {
      drawPreviewAnnotations();
    } else {
      interaction.suppressPreviewClick = true;
      annotationEditor.hoveredId = null;
      updatePageAnnotations(pageId, annotations => [...annotations, annotation]);
      selectAnnotation(annotation);
    }
  }

  function clickPreview(event) {
    if (workspace.busy || !annotationEditor.tool || annotationEditor.tool === "highlight") return;
    if (interaction.suppressPreviewClick) {
      interaction.suppressPreviewClick = false;
      return;
    }
    const point = pointerToPdfPoint(event);
    if (!point) return;
    const target = event.altKey && annotationEditor.tool ? null : editTargetAt(point);
    if (target) {
      selectAnnotation(target.annotation);
    } else if (isTextAnnotation(annotationEditor.tool)) {
      const [x, y] = point;
      openTextEditor({
        id: annotationEditor.nextId++, nativeName: makeAnnotationName(annotationEditor.tool),
        kind: annotationEditor.tool, text: "", x, y,
        rotation: preview.bitmap.viewport.rotation, ...styleForNewAnnotation(annotationEditor.tool),
      }, false);
    } else {
      selectAnnotation(null);
    }
  }

  function doubleClickPreview(event) {
    if (workspace.busy || !annotationEditor.tool || ui["mark-dialog"].open || event.altKey) return;
    const point = pointerToPdfPoint(event);
    const target = point && editTargetAt(point);
    if (!target) return;
    event.preventDefault();
    selectAnnotation(target.annotation);
    if (!ensureAnnotationsUnlocked([target.annotation]) || target.annotation.kind === "external") return;
    if (isTextAnnotation(target.annotation.kind)) {
      openTextEditor(target.annotation, true);
    } else if (target.annotation.kind !== "highlight") {
      ui["mark-width"].focus();
    }
  }

  function pdfToPreviewScale() {
    return pdfViewportScale(preview.bitmap.viewport) * previewBitmapScale();
  }

  function visibleHandleAnnotationId() {
    if (interaction.pointerOperation?.kind === "group-edit") return null;
    if (interaction.pointerOperation?.kind === "edit") return interaction.pointerOperation.original.id;
    if (interaction.pointerOperation?.kind === "draw" || hasAnnotationGroupSelection()) return null;
    return (annotationEditor.selectionHover ? null : annotationEditor.hoveredId) ?? selectedAnnotation()?.id;
  }

  function annotationAt(point) {
    const page = activePreviewPage();
    return page && hitTestAnnotation(page.annotations, point, pdfToPreviewScale(),
      annotationEditor.tool === "select", renderTextAnnotationImage);
  }

  function editTargetAt(point) {
    const shown = findAnnotation(visibleHandleAnnotationId());
    const handle = shown && findAnnotationHandle(shown, point, pdfToPreviewScale());
    if (handle) return { annotation: shown, handle };
    const annotation = annotationAt(point);
    if (annotation) return { annotation, handle: null };
    if (shown?.kind === "rect" && shown.id === selectedAnnotation()?.id && pointInBounds(point, annotationBounds(shown))) {
      return { annotation: shown, handle: null };
    }
    return null;
  }

  function setPreviewHover(id, selectionHover = false) {
    if (annotationEditor.hoveredId === id && annotationEditor.selectionHover === selectionHover) return;
    annotationEditor.hoveredId = id;
    annotationEditor.selectionHover = selectionHover;
    annotationOverlay.title = findAnnotation(id)?.locked ? "ロック中 — 選択して「ロック」を外すと編集できます" : "";
    drawPreviewAnnotations();
  }

  function updatePreviewHover(event, modifiers = event) {
    if (workspace.busy || !annotationEditor.tool || interaction.pointerOperation || event.pointerType === "touch") return;
    const point = pointerToPdfPoint(event);
    const gesture = annotationSelectionGesture(modifiers);
    if (gesture?.endsWith("-range")) {
      setPreviewHover(null);
      annotationOverlay.style.cursor = "crosshair";
      return;
    }
    if (gesture === "toggle-annotation") {
      const candidate = point && !modifiers.altKey ? annotationAt(point) : null;
      setPreviewHover(candidate?.id ?? null, Boolean(candidate));
      annotationOverlay.style.cursor = candidate ? "pointer" : "default";
      return;
    }
    if (annotationEditor.selectionHover) setPreviewHover(null);
    if (hasAnnotationGroupSelection()) {
      const bounds = annotationGroupBounds(selectedAnnotations());
      const inside = point && bounds && pointInBounds(point, bounds);
      const locked = annotationSelectionLock(selectedAnnotations()).any;
      annotationOverlay.style.cursor = inside ? locked ? "not-allowed" : "move" : "";
      annotationOverlay.title = inside && locked ? "ロック中の注釈を含む選択 — ロックを外すと編集できます" : "";
      return;
    }
    const drawOnTop = modifiers.altKey && annotationEditor.tool;
    const target = point && !drawOnTop ? editTargetAt(point) : null;
    const previous = findAnnotation(annotationEditor.hoveredId);
    const insideHoverArea = !drawOnTop && point && previous
      && pointInBounds(point, annotationBounds(previous), 12 / pdfToPreviewScale());
    // ペンの線から離れた角のハンドルまで、枠の内側を通って移動できるようにする。
    setPreviewHover(target?.annotation.id ?? (insideHoverArea ? previous.id : null));
    annotationOverlay.style.cursor = target ? target.annotation.locked ? "not-allowed" : annotationDragCursor(target, preview.bitmap.viewport) : "";
  }

  function refreshPreviewHoverModifiers(event) {
    if (interaction.previewHoverPointer && annotationEditor.tool === "select" && ["Control", "Meta", "Shift", "Alt"].includes(event.key)) {
      updatePreviewHover(interaction.previewHoverPointer, event);
    }
  }

  function beginAnnotationDrag(event, point, { annotation, handle }) {
    if (!ensureAnnotationsUnlocked([annotation])) { interaction.suppressPreviewClick = true; return; }
    interaction.pointerOperation = {
      kind: "edit", pointerId: event.pointerId, pageId: pageView.previewPageId,
      original: annotation, draft: annotation, point, handle,
      textWidth: handle?.action === "wrap" ? renderTextAnnotationImage(annotation).width : null,
    };
    annotationOverlay.setPointerCapture(event.pointerId);
    drawPreviewAnnotations();
  }

  function beginAnnotationGroupDrag(event, point) {
    const originals = selectedAnnotations();
    if (!ensureAnnotationsUnlocked(originals)) { interaction.suppressPreviewClick = true; return; }
    interaction.pointerOperation = { kind: "group-edit", pointerId: event.pointerId, pageId: pageView.previewPageId,
      originals, drafts: originals, point };
    annotationOverlay.setPointerCapture(event.pointerId);
    drawPreviewAnnotations();
  }

  function moveAnnotationGroupDrag(event) {
    const drag = interaction.pointerOperation;
    if (drag?.kind !== "group-edit" || drag.pointerId !== event.pointerId) return;
    const point = pointerToPdfPoint(event, true);
    if (!point) return;
    const dx = point[0] - drag.point[0], dy = point[1] - drag.point[1];
    drag.drafts = Math.hypot(dx, dy) * pdfToPreviewScale() < 2 ? drag.originals
      : translateAnnotationGroup(drag.originals, dx, dy, preview.bitmap.viewport.viewBox);
    drawPreviewAnnotations();
  }

  function endAnnotationGroupDrag(event, cancel = false) {
    if (interaction.pointerOperation?.kind !== "group-edit" || interaction.pointerOperation.pointerId !== event.pointerId) return;
    if (!cancel) moveAnnotationGroupDrag(event);
    const { pageId, originals, drafts } = interaction.pointerOperation;
    resetPointerOperation();
    interaction.suppressPreviewClick = true;
    if (!cancel && drafts.some((annotation, index) => annotation !== originals[index])) {
      const byId = new Map(drafts.map(annotation => [annotation.id, annotation]));
      updatePageAnnotations(pageId, annotations => annotations.map(annotation => byId.get(annotation.id) ?? annotation));
    }
    drawPreviewAnnotations();
  }

  function moveAnnotationDrag(event) {
    const drag = interaction.pointerOperation;
    if (drag?.kind !== "edit" || drag.pointerId !== event.pointerId) return;
    const point = pointerToPdfPoint(event, true);
    if (!point) return;
    const dx = point[0] - drag.point[0];
    const dy = point[1] - drag.point[1];
    drag.draft = Math.hypot(dx, dy) * pdfToPreviewScale() < 2 ? drag.original : transformAnnotationDrag(drag, dx, dy, preview.bitmap.viewport.viewBox, event.shiftKey);
    drawPreviewAnnotations();
  }

  function endAnnotationDrag(event, cancel = false) {
    if (interaction.pointerOperation?.kind !== "edit" || interaction.pointerOperation.pointerId !== event.pointerId) return;
    if (!cancel) moveAnnotationDrag(event);
    const { pageId, original, draft } = interaction.pointerOperation;
    resetPointerOperation();
    if (cancel || draft === original) {
      if (cancel) {
        drawPreviewAnnotations();
      } else {
        interaction.suppressPreviewClick = true;
        annotationEditor.hoveredId = null;
        selectAnnotation(original);
      }
      return;
    }
    interaction.suppressPreviewClick = true;
    annotationEditor.hoveredId = null;
    const placed = isTextAnnotation(draft.kind) ? fitAnnotationToPage(draft, preview.bitmap.viewport.viewBox) : draft;
    replacePageAnnotation(pageId, placed);
    selectAnnotation(placed);
  }

  function bindAnnotationControls() {
    for (const button of previewModeButtons) {
      const mode = button.dataset.tool;
      button.addEventListener("click", () => setPreviewTool(mode === "navigate" ? null : mode));
    }
    ui["mark-locked"].addEventListener("change", event => { event.stopPropagation(); changeAnnotationLock(); });
    ui["mark-settings"].addEventListener("change", commitToolStyle);
    document.addEventListener("selectionchange", updateHighlightAction);
    ui["apply-highlight"].addEventListener("pointerdown", event => event.preventDefault());
    ui["apply-highlight"].addEventListener("click", applySelectedHighlight);
    previewTextLayer.addEventListener("pointerup", event => {
      if (event.pointerType === "mouse" || event.pointerType === "pen") requestAnimationFrame(applySelectedHighlight);
    });
    const overlay = annotationOverlay;
    document.addEventListener("keydown", refreshPreviewHoverModifiers);
    document.addEventListener("keyup", refreshPreviewHoverModifiers);
    overlay.addEventListener("pointerenter", event => {
      if (event.pointerType === "touch") return;
      interaction.previewHoverPointer = event;
      updatePreviewHover(event);
    });
    overlay.addEventListener("pointerdown", event => {
      interaction.suppressPreviewClick = false;
      if (event.pointerType !== "touch") interaction.previewHoverPointer = event;
      if (workspace.busy || !annotationEditor.tool || annotationEditor.tool === "highlight" || event.button !== 0 || interaction.pointerOperation) return;
      finishZoomForPointer();
      const gesture = annotationSelectionGesture(event);
      if (gesture?.endsWith("-range")) {
        beginRangeSelection(event, pointerToPdfPoint(event, true), gesture);
        overlay.style.cursor = "crosshair";
        return;
      }
      const point = pointerToPdfPoint(event);
      if (gesture === "toggle-annotation") {
        event.preventDefault();
        toggleAnnotationSelection(point && !event.altKey ? annotationAt(point) : null);
        updatePreviewHover(event);
        interaction.suppressPreviewClick = true;
        return;
      }
      const target = point && !(event.altKey && annotationEditor.tool) ? editTargetAt(point) : null;
      if (annotationEditor.tool === "select" && hasAnnotationGroupSelection()) {
        const group = selectedAnnotations();
        const inside = target ? group.some(annotation => annotation.id === target.annotation.id)
          : point && pointInBounds(point, annotationGroupBounds(group));
        if (inside) { beginAnnotationGroupDrag(event, point); return; }
      }
      if (target) {
        if (!selectedAnnotations().some(annotation => annotation.id === target.annotation.id)) selectAnnotation(target.annotation);
        beginAnnotationDrag(event, point, target);
      } else {
        setPreviewHover(null);
        overlay.style.cursor = "";
        beginStroke(event);
      }
    });
    overlay.addEventListener("pointermove", event => {
      if (event.pointerType !== "touch") interaction.previewHoverPointer = event;
      if (interaction.pointerOperation?.kind === "range-select") moveRangeSelection(event);
      else if (interaction.pointerOperation?.kind === "group-edit") moveAnnotationGroupDrag(event);
      else if (interaction.pointerOperation?.kind === "edit") moveAnnotationDrag(event);
      else if (interaction.pointerOperation?.kind === "draw") extendStroke(event);
      else updatePreviewHover(event);
    });
    overlay.addEventListener("pointerup", event => {
      if (interaction.pointerOperation?.kind === "range-select") {
        endRangeSelection(event);
        updatePreviewHover(event);
      }
      else if (interaction.pointerOperation?.kind === "group-edit") endAnnotationGroupDrag(event);
      else if (interaction.pointerOperation?.kind === "edit") endAnnotationDrag(event);
      else endStroke(event);
    });
    function cancelPreviewGesture(event) {
      endRangeSelection(event, true);
      endAnnotationGroupDrag(event, true);
      endAnnotationDrag(event, true);
      endStroke(event, true);
    }
    overlay.addEventListener("pointercancel", cancelPreviewGesture);
    overlay.addEventListener("lostpointercapture", cancelPreviewGesture);
    overlay.addEventListener("pointerleave", () => {
      interaction.previewHoverPointer = null;
      setPreviewHover(null);
      overlay.style.cursor = "";
    });
    overlay.addEventListener("click", clickPreview);
    overlay.addEventListener("dblclick", doubleClickPreview);
    ui["mark-dialog"].querySelector("form").addEventListener("submit", submitTextEditor);
    ui["mark-dialog"].addEventListener("cancel", () => { annotationEditor.textEdit = null; });
    ui["mark-edit"].addEventListener("click", () => {
      const mark = selectedAnnotation();
      if (mark) openTextEditor(mark, true);
    });
    ui["mark-select-all"].addEventListener("click", () => selectAllPageAnnotations());
    ui["mark-multiselect"].addEventListener("click", toggleMultiSelection);
    ui["mark-range-select"].addEventListener("click", toggleRangeSelection);
    for (const button of annotationAlignButtons) button.addEventListener("click", () => arrangeSelectedAnnotations(button.dataset.align));
    ui["mark-copy"].addEventListener("click", copySelectedAnnotations);
    ui["mark-paste"].addEventListener("click", () => pasteAnnotations());
    ui["mark-remove"].addEventListener("click", removeSelectedAnnotations);
  }

  return {
    endRangeSelection,
    endStroke,
    visibleHandleAnnotationId,
    setPreviewHover,
    endAnnotationGroupDrag,
    endAnnotationDrag,
    bindAnnotationControls,
  };
}

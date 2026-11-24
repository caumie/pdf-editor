import { drawAnnotationsOnCanvas } from "./annotations.mjs";

// 描画済みPDFと注釈をDOMへ配置する。編集対象の変更は呼び出し元へ委ねる。
export function mountPreviewPages(nodes, rendered, models, indexes, activeIndex, activatePage, drawMarks = drawAnnotationsOnCanvas) {
  const active = rendered.entries[activeIndex];
  positionPreviewPage(nodes.activePage, active, rendered);
  nodes.activePage.setAttribute("aria-label", (indexes[activeIndex] + 1) + "ページ目（編集中）");
  active.canvas.style.width = active.canvas.style.height = "100%";
  nodes.base.replaceChildren(active.canvas);
  const pageLayers = [{ element: nodes.activePage, layer: nodes.base, entry: active, pageId: models[activeIndex]?.id, addedRotation: models[activeIndex]?.addedRotation }];
  const shadows = [];
  const companions = [];
  for (const [index, entry] of rendered.entries.entries()) {
    if (!entry) continue;
    const shadow = document.createElement("div");
    shadow.className = "preview-page-shadow";
    positionPreviewPage(shadow, entry, rendered);
    shadows.push(shadow);
    if (index === activeIndex) continue;
    const model = models[index];
    const canvas = document.createElement("canvas");
    canvas.width = entry.canvas.width; canvas.height = entry.canvas.height;
    canvas.style.width = canvas.style.height = "100%";
    canvas.setAttribute("aria-hidden", "true");
    canvas.getContext("2d").drawImage(entry.canvas, 0, 0);
    drawMarks(canvas, entry.viewport, model.annotations);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "preview-page preview-companion";
    button.setAttribute("aria-label", (indexes[index] + 1) + "ページ目を編集");
    button.title = (indexes[index] + 1) + "ページ目をクリックして編集";
    positionPreviewPage(button, entry, rendered);
    button.append(canvas);
    button.addEventListener("click", event => activatePage(model, event));
    companions.push(button);
    pageLayers.push({ element: button, layer: button, entry, pageId: model.id, addedRotation: model.addedRotation, annotations: model.annotations });
  }
  nodes.shadows.replaceChildren(...shadows);
  nodes.companions.replaceChildren(...companions);
  nodes.surface.dataset.spread = String(indexes.length > 1);
  nodes.overlay.width = active.canvas.width; nodes.overlay.height = active.canvas.height;
  return pageLayers;
}

function positionPreviewPage(element, box, spread) {
  element.style.left = box.x / spread.width * 100 + "%";
  element.style.top = box.y / spread.height * 100 + "%";
  element.style.width = box.width / spread.width * 100 + "%";
  element.style.height = box.height / spread.height * 100 + "%";
}

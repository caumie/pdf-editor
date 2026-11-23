export function previewPageIndexes(count, index, { mode, cover, direction }) {
  if (index < 0 || index >= count) return [];
  if (mode !== "spread" || (cover && index === 0)) return [index];
  const offset = cover ? 1 : 0;
  const first = offset + Math.floor((index - offset) / 2) * 2;
  const pair = [first, first + 1 < count ? first + 1 : null];
  return direction === "right" ? pair.reverse() : pair;
}

export function adjacentPreviewIndex(count, index, settings, amount) {
  const indexes = previewPageIndexes(count, index, settings).filter(value => value !== null);
  if (!indexes.length) return -1;
  if (amount >= 0) return Math.max(...indexes) + 1;
  const previous = Math.min(...indexes) - 1;
  // 後ろから入った場合も、見開きの編集対象はページ順で最初のページに揃える。
  return Math.min(previous, ...previewPageIndexes(count, previous, settings).filter(value => value !== null));
}

// PDFの自然なサイズに共通倍率を掛ける。空きページの分も取り、最終見開きだけ拡大しない。
export function fitPreviewPages(sizes, maxWidth, maxHeight, zoom = 1, direction = "left") {
  const fallback = sizes.find(Boolean);
  if (!fallback) return null;
  const slots = sizes.map(size => size ?? fallback);
  const vertical = direction === "vertical";
  const along = vertical ? "height" : "width";
  const across = vertical ? "width" : "height";
  const availableAlong = vertical ? maxHeight : maxWidth;
  const availableAcross = vertical ? maxWidth : maxHeight;
  const gap = slots.length > 1 ? 16 / 3 : 0;
  const naturalAlong = slots.reduce((sum, size) => sum + size[along], 0);
  const naturalAcross = Math.max(...slots.map(size => size[across]));
  const availableForPages = Math.max(1, availableAlong - gap * (slots.length - 1));
  const scale = Math.min(availableForPages / naturalAlong, availableAcross / naturalAcross) * zoom;
  const acrossSize = naturalAcross * scale;
  let offset = 0;
  const boxes = slots.map(size => {
    const center = (acrossSize - size[across] * scale) / 2;
    const box = { x: vertical ? center : offset, y: vertical ? offset : center,
      width: size.width * scale, height: size.height * scale };
    offset += box[along] + gap * zoom;
    return box;
  });
  const alongSize = offset - gap * zoom;
  return { width: vertical ? acrossSize : alongSize, height: vertical ? alongSize : acrossSize, scale, boxes };
}

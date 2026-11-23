import { normalizeRotation } from "./page-coordinates.mjs";

export function rotateDocumentPages(pages, ids, angle) {
  return pages.map(page => ids.has(page.id)
    ? { ...page, addedRotation: normalizeRotation(page.addedRotation + angle) }
    : page
  );
}

export function removeDocumentPages(pages, ids) {
  return pages.filter(page => !ids.has(page.id));
}

export function canMoveDocumentPages(pages, ids, direction) {
  return pages.some((page, index) => canSwapDocumentPage(pages, ids, index, direction));
}

function canSwapDocumentPage(pages, ids, index, direction) {
  const neighbor = pages[index + direction];
  return Boolean(neighbor && ids.has(pages[index].id) && !ids.has(neighbor.id));
}

export function moveDocumentPages(pages, ids, direction) {
  const reordered = [...pages];
  let changed = false;
  // 前へは左から、後ろへは右から見て、隣の未選択ページと入れ替える。
  for (let i = direction < 0 ? 1 : pages.length - 2; i >= 0 && i < pages.length; i -= direction) {
    if (!canSwapDocumentPage(reordered, ids, i, direction)) continue;
    [reordered[i], reordered[i + direction]] = [reordered[i + direction], reordered[i]];
    changed = true;
  }
  return changed ? reordered : pages;
}

export function placeDocumentPages(pages, ids, targetId, after) {
  if (ids.has(targetId)) return pages;
  const reordered = removeDocumentPages(pages, ids);
  const index = reordered.findIndex(page => page.id === targetId);
  if (index < 0) return pages;
  reordered.splice(index + (after ? 1 : 0), 0, ...pages.filter(page => ids.has(page.id)));
  return reordered.some((page, index) => page !== pages[index]) ? reordered : pages;
}

export function changeDocumentAnnotations(pages, id, change) {
  const index = pages.findIndex(page => page.id === id);
  if (index < 0) return pages;
  const page = pages[index];
  const annotations = change(page.annotations);
  if (annotations === page.annotations) return pages;
  const edited = [...pages];
  edited[index] = { ...page, annotations };
  return edited;
}

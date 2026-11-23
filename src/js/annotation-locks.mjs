// 個別ロックは誤操作防止として統一する。非表示・レイヤーの指定とは分離する。
export const annotationLockMask = 64 | 128 | 512;

export function annotationIsLocked(flags) {
  return Boolean(flags & annotationLockMask);
}

export function annotationOutputFlags(annotation, original = 4) {
  const flags = (annotation.pdfFlags ?? original) & ~annotationLockMask;
  return annotation.locked ? flags | 128 | 512 : flags;
}

export function annotationSelectionLock(annotations) {
  const count = annotations.filter(annotation => annotation.locked).length;
  return { any: count > 0, all: annotations.length > 0 && count === annotations.length,
    mixed: count > 0 && count < annotations.length, count };
}

export function setAnnotationsLocked(annotations, ids, locked) {
  return annotations.map(annotation => ids.has(annotation.id) && Boolean(annotation.locked) !== locked
    ? { ...annotation, locked } : annotation);
}

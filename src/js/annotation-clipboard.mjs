import { translateAnnotation } from "./annotations.mjs";
import { annotationGroupBounds } from "./annotation-layout.mjs";
import { makeAnnotationName } from "./pdf-annotations.mjs";
import { pdfViewportScale } from "./page-coordinates.mjs";

// 全体に同じ移動量を使い、複数の書き込みの配置関係を保つ。
export function createAnnotationCopies(annotations, viewport, offset, nextId) {
  if (!annotations.length) return [];
  const { left, right, bottom, top } = annotationGroupBounds(annotations);
  const [pageLeft, pageBottom, pageRight, pageTop] = viewport.viewBox;
  const [originX, originY] = viewport.convertToPdfPoint(0, 0);
  const distance = offset * pdfViewportScale(viewport);
  const [targetX, targetY] = viewport.convertToPdfPoint(distance, distance);
  const dx = Math.max(pageLeft - left, Math.min(pageRight - right, targetX - originX));
  const dy = Math.max(pageBottom - bottom, Math.min(pageTop - top, targetY - originY));
  const timestamp = new Date().toISOString();
  return annotations.map(annotation => {
    const { sourceAnnotationRef, originalAppearance, ...copy } = structuredClone(annotation);
    if (originalAppearance) {
      delete copy.appearanceKey;
      delete copy.appearancePageIndex;
    }
    return { ...translateAnnotation(copy, dx, dy), id: nextId(),
      nativeName: makeAnnotationName(annotation.kind), createdAt: timestamp, modifiedAt: timestamp };
  });
}

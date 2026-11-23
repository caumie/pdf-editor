import { annotationIsLocked, annotationOutputFlags } from "./annotation-locks.mjs";
import { removePdfAnnotationsAndReplies } from "./pdf-annotation-links.mjs";
import { PdfResources } from "./libraries.mjs";
import { annotationSavedState, currentOriginalAppearance } from "./annotation-state.mjs";
import { setExternalAnnotationRaster, releaseExternalAnnotationRasters } from "./annotations.mjs";

// リンク、フォーム部品、親注釈に従うポップアップは個別の操作対象にしない。
const relatedAnnotationSubtypes = new Set(["Link", "Widget", "Popup"]);

export function createExternalAnnotationCodec(pdfLib) {
  const { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, PDFDocument, PDFObjectCopier, PDFString } = pdfLib;
  const name = PDFName.of;

  function values(dict, key) {
    const array = dict.lookupMaybe(name(key), PDFArray);
    if (!array) return null;
    const items = array.asArray().map(item => array.context.lookup(item));
    if (!items.every(item => item instanceof PDFNumber && Number.isFinite(item.asNumber()))) return null;
    return items.map(item => item.asNumber());
  }

  function appearance(dict) {
    const ap = dict.lookupMaybe(name("AP"), PDFDict);
    let normal = ap?.lookup(name("N"));
    if (normal instanceof PDFDict) {
      const state = dict.lookupMaybe(name("AS"), PDFName);
      normal = state && normal.lookup(state);
    }
    return normal instanceof PDFStream ? normal : null;
  }

  function read(page, ref) {
    if (!(ref instanceof PDFRef)) return null;
    try {
      const dict = page.doc.context.lookup(ref, PDFDict);
      const subtype = dict.lookupMaybe(name("Subtype"), PDFName)?.decodeText();
      if (!subtype || relatedAnnotationSubtypes.has(subtype) || !appearance(dict)) return null;
      const flags = dict.lookupMaybe(name("F"), PDFNumber)?.asNumber() ?? 0;
      if (dict.has(name("OC"))) return null;
      // 非表示の注釈だけを元PDFの表示に残し、個別ロックは選択可能な状態として復元する。
      if (flags & (1 | 2 | 32)) return null;
      const rect = values(dict, "Rect");
      if (rect?.length !== 4 || rect[2] <= rect[0] || rect[3] <= rect[1]) return null;
      const refId = ref.objectNumber + "R" + (ref.generationNumber || "");
      return {
        ref, refId,
        annotation: {
          kind: "external", locked: annotationIsLocked(flags), pdfFlags: flags, externalRefId: refId, subtype, rect, offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1,
        },
      };
    } catch {
      return null;
    }
  }

  async function appearancePdf(file, restored, password = "") {
    const entries = [...restored.values()].flat().filter(({ annotation }) => annotation.kind === "external" || annotation.originalAppearance);
    if (!entries.length) return null;
    const source = await PDFDocument.load(await file.arrayBuffer(), { password, updateMetadata: false });
    const output = await PDFDocument.create();
    const copier = PDFObjectCopier.for(source.context, output.context);
    for (const entry of entries) {
      const dict = source.context.lookup(entry.ref, PDFDict);
      const stream = appearance(dict);
      let bbox, matrix;
      try {
        bbox = values(stream.dict, "BBox");
        matrix = values(stream.dict, "Matrix") ?? [1, 0, 0, 1, 0, 0];
      } catch { continue; } // この注釈は元ページの描画に残す。
      if (bbox?.length !== 4 || matrix.length !== 6) continue;
      const [a, b, c, d, e, f] = matrix;
      const corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]]
        .map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
      const left = Math.min(...corners.map(point => point[0]));
      const bottom = Math.min(...corners.map(point => point[1]));
      const width = Math.max(...corners.map(point => point[0])) - left;
      const height = Math.max(...corners.map(point => point[1])) - bottom;
      if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) continue;
      const rect = entry.annotation.originalAppearance?.rect ?? entry.annotation.rect;
      const page = output.addPage([rect[2] - rect[0], rect[3] - rect[1]]);
      const sx = page.getWidth() / width;
      const sy = page.getHeight() / height;
      const copiedStream = output.context.register(copier.copy(stream));
      page.node.set(name("Resources"), output.context.obj({ XObject: { OriginalAppearance: copiedStream } }));
      const contents = "q " + [sx, 0, 0, sy, -left * sx, -bottom * sy].join(" ") + " cm /OriginalAppearance Do Q";
      page.node.set(name("Contents"), output.context.register(output.context.flateStream(contents)));
      entry.annotation.appearancePageIndex = output.getPageCount() - 1;
    }
    return output.getPageCount() ? output.save() : null;
  }

  function transformCoordinates(dict, key, sx, sy, tx, ty) {
    const coordinates = values(dict, key);
    if (!coordinates?.length || coordinates.length % 2) return;
    dict.set(name(key), dict.context.obj(coordinates.map((value, index) => index % 2 ? value * sy + ty : value * sx + tx)));
  }

  function transform(dict, annotation) {
    const sx = annotation.scaleX ?? 1;
    const sy = annotation.scaleY ?? 1;
    const tx = annotation.offsetX;
    const ty = annotation.offsetY;
    if (sx === 1 && sy === 1 && !tx && !ty) return;
    for (const key of ["Rect", "L", "Vertices", "QuadPoints", "CL"]) transformCoordinates(dict, key, sx, sy, tx, ty);
    const ink = dict.lookupMaybe(name("InkList"), PDFArray);
    if (ink) {
      const strokes = ink.asArray().map(item => ink.context.lookup(item, PDFArray));
      const transformed = strokes.map(stroke => stroke.asArray().map((value, index) => {
        const number = stroke.context.lookup(value, PDFNumber).asNumber();
        return index % 2 ? number * sy + ty : number * sx + tx;
      }));
      dict.set(name("InkList"), dict.context.obj(transformed));
    }
    const differences = values(dict, "RD");
    if (differences?.length === 4) {
      dict.set(name("RD"), dict.context.obj(differences.map((value, index) => value * (index % 2 ? sy : sx))));
    }
    const popup = dict.lookupMaybe(name("Popup"), PDFDict);
    if (popup) transformCoordinates(popup, "Rect", sx, sy, tx, ty);
    dict.set(name("M"), PDFString.fromDate(new Date()));
  }

  function applyChanges(page, tracked, annotations) {
    const refs = page.node.Annots();
    if (!refs) return;
    const byId = new Map(annotations.filter(annotation => annotation.kind === "external")
      .map(annotation => [annotation.externalRefId, annotation]));
    const removed = new Set();
    for (const { refId, position, annotation, savedState } of tracked) {
      const ref = refs.get(position);
      const current = byId.get(refId);
      if (!current) {
        removed.add(ref.toString());
        continue;
      }
      if (annotationSavedState(current) === (savedState ?? annotationSavedState(annotation))) continue;
      const dict = page.doc.context.lookup(ref, PDFDict);
      transform(dict, current);
      dict.set(name("F"), PDFNumber.of(annotationOutputFlags(current, dict.lookupMaybe(name("F"), PDFNumber)?.asNumber() ?? 4)));
      dict.set(name("P"), page.ref);
    }
    removePdfAnnotationsAndReplies(pdfLib, page, removed);
  }

  return { read, appearancePdf, applyChanges };
}

export async function openExternalAnnotationRenderer(pdfjs, bytes, sourceId) {
  if (!bytes) return null;
  const task = pdfjs.getDocument({
    data: bytes, BinaryDataFactory: PdfResources, useWorkerFetch: false, disableWorkerRendering: true,
  });
  let reader;
  try {
    reader = await task.promise;
  } catch (error) {
    await task.destroy().catch(console.warn);
    throw error;
  }
  const cached = new Map();
  return {
    async prepare(annotations, requestedScale = 3) {
      for (const annotation of annotations) {
        const original = currentOriginalAppearance(annotation);
        if ((!original && annotation.kind !== "external") || annotation.appearancePageIndex === undefined) continue;
        const key = annotation.appearanceKey;
        const rect = original?.rect ?? annotation.rect;
        const sx = annotation.scaleX ?? 1;
        const sy = annotation.scaleY ?? 1;
        const width = (rect[2] - rect[0]) / sx;
        const height = (rect[3] - rect[1]) / sy;
        const scale = Math.min(Math.max(3, requestedScale * Math.max(sx, sy)),
          8192 / Math.max(width, height), Math.sqrt(14_000_000 / (width * height)));
        const previous = cached.get(key);
        if (previous?.scale >= scale) {
          await previous.promise;
          continue;
        }
        // 要求を同じキーの前回処理につなぎ、高解像度の結果が後で低解像度に戻らないようにする。
        const promise = (async () => {
          if (previous) await previous.promise;
          const page = await reader.getPage(annotation.appearancePageIndex + 1);
          const viewport = page.getViewport({ scale, rotation: 0 });
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.ceil(viewport.width));
          canvas.height = Math.max(1, Math.ceil(viewport.height));
          try {
            await page.render({ canvas, viewport, background: "rgba(0,0,0,0)" }).promise;
            setExternalAnnotationRaster(key, { canvas, scale });
          } catch (error) {
            canvas.width = canvas.height = 0;
            throw error;
          }
        })();
        cached.set(key, { scale, promise });
        try {
          await promise;
        } catch (error) {
          if (cached.get(key)?.promise === promise) cached.delete(key);
          throw error;
        }
      }
    },
    async destroy() {
      await Promise.allSettled([...cached.values()].map(entry => entry.promise));
      releaseExternalAnnotationRasters(sourceId);
      await task.destroy();
    },
  };
}

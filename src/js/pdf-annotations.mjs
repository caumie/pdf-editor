import { annotationIsLocked, annotationOutputFlags } from "./annotation-locks.mjs";
import { annotationBounds, annotationFillOpacity, colorChannels, isTextAnnotation, opacityFromTransparency, renderTextAnnotationImage, textBoxPointToPdf, noteInkColor, lineArrowPoints } from "./annotations.mjs";
import { normalizeDrawingStyle } from "./drawing-styles.mjs";
import { normalizeRotation } from "./page-coordinates.mjs";
import { decodePdfText } from "./pdf-text.mjs";

const markupKey = "PDFPageEditorV1";
const markupSubtypes = { text: "FreeText", note: "FreeText", rect: "Square", line: "Line", pen: "Ink", highlight: "Highlight", stamp: "Stamp" };

const editorAnnotationName = /^pdf-page-editor-(text|note|rect|line|pen|highlight|stamp)-[0-9a-f-]{36}$/;

export function makeAnnotationName(kind) {
  // randomUUID は安全なコンテキストだけで利用できるため、通常のHTTP配信にも対応する。
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  const uuid = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  return "pdf-page-editor-" + kind + "-" + uuid;
}

export function createPdfAnnotationCodec(pdfLib) {
  const { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString } = pdfLib;
  const name = PDFName.of;
  const text = PDFHexString.fromText;
  const token = PDFString.of;
  const fontsByDocument = new WeakMap();
  const stampAssetsByDocument = new WeakMap();
  const { rgb, pushGraphicsState, popGraphicsState, rectangle, fill, stroke, setStrokingColor, setFillingColor,
    setLineWidth, setLineCap, setLineJoin, moveTo, lineTo, closePath, setGraphicsState, concatTransformationMatrix, drawObject } = pdfLib;

  async function stampAsset(output, bytes) {
    let assets = stampAssetsByDocument.get(output);
    if (!assets) stampAssetsByDocument.set(output, assets = new WeakMap());
    let asset = assets.get(bytes);
    if (!asset) {
      const image = await output.embedPng(bytes);
      asset = { appearance: image.ref, source: output.context.register(output.context.stream(bytes)) };
      assets.set(bytes, asset);
    }
    return asset;
  }

  async function write(output, page, annotation, existingRef) {
    const bounds = annotationBounds(annotation);
    const isText = isTextAnnotation(annotation.kind);
    const highlight = annotation.kind === "highlight";
    const stamp = annotation.kind === "stamp";
    const pad = isText || highlight || stamp ? 0 : annotation.width / 2;
    const left = bounds.left - pad;
    const bottom = bounds.bottom - pad;
    const width = bounds.width + 2 * pad;
    const height = bounds.height + 2 * pad;
    const rect = [left, bottom, left + width, bottom + height];
    const context = output.context;
    const resources = { ExtGState: {}, XObject: {}, Font: {} };
    const ops = [pushGraphicsState()];

    function paint(channel, opacity, color, path, lineWidth) {
      if (opacity === 0) return;
      ops.push(pushGraphicsState());
      if (opacity < 1) {
        const key = channel === "fill" ? "FillAlpha" : "StrokeAlpha";
        resources.ExtGState[key] = context.obj({ Type: "ExtGState", [channel === "fill" ? "ca" : "CA"]: opacity });
        ops.push(setGraphicsState(key));
      }
      if (channel === "fill") {
        ops.push(setFillingColor(color), ...path, fill());
      } else {
        ops.push(setStrokingColor(color), setLineWidth(lineWidth), ...path, stroke());
      }
      ops.push(popGraphicsState());
    }

    const subtype = markupSubtypes[annotation.kind];
    const border = isText ? (annotation.kind === "text" && annotation.boxBorder ? annotation.boxBorderWidth : 0) : annotation.width;
    const native = {
      Type: "Annot", Subtype: subtype, Rect: rect, P: page.ref, F: annotationOutputFlags(annotation),
      NM: text(annotation.nativeName),
    };
    if (!highlight && !stamp) native.BS = context.obj({ Type: "Border", W: border, S: "S" });
    const { id, nativeName, sourceAnnotationRef, originalAppearance, appearancePageIndex, appearanceKey, text: contents, points, quads, x, y, createdAt, modifiedAt, image: stampImage, ...privateData } = annotation;

    if (stamp) {
      const asset = await stampAsset(output, stampImage);
      resources.XObject.StampImage = asset.appearance;
      native.Name = name("Approved");
      native.PPEStampImage = asset.source;
      const matrix = {
        0: [width, 0, 0, height, 0, 0],
        90: [0, height, -width, 0, width, 0],
        180: [-width, 0, 0, -height, width, height],
        270: [0, -height, width, 0, 0, height],
      }[annotation.rotation];
      ops.push(concatTransformationMatrix(...matrix), drawObject("StampImage"));
    } else if (highlight) {
      const opacity = opacityFromTransparency(annotation.fillTransparency);
      native.QuadPoints = quads.flat(2);
      native.C = colorChannels(annotation.color);
      native.CA = opacity;
      resources.ExtGState.Highlight = context.obj({ Type: "ExtGState", BM: "Multiply", ca: opacity });
      ops.push(setGraphicsState("Highlight"), setFillingColor(rgb(...native.C)));
      for (const [tl, tr, bl, br] of quads) {
        ops.push(moveTo(tl[0] - left, tl[1] - bottom));
        for (const [px, py] of [tr, br, bl]) ops.push(lineTo(px - left, py - bottom));
        ops.push(closePath());
      }
      ops.push(fill());
    } else if (isText) {
      const raster = renderTextAnnotationImage(annotation);
      const image = await output.embedPng(raster.canvas.toDataURL("image/png"));
      const [imageX, imageY] = textBoxPointToPdf(annotation, 0, raster.height);
      const angle = annotation.rotation * Math.PI / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const note = annotation.kind === "note";
      native.Contents = text(contents);
      if (createdAt) native.CreationDate = PDFString.fromDate(new Date(createdAt));
      if (modifiedAt) native.M = PDFString.fromDate(new Date(modifiedAt));
      native.IT = name("FreeText");
      native.Q = 0;
      native.Rotate = normalizeRotation(annotation.rotation);
      privateData.boxWidth = raster.width;
      const ink = note ? noteInkColor(annotation.color, annotationFillOpacity(annotation)) : annotation.color;
      const fontType = annotation.bold ? pdfLib.StandardFonts.HelveticaBold : pdfLib.StandardFonts.Helvetica;
      let fonts = fontsByDocument.get(output);
      if (!fonts) fontsByDocument.set(output, fonts = new Map());
      if (!fonts.has(fontType)) fonts.set(fontType, output.embedStandardFont(fontType));
      const font = fonts.get(fontType);
      const fontName = page.node.newFontDictionary("PPEFont", font.ref).decodeText();
      resources.Font[fontName] = font.ref;
      native.DA = token(colorChannels(ink).join(" ") + " rg /" + fontName + " " + annotation.size + " Tf");
      native.DS = text("font: " + (annotation.bold ? "bold " : "") + annotation.size + "pt sans-serif; color: " + ink);
      const fillOpacity = annotationFillOpacity(annotation);
      if (note || (annotation.boxFill && fillOpacity > 0)) native.C = colorChannels(note ? annotation.color : annotation.boxFillColor);
      if (border) native.RD = Array(4).fill(border / 2);

      if (!note) {
        if (annotation.boxFill) paint("fill", fillOpacity, rgb(...colorChannels(annotation.boxFillColor)), [rectangle(0, 0, width, height)]);
        if (border && width > border && height > border) {
          paint("stroke", opacityFromTransparency(annotation.strokeTransparency), rgb(...colorChannels(annotation.boxBorderColor)),
            [rectangle(border / 2, border / 2, width - border, height - border)], border);
        }
      }
      resources.XObject.TextImage = image.ref;
      ops.push(concatTransformationMatrix(
        raster.width * cos, raster.width * sin, -raster.height * sin, raster.height * cos,
        imageX - left, imageY - bottom
      ), drawObject("TextImage"));
    } else {
      const color = rgb(...colorChannels(annotation.color));
      const opacity = opacityFromTransparency(annotation.strokeTransparency);
      native.C = colorChannels(annotation.color);
      native.CA = opacity;
      if (subtype === "Square") {
        const box = [rectangle(pad, pad, bounds.width, bounds.height)];
        const fillOpacity = annotationFillOpacity(annotation);
        if (fillOpacity > 0) native.IC = colorChannels(annotation.fillColor);
        native.RD = Array(4).fill(pad);
        paint("fill", fillOpacity, rgb(...colorChannels(annotation.fillColor)), box);
        paint("stroke", opacity, color, box, border);
      } else {
        const geometry = points.length === 1 ? [points[0], points[0]] : points;
        if (subtype === "Line") {
          native.L = geometry.flat();
          native.LE = [name("None"), name(annotation.arrowEnd ? "ClosedArrow" : "None")];
          if (annotation.arrowEnd) native.IC = native.C;
        } else {
          native.InkList = [geometry.flat()];
        }
        const arrow = lineArrowPoints(annotation);
        const shaft = arrow.length ? [geometry[0],
          [(arrow[1][0] + arrow[2][0]) / 2, (arrow[1][1] + arrow[2][1]) / 2]] : geometry;
        const [[startX, startY], ...rest] = shaft;
        const path = [
          setLineCap(pdfLib.LineCapStyle.Round), setLineJoin(pdfLib.LineJoinStyle.Round),
          moveTo(startX - left, startY - bottom), ...rest.map(([px, py]) => lineTo(px - left, py - bottom)),
        ];
        paint("stroke", opacity, color, path, border);
        if (arrow.length) {
          paint("fill", opacity, color, [moveTo(arrow[0][0] - left, arrow[0][1] - bottom),
            ...arrow.slice(1).map(([px, py]) => lineTo(px - left, py - bottom)), closePath()]);
        }
      }
    }

    ops.push(popGraphicsState());
    const stream = context.formXObject(ops, {
      BBox: [0, 0, width, height],
      Resources: resources,
      ...(highlight ? {} : { Group: context.obj({ Type: "Group", S: "Transparency", I: true, CS: "DeviceRGB" }) }),
    });
    native.AP = context.obj({ N: context.register(stream) });
    native[markupKey] = text(JSON.stringify(privateData));
    if (existingRef) {
      const original = context.lookup(existingRef, PDFDict);
      // 標準の関連参照とコメント属性は残し、編集した注釈の図形・表示データだけを置き換える。
      for (const key of ["T", "Subj", "Contents", "CreationDate", "M", "Popup", "IRT", "RT"]) {
        const value = original.get(name(key));
        if (value && native[key] === undefined) native[key] = value;
      }
      context.assign(existingRef, context.obj(native));
    } else {
      page.node.addAnnot(context.register(context.obj(native)));
    }
  }

  function dictValue(dict, key, ...types) {
    return dict?.lookupMaybe(name(key), ...types);
  }

  function decodeString(dict, key) {
    return decodePdfText(pdfLib, dictValue(dict, key, PDFHexString, PDFString));
  }

  function decodeAnnotationDate(dict, key) {
    try {
      return dictValue(dict, key, PDFHexString, PDFString)?.decodeDate().toISOString();
    } catch {
      return undefined;
    }
  }

  function numbers(array) {
    if (!(array instanceof PDFArray) || array.size() > 12000) return [];
    const values = array.asArray().map(value => array.context.lookup(value));
    return values.every(value => value instanceof PDFNumber && Number.isFinite(value.asNumber()))
      ? values.map(value => value.asNumber()) : [];
  }

  function annotationRefs(page) {
    const refs = page.doc.context.lookup(page.node.get(name("Annots")));
    return refs instanceof PDFArray ? refs : undefined;
  }

  function read(page, ref) {
    if (!(ref instanceof PDFRef)) return null;
    try {
      const dict = page.doc.context.lookupMaybe(ref, PDFDict);
      const flags = dictValue(dict, "F", PDFNumber)?.asNumber() ?? 0;
      if (flags & (1 | 2 | 32)) return null;
      // レイヤーに属する注釈は元PDFの表示に任せ、非表示の注釈を操作用描画で出さない。
      if (dict.has(name("OC"))) return null;
      const nativeName = decodeString(dict, "NM");
      const namedKind = editorAnnotationName.exec(nativeName)?.[1];
      const stored = readAnnotationOptions(dict);
      const subtype = dictValue(dict, "Subtype", PDFName)?.decodeText();
      const standardKind = { FreeText: "text", Square: "rect", Line: "line", Ink: "pen", Highlight: "highlight" }[subtype];
      const kind = namedKind ?? stored.kind ?? standardKind;
      if (!Object.hasOwn(markupSubtypes, kind) || subtype !== markupSubtypes[kind]) return null;
      const border = dictValue(dict, "BS", PDFDict);
      const borderStyle = dictValue(border, "S", PDFName)?.decodeText();
      const oldBorder = dictValue(dict, "Border", PDFArray);
      const oldDash = oldBorder?.size() > 3 ? oldBorder.lookupMaybe(3, PDFArray) : undefined;
      // 未対応の破線・吹き出し線などは、外観を保持する移動・変形・削除へ回す。
      if ((borderStyle && borderStyle !== "S") || oldDash?.size()) return null;
      if (dict.has(name("BE")) || dict.has(name("CL"))) return null;
      const style = normalizeDrawingStyle(kind, stored);
      const foreign = !namedKind && !stored.kind;
      if (foreign) {
        style.color = "#000000";
        if (kind === "text") {
          style.boxBorderColor = "#000000";
          style.boxBorder = (readBorderWidth(dict) ?? 1) > 0;
          style.boxBorderWidth = Math.max(.5, Math.min(24, readBorderWidth(dict) ?? 1));
        } else if (kind !== "highlight") {
          style.width = Math.max(1, Math.min(24, readBorderWidth(dict) ?? 1));
        }
      }
      if (kind === "line") {
        const endings = dictValue(dict, "LE", PDFArray);
        if (endings) {
          const start = endings.lookup(0, PDFName).decodeText();
          const end = endings.lookup(1, PDFName).decodeText();
          if (start !== "None" || !["None", "ClosedArrow"].includes(end)) return null;
          style.arrowEnd = end === "ClosedArrow";
        } else {
          // PDFに終点指定がなければ、新規作図の初期設定とは切り離して復元する。
          style.arrowEnd = stored.arrowEnd === true;
        }
      }
      const rect = numbers(dictValue(dict, "Rect", PDFArray));
      if (rect.length !== 4) return null;
      const [x1, y1, x2, y2] = rect;
      const left = Math.min(x1, x2), right = Math.max(x1, x2), bottom = Math.min(y1, y2), top = Math.max(y1, y2);
      if (right <= left || top <= bottom) return null;

      let annotation;
      if (kind === "stamp") {
        const stream = dictValue(dict, "PPEStampImage", PDFRawStream);
        const image = stream?.getContents();
        if (!image?.length || stream.dict.has(name("Filter"))) return null;
        const rotation = normalizeRotation(stored.rotation ?? 0);
        if (![0, 90, 180, 270].includes(rotation)) return null;
        annotation = { kind, image, rotation, points: [[left, bottom], [right, top]] };
      } else if (kind === "highlight") {
        const values = numbers(dictValue(dict, "QuadPoints", PDFArray));
        if (!values.length || values.length % 8 !== 0) return null;
        const quads = [];
        for (let i = 0; i < values.length; i += 8) {
          const quad = [];
          for (let j = 0; j < 8; j += 2) quad.push(values.slice(i + j, i + j + 2));
          quads.push(quad);
        }
        const color = readColor(dict, "C") ?? style.color;
        const fillTransparency = readTransparency(dict) ?? style.fillTransparency;
        annotation = { kind, color, fillTransparency, quads };
      } else if (isTextAnnotation(kind)) {
        const contents = decodeString(dict, "Contents");
        if (contents === undefined || contents.length > 100_000) return null;
        const rotation = normalizeRotation(dictValue(dict, "Rotate", PDFNumber)?.asNumber() ?? stored.rotation ?? 0);
        const ink = readTextAppearance(dict);
        if (ink.size > 0) style.size = Math.max(8, Math.min(48, ink.size));
        if (ink.bold !== undefined) style.bold = ink.bold;
        const borderWidth = readBorderWidth(dict);
        const interior = readColor(dict, "C");
        if (kind === "text") {
          if (ink.color) style.color = ink.color;
          if (borderWidth !== undefined) {
            style.boxBorder = borderWidth > 0;
            if (style.boxBorder) style.boxBorderWidth = Math.max(.5, Math.min(24, borderWidth));
          }
          if (interior) {
            style.boxFill = true;
            style.boxFillColor = interior;
          } else if (!style.useFillTransparency || style.fillTransparency !== 100) {
            style.boxFill = false;
          }
        } else if (interior) style.color = interior;
        const anchor = { 0: [left, top], 90: [left, bottom], 180: [right, bottom], 270: [right, top] }[rotation];
        if (!anchor) return null;
        const currentWidth = rotation % 180 ? top - bottom : right - left;
        const wrap = Number.isFinite(stored.boxWidth) && Math.abs(currentWidth - stored.boxWidth) <= .05
          ? stored.wrapWidth : currentWidth;
        const wrapWidth = typeof wrap === "number" && Number.isFinite(wrap) && wrap > 0 ? wrap : undefined;
        annotation = {
          kind, ...style, text: contents.replace(/\r\n?/g, "\n"), x: anchor[0], y: anchor[1], rotation, wrapWidth,
          createdAt: decodeAnnotationDate(dict, "CreationDate"),
          modifiedAt: decodeAnnotationDate(dict, "M"),
        };
      } else {
        const strokeColor = readColor(dict, "C");
        if (strokeColor) style.color = strokeColor;
        const borderWidth = readBorderWidth(dict);
        if (borderWidth > 0 && borderWidth <= 24) style.width = borderWidth;
        style.strokeTransparency = readTransparency(dict) ?? style.strokeTransparency;
        let points;
        if (kind === "rect") {
          const pad = style.width / 2;
          if (right - left <= style.width || top - bottom <= style.width) return null;
          points = [[left + pad, bottom + pad], [right - pad, top - pad]];
          const interior = readColor(dict, "IC");
          if (interior) {
            style.fillColor = interior;
            if (!Number.isFinite(stored.fillTransparency)) style.fillTransparency = 70;
            style.useFillTransparency = stored.useFillTransparency === true && style.fillTransparency !== 100;
          } else {
            style.useFillTransparency = true;
            style.fillTransparency = 100;
          }
        } else {
          const inkList = kind === "pen" && dictValue(dict, "InkList", PDFArray);
          if (kind === "pen" && inkList?.size() !== 1) return null;
          const coordinates = numbers(kind === "line" ? dictValue(dict, "L", PDFArray) : inkList.lookup(0, PDFArray));
          if (coordinates.length < 4 || coordinates.length % 2 !== 0 || (kind === "line" && coordinates.length !== 4)) return null;
          points = [];
          for (let i = 0; i < coordinates.length; i += 2) points.push(coordinates.slice(i, i + 2));
          if (points.length === 2 && points[0].every((value, index) => value === points[1][index])) points.pop();
        }
        annotation = { kind, ...style, points };
      }
      const refId = ref.objectNumber + "R" + (ref.generationNumber || "");
      return { refId, ref, foreignAppearance: !namedKind && !stored.kind, annotation: { ...annotation, sourceAnnotationRef: refId, locked: annotationIsLocked(flags), pdfFlags: flags, nativeName: nativeName || makeAnnotationName(kind) } };
    } catch {
      return null;
    }
  }

  function readAnnotationOptions(dict) {
    try {
      const encoded = decodeString(dict, markupKey);
      if (!encoded || encoded.length > 4096) return {};
      const stored = JSON.parse(encoded);
      return stored && typeof stored === "object" ? stored : {};
    } catch {
      return {};
    }
  }

  function readBorderWidth(dict) {
    const border = dictValue(dict, "BS", PDFDict);
    return dictValue(border, "W", PDFNumber)?.asNumber()
      ?? numbers(dictValue(dict, "Border", PDFArray))[2];
  }

  function readTransparency(dict) {
    const opacity = dictValue(dict, "CA", PDFNumber)?.asNumber();
    if (opacity >= 0 && opacity <= 1) return Number((100 * (1 - opacity)).toFixed(6));
  }

  function readTextAppearance(dict) {
    const commands = (decodeString(dict, "DA") ?? "").trim().split(/\s+/);
    const appearance = {};
    for (const [index, operator] of commands.entries()) {
      if (operator === "Tf" && index > 0) appearance.size = Number(commands[index - 1]);
      if (operator === "rg" && index >= 3) appearance.color = rgbHex(commands.slice(index - 3, index).map(Number));
      if (operator === "g" && index > 0) appearance.color = rgbHex(Array(3).fill(Number(commands[index - 1])));
      if (operator === "k" && index >= 4) appearance.color = colorHex(commands.slice(index - 4, index).map(Number));
    }
    const css = decodeString(dict, "DS") ?? "";
    if (/font(?:-weight)?\s*:[^;]*\bbold\b/i.test(css)) appearance.bold = true;
    return appearance;
  }

  function colorHex(values) {
    if (values.length === 1) return rgbHex(Array(3).fill(values[0]));
    if (values.length === 4 && values.every(value => value >= 0 && value <= 1)) {
      const [c, m, y, k] = values;
      return rgbHex([c, m, y].map(value => 1 - Math.min(1, value + k)));
    }
    return rgbHex(values);
  }

  function rgbHex(values) {
    if (values.length !== 3 || values.some(value => !(value >= 0 && value <= 1))) return undefined;
    return "#" + values.map(value => Math.round(value * 255).toString(16).padStart(2, "0")).join("");
  }

  function readColor(dict, key) {
    return colorHex(numbers(dictValue(dict, key, PDFArray)));
  }

  return { write, read, annotationRefs };
}

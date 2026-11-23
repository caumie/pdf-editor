import { editorSettingKey } from "./settings-storage.mjs";

const styleStorageKey = editorSettingKey("styles.v3");
const previousStyleStorageKey = editorSettingKey("styles.v2");
const legacyStyleStorageKey = editorSettingKey("styles.v1");
const legacyStyleDefaults = {
  pen: { color: "#b83248", width: 3 },
  line: { color: "#b83248", width: 3 },
  rect: { color: "#2355c4", width: 3, fillColor: "#ffe18a" },
  text: { size: 16, boxBorderColor: "#d02535" },
  note: { color: "#ffdf76", size: 16 },
};
const drawingDefaults = {
  pen: { color: "#ff0000", width: 2, strokeTransparency: 0 },
  line: { color: "#ff0000", width: 2, strokeTransparency: 0, arrowEnd: true },
  rect: { color: "#ff0000", width: 2, strokeTransparency: 0,
    fillColor: "#ffffff", useFillTransparency: true, fillTransparency: 100 },
  text: {
    color: "#25304a", size: 12, bold: false,
    boxBorder: true, boxBorderColor: "#ff0000", boxBorderWidth: 2, strokeTransparency: 0,
    boxFill: true, boxFillColor: "#ffffff", useFillTransparency: false, fillTransparency: 70,
  },
  highlight: { color: "#ffe34f", fillTransparency: 45 },
  note: { color: "#fff3ad", size: 12, bold: false, useFillTransparency: false, fillTransparency: 70 },
};
export const drawingStyleRanges = {
  width: [1, 24],
  size: [8, 48],
  strokeTransparency: [0, 100],
  fillTransparency: [0, 100],
  boxBorderWidth: [0.5, 24],
};
// プロパティ名は保存形式に合わせ、同じ役割の入力欄をツール間で共有する。
const strokeFields = { color: "mark-color", width: "mark-width", strokeTransparency: "stroke-transparency" };
const fillTransparencyFields = { useFillTransparency: "fill-transparency-enabled", fillTransparency: "fill-transparency" };
const textFields = { size: "mark-size", bold: "mark-bold" };
export const toolStyleFields = {
  pen: strokeFields,
  line: { ...strokeFields, arrowEnd: "line-arrow-enabled" },
  highlight: { color: "highlight-color", fillTransparency: "highlight-transparency" },
  rect: { ...strokeFields, fillColor: "mark-fill", ...fillTransparencyFields },
  text: {
    boxBorder: "text-border-enabled", boxBorderColor: "mark-color", boxBorderWidth: "mark-width",
    strokeTransparency: "stroke-transparency", boxFill: "text-fill-enabled", boxFillColor: "mark-fill", ...fillTransparencyFields,
    color: "text-color", ...textFields,
  },
  note: { color: "mark-fill", ...fillTransparencyFields, ...textFields },
};
export const styleInputProperties = { color: "value", number: "valueAsNumber", checkbox: "checked" };

export function loadDrawingStyles() {
  let saved;
  let legacy = false;
  try {
    saved = JSON.parse(window.localStorage.getItem(styleStorageKey));
    if (!saved) {
      saved = JSON.parse(window.localStorage.getItem(previousStyleStorageKey));
      if (saved?.note?.color === "#ffffff") delete saved.note.color;
    }
    if (!saved) {
      legacy = true;
      saved = JSON.parse(window.localStorage.getItem(legacyStyleStorageKey));
    }
  } catch {
    // 保存領域が使えない場合も、標準設定で開けるようにする。
  }
  return Object.fromEntries(Object.keys(drawingDefaults).map(kind =>
    [kind, normalizeDrawingStyle(kind, saved?.[kind], legacy)]));
}

export function normalizeDrawingStyle(kind, style, legacy = false) {
  const result = { ...drawingDefaults[kind] };
  for (const [key, fallback] of Object.entries(result)) {
    const value = style?.[key];
    if (typeof value !== typeof fallback) continue;
    // 以前のプリセット値を更新し、カスタム値は引き継ぐ。
    if (legacy && value === legacyStyleDefaults[kind]?.[key]) continue;
    if (typeof value === "boolean") {
      result[key] = value;
    } else if (Number.isFinite(value)) {
      const [minimum, maximum] = drawingStyleRanges[key];
      result[key] = Math.max(minimum, Math.min(maximum, value));
    } else if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) {
      result[key] = value.toLowerCase();
    }
  }
  return result;
}

export function saveDrawingStyles(styles) {
  window.localStorage.setItem(styleStorageKey, JSON.stringify(styles));
}

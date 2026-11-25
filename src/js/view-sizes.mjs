import { editorSettingKey } from "./settings-storage.mjs";

const viewSizesStorageKey = editorSettingKey("view-sizes");

export const thumbnailSizes = { small: [104, 94], medium: [146, 145], large: [218, 218] };
export const previewZoomLimits = { min: 0.4, max: 100 };

export function clampPreviewZoom(zoom) {
  return Math.min(previewZoomLimits.max, Math.max(previewZoomLimits.min, zoom));
}

export function loadViewPreferences() {
  let saved;
  try { saved = JSON.parse(window.localStorage.getItem(viewSizesStorageKey)); }
  catch { /* 保存値を取得できない場合は既定値を使う。 */ }
  const size = saved?.thumbnailSize;
  const preferences = {
    thumbnailSize: typeof size === "string" && Object.hasOwn(thumbnailSizes, size) ? size : "medium",
    toolsVisible: saved?.toolsVisible === true,
  };
  // プレビュー倍率は起動ごとに100%。旧版の保存値だけを消し、サムネイルなどの設定は残す。
  if (Object.hasOwn(saved ?? {}, "previewZoom")) {
    saveViewPreferences(preferences.thumbnailSize, preferences.toolsVisible);
  }
  return preferences;
}

export function saveViewPreferences(thumbnailSize, toolsVisible) {
  try { window.localStorage.setItem(viewSizesStorageKey, JSON.stringify({ thumbnailSize, toolsVisible })); }
  catch { /* 保存できない場合も、表示中の設定はメモリに残る。 */ }
}

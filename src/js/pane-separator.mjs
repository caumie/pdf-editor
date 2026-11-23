import { editorSettingKey } from "./settings-storage.mjs";

const paneWidthStorageKey = editorSettingKey("pane-width");
const defaultPaneWidth = 50;
const minPageListWidth = 258;
const maxPaneWidth = 72;

export function bindPaneSeparator(separator, list, preview, workspace) {
  let preferredWidth = defaultPaneWidth;
  let width = defaultPaneWidth;

  function availablePaneWidth(left = list.getBoundingClientRect().left) {
    if (!separator.offsetWidth) return 0;
    return preview.getBoundingClientRect().right - left - separator.offsetWidth;
  }

  function renderPaneWidth(available) {
    if (available <= 0) return;
    const minPaneWidth = Math.min(defaultPaneWidth, 100 * minPageListWidth / available);
    width = Math.max(minPaneWidth, preferredWidth);
    workspace.style.setProperty("--list-width", "calc((100% - var(--separator-width)) * " + width / 100 + ")");
    separator.setAttribute("aria-valuemin", String(Math.round(minPaneWidth)));
    separator.setAttribute("aria-valuenow", String(Math.round(width)));
  }

  function setPaneWidth(percent, available = availablePaneWidth()) {
    if (available <= 0) return;
    preferredWidth = Math.min(maxPaneWidth, Math.max(0, percent));
    renderPaneWidth(available);
    preferredWidth = width;
  }

  function savePaneWidth() {
    try { window.localStorage.setItem(paneWidthStorageKey, String(preferredWidth)); }
    catch { /* 保存できない環境でも仕切りは操作できる。 */ }
  }

  try {
    const stored = window.localStorage.getItem(paneWidthStorageKey);
    if (stored !== null && stored.trim() && Number.isFinite(Number(stored))) {
      preferredWidth = Math.min(maxPaneWidth, Math.max(0, Number(stored)));
    }
  } catch { /* 保存値を取得できなければ初期位置を使う。 */ }
  renderPaneWidth(availablePaneWidth());
  new ResizeObserver(() => renderPaneWidth(availablePaneWidth())).observe(workspace);

  separator.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    separator.setPointerCapture(event.pointerId);
    separator.focus();
  });
  separator.addEventListener("pointermove", event => {
    if (!separator.hasPointerCapture(event.pointerId)) return;
    const left = list.getBoundingClientRect().left;
    const available = availablePaneWidth(left);
    if (available > 0) setPaneWidth((event.clientX - left - separator.offsetWidth / 2) * 100 / available, available);
  });
  separator.addEventListener("lostpointercapture", savePaneWidth);
  separator.addEventListener("dblclick", () => {
    setPaneWidth(defaultPaneWidth);
    savePaneWidth();
  });
  separator.addEventListener("keydown", event => {
    const next = { ArrowLeft: width - 3, ArrowRight: width + 3, Home: 0, End: maxPaneWidth }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    setPaneWidth(next);
    savePaneWidth();
  });
}

import { defaultExportName, exportTargetPages, sameExportPlan } from "./export-job.mjs";

// ダウンロード欄の表示と、前回の書き出し設定・ファイルを保持する。
// ページ・選択・元PDFは、必要なときに呼び出し元から読み取る。
export function createDownloadPanel(ui, properties, context, onSubmit) {
  const layouts = { pdf: "combined", jpg: "zip" };
  const form = ui["export-form"];
  let latestDownload = null;

  function options() {
    const extension = ui["export-format"].value;
    return {
      extension, layout: layouts[extension],
      selectionOnly: ui["export-scope"].value === "selected",
      customName: ui["output-name"].value,
      jpegDpi: Number(ui["jpeg-dpi"].value),
      pdfSettings: properties.settings(),
    };
  }

  function update() {
    const { pages, selectedIds, sources, available } = context();
    const disabled = !available || !pages.length;
    const { extension, layout, selectionOnly } = options();
    const jpeg = extension === "jpg";
    const layoutInput = ui["export-layout"];
    layoutInput.options[0].disabled = layoutInput.options[0].hidden = jpeg;
    layoutInput.value = layout;
    ui["export-menu-toggle"].disabled = disabled;
    for (const id of ["output-name", "export-format", "export-scope", "export-layout"]) ui[id].disabled = disabled;
    ui["jpeg-dpi"].disabled = disabled || !jpeg;
    ui["jpeg-dpi"].hidden = ui["jpeg-dpi-label"].hidden = !jpeg;
    const targets = exportTargetPages(pages, selectedIds, selectionOnly);
    const count = targets.length;
    const exportCount = "書き出し対象 " + count + "ページ";
    const exportMenuCount = ui["export-menu-count"];
    if (exportMenuCount.textContent !== exportCount) exportMenuCount.textContent = exportCount;
    ui["output-name"].placeholder = defaultExportName(targets, sources) + "." + (layout === "zip" ? "zip" : extension);
    ui["export-submit"].disabled = disabled || !count;
    properties.update();
  }

  function setOpen(open, restoreFocus = false) {
    form.hidden = !open;
    ui["export-menu-toggle"].setAttribute("aria-expanded", String(open));
    if (open) { properties.update(); ui["export-scope"].focus(); }
    else if (restoreFocus) ui["export-menu-toggle"].focus();
  }

  function setProgress(active) {
    ui["export-spinner"].hidden = !active;
    ui["export-menu-arrow"].hidden = active;
    ui["export-menu-label"].textContent = active ? "書き出し中…" : "ダウンロード";
  }

  function clearDownload() {
    if (latestDownload) URL.revokeObjectURL(latestDownload.url);
    latestDownload = null;
  }

  function save(plan, blob, filename) {
    const url = URL.createObjectURL(blob);
    clearDownload();
    latestDownload = { plan, url, filename };
    clickDownload();
  }

  function reuse(plan) {
    if (!latestDownload || !sameExportPlan(latestDownload.plan, plan)) return false;
    clickDownload();
    return true;
  }

  function clickDownload() {
    const link = document.createElement("a");
    link.href = latestDownload.url;
    link.download = latestDownload.filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
  }

  function reset() {
    clearDownload();
    setOpen(false);
    ui["output-name"].value = "";
    ui["export-scope"].value = "all";
    ui["export-format"].value = "pdf";
    ui["export-layout"].value = layouts.pdf = "combined";
    ui["jpeg-dpi"].value = "150";
    layouts.jpg = "zip";
  }

  ui["export-menu-toggle"].addEventListener("click", () => setOpen(form.hidden, true));
  form.addEventListener("change", event => {
    if (event.target === ui["export-layout"]) layouts[ui["export-format"].value] = event.target.value;
    update();
  });
  form.addEventListener("submit", onSubmit);
  function closeOutside(event) {
    if (!form.hidden && !ui["header-output"].contains(event.target)) setOpen(false);
  }
  document.addEventListener("pointerdown", closeOutside);
  document.addEventListener("focusin", closeOutside);
  return { options, update, setOpen, setProgress, reuse, save, reset };
}

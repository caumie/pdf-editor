import { defaultExportName, exportTargetPages, sameExportPlan } from "./export-job.mjs";

// ダウンロード欄の表示と、前回の書き出し設定・ファイルを保持する。
// ページ・選択・元PDFは、必要なときに呼び出し元から読み取る。
export function createDownloadPanel(ui, properties, context, onSubmit) {
  let pdfLayout = "combined";
  const form = ui["export-form"];
  const quality = ui["jpeg-quality"];
  let latestDownload = null;

  function options() {
    const extension = ui["export-format"].value;
    return {
      extension, layout: extension === "pdf" ? pdfLayout : "zip",
      selectionOnly: ui["export-scope"].value === "selected",
      customName: ui["output-name"].value,
      imageDpi: Number(ui["image-dpi"].value),
      jpegQuality: Number(quality.value),
      pdfSettings: properties.settings(),
    };
  }

  function update() {
    const { pages, selectedIds, sources, available } = context();
    const disabled = !available || !pages.length;
    const { extension, layout, selectionOnly } = options();
    const image = extension !== "pdf";
    const jpeg = extension === "jpg";
    const layoutInput = ui["export-layout"];
    layoutInput.options[0].disabled = layoutInput.options[0].hidden = image;
    layoutInput.value = layout;
    ui["export-menu-toggle"].disabled = disabled;
    for (const id of ["output-name", "export-format", "export-scope", "export-layout"]) ui[id].disabled = disabled;
    ui["image-dpi"].disabled = disabled || !image;
    ui["image-dpi"].hidden = ui["image-dpi-label"].hidden = !image;
    quality.disabled = disabled || !jpeg;
    ui["jpeg-quality-field"].hidden = ui["jpeg-quality-label"].hidden = !jpeg;
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
    ui["export-layout"].value = pdfLayout = "combined";
    ui["image-dpi"].value = "150";
    quality.value = quality.defaultValue;
    updateQualityLabel();
  }

  function updateQualityLabel() {
    const label = quality.value + "%";
    ui["jpeg-quality-value"].textContent = label;
    quality.setAttribute("aria-valuetext", label);
  }

  quality.addEventListener("input", updateQualityLabel);
  ui["export-menu-toggle"].addEventListener("click", () => setOpen(form.hidden, true));
  form.addEventListener("change", event => {
    if (event.target === ui["export-layout"] && ui["export-format"].value === "pdf") pdfLayout = event.target.value;
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

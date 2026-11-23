import { openSourcePdf } from "./pdf-preview.mjs";
import { loadLibraries } from "./libraries.mjs";
import { ExportSourceError, createPdfExporter } from "./pdf-export.mjs";
import { createExportPlan, createExportRunner } from "./export-job.mjs";
import { sourceImageFormat } from "./image-import.mjs";
import { readSourcePdfProperties, validatePdfOutputSettings } from "./pdf-properties.mjs";
import { openExternalAnnotationRenderer } from "./external-annotations.mjs";
import { duplicatePdfFormWarning, unsupportedPdfWarning } from "./pdf-feature-policy.mjs";
import { JpegExportError } from "./jpeg-export.mjs";

export function createEditorFiles({
  annotationEditor,
  commitDocumentRevision,
  documentHistory,
  documentPropertiesUi,
  downloadPanel,
  interaction,
  pageView,
  previewPageIds,
  showStatus,
  ui,
  unsavedChanges,
  updateControls,
  workspace,
  workspaceAvailable,
}) {
  let pdfjs;
  let pdfExporter;
  let runExport;

  async function openPdfForImport(file) {
    let password = "";
    let retry = false;
    while (true) {
      try { return await openSourcePdf(pdfjs, file, password); }
      catch (error) {
        if (error.name !== "PasswordException") throw error;
        const dialog = ui["source-password-dialog"];
        ui["source-password-message"].textContent = file.name + (retry ? "：パスワードが違います。再入力してください。" : " を開くためのパスワードを入力してください。");
        ui["source-password"].value = "";
        dialog.returnValue = "";
        const response = new Promise(resolve => dialog.addEventListener("close", () => {
          resolve(dialog.returnValue === "open" ? ui["source-password"].value : null);
          ui["source-password"].value = "";
        }, { once: true }));
        dialog.showModal();
        ui["source-password"].focus();
        password = await response;
        if (password === null) return null;
        retry = true;
      }
    }
  }

  async function initialize() {
    try {
      const libraries = await loadLibraries();
      pdfjs = libraries.pdfjs;
      pdfExporter = createPdfExporter(libraries.pdfLib);
      documentPropertiesUi.setOutputVersions(await pdfExporter.outputVersionLabels());
      runExport = createExportRunner(pdfExporter, libraries.fflate);
      workspace.ready = true;
    } catch (error) {
      console.error(error);
      showStatus("PDF編集機能を起動できませんでした。", { error: true });
    } finally {
      updateControls();
    }
  }

  async function runWorkspaceJob(job, { reading = false } = {}) {
    const label = reading ? ui["add-files-label"] : null;
    const count = reading ? ui["page-import-count"] : null;
    const filename = reading ? ui["page-import-filename"] : null;
    const reportFile = reading ? (file, index, total) => {
      count.textContent = "読み込み中 " + (index + 1) + "/" + total + "件";
      filename.textContent = filename.title = file.name;
    } : undefined;
    if (label) label.textContent = "読み込み中…";
    workspace.busy = true;
    updateControls();
    try {
      await job(reportFile);
    } finally {
      if (label) label.textContent = "ファイルを追加";
      if (reading) {
        count.textContent = "";
        filename.textContent = filename.title = "";
      }
      workspace.busy = false;
      updateControls();
    }
  }

  async function importDocumentFiles(files) {
    if (!workspaceAvailable() || !files.length) return;
    const firstImport = workspace.sourcePdfs.size === 0 && !documentHistory.pages.length;
    await runWorkspaceJob(async reportFile => {
      const added = [];
      const errors = [];
      const warnings = [];
      const skipped = [];
      for (const [index, file] of files.entries()) {
        reportFile(file, index, files.length);
        const format = sourceImageFormat(file);
        try {
          let source;
          if (format) {
            const { pdfFile, image } = await pdfExporter.convertImage(file, format);
            source = { ...await openSourcePdf(pdfjs, pdfFile), file, pdfFile, image };
          } else {
            source = await openPdfForImport(file);
            if (!source) {
              skipped.push(file.name + " — パスワード入力をキャンセルしました。");
              continue;
            }
          }
          source.properties = await readSourcePdfProperties(source.reader);
          const sourcePdfId = workspace.nextSourcePdfId++;
          if (!source.image) {
            try {
              const imported = await pdfExporter.readSourceForEditing(file, source.reader, async bytes => {
                source.externalRenderer = await openExternalAnnotationRenderer(pdfjs, bytes, sourcePdfId);
              }, source.password);
              source.restoredAnnotations = imported.annotations;
              source.formFieldPages = imported.formFieldPages;
              const warning = unsupportedPdfWarning(file.name, imported.unsupportedFeatures);
              if (warning) warnings.push(warning);
            } catch (error) {
              console.warn("編集用の注釈情報を復元できませんでした。", error);
              errors.push(file.name + " — 書き込み情報を読み込めなかったため、注釈を編集できません。PDFの表示は続行します。");
            }
          }
          workspace.sourcePdfs.set(sourcePdfId, source);
          documentPropertiesUi.initializeSource(source);
          for (let sourceIndex = 0; sourceIndex < source.reader.numPages; sourceIndex++) {
            const annotations = (source.restoredAnnotations?.get(sourceIndex) ?? [])
              .map(({ annotation }) => ({ ...annotation, id: annotationEditor.nextId++,
                ...(annotation.appearancePageIndex !== undefined
                  ? { appearanceKey: sourcePdfId + ":" + (annotation.externalRefId ?? annotation.sourceAnnotationRef) } : {}) }));
            added.push({ id: sourcePdfId + ":" + sourceIndex, sourcePdfId, sourceIndex, addedRotation: 0, annotations });
          }
        } catch (error) {
          const reason = format ? format + "画像として開けませんでした。"
            : error.name === "PasswordException" ? "パスワードで保護されています。" : "PDFとして開けませんでした。";
          errors.push(file.name + " — " + reason);
          console.warn(error);
        }
      }
      if (added.length) {
        interaction.shortcutScope = "pages";
        const pages = [...documentHistory.pages, ...added];
        const duplicateWarning = duplicatePdfFormWarning(pages, workspace.sourcePdfs, new Set(added.map(page => page.sourcePdfId)));
        if (duplicateWarning) warnings.unshift(duplicateWarning);
        commitDocumentRevision(pages, {
          selectedPageIds: new Set(previewPageIds(documentHistory.pages.length, pages)),
          previewPageId: added[0].id,
        });
        if (firstImport && workspace.sourcePdfs.size === 1 && !workspace.sourcePdfs.get(added[0].sourcePdfId).image) {
          unsavedChanges.markSaved();
        }
      }
      const notice = [...errors, ...warnings, ...skipped].join("\n\n");
      if (notice) showStatus(notice, { error: errors.length > 0 });
    }, { reading: true });
  }

  function releaseUnusedSourcePdfs() {
    // 今の一覧から消えてもUndoで復活する。履歴からも参照されなくなるまでは元PDFを破棄しない。
    const referenced = documentHistory.sourceIds();
    for (const [id, source] of workspace.sourcePdfs) {
      if (referenced.has(id)) continue;
      workspace.sourcePdfs.delete(id);
      source.externalRenderer?.destroy().catch(console.warn);
      source.loadingTask.destroy().catch(console.warn);
    }
  }

  function loadSourcePage(page) {
    return workspace.sourcePdfs.get(page.sourcePdfId).reader.getPage(page.sourceIndex + 1);
  }

  async function downloadExport(event) {
    event.preventDefault();
    if (!workspaceAvailable()) return;
    const options = downloadPanel.options();
    if (options.extension === "pdf") {
      try { validatePdfOutputSettings(options.pdfSettings); }
      catch (error) { showStatus(error.message, { error: true }); return; }
    }
    const plan = createExportPlan(documentHistory.pages, pageView.selectedPageIds, workspace.sourcePdfs, options);
    if (!plan.pages.length) return;
    const restoreFocus = !ui["export-form"].hidden;
    downloadPanel.setOpen(false);
    await runWorkspaceJob(async () => {
      downloadPanel.setProgress(true);
      try {
        if (!downloadPanel.reuse(plan)) {
          await waitForExportPaint();
          await runExport(plan, { download: (blob, filename) => downloadPanel.save(plan, blob, filename) });
        }
        if (plan.extension === "pdf" && plan.layout === "combined"
            && plan.pages.length === documentHistory.pages.length
            && plan.pages.every((page, index) => page === documentHistory.pages[index])) unsavedChanges.markSaved();
        const duplicateWarning = plan.extension === "pdf" && plan.layout === "combined"
          ? duplicatePdfFormWarning(plan.pages, plan.sources) : "";
        if (duplicateWarning) showStatus(duplicateWarning);
      } catch (error) {
        showExportError(error);
      } finally {
        downloadPanel.setProgress(false);
      }
    });
    if (restoreFocus) ui["export-menu-toggle"].focus();
  }

  function waitForExportPaint() {
    return new Promise(resolve => {
      // PDFの処理を始める前に一度描画する。バックグラウンドではタイマーで続行する。
      const frame = requestAnimationFrame(() => setTimeout(finish, 0));
      const fallback = setTimeout(finish, 100);
      function finish() {
        cancelAnimationFrame(frame);
        clearTimeout(fallback);
        resolve();
      }
    });
  }

  function showExportError(error) {
    const detail = error instanceof ExportSourceError || error instanceof JpegExportError
      ? "\n" + error.message : "";
    showStatus("書き出しに失敗しました。" + detail + "\n編集内容は画面に残っています。", { error: true });
    console.error(error);
  }

  function bindFileDrop() {
    let fileDragDepth = 0;
    function hasFiles(event) {
      return event.dataTransfer.types.includes("Files");
    }
    window.addEventListener("dragenter", event => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      fileDragDepth += 1;
      if (workspace.ready && !workspace.busy) document.body.classList.add("file-over");
    });
    window.addEventListener("dragover", event => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = workspace.ready && !workspace.busy ? "copy" : "none";
    });
    window.addEventListener("dragleave", event => {
      if (!hasFiles(event)) return;
      fileDragDepth = Math.max(0, fileDragDepth - 1);
      if (!fileDragDepth) document.body.classList.remove("file-over");
    });
    window.addEventListener("drop", event => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      fileDragDepth = 0;
      document.body.classList.remove("file-over");
      importDocumentFiles([...event.dataTransfer.files]);
    });
  }

  function createTextLayer(options) {
    return new pdfjs.TextLayer(options);
  }

  return {
    createTextLayer,
    initialize,
    importDocumentFiles,
    releaseUnusedSourcePdfs,
    loadSourcePage,
    bindFileDrop,
    downloadExport,
  };
}

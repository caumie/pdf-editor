import { pdfPermissionFields, initialOutputProperties, mergedSourceNotes, pdfOutputNeedsEncryption, pdfDateForDisplay } from "./pdf-properties.mjs";
import { pdfGeneratorName } from "./pdf-document.mjs";

// 元文書の参照情報と、利用者が編集する出力設定を別に保持する。
export function createDocumentPropertiesUi(ui, sources, outputPages, available) {
  let baseline = null;
  let notesEdited = false;
  let outputVersions = null;
  const permissionInputs = new Map();
  const generatedFields = ["pdf-creation-date", "pdf-modification-date", "pdf-creator", "pdf-producer", "pdf-version"];
  const fields = { title: "pdf-title", author: "pdf-author", subject: "pdf-subject", keywords: "pdf-keywords", notes: "pdf-notes" };

  for (const { key, label } of pdfPermissionFields) {
    const row = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("aria-label", label + "を許可");
    row.append(checkbox, document.createTextNode(label));
    ui["pdf-permissions"].append(row);
    permissionInputs.set(key, checkbox);
    checkbox.addEventListener("change", () => {
      if (key === "printing" && !checkbox.checked) permissionInputs.get("highQualityPrinting").checked = false;
      if (key === "highQualityPrinting" && checkbox.checked) permissionInputs.get("printing").checked = true;
      update();
    });
  }

  function initializeSource(source) {
    if (baseline) return;
    baseline = { name: source.file.name, properties: structuredClone(source.properties) };
    const defaults = initialOutputProperties(source.properties);
    for (const [key, id] of Object.entries(fields)) ui[id].value = defaults[key];
    for (const [key, input] of permissionInputs) input.checked = defaults.permissions[key];
    update();
  }

  function settings() {
    const result = Object.fromEntries(Object.entries(fields).map(([key, id]) => [key, ui[id].value]));
    result.permissions = Object.fromEntries([...permissionInputs].map(([key, input]) => [key, input.checked]));
    result.userPasswordEnabled = ui["pdf-user-password-enabled"].checked;
    result.userPassword = result.userPasswordEnabled ? ui["pdf-user-password"].value : "";
    return result;
  }

  function chosenSources() {
    const ids = new Set(outputPages().map(page => page.sourcePdfId));
    return new Map([...sources()].filter(([id]) => ids.has(id)));
  }

  function update() {
    const enabled = available();
    const originals = sources();
    const includesImages = [...originals.values()].some(source => source.image);
    ui["source-properties"].disabled = !enabled || !originals.size;
    ui["source-properties-label"].textContent = includesImages ? "元ファイル情報" : "元PDF情報";
    ui["source-properties-title"].textContent = includesImages ? "元ファイルのプロパティ" : "元PDFのプロパティ";
    const pdf = ui["export-format"].value === "pdf";
    ui["pdf-output-settings"].hidden = !pdf;
    for (const id of Object.values(fields)) ui[id].disabled = !enabled || !pdf;
    for (const input of permissionInputs.values()) input.disabled = !enabled || !pdf;
    const toggle = ui["pdf-user-password-enabled"];
    toggle.disabled = !enabled || !pdf;
    ui["pdf-user-password"].disabled = !enabled || !pdf || !toggle.checked;
    if (!baseline) return;
    const chosen = chosenSources();
    if (!notesEdited) ui["pdf-notes"].value = mergedSourceNotes(baseline.properties.notes, ui["export-layout"].value === "combined" ? chosen : new Map());
    const values = settings();
    const encrypt = pdfOutputNeedsEncryption(values);
    const versionLabel = outputVersions?.[encrypt ? "encrypted" : "plain"] ?? "未取得";
    const first = [...chosen.values()][0];
    const creation = ui["export-layout"].value === "zip" && chosen.size > 1 ? "各元PDFの日時"
      : chosen.size === 1 ? pdfDateForDisplay(first?.properties.info.CreationDate) : "保存時に設定";
    const generated = [creation === "未設定" ? "保存時に設定" : creation, "<保存時に設定>", pdfGeneratorName, pdfGeneratorName, versionLabel];
    for (const [index, id] of generatedFields.entries()) ui[id].value = generated[index];
  }

  function openProperties() {
    const table = document.createElement("table");
    table.className = "properties-table";
    const originals = [...sources().values()];
    const keyWidth = 112, fileWidth = 176;
    const width = keyWidth + originals.length * fileWidth;
    table.style.width = width + "px";
    const columns = document.createElement("colgroup");
    for (let index = 0; index <= originals.length; index++) {
      const column = document.createElement("col");
      column.style.width = (index === 0 ? keyWidth : fileWidth) + "px";
      columns.append(column);
    }
    const head = document.createElement("thead");
    const body = document.createElement("tbody");
    table.append(columns, head, body);
    const addRow = (label, values, header = false) => {
      const row = document.createElement("tr");
      const heading = document.createElement("th");
      heading.scope = header ? "col" : "row";
      heading.textContent = label;
      row.append(heading);
      for (const value of values) {
        const cell = document.createElement(header ? "th" : "td");
        if (header) cell.scope = "col";
        cell.textContent = value;
        row.append(cell);
      }
      (header ? head : body).append(row);
    };
    addRow("項目", originals.map(source => source.file.name), true);
    addRow("ページ数", originals.map(source => String(source.reader.numPages)));
    addRow("ファイルサイズ", originals.map(source => source.file.size.toLocaleString() + " bytes"));
    if (originals.some(source => source.image)) {
      addRow("形式", originals.map(source => source.image?.format ?? "PDF"));
      addRow("画像サイズ", originals.map(({ image }) => image ? image.width + " × " + image.height + " px" : "—"));
    }
    for (const [key, label] of [["Title", "タイトル"], ["Author", "著者"], ["Subject", "件名"], ["Keywords", "キーワード"],
      ["Creator", "作成アプリ"], ["Producer", "生成ソフト"], ["CreationDate", "作成日時"], ["ModDate", "更新日時"]]) {
      addRow(label, originals.map(source => source.image ? "—" : !source.properties.metadataKnown ? "取得できません" : key.endsWith("Date")
        ? pdfDateForDisplay(source.properties.info[key]) : source.properties.info[key] || "未設定"));
    }
    addRow("備考（Notes）", originals.map(source => source.properties.notes || "未設定"));
    addRow("PDFバージョン", originals.map(source => source.image ? "—" : source.properties.version));
    addRow("暗号化", originals.map(source => source.image ? "—" : source.properties.encrypted === null ? "不明" : source.properties.encrypted ? "あり（" + source.properties.info.EncryptFilterName + "）" : "なし"));
    addRow("閲覧パスワード", originals.map(source => source.image ? "—" : source.password ? "あり" : "なし"));
    for (const { key, label } of pdfPermissionFields) {
      addRow(label, originals.map(source => source.image ? "—" : source.properties.permissions ? source.properties.permissions[key] ? "許可" : "不許可" : "不明"));
    }
    ui["source-properties-content"].replaceChildren(table);
    ui["source-properties-count"].textContent = originals.length + "ファイル";
    ui["source-properties-dialog"].style.setProperty("--properties-width", width + 44 + "px");
    ui["source-properties-content"].scrollLeft = ui["source-properties-content"].scrollTop = 0;
    ui["source-properties-dialog"].showModal();
    ui["source-properties-content"].focus();
  }

  function reset() {
    baseline = null;
    notesEdited = false;
    for (const id of [...Object.values(fields), ...generatedFields]) ui[id].value = "";
    for (const input of permissionInputs.values()) input.checked = true;
    ui["pdf-permission-details"].open = ui["pdf-metadata-details"].open = false;
    ui["pdf-user-password-enabled"].checked = false;
    ui["pdf-user-password"].value = "";
    ui["source-properties-content"].replaceChildren();
    update();
  }

  ui["source-properties"].addEventListener("click", openProperties);
  ui["source-properties-close"].addEventListener("click", () => ui["source-properties-dialog"].close());
  ui["pdf-notes"].addEventListener("input", () => { notesEdited = true; });
  // 折りたたんだ後の送信でも、標準の必須入力警告を入力欄に表示できるようにする。
  ui["pdf-user-password"].addEventListener("invalid", () => { ui["pdf-permission-details"].open = true; });
  ui["pdf-output-settings"].addEventListener("input", update);
  ui["pdf-output-settings"].addEventListener("change", event => {
    if (event.target === ui["pdf-user-password-enabled"] && !event.target.checked) ui["pdf-user-password"].value = "";
    update();
  });
  reset();
  function revisionSettings() {
    const values = settings();
    // 対象ページの選択だけで自動の結合元一覧が変わっても、未保存編集とはしない。
    values.notes = notesEdited ? values.notes : null;
    return values;
  }
  function setOutputVersions(versions) { outputVersions = { ...versions }; update(); }
  return { initializeSource, settings, revisionSettings, setOutputVersions, update, reset };
}

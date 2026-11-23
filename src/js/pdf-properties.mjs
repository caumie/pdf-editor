export const pdfPermissionFields = [
  { key: "printing", bit: 4, label: "印刷" },
  { key: "highQualityPrinting", bit: 2048, label: "高品質印刷" },
  { key: "modifying", bit: 8, label: "文書内容の変更" },
  { key: "copying", bit: 16, label: "文字・画像のコピー" },
  { key: "annotating", bit: 32, label: "注釈の追加・変更" },
  { key: "fillingForms", bit: 256, label: "フォームへの入力" },
  { key: "contentAccessibility", bit: 512, label: "アクセシビリティ用の抽出" },
  { key: "documentAssembly", bit: 1024, label: "ページの挿入・回転・削除" },
];

export async function readSourcePdfProperties(reader) {
  const [metadata, permissions] = await Promise.allSettled([
    Promise.resolve().then(() => reader.getMetadata()),
    Promise.resolve().then(() => reader.getPermissions()),
  ]);
  const info = metadata.status === "fulfilled" ? metadata.value.info ?? {} : {};
  const known = permissions.status === "fulfilled" && permissions.value !== undefined;
  const values = known && permissions.value !== null ? new Set(permissions.value) : null;
  return {
    info, title: info.Title ?? "", author: info.Author ?? "", subject: info.Subject ?? "",
    keywords: info.Keywords ?? "", notes: info.Custom?.Notes ?? "",
    permissions: known ? Object.fromEntries(pdfPermissionFields.map(({ key, bit }) => [key, !values || values.has(bit)])) : null,
    permissionsKnown: known, metadataKnown: metadata.status === "fulfilled",
    encrypted: metadata.status === "fulfilled" ? Boolean(info.EncryptFilterName) : null,
    version: info.PDFFormatVersion ?? "不明",
  };
}

export function normalizePdfPermissions(permissions) {
  const values = permissions == null ? null : new Set(permissions);
  return Object.fromEntries(pdfPermissionFields.map(({ key, bit }) => [key, values === null || values.has(bit)]));
}

export function initialOutputProperties(properties) {
  return {
    title: properties.title, author: "", subject: properties.subject, keywords: properties.keywords,
    notes: properties.notes, permissions: normalizePdfPermissions(null),
  };
}

export function mergedSourceNotes(base, sources) {
  if (sources.size < 2) return base;
  const entries = [...sources.values()];
  const label = entries.some(source => source.image) ? "結合元ファイル" : "結合元PDF";
  return [base, label + "：\n" + entries.map(source => source.file.name).join("\n")].filter(Boolean).join("\n\n");
}

export function pdfOutputNeedsEncryption(settings) {
  return Boolean(settings?.userPasswordEnabled
    || (settings?.permissions && pdfPermissionFields.some(({ key }) => !settings.permissions[key])));
}

export function validatePdfOutputSettings(settings) {
  if (!settings.userPasswordEnabled) return;
  if (!settings.userPassword) throw new Error("閲覧用パスワードを入力するか、保護のチェックを外してください。");
  if (new TextEncoder().encode(settings.userPassword).length > 127) throw new Error("閲覧用パスワードはUTF-8で127バイト以内にしてください。");
}

export function applyPdfOutputSecurity(output, settings) {
  if (!settings) return;
  validatePdfOutputSettings(settings);
  if (!pdfOutputNeedsEncryption(settings)) return;
  const permissions = settings.permissions ?? normalizePdfPermissions(null);
  // パスワード未指定でも権限フラグを保存するため、権限用のランダムな内部キーを使う。
  const ownerPassword = Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, "0")).join("");
  output.encrypt({ algorithm: "AES-256", userPassword: settings.userPasswordEnabled ? settings.userPassword : "",
    ownerPassword, permissions: {
      printing: !permissions.printing ? false : permissions.highQualityPrinting ? "highResolution" : "lowResolution",
      modifying: permissions.modifying, copying: permissions.copying, annotating: permissions.annotating,
      fillingForms: permissions.fillingForms, contentAccessibility: permissions.contentAccessibility,
      documentAssembly: permissions.documentAssembly,
    } });
}

export function pdfDateForDisplay(value) {
  if (!value) return "未設定";
  const match = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(value);
  if (!match) return value;
  const [, year, month = "01", day = "01", hour = "00", minute = "00", second = "00"] = match;
  const zone = value.slice(match[0].length);
  return `${year}-${month}-${day} ${hour}:${minute}:${second}${zone ? " " + zone : "（タイムゾーン未指定）"}`;
}

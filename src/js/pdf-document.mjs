export const pdfGeneratorName = "pdf-editor";

// 保存したバイト列を再読込した文書から、実際の宣言バージョンを読む。
export function generatedPdfVersionLabel(pdfLib, output) {
  const name = pdfLib.PDFName.of;
  const versions = [output.context.header.getVersionString(), output.catalog.get(name("Version"))?.decodeText?.()]
    .filter(value => /^\d+\.\d+$/.test(value ?? ""));
  const version = versions.sort((a, b) => Number(b) - Number(a))[0] ?? "不明";
  const extensions = output.catalog.lookupMaybe(name("Extensions"), pdfLib.PDFDict);
  const adobe = extensions?.lookupMaybe(name("ADBE"), pdfLib.PDFDict);
  const level = adobe?.lookupMaybe(name("ExtensionLevel"), pdfLib.PDFNumber)?.asNumber();
  return version + (level > 0 ? " 拡張レベル" + level : "");
}

// 文書属性は出力設定から生成し、元文書のPDF/A・PDF/X適合宣言は継承しない。
export function initializeGeneratedPdf(pdfLib, output, settings = {}) {
  const now = new Date();
  const creationDate = settings.creationDate instanceof Date ? settings.creationDate : now;
  const { title = "", author = "", subject = "", keywords = "", notes = "" } = settings;
  output.setCreator(pdfGeneratorName);
  output.setProducer(pdfGeneratorName);
  output.setAuthor(author);
  output.setTitle(title);
  output.setSubject(subject);
  // カンマを含む語句も、画面で指定した文字列のまま記録する。
  const info = output.context.lookup(output.context.trailerInfo.Info);
  info.set(pdfLib.PDFName.of("Keywords"), pdfLib.PDFHexString.fromText(keywords));
  info.set(pdfLib.PDFName.of("Notes"), pdfLib.PDFHexString.fromText(notes));
  output.setCreationDate(creationDate);
  output.setModificationDate(now);
  const escapeXml = value => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const timestamp = now.toISOString();
  const xml = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:ppe="urn:pdf-page-editor:metadata:1.0/">
<xmp:CreatorTool>${pdfGeneratorName}</xmp:CreatorTool>
<pdf:Producer>${pdfGeneratorName}</pdf:Producer>
<xmp:CreateDate>${creationDate.toISOString()}</xmp:CreateDate>
<xmp:ModifyDate>${timestamp}</xmp:ModifyDate>
<xmp:MetadataDate>${timestamp}</xmp:MetadataDate>
<dc:format>application/pdf</dc:format>
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(title)}</rdf:li></rdf:Alt></dc:title>
<dc:creator><rdf:Seq>${author ? "<rdf:li>" + escapeXml(author) + "</rdf:li>" : ""}</rdf:Seq></dc:creator>
<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(subject)}</rdf:li></rdf:Alt></dc:description>
<pdf:Keywords>${escapeXml(keywords)}</pdf:Keywords>
<ppe:Notes>${escapeXml(notes)}</ppe:Notes>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
  const name = pdfLib.PDFName.of;
  const metadata = output.context.flateStream(new TextEncoder().encode(xml), { Type: "Metadata", Subtype: "XML" });
  output.catalog.set(name("Metadata"), output.context.register(metadata));
  output.catalog.set(name("ViewerPreferences"), output.context.obj({ PrintScaling: "None" }));
}

// 文書全体の出力インテントは先頭ページの元PDFから、埋め込みICCがあるものだけを取り込む。
// プロファイルのない文書や未対応の外部参照では、代替ICCを生成せず未指定とする。
export function copyPdfOutputIntents(pdfLib, output, source, copier) {
  const { PDFArray, PDFDict, PDFName, PDFNumber, PDFStream } = pdfLib;
  const name = PDFName.of;
  const copied = output.context.obj([]);
  let intents;
  try {
    intents = source.catalog.lookupMaybe(name("OutputIntents"), PDFArray);
  } catch {
    return;
  }
  for (const ref of intents?.asArray() ?? []) {
    try {
      const intent = source.context.lookup(ref, PDFDict);
      const profile = intent.lookupMaybe(name("DestOutputProfile"), PDFStream);
      const channels = profile?.dict.lookupMaybe(name("N"), PDFNumber)?.asNumber();
      if (!profile || ![1, 3, 4].includes(channels)) continue;
      copied.push(copier.copy(ref));
    } catch {
      // ICCだけの取り込み失敗ではページの書き出しを止めない。
    }
  }
  if (copied.size()) output.catalog.set(name("OutputIntents"), copied);
}

// ページと同じ copier を使い、ページの /OC 参照と文書のレイヤー設定を一致させる。
export function mergePdfLayers(pdfLib, output, source, copier, { keepAlternateConfigurations = false } = {}) {
  const { PDFArray, PDFDict, PDFName } = pdfLib;
  const name = PDFName.of;
  const incoming = source.catalog.lookupMaybe(name("OCProperties"), PDFDict);
  if (!incoming) return;
  const copied = copier.copy(incoming);
  const groups = copied.lookupMaybe(name("OCGs"), PDFArray);
  if (!groups?.size()) return;

  let properties = output.catalog.lookupMaybe(name("OCProperties"), PDFDict);
  if (!properties) {
    properties = output.context.obj({ OCGs: [], D: { BaseState: "ON" } });
    output.catalog.set(name("OCProperties"), properties);
  }
  // 代替構成は文書全体に作用するため、元PDFが複数ある結合では既定の表示状態だけを統合する。
  if (keepAlternateConfigurations && copied.lookupMaybe(name("Configs"), PDFArray)) {
    properties.set(name("Configs"), copied.get(name("Configs")));
  }
  function array(dict, key) {
    let value = dict.lookupMaybe(name(key), PDFArray);
    if (!value) dict.set(name(key), value = output.context.obj([]));
    return value;
  }
  function append(target, values) {
    for (const value of values?.asArray() ?? []) target.push(value);
  }
  const all = array(properties, "OCGs");
  const config = copied.lookupMaybe(name("D"), PDFDict);
  let target = properties.lookupMaybe(name("D"), PDFDict);
  if (!target) properties.set(name("D"), target = output.context.obj({ BaseState: "ON" }));
  const on = array(target, "ON"), off = array(target, "OFF");
  const incomingOn = config?.lookupMaybe(name("ON"), PDFArray);
  const incomingOff = config?.lookupMaybe(name("OFF"), PDFArray);
  const baseOff = config?.lookupMaybe(name("BaseState"), PDFName)?.decodeText() === "OFF";
  for (const group of groups.asArray()) {
    all.push(group);
    // 出力側の BaseState が異なっていても、取り込む各グループの既定状態を保持する。
    const visible = incomingOff?.indexOf(group) !== undefined ? false
      : incomingOn?.indexOf(group) !== undefined ? true : !baseOff;
    (visible ? on : off).push(group);
  }
  for (const key of ["Order", "AS", "RBGroups", "Locked"]) {
    const values = config?.lookupMaybe(name(key), PDFArray);
    if (values) append(array(target, key), values);
  }
  if (!config?.has(name("Order"))) append(array(target, "Order"), groups);
}

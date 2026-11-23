import { compatiblePdfText } from "./pdf-text.mjs";

// リンクはコピー用ビューで解決し、名前付き移動先としおりは出力文書用に構築し直す。
export function mergePdfNavigation(pdfLib, output, graphs) {
  const name = pdfLib.PDFName.of;
  const destinations = new Map();
  for (const graph of graphs) {
    for (const [label, value] of graph.named) {
      const destination = graph.destination(value);
      if (!destination) continue;
      let unique = label, suffix = 2;
      while (destinations.has(unique)) unique = label + "_" + suffix++;
      destinations.set(unique, graph.copier.copy(destination));
    }
  }
  if (destinations.size) {
    const pairs = output.context.obj([]);
    for (const label of [...destinations.keys()].sort()) {
      pairs.push(pdfLib.PDFHexString.fromText(label)); pairs.push(destinations.get(label));
    }
    output.catalog.set(name("Names"), output.context.obj({ Dests: { Names: pairs } }));
  }

  const top = [];
  for (const graph of graphs) {
    const root = graph.dict(graph.source.catalog.get(name("Outlines")));
    const visited = new Set();
    function siblings(first, depth = 0) {
      if (depth > 128) throw new Error("しおりの階層が深すぎるため保存できません。");
      const entries = [];
      let ref = first;
      while (ref) {
        const original = graph.dict(ref);
        if (!original || visited.has(original)) break;
        visited.add(original);
        const children = siblings(original.get(name("First")), depth + 1);
        const destination = original.has(name("Dest")) ? graph.destination(original.get(name("Dest"))) : null;
        const action = original.has(name("A")) ? graph.action(original.get(name("A"))) : null;
        const hasTarget = original.has(name("Dest")) || original.has(name("A"));
        if (children.length || destination || action || !hasTarget) {
          const value = output.context.obj({});
          const title = original.get(name("Title"));
          if (title) value.set(name("Title"), compatiblePdfText(pdfLib, graph.read(title)) ?? graph.copier.copy(title));
          for (const key of ["C", "F"]) if (original.has(name(key))) value.set(name(key), graph.copier.copy(original.get(name(key))));
          if (destination) value.set(name("Dest"), graph.copier.copy(destination));
          if (action) value.set(name("A"), graph.copier.copy(action));
          const collapsed = (graph.read(original.get(name("Count")))?.asNumber?.() ?? 0) < 0;
          entries.push({ ref: output.context.register(value), value, children, collapsed });
        }
        ref = original.get(name("Next"));
      }
      return entries;
    }
    if (root) top.push(...siblings(root.get(name("First"))));
  }
  if (!top.length) return;
  const root = output.context.obj({ Type: "Outlines" });
  const rootRef = output.context.register(root);
  function connect(entries, parent, parentRef) {
    parent.set(name("First"), entries[0].ref); parent.set(name("Last"), entries.at(-1).ref);
    let visible = 0;
    for (const [index, entry] of entries.entries()) {
      entry.value.set(name("Parent"), parentRef);
      if (index) entry.value.set(name("Prev"), entries[index - 1].ref);
      if (index + 1 < entries.length) entry.value.set(name("Next"), entries[index + 1].ref);
      let childCount = 0;
      if (entry.children.length) {
        childCount = connect(entry.children, entry.value, entry.ref);
        entry.value.set(name("Count"), pdfLib.PDFNumber.of(entry.collapsed ? -childCount : childCount));
      }
      visible += 1 + (entry.collapsed ? 0 : childCount);
    }
    return visible;
  }
  root.set(name("Count"), pdfLib.PDFNumber.of(connect(top, root, rootRef)));
  output.catalog.set(name("Outlines"), rootRef);
}

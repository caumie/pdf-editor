// 文書の履歴には、確定したページの配列だけを格納する。
// ページの選択、表示倍率、ドラッグ途中の状態は呼び出し側が保持する。
export function createDocumentHistory(limit = 40) {
  let pages = [];
  const undo = [];
  const redo = [];

  return {
    get pages() { return pages; },
    get canUndo() { return undo.length > 0; },
    get canRedo() { return redo.length > 0; },
    clear() {
      pages = [];
      undo.length = 0;
      redo.length = 0;
    },
    commit(next) {
      if (next === pages) return false;
      const discarded = undo.length === limit || redo.length > 0;
      undo.push(pages);
      if (undo.length > limit) undo.shift();
      redo.length = 0;
      pages = next;
      return discarded;
    },
    step(direction) {
      const [from, to] = direction === "undo" ? [undo, redo] : [redo, undo];
      if (!from.length) return false;
      to.push(pages);
      pages = from.pop();
      return true;
    },
    sourceIds() {
      const ids = new Set();
      for (const revision of [pages, ...undo, ...redo]) {
        for (const page of revision) ids.add(page.sourcePdfId);
      }
      return ids;
    },
  };
}

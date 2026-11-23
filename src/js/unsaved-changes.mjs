// 文書内容と手入力した出力設定を保存済み状態と比較する。表示・選択の変更は含めない。
export function createUnsavedChangesGuard(target, readState) {
  let savedPages;
  let savedSettings;
  function markSaved() {
    const state = readState();
    savedPages = state.pages;
    savedSettings = JSON.stringify(state.settings);
  }
  function hasChanges() {
    const state = readState();
    return Boolean(state.pending) || state.pages !== savedPages || JSON.stringify(state.settings) !== savedSettings;
  }
  function beforeUnload(event) {
    if (!hasChanges()) return;
    event.preventDefault();
    event.returnValue = "";
  }
  markSaved();
  target.addEventListener("beforeunload", beforeUnload);
  return { markSaved, hasChanges, dispose: () => target.removeEventListener("beforeunload", beforeUnload) };
}

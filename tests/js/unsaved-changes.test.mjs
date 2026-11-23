import assert from "node:assert/strict";
import test from "node:test";
import { createUnsavedChangesGuard } from "../../src/js/unsaved-changes.mjs";

test("文書変更・出力プロパティ・未確定編集は離脱を止め、Undoや保存後は解除する", () => {
  const target = new EventTarget();
  const original = [{}];
  const state = { pages: original, settings: { title: "original", userPassword: "" }, pending: false };
  const guard = createUnsavedChangesGuard(target, () => state);
  function blocked() {
    const event = new Event("beforeunload", { cancelable: true });
    target.dispatchEvent(event); return event.defaultPrevented;
  }
  assert.equal(blocked(), false);
  state.pages = [...original]; assert.equal(blocked(), true);
  state.pages = original; assert.equal(blocked(), false);
  state.settings.title = "edited"; assert.equal(blocked(), true);
  guard.markSaved(); assert.equal(blocked(), false);
  state.settings.userPassword = "explicit-password"; assert.equal(blocked(), true);
  guard.markSaved(); assert.equal(blocked(), false);
  state.pending = true; assert.equal(blocked(), true);
  state.pending = false; assert.equal(blocked(), false);
  state.pages = []; assert.equal(blocked(), true);
  guard.markSaved(); assert.equal(blocked(), false);
  state.pages = [{}]; assert.equal(blocked(), true);
  guard.dispose(); assert.equal(blocked(), false);
});

test("初期状態の空文書は警告せず、読み込んだ文書の全ページ削除は未保存になる", () => {
  const state = { pages: [], settings: {} };
  const guard = createUnsavedChangesGuard(new EventTarget(), () => state);
  assert.equal(guard.hasChanges(), false);
  state.pages = [{}]; guard.markSaved();
  const saved = state.pages;
  state.pages = []; assert.equal(guard.hasChanges(), true);
  state.pages = saved; assert.equal(guard.hasChanges(), false);
  state.pages = []; guard.markSaved(); assert.equal(guard.hasChanges(), false);
  guard.dispose();
});

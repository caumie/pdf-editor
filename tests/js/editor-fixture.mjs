import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { runInContext } from "node:vm";

const folder = new URL("../../src/js/", import.meta.url);
const modules = readdirSync(folder).filter(name => name.endsWith(".mjs"))
  .map(name => readFileSync(new URL(name, folder), "utf8"));

function editorHandlerSource(name) {
  for (const source of modules) {
    const match = new RegExp("^([ ]*)(?:export )?((?:async )?function " + name + "\\()", "m").exec(source);
    if (!match) continue;
    const start = match.index + match[0].indexOf(match[2]);
    const end = source.indexOf("\n" + match[1] + "}", start);
    assert(end >= 0, name);
    return source.slice(start, end + match[1].length + 2);
  }
  assert.fail("エディターのハンドラーが見つかりません: " + name);
}

// 既存の操作テストが使う各依存を、実際のモジュールの状態と接続する。
export function installEditorHandler(context, name) {
  const state = new Proxy({}, {
    get: (_, key) => context[key],
    set: (_, key, value) => { context[key] = value; return true; },
  });
  context.interaction ??= state;
  context.preferences ??= state;
  context.files ??= state;
  context.list ??= state;
  context.previewUi ??= state;
  context.previewDetail ??= { clear() {}, setPages() {}, schedule() {} };
  context.tools ??= state;
  context.focusPageCard ??= id => context.thumbnailCards?.get(id)?.pick.focus({ preventScroll: true });
  runInContext(editorHandlerSource(name), context);
}

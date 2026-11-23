import { installEditorHandler } from "./editor-fixture.mjs";
import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { openSourcePdf } from "../../src/js/pdf-preview.mjs";


test("パスワード再入力は入力値を読込処理へ渡し、入力欄を消去してキャンセルも終了する", async () => {
  for (const cancelled of [false, true]) {
    const attempts = [], messages = [], responses = cancelled ? [null] : ["wrong", "correct"];
    const dialog = new EventTarget();
    const field = { value: "", focus() {} };
    const ui = { "source-password-dialog": dialog, "source-password": field, "source-password-message": {} };
    dialog.showModal = () => {
      messages.push(ui["source-password-message"].textContent);
      queueMicrotask(() => {
        const value = responses.shift();
        dialog.returnValue = value === null ? "cancel" : "open";
        field.value = value ?? "";
        dialog.dispatchEvent(new Event("close"));
      });
    };
    const context = vm.createContext({ ui, pdfjs: {}, openSourcePdf: async (_, file, password) => {
      attempts.push(password);
      if (password === "correct") return { file, password };
      const error = new Error("password required"); error.name = "PasswordException"; throw error;
    } });
    installEditorHandler(context, "openPdfForImport");
    if (cancelled) assert.equal(await context.openPdfForImport({ name: "test.pdf" }), null);
    else {
      assert.equal((await context.openPdfForImport({ name: "test.pdf" })).password, "correct");
      assert.deepEqual(attempts, ["", "wrong", "correct"]);
      assert(messages[1].includes("パスワードが違います"));
    }
    assert.equal(field.value, "");
  }
});

test("PDF.jsに入力パスワードを渡し、後の注釈復元・保存用に同じ値を元PDFと保持する", async () => {
  let received;
  const task = { promise: Promise.resolve({ numPages: 1 }), destroy: async () => {} };
  const source = await openSourcePdf({ getDocument(options) { received = options; return task; } }, new Blob(["test"]), "entered-password");
  assert.equal(received.password, "entered-password"); assert.equal(source.password, "entered-password");
});

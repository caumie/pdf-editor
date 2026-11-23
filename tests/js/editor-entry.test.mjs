import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";
import vm from "node:vm";
import test from "node:test";

const require = createRequire(import.meta.url);
const pdfLib = require("../../src/vendor/cantoo-pdf-lib/pdf-lib.min.js");
const bundle = new URL("../../dist/pdf-editor.html", import.meta.url);

function createBrowserHarness(html) {
  const downloads = [];
  const blobs = new Map();
  const observed = new Set();
  const storedSettings = new Map();
  let urlSequence = 0;
  let observer;
  const controls = new Map();
  const tools = [];
  const align = [];
  const add = [];
  const startScript = html.indexOf('<script type="module">');
  assert.notEqual(startScript, -1);
  const markup = html.slice(0, startScript);

  class Element {
    children = [];
    dataset = {};
    style = { setProperty(name, value) { this[name] = value; } };
    attributes = new Map();
    listeners = new Map();
    classes = new Set();
    captures = new Set();
    files = [];
    value = "";
    hidden = false;
    checked = false;
    open = false;
    classList = {
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name),
      contains: name => this.classes.has(name),
      toggle: (name, active) => active ? this.classes.add(name) : this.classes.delete(name),
    };
    clientWidth = 570;
    clientHeight = 750;
    width = 0;
    height = 0;
    offsetWidth = 12;
    scrollTop = 0;
    scrollLeft = 0;
    scrollWidth = 1000;
    scrollHeight = 1100;
    constructor(tag) { this.tagName = tag.toUpperCase(); }
    get firstElementChild() { return this.children[0] ?? null; }
    get nextElementSibling() {
      return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null;
    }
    get options() { return this.selectOptions ??= [{}]; }
    append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
    insertBefore(node, before) {
      node.remove();
      const index = before ? this.children.indexOf(before) : this.children.length;
      this.children.splice(index, 0, node);
      node.parentNode = this;
    }
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
      this.parentNode = null;
    }
    replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
    querySelector() { return this.form ??= new Element("form"); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    hasAttribute(name) { return this.attributes.has(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    addEventListener(name, listener) {
      const listeners = this.listeners.get(name) ?? [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }
    removeEventListener(name, listener) {
      this.listeners.set(name, (this.listeners.get(name) ?? []).filter(handler => handler !== listener));
    }
    async dispatch(name, fields = {}) {
      const event = { type: name, target: this, currentTarget: this, detail: 1, preventDefault() {}, ...fields };
      await Promise.all((this.listeners.get(name) ?? []).map(handler => handler(event)));
    }
    click() {
      if (this.tagName === "A") downloads.push({ name: this.download, blob: blobs.get(this.href) });
      return this.dispatch("click");
    }
    getContext() { return new Proxy({}, { get: () => () => {} }); }
    toBlob(callback, type) { callback(new Blob(["thumbnail"], { type })); }
    getBoundingClientRect() { return { left: 0, top: 0, right: 570, bottom: 750, width: 570, height: 750 }; }
    focus() { document.activeElement = this; }
    setPointerCapture(id) { this.captures.add(id); }
    hasPointerCapture(id) { return this.captures.has(id); }
    releasePointerCapture(id) { this.captures.delete(id); }
    contains(child) { return this.children.includes(child); }
  }
  for (const [, tag, attributes] of markup.matchAll(/<([\w-]+)([^<>]*)>/g)) {
    const id = attributes.match(/\bid="([^"]+)"/)?.[1];
    const tool = attributes.match(/\bdata-tool="([^"]+)"/)?.[1];
    const alignment = attributes.match(/\bdata-align="([^"]+)"/)?.[1];
    const isAdd = /(?:^|\s)data-add(?:\s|$)/.test(attributes);
    if (!(id || tool || alignment || isAdd)) continue;
    const node = new Element(tag);
    node.id = id;
    node.hidden = /\shidden(?:\s|$)/.test(attributes);
    node.disabled = /\sdisabled(?:\s|$)/.test(attributes);
    node.checked = /\schecked(?:\s|$)/.test(attributes);
    node.value = attributes.match(/\bvalue="([^"]*)"/)?.[1] ?? "";
    if (id) controls.set(id, node);
    if (tool) { node.dataset.tool = tool; tools.push(node); }
    if (alignment) { node.dataset.align = alignment; align.push(node); }
    if (isAdd) add.push(node);
  }
  for (const [id, value] of Object.entries({
    "export-format": "pdf", "export-layout": "combined", "export-scope": "all",
    "jpeg-dpi": "150", "preview-layout": "single", "preview-direction": "left",
  })) controls.get(id).value = value;
  const document = new Element("document");
  document.body = new Element("body");
  document.querySelectorAll = selector => ({
    "[id]": [...controls.values()],
    "button[data-tool]": tools, "button[data-align]": align, "[data-add]": add,
  }[selector] ?? []);
  document.querySelector = () => document.body;
  document.getSelection = () => null;
  document.createTextNode = text => Object.assign(new Element("text"), { textContent: text });
  document.createElement = tag => new Element(tag);
  const window = new Element("window");
  window.devicePixelRatio = 1;
  window.confirm = () => true;
  window.localStorage = {
    getItem: key => storedSettings.get(key) ?? null,
    setItem: (key, value) => storedSettings.set(key, value),
  };
  const testLibraries = {
    pdfLib,
    pdfjs: {
      getDocument({ data }) {
        return {
          destroy: async () => {},
          promise: pdfLib.PDFDocument.load(data).then(pdf => ({
            numPages: pdf.getPageCount(),
            getMetadata: async () => ({ info: {} }),
            getPermissions: async () => null,
            annotationStorage: { setValue() {} },
            getPage: async n => {
              const source = pdf.getPage(n - 1);
              return {
                rotate: source.getRotation().angle,
                getViewport({ scale, rotation }) {
                  const { width, height } = source.getSize();
                  return {
                    scale, rotation, userUnit: 1, viewBox: [0, 0, width, height],
                    width: (rotation % 180 ? height : width) * scale,
                    height: (rotation % 180 ? width : height) * scale,
                    transform: [scale, 0, 0, -scale, 0, height * scale],
                    convertToViewportPoint: (x, y) => [x * scale, (height - y) * scale],
                    convertToPdfPoint: (x, y) => [x / scale, height - y / scale],
                  };
                },
                render: () => ({ promise: Promise.resolve(), cancel() {} }),
              };
            },
          })),
        };
      },
    },
  };
  const errors = [];
  const context = vm.createContext({
    document, window, Blob, ArrayBuffer, structuredClone, TextEncoder, TextDecoder, Uint8Array, testLibraries,
    setTimeout, clearTimeout, requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    performance, crypto, getComputedStyle: () => ({ paddingLeft: "0", paddingRight: "0", paddingTop: "0", paddingBottom: "0" }),
    console: { warn: (...messages) => errors.push(messages.at(-1)), error: error => errors.push(error) },
    URL: { createObjectURL(blob) { const url = "blob:test-" + ++urlSequence; blobs.set(url, blob); return url; },
      revokeObjectURL: url => blobs.delete(url) },
    ResizeObserver: class { observe() {} },
    IntersectionObserver: class {
      constructor(callback) { observer = callback; }
      observe(node) { observed.add(node); }
      unobserve(node) { observed.delete(node); }
    },
  });
  const vendorSource = readFileSync(new URL("../../src/vendor/cantoo-pdf-lib/pdf-lib.min.js", import.meta.url), "utf8");
  vm.runInContext("var exports = {}; var module = { exports };\n" + vendorSource + "\ntestLibraries.pdfLib = module.exports;", context);
  const moduleStart = startScript + '<script type="module">'.length;
  const source = html.slice(moduleStart, html.indexOf("</script>", moduleStart))
    .replace("async function loadLibraries() {", "async function loadLibraries() { return testLibraries; }\nasync function loadLibrariesForBrowser() {");
  vm.runInContext(source, context);
  function updateVisibility(nodes) {
    const visible = new Set(nodes);
    observer([...observed].map(target => ({ target, isIntersecting: visible.has(target) })));
  }
  return { controls, document, tools, downloads, blobs, errors, updateVisibility, storedSettings };
}

async function until(check) {
  for (let turn = 0; turn < 100; turn++) {
    if (check()) return;
    await nextTurn();
  }
  assert(check(), "エディターの更新が完了しませんでした");
}

async function exerciseEditor(html, input) {
  const browser = createBrowserHarness(html);
  const { controls, downloads, errors } = browser;
  // 画面ID変更前の配布版も比較対象にできる。
  const previousIds = {
    "add-files": "add",
    "file-input": "files",
    "export-menu-toggle": "download-menu",
    "move-pages-earlier": "back",
    "rotate-pages-right": "right",
  };
  const node = id => controls.get(id) ?? controls.get(previousIds[id]);
  const cards = () => node("page-grid").children;
  const picked = () => cards().flatMap(card => card.children[1].checked ? [card.dataset.id] : []);
  const image = card => card.children[0].children[1].firstElementChild;
  const click = id => node(id).click();
  await until(() => !node("add-files").disabled || errors.length > 0);
  assert.deepEqual(errors, []);
  const boot = { label: node("preview-tools-toggle").getAttribute("aria-expanded"), exportDisabled: node("export-menu-toggle").disabled };
  node("file-input").files = [input];
  await node("file-input").dispatch("change");
  await until(() => cards().length === 4 || errors.length > 0);
  assert.equal(cards().length, 4, errors.map(e => e?.stack || String(e)).join("\n"));
  if (node("page-grid").tagName === "OL") assert(cards().every(card => card.tagName === "LI"));
  assert.deepEqual(errors, []);
  await until(() => !node("preview-sheet").hidden && node("preview-base").children.length === 1);
  const originalCards = [...cards()];
  browser.updateVisibility([originalCards[0]]);
  await until(() => image(originalCards[0])?.tagName === "IMG");
  const thumbnail = image(originalCards[0]).src;
  node("thumbnail-size").value = "small";
  await node("thumbnail-size").dispatch("change");
  assert.equal(image(originalCards[0]).src, thumbnail);
  browser.updateVisibility([]);
  browser.updateVisibility([originalCards[0]]);
  assert.equal(image(originalCards[0]).src, thumbnail);

  // 見開きの選択からページ移動と回転、その履歴をたどる。
  node("preview-layout").value = "spread";
  await node("preview-layout").dispatch("change");
  await click("preview-next");
  await until(() => node("preview-companions").children.length === 1 || errors.length > 0);
  assert.deepEqual(errors, []);
  const spreadPicked = picked();
  node("preview-layout").value = "single";
  await node("preview-layout").dispatch("change");
  await originalCards[1].children[0].click();
  await click("move-pages-earlier");
  await click("rotate-pages-right");
  await click("undo");
  await click("redo");
  await until(() => node("preview-meta").textContent.includes("回転 +90°"));
  await click("preview-tools-toggle");
  await browser.tools.find(button => button.dataset.tool === "rect").click();
  const overlay = node("preview-overlay");
  const pointer = { button: 0, pointerId: 1, pointerType: "mouse" };
  await overlay.dispatch("pointerdown", { ...pointer, clientX: 90, clientY: 100 });
  await overlay.dispatch("pointermove", { ...pointer, clientX: 175, clientY: 150 });
  await overlay.dispatch("pointerup", { ...pointer, clientX: 175, clientY: 150 });
  await click("mark-copy");
  await click("mark-paste");
  assert.match(node("preview-meta").textContent, /書き込み 2件/);
  await click("preview-tools-toggle");
  let selectAllPrevented = false;
  await browser.document.dispatch("keydown", { key: "a", ctrlKey: true, target: overlay,
    preventDefault() { selectAllPrevented = true; } });
  assert(selectAllPrevented);
  const status = node("preview-meta").textContent;

  await click("export-menu-toggle");
  node("output-name").value = "comparison";
  await node("export-form").dispatch("submit");
  await click("export-menu-toggle");
  await node("export-form").dispatch("submit");
  assert.equal(downloads.length, 2, JSON.stringify(errors));
  assert.equal(downloads[0].blob, downloads[1].blob);
  const pdf = await pdfLib.PDFDocument.load(await downloads[0].blob.arrayBuffer());
  const pdfPages = pdf.getPages().map(page => [page.getWidth(), page.getHeight(), page.getRotation().angle]);
  const pdfMarks = pdf.getPage(0).node.Annots().asArray().map(ref => {
    const annotation = pdf.context.lookup(ref, pdfLib.PDFDict);
    return [annotation.get(pdfLib.PDFName.of("Subtype")).toString(),
      annotation.get(pdfLib.PDFName.of("Rect")).toString()];
  });
  const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=", "base64");
  node("file-input").files = [new File([pngBytes], "fixture.png", { type: "image/png" })];
  await node("file-input").dispatch("change");
  await until(() => cards().length === 5 || errors.length > 0);
  assert.equal(cards().length, 5);
  const imageSourceLabel = node("source-properties-label").textContent;
  await click("clear-document");
  assert.deepEqual(errors, []);
  return { boot, spreadPicked, status, pdfPages, pdfMarks, imageSourceLabel, name: downloads[0].name,
    cleared: cards().length === 0 && node("undo").disabled && browser.blobs.size === 0,
    storedSettings: [...browser.storedSettings] };
}

test("配布HTMLから読み込み・一覧・見開き・回転・履歴・再ダウンロード・クリアが一続きで動く", async () => {
  const inputPdf = await pdfLib.PDFDocument.create();
  for (const width of [300, 310, 320, 330]) inputPdf.addPage([width, 410]);
  const source = new File([await inputPdf.save()], "fixture.pdf", { type: "application/pdf" });
  const actual = await exerciseEditor(readFileSync(bundle, "utf8"), source);
  assert.deepEqual(actual.boot, { label: "false", exportDisabled: true });
  assert.deepEqual(actual.spreadPicked, ["1:1", "1:2"]);
  assert.deepEqual(actual.pdfPages, [[310, 410, 90], [300, 410, 0], [320, 410, 0], [330, 410, 0]]);
  assert.deepEqual(actual.pdfMarks.map(([kind]) => kind), ["/Square", "/Square"]);
  assert.notEqual(actual.pdfMarks[0][1], actual.pdfMarks[1][1]);
  assert.equal(actual.imageSourceLabel, "元ファイル情報");
  assert.equal(actual.name, "comparison.pdf");
  assert(actual.cleared);
  const baseline = process.env["PDF-EDITOR-BASELINE"];
  if (baseline) {
    const reference = await exerciseEditor(readFileSync(baseline, "utf8"), source);
    assert.deepEqual(actual, reference);
  }
});

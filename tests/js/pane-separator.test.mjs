import assert from "node:assert/strict";
import test from "node:test";
import { bindPaneSeparator } from "../../src/js/pane-separator.mjs";

function createSeparator(available = 1000) {
  const separator = new EventTarget();
  const attrs = new Map([["aria-valuenow", "50"]]);
  let captured, onResize, fraction;
  globalThis.ResizeObserver = class {
    constructor(callback) { onResize = callback; }
    observe() {}
  };
  Object.assign(separator, {
    offsetWidth: 14, setAttribute: (name, value) => attrs.set(name, value), focus() {},
    setPointerCapture: id => { captured = id; }, hasPointerCapture: id => id === captured,
  });
  bindPaneSeparator(separator, { getBoundingClientRect: () => ({ left: 0 }) },
    { getBoundingClientRect: () => ({ right: available + separator.offsetWidth }) },
    { style: { setProperty(name, value) { fraction = Number(value.match(/\* ([\d.]+)\)$/)[1]); } } });
  return {
    attrs,
    get pixels() { return fraction * available; },
    resize(nextWidth) { available = nextWidth; onResize(); },
    event(type, fields = {}) {
      separator.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), fields));
    },
  };
}

test("仕切りのドラッグ・キー操作・初期位置への復帰を、開き直しても復元する", () => {
  const store = new Map();
  globalThis.window = { localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) } };
  const pane = createSeparator();
  pane.event("pointerdown", { button: 0, pointerId: 7 });
  pane.event("pointermove", { pointerId: 7, clientX: 657 });
  pane.event("lostpointercapture", { pointerId: 7 });
  const reopened = createSeparator();
  assert.equal(reopened.attrs.get("aria-valuenow"), "65");
  reopened.event("keydown", { key: "ArrowRight" });
  assert.equal(createSeparator().attrs.get("aria-valuenow"), "68");
  reopened.event("dblclick");
  assert.equal(createSeparator().attrs.get("aria-valuenow"), "50");
});

test("最小幅を狭くしても操作に必要な幅を保ち、ウィンドウ幅を戻すと保存した割合に戻る", () => {
  const store = new Map();
  globalThis.window = { localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) } };
  const pane = createSeparator(1600);
  pane.event("keydown", { key: "Home" });
  assert.equal(pane.attrs.get("aria-valuemin"), "16");
  assert.equal(pane.attrs.get("aria-valuenow"), "16");
  assert.equal(pane.pixels, 258);
  assert.equal(createSeparator(1600).pixels, 258);

  pane.resize(800);
  assert.equal(pane.pixels, 258);
  assert.equal(pane.attrs.get("aria-valuemin"), "32");
  pane.resize(1600);
  assert.equal(pane.attrs.get("aria-valuenow"), "16");
  pane.resize(800);
  pane.event("keydown", { key: "ArrowRight" });
  assert.equal(pane.pixels, 282);
  pane.event("pointerdown", { button: 0, pointerId: 7 });
  pane.event("pointermove", { pointerId: 7, clientX: 90 });
  pane.event("lostpointercapture", { pointerId: 7 });
  assert.equal(createSeparator(800).pixels, 258);
});

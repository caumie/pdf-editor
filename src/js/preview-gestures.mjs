// 2本指操作はツールから独立させる。残った1本指を描画操作へ戻さず、全指が離れるまで扱う。
export function bindPreviewTouchGestures(stage, { canStart, start, move, end }) {
  const touches = new Map();
  let navigating = false;
  let suppressClick = false;

  function geometry() {
    const [a, b] = [...touches.values()];
    return { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2,
      distance: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)) };
  }
  function block(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function reset() {
    const ids = [...touches.keys()];
    touches.clear();
    const wasNavigating = navigating;
    navigating = false;
    for (const id of ids) {
      if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id);
    }
    if (wasNavigating) end();
  }
  stage.addEventListener("pointerdown", event => {
    if (event.pointerType !== "touch") {
      suppressClick = false;
      return;
    }
    if (!canStart()) return;
    if (!touches.size) suppressClick = false;
    touches.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    if (touches.size === 2) {
      navigating = true;
      suppressClick = true;
      start(geometry());
      for (const id of touches.keys()) stage.setPointerCapture(id);
    }
    if (navigating) {
      stage.setPointerCapture(event.pointerId);
      block(event);
    }
  }, { capture: true, passive: false });
  stage.addEventListener("pointermove", event => {
    if (!touches.has(event.pointerId)) return;
    touches.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    if (!navigating) return;
    block(event);
    if (!canStart()) { reset(); return; }
    if (touches.size >= 2) move(geometry());
  }, { capture: true, passive: false });
  function finish(event) {
    if (!touches.has(event.pointerId)) return;
    touches.delete(event.pointerId);
    if (!navigating) return;
    block(event);
    if (!touches.size) {
      navigating = false;
      end();
    } else if (touches.size >= 2) {
      // 3本目以降の指が入れ替わった場合も、現在の表示を新しい基準にする。
      start(geometry());
    }
  }
  stage.addEventListener("pointerup", finish, { capture: true });
  stage.addEventListener("pointercancel", finish, { capture: true });
  stage.addEventListener("lostpointercapture", event => {
    if (event.target === stage && navigating && touches.has(event.pointerId)) finish(event);
  }, { capture: true });
  for (const type of ["click", "dblclick"]) {
    stage.addEventListener(type, event => { if (suppressClick) block(event); }, { capture: true });
  }
  return { reset };
}

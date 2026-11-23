export function bindSettingsMenu(ui, closeDownloadMenu, onReset) {
  const trigger = ui["settings-menu-toggle"];
  const menu = ui["settings-menu"];
  const reset = ui["reset-settings"];

  function setOpen(open, restoreFocus = false) {
    menu.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    if (open) {
      closeDownloadMenu();
      reset.focus();
    } else if (restoreFocus) {
      trigger.focus();
    }
  }

  function closeOutside(event) {
    if (!menu.hidden && !ui["settings-actions"].contains(event.target)) setOpen(false);
  }

  trigger.addEventListener("click", () => setOpen(menu.hidden));
  reset.addEventListener("click", () => {
    setOpen(false, true);
    onReset();
  });
  document.addEventListener("pointerdown", closeOutside);
  document.addEventListener("focusin", closeOutside);
  document.addEventListener("keydown", event => {
    if (menu.hidden || event.defaultPrevented || event.key !== "Escape") return;
    event.preventDefault();
    setOpen(false, true);
  });
}

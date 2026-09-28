import { el, fill } from "./dom.ts";

/** Native modal focus trapping, Escape dismissal, and return to the opener. */
export function createOverlay(label: string, className: string, onClose?: () => void) {
  const dialog = el("dialog", `pgc-overlay ${className}`);
  dialog.setAttribute("aria-label", label);
  const title = el("h2", "pgc-overlay-title", label);
  const close = el("button", "btn btn-ghost pgc-overlay-close", "Close");
  close.type = "button";
  close.autofocus = true;
  close.addEventListener("click", () => dialog.close());
  const body = el("div", "pgc-overlay-body");
  fill(dialog, fill(el("div", "pgc-overlay-head"), title, close), body);
  dialog.addEventListener("click", event => {
    if (event.target !== dialog || close.hidden) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener("close", () => onClose?.());
  document.body.appendChild(dialog);
  return { dialog, body, title, close, open: () => { if (!dialog.open) dialog.showModal(); } };
}

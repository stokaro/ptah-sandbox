/*
 * Links on the playground page.
 *
 * The workspace lives in this tab's memory, and following a link in the same
 * tab throws it away. So every link to another page opens a new tab. A link
 * that leaves the playground asks first, naming where it goes: to github.com,
 * and as much to ptah.run's other sites, the docs or the blog, which are
 * someone else's pages as far as this workspace is concerned. Nothing about a
 * link says where it leads until it has been followed.
 *
 * A click with a modifier or the middle button is left alone. Whoever made it
 * has already said where the page should open.
 */

import { el, fill } from "./panes/dom.ts";

/** What the leaving dialog calls this page. */
const NAME = "Playground";

/** A link that goes to another page: not an anchor here, not this page, not a download. */
function leavesPage(link: HTMLAnchorElement): boolean {
  const href = link.getAttribute("href") ?? "";
  if (href === "" || href.startsWith("#")) return false;
  if (link.hasAttribute("download") || link.getAttribute("aria-current") === "page") return false;
  return link.protocol === "http:" || link.protocol === "https:";
}

/** A link to the playground itself, wherever it is served from. */
function onPlayground(url: URL): boolean {
  return url.origin === window.location.origin;
}

/** Every link to another page opens a new tab, and gives it no handle back to this one. */
export function markLinks(root: ParentNode): void {
  for (const link of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (!leavesPage(link)) continue;
    link.target = "_blank";
    link.rel = "noopener";
  }
}

export function installLinks(): void {
  markLinks(document);

  const title = el("h2", "pg-leave-title", `Leave ${NAME}?`);
  title.id = "pg-leave-title";
  const where = el("p", "pg-leave-text");
  const address = el("p", "pg-leave-url");
  const stay = el("button", "btn btn-ghost", "Stay here");
  stay.type = "button";
  const go = el("button", "btn");
  go.type = "button";
  const dialog = fill(
    el("dialog", "pg-leave"),
    title,
    where,
    address,
    fill(el("div", "pg-leave-buttons"), stay, go),
  );
  dialog.setAttribute("aria-labelledby", "pg-leave-title");
  document.body.appendChild(dialog);

  let pending: URL | null = null;
  stay.addEventListener("click", () => dialog.close());
  go.addEventListener("click", () => {
    if (pending !== null) window.open(pending.href, "_blank", "noopener");
    dialog.close();
  });
  // A click on the backdrop is a click on the dialog itself.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!(link instanceof HTMLAnchorElement) || !leavesPage(link)) return;
    // Links drawn after markLinks ran are caught here, before they open.
    link.target = "_blank";
    link.rel = "noopener";
    const url = new URL(link.href);
    if (onPlayground(url)) return;

    event.preventDefault();
    pending = url;
    where.textContent =
      `This link goes to ${url.hostname}, outside ${NAME}. It opens in a new tab, `
      + `and ${NAME} in this one stays as it is.`;
    address.textContent = url.href;
    go.textContent = `Open ${url.hostname} ↗`;
    dialog.showModal();
    go.focus();
  });
}

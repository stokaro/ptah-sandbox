/*
 * Links on the playground page.
 *
 * The workspace lives in this tab's memory, and following a link in the same
 * tab throws it away. So every link to another page opens a new tab. A link
 * that leaves ptah.run -- the site menu and About carry github.com beside the
 * site's own pages -- asks first, naming where it goes: nothing about a link
 * says which of the two it is until it has been followed.
 *
 * A click with a modifier or the middle button is left alone. Whoever made it
 * has already said where the page should open.
 */

import { el, fill } from "./panes/dom.ts";

/** The site this page belongs to. Its subdomains are the same site. */
const SITE = "ptah.run";

/** A link that goes to another page: not an anchor here, not this page, not a download. */
function leavesPage(link: HTMLAnchorElement): boolean {
  const href = link.getAttribute("href") ?? "";
  if (href === "" || href.startsWith("#")) return false;
  if (link.hasAttribute("download") || link.getAttribute("aria-current") === "page") return false;
  return link.protocol === "http:" || link.protocol === "https:";
}

function onSite(url: URL): boolean {
  return url.origin === window.location.origin || url.hostname === SITE || url.hostname.endsWith(`.${SITE}`);
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

  const title = el("h2", "pg-leave-title", `Leave ${SITE}?`);
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
    if (onSite(url)) return;

    event.preventDefault();
    pending = url;
    where.textContent =
      `This link goes to ${url.hostname}, outside ${SITE}. It opens in a new tab, `
      + "and the playground in this one stays as it is.";
    address.textContent = url.href;
    go.textContent = `Open ${url.hostname} ↗`;
    dialog.showModal();
    go.focus();
  });
}

/*
 * The site menu in the toolbar.
 *
 * Above 1100px the playground takes the whole window and the site header is
 * not drawn (see "Full window" in playground.css). Its links are still one
 * click away: the Ptah mark at the left of the toolbar opens them in a
 * popover. They are copied out of the header rather than written a second
 * time, so a page added to the header's navigation reaches this menu too, and
 * the header stays what the narrower layouts and a page without its script
 * show.
 */

import { anchorPopover } from "./popover.ts";

export function installSiteMenu(control: HTMLElement, menu: HTMLElement): void {
  const list = document.createElement("ul");

  const brand = document.querySelector<HTMLAnchorElement>(".site-header .brand");
  if (brand !== null) {
    const home = document.createElement("a");
    home.className = "pg-sitemenu-home";
    home.href = brand.href;
    const logo = brand.querySelector("img")?.cloneNode(true);
    if (logo) home.appendChild(logo);
    home.appendChild(document.createTextNode("Ptah"));
    const item = document.createElement("li");
    item.appendChild(home);
    list.appendChild(item);
  }

  for (const link of document.querySelectorAll<HTMLAnchorElement>(".site-header .nav-links a")) {
    const copy = document.createElement("a");
    copy.href = link.getAttribute("href") ?? link.href;
    copy.textContent = link.textContent;
    const current = link.getAttribute("aria-current");
    if (current !== null) copy.setAttribute("aria-current", current);
    const item = document.createElement("li");
    item.appendChild(copy);
    list.appendChild(item);
  }

  menu.appendChild(list);
  anchorPopover(menu, control);

  // Opening by keyboard or pointer puts focus on the page this is, so Tab
  // walks on from where the reader is; Escape hands it back to the control.
  menu.addEventListener("toggle", (event) => {
    if (event.newState !== "open") return;
    const here = menu.querySelector<HTMLAnchorElement>('a[aria-current="page"]') ?? menu.querySelector("a");
    here?.focus();
  });
}

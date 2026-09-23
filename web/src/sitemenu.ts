/*
 * The site menu in the toolbar.
 *
 * Above 900px the playground takes the whole window and the site header is
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
    // Not the page this menu is on: a link from the playground to itself goes
    // nowhere. The header keeps it, where it marks the section you are in.
    if (link.getAttribute("aria-current") === "page") continue;
    const copy = document.createElement("a");
    copy.href = link.getAttribute("href") ?? link.href;
    copy.textContent = link.textContent;
    const item = document.createElement("li");
    item.appendChild(copy);
    list.appendChild(item);
  }

  menu.appendChild(list);
  anchorPopover(menu, control);

  // Opening puts focus on the first link, so Tab walks on down the list;
  // Escape hands it back to the control.
  menu.addEventListener("toggle", (event) => {
    if (event.newState !== "open") return;
    menu.querySelector<HTMLAnchorElement>("a")?.focus();
  });
}

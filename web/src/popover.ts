/*
 * Placing a popover under the control that opens it.
 *
 * The page's popovers -- the step strip's hint, the site menu -- use the
 * Popover API, which gives them the top layer, light dismiss and Escape for
 * nothing. What it does not give is a position: a popover sits in the middle
 * of the window unless something places it. This places one under its
 * control, kept inside the window, and keeps the control's aria-expanded in
 * step. The full-window layout does not scroll; where the page does, a scroll
 * or a resize closes the popover rather than leaving it at the old position.
 *
 * The popover's stylesheet sets `inset: auto; margin: 0`, so the top and left
 * written here are the only position it has.
 */

const EDGE = 16;
const GAP = 8;

export function anchorPopover(popover: HTMLElement, control: HTMLElement): void {
  const close = (): void => {
    if (popover.matches(":popover-open")) popover.hidePopover();
  };

  popover.addEventListener("beforetoggle", (event) => {
    const opening = event.newState === "open";
    control.setAttribute("aria-expanded", String(opening));
    if (!opening) {
      window.removeEventListener("scroll", close);
      window.removeEventListener("resize", close);
      return;
    }
    const box = control.getBoundingClientRect();
    popover.style.top = `${Math.round(box.bottom + GAP)}px`;
    popover.style.left = `${Math.round(box.left)}px`;
    window.addEventListener("scroll", close, { once: true });
    window.addEventListener("resize", close, { once: true });
  });

  // The width is known only once the popover is drawn, so the right edge is
  // corrected after it opens rather than guessed before.
  popover.addEventListener("toggle", (event) => {
    if (event.newState !== "open") return;
    const overflow = popover.getBoundingClientRect().right - (window.innerWidth - EDGE);
    if (overflow > 0) {
      popover.style.left = `${Math.max(EDGE, Math.round(control.getBoundingClientRect().left - overflow))}px`;
    }
  });
}

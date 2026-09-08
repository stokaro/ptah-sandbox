/**
 * The DOM helpers the editor and the panes share.
 *
 * Two rules live here, and they are the reason this file exists rather than
 * each pane rolling its own markup.
 *
 * Everything that came out of SQLite or off the filesystem reaches the page
 * as a text node. A table called `<img onerror=alert(1)>` is a legal SQLite
 * identifier and it must appear on screen as those characters. No pane may
 * assign `innerHTML` from data; the only `innerHTML` in this component is a
 * literal skeleton with no interpolation.
 *
 * And every pane has the same four states -- empty, loading, error, ready --
 * so the placeholder markup is written once and an error is guaranteed to
 * stay on screen until something replaces it.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Appends children and returns the parent, so a tree reads as one expression. */
export function fill<T extends Element>(parent: T, ...children: (Node | null | undefined)[]): T {
  for (const child of children) if (child) parent.appendChild(child);
  return parent;
}

/**
 * A small trailing marker: `PK`, `added`, `not in schema.sql`.
 *
 * `tone` is deliberately a closed set. Amber is the only attention colour on
 * this page and it is reserved for something the visitor has to act on or
 * read, so a marker that is merely informational must not reach for it.
 */
export function marker(text: string, tone: "mute" | "amber" = "mute"): HTMLSpanElement {
  return el("span", tone === "amber" ? "pgc-mark pgc-mark-amber" : "pgc-mark", text);
}

/** The states a pane can be in other than having something to draw. */
export type PaneStatus =
  | { kind: "empty"; note: string }
  | { kind: "loading"; note: string }
  | { kind: "error"; message: string; note?: string };

/**
 * Draws a status into a pane body, replacing whatever was there.
 *
 * The error branch prints the message verbatim. A pane that failed says what
 * failed and keeps saying it; it does not fall back to a blank body that
 * reads as "nothing here", which would be a quieter kind of lie.
 */
export function renderStatus(host: HTMLElement, status: PaneStatus): void {
  clear(host);
  if (status.kind === "error") {
    const box = el("div", "pgc-pane-status pgc-pane-status-error");
    box.appendChild(el("p", "pgc-pane-status-head", "△ This pane could not be filled."));
    box.appendChild(el("pre", "pgc-pane-status-detail", status.message));
    if (status.note) box.appendChild(el("p", "pgc-pane-status-note", status.note));
    host.appendChild(box);
    return;
  }
  const box = el("div", "pgc-pane-status");
  if (status.kind === "loading") box.appendChild(el("span", "pgc-pane-spin"));
  box.appendChild(el("p", "pgc-pane-status-note", status.note));
  host.appendChild(box);
}

/** A table header cell. Split out because every pane builds the same one. */
export function th(text: string): HTMLTableCellElement {
  return el("th", "pgc-th", text);
}

export function td(text: string, className = ""): HTMLTableCellElement {
  return el("td", className ? `pgc-td ${className}` : "pgc-td", text);
}

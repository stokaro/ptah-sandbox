/*
 * Lines removed and added, drawn the way a unified diff prints them.
 *
 * The step strip shows a patch this way before it applies, and the editor
 * shows a changed run this way when its gutter mark is clicked. One renderer,
 * one set of classes in panes.css, so the two cannot drift into two looks for
 * the same thing.
 */

import type { DiffOp } from "./linediff.ts";
import { el } from "./panes/dom.ts";

/** Each part is one run of operations; parts are separated by a gap line. */
export function diffView(parts: readonly (readonly DiffOp[])[]): HTMLElement {
  const pre = el("pre", "pgc-diff");
  parts.forEach((ops, index) => {
    if (index > 0) pre.appendChild(el("span", "pgc-diff-gap", "⋯"));
    for (const op of ops) {
      const sign = op.op === "add" ? "+" : op.op === "del" ? "-" : " ";
      pre.appendChild(el("span", `pgc-diff-${op.op}`, `${sign} ${op.text}`));
    }
  });
  return pre;
}

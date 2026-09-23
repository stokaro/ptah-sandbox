/*
 * Two texts compared line by line, the way a version-control gutter does it.
 *
 * The editor marks what schema.sql says now against what the workspace was
 * seeded with: a line that is new, a line that was there and changed, and the
 * place where lines were removed. The step strip shows a patch the same way
 * before it is applied. Both read this one comparison, so the preview and the
 * marks it produces cannot disagree about what changed.
 *
 * The comparison is a longest common subsequence, not line against line: a
 * line-by-line comparison would mark everything below an inserted line, which
 * is exactly the case this exists to show -- one column added in the middle of
 * a CREATE TABLE. The table is O(n*m). Schema files are small, and above
 * LINE_LIMIT the answer is "no marks" rather than a frozen tab.
 */

/** Above this many lines on either side, nothing is compared. */
export const LINE_LIMIT = 1500;

export type DiffOp =
  | { op: "same"; text: string }
  | { op: "del"; text: string }
  | { op: "add"; text: string };

/**
 * The edit script from `before` to `after`, in order. Within a changed run
 * the removed lines come before the added ones, as in a unified diff.
 */
export function diffLines(before: readonly string[], after: readonly string[]): DiffOp[] {
  const n = before.length;
  const m = after.length;
  // lcs[i][j] = length of the LCS of before[i..] and after[j..].
  const width = m + 1;
  const lcs = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        before[i] === after[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ op: "same", text: after[j]! });
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      ops.push({ op: "del", text: before[i]! });
      i += 1;
    } else {
      ops.push({ op: "add", text: after[j]! });
      j += 1;
    }
  }
  for (; i < n; i++) ops.push({ op: "del", text: before[i]! });
  for (; j < m; j++) ops.push({ op: "add", text: after[j]! });
  return ops;
}

export type LineChange = "added" | "modified";

export interface LineMarks {
  /** Lines of the current text that differ from the baseline, by index. */
  changed: Map<number, LineChange>;
  /**
   * Where lines of the baseline were removed and nothing took their place:
   * the index of the current line they were above. It can equal the number of
   * lines, which means they were removed from the end.
   */
  removedAbove: Set<number>;
}

/**
 * A text's lines as a version-control tool counts them.
 *
 * A final newline ends the last line rather than starting an empty one:
 * counting that empty tail as a line made adding a block at the end of the
 * file mark the blank line after it instead of the blank line before it. An
 * empty text has no lines at all, so everything written into it is added.
 */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * How each line of `current` differs from `baseline`.
 *
 * In a changed run, as many added lines as there were removed ones count as
 * modified and the rest as added, so one comma added to a line and one line
 * inserted after it come out as one modified line and one new one. A run that
 * only removes lines leaves no line to mark, so it is recorded as a place.
 */
export function lineMarks(baseline: readonly string[], current: readonly string[]): LineMarks {
  const marks: LineMarks = { changed: new Map(), removedAbove: new Set() };
  if (baseline.length > LINE_LIMIT || current.length > LINE_LIMIT) return marks;

  let line = 0;
  let removed = 0;
  let added: number[] = [];
  const close = (): void => {
    added.forEach((index, k) => marks.changed.set(index, k < removed ? "modified" : "added"));
    if (added.length === 0 && removed > 0) marks.removedAbove.add(line);
    removed = 0;
    added = [];
  };

  for (const op of diffLines(baseline, current)) {
    if (op.op === "same") {
      close();
      line += 1;
    } else if (op.op === "del") {
      removed += 1;
    } else {
      added.push(line);
      line += 1;
    }
  }
  close();
  return marks;
}

import { splitLines, type Hunk } from './diff';

/**
 * Rows for the diff view: hunks flattened into what the split layout renders.
 *
 * `diffText(base, current)` answers in *before*-space — `Hunk.fromLine` is a
 * 0-based index into the base — but the view shows both sides with their own
 * real line numbers. As in `git-gutter.ts`, the translation is one running
 * number: every hunk shifts the text after it by `added − removed`, so a
 * line's after-side number is its before-side index plus the cumulative
 * offset of the hunks already passed. `splitLines`' terminator-carrying
 * invariant makes index = line − 1 on both sides; the terminator itself is
 * stripped for display, and a final line without one passes through as-is.
 *
 * Within a hunk, change rows pair `removed[i]` beside `added[i]` and the
 * longer side's tail faces `null` — the shape every split view uses. Around
 * each hunk, up to `context` unchanged lines show on both sides; anything
 * longer — the file's head and tail included — collapses to one `fold` row
 * carrying the hidden count. Hunks whose context windows touch or overlap
 * share their gap's lines, shown once, with nothing folded.
 *
 * Two decisions the numbers force:
 *
 * - **Folds only hide 2+ lines.** A one-line fold costs the row it saves and
 *   reads worse than the line, so a gap that context misses by exactly one
 *   line shows that line as context instead. The whole-file fold below is
 *   the one exemption: with no hunk to attach to, even a single line folds.
 * - **`context` is clamped to ≥ 1** (0 is not offered — spec §4). The inline
 *   layout leans on the invariant that change rows from different hunks are
 *   always separated by at least one context or fold row; `diffText` hunks
 *   are separated by ≥ 1 equal line, and context ≥ 1 keeps it visible.
 *
 * With no hunks at all the file is unchanged: one fold row carrying the full
 * `splitLines` count for a non-empty file, no rows for an empty one. That
 * holds even at `context: Infinity` — an unchanged file has nothing to
 * expand into, and the component shows its "no changes" empty state before
 * rows are ever rendered.
 *
 * Hunks must be what `diffText` emits: ordered, coalesced, in before-space.
 * Pure; the component renders and never diffs. See
 * `docs/superpowers/specs/2026-08-19-git-diff-view-design.md` §4.
 *
 * Mutation-checked: dropping the running offset from the after-side change
 * numbers fails the far-apart-hunks and Infinity tests; clamping the two
 * context windows instead of merging them (duplicating the shared lines)
 * fails the overlap-merge, one-line-over, and Infinity tests.
 */

/** One side of a row: a 1-based line number in its own text, terminator stripped. */
export interface SideCell {
  line: number;
  text: string;
}

export type DiffViewRow =
  | { kind: 'context'; before: SideCell; after: SideCell }
  | { kind: 'change'; before: SideCell | null; after: SideCell | null }
  | { kind: 'fold'; count: number };

const strip = (line: string): string => (line.endsWith('\n') ? line.slice(0, -1) : line);

/** Flatten hunks into renderable rows. `context` defaults to 3; `Infinity` folds nothing. */
export function diffViewRows(
  base: string,
  current: string,
  hunks: readonly Hunk[],
  context = 3,
): DiffViewRow[] {
  if (hunks.length === 0) {
    return base.length === 0 ? [] : [{ kind: 'fold', count: splitLines(base).length }];
  }

  const ctx = Math.max(1, context);
  const before = splitLines(base);
  const after = splitLines(current);

  const rows: DiffViewRow[] = [];
  let offset = 0; // after-index − before-index for the equal lines of the current gap

  /** Emit before-space indices [from, to) as context rows, numbered on both sides. */
  const emitContext = (from: number, to: number): void => {
    for (let i = from; i < to; i++) {
      rows.push({
        kind: 'context',
        before: { line: i + 1, text: strip(before[i] ?? '') },
        after: { line: i + offset + 1, text: strip(after[i + offset] ?? '') },
      });
    }
  };

  /**
   * Emit the equal gap [from, to), keeping `leading` lines at its start (the
   * previous hunk's trailing context) and `trailing` at its end (the next
   * hunk's leading context). A remainder of 0 has already merged; a remainder
   * of 1 is shown rather than folded (the ≥ 2 rule above).
   */
  const emitGap = (from: number, to: number, leading: number, trailing: number): void => {
    const hidden = to - from - leading - trailing;
    if (hidden < 2) {
      emitContext(from, to);
      return;
    }
    emitContext(from, from + leading);
    rows.push({ kind: 'fold', count: hidden });
    emitContext(to - trailing, to);
  };

  let cursor = 0; // before-space index of the first equal line not yet emitted
  for (const [index, hunk] of hunks.entries()) {
    // The file's head has no earlier hunk asking for trailing context.
    emitGap(cursor, hunk.fromLine, index === 0 ? 0 : ctx, ctx);

    const pairs = Math.max(hunk.removed.length, hunk.added.length);
    for (let i = 0; i < pairs; i++) {
      rows.push({
        kind: 'change',
        before:
          i < hunk.removed.length
            ? { line: hunk.fromLine + i + 1, text: strip(hunk.removed[i]!) }
            : null,
        after:
          i < hunk.added.length
            ? { line: hunk.fromLine + offset + i + 1, text: strip(hunk.added[i]!) }
            : null,
      });
    }

    offset += hunk.added.length - hunk.removed.length;
    cursor = hunk.fromLine + hunk.removed.length;
  }

  // The tail mirrors the head: no later hunk, so no trailing context to keep.
  emitGap(cursor, before.length, ctx, 0);

  return rows;
}

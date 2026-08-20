import { describe, expect, it } from 'vitest';
import { diffText, splitLines } from '../src/core/diff';
import { diffViewRows, type DiffViewRow, type SideCell } from '../src/core/diff-view';

/**
 * Every fixture goes through the real differ: the hunks `diffViewRows` sees in
 * production come from `diffText`, so that is what the tests feed it.
 * Hand-built hunks would let the tests pass against shapes the differ never
 * emits.
 */
const rowsOf = (base: string, current: string, context?: number): DiffViewRow[] =>
  diffViewRows(base, current, diffText(base, current), context);

/** `n` lines named l1..ln, as an array — mutate, then `doc` it. */
const lines = (n: number): string[] => Array.from({ length: n }, (_, i) => `l${i + 1}`);
/** Join with terminators, trailing newline included — the common file shape. */
const doc = (ls: readonly string[]): string => ls.join('\n') + '\n';

const cell = (line: number, text: string): SideCell => ({ line, text });
const ctx = (before: number, after: number, text: string): DiffViewRow => ({
  kind: 'context',
  before: cell(before, text),
  after: cell(after, text),
});
const chg = (before: SideCell | null, after: SideCell | null): DiffViewRow => ({
  kind: 'change',
  before,
  after,
});
const fold = (count: number): DiffViewRow => ({ kind: 'fold', count });

/** Maximal runs of consecutive change rows. One run must be one hunk. */
const changeRuns = (rows: readonly DiffViewRow[]): number =>
  rows.reduce(
    (runs, row, i) => runs + (row.kind === 'change' && rows[i - 1]?.kind !== 'change' ? 1 : 0),
    0,
  );

// ---------------------------------------------------------------------------
// Fixtures, named so the invariant sweep at the bottom can walk all of them.
// ---------------------------------------------------------------------------

const single = {
  base: doc(lines(12)),
  current: doc(lines(12).map((l) => (l === 'l6' ? 'X6' : l))),
};

const longerRemoved = { base: 'a\nb\nc\nd\ne\nf\n', current: 'a\nb\nZ\nf\n' };
const longerAdded = { base: 'a\nb\nq\nc\n', current: 'a\nb\nX\nY\nZ\nc\n' };

const farApart = (() => {
  const current = lines(20);
  current.splice(2, 0, 'NEW'); // insert between l2 and l3 — hunk 1 shifts everything after it by +1
  current[current.indexOf('l15')] = 'X15';
  return { base: doc(lines(20)), current: doc(current) };
})();

const nearMiss = {
  // Hunks at l3 and l8: a 4-line gap, inside 2·3 — the context windows overlap.
  base: doc(lines(10)),
  current: doc(lines(10).map((l) => (l === 'l3' ? 'X3' : l === 'l8' ? 'X8' : l))),
};

const oneOver = {
  // Hunks at l3 and l11: a 7-line gap, exactly 2·3 + 1 — one line too many.
  base: doc(lines(14)),
  current: doc(lines(14).map((l) => (l === 'l3' ? 'X3' : l === 'l11' ? 'X11' : l))),
};

const atLineOne = {
  base: doc(lines(6)),
  current: doc(lines(6).map((l) => (l === 'l1' ? 'X1' : l))),
};

const atEof = { base: 'a\nb\nc', current: 'a\nb\nC' }; // no trailing terminator
const wholeFile = { base: 'a\nb', current: 'x\ny\nz' }; // nothing in common

const FIXTURES: { name: string; base: string; current: string; context?: number }[] = [
  { name: 'single', ...single },
  { name: 'longerRemoved', ...longerRemoved },
  { name: 'longerAdded', ...longerAdded },
  { name: 'farApart', ...farApart },
  { name: 'nearMiss', ...nearMiss },
  { name: 'oneOver', ...oneOver },
  { name: 'atLineOne', ...atLineOne },
  { name: 'atEof', ...atEof },
  { name: 'wholeFile', ...wholeFile },
  { name: 'farApart @ context 1', ...farApart, context: 1 },
  { name: 'farApart @ Infinity', ...farApart, context: Infinity },
  { name: 'nearMiss @ context 1', ...nearMiss, context: 1 },
];

describe('diffViewRows', () => {
  it('pairs a modified line and shows 3 context lines either side, folding head and tail', () => {
    expect(rowsOf(single.base, single.current)).toEqual([
      fold(2), // l1, l2
      ctx(3, 3, 'l3'),
      ctx(4, 4, 'l4'),
      ctx(5, 5, 'l5'),
      chg(cell(6, 'l6'), cell(6, 'X6')),
      ctx(7, 7, 'l7'),
      ctx(8, 8, 'l8'),
      ctx(9, 9, 'l9'),
      fold(4), // l10, l11, l12, and the empty line after the final terminator
    ]);
  });

  it('defaults context to 3', () => {
    expect(rowsOf(single.base, single.current)).toEqual(rowsOf(single.base, single.current, 3));
  });

  it('null-pads the after side when more was removed than added', () => {
    expect(rowsOf(longerRemoved.base, longerRemoved.current)).toEqual([
      ctx(1, 1, 'a'),
      ctx(2, 2, 'b'),
      chg(cell(3, 'c'), cell(3, 'Z')),
      chg(cell(4, 'd'), null),
      chg(cell(5, 'e'), null),
      ctx(6, 4, 'f'),
      ctx(7, 5, ''),
    ]);
  });

  it('null-pads the before side when more was added than removed', () => {
    expect(rowsOf(longerAdded.base, longerAdded.current)).toEqual([
      ctx(1, 1, 'a'),
      ctx(2, 2, 'b'),
      chg(cell(3, 'q'), cell(3, 'X')),
      chg(null, cell(4, 'Y')),
      chg(null, cell(5, 'Z')),
      ctx(4, 6, 'c'),
      ctx(5, 7, ''),
    ]);
  });

  it('folds the gap between far-apart hunks and shifts the second hunk by the first delta', () => {
    // The fixture must be what the test believes it is: an insertion, then an edit.
    const hunks = diffText(farApart.base, farApart.current);
    expect(hunks.map((h) => `${h.fromLine} -${h.removed.length} +${h.added.length}`)).toEqual([
      '2 -0 +1',
      '14 -1 +1',
    ]);

    expect(rowsOf(farApart.base, farApart.current)).toEqual([
      ctx(1, 1, 'l1'),
      ctx(2, 2, 'l2'),
      chg(null, cell(3, 'NEW')),
      ctx(3, 4, 'l3'), // after-side numbers carry the +1 from here on
      ctx(4, 5, 'l4'),
      ctx(5, 6, 'l5'),
      fold(6), // l6..l11
      ctx(12, 13, 'l12'),
      ctx(13, 14, 'l13'),
      ctx(14, 15, 'l14'),
      chg(cell(15, 'l15'), cell(16, 'X15')),
      ctx(16, 17, 'l16'),
      ctx(17, 18, 'l17'),
      ctx(18, 19, 'l18'),
      fold(3), // l19, l20, trailing empty line
    ]);
  });

  it('merges overlapping context windows: 4 lines apart at context 3, shown once, no fold', () => {
    expect(rowsOf(nearMiss.base, nearMiss.current)).toEqual([
      ctx(1, 1, 'l1'),
      ctx(2, 2, 'l2'),
      chg(cell(3, 'l3'), cell(3, 'X3')),
      ctx(4, 4, 'l4'),
      ctx(5, 5, 'l5'),
      ctx(6, 6, 'l6'),
      ctx(7, 7, 'l7'),
      chg(cell(8, 'l8'), cell(8, 'X8')),
      ctx(9, 9, 'l9'),
      ctx(10, 10, 'l10'),
      ctx(11, 11, ''),
    ]);
  });

  it('shows a single extra line as context rather than a one-line fold (gap of 2·context + 1)', () => {
    const rows = rowsOf(oneOver.base, oneOver.current);
    // Head gap 2 and tail gap 4 both hide one line at most, so nothing folds anywhere.
    expect(rows.filter((r) => r.kind === 'fold')).toEqual([]);
    // All 7 gap lines (l4..l10) sit between the two change rows.
    const first = rows.findIndex((r) => r.kind === 'change');
    const last = rows.length - 1 - [...rows].reverse().findIndex((r) => r.kind === 'change');
    expect(rows.slice(first + 1, last)).toEqual([
      ctx(4, 4, 'l4'),
      ctx(5, 5, 'l5'),
      ctx(6, 6, 'l6'),
      ctx(7, 7, 'l7'),
      ctx(8, 8, 'l8'),
      ctx(9, 9, 'l9'),
      ctx(10, 10, 'l10'),
    ]);
  });

  it('never folds at context Infinity and shows every line of both sides', () => {
    const rows = rowsOf(farApart.base, farApart.current, Infinity);
    expect(rows.filter((r) => r.kind === 'fold')).toEqual([]);
    // 21 before lines − 1 removed = 20 context rows, plus 2 change rows.
    expect(rows).toHaveLength(22);
    // Both sides are gapless, in order, from line 1 to their own last line.
    const beforeNumbers = rows.flatMap((r) =>
      r.kind !== 'fold' && r.before ? [r.before.line] : [],
    );
    const afterNumbers = rows.flatMap((r) => (r.kind !== 'fold' && r.after ? [r.after.line] : []));
    expect(beforeNumbers).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
    expect(afterNumbers).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));
  });

  it('handles a hunk at line 1: no head fold, no leading context', () => {
    expect(rowsOf(atLineOne.base, atLineOne.current)).toEqual([
      chg(cell(1, 'l1'), cell(1, 'X1')),
      ctx(2, 2, 'l2'),
      ctx(3, 3, 'l3'),
      ctx(4, 4, 'l4'),
      fold(3), // l5, l6, trailing empty line
    ]);
  });

  it('handles a hunk at EOF and displays a terminator-less final line as-is', () => {
    expect(rowsOf(atEof.base, atEof.current)).toEqual([
      ctx(1, 1, 'a'),
      ctx(2, 2, 'b'),
      chg(cell(3, 'c'), cell(3, 'C')),
    ]);
  });

  it('strips the terminator from every displayed line', () => {
    for (const row of rowsOf(single.base, single.current)) {
      if (row.kind === 'fold') continue;
      if (row.before) expect(row.before.text).not.toContain('\n');
      if (row.after) expect(row.after.text).not.toContain('\n');
    }
  });

  it('renders a whole-file change as change rows only', () => {
    expect(rowsOf(wholeFile.base, wholeFile.current)).toEqual([
      chg(cell(1, 'a'), cell(1, 'x')),
      chg(cell(2, 'b'), cell(2, 'y')),
      chg(null, cell(3, 'z')),
    ]);
  });

  it('collapses an unchanged file to one fold carrying the full line count', () => {
    expect(diffViewRows('a\nb\nc\n', 'a\nb\nc\n', [])).toEqual([fold(4)]);
    expect(splitLines('a\nb\nc\n')).toHaveLength(4); // the count the fold must match
    expect(diffViewRows('a', 'a', [])).toEqual([fold(1)]); // the whole-file fold is exempt from the >= 2 rule
  });

  it('returns nothing for an empty file', () => {
    expect(diffViewRows('', '', [])).toEqual([]);
  });

  it('clamps context below 1 up to 1, keeping the separation invariant alive', () => {
    expect(rowsOf(nearMiss.base, nearMiss.current, 0)).toEqual(
      rowsOf(nearMiss.base, nearMiss.current, 1),
    );
  });
});

describe('diffViewRows invariants', () => {
  it('keeps change rows from different hunks separated by a context or fold row', () => {
    for (const { name, base, current, context } of FIXTURES) {
      const hunks = diffText(base, current);
      const rows = diffViewRows(base, current, hunks, context);
      // One maximal run of change rows per hunk: no hunk split apart, and no
      // two hunks touching — which is exactly the separation invariant.
      expect(changeRuns(rows), name).toBe(hunks.length);
    }
  });

  it('never emits a fold hiding fewer than 2 lines when there are hunks', () => {
    for (const { name, base, current, context } of FIXTURES) {
      const rows = diffViewRows(base, current, diffText(base, current), context);
      for (const row of rows) {
        if (row.kind === 'fold') expect(row.count, name).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

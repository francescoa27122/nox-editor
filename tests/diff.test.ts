import { describe, expect, it } from 'vitest';
import { diffText, splitLines, type Hunk } from '../src/core/diff';

/** Compact form for readability: "start -removed +added". */
const shape = (hunks: Hunk[]) =>
  hunks.map((hunk) => `${hunk.fromLine} -${hunk.removed.length} +${hunk.added.length}`);

describe('splitLines', () => {
  it('keeps terminators so the text can be rebuilt exactly', () => {
    for (const text of ['', 'a', 'a\n', 'a\nb', 'a\nb\n', '\n', '\n\n']) {
      expect(splitLines(text).join('')).toBe(text);
    }
  });

  it('counts lines the way CodeMirror does', () => {
    // A line index here has to be a document line number minus one, or every
    // offset the review layer computes would be off by a newline.
    expect(splitLines('')).toHaveLength(1);
    expect(splitLines('a')).toHaveLength(1);
    expect(splitLines('a\n')).toHaveLength(2);
    expect(splitLines('a\nb')).toHaveLength(2);
    expect(splitLines('a\nb\n')).toHaveLength(3);
  });
});

describe('diffText', () => {
  it('finds nothing in identical text', () => {
    expect(diffText('a\nb\nc\n', 'a\nb\nc\n')).toEqual([]);
  });

  it('finds a single changed line', () => {
    const hunks = diffText('a\nb\nc\n', 'a\nB\nc\n');
    expect(hunks).toEqual([{ fromLine: 1, removed: ['b\n'], added: ['B\n'] }]);
  });

  it('finds a pure insertion', () => {
    const hunks = diffText('a\nc\n', 'a\nb\nc\n');
    expect(hunks).toEqual([{ fromLine: 1, removed: [], added: ['b\n'] }]);
  });

  it('finds a pure deletion', () => {
    const hunks = diffText('a\nb\nc\n', 'a\nc\n');
    expect(hunks).toEqual([{ fromLine: 1, removed: ['b\n'], added: [] }]);
  });

  it('keeps separate edits in separate hunks', () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after = 'A\nb\nc\nd\nE\n';
    expect(shape(diffText(before, after))).toEqual(['0 -1 +1', '4 -1 +1']);
  });

  it('groups adjacent changes into one hunk', () => {
    const before = 'a\nb\nc\nd\n';
    const after = 'a\nX\nY\nd\n';
    expect(shape(diffText(before, after))).toEqual(['1 -2 +2']);
  });

  it('handles an insertion at the very start', () => {
    expect(diffText('a\n', 'z\na\n')).toEqual([{ fromLine: 0, removed: [], added: ['z\n'] }]);
  });

  it('handles an append with no trailing newline before it', () => {
    // "a" and "a\n" are genuinely different files, and the diff says so
    // rather than quietly treating the newline as noise.
    expect(diffText('a', 'a\nb')).toEqual([
      { fromLine: 0, removed: ['a'], added: ['a\n', 'b'] },
    ]);
  });

  it('handles empty text on either side', () => {
    // The trailing empty line is common to both, so these come out as a plain
    // insertion and a plain deletion rather than a whole-file replacement.
    expect(diffText('', 'a\n')).toEqual([{ fromLine: 0, removed: [], added: ['a\n'] }]);
    expect(diffText('a\n', '')).toEqual([{ fromLine: 0, removed: ['a\n'], added: [] }]);
  });

  it('replaces wholesale when nothing is shared', () => {
    expect(shape(diffText('a\nb\n', 'x\ny\n'))).toEqual(['0 -2 +2']);
  });

  it('rebuilds the after-text by applying its own hunks', () => {
    const cases: [string, string][] = [
      ['a\nb\nc\n', 'a\nB\nc\n'],
      ['one\ntwo\nthree\nfour\n', 'one\nthree\nfour\nfive\n'],
      ['x\n', 'a\nb\nc\n'],
      ['a\nb\nc\nd\ne\nf\n', 'a\nc\nd\nX\ne\nf\ng\n'],
      ['same\n', 'same\n'],
      ['', ''],
    ];

    for (const [before, after] of cases) {
      const lines = splitLines(before);
      // Applied back to front so earlier indices stay valid.
      for (const hunk of [...diffText(before, after)].reverse()) {
        lines.splice(hunk.fromLine, hunk.removed.length, ...hunk.added);
      }
      expect(lines.join('')).toBe(after);
    }
  });

  it('stays quick on a large file with a small edit', () => {
    const before = Array.from({ length: 20_000 }, (_, i) => `line ${i}\n`).join('');
    const after = before.replace('line 12345\n', 'CHANGED\n');

    const started = Date.now();
    const hunks = diffText(before, after);
    // Trimming the common prefix and suffix is what keeps this from being
    // O(n²); without it this test is the one that would notice.
    expect(Date.now() - started).toBeLessThan(500);
    expect(shape(hunks)).toEqual(['12345 -1 +1']);
  });
});

/**
 * A4-003: `myers` used to keep every round's frontier with no limit on how
 * many rounds it would run, so a whole-file rewrite (D close to N+M) cost
 * O((N+M)·D) time and O(D·(N+M)) memory — 8,000 lines all different measured
 * at 1.6 s and 2 GB on this machine before this fix. `MAX_D` (`core/diff.ts`)
 * now stops the search and falls back to one replacement hunk past that
 * point, the same shape the empty-side shortcut already returns.
 */
describe('diffText past MAX_D, A4-003', () => {
  /** `lines` lines, none shared between `before` and `after`. */
  function allDifferent(lines: number): [string, string] {
    const before: string[] = [];
    const after: string[] = [];
    for (let i = 0; i < lines; i++) {
      before.push(`before line ${i}\n`);
      after.push(`after line ${i}\n`);
    }
    return [before.join(''), after.join('')];
  }

  it('completes the 8,000-all-different case quickly and in a bounded amount of memory', () => {
    const [before, after] = allDifferent(8_000);

    const started = performance.now();
    const hunks = diffText(before, after);
    const elapsed = performance.now() - started;
    const heapAfter = process.memoryUsage().arrayBuffers;

    // Measured well under 100 ms in isolation (60-85 ms, `core/diff.ts`'s own
    // comment). 500 ms, the same threshold `stays quick on a large file with
    // a small edit` above uses, is the CI-safe version of that: the pre-fix
    // code measured 1.6-1.7 s here, so a 500 ms bound still fails loudly on a
    // cap that stopped capping without this test flaking under a busy runner
    // the way a tighter bound measured against did.
    expect(elapsed, `took ${elapsed.toFixed(1)}ms`).toBeLessThan(500);
    // Loose on purpose, the way the other memory-shaped checks in this repo
    // are: the point is "bounded", not a specific byte count, and `v.slice()`
    // per round means this scales with MAX_D regardless of how the runtime's
    // allocator happens to lay things out. The unbounded version measured
    // ~2 GB here; 500 MB is generous headroom above the ~190 MB this fix
    // actually uses and still catches a cap that stopped capping.
    expect(heapAfter, `${(heapAfter / 1024 / 1024).toFixed(1)}MB in ArrayBuffers`).toBeLessThan(
      500 * 1024 * 1024,
    );
    // One replacement hunk, the same answer the empty-side shortcut gives:
    // past MAX_D nothing in the file is worth expressing as fine-grained
    // hunks.
    expect(shape(hunks)).toEqual(['0 -8000 +8000']);
  });

  /**
   * The output contract must not change for inputs under the cap — the
   * finding's own requirement. 500 changed lines keeps D well inside
   * `MAX_D` (1,000), so this is `myers` actually running, not the fallback
   * above, and it must still find the fine-grained hunks rather than one
   * wholesale replacement.
   */
  it('still finds fine-grained hunks for an edit distance under the cap', () => {
    const lines = Array.from({ length: 1_000 }, (_, i) => `line ${i}\n`);
    const before = lines.join('');
    const after = lines
      .map((line, i) => (i % 2 === 0 ? line : line.toUpperCase()))
      .join('');

    const hunks = diffText(before, after);
    // Every odd line changed, every even line did not: 500 separate
    // one-line hunks, not one hunk covering the whole file. A rewrite that
    // wrongly triggered the MAX_D fallback here would collapse this to one
    // ['0 -1000 +1000'] entry instead.
    expect(hunks).toHaveLength(500);
    expect(hunks.every((h) => h.removed.length === 1 && h.added.length === 1)).toBe(true);

    // Byte-identical to what applying the hunks produced before this fix:
    // rebuilding `after` from `before` plus the hunks still round-trips.
    const rebuilt = [...before.split(/(?<=\n)/)];
    for (const hunk of [...hunks].reverse()) {
      rebuilt.splice(hunk.fromLine, hunk.removed.length, ...hunk.added);
    }
    expect(rebuilt.join('')).toBe(after);
  });
});

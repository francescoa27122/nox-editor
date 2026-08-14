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

import { describe, expect, it } from 'vitest';
import { diffText, splitLines, type Hunk } from '../src/core/diff';
import { gutterLines, normalizeGitBase, type GutterLine } from '../src/core/git-gutter';

/**
 * Every fixture but one goes through the real differ: the hunks `gutterLines`
 * will see in production come from `diffText`, so that is what the tests feed
 * it. The single hand-built fixture is the collision case, and says so.
 */
const marks = (before: string, after: string): GutterLine[] => gutterLines(diffText(before, after));

describe('gutterLines', () => {
  it('finds nothing in identical text', () => {
    expect(marks('a\nb\nc\n', 'a\nb\nc\n')).toEqual([]);
    expect(gutterLines([])).toEqual([]);
  });

  it('marks a line edited in place as modified', () => {
    expect(marks('a\nb\nc\n', 'a\nX\nc\n')).toEqual([{ line: 2, kind: 'modified' }]);
  });

  it('marks a replacement of two lines by one as modified on the one', () => {
    expect(marks('a\nb\nc\nd\n', 'a\nX\nd\n')).toEqual([{ line: 2, kind: 'modified' }]);
  });

  it('marks an insertion at the top', () => {
    expect(marks('b\nc\n', 'a\nb\nc\n')).toEqual([{ line: 1, kind: 'added' }]);
  });

  it('marks an insertion in the middle', () => {
    expect(marks('a\nc\n', 'a\nb\nc\n')).toEqual([{ line: 2, kind: 'added' }]);
  });

  it('marks an insertion at EOF, one mark per inserted line', () => {
    expect(marks('a\n', 'a\nb\nc\n')).toEqual([
      { line: 2, kind: 'added' },
      { line: 3, kind: 'added' },
    ]);
  });

  it('shifts a later edit by the lines an earlier insertion added', () => {
    const before = 'a\nb\nc\nd\n';
    const after = 'x\na\nb\nC\nd\n';
    // Two hunks: the insertion of `x` at the top, the edit of `c`. Without the
    // cumulative offset the edit would be reported on line 3 — its before-space
    // position — instead of line 4, where `C` actually sits now.
    expect(splitLines(after)[3]).toBe('C\n');
    expect(marks(before, after)).toEqual([
      { line: 1, kind: 'added' },
      { line: 4, kind: 'modified' },
    ]);
  });

  it('shifts a later edit by the lines an earlier deletion removed', () => {
    const before = 'x\na\nb\nc\n';
    const after = 'a\nb\nC\n';
    expect(splitLines(after)[2]).toBe('C\n');
    expect(marks(before, after)).toEqual([
      { line: 1, kind: 'removed' },
      { line: 3, kind: 'modified' },
    ]);
  });

  it('marks a deletion at the top on line 1', () => {
    expect(marks('a\nb\n', 'b\n')).toEqual([{ line: 1, kind: 'removed' }]);
  });

  it('marks a deletion in the middle on the line now sitting there', () => {
    expect(marks('a\nb\nc\n', 'a\nc\n')).toEqual([{ line: 2, kind: 'removed' }]);
  });

  it('marks a deletion at EOF on the last line of the current text', () => {
    const after = 'a\nb\n';
    const hunks = diffText('a\nb\nc\nd\n', after);
    // The differ keeps the trailing empty line as common suffix, so the pure
    // deletion's current-space start lands exactly on the current text's last
    // (empty) document line — the mark never needs to point past the end.
    expect(hunks).toEqual([{ fromLine: 2, removed: ['c\n', 'd\n'], added: [] }]);
    const lastLine = splitLines(after).length;
    expect(gutterLines(hunks)).toEqual([{ line: lastLine, kind: 'removed' }]);
  });

  it('lets an existing mark win when a removal lands on a claimed line', () => {
    // The ONLY synthetic fixture in this file. `diffText` cannot produce this
    // shape: a delete touching an insert coalesces into one modified hunk, and
    // separate hunks always keep an unchanged line between them, so a real
    // removal mark always lands on a context line. The rule guards hunks that
    // arrive from elsewhere (or after being mapped through edits).
    const removalSecond: Hunk[] = [
      { fromLine: 0, removed: ['old\n'], added: ['new\n'] },
      { fromLine: 0, removed: ['gone\n'], added: [] },
    ];
    expect(gutterLines(removalSecond)).toEqual([{ line: 1, kind: 'modified' }]);

    // Same collision with the removal arriving first: the non-removed kind
    // still wins — the rule is about kinds, not arrival order.
    const removalFirst: Hunk[] = [
      { fromLine: 0, removed: ['gone\n'], added: [] },
      { fromLine: 1, removed: ['old\n'], added: ['new\n'] },
    ];
    expect(gutterLines(removalFirst)).toEqual([{ line: 1, kind: 'modified' }]);
  });

  it('returns marks sorted by line with at most one entry per line', () => {
    const result = marks('a\nb\nc\nd\ne\n', 'X\nb\nY\nd\nZ\n');
    expect(result).toEqual([
      { line: 1, kind: 'modified' },
      { line: 3, kind: 'modified' },
      { line: 5, kind: 'modified' },
    ]);
    const lines = result.map((mark) => mark.line);
    expect(lines).toEqual([...new Set(lines)].sort((a, b) => a - b));
  });
});

describe('normalizeGitBase', () => {
  it('strips a single leading BOM', () => {
    expect(normalizeGitBase('\uFEFFa\nb\n')).toBe('a\nb\n');
  });

  it('strips only the first of two leading BOMs', () => {
    expect(normalizeGitBase('\uFEFF\uFEFFa')).toBe('\uFEFFa');
  });

  it('turns CRLF into LF', () => {
    expect(normalizeGitBase('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('handles BOM and CRLF together', () => {
    expect(normalizeGitBase('\uFEFFa\r\nb')).toBe('a\nb');
  });

  it('leaves already-canonical text alone', () => {
    expect(normalizeGitBase('a\nb\n')).toBe('a\nb\n');
    expect(normalizeGitBase('')).toBe('');
  });

  it('leaves a lone carriage return alone', () => {
    expect(normalizeGitBase('a\rb\n')).toBe('a\rb\n');
  });

  it('makes a CRLF base diff clean against the LF document', () => {
    // The failure mode the function exists for: an unnormalized CRLF base
    // would mark every line of an otherwise-identical buffer as modified.
    expect(diffText(normalizeGitBase('a\r\nb\r\n'), 'a\nb\n')).toEqual([]);
  });
});

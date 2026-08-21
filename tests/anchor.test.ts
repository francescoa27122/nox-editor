import { describe, expect, it } from 'vitest';
import { resolveAnchorLine } from '../src/core/anchor';

/**
 * Where a note's anchor actually lands once the file has moved on.
 *
 * A pure function over text and a line number, so the case that matters —
 * code that has drifted since the anchor was made — is a string literal here
 * rather than a file someone has to edit to reproduce.
 */

const lines = (...rows: string[]) => rows.join('\n');

describe('resolving an anchor', () => {
  it('stays put when the line still holds the snippet', () => {
    const text = lines('one', 'two', 'three');

    expect(resolveAnchorLine(text, 2, 'two')).toBe(2);
  });

  /**
   * The failure this prevents: the whole reason a snippet is stored beside
   * the line. Inserting above an anchor is the single most common edit there
   * is, and a line number alone silently points at the wrong code afterwards
   * — worse than pointing nowhere, because it looks right.
   */
  it('follows code pushed down by an insertion above it', () => {
    const text = lines('added', 'added', 'one', 'two', 'three');

    expect(resolveAnchorLine(text, 2, 'two')).toBe(4);
  });

  it('follows code pulled up by a deletion above it', () => {
    const text = lines('two', 'three');

    expect(resolveAnchorLine(text, 4, 'two')).toBe(1);
  });

  it('ignores indentation changes, which reformatting makes constantly', () => {
    const text = lines('one', '        two', 'three');

    expect(resolveAnchorLine(text, 2, 'two')).toBe(2);
  });

  /**
   * `}` and `});` appear hundreds of times in a real file. Expanding outward
   * from the remembered line rather than scanning from the top is what stops
   * a jump landing on the first one in the document.
   */
  it('prefers the nearest match when the snippet is not unique', () => {
    const text = lines('}', 'a', '}', 'b', '}', 'c', '}');

    expect(resolveAnchorLine(text, 4, '}')).toBe(3);
    expect(resolveAnchorLine(text, 6, '}')).toBe(5);
  });

  /**
   * The failure this prevents: an anchor whose code is genuinely gone
   * jumping somewhere arbitrary. Falling back to the remembered line puts the
   * reader in the neighbourhood the note was about, which is the best that
   * can honestly be offered.
   */
  it('falls back to the remembered line when the snippet has gone', () => {
    const text = lines('one', 'two', 'three');

    expect(resolveAnchorLine(text, 2, 'deleted long ago')).toBe(2);
  });

  it('clamps a line past the end of a file that has shrunk', () => {
    const text = lines('one', 'two');

    expect(resolveAnchorLine(text, 99, 'gone')).toBe(2);
  });

  it('never returns less than the first line', () => {
    expect(resolveAnchorLine('one', 0, 'gone')).toBe(1);
    expect(resolveAnchorLine('one', -5, 'gone')).toBe(1);
  });

  it('treats an empty snippet as no help, not as a match on every blank line', () => {
    const text = lines('one', '', 'three');

    expect(resolveAnchorLine(text, 3, '')).toBe(3);
  });

  /**
   * A restructure that moved code hundreds of lines is not a drift, and a
   * far-away identical line is more likely a coincidence than the anchor's
   * subject. Past the window the remembered line is the safer answer.
   */
  it('does not chase a match beyond the search window', () => {
    const far = ['target', ...Array.from({ length: 900 }, (_, i) => `filler ${i}`)];

    expect(resolveAnchorLine(far.join('\n'), 901, 'target')).toBe(901);
  });
});

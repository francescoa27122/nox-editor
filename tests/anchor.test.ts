import { describe, expect, it } from 'vitest';
import { resolveAnchor } from '../src/core/anchor';

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

    expect(resolveAnchor(text, 2, 'two').line).toBe(2);
  });

  /**
   * The failure this prevents: the whole reason a snippet is stored beside
   * the line. Inserting above an anchor is the single most common edit there
   * is, and a line number alone silently points at the wrong code afterwards
   * — worse than pointing nowhere, because it looks right.
   */
  it('follows code pushed down by an insertion above it', () => {
    const text = lines('added', 'added', 'one', 'two', 'three');

    expect(resolveAnchor(text, 2, 'two').line).toBe(4);
  });

  it('follows code pulled up by a deletion above it', () => {
    const text = lines('two', 'three');

    expect(resolveAnchor(text, 4, 'two').line).toBe(1);
  });

  it('ignores indentation changes, which reformatting makes constantly', () => {
    const text = lines('one', '        two', 'three');

    expect(resolveAnchor(text, 2, 'two').line).toBe(2);
  });

  /**
   * `}` and `});` appear hundreds of times in a real file. Expanding outward
   * from the remembered line rather than scanning from the top is what stops
   * a jump landing on the first one in the document.
   */
  it('prefers the nearest match when the snippet is not unique', () => {
    const text = lines('}', 'a', '}', 'b', '}', 'c', '}');

    expect(resolveAnchor(text, 4, '}').line).toBe(3);
    expect(resolveAnchor(text, 6, '}').line).toBe(5);
  });

  /**
   * The failure this prevents: an anchor whose code is genuinely gone
   * jumping somewhere arbitrary. Falling back to the remembered line puts the
   * reader in the neighbourhood the note was about, which is the best that
   * can honestly be offered.
   */
  it('falls back to the remembered line when the snippet has gone', () => {
    const text = lines('one', 'two', 'three');

    expect(resolveAnchor(text, 2, 'deleted long ago').line).toBe(2);
  });

  it('clamps a line past the end of a file that has shrunk', () => {
    const text = lines('one', 'two');

    expect(resolveAnchor(text, 99, 'gone').line).toBe(2);
  });

  it('never returns less than the first line', () => {
    expect(resolveAnchor('one', 0, 'gone').line).toBe(1);
    expect(resolveAnchor('one', -5, 'gone').line).toBe(1);
  });

  it('treats an empty snippet as no help, not as a match on every blank line', () => {
    const text = lines('one', '', 'three');

    expect(resolveAnchor(text, 3, '').line).toBe(3);
  });

  /**
   * A restructure that moved code hundreds of lines is not a drift, and a
   * far-away identical line is more likely a coincidence than the anchor's
   * subject. Past the window the remembered line is the safer answer.
   */
  it('does not chase a match beyond the search window', () => {
    const far = ['target', ...Array.from({ length: 900 }, (_, i) => `filler ${i}`)];

    expect(resolveAnchor(far.join('\n'), 901, 'target').line).toBe(901);
  });
});

describe('reporting whether it found the snippet', () => {
  /**
   * The caller needs this to decide whether the answer is trustworthy enough
   * to write back. A found line is the anchor's subject; a fallback is only
   * the neighbourhood it used to be in, and persisting that would overwrite
   * the last thing anyone actually knew.
   */
  it('says so when the snippet was there', () => {
    expect(resolveAnchor(lines('added', 'one', 'two'), 1, 'two').found).toBe(true);
  });

  it('says so when it fell back to the remembered line', () => {
    expect(resolveAnchor(lines('one', 'two'), 2, 'deleted long ago').found).toBe(false);
  });

  it('does not claim a find for an empty snippet', () => {
    expect(resolveAnchor(lines('one', ''), 2, '').found).toBe(false);
  });

  it('does not claim a find beyond the window', () => {
    const far = ['target', ...Array.from({ length: 900 }, (_, i) => `filler ${i}`)];

    expect(resolveAnchor(far.join('\n'), 901, 'target').found).toBe(false);
  });
});

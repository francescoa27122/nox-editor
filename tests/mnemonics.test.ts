import { describe, expect, it } from 'vitest';
import { mnemonicsFor } from '../src/core/mnemonics';
import { LAYOUT } from '../src/services/menu';

/**
 * The Alt letters of the drawn menu bar.
 *
 * A5-003: Windows and Linux open a menu with Alt and a letter, and Nox had
 * no letters. Which letter each menu gets is a decision, not markup, so it
 * lives in `core/` and is pinned here rather than read off the DOM.
 */
describe('mnemonicsFor', () => {
  it('takes the first letter where it is free', () => {
    expect(mnemonicsFor(['File', 'Edit', 'View'])).toEqual(['F', 'E', 'V']);
  });

  /**
   * "Find" after "File": the first free letter in the word, so it still
   * reads as an underline inside the title rather than as an arbitrary key.
   */
  it('moves along the word when the first letter is taken', () => {
    expect(mnemonicsFor(['File', 'Find'])).toEqual(['F', 'I']);
  });

  it('gives up on a title with no free letter rather than inventing one', () => {
    expect(mnemonicsFor(['Go', 'Go', 'Go'])).toEqual(['G', 'O', null]);
  });

  it('is case-insensitive about what is taken', () => {
    expect(mnemonicsFor(['Edit', 'Exit'])).toEqual(['E', 'X']);
  });

  /**
   * The real table, so a menu added without a free letter fails here rather
   * than shipping as the one title Alt cannot reach.
   */
  it('finds a letter for every menu Nox draws', () => {
    const letters = mnemonicsFor(LAYOUT.map((group) => group.label));
    expect(letters).not.toContain(null);
    expect(new Set(letters).size).toBe(letters.length);
  });
});

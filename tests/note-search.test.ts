import { describe, expect, it } from 'vitest';
import { findNotes } from '../src/core/note-search';

/**
 * The rows the notes panel shows, given a query. A pure function rather than
 * a `$derived` in the component, for the same reason `core/search-match.ts`
 * is one: the ranking and the snippet are the parts worth testing, and they
 * do not need a DOM to be wrong.
 */

interface Row {
  title: string;
  body: string;
  pinned: boolean;
}

const note = (title: string, body = '', pinned = false): Row => ({ title, body, pinned });

describe('filtering', () => {
  it('returns every note in order for an empty query', () => {
    const notes = [note('first'), note('second')];

    expect(findNotes(notes, '').map((hit) => hit.note.title)).toEqual(['first', 'second']);
  });

  it('matches a title', () => {
    const notes = [note('release checklist'), note('shopping')];

    expect(findNotes(notes, 'check').map((hit) => hit.note.title)).toEqual(['release checklist']);
  });

  /**
   * The whole point of the feature: the list shows titles only, so a note
   * whose subject is in its body is otherwise unfindable.
   */
  it('matches a body the list never shows', () => {
    const notes = [note('untitled 1', 'remember to rotate the signing key')];

    expect(findNotes(notes, 'signing')).toHaveLength(1);
  });

  it('ignores case in both directions', () => {
    const notes = [note('Signing Key')];

    expect(findNotes(notes, 'signing')).toHaveLength(1);
    expect(findNotes(notes, 'SIGNING')).toHaveLength(1);
  });

  /**
   * Substring, not fuzzy. A filter box over a list wants predictable
   * behaviour — fuzzy would match 'sk' against 'shopping list' and leave the
   * user unable to narrow anything down. The palette is where fuzzy belongs.
   */
  it('does not match a scattered subsequence', () => {
    const notes = [note('shopping list')];

    expect(findNotes(notes, 'sl')).toHaveLength(0);
  });

  it('treats whitespace-only as no query', () => {
    const notes = [note('first'), note('second')];

    expect(findNotes(notes, '   ')).toHaveLength(2);
  });
});

describe('snippets', () => {
  it('returns the first body line containing the query', () => {
    const notes = [note('n', 'line one\nthe signing key is here\nline three')];

    expect(findNotes(notes, 'signing')[0]!.snippet).toBe('the signing key is here');
  });

  /**
   * A title-only match has nothing to quote. Showing the note's first body
   * line instead would look like a hit on text that does not contain the
   * query at all.
   */
  it('has no snippet when only the title matched', () => {
    const notes = [note('signing key', 'a body about something else')];

    expect(findNotes(notes, 'signing')[0]!.snippet).toBeNull();
  });

  it('has no snippet for an empty query', () => {
    const notes = [note('n', 'a body')];

    expect(findNotes(notes, '')[0]!.snippet).toBeNull();
  });

  it('trims a snippet so indented prose does not render ragged', () => {
    const notes = [note('n', '    indented signing line')];

    expect(findNotes(notes, 'signing')[0]!.snippet).toBe('indented signing line');
  });
});

describe('ordering', () => {
  /**
   * The failure this prevents: pinning that does not actually lift a note.
   * `create()` prepends and the list never re-sorts, so a pinned note created
   * early stays buried without this.
   */
  it('lifts pinned notes above unpinned ones', () => {
    const notes = [note('newest'), note('pinned one', '', true), note('oldest')];

    expect(findNotes(notes, '').map((hit) => hit.note.title)).toEqual([
      'pinned one',
      'newest',
      'oldest',
    ]);
  });

  /**
   * Within a group the existing order is the one `create()` decided, and
   * nothing here re-decides it — sorting by a timestamp would make rows move
   * while they are being typed into.
   */
  it('keeps insertion order within each group', () => {
    const notes = [
      note('a', '', true),
      note('b'),
      note('c', '', true),
      note('d'),
    ];

    expect(findNotes(notes, '').map((hit) => hit.note.title)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('still lifts pinned notes among filtered results', () => {
    const notes = [note('key one'), note('key two', '', true), note('unrelated')];

    expect(findNotes(notes, 'key').map((hit) => hit.note.title)).toEqual(['key two', 'key one']);
  });
});

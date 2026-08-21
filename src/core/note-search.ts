/**
 * Which notes the panel shows, and in what order.
 *
 * A pure function rather than a `$derived` in `NotesPanel.svelte`, for the
 * reason `core/search-match.ts` is one: the matching and the snippet are the
 * parts that can be wrong, and neither needs a DOM to be tested.
 *
 * It takes a structural shape rather than importing `Note` from
 * `services/notes.ts`, because `core/` sits below `services/` and nothing
 * here may import upwards.
 *
 * Substring rather than fuzzy, deliberately. `core/fuzzy.ts` is right for the
 * palette, where you are naming a note you already have in mind; it is wrong
 * for a filter box, where 'sl' matching 'shopping list' means the query can
 * never be narrowed. The two affordances want opposite things.
 */

export interface SearchableNote {
  title: string;
  body: string;
  pinned: boolean;
}

export interface NoteHit<T extends SearchableNote> {
  note: T;
  /**
   * The first body line containing the query, or null when the body did not
   * match. Quoting the first line of a body that does not contain the query
   * would look like a hit on text that is not there.
   */
  snippet: string | null;
}

/**
 * Notes matching `query`, pinned first. An empty or whitespace-only query
 * matches everything, so clearing the box restores the full list rather than
 * emptying it.
 *
 * Order within each group is the order given, which is the order `create()`
 * decided. Nothing here re-sorts: ranking by a timestamp would move rows
 * while they are being typed into.
 */
export function findNotes<T extends SearchableNote>(
  notes: readonly T[],
  query: string,
): NoteHit<T>[] {
  const needle = query.trim().toLowerCase();

  const hits: NoteHit<T>[] = [];
  for (const note of notes) {
    if (needle.length === 0) {
      hits.push({ note, snippet: null });
      continue;
    }
    const snippet = firstMatchingLine(note.body, needle);
    if (snippet === null && !note.title.toLowerCase().includes(needle)) continue;
    hits.push({ note, snippet });
  }

  // Two passes rather than a comparator: `Array.prototype.sort` is only
  // guaranteed stable per spec, and saying "pinned, then the rest, each in
  // the order they arrived" directly is clearer than relying on that.
  return [...hits.filter((hit) => hit.note.pinned), ...hits.filter((hit) => !hit.note.pinned)];
}

/** The first line of `body` containing `needle`, trimmed, or null. */
function firstMatchingLine(body: string, needle: string): string | null {
  for (const line of body.split('\n')) {
    if (line.toLowerCase().includes(needle)) return line.trim();
  }
  return null;
}

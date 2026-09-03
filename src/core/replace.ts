/**
 * Replacement primitives.
 *
 * Kept pure and separate from the search service because this is the part that
 * can destroy work: everything here is a total function over strings, so the
 * decision of *what* the new text should be is fully testable without touching
 * a filesystem.
 */

export interface FileEdit {
  from: number;
  to: number;
  insert: string;
}

export interface ReplacementResult {
  /** The rewritten document. */
  text: string;
  /** Edits in ascending order — usable as a CodeMirror change set. */
  edits: FileEdit[];
  count: number;
}

const TOKEN = /\$(\$|&|<([^>]*)>|\d{1,2})/g;

/**
 * Expand `$1`, `$&`, `$<name>` and `$$` against a match.
 *
 * Only meaningful for regex searches; a literal search treats the replacement
 * verbatim, which is what every editor does and what stops `$` in a plain
 * string search from silently vanishing.
 */
export function expandReplacement(
  template: string,
  match: RegExpExecArray,
  expand: boolean,
): string {
  if (!expand) return template;

  return template.replace(TOKEN, (whole, token: string, name: string | undefined) => {
    if (token === '$') return '$';
    if (token === '&') return match[0];
    if (name !== undefined) return match.groups?.[name] ?? '';

    const index = Number.parseInt(token, 10);
    // An out-of-range group reference stays literal rather than becoming
    // empty — silently deleting text the user typed would be worse.
    if (!Number.isFinite(index) || index <= 0 || index >= match.length) return whole;
    return match[index] ?? '';
  });
}

/**
 * Shape `replacement` to the case pattern of `matched`.
 *
 * Precedence — order is load-bearing — all lower, then Capitalized, then ALL
 * UPPER, then verbatim. Both boundaries in that order are load-bearing, not
 * just the second one:
 *
 * - All-lower before Capitalized: an uncased leading character such as `_`
 *   or a digit trivially satisfies `first === first.toUpperCase()` (there is
 *   no case to change), so a leading-underscore lower-case match like
 *   `_scheduler` would be misread as Capitalized — and its replacement's
 *   first letter wrongly upper-cased — if Capitalized were checked first.
 * - Capitalized before ALL UPPER: a single capital letter (`S`) satisfies
 *   both — its remainder is empty, which is trivially lower-case — and one
 *   capital reads as a capitalised word, not a shout. `SS` has a non-lower
 *   remainder and so only ever matches ALL UPPER.
 *
 * A match with no cased letter — digits, punctuation, or empty — is
 * verbatim. `matched === matched.toUpperCase()` alone would call `123` ALL
 * UPPER, because a string with no letters is equal to both its upper- and
 * lower-cased form; comparing the upper and lower forms against each other
 * instead of against `matched` catches that, and does it for any script, not
 * just ASCII — an ASCII `/[a-zA-Z]/` guard would wrongly call a Cyrillic or
 * Greek match letterless, since none of its characters are in `a-zA-Z`.
 *
 * A match like `_Scheduler` is deliberately verbatim, not Capitalized:
 * Capitalized requires the *entire* remainder to be lower-case, and
 * `_Scheduler`'s remainder is `Scheduler`, not `scheduler`. That is the
 * rule's least intuitive output but it is spec-conformant — resist folding
 * it into the Capitalized branch, which would also capture `_scheduler`.
 */
export function preserveCase(matched: string, replacement: string): string {
  const upper = matched.toUpperCase();
  const lower = matched.toLowerCase();
  if (upper === lower) return replacement; // No cased letter — verbatim.

  if (matched === lower) return replacement.toLowerCase();

  const first = matched.charAt(0);
  const rest = matched.slice(1);
  if (first === first.toUpperCase() && rest === rest.toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }

  if (matched === upper) return replacement.toUpperCase();

  return replacement;
}

/**
 * Compute the replacement for one document.
 *
 * Walks line by line in exactly the order `findMatches` does, so `skip` indices
 * line up with the match rows the user is looking at. Zero-width matches are
 * skipped for the same reason they are in search: a pattern like `x*` would
 * otherwise splice the replacement in an unbounded number of times.
 */
export function computeReplacements(
  text: string,
  matcher: RegExp,
  replacement: string,
  options: { expand?: boolean; skip?: ReadonlySet<number>; preserveCase?: boolean } = {},
): ReplacementResult {
  const { expand = false, skip, preserveCase: shouldPreserveCase = false } = options;
  const edits: FileEdit[] = [];
  const lines = text.split('\n');

  let lineStart = 0;
  let index = -1;

  for (const raw of lines) {
    // Matched without its `\r`, so a CRLF file matches the way the Rust
    // search's `lines()` sees it and `$` anchors at the text rather than at
    // the `\r`. Offsets are unaffected: the `\r` sits after every match on
    // its line, and stays in the output.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    matcher.lastIndex = 0;
    let found: RegExpExecArray | null;

    while ((found = matcher.exec(line)) !== null) {
      if (found[0].length === 0) {
        matcher.lastIndex++;
        continue;
      }

      index++;
      if (!skip?.has(index)) {
        // preserveCase is applied after expansion, to the expanded string —
        // casing the template instead would rewrite named-group references
        // like `$<word>` to `$<WORD>`, silently losing the captured text.
        const expanded = expandReplacement(replacement, found, expand);
        edits.push({
          from: lineStart + found.index,
          to: lineStart + found.index + found[0].length,
          insert: shouldPreserveCase ? preserveCase(found[0], expanded) : expanded,
        });
      }
    }

    lineStart += raw.length + 1; // +1 for the newline `split` removed.
  }

  return { text: applyEdits(text, edits), edits, count: edits.length };
}

/** Apply ascending, non-overlapping edits to a string. */
export function applyEdits(text: string, edits: readonly FileEdit[]): string {
  if (edits.length === 0) return text;

  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    out += text.slice(cursor, edit.from) + edit.insert;
    cursor = edit.to;
  }
  return out + text.slice(cursor);
}

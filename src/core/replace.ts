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
  options: { expand?: boolean; skip?: ReadonlySet<number> } = {},
): ReplacementResult {
  const { expand = false, skip } = options;
  const edits: FileEdit[] = [];
  const lines = text.split('\n');

  let lineStart = 0;
  let index = -1;

  for (const line of lines) {
    matcher.lastIndex = 0;
    let found: RegExpExecArray | null;

    while ((found = matcher.exec(line)) !== null) {
      if (found[0].length === 0) {
        matcher.lastIndex++;
        continue;
      }

      index++;
      if (!skip?.has(index)) {
        edits.push({
          from: lineStart + found.index,
          to: lineStart + found.index + found[0].length,
          insert: expandReplacement(replacement, found, expand),
        });
      }
    }

    lineStart += line.length + 1; // +1 for the newline `split` removed.
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

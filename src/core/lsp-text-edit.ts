import type { LspRange } from './lsp-definition';
import { offsetAt, type LspPosition } from './lsp-position';

/**
 * `TextEdit`, read and converted.
 *
 * Rename and formatting both receive lists of `{ range, newText }` and both
 * turn them into CodeMirror changes against a buffer's text; this is the one
 * reading and the one conversion. Pure. See
 * `docs/superpowers/specs/2026-08-19-lsp-format-design.md` §3.
 */

export interface TextEdit {
  range: LspRange;
  newText: string;
}

export function isLspPosition(value: unknown): value is LspPosition {
  if (typeof value !== 'object' || value === null) return false;
  const { line, character } = value as LspPosition;
  return (
    Number.isInteger(line) && line >= 0 && Number.isInteger(character) && character >= 0
  );
}

export function isLspRange(value: unknown): value is LspRange {
  return (
    typeof value === 'object' &&
    value !== null &&
    isLspPosition((value as LspRange).start) &&
    isLspPosition((value as LspRange).end)
  );
}

function textEditOf(entry: unknown): TextEdit | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const { range, newText } = entry as Record<string, unknown>;
  if (!isLspRange(range) || typeof newText !== 'string') return null;
  return { range, newText };
}

/** Every well-formed edit in `value`, in order; anything else is dropped. */
export function textEditsOf(value: unknown): TextEdit[] {
  if (!Array.isArray(value)) return [];
  const edits: TextEdit[] = [];
  for (const entry of value) {
    const edit = textEditOf(entry);
    if (edit) edits.push(edit);
  }
  return edits;
}

export interface Change {
  from: number;
  to: number;
  insert: string;
}

/**
 * The edits as changes against `text`, the text they were computed for.
 *
 * `offsetAt` clamps a position past the end of a line or the text to the
 * end, so an edit a server aims beyond the document becomes an append
 * rather than an offset `ChangeSet.of` would throw on — and appending is
 * also how a formatter adds a final newline. An inverted range is clamped
 * so it cannot become a backwards change.
 */
export function changesOf(text: string, edits: readonly TextEdit[]): Change[] {
  return edits.map((edit) => {
    const from = offsetAt(text, edit.range.start);
    const to = Math.max(from, offsetAt(text, edit.range.end));
    return { from, to, insert: edit.newText };
  });
}

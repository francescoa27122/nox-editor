/**
 * LSP positions to string offsets and back.
 *
 * LSP counts a character in UTF-16 code units and so does a JavaScript string
 * index, so the mapping is mechanical — which is exactly why it is worth
 * writing down once with tests, rather than open-coding it at each call site
 * where an off-by-one is invisible.
 *
 * Both directions clamp. A server computes against a copy of the document that
 * may be a revision behind, and a position past the end of the current text is
 * a crash in CodeMirror rather than a cosmetic error.
 */

export interface LspPosition {
  /** Zero-based. */
  line: number;
  /** Zero-based, in UTF-16 code units. */
  character: number;
}

/** Offset of the first character of every line. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/**
 * Length of the line beginning at `start`, excluding its terminator.
 *
 * A `\r` before the `\n` terminates the line rather than sitting on it, because
 * counting it as content would shift every column reported for the line.
 *
 * No caller in Nox can currently reach that branch: every one of them passes a
 * buffer's document, and a document is canonical LF by construction — `decode`
 * strips CRLF on the way in and `encode` reapplies it on save, so the file's
 * ending is metadata the text never carries (see ARCHITECTURE.md §4, "The
 * document is canonical"). It is handled anyway because this is a pure string
 * helper over LSP's own coordinate system rather than over Nox's documents, and
 * a helper that silently mis-measures raw file text is a trap for the first
 * caller who hands it some. `tests/lsp-position.test.ts` is what keeps the
 * branch honest; do not delete those cases as dead weight.
 */
function lineLength(text: string, start: number): number {
  let end = text.indexOf('\n', start);
  if (end === -1) end = text.length;
  if (end > start && text[end - 1] === '\r') end--;
  return end - start;
}

export function offsetAt(text: string, position: LspPosition): number {
  const starts = lineStarts(text);
  const line = Math.max(0, position.line);
  if (line >= starts.length) return text.length;

  const start = starts[line]!;
  const character = Math.min(Math.max(0, position.character), lineLength(text, start));
  return start + character;
}

export function positionAt(text: string, offset: number): LspPosition {
  const clamped = Math.min(Math.max(0, offset), text.length);
  const starts = lineStarts(text);

  // The last line whose start is at or before the offset. Linear rather than
  // bisected: the caller is converting a handful of diagnostic ranges, not
  // walking a document.
  let line = 0;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i]! <= clamped) line = i;
    else break;
  }

  const start = starts[line]!;
  // Clamped to the line, so this never returns a position the format cannot
  // express. An offset landing between a carriage return and its newline is
  // inside a terminator rather than on the line, and reporting the character
  // after the last one would be out of range for every consumer.
  const character = Math.min(clamped - start, lineLength(text, start));
  return { line, character };
}

/**
 * LSP hover `contents` to blocks Nox can render.
 *
 * Pure, and separate from the editor for one reason above the usual: what
 * comes back is markdown from a third-party process, and the decision *not*
 * to parse it into HTML is a security boundary rather than a styling
 * preference. See the design's §4. This module reduces it to text; the editor
 * puts that text on screen through `textContent` and never `innerHTML`.
 */

export type HoverBlock = { kind: 'code'; text: string } | { kind: 'prose'; text: string };

/** ```lang \n body \n``` — the tag is dropped, the body kept. */
const FENCE = /```[^\n]*\n?([\s\S]*?)(?:```|$)/g;

/**
 * `MarkedString`'s object form, which is the easy one to get wrong: it
 * carries a language and is therefore code, with no fence to signal it.
 */
function isLanguageString(value: unknown): value is { language: string; value: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'language' in value &&
    typeof (value as { value?: unknown }).value === 'string'
  );
}

function isMarkupContent(value: unknown): value is { kind?: string; value: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    typeof (value as { value?: unknown }).value === 'string'
  );
}

/** Split one markdown string into its fenced and unfenced parts, in order. */
function splitFences(markdown: string): HoverBlock[] {
  const blocks: HoverBlock[] = [];
  let cursor = 0;

  FENCE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = FENCE.exec(markdown)) !== null) {
    const prose = markdown.slice(cursor, match.index).trim();
    if (prose) blocks.push({ kind: 'prose', text: prose });

    const code = (match[1] ?? '').replace(/\n$/, '').trim();
    if (code) blocks.push({ kind: 'code', text: code });

    cursor = match.index + match[0].length;
    // A zero-length match would spin; the pattern can match empty at the end.
    if (match[0].length === 0) FENCE.lastIndex++;
  }

  const tail = markdown.slice(cursor).trim();
  if (tail) blocks.push({ kind: 'prose', text: tail });

  return blocks;
}

/** One entry of `contents`, whichever of the three shapes it is. */
function blocksOf(entry: unknown): HoverBlock[] {
  if (typeof entry === 'string') return splitFences(entry);

  // Checked before `isMarkupContent`, which it would otherwise satisfy — both
  // have a string `value`, and only this one means "code".
  if (isLanguageString(entry)) {
    const text = entry.value.trim();
    return text ? [{ kind: 'code', text }] : [];
  }

  if (isMarkupContent(entry)) return splitFences(entry.value);

  return [];
}

/**
 * Reduce `contents` to blocks. Empty in, empty out — a hover with nothing to
 * say produces no tooltip rather than an empty one.
 */
export function hoverBlocks(contents: unknown): HoverBlock[] {
  if (contents === null || contents === undefined) return [];
  if (Array.isArray(contents)) return contents.flatMap(blocksOf);
  return blocksOf(contents);
}

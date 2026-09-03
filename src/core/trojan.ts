/**
 * Text that reads one way and is stored another.
 *
 * Unicode's bidirectional controls reorder what a renderer draws without
 * changing what a compiler reads, zero-width characters sit inside an
 * identifier without taking up any space, and a Cyrillic or Greek letter
 * can be drawn with the same glyph as a Latin one. Each lets a line look
 * benign in a diff and mean something else in the file (the "Trojan Source"
 * class, CVE-2021-42574). The review panel is the one place a human is
 * relying on the rendering to decide, so it is the place that has to say.
 *
 * Pure functions over strings, so the detection is testable against the
 * paper's own samples without a component. Nothing here refuses anything:
 * what gets applied is the user's decision, and this exists to make it an
 * informed one.
 */

export type HiddenKind = 'bidi' | 'zero-width';

export interface HiddenCharacter {
  /** Index into the string, in UTF-16 code units. */
  index: number;
  codePoint: number;
  kind: HiddenKind;
}

/** What a hunk can be flagged for, in the order the badge lists them. */
export type Concern = HiddenKind | 'mixed-script';

/**
 * The nine embedding, override and isolate controls the paper uses. The
 * weaker marks (U+200E, U+200F) are left alone: they change the direction of
 * neutral characters and cannot reorder text.
 */
const BIDI = new Set([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);

/**
 * Characters that take no space. U+FEFF counts anywhere: the workspace strips
 * a file's byte-order mark on open and tracks it separately, so one inside a
 * buffer's text is never a BOM. U+200D is flagged too, though emoji sequences
 * use it legitimately; a review that showed every invisible character but
 * that one would be the wrong kind of tidy.
 */
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);

/** Every hidden character in `text`, in order. */
export function findHidden(text: string): HiddenCharacter[] {
  const found: HiddenCharacter[] = [];
  for (let index = 0; index < text.length; index++) {
    const codePoint = text.charCodeAt(index);
    // Every code point of interest is in the Basic Multilingual Plane, so a
    // code unit is a code point and no surrogate handling is needed.
    if (BIDI.has(codePoint)) found.push({ index, codePoint, kind: 'bidi' });
    else if (ZERO_WIDTH.has(codePoint)) found.push({ index, codePoint, kind: 'zero-width' });
  }
  return found;
}

/**
 * A run of letters, marks, digits and underscores: what an identifier or a
 * word is made of, whatever the language.
 */
const WORD = /[\p{L}\p{M}\p{N}_]+/gu;
const LATIN = /\p{Script=Latin}/u;
const CYRILLIC = /\p{Script=Cyrillic}/u;
const GREEK = /\p{Script=Greek}/u;

/**
 * Whether any single word mixes Latin with Cyrillic or Greek.
 *
 * Those are the scripts with letters drawn identically to Latin ones, so a
 * mix inside one word is a disguise far more often than a spelling. Two
 * scripts in different words is prose. Han beside Latin is left alone
 * because `変数name` is how a great deal of real code is written.
 */
export function hasMixedScript(text: string): boolean {
  for (const [word] of text.matchAll(WORD)) {
    const latin = LATIN.test(word);
    if (latin && (CYRILLIC.test(word) || GREEK.test(word))) return true;
  }
  return false;
}

/** The distinct concerns across a hunk's lines, most serious first. */
export function concernsIn(lines: string[]): Concern[] {
  const seen = new Set<Concern>();
  for (const line of lines) {
    for (const hit of findHidden(line)) seen.add(hit.kind);
    if (hasMixedScript(line)) seen.add('mixed-script');
  }
  const order: Concern[] = ['bidi', 'zero-width', 'mixed-script'];
  return order.filter((concern) => seen.has(concern));
}

/**
 * The same text with each hidden character replaced by `<U+XXXX>`.
 *
 * For rendering only. The placeholder is deliberately not a character the
 * diff could have contained on its own, and it is drawn in place so the
 * reader sees where the control sits, which for a bidi override is the whole
 * point.
 */
export function revealHidden(text: string): string {
  const hidden = findHidden(text);
  if (hidden.length === 0) return text;
  let out = '';
  let last = 0;
  for (const hit of hidden) {
    out += text.slice(last, hit.index);
    out += `<U+${hit.codePoint.toString(16).toUpperCase().padStart(4, '0')}>`;
    last = hit.index + 1;
  }
  return out + text.slice(last);
}

/**
 * What a file's own text says about how it is indented.
 *
 * A1-004: the indent unit used to be a pure function of settings, so opening
 * a tab-indented file with `editor.insertSpaces` on and pressing Enter
 * produced mixed indentation nobody asked for. Detection runs once per buffer
 * when it is opened, never per keystroke, and the settings value is what a
 * file with nothing to say falls back to.
 *
 * Pure and view-free on purpose: it lives here rather than in `src/editor/`
 * so it can be tested headless and held to its stated cost by
 * `tests/complexity.test.ts`.
 */

/** What a file was read to be using. `null` fields mean "the file cannot say". */
export interface Indentation {
  insertSpaces: boolean;
  /**
   * Columns per indent level, or null when the file gives no trustworthy
   * width. Tabs are always null: a tab's display width is a preference of the
   * reader's, not a fact about the file.
   */
  tabSize: number | null;
}

/** An `Indentation` with every gap filled in, ready to configure an editor. */
export interface ResolvedIndentation {
  insertSpaces: boolean;
  tabSize: number;
}

/**
 * How many lines are read before the answer is called.
 *
 * Bounded because `WorkspaceService.open` accepts files up to 64 MB and this
 * runs on the path between the click and the text appearing. Five hundred
 * lines is far more than any heuristic needs (the shape of a file is settled
 * in its first screenful) and it makes the cost independent of the document,
 * which is the property `tests/complexity.test.ts` holds.
 */
const MAX_SAMPLE_LINES = 500;

/**
 * And a byte bound beside the line bound, because one does not imply the
 * other: a minified bundle is a single 60 MB line, and a line cap alone would
 * still walk all of it looking for the newline that never comes.
 */
const MAX_SAMPLE_CHARS = 64 * 1024;

/**
 * Widths outside this range are not indentation.
 *
 * The low end is the interesting one. A step of exactly one space is far more
 * often a continuation line or an aligned comment than a file that really
 * indents by one, so a width of 1 is read as "no trustworthy width" and the
 * setting is used instead. The high end is alignment to a column, not nesting.
 */
const MIN_WIDTH = 2;
const MAX_WIDTH = 8;

const TAB = 9;
const NEWLINE = 10;
const CARRIAGE_RETURN = 13;
const SPACE = 32;
const ASTERISK = 42;

/**
 * Read a document's indentation, or null when it does not have any.
 *
 * The rules, all of which have a test in `tests/indentation.test.ts`:
 *
 * - **Tabs versus spaces is a majority vote** over the sampled indented
 *   lines, and any tab in a line's leading run makes it a tab line. An exact
 *   tie returns null: a file that is evenly both is not telling you anything,
 *   and the user's setting is a better answer than a coin toss.
 * - **The width is the most common step between consecutive lines**, not the
 *   most common absolute indent, so a continuation line indented to line up
 *   with an open bracket does not outvote the real unit. Ties go to the
 *   smaller step, because a four-space file produces only fours while a
 *   two-space file produces twos and the occasional four.
 * - **Blank lines are skipped but do not reset the baseline**, so a step is
 *   still counted across the blank line between two functions.
 * - **Lines whose first non-whitespace character is `*` are skipped**, which
 *   is what keeps a file whose only indentation is a block comment from being
 *   read as a one-space file. That also drops the rare indented pointer
 *   dereference in C, which costs one sample and changes no answer.
 */
export function detectIndentation(doc: string): Indentation | null {
  const limit = Math.min(doc.length, MAX_SAMPLE_CHARS);
  const steps = new Map<number, number>();
  let pos = 0;
  let lines = 0;
  let tabLines = 0;
  let spaceLines = 0;
  let previousWidth = 0;

  while (pos < limit && lines < MAX_SAMPLE_LINES) {
    let end = pos;
    while (end < limit && doc.charCodeAt(end) !== NEWLINE) end++;
    // The sample window cut this line in half. A fragment's leading run is
    // real but its content is not, so stop rather than classify it.
    if (end === limit && limit < doc.length) break;

    lines++;
    let spaces = 0;
    let tabs = 0;
    let i = pos;
    for (; i < end; i++) {
      const code = doc.charCodeAt(i);
      if (code === SPACE) spaces++;
      else if (code === TAB) tabs++;
      else break;
    }
    pos = end + 1;

    // Blank, or blank but for the CR of a CRLF pair.
    if (i === end || doc.charCodeAt(i) === CARRIAGE_RETURN) continue;
    if (doc.charCodeAt(i) === ASTERISK) continue;

    if (tabs > 0) {
      tabLines++;
      // Deliberately leaves `previousWidth` alone: a tab line has no space
      // width, and pretending it has one would invent a step on the next
      // space line of a mixed file.
      continue;
    }

    if (spaces > 0) spaceLines++;
    const step = Math.abs(spaces - previousWidth);
    if (step > 0) steps.set(step, (steps.get(step) ?? 0) + 1);
    previousWidth = spaces;
  }

  if (tabLines === 0 && spaceLines === 0) return null;
  if (tabLines > spaceLines) return { insertSpaces: false, tabSize: null };
  if (spaceLines > tabLines) return { insertSpaces: true, tabSize: commonStep(steps) };
  return null;
}

/** The most common step, smaller wins a tie, or null when it is not a width. */
function commonStep(steps: ReadonlyMap<number, number>): number | null {
  let best: number | null = null;
  let bestCount = 0;
  for (const [step, count] of steps) {
    if (count > bestCount || (count === bestCount && best !== null && step < best)) {
      best = step;
      bestCount = count;
    }
  }
  if (best === null || best < MIN_WIDTH || best > MAX_WIDTH) return null;
  return best;
}

/** The detected indentation, with anything the file did not say taken from `fallback`. */
export function resolveIndentation(
  detected: Indentation | null,
  fallback: ResolvedIndentation,
): ResolvedIndentation {
  if (!detected) return fallback;
  return {
    insertSpaces: detected.insertSpaces,
    tabSize: detected.tabSize ?? fallback.tabSize,
  };
}

import { EditorView } from '@codemirror/view';
import { page } from 'vitest/browser';
import { afterEach, describe, expect, it } from 'vitest';
import { parseGitBlame } from '../../src/core/git-blame';
import { blameCompartment } from '../../src/editor/extensions';
import { blameGutter, setGitBlame } from '../../src/editor/git-blame';
import { document as sourceDocument, mountEditor, type Editor } from './support/keystroke';
import '../../src/styles/tokens.css';

/**
 * The blame gutter's geometry, in a browser that has layout.
 *
 * Everything else about blame is proved headlessly or in jsdom, and neither
 * can reach the one claim the column is built on: **its width does not
 * change.** `tests/support/jsdom-layout.ts` records that jsdom returns zeros
 * from every measurement, so a jsdom test asserting a width would be
 * asserting against an invention. The claim matters because the gutter sits
 * to the left of the code, and a column that resized as different names
 * scrolled into view would shove every line of the file sideways while you
 * read it.
 *
 * Two mechanisms are supposed to make it fixed, and each gets a test:
 * `blameLabel` pads every label to `BLAME_LABEL_WIDTH` in a monospaced
 * column, and `initialSpacer` holds that width open before any marks exist.
 */

const LINES = 400;

/**
 * Three commits down the file, in the order that makes the width claim
 * testable: names that fit, then a name that must be cut, then lines no
 * commit holds. Scrolling from the top to the bottom therefore changes which
 * kind of label is on screen, which is the whole point.
 */
const AUTHORS = ['Jane Doe', 'Bartholomew Fortescue-Smythe', ''] as const;
const HASHES = ['a'.repeat(40), 'b'.repeat(40), '0'.repeat(40)] as const;

function blameFor(lines: number): string {
  const rows: string[] = [];
  const stated = new Set<string>();
  for (let i = 0; i < lines; i++) {
    const which = Math.min(2, Math.floor((i * 3) / lines));
    const hash = HASHES[which]!;
    rows.push(`${hash} ${i + 1} ${i + 1} 1`);
    if (!stated.has(hash)) {
      stated.add(hash);
      rows.push(
        // git's own author for a line supplied through `--contents`, which is
        // how Nox always asks. The renderer never shows it, because the zero
        // hash is what makes the line read Uncommitted, so it is here to prove
        // that.
        `author ${AUTHORS[which] || 'External file (--contents)'}`,
        `author-mail <${which}@example.com>`,
        'author-time 1700000000',
        'author-tz +0000',
        'summary A commit that touched these lines',
        'filename src/app.ts',
      );
    }
    rows.push(`\t${i}`);
  }
  return rows.join('\n') + '\n';
}

/** The blame gutter's own column, measured. */
function columnWidth(view: EditorView): number {
  const column = view.dom.querySelector('.cm-blameGutter');
  if (!column) throw new Error('no blame gutter in the view');
  return column.getBoundingClientRect().width;
}

/**
 * The gutter columns, named in the order they are actually painted.
 *
 * Sorted by measured `left` rather than read off the DOM, which is the point
 * of asking here rather than in jsdom. DOM order and paint order agree today
 * because `.cm-gutters` is a flex row, but "the blame column is to the left of
 * the code" is a claim about the screen, and the way to check a claim about
 * the screen is to measure the screen. jsdom would return six zeros and sort
 * them into whatever order they arrived in.
 */
function gutterOrder(view: EditorView): string[] {
  return [...view.dom.querySelectorAll('.cm-gutter')]
    .map((gutter) => ({
      name: [...gutter.classList].find((name) => name !== 'cm-gutter') ?? 'unnamed',
      left: gutter.getBoundingClientRect().left,
    }))
    .sort((a, b) => a.left - b.left)
    .map((gutter) => gutter.name);
}

function scrollTo(view: EditorView, line: number): void {
  view.dispatch({
    effects: EditorView.scrollIntoView(view.state.doc.line(line).from, { y: 'start' }),
  });
  void view.scrollDOM.offsetHeight;
}

function showBlame(view: EditorView, raw: string | null): void {
  view.dispatch({
    effects: [
      blameCompartment.reconfigure(blameGutter()),
      setGitBlame.of(raw === null ? [] : parseGitBlame(raw)),
    ],
  });
  // CodeMirror measures on a scheduled phase; the layout read forces it.
  void view.scrollDOM.offsetHeight;
}

describe('the blame gutter holds one width', () => {
  let open: Editor | null = null;

  afterEach(() => {
    open?.destroy();
    open = null;
  });

  /**
   * The claim `blameLabel`'s padding exists for. Scrolling from the short
   * names to the long, truncated ones must not move the code.
   *
   * Verified by planting the alternative: dropping the `fit()` padding from
   * `blameLabel`, leaving labels sized to their content as CSS elision would,
   * makes this fail, because the column follows its widest *visible*
   * marker.
   */
  it('is the same width wherever the file is scrolled', () => {
    open = mountEditor(sourceDocument(LINES));
    showBlame(open.view, blameFor(LINES));

    const atTop = columnWidth(open.view);

    scrollTo(open.view, Math.floor(LINES / 2));
    const atBottom = columnWidth(open.view);

    // Sub-pixel equality: a fractional character advance can land either side
    // of a device pixel, and that is not the failure this is watching for.
    expect(Math.abs(atBottom - atTop)).toBeLessThan(1);
    // And the column is real, not a collapsed one that trivially matches.
    expect(atTop).toBeGreaterThan(50);
  });

  /**
   * The claim `initialSpacer` exists for. Between switching blame on and
   * git answering, which is seconds on a large repository, the column must already
   * be its final width, or the code jumps sideways when the answer lands.
   */
  it('is already its final width before any marks arrive', () => {
    open = mountEditor(sourceDocument(LINES));

    showBlame(open.view, null);
    const empty = columnWidth(open.view);

    showBlame(open.view, blameFor(LINES));
    const filled = columnWidth(open.view);

    expect(Math.abs(filled - empty)).toBeLessThan(1);
  });

  /**
   * The column reserves enough room for the label it renders. A label wider
   * than its own column would be clipped by the gutter's overflow, which is
   * the failure a fixed width invites if the padding and the CSS disagree.
   */
  it('gives every label room to render without clipping', () => {
    open = mountEditor(sourceDocument(LINES));
    showBlame(open.view, blameFor(LINES));

    const entries = [...open.view.dom.querySelectorAll<HTMLElement>('.nox-blame-entry')];
    expect(entries.length).toBeGreaterThan(5);
    for (const entry of entries) {
      expect(entry.scrollWidth).toBeLessThanOrEqual(entry.clientWidth + 1);
    }
  });

  /**
   * The other half of what looking at a screenshot found on 2026-08-29, and
   * the half nothing has held since.
   *
   * Blame went in last at first, which put it between the git gutter and the
   * code: the change bars ended up twenty characters from the lines they
   * mark, and the line numbers further still. `extensions.ts` fixes it by
   * listing `blameCompartment` **first**, because `activeGutters` is an
   * ordered facet, and says so in a comment. A comment is not a test, and
   * this is a regression that has already happened once.
   *
   * The whole sequence rather than just "blame is leftmost", and that is
   * deliberate brittleness: a seventh gutter's position is a decision
   * somebody should make on purpose, and a test that names the order is where
   * they will be told they are making it. `cm-gutter-lint` is CodeMirror's
   * own, from `lspDiagnosticsExtension`.
   *
   * Mutation-checked on 2026-08-31, and the first attempt was wrong in a way
   * worth writing down. Moving `blameCompartment.of([])` past
   * `staticExtensions()` changes nothing, because none of those extensions is
   * a gutter: every other column here comes from `configured`, the
   * compartments. Move it past *those* and blame lands fifth, between the
   * change bars and the code, which is the historic defect exactly, and this
   * fails printing the order it got.
   */
  it('puts blame outside every other column, left to right', () => {
    open = mountEditor(sourceDocument(LINES));
    showBlame(open.view, blameFor(LINES));

    expect(gutterOrder(open.view)).toEqual([
      'cm-blameGutter',
      'cm-lineNumbers',
      'cm-foldGutter',
      'cm-provenanceGutter',
      'cm-gitGutter',
      'cm-gutter-lint',
    ]);
  });

  /**
   * With blame off, the same order minus its column. Worth its own case
   * because blame is the one gutter that comes and goes at runtime, so this
   * is what a reader sees for all the time they are not asking about history,
   * and nothing else here exercises that configuration.
   */
  it('leaves the other columns in the same order when blame is off', () => {
    open = mountEditor(sourceDocument(LINES));

    expect(gutterOrder(open.view)).toEqual([
      'cm-lineNumbers',
      'cm-foldGutter',
      'cm-provenanceGutter',
      'cm-gitGutter',
      'cm-gutter-lint',
    ]);
  });

  /**
   * Three pictures, for a human. Not an assertion: the three tests above
   * are, and this one cannot fail in a useful way.
   *
   * It is here because of the failure it answers. Everything else about
   * blame was green before anyone had *seen* it, and looking at the first of
   * these found two things no test reported: the column was half again as
   * wide as it needed to be, all of it dead space between the name and the
   * code; and it was going in to the *right* of the git gutter, pushing the
   * change bars away from the lines they mark. Both are recorded where they
   * were fixed. `npm run test:editor` writes these into `__screenshots__/`,
   * which is gitignored. Run it and open them.
   */
  it('renders', async () => {
    open = mountEditor(sourceDocument(LINES));
    showBlame(open.view, blameFor(LINES));
    await page.screenshot({ path: '__screenshots__/blame-top.png' });

    scrollTo(open.view, Math.floor(LINES / 2));
    await page.screenshot({ path: '__screenshots__/blame-truncated.png' });

    scrollTo(open.view, LINES);
    await page.screenshot({ path: '__screenshots__/blame-uncommitted.png' });
  });
});

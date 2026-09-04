import { afterEach, describe, expect, it } from 'vitest';
import {
  document,
  fastestKeystroke,
  mountEditor,
  mountEditorWithGrammar,
  typeOneCharacterAndFlushMeasure,
  type Editor,
} from './support/keystroke';
import { MAX_DECORATIONS } from '../../src/core/plugin-decorations';
import { applyPluginDecorations } from '../../src/editor/plugin-decorations';

/**
 * The rule that has never had a test.
 *
 * `CONTRIBUTING.md` rule 5 is *"Nothing new on the typing path"*, and it says
 * how to obey it: *"Before adding work that runs per keystroke, per scroll or
 * per cursor move, ask what it costs on a 10 MB file. Prefer viewport-bounded
 * work (`view.visibleRanges`), debouncing, or doing it in Rust."*
 *
 * That rule has been enforced by review alone. This is what it looks like as a
 * check, and the property it pins is the one the rule is actually about:
 * **a keystroke must cost the same in a large document as in a small one.**
 * Viewport-bounded work is flat in document size. Work that scans the document
 * is not, and that is the entire failure mode — an extension that walks every
 * line to decorate it looks perfectly correct, passes every existing test, and
 * makes a big file unusable.
 *
 * A ratio rather than a duration, for the same reason as
 * `tests/complexity.test.ts`: a shared runner's absolute speed divides out, and
 * what survives is whether the cost grew with the document. The absolute
 * numbers belong in a comment where a human reads them, and are below.
 */
describe('the typing path is flat in document size', () => {
  let open: Editor | null = null;

  afterEach(() => {
    open?.destroy();
    open = null;
  });

  const keystrokeAt = (lines: number): number => {
    open?.destroy();
    open = mountEditor(document(lines));
    const ms = fastestKeystroke(open.view);
    open.destroy();
    open = null;
    return ms;
  };

  /**
   * 8x the document for the same keystroke.
   *
   * **Measured flat, across far more than the 8x this asserts.** In chromium,
   * best-of-seven batches: 500 lines 0.32 ms, 2,000 lines 0.31 ms, 8,000 lines
   * 0.25 ms, 16,000 lines 0.34 ms, 64,000 lines (4 MB) 0.26 ms. There is no
   * trend in that at all over a 140x range of document size, which is exactly
   * what viewport-bounded work is supposed to look like.
   *
   * **Budget 3x, from the noise.** Thirty local samples of this ratio ran
   * **0.77x to 1.42x** — the spread is the browser, not the document. 3x sits
   * at 2.1x the worst of that, which is the flakiness margin that matters:
   * `enforce_admins` is on, so a false failure here blocks everyone with no
   * override.
   *
   * **Verified by planting the regression rule 5 forbids** — a `ViewPlugin`
   * decorating every line in the document instead of `view.visibleRanges`.
   * It reports **4.13x** and fails this. Note what that number is *not*: the
   * first draft of this comment guessed ~8x, on the reasoning that 8x the
   * document means 8x the scan. It does not, because the scan is added to a
   * fixed per-keystroke baseline that both sizes pay — so the ratio is diluted
   * and a *mild* document-wide scan is the hardest kind to catch. That is the
   * argument for 3x rather than 4x, and for reading the numbers above when
   * something here changes.
   */
  it('costs the same at 16,000 lines as at 2,000', () => {
    const small = keystrokeAt(2_000);
    const large = keystrokeAt(16_000);
    const ratio = large / small;

    expect(
      ratio,
      `keystroke: ${ratio.toFixed(2)}x for 8x the document ` +
        `(budget 3x; flat is ~1x, a per-line document scan measured 4.13x) ` +
        `[${small.toFixed(3)}ms -> ${large.toFixed(3)}ms]`,
    ).toBeLessThan(3);
  });

  /**
   * The absolute half of the question, which a ratio cannot answer: a keystroke
   * can be perfectly flat and still be too slow.
   *
   * Deliberately loose, and deliberately not a stopwatch on a shared runner —
   * §4 is explicit that wall-clock there means little. 8 ms is half a frame,
   * and the measurement is **0.34 ms** at 16,000 lines, so this clears by 23x.
   * It fails only if something has gone very wrong indeed, which is the only
   * claim worth making from a machine whose speed nobody controls.
   *
   * The planted document-scan above does *not* fail this one — it reached
   * 2.35 ms, still inside half a frame. The ratio is what catches that class
   * of regression; this is here for the class that a ratio cannot see, where
   * everything grew at once.
   */
  it('leaves most of the frame for everything else', () => {
    const ms = keystrokeAt(16_000);
    expect(ms, `keystroke at 16,000 lines took ${ms.toFixed(2)}ms`).toBeLessThan(8);
  });
});

/**
 * The same claim, with a real grammar attached and fully parsed — the case
 * the suite above cannot see (A4-013).
 *
 * `mountEditor` builds a state with no language, so `syntaxTree(state)` is
 * empty and every extension keyed on it (sticky scroll, folding, bracket
 * matching, `indentOnInput`) runs against nothing: a document-sized walk
 * behind one of those looks exactly as flat as no walk at all. A4-001
 * shipped precisely that — sticky scroll walking the whole parsed tree on
 * every keystroke once a large file's tree was fully parsed, a normal
 * thing to have happened (scrolling to the end, a session restored near the
 * bottom, the symbol palette's own forced parse) — and this suite, as it
 * stood, would not have failed on it.
 *
 * `mountEditorWithGrammar` is what closes the first half of that gap:
 * TypeScript's grammar, attached directly and parsed in full before the
 * first keystroke, on top of every other extension `mountEditor` already
 * carries. `typeOneCharacterAndFlushMeasure` closes the second, and matters
 * more than it looks: sticky scroll's expensive walk runs inside a
 * `requestMeasure` write phase, which is scheduled on the next animation
 * frame and never reached by a tight loop of dispatches with no frame in
 * between — confirmed by instrumenting `sticky.ts`'s `paint` during a plain
 * `typeOneCharacter` batch here and finding it ran zero times. A keystroke
 * timed that way would report this suite flat regardless of what sticky
 * scroll did, for the same reason `mountEditor`'s missing grammar did: not
 * because the work is cheap, but because the harness never asked for it.
 */
describe('the typing path is flat in document size, with a real grammar attached', () => {
  let open: Editor | null = null;

  afterEach(() => {
    open?.destroy();
    open = null;
  });

  const keystrokeAt = (lines: number): number => {
    open?.destroy();
    open = mountEditorWithGrammar(document(lines));
    const ms = fastestKeystroke(open.view, 7, 20, typeOneCharacterAndFlushMeasure);
    open.destroy();
    open = null;
    return ms;
  };

  /**
   * Same budget and same shape as the undecorated case above: 8x the
   * document for the same keystroke, flat is ~1x. A4-001's own walk
   * measured 8.20 ms at 16,000 lines against 1.50 ms at 2,000 — a ~5.5x
   * ratio, comfortably past this budget — so a reintroduced document-sized
   * walk behind any grammar-keyed extension has room to be caught here
   * before it reaches the 3x line.
   */
  it('costs the same at 16,000 lines as at 2,000', () => {
    const small = keystrokeAt(2_000);
    const large = keystrokeAt(16_000);
    const ratio = large / small;

    expect(
      ratio,
      `keystroke (grammar attached): ${ratio.toFixed(2)}x for 8x the document ` +
        `(budget 3x; flat is ~1x) [${small.toFixed(3)}ms -> ${large.toFixed(3)}ms]`,
    ).toBeLessThan(3);
  });
});

/**
 * The same rule, asked of the one feature most able to break it.
 *
 * A plugin's decorations are a `RangeSet` in state, and every edit maps that
 * set forward. That is real per-keystroke work, and it is the only work
 * plugins put on this path — so the question is not whether it costs anything
 * but whether it grows with the **document**. It must not: mapping is
 * proportional to how many marks there are, which is capped, and the cap is
 * `MAX_DECORATIONS`.
 *
 * Filled to the cap on purpose. A test with three decorations would prove
 * nothing about a linter that found two thousand.
 *
 * **Measured: 0.82x for 8x the document** — 0.387 ms at 2,000 lines against
 * 0.320 ms at 16,000, both carrying 2,000 marks. So the marks cost about
 * 0.08 ms against the undecorated 0.31 ms baseline, and that cost does not
 * move with the document, which is the whole claim.
 */
describe('a fully decorated buffer still types flat', () => {
  let open: Editor | null = null;

  afterEach(() => {
    open?.destroy();
    open = null;
  });

  /** A keystroke in a document carrying the maximum number of plugin marks. */
  const decoratedKeystrokeAt = (lines: number): number => {
    open?.destroy();
    open = mountEditor(document(lines));

    const length = open.view.state.doc.length;
    // Spread across the whole document rather than bunched at the top, so the
    // ones outside the viewport are mapped too — which is the cost being
    // measured. Non-overlapping and ascending, as `RangeSet.of` requires.
    const step = Math.floor(length / MAX_DECORATIONS);
    const decorations = Array.from({ length: MAX_DECORATIONS }, (_, i) => ({
      from: i * step,
      to: i * step + Math.min(4, step - 1),
      kind: 'warning' as const,
    })).filter((d) => d.to > d.from && d.to <= length);

    applyPluginDecorations(open.view, decorations);

    const ms = fastestKeystroke(open.view);
    open.destroy();
    open = null;
    return ms;
  };

  it('costs the same at 16,000 lines as at 2,000, with 2,000 marks in each', () => {
    const small = decoratedKeystrokeAt(2_000);
    const large = decoratedKeystrokeAt(16_000);
    const ratio = large / small;

    // Same budget as the undecorated case, and it has to be: the whole claim
    // is that decorations cost by their own count and not by the document.
    expect(
      ratio,
      `decorated keystroke: ${ratio.toFixed(2)}x for 8x the document ` +
        `(budget 3x) [${small.toFixed(3)}ms -> ${large.toFixed(3)}ms]`,
    ).toBeLessThan(3);
  });
});

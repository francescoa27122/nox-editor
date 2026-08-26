import { afterEach, describe, expect, it } from 'vitest';
import { document, fastestKeystroke, mountEditor, type Editor } from './support/keystroke';

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

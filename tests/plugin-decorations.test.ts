import { describe, expect, it } from 'vitest';
import {
  MAX_DECORATIONS,
  MAX_MESSAGE_LENGTH,
  normaliseDecorations,
} from '../src/core/plugin-decorations';

/**
 * Making a plugin's ranges safe to draw.
 *
 * Every case here is a number a third party sent. Most of them are merely
 * wrong; **one class of them takes the editor down**, and that is why this is
 * the strictest normaliser after the manifest parser: CodeMirror throws on a
 * range outside the document, from inside a view update, where the failure is
 * not a missing decoration but a dead editor.
 *
 * `editor/lsp.ts` already clamps language-server ranges for exactly this. A
 * plugin has less excuse and no specification behind it.
 */

const DOC = 100;
const ok = (from: number, to: number) => ({ from, to, kind: 'error' as const });

describe('ranges that would throw', () => {
  it('clamps one that runs past the end of the document', () => {
    const { decorations } = normaliseDecorations([ok(90, 999)], DOC);

    expect(decorations).toEqual([{ from: 90, to: DOC, kind: 'error' }]);
  });

  it('clamps a negative start rather than dropping the mark', () => {
    const { decorations } = normaliseDecorations([ok(-50, 10)], DOC);

    expect(decorations[0]?.from).toBe(0);
  });

  it('drops an inverted range instead of dispatching it backwards', () => {
    const { decorations, dropped } = normaliseDecorations([ok(50, 20)], DOC);

    expect(decorations).toEqual([]);
    expect(dropped).toBe(1);
  });

  it('drops an empty one, which draws nothing and costs a mapping anyway', () => {
    expect(normaliseDecorations([ok(10, 10)], DOC).decorations).toEqual([]);
  });

  it('drops a range that clamps down to nothing', () => {
    // Entirely past the end: both ends clamp to the document length, so what
    // survives clamping is empty.
    expect(normaliseDecorations([ok(500, 600)], DOC).decorations).toEqual([]);
  });

  it('refuses numbers that are not numbers', () => {
    const { decorations, dropped } = normaliseDecorations(
      [
        { from: '0', to: 5, kind: 'error' },
        { from: 0, to: Number.NaN, kind: 'error' },
        { from: 0, to: Number.POSITIVE_INFINITY, kind: 'error' },
      ],
      DOC,
    );

    expect(decorations).toEqual([]);
    expect(dropped).toBe(3);
  });

  it('floors a fractional offset rather than handing CodeMirror one', () => {
    expect(normaliseDecorations([ok(1.7, 9.2)], DOC).decorations[0]).toEqual({
      from: 1,
      to: 9,
      kind: 'error',
    });
  });
});

describe('sorting', () => {
  it('puts them in document order, because RangeSet.of demands it', () => {
    // A linter that reports by rule rather than by position emits them out of
    // order as a matter of course. That is not a mistake on its part, and
    // `RangeSet.of` throws on it.
    const { decorations } = normaliseDecorations([ok(80, 90), ok(10, 20), ok(40, 50)], DOC);

    expect(decorations.map((d) => d.from)).toEqual([10, 40, 80]);
  });

  it('breaks a tie on the end, so the order is total', () => {
    const { decorations } = normaliseDecorations([ok(10, 30), ok(10, 20)], DOC);

    expect(decorations.map((d) => d.to)).toEqual([20, 30]);
  });
});

describe('the vocabulary', () => {
  it('takes the four kinds Nox knows how to draw', () => {
    for (const kind of ['error', 'warning', 'info', 'highlight']) {
      expect(normaliseDecorations([{ from: 0, to: 5, kind }], DOC).decorations).toHaveLength(1);
    }
  });

  it('drops one it cannot draw rather than inventing a style', () => {
    // A plugin choosing its own class would be a plugin choosing how Nox
    // looks. It names what it means; Nox decides how that is drawn.
    const { decorations, dropped } = normaliseDecorations(
      [{ from: 0, to: 5, kind: 'blink-red' }],
      DOC,
    );

    expect(decorations).toEqual([]);
    expect(dropped).toBe(1);
  });
});

describe('the caps', () => {
  it('stops at the decoration cap and counts the rest', () => {
    const many = Array.from({ length: MAX_DECORATIONS + 10 }, () => ok(0, 5));
    const { decorations, dropped } = normaliseDecorations(many, DOC);

    // Finite because the set is mapped forward through every edit, and that
    // mapping is the one cost decorations put on the typing path.
    expect(decorations).toHaveLength(MAX_DECORATIONS);
    expect(dropped).toBe(10);
  });

  it('truncates a hover message', () => {
    const { decorations } = normaliseDecorations(
      [{ ...ok(0, 5), message: 'm'.repeat(MAX_MESSAGE_LENGTH + 50) }],
      DOC,
    );

    expect(decorations[0]?.message).toHaveLength(MAX_MESSAGE_LENGTH);
  });
});

describe('what it is handed', () => {
  it('survives something that is not a list', () => {
    expect(normaliseDecorations('decorate please', DOC).decorations).toEqual([]);
    expect(normaliseDecorations(null, DOC).decorations).toEqual([]);
  });

  it('skips one bad entry without losing the good ones', () => {
    const { decorations, dropped } = normaliseDecorations([ok(0, 5), 'nope', ok(10, 15)], DOC);

    expect(decorations).toHaveLength(2);
    expect(dropped).toBe(1);
  });

  it('handles an empty document without producing anything', () => {
    expect(normaliseDecorations([ok(0, 10)], 0).decorations).toEqual([]);
  });
});

// @vitest-environment jsdom
import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { guideDepths } from '../src/core/indent-guides';
import { buildGuideDecorations } from '../src/editor/indent-guides';
import { MemoryPlatform } from '../src/platform/memory';
import { sourceFile } from './support/corpus';
import { describeGrowth, growth } from './support/growth';

/**
 * Indent guides: one hairline per level of nesting, beside the code.
 *
 * Two halves. `guideDepths` is the decision, a pure function over line text
 * that says how many guides each line gets, and it is what the rules below
 * pin. `buildGuideDecorations` is the rendering, and the one thing worth
 * testing about it is rule 5 of CONTRIBUTING: it decorates the ranges it is
 * handed and nothing outside them, so the per-keystroke cost is the
 * viewport's, not the document's. The typing-path browser test measures
 * that claim; this checks the mechanism it rests on.
 */

describe('guideDepths', () => {
  it('counts one guide per indent unit of leading space', () => {
    expect(guideDepths(['a', '  b', '    c', '  d'], 2)).toEqual([0, 1, 2, 1]);
  });

  it('treats a tab as one level however wide the unit is', () => {
    expect(guideDepths(['\tx', '\t\ty'], 4)).toEqual([1, 2]);
  });

  /**
   * A tab advances to the next stop rather than adding a fixed width, so
   * two spaces and a tab under a four-wide unit is column 4, one level, and
   * not column 6.
   */
  it('advances a tab to the next stop when it follows spaces', () => {
    expect(guideDepths(['  \tx'], 4)).toEqual([1]);
  });

  /**
   * A blank line inside a block keeps the block's guides so the column does
   * not flicker off between two lines that share it; a blank line between
   * two blocks takes the shallower one, so a guide never appears where
   * neither neighbour has it. A missing neighbour counts as depth zero.
   */
  it('gives a blank line the shallower of its neighbours', () => {
    expect(guideDepths(['  a', '', '    b', '', 'c'], 2)).toEqual([1, 1, 2, 0, 0]);
    expect(guideDepths(['', '  a', ''], 2)).toEqual([0, 1, 0]);
  });

  it('rounds a partial level down rather than drawing a guide inside the text', () => {
    expect(guideDepths(['   x'], 4)).toEqual([0]);
  });

  /**
   * Linear in the number of lines, and in the leading whitespace of each,
   * which the guard below holds to the file's usual 24x budget for an 8x
   * input. A whole-document scan is what rule 5 forbids; this is the one
   * that has to be cheap because the viewport calls it on every keystroke.
   */
  it('costs in proportion to the lines it is given', () => {
    const g = growth(
      (lines) => sourceFile(lines).split('\n'),
      (text) => void guideDepths(text, 2),
      2_000,
      16_000,
    );
    expect(g.ratio, describeGrowth('guideDepths', g, 24)).toBeLessThan(24);
  });
});

describe('buildGuideDecorations', () => {
  const doc = Text.of(
    Array.from({ length: 100 }, (_, i) => `${' '.repeat((i % 4) * 2)}line ${i + 1}`),
  );

  /** Every decorated line, as `[lineNumber, guides]`. */
  function decorated(from: number, to: number): [number, number][] {
    const set = buildGuideDecorations(doc, [{ from, to }], 2);
    const out: [number, number][] = [];
    const cursor = set.iter();
    while (cursor.value) {
      const style = String(cursor.value.spec.attributes?.style ?? '');
      const guides = Number(/--guides:\s*(\d+)/.exec(style)?.[1] ?? NaN);
      out.push([doc.lineAt(cursor.from).number, guides]);
      cursor.next();
    }
    return out;
  }

  it('decorates only the lines inside the ranges it is handed', () => {
    const from = doc.line(11).from;
    const to = doc.line(20).to;
    const lines = decorated(from, to).map(([line]) => line);

    expect(Math.min(...lines)).toBeGreaterThanOrEqual(11);
    expect(Math.max(...lines)).toBeLessThanOrEqual(20);
  });

  it('carries each line its guide count and skips lines with none', () => {
    const rows = decorated(doc.line(1).from, doc.line(8).to);
    // Lines 1..8 indent by (i % 4) * 2 spaces: depths 0,1,2,3,0,1,2,3.
    expect(rows).toEqual([
      [2, 1],
      [3, 2],
      [4, 3],
      [6, 1],
      [7, 2],
      [8, 3],
    ]);
  });
});

describe('the setting', () => {
  it('is on by default, and the command turns it off and on', async () => {
    const app = new NoxApp(new MemoryPlatform());
    expect(app.config.get('editor.indentGuides')).toBe(true);

    expect(await app.commands.execute('view.toggleIndentGuides')).toBe(true);
    expect(app.config.get('editor.indentGuides')).toBe(false);

    await app.commands.execute('view.toggleIndentGuides');
    expect(app.config.get('editor.indentGuides')).toBe(true);
  });
});

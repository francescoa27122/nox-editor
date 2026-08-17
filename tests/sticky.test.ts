import { readFileSync } from 'node:fs';
import { parser as jsParser } from '@lezer/javascript';
import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { fileSymbols, stickyRows } from '../src/core/symbols';

const ts = jsParser.configure({ dialect: 'ts' });

/**
 * A class holding a method holding a loop. Three levels of source and two
 * levels of *symbol*, because the loop is not a declaration — which is what
 * makes it useful for pinning down that blocks do not pin.
 */
const SOURCE = [
  'class Service {', // 1
  '  async reveal(path) {', // 2
  '    for (const segment of path) {', // 3
  '      load(segment);', // 4
  '    }', // 5
  '  }', // 6
  '}', // 7
  '', // 8
  'function after() {}', // 9
].join('\n');

/** The rows at `topLine`, as "depth:text" strings. */
function rowsAt(source: string, topLine: number, max = 5): string[] {
  const doc = Text.of(source.split('\n'));
  const symbols = fileSymbols(ts.parse(source), doc);
  return stickyRows(symbols, topLine, doc, max).map((row) => `${row.depth}:${row.text}`);
}

describe('what stays pinned while scrolling', () => {
  /**
   * The failure this prevents: a strip that pins nothing, or that pins the
   * innermost thing only. Standing inside a method inside a class, both are
   * what you have lost off the top of the screen, and the order has to read
   * outermost-first so the strip nests the way the code does.
   */
  it('pins every enclosing declaration, outermost first', () => {
    expect(rowsAt(SOURCE, 4)).toEqual([
      '0:class Service {',
      '1:async reveal(path) {',
    ]);
  });

  /**
   * The failure this prevents, and it is the rule the whole feature rests on:
   * a declaration that is *still on screen* must not be pinned. Line 2 is
   * `async reveal(path) {` itself, so pinning it would print that line twice —
   * once in the strip and once in the document directly below — and cost a row
   * of editor height to say nothing.
   *
   * Wrong only at the boundary, which is why the boundary is the test. A rule
   * written as "contains the top line" instead of "starts above it" passes
   * every other case in this file.
   */
  it('does not pin a declaration whose own line is still visible', () => {
    expect(rowsAt(SOURCE, 2)).toEqual(['0:class Service {']);
  });

  /**
   * The line above: at the top of the file nothing has scrolled away yet, so
   * the strip is empty rather than pinning the class you can plainly see.
   */
  it('pins nothing at the first line of the file', () => {
    expect(rowsAt(SOURCE, 1)).toEqual([]);
  });

  /**
   * The failure this prevents: pinning a declaration you have scrolled *past*.
   * Line 9 is after `Service` has closed, so nothing encloses it — a rule that
   * tested only "starts above" and forgot "still open" would pin the class
   * here, naming a scope that ended two lines earlier.
   */
  it('pins nothing once the enclosing declaration has closed', () => {
    expect(rowsAt(SOURCE, 9)).toEqual([]);
  });

  /**
   * The failure this prevents: an implementation that applies "still open"
   * only up to the first qualifying symbol, then pins everything else that
   * merely starts above `topLine` regardless of whether it has closed. Line 7
   * is the class's own closing brace: the class (1–7) is still open there but
   * the method (2–6) is not, so a mixed depth is exercised — every other
   * `topLine` in this file has either both open or both closed, and a passing
   * suite without this case did not tell the two implementations apart.
   */
  it('excludes a closed inner declaration while its outer one is still open', () => {
    expect(rowsAt(SOURCE, 7)).toEqual(['0:class Service {']);
  });

  /**
   * The failure this prevents: an implementation that scans in document order
   * and stops at the first symbol that does not qualify, instead of skipping
   * it and continuing. `before` closes on line 3, long before the enclosing
   * `Service`/`reveal` chain even starts — a scan that breaks there returns
   * nothing for a line that plainly has two enclosing declarations. As with
   * the case above, no `topLine` in `SOURCE` alone puts a closed declaration
   * *before* the open chain, so this was not previously exercised.
   */
  it('does not stop scanning at a closed declaration preceding the enclosing chain', () => {
    const source = [
      'function before() {', // 1
      '  x();', // 2
      '}', // 3
      '', // 4
      'class Service {', // 5
      '  async reveal(path) {', // 6
      '    load(path);', // 7
      '  }', // 8
      '}', // 9
    ].join('\n');
    expect(rowsAt(source, 7)).toEqual(['0:class Service {', '1:async reveal(path) {']);
  });

  /**
   * The failure this prevents: blocks creeping in. `for` is not a declaration
   * and `core/symbols.ts` does not collect it, so the strip must show two rows
   * here and not three. This is the shared-rule-table decision from the spec's
   * §2, asserted where a future change to the table would break it.
   */
  it('does not pin control blocks', () => {
    expect(rowsAt(SOURCE, 4)).toHaveLength(2);
  });

  /**
   * The failure this prevents: a row carrying the qualified name rather than
   * the source. `Service.reveal` is right for a searchable list; the line the
   * reader was looking at is what they are trying to recover, and it has to
   * arrive without its indentation because the strip supplies its own.
   */
  it('carries the declaration source line, trimmed, and where to jump to', () => {
    const doc = Text.of(SOURCE.split('\n'));
    const rows = stickyRows(fileSymbols(ts.parse(SOURCE), doc), 4, doc, 5);
    expect(rows[1]?.text).toBe('async reveal(path) {');
    // `from` addresses the declaration itself, so clicking a row lands on it.
    expect(doc.lineAt(rows[1]?.from ?? 0).number).toBe(2);
  });

  /**
   * The failure this prevents: an unbounded strip eating the editor on deeply
   * nested code. Truncating from the innermost keeps a contiguous run from the
   * outside in; dropping the outermost instead would leave an inner scope
   * floating with nothing to anchor it.
   */
  it('caps the rows, keeping the outermost', () => {
    const nested = [
      'class A {', // 1
      '  m() {', // 2
      '    function inner() {', // 3
      '      here();', // 4
      '    }', // 5
      '  }', // 6
      '}', // 7
    ].join('\n');
    expect(rowsAt(nested, 4, 3)).toHaveLength(3);
    expect(rowsAt(nested, 4, 2)).toEqual(['0:class A {', '1:m() {']);
  });

  /**
   * The failure this prevents: throwing on a file with no structure, which is
   * every plain-text file and every language with no parser. The strip is
   * empty; it is not an error.
   */
  it('returns nothing for a document with no symbols', () => {
    expect(rowsAt('const a = 1;\nconst b = 2;\n', 2)).toEqual([]);
  });

  /**
   * Not a threshold test, and deliberately not an assertion about wall clock:
   * spec §11 asks whether the linear filter is worth replacing with a sorted
   * array and a binary search, and that question needs a number rather than an
   * opinion. `src/app.ts` is the largest real file in this repo, so its symbol
   * count is the one the answer should be based on.
   *
   * Prints rather than asserts. A wall-clock assertion here would be the same
   * bet `tests/symbols.test.ts` had to be rewritten to stop making — its comment
   * claimed ~40 chars/ms and a 60x margin against a measured ~2,437 chars/ms and
   * 3.5x.
   */
  it('reports what one sticky recompute costs on a real file', () => {
    const source = readFileSync('src/app.ts', 'utf8');
    const doc = Text.of(source.split('\n'));
    const symbols = fileSymbols(ts.parse(source), doc);

    const start = performance.now();
    const ITERATIONS = 1000;
    for (let i = 0; i < ITERATIONS; i++) stickyRows(symbols, 1500, doc, 5);
    const perCall = (performance.now() - start) / ITERATIONS;

    console.log(`sticky: ${symbols.length} symbols, ${perCall.toFixed(4)} ms per recompute`);
    expect(symbols.length).toBeGreaterThan(50);
  });
});

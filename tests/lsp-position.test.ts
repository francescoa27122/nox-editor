import { describe, expect, it } from 'vitest';
import { offsetAt, positionAt } from '../src/core/lsp-position';

/**
 * LSP positions to string offsets.
 *
 * Mechanical enough to look not worth testing, which is exactly why it is:
 * every failure here is an off-by-one that lands a squiggle on the wrong
 * column and looks entirely plausible while doing it.
 */

const CRLF_DOC = 'alpha\r\nbeta\r\ngamma';

describe('offsetAt', () => {
  it('finds a position on the first line', () => {
    expect(offsetAt('const a = 1;\nconst b = 2;\n', { line: 0, character: 6 })).toBe(6);
  });

  it('finds a position on a later line', () => {
    expect(offsetAt('const a = 1;\nconst b = 2;\n', { line: 1, character: 6 })).toBe(19);
  });

  it('counts UTF-16 code units, so an emoji spans two characters', () => {
    // One code point, two UTF-16 code units — which is what LSP counts and
    // what a JavaScript string index counts. They agree, and this is the test
    // that says so out loud.
    expect(offsetAt('a\u{1F642}b', { line: 0, character: 3 })).toBe(3);
  });

  it('treats CRLF as a terminator rather than content', () => {
    // Every file in this repository is CRLF. A carriage return counted as
    // content on the line would shift every column after it.
    const text = 'const a = 1;\r\nconst b = 2;\r\n';
    expect(offsetAt(text, { line: 1, character: 0 })).toBe(14);
  });

  it('clamps a column past the visible end of a CRLF line', () => {
    const text = 'const a = 1;\r\nconst b = 2;\r\n';
    expect(offsetAt(text, { line: 0, character: 99 })).toBe(12);
  });

  it('clamps a line past the end of the document', () => {
    expect(offsetAt('a\nb', { line: 99, character: 0 })).toBe(3);
  });

  it('clamps a negative position rather than returning one', () => {
    expect(offsetAt('abc', { line: -1, character: -5 })).toBe(0);
  });
});

describe('positionAt', () => {
  it('is the inverse of offsetAt at every addressable offset', () => {
    // Every offset except one sitting inside a line terminator: an LSP
    // position cannot point between the carriage return and the newline, so
    // no implementation can round-trip one. Asserting that it did would be
    // asserting a property of the format rather than of this code.
    for (const offset of [0, 3, 5, 7, 10, 11, 13, 17, CRLF_DOC.length]) {
      expect(offsetAt(CRLF_DOC, positionAt(CRLF_DOC, offset))).toBe(offset);
    }
  });

  it('never reports a character past the end of its line', () => {
    // Offset 12 is the newline of a CRLF pair, on a line four characters
    // long. A position of character 5 there is out of range — and keeping
    // out-of-range positions away from CodeMirror is what this module is for.
    expect(positionAt(CRLF_DOC, 12)).toEqual({ line: 1, character: 4 });
  });

  it('reports the line an offset falls on', () => {
    expect(positionAt('alpha\nbeta', 7)).toEqual({ line: 1, character: 1 });
  });

  it('clamps an offset past the end', () => {
    expect(positionAt('a\nb', 99)).toEqual({ line: 1, character: 1 });
  });
});

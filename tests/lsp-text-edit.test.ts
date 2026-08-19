import { describe, expect, it } from 'vitest';
import { changesOf, textEditsOf } from '../src/core/lsp-text-edit';

const range = (line: number, from: number, to: number) => ({
  start: { line, character: from },
  end: { line, character: to },
});

describe('textEditsOf', () => {
  it('is empty for null and for anything that is not a list', () => {
    expect(textEditsOf(null)).toEqual([]);
    expect(textEditsOf({ range: range(0, 0, 1), newText: 'x' })).toEqual([]);
  });

  it('keeps well-formed edits in order and drops the rest', () => {
    expect(
      textEditsOf([
        { range: range(1, 0, 2), newText: 'b' },
        { range: range(0, 0, 1) },
        { range: { start: { line: 0, character: -1 }, end: { line: 0, character: 1 } }, newText: 'x' },
        null,
        { range: range(0, 0, 1), newText: 'a' },
      ]),
    ).toEqual([
      { range: range(1, 0, 2), newText: 'b' },
      { range: range(0, 0, 1), newText: 'a' },
    ]);
  });
});

describe('changesOf', () => {
  const text = 'const  x=1\nlet y\n';

  it('converts positions against the text the edits were made for', () => {
    expect(changesOf(text, [{ range: range(0, 5, 7), newText: ' ' }])).toEqual([
      { from: 5, to: 7, insert: ' ' },
    ]);
    // Line 1 starts at 11.
    expect(changesOf(text, [{ range: range(1, 0, 3), newText: 'var' }])).toEqual([
      { from: 11, to: 14, insert: 'var' },
    ]);
  });

  it('clamps an inverted range so it cannot become a backwards change', () => {
    expect(changesOf(text, [{ range: { start: { line: 0, character: 7 }, end: { line: 0, character: 5 } }, newText: '' }])).toEqual([
      { from: 7, to: 7, insert: '' },
    ]);
  });

  it('keeps an edit at the end of the text: that is how a final newline is added', () => {
    const noNewline = 'a';
    expect(changesOf(noNewline, [{ range: range(0, 1, 1), newText: '\n' }])).toEqual([
      { from: 1, to: 1, insert: '\n' },
    ]);
  });

  it('turns an edit aimed past the end into an append rather than an offset that throws', () => {
    expect(changesOf('a\n', [{ range: range(9, 0, 0), newText: 'z' }])).toEqual([
      { from: 2, to: 2, insert: 'z' },
    ]);
  });
});

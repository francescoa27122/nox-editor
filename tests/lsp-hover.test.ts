import { describe, expect, it } from 'vitest';
import { hoverBlocks } from '../src/core/lsp-hover';

/**
 * The three shapes LSP `contents` can take, reduced to blocks Nox renders.
 *
 * The object form of `MarkedString` is the one worth watching: it carries a
 * language and is therefore code, even with no fence around it. Missing that
 * renders a type signature as a paragraph.
 */

describe('the three shapes of contents', () => {
  it('reads MarkupContent', () => {
    expect(hoverBlocks({ kind: 'markdown', value: 'A number.' })).toEqual([
      { kind: 'prose', text: 'A number.' },
    ]);
  });

  it('reads a bare string as prose', () => {
    expect(hoverBlocks('A number.')).toEqual([{ kind: 'prose', text: 'A number.' }]);
  });

  it('reads a language-tagged MarkedString as code, fence or no fence', () => {
    expect(hoverBlocks({ language: 'typescript', value: 'const n: number' })).toEqual([
      { kind: 'code', text: 'const n: number' },
    ]);
  });

  it('reads an array mixing all three, in order', () => {
    expect(
      hoverBlocks([
        { language: 'typescript', value: 'const n: number' },
        'Holds the answer.',
        { kind: 'markdown', value: 'See also.' },
      ]),
    ).toEqual([
      { kind: 'code', text: 'const n: number' },
      { kind: 'prose', text: 'Holds the answer.' },
      { kind: 'prose', text: 'See also.' },
    ]);
  });
});

describe('fenced blocks', () => {
  it('splits a fence out of the prose around it, keeping the order', () => {
    const value = 'Before.\n```ts\nconst n: number\n```\nAfter.';

    expect(hoverBlocks({ kind: 'markdown', value })).toEqual([
      { kind: 'prose', text: 'Before.' },
      { kind: 'code', text: 'const n: number' },
      { kind: 'prose', text: 'After.' },
    ]);
  });

  it('drops the language tag rather than showing it as a line of code', () => {
    expect(hoverBlocks({ kind: 'markdown', value: '```typescript\nconst n: number\n```' })).toEqual([
      { kind: 'code', text: 'const n: number' },
    ]);
  });

  it('handles a fence with no language tag', () => {
    expect(hoverBlocks({ kind: 'markdown', value: '```\nplain\n```' })).toEqual([
      { kind: 'code', text: 'plain' },
    ]);
  });

  it('treats an unterminated fence as code to its end', () => {
    // A truncated hover string should still show its signature rather than
    // the fence characters.
    expect(hoverBlocks({ kind: 'markdown', value: 'Note.\n```ts\nconst n: number' })).toEqual([
      { kind: 'prose', text: 'Note.' },
      { kind: 'code', text: 'const n: number' },
    ]);
  });

  it('keeps several fences apart', () => {
    const value = '```ts\nfirst\n```\nmid\n```ts\nsecond\n```';

    expect(hoverBlocks({ kind: 'markdown', value }).map((b) => b.kind)).toEqual([
      'code',
      'prose',
      'code',
    ]);
  });
});

describe('nothing to show', () => {
  it('reduces an empty string to no blocks', () => {
    // No tooltip at all, rather than an empty box following the pointer.
    expect(hoverBlocks({ kind: 'markdown', value: '' })).toEqual([]);
  });

  it('reduces whitespace to no blocks', () => {
    expect(hoverBlocks({ kind: 'markdown', value: '   \n\n  ' })).toEqual([]);
  });

  it('reduces an empty array to no blocks', () => {
    expect(hoverBlocks([])).toEqual([]);
  });

  it('reduces null and undefined to no blocks', () => {
    expect(hoverBlocks(null)).toEqual([]);
    expect(hoverBlocks(undefined)).toEqual([]);
  });

  it('drops an empty entry from an array without dropping its neighbours', () => {
    expect(hoverBlocks(['', 'kept', { kind: 'markdown', value: '  ' }])).toEqual([
      { kind: 'prose', text: 'kept' },
    ]);
  });
});

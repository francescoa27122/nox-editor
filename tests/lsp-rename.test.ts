import { describe, expect, it } from 'vitest';
import { prepareRenameSeed } from '../src/core/lsp-rename';

const range = (line: number, from: number, to: number) => ({
  start: { line, character: from },
  end: { line, character: to },
});

describe('prepareRenameSeed', () => {
  const textAt = (r: { start: { line: number; character: number } }) => `text@${r.start.line}:${r.start.character}`;

  it('is null when the server says there is nothing here to rename', () => {
    expect(prepareRenameSeed(null, 'word', textAt)).toBeNull();
  });

  it('uses the placeholder when there is one', () => {
    expect(prepareRenameSeed({ range: range(0, 6, 11), placeholder: 'total' }, 'word', textAt)).toBe('total');
  });

  it('uses the text the range names when there is only a range', () => {
    expect(prepareRenameSeed(range(0, 6, 11), 'word', textAt)).toBe('text@0:6');
  });

  it('falls back to the word under the cursor for defaultBehavior, and for anything unreadable', () => {
    expect(prepareRenameSeed({ defaultBehavior: true }, 'word', textAt)).toBe('word');
    expect(prepareRenameSeed({ nonsense: 1 }, 'word', textAt)).toBe('word');
  });
});

import { describe, expect, it } from 'vitest';
import { prepareRenameSeed, renameEdits } from '../src/core/lsp-rename';

const range = (line: number, from: number, to: number) => ({
  start: { line, character: from },
  end: { line, character: to },
});

describe('renameEdits', () => {
  it('is empty for null, which is a server declining to rename', () => {
    expect(renameEdits(null)).toEqual({ files: [], unsupported: [] });
  });

  it('reads the `changes` map, one entry per file', () => {
    const plan = renameEdits({
      changes: {
        'file:///w/a.ts': [{ range: range(0, 6, 11), newText: 'sum' }],
        'file:///w/b.ts': [
          { range: range(1, 12, 17), newText: 'sum' },
          { range: range(0, 9, 14), newText: 'sum' },
        ],
      },
    });
    expect(plan.unsupported).toEqual([]);
    expect(plan.files).toEqual([
      { uri: 'file:///w/a.ts', edits: [{ range: range(0, 6, 11), newText: 'sum' }] },
      {
        uri: 'file:///w/b.ts',
        edits: [
          { range: range(1, 12, 17), newText: 'sum' },
          { range: range(0, 9, 14), newText: 'sum' },
        ],
      },
    ]);
  });

  it('reads `documentChanges`, merging entries for one file', () => {
    const plan = renameEdits({
      documentChanges: [
        { textDocument: { uri: 'file:///w/a.ts', version: 3 }, edits: [{ range: range(0, 6, 11), newText: 'sum' }] },
        { textDocument: { uri: 'file:///w/a.ts', version: 3 }, edits: [{ range: range(2, 0, 5), newText: 'sum' }] },
      ],
    });
    expect(plan.files).toEqual([
      {
        uri: 'file:///w/a.ts',
        edits: [
          { range: range(0, 6, 11), newText: 'sum' },
          { range: range(2, 0, 5), newText: 'sum' },
        ],
      },
    ]);
  });

  it('prefers `documentChanges` when both are present, as the specification says', () => {
    const plan = renameEdits({
      changes: { 'file:///w/old.ts': [{ range: range(0, 0, 1), newText: 'x' }] },
      documentChanges: [
        { textDocument: { uri: 'file:///w/new.ts' }, edits: [{ range: range(0, 0, 1), newText: 'y' }] },
      ],
    });
    expect(plan.files.map((f) => f.uri)).toEqual(['file:///w/new.ts']);
  });

  it('drops a malformed edit and keeps the rest', () => {
    const plan = renameEdits({
      changes: {
        'file:///w/a.ts': [
          { range: range(0, 6, 11) },
          { range: { start: { line: -1, character: 0 }, end: { line: 0, character: 1 } }, newText: 'x' },
          'nonsense',
          { range: range(1, 0, 1), newText: 'ok' },
        ],
      },
    });
    expect(plan.files).toEqual([{ uri: 'file:///w/a.ts', edits: [{ range: range(1, 0, 1), newText: 'ok' }] }]);
  });

  it('lists a resource operation as unsupported and still returns the text edits', () => {
    const plan = renameEdits({
      documentChanges: [
        { kind: 'rename', oldUri: 'file:///w/a.ts', newUri: 'file:///w/b.ts' },
        { textDocument: { uri: 'file:///w/c.ts' }, edits: [{ range: range(0, 0, 1), newText: 'y' }] },
        { kind: 'create', uri: 'file:///w/d.ts' },
      ],
    });
    expect(plan.unsupported).toEqual(['rename', 'create']);
    expect(plan.files.map((f) => f.uri)).toEqual(['file:///w/c.ts']);
  });
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

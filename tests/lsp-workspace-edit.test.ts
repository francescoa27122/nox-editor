import { describe, expect, it } from 'vitest';
import { workspaceEditPlan } from '../src/core/lsp-workspace-edit';

/**
 * Reading a `WorkspaceEdit`.
 *
 * One shape, two callers — rename and code actions — which is why it left
 * `lsp-rename.ts`. These tests came with it.
 */

const range = (line: number, from: number, to: number) => ({
  start: { line, character: from },
  end: { line, character: to },
});

describe('workspaceEditPlan', () => {
  it('is empty for null, which is a server declining to rename', () => {
    expect(workspaceEditPlan(null)).toEqual({ files: [], unsupported: [] });
  });

  it('reads the `changes` map, one entry per file', () => {
    const plan = workspaceEditPlan({
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
    const plan = workspaceEditPlan({
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
    const plan = workspaceEditPlan({
      changes: { 'file:///w/old.ts': [{ range: range(0, 0, 1), newText: 'x' }] },
      documentChanges: [
        { textDocument: { uri: 'file:///w/new.ts' }, edits: [{ range: range(0, 0, 1), newText: 'y' }] },
      ],
    });
    expect(plan.files.map((f) => f.uri)).toEqual(['file:///w/new.ts']);
  });

  it('drops a malformed edit and keeps the rest', () => {
    const plan = workspaceEditPlan({
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
    const plan = workspaceEditPlan({
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

import { describe, expect, it } from 'vitest';
import type { LspDiagnostic } from '../src/services/lsp';
import { problemRows, problemTotals } from '../src/ui/problems';

/**
 * The problems list, flattened for the keyboard.
 *
 * Same shape as the search panel's `rows()`, and for the reason that panel's
 * own docstring gives: a results tree you cannot drive with the arrow keys is
 * half a feature in a keyboard-first editor. The flattening is tested here so
 * the component is only markup.
 */

function diagnostic(line: number, message: string, severity: 1 | 2 | 3 | 4 = 1): LspDiagnostic {
  return {
    range: { start: { line, character: 0 }, end: { line, character: 4 } },
    severity,
    message,
  };
}

const TWO_FILES = new Map<string, LspDiagnostic[]>([
  ['file:///w/src/b.ts', [diagnostic(3, 'second file')]],
  ['file:///w/src/a.ts', [diagnostic(0, 'first'), diagnostic(9, 'second')]],
]);

describe('rows', () => {
  it('puts a file row above each of its problems', () => {
    const rows = problemRows(TWO_FILES, '/w');

    expect(rows.map((row) => row.kind)).toEqual([
      'file',
      'problem',
      'problem',
      'file',
      'problem',
    ]);
  });

  it('sorts files by path, so the list does not reorder as batches arrive', () => {
    // A server publishes per file, in whatever order it finishes. A list
    // ordered by arrival would rearrange itself under the cursor.
    const rows = problemRows(TWO_FILES, '/w');

    expect(rows.filter((row) => row.kind === 'file').map((row) => row.label)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('sorts problems within a file by line', () => {
    const rows = problemRows(
      new Map([['file:///w/a.ts', [diagnostic(9, 'later'), diagnostic(2, 'earlier')]]]),
      '/w',
    );

    expect(rows.filter((row) => row.kind === 'problem').map((row) => row.label)).toEqual([
      'earlier',
      'later',
    ]);
  });

  it('shows a path relative to the workspace, and an absolute one outside it', () => {
    const rows = problemRows(
      new Map([['file:///elsewhere/x.ts', [diagnostic(0, 'stray')]]]),
      '/w',
    );

    expect(rows[0]?.label).toBe('/elsewhere/x.ts');
  });

  it('carries the path and line each row needs to be opened', () => {
    const rows = problemRows(TWO_FILES, '/w');
    const problem = rows.find((row) => row.kind === 'problem');

    expect(problem?.path).toBe('/w/src/a.ts');
    // One-based, because that is what `onReveal` and the editor speak.
    expect(problem?.line).toBe(1);
  });

  it('omits a file whose diagnostics were all cleared', () => {
    const rows = problemRows(new Map([['file:///w/a.ts', []]]), '/w');

    expect(rows).toEqual([]);
  });

  it('is empty when there is nothing wrong', () => {
    expect(problemRows(new Map(), '/w')).toEqual([]);
  });
});

describe('totals', () => {
  it('counts errors and warnings apart, since one is worth interrupting for', () => {
    const totals = problemTotals(
      new Map([
        ['file:///w/a.ts', [diagnostic(0, 'bad', 1), diagnostic(1, 'iffy', 2)]],
        ['file:///w/b.ts', [diagnostic(0, 'also bad', 1)]],
      ]),
    );

    expect(totals).toEqual({ errors: 2, warnings: 1, files: 2 });
  });

  it('treats a diagnostic with no severity as an error, as the spec does', () => {
    const totals = problemTotals(
      new Map([['file:///w/a.ts', [{ range: diagnostic(0, 'x').range, message: 'x' }]]]),
    );

    expect(totals.errors).toBe(1);
  });

  it('counts nothing when there is nothing', () => {
    expect(problemTotals(new Map())).toEqual({ errors: 0, warnings: 0, files: 0 });
  });
});

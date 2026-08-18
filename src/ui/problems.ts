import { contains, relative } from '@core/path';
import { uriToPath } from '@core/uri';
import type { LspDiagnostic } from '@services/lsp';

/**
 * The problems list, flattened for the keyboard.
 *
 * The same shape as `SearchService.rows()`, and for the reason that service's
 * docstring gives: a results tree you cannot drive with the arrow keys is half
 * a feature in a keyboard-first editor. A second tree that behaved differently
 * would be worse than either.
 *
 * Pure, so the component is only markup.
 */

export interface ProblemRow {
  kind: 'file' | 'problem';
  /** What the row shows. */
  label: string;
  /** The file this row belongs to, absolute. */
  path: string;
  /** One-based, as `onReveal` and the editor speak it. Zero for a file row. */
  line: number;
  /** One-based column, for a problem row. */
  column: number;
  severity: 1 | 2 | 3 | 4;
  /** How many problems the file has. Only meaningful on a file row. */
  count: number;
}

export interface ProblemTotals {
  errors: number;
  warnings: number;
  files: number;
}

/** Absolute path, or the URI itself when it names nothing on disk. */
function pathOf(uri: string): string | null {
  try {
    return uriToPath(uri);
  } catch {
    return null;
  }
}

export function problemRows(
  diagnostics: ReadonlyMap<string, readonly LspDiagnostic[]>,
  root: string | null,
): ProblemRow[] {
  const files: { path: string; label: string; problems: readonly LspDiagnostic[] }[] = [];

  for (const [uri, problems] of diagnostics) {
    if (problems.length === 0) continue; // Cleared, but not yet forgotten.
    const path = pathOf(uri);
    if (path === null) continue;

    files.push({
      path,
      label: root && contains(root, path) ? relative(root, path) : path,
      problems,
    });
  }

  // By path, not by arrival. A server publishes per file in whatever order it
  // finishes, and a list ordered by arrival rearranges itself under the cursor.
  files.sort((a, b) => a.label.localeCompare(b.label));

  const rows: ProblemRow[] = [];
  for (const file of files) {
    rows.push({
      kind: 'file',
      label: file.label,
      path: file.path,
      line: 0,
      column: 0,
      severity: 1,
      count: file.problems.length,
    });

    for (const problem of [...file.problems].sort(
      (a, b) => a.range.start.line - b.range.start.line,
    )) {
      rows.push({
        kind: 'problem',
        label: problem.message,
        path: file.path,
        line: problem.range.start.line + 1,
        column: problem.range.start.character + 1,
        severity: problem.severity ?? 1,
        count: 0,
      });
    }
  }

  return rows;
}

export function problemTotals(
  diagnostics: ReadonlyMap<string, readonly LspDiagnostic[]>,
): ProblemTotals {
  let errors = 0;
  let warnings = 0;
  let files = 0;

  for (const problems of diagnostics.values()) {
    if (problems.length === 0) continue;
    files++;
    for (const problem of problems) {
      // No severity means error, which is what the specification says and
      // what a reader would assume from an unlabelled problem anyway.
      if ((problem.severity ?? 1) === 1) errors++;
      else if (problem.severity === 2) warnings++;
    }
  }

  return { errors, warnings, files };
}

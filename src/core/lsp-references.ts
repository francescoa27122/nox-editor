import { definitionTargets, type LspLocation } from './lsp-definition';
import { contains, relative } from './path';
import { uriToPath } from './uri';

/**
 * Find references: the answer reduced, and the list built from it.
 *
 * `textDocument/references` returns `Location[] | null` — never links — which
 * is a subset of what `definitionTargets` reads. One normaliser under two
 * names, so the call sites say which question they asked; the day the two
 * need to differ, this is where one of them changes.
 *
 * Pure; the app reads the texts and the component is only markup. See
 * `docs/superpowers/specs/2026-08-19-lsp-references-design.md`.
 */

export function referenceTargets(response: unknown): LspLocation[] {
  return definitionTargets(response);
}

export interface LocationRow {
  kind: 'file' | 'location';
  /** A file row: the path, relative to the root when inside it. A location row: the line's text, trimmed. */
  label: string;
  /** The file this row belongs to, absolute. */
  path: string;
  /** One-based, as the editor speaks it. Zero for a file row. */
  line: number;
  /** One-based. Zero for a file row. */
  column: number;
  /** How many locations the file has. Only meaningful on a file row. */
  count: number;
  /** The location to reveal. Null on a file row. */
  location: LspLocation | null;
}

/** What a sidebar list holds: one answer, titled, with its subject. */
export interface LocationList {
  title: string;
  /** The word the question was asked about, or '' when there was none. */
  subject: string;
  rows: LocationRow[];
  files: number;
  total: number;
}

function pathOf(uri: string): string | null {
  try {
    return uriToPath(uri);
  } catch {
    return null;
  }
}

/** The trimmed text of `line` (zero-based) in `text`, or '' when there is no such line. */
function lineText(text: string | undefined, line: number): string {
  if (text === undefined) return '';
  const lines = text.split('\n');
  return line < lines.length ? lines[line]!.trim() : '';
}

/**
 * The list, flattened for the keyboard — `problemRows` is the model, and for
 * the reason `src/ui/problems.ts` gives: a tree you cannot drive with the
 * arrow keys is half a feature here.
 *
 * `texts` holds whatever file contents the caller could find; a location in
 * a file with none still gets its row, with an empty label, because the
 * place exists whether or not its line could be read. A location whose URI
 * names nothing on disk is dropped: `revealLocation` could not open it.
 */
export function locationRows(
  locations: readonly LspLocation[],
  texts: ReadonlyMap<string, string>,
  root: string | null,
): LocationRow[] {
  const files = new Map<string, { label: string; locations: LspLocation[] }>();

  for (const location of locations) {
    const path = pathOf(location.uri);
    if (path === null) continue;
    let file = files.get(path);
    if (!file) {
      file = { label: root && contains(root, path) ? relative(root, path) : path, locations: [] };
      files.set(path, file);
    }
    file.locations.push(location);
  }

  const rows: LocationRow[] = [];
  for (const [path, file] of [...files].sort(([, a], [, b]) => a.label.localeCompare(b.label))) {
    rows.push({ kind: 'file', label: file.label, path, line: 0, column: 0, count: file.locations.length, location: null });

    const text = texts.get(path);
    const ordered = [...file.locations].sort(
      (a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character,
    );
    for (const location of ordered) {
      rows.push({
        kind: 'location',
        label: lineText(text, location.range.start.line),
        path,
        line: location.range.start.line + 1,
        column: location.range.start.character + 1,
        count: 0,
        location,
      });
    }
  }

  return rows;
}

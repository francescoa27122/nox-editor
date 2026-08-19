import type { LspPosition } from './lsp-position';

/**
 * Where a definition is, reduced from the four shapes a server may answer in.
 *
 * `textDocument/definition` returns `Location | Location[] | LocationLink[] |
 * null`. Nox does not advertise `linkSupport`, so a conforming server sends
 * the first two — but reading links too costs one branch and removes one way
 * to be wrong about a server. Pure; the app decides what to do with the list.
 */

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

function isPosition(value: unknown): value is LspPosition {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as LspPosition).line === 'number' &&
    typeof (value as LspPosition).character === 'number'
  );
}

function isRange(value: unknown): value is LspRange {
  return (
    typeof value === 'object' &&
    value !== null &&
    isPosition((value as LspRange).start) &&
    isPosition((value as LspRange).end)
  );
}

/** One entry, whichever shape it is, or null when it is neither. */
function locationOf(entry: unknown): LspLocation | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const record = entry as Record<string, unknown>;

  if (typeof record.uri === 'string' && isRange(record.range)) {
    return { uri: record.uri, range: record.range };
  }

  if (typeof record.targetUri === 'string') {
    // The selection range is the identifier; the range is the whole
    // declaration. Landing on the name is what "go to definition" means.
    const range = isRange(record.targetSelectionRange)
      ? record.targetSelectionRange
      : isRange(record.targetRange)
        ? record.targetRange
        : null;
    if (range) return { uri: record.targetUri, range };
  }

  return null;
}

export function definitionTargets(response: unknown): LspLocation[] {
  const entries = Array.isArray(response) ? response : [response];
  const seen = new Set<string>();
  const targets: LspLocation[] = [];

  for (const entry of entries) {
    const location = locationOf(entry);
    if (!location) continue;

    const { start, end } = location.range;
    const key = `${location.uri}:${start.line}:${start.character}-${end.line}:${end.character}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(location);
  }

  return targets;
}

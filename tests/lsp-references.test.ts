import { describe, expect, it } from 'vitest';
import { locationRows, referenceTargets } from '../src/core/lsp-references';
import type { LspLocation } from '../src/core/lsp-definition';
import { pathToUri } from '../src/core/uri';

const range = (line: number, from: number, to: number) => ({
  start: { line, character: from },
  end: { line, character: to },
});

const at = (path: string, line: number, from: number, to: number): LspLocation => ({
  uri: pathToUri(path),
  range: range(line, from, to),
});

describe('referenceTargets', () => {
  it('is empty for null, which is what a server with nothing to say sends', () => {
    expect(referenceTargets(null)).toEqual([]);
  });

  it('keeps every well-formed location, in the order the server gave them', () => {
    const a = at('/w/a.ts', 0, 6, 11);
    const b = at('/w/b.ts', 3, 0, 5);
    expect(referenceTargets([a, b])).toEqual([a, b]);
  });

  it('drops a malformed entry and keeps the rest', () => {
    const good = at('/w/a.ts', 0, 6, 11);
    expect(referenceTargets([{ uri: 'file:///w/x.ts' }, good, 7, null])).toEqual([good]);
  });

  it('removes a duplicate', () => {
    const a = at('/w/a.ts', 0, 6, 11);
    expect(referenceTargets([a, { ...a }])).toEqual([a]);
  });
});

describe('locationRows', () => {
  const texts = new Map<string, string>([
    ['/w/src/main.ts', 'import { total } from "./lib";\n  console.log(total);\n'],
    ['/w/src/lib.ts', 'export const total = 42;\n'],
  ]);

  it('puts a file row above each of its locations, files by label, locations by position', () => {
    const rows = locationRows(
      [
        at('/w/src/main.ts', 1, 14, 19),
        at('/w/src/lib.ts', 0, 13, 18),
        at('/w/src/main.ts', 0, 9, 14),
      ],
      texts,
      '/w',
    );

    expect(rows.map((r) => [r.kind, r.label, r.line, r.column])).toEqual([
      ['file', 'src/lib.ts', 0, 0],
      ['location', 'export const total = 42;', 1, 14],
      ['file', 'src/main.ts', 0, 0],
      ['location', 'import { total } from "./lib";', 1, 10],
      ['location', 'console.log(total);', 2, 15],
    ]);
  });

  it('counts locations on the file row and carries the location on its own row', () => {
    const one = at('/w/src/main.ts', 1, 14, 19);
    const two = at('/w/src/main.ts', 0, 9, 14);
    const rows = locationRows([one, two], texts, '/w');
    expect(rows[0]).toMatchObject({ kind: 'file', path: '/w/src/main.ts', count: 2, location: null });
    expect(rows[1]!.location).toBe(two);
    expect(rows[2]!.location).toBe(one);
  });

  it('labels a file outside the workspace, or with no workspace, by its absolute path', () => {
    const loc = at('/elsewhere/x.ts', 0, 0, 1);
    expect(locationRows([loc], texts, '/w')[0]!.label).toBe('/elsewhere/x.ts');
    expect(locationRows([loc], texts, null)[0]!.label).toBe('/elsewhere/x.ts');
  });

  it('shows an empty line for a file whose text is not known, and a trimmed one otherwise', () => {
    const rows = locationRows([at('/w/src/other.ts', 2, 0, 1)], texts, '/w');
    expect(rows[1]!.label).toBe('');
    const known = locationRows([at('/w/src/main.ts', 1, 14, 19)], texts, '/w');
    expect(known[1]!.label).toBe('console.log(total);');
  });

  it('shows an empty line for a position past the end of the text', () => {
    const rows = locationRows([at('/w/src/lib.ts', 9, 0, 1)], texts, '/w');
    expect(rows[1]!.label).toBe('');
    expect(rows[1]!.line).toBe(10);
  });

  it('drops a location whose URI is not a file', () => {
    const rows = locationRows(
      [{ uri: 'untitled:one', range: range(0, 0, 1) }, at('/w/src/lib.ts', 0, 13, 18)],
      texts,
      '/w',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.path).toBe('/w/src/lib.ts');
  });

  it('is empty for nothing', () => {
    expect(locationRows([], texts, '/w')).toEqual([]);
  });
});

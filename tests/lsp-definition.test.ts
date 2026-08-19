import { describe, expect, it } from 'vitest';
import { definitionTargets } from '../src/core/lsp-definition';

/**
 * The four shapes a definition response can take, reduced to places to go.
 *
 * Nox does not advertise `linkSupport`, so a conforming server sends
 * `Location | Location[] | null` — but reading `LocationLink[]` too costs one
 * branch and removes one way to be wrong about a server.
 */

const RANGE = { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } };
const WHOLE = { start: { line: 2, character: 0 }, end: { line: 5, character: 1 } };

describe('shapes', () => {
  it('reads a single Location', () => {
    expect(definitionTargets({ uri: 'file:///w/a.ts', range: RANGE })).toEqual([
      { uri: 'file:///w/a.ts', range: RANGE },
    ]);
  });

  it('reads a Location array, in order', () => {
    expect(
      definitionTargets([
        { uri: 'file:///w/a.ts', range: RANGE },
        { uri: 'file:///w/b.ts', range: WHOLE },
      ]),
    ).toEqual([
      { uri: 'file:///w/a.ts', range: RANGE },
      { uri: 'file:///w/b.ts', range: WHOLE },
    ]);
  });

  it('reads LocationLinks, preferring the selection range over the whole declaration', () => {
    expect(
      definitionTargets([
        { targetUri: 'file:///w/a.ts', targetRange: WHOLE, targetSelectionRange: RANGE },
        { targetUri: 'file:///w/b.ts', targetRange: WHOLE },
      ]),
    ).toEqual([
      { uri: 'file:///w/a.ts', range: RANGE },
      { uri: 'file:///w/b.ts', range: WHOLE },
    ]);
  });

  it('reads null, undefined and an empty array as nowhere to go', () => {
    expect(definitionTargets(null)).toEqual([]);
    expect(definitionTargets(undefined)).toEqual([]);
    expect(definitionTargets([])).toEqual([]);
  });
});

describe('what a server can get wrong', () => {
  it('drops an entry with no usable uri or range and keeps the rest', () => {
    expect(
      definitionTargets([
        { uri: 42, range: RANGE },
        { uri: 'file:///w/a.ts', range: { start: { line: 1 } } },
        { uri: 'file:///w/b.ts', range: RANGE },
        'not an object',
      ]),
    ).toEqual([{ uri: 'file:///w/b.ts', range: RANGE }]);
  });

  it('removes duplicates by uri and range', () => {
    expect(
      definitionTargets([
        { uri: 'file:///w/a.ts', range: RANGE },
        { uri: 'file:///w/a.ts', range: { start: { ...RANGE.start }, end: { ...RANGE.end } } },
        { uri: 'file:///w/a.ts', range: WHOLE },
      ]),
    ).toEqual([
      { uri: 'file:///w/a.ts', range: RANGE },
      { uri: 'file:///w/a.ts', range: WHOLE },
    ]);
  });
});

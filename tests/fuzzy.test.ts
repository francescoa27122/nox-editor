import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyMatch, fuzzyMatchPath, segmentMatch } from '../src/core/fuzzy';

const score = (pattern: string, text: string) => fuzzyMatch(pattern, text)?.score ?? -Infinity;

describe('fuzzyMatch', () => {
  it('matches a subsequence', () => {
    expect(fuzzyMatch('abc', 'axbxc')).not.toBeNull();
  });

  it('rejects a non-subsequence', () => {
    expect(fuzzyMatch('abc', 'acb')).toBeNull();
  });

  it('matches an empty pattern against anything', () => {
    expect(fuzzyMatch('', 'whatever')).toEqual({ score: 0, positions: [] });
  });

  it('rejects when the pattern is longer than the text', () => {
    expect(fuzzyMatch('abcd', 'abc')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(fuzzyMatch('ABC', 'abc')).not.toBeNull();
  });

  it('prefers contiguous runs over scattered hits', () => {
    expect(score('path', 'path.ts')).toBeGreaterThan(score('path', 'p_a_t_h.ts'));
  });

  it('rewards word boundaries', () => {
    expect(score('fb', 'foo_bar')).toBeGreaterThan(score('fb', 'foobxar'));
  });

  it('rewards camelCase boundaries', () => {
    expect(score('cs', 'createScheduler')).toBeGreaterThan(score('cs', 'crxsxx'));
  });

  it('prefers matches near the start', () => {
    expect(score('a', 'abc')).toBeGreaterThan(score('a', 'xxxxxxxxxa'));
  });

  it('breaks ties toward exact case', () => {
    expect(score('S', 'Sx')).toBeGreaterThan(score('S', 'sx'));
  });

  it('reports highlight positions inside the text', () => {
    const match = fuzzyMatch('sch', 'scheduler.ts');
    expect(match?.positions).toEqual([0, 1, 2]);
  });

  it('returns one position per pattern character', () => {
    const match = fuzzyMatch('abc', 'aXbXcXabc');
    expect(match?.positions).toHaveLength(3);
  });
});

describe('fuzzyFilter', () => {
  it('ranks best matches first', () => {
    const items = ['src/telemetry.ts', 'src/scheduler.ts', 'schema.ts'];
    const results = fuzzyFilter('sch', items, (s) => s);
    expect(results[0]?.item).toBe('schema.ts');
  });

  it('drops non-matching items', () => {
    const results = fuzzyFilter('zzz', ['abc', 'def'], (s) => s);
    expect(results).toHaveLength(0);
  });

  it('honours the limit', () => {
    const results = fuzzyFilter('a', ['a', 'ba', 'ca', 'da'], (s) => s, 2);
    expect(results).toHaveLength(2);
  });
});

describe('fuzzyMatchPath', () => {
  const nameStart = (path: string) => path.lastIndexOf('/') + 1;

  it('ranks a filename hit above a directory hit', () => {
    const inName = fuzzyMatchPath('sched', 'src/scheduler.ts', nameStart('src/scheduler.ts'));
    const inDir = fuzzyMatchPath('sched', 'scheduler/index.ts', nameStart('scheduler/index.ts'));
    expect(inName!.score).toBeGreaterThan(inDir!.score);
  });

  it('shifts positions back onto the full path', () => {
    const path = 'src/ui/App.svelte';
    const match = fuzzyMatchPath('app', path, nameStart(path));
    // Every reported index must point at a character of the original string.
    for (const position of match!.positions) {
      expect(path[position]!.toLowerCase()).toMatch(/[a-z]/);
    }
    expect(Math.min(...match!.positions)).toBeGreaterThanOrEqual(nameStart(path));
  });

  it('still matches when only the directory contains the pattern', () => {
    expect(fuzzyMatchPath('ui', 'src/ui/App.svelte', 7)).not.toBeNull();
  });
});

describe('segmentMatch', () => {
  it('splits into hit and non-hit runs', () => {
    expect(segmentMatch('abcd', [1, 2])).toEqual([
      { text: 'a', hit: false },
      { text: 'bc', hit: true },
      { text: 'd', hit: false },
    ]);
  });

  it('handles a leading hit', () => {
    expect(segmentMatch('ab', [0])).toEqual([
      { text: 'a', hit: true },
      { text: 'b', hit: false },
    ]);
  });

  it('returns one plain run with no positions', () => {
    expect(segmentMatch('abc', [])).toEqual([{ text: 'abc', hit: false }]);
  });

  it('preserves the whole string', () => {
    const segments = segmentMatch('scheduler', [0, 3, 8]);
    expect(segments.map((s) => s.text).join('')).toBe('scheduler');
  });
});

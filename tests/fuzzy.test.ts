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

/**
 * The matcher keeps two pieces of state between calls now — the scratch
 * buffers the DP runs in, and a one-entry memo of the last prepared pattern.
 * Both are invisible when they work and produce results that depend on call
 * *order* when they do not, which is the worst shape a bug can have: every
 * test passes alone and the palette ranks wrongly only after you have typed
 * something else first.
 *
 * These are the tests that would catch that. Each one runs a case in isolation
 * and then again after something designed to poison the shared state.
 */
describe('the matcher carries no state between calls', () => {
  /** The same call, made after `poison()` has run. */
  const after = (poison: () => void, run: () => unknown) => {
    const alone = JSON.stringify(run());
    poison();
    return { alone, polluted: JSON.stringify(run()) };
  };

  it('is unaffected by a longer candidate scored first', () => {
    // The scratch buffers only grow, so a long candidate leaves a big array
    // with stale scores in it. Filling past `n` would make the short one read
    // the tail of the long one's row.
    const { alone, polluted } = after(
      () => void fuzzyMatch('src', 'src/'.repeat(200) + 'deeply/nested/file.ts'),
      () => fuzzyMatch('src', 'src/main.ts'),
    );
    expect(polluted).toBe(alone);
  });

  it('is unaffected by a different pattern scored first', () => {
    const { alone, polluted } = after(
      () => void fuzzyMatch('zzz', 'zzz'),
      () => fuzzyMatch('src', 'src/main.ts'),
    );
    expect(polluted).toBe(alone);
  });

  /**
   * The memo is keyed on the raw pattern, and it has to be: `BONUS_CASE`
   * rewards an exact-case hit, so `TS` and `ts` are different questions. A
   * memo keyed on the lowercased pattern would answer the second with the
   * first's prepared codes and silently drop the bonus.
   */
  it('does not confuse two patterns differing only in case', () => {
    const upper = fuzzyMatch('TS', 'TSConfig')!;
    const lower = fuzzyMatch('ts', 'TSConfig')!;
    expect(upper.score).toBeGreaterThan(lower.score);

    // And again in the other order, so neither is merely the one that ran first.
    const lowerAgain = fuzzyMatch('ts', 'TSConfig')!;
    const upperAgain = fuzzyMatch('TS', 'TSConfig')!;
    expect(lowerAgain.score).toBe(lower.score);
    expect(upperAgain.score).toBe(upper.score);
  });

  it('gives fuzzyMatchPath the same answer whatever ran before it', () => {
    const path = 'src/services/workspace.ts';
    const nameStart = path.length - 'workspace.ts'.length;
    const { alone, polluted } = after(
      () => {
        fuzzyMatch('other', 'a/completely/different/candidate/entirely.ts');
        fuzzyFilter('zz', ['zzz', 'zz'], (s) => s);
      },
      () => fuzzyMatchPath('wsp', path, nameStart),
    );
    expect(polluted).toBe(alone);
  });

  /**
   * Interleaving two patterns across the same candidates is what the palette
   * actually does as someone types and deletes. A one-entry memo makes every
   * one of these a miss, which is correct but is the case most likely to be
   * got wrong.
   */
  it('survives interleaved patterns over the same candidates', () => {
    const items = ['src/core/path.ts', 'src/ui/Palette.svelte', 'README.md'];
    const pathOnly = fuzzyFilter('path', items, (s) => s);
    const uiOnly = fuzzyFilter('ui', items, (s) => s);

    for (let i = 0; i < 3; i++) {
      expect(fuzzyFilter('path', items, (s) => s)).toEqual(pathOnly);
      expect(fuzzyFilter('ui', items, (s) => s)).toEqual(uiOnly);
    }
  });
});

import type { SearchFileResult, SearchSummary } from '../src/platform/types';
import { JobRunner } from '../src/services/jobs';
import { describe, expect, it } from 'vitest';
import {
  buildSearchRegex,
  findMatches,
  globToRegExp,
  matchesGlobs,
  previewFor,
  PREVIEW_BUDGET,
} from '../src/core/search-match';
import { MemoryPlatform } from '../src/platform/memory';
import { SearchService, splitPatterns } from '../src/services/search';
import { WorkspaceService } from '../src/services/workspace';

/**
 * These mirror the Rust unit tests in `src-tauri/src/search.rs`. The two
 * implementations must agree — the browser target and the desktop build are
 * meant to be indistinguishable — so the same cases are asserted on both sides.
 */

const plain = { caseSensitive: true, wholeWord: false, regexp: false };

describe('query compilation', () => {
  it('escapes a plain query', () => {
    expect(buildSearchRegex('a.c', plain).test('a.c')).toBe(true);
    expect(buildSearchRegex('a.c', plain).test('abc')).toBe(false);
  });

  it('does not escape a regex query', () => {
    expect(buildSearchRegex('a.c', { ...plain, regexp: true }).test('abc')).toBe(true);
  });

  it('is case-insensitive unless asked', () => {
    expect(buildSearchRegex('hello', { ...plain, caseSensitive: false }).test('HELLO')).toBe(true);
    expect(buildSearchRegex('hello', plain).test('HELLO')).toBe(false);
  });

  it('wraps the whole pattern in word boundaries', () => {
    const matcher = buildSearchRegex('cat|dog', { ...plain, wholeWord: true, regexp: true });
    expect(matcher.test('a cat sat')).toBe(true);
    matcher.lastIndex = 0;
    expect(matcher.test('concatenate')).toBe(false);
  });

  it('throws on an invalid regex so the panel can report it', () => {
    expect(() => buildSearchRegex('(unclosed', { ...plain, regexp: true })).toThrow();
  });
});

describe('finding matches', () => {
  it('reports 1-based line numbers and 0-based columns', () => {
    const matches = findMatches('alpha\nbeta needle\n', buildSearchRegex('needle', plain));
    expect(matches).toHaveLength(1);
    expect(matches[0]!.line).toBe(2);
    expect(matches[0]!.column).toBe(5);
    expect(matches[0]!.length).toBe(6);
  });

  it('finds several matches on one line', () => {
    const matches = findMatches('x x x', buildSearchRegex('x', plain));
    expect(matches.map((m) => m.column)).toEqual([0, 2, 4]);
  });

  it('does not loop forever on a zero-width pattern', () => {
    const matches = findMatches('abc', buildSearchRegex('x*', { ...plain, regexp: true }));
    expect(matches).toHaveLength(0);
  });

  it('keeps the full line as the preview when it is short', () => {
    const matches = findMatches('const value = 1;', buildSearchRegex('value', plain));
    expect(matches[0]!.preview).toBe('const value = 1;');
    expect(matches[0]!.previewOffset).toBe(0);
  });

  it('windows around a match on a very long line', () => {
    const line = `${'x'.repeat(2000)}NEEDLE${'y'.repeat(2000)}`;
    const matches = findMatches(line, buildSearchRegex('NEEDLE', plain));
    const match = matches[0]!;

    expect(match.preview.length).toBeLessThanOrEqual(PREVIEW_BUDGET);
    // The match must actually be inside the window handed to the renderer.
    expect(match.preview.slice(match.column, match.column + match.length)).toBe('NEEDLE');
    expect(match.previewOffset).toBeGreaterThan(0);
  });

  it('reports an absolute column via previewOffset + column', () => {
    const line = `${'x'.repeat(2000)}NEEDLE`;
    const match = findMatches(line, buildSearchRegex('NEEDLE', plain))[0]!;
    expect(match.previewOffset + match.column).toBe(2000);
  });
});

describe('previewFor', () => {
  it('is a no-op for short lines', () => {
    expect(previewFor('hello world', 6, 11)).toEqual({
      preview: 'hello world',
      column: 6,
      length: 5,
      previewOffset: 0,
    });
  });
});

describe('globs', () => {
  it('matches a bare pattern at any depth', () => {
    const pattern = globToRegExp('*.ts');
    expect(pattern.test('main.ts')).toBe(true);
    expect(pattern.test('src/deep/main.ts')).toBe(true);
    expect(pattern.test('main.js')).toBe(false);
  });

  it('anchors a pattern that contains a separator', () => {
    const pattern = globToRegExp('src/*.ts');
    expect(pattern.test('src/main.ts')).toBe(true);
    expect(pattern.test('lib/main.ts')).toBe(false);
    // A single star must not cross a separator.
    expect(pattern.test('src/deep/main.ts')).toBe(false);
  });

  it('spans directories with a double star', () => {
    const pattern = globToRegExp('src/**/*.ts');
    expect(pattern.test('src/deep/main.ts')).toBe(true);
    expect(pattern.test('src/main.ts')).toBe(true);
  });

  it('treats dots literally', () => {
    expect(globToRegExp('*.ts').test('mats')).toBe(false);
  });

  it('an exclude beats an include that also matched', () => {
    const includes = [globToRegExp('*.ts')];
    const excludes = [globToRegExp('*.test.ts')];
    expect(matchesGlobs('a.ts', includes, excludes)).toBe(true);
    // This assertion is correct, and it passed for as long as the desktop build
    // did the exact opposite. `ignore`'s overrides are last-match-wins and
    // `search.rs` added the excludes *before* the includes, so `include *.ts`
    // with `exclude *.test.ts` handed `a.test.ts` back in the shipped app. What
    // the test locked in was the fake's behaviour alone, while reading as
    // though it covered the rule for the whole product — which is worse than no
    // coverage, because it is the reason nobody went looking. The Rust half is
    // now pinned by `an_exclude_beats_an_include_that_also_matched` in
    // `src-tauri/src/search.rs`, and the two share a name so that changing one
    // without the other is visibly half a change.
    expect(matchesGlobs('a.test.ts', includes, excludes)).toBe(false);
  });

  it('an empty include list means everything', () => {
    expect(matchesGlobs('anything.md', [], [])).toBe(true);
  });

  /**
   * The failure this prevents: `matchesGlobs` had no always-exclude list at
   * all, so the browser target and every service test written against
   * `MemoryPlatform` walked `node_modules` and `.git` while the desktop build
   * pruned them. The fake being wrong in the direction that looks harmless,
   * which is the direction nobody checks.
   *
   * Named for `machine_directories_stay_out_when_nothing_is_asked_for` in
   * `src-tauri/src/search.rs`, so that changing one side without the other is
   * visibly half a change.
   */
  it('machine directories stay out when nothing is asked for', () => {
    for (const path of [
      '.git/config',
      'node_modules/pkg/index.js',
      'target/debug/build.rs',
      'dist/assets/index.js',
      '.svelte-kit/generated/root.js',
      '.next/server/page.js',
      'src/__pycache__/mod.cpython-312.pyc',
      '.venv/lib/site.py',
    ]) {
      expect(matchesGlobs(path, [], [])).toBe(false);
    }
    // A directory that merely *contains* one of those names is not one.
    expect(matchesGlobs('src/node_modules_helper.ts', [], [])).toBe(true);
    expect(matchesGlobs('src/distance.ts', [], [])).toBe(true);
  });

  /**
   * `ALWAYS_EXCLUDE` is the weakest of the three groups, deliberately: it is a
   * convenience list, not a rule, so naming one of those directories in
   * "files to include" reaches into it. That is what keeps "No results"
   * honest — every skip the walk makes is one the panel can undo.
   *
   * Named for `an_explicit_include_reaches_into_an_always_excluded_directory`.
   */
  it('an explicit include reaches into an always excluded directory', () => {
    const includes = [globToRegExp('node_modules/**')];
    expect(matchesGlobs('node_modules/pkg/index.js', includes, [])).toBe(true);
    // …and still does not drag in the rest of the tree.
    expect(matchesGlobs('src/main.ts', includes, [])).toBe(false);
  });

  /** Excludes stay strongest, above an include that reached in. */
  it('an exclude still beats an include that reached into one', () => {
    const includes = [globToRegExp('node_modules/**')];
    const excludes = [globToRegExp('**/*.min.js')];
    expect(matchesGlobs('node_modules/pkg/a.min.js', includes, excludes)).toBe(false);
    expect(matchesGlobs('node_modules/pkg/a.js', includes, excludes)).toBe(true);
  });
});

describe('splitPatterns', () => {
  it('splits on commas and newlines and trims', () => {
    expect(splitPatterns(' *.ts, src/** \n *.md ')).toEqual(['*.ts', 'src/**', '*.md']);
  });

  it('is empty for an empty string', () => {
    expect(splitPatterns('   ')).toEqual([]);
  });
});

// --- The service against a real in-memory filesystem ------------------------

function setup() {
  const platform = new MemoryPlatform();
  platform.seedFile('/w/src/main.ts', 'const needle = 1;\nconst other = 2;\n');
  platform.seedFile('/w/src/util.ts', 'export function needle() {}\n// needle again\n');
  platform.seedFile('/w/README.md', 'nothing to see\n');
  platform.seedFile('/w/notes.txt', 'NEEDLE in caps\n');

  const workspace = new WorkspaceService(platform, () => []);
  const search = new SearchService(platform, workspace, new JobRunner());
  return { platform, workspace, search };
}

async function runSearch(search: SearchService, query: string) {
  search.query.set(query);
  await search.run();
}

describe('SearchService', () => {
  it('finds matches across files', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    await runSearch(search, 'needle');

    const paths = search.results.get().map((file) => file.path);
    expect(paths).toContain('/w/src/main.ts');
    expect(paths).toContain('/w/src/util.ts');
    expect(paths).not.toContain('/w/README.md');
  });

  it('counts every match, not just every file', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    await runSearch(search, 'needle');

    // main.ts has 1, util.ts has 2, notes.txt has 1 (case-insensitive).
    expect(search.summary.get()?.totalMatches).toBe(4);
    expect(search.summary.get()?.totalFiles).toBe(3);
  });

  it('respects match case', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    search.setOption('caseSensitive', true);
    await runSearch(search, 'NEEDLE');

    expect(search.results.get().map((f) => f.path)).toEqual(['/w/notes.txt']);
  });

  it('searches dotfiles and dot-directories', async () => {
    const { platform, workspace, search } = setup();
    // Guards the divergence that made every dotfile unsearchable on the desktop
    // build: `ignore` skips hidden entries by default and `search.rs` never
    // turned that off, while this fake has always walked them. Nox's own
    // per-workspace settings live in `.nox/settings.json`, so the editor could
    // not find text in its own configuration. Pairs with
    // `dotfiles_and_dot_directories_are_searched` in `src-tauri/src/search.rs`;
    // only the Rust one can fail for the reason this comment describes, which
    // is precisely why the pair has to exist.
    platform.seedFile('/w/.nox/settings.json', '{ "needle": true }\n');
    platform.seedFile('/w/.env', 'NEEDLE_TOKEN=1\n');
    await workspace.openFolder('/w');
    await runSearch(search, 'needle');

    const paths = search.results.get().map((file) => file.path);
    expect(paths).toContain('/w/.nox/settings.json');
    expect(paths).toContain('/w/.env');
  });

  it('applies include globs', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    search.setOption('includes', '*.md');
    await runSearch(search, 'nothing');

    expect(search.results.get()).toHaveLength(1);
    expect(search.results.get()[0]!.path).toBe('/w/README.md');
  });

  it('applies exclude globs', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    search.setOption('excludes', 'src/**');
    await runSearch(search, 'needle');

    expect(search.results.get().map((f) => f.path)).toEqual(['/w/notes.txt']);
  });

  it('reports an invalid regex instead of throwing', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    search.setOption('regexp', true);
    await runSearch(search, '(unclosed');

    expect(search.summary.get()?.error).toBeTruthy();
    expect(search.results.get()).toHaveLength(0);
  });

  it('does nothing without an open folder', async () => {
    const { search } = setup();
    await runSearch(search, 'needle');
    expect(search.results.get()).toHaveLength(0);
  });

  it('clears everything', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    await runSearch(search, 'needle');

    search.clear();
    expect(search.query.get()).toBe('');
    expect(search.results.get()).toHaveLength(0);
    expect(search.status.get()).toBe('idle');
  });

  it('flattens into navigable rows, collapse-aware', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    await runSearch(search, 'needle');

    const expanded = search.rows();
    // 3 file rows + 4 match rows.
    expect(expanded).toHaveLength(7);
    expect(expanded[0]!.kind).toBe('file');

    search.collapseAll();
    expect(search.rows()).toHaveLength(3);
    expect(search.rows().every((row) => row.kind === 'file')).toBe(true);
  });

  it('clamps focus movement to the row range', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    await runSearch(search, 'needle');

    search.moveFocus(-1);
    expect(search.focused.get()).toBe(search.rows().length - 1);

    search.focused.set(0);
    search.moveFocus(-5);
    expect(search.focused.get()).toBe(0);

    search.moveFocus(999);
    expect(search.focused.get()).toBe(search.rows().length - 1);
  });

  it('dismisses one file group', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    await runSearch(search, 'needle');

    search.dismissFile('/w/src/util.ts');
    expect(search.results.get().map((f) => f.path)).not.toContain('/w/src/util.ts');
  });

  it('opens a match and reveals the absolute column', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    await runSearch(search, 'needle');

    const revealed: { line: number; column: number }[] = [];
    search.onReveal = (line, column) => revealed.push({ line, column });

    const file = search.results.get().find((f) => f.path === '/w/src/main.ts')!;
    await search.openMatch(file.path, file.matches[0]);

    expect(workspace.activeSnapshot()?.path).toBe('/w/src/main.ts');
    // `const needle` — column 7 (1-based) on line 1.
    expect(revealed).toEqual([{ line: 1, column: 7 }]);
  });

  it('discards results from a superseded search', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');

    // Start one search and immediately supersede it; the first must not
    // contribute rows to what the user ends up looking at.
    search.query.set('needle');
    const first = search.run();
    search.query.set('nothing');
    const second = search.run();
    await Promise.all([first, second]);

    expect(search.results.get().map((f) => f.path)).toEqual(['/w/README.md']);
  });
});

describe('previewReplacement with preserveCase', () => {
  it('leaves the template alone when the option is off', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    await runSearch(search, 'needle');
    search.setReplacement('worker');

    // notes.txt matched case-insensitively against an all-caps line — a
    // preview that shaped case here without being asked would be the bug.
    const upper = search.results.get().find((f) => f.path === '/w/notes.txt')!;
    expect(search.previewReplacement(upper.matches[0]!)).toBe('worker');
  });

  it('shapes a literal preview to the matched case, same as computeReplacements would write it', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    await runSearch(search, 'needle');
    search.setReplacement('worker');
    search.setOption('preserveCase', true);

    const lower = search.results.get().find((f) => f.path === '/w/src/main.ts')!;
    expect(search.previewReplacement(lower.matches[0]!)).toBe('worker');

    const upper = search.results.get().find((f) => f.path === '/w/notes.txt')!;
    expect(search.previewReplacement(upper.matches[0]!)).toBe('WORKER');
  });

  it('shapes a regex preview from the actual matched text, after group expansion', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    search.setOption('regexp', true);
    await runSearch(search, 'needle');
    search.setReplacement('worker');
    search.setOption('preserveCase', true);

    const upper = search.results.get().find((f) => f.path === '/w/notes.txt')!;
    expect(search.previewReplacement(upper.matches[0]!)).toBe('WORKER');
  });

  it('expands a named group before shaping case, rather than casing the reference itself', async () => {
    // `worker`/`$1s` above would produce the same string whichever order ran
    // first — toUpperCase() is a no-op on `$`, digits, and an already-upper
    // literal, so that pairing cannot tell the orders apart. A named-group
    // reference can: casing the *template* first turns `$<word>` into
    // `$<WORD>`, a group name the match's `groups` object does not have, so
    // `expandReplacement` silently drops it — exactly the failure mode
    // `computeReplacements` documents at src/core/replace.ts:135-137.
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    search.setOption('regexp', true);
    await runSearch(search, '(?<word>needle)');
    search.setReplacement('$<word>s');
    search.setOption('preserveCase', true);

    const upper = search.results.get().find((f) => f.path === '/w/notes.txt')!;
    // Expand first: $<word> -> 'NEEDLE', giving 'NEEDLEs'; then shape to the
    // all-caps match, giving 'NEEDLES'. Casing the template first would lose
    // the captured text and leave only 'S'.
    expect(search.previewReplacement(upper.matches[0]!)).toBe('NEEDLES');
  });

  it('still reports an invalid pattern as null rather than throwing', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    await runSearch(search, 'needle');
    const match = search.results.get()[0]!.matches[0]!;

    search.setOption('regexp', true);
    search.setOption('preserveCase', true);
    search.query.set('(unclosed');

    expect(search.previewReplacement(match)).toBeNull();
  });
});

describe('previewReplacement over a windowed preview', () => {
  /**
   * A line past PREVIEW_BUDGET is windowed, so the preview starts mid-line and
   * a rescan of it realigns: `a{7}` from a lead that is not a multiple of 7
   * lands on 56, 63, 70 -- never on the match's own column 60. Scanning the
   * preview for a match at that column therefore finds nothing, while the
   * write, which runs over the whole line, expands the group as normal. The
   * preview must say what the write will do or say nothing at all.
   */
  function windowedService(line: string, query: string, replacement: string) {
    const { search } = setup();
    search.query.set(query);
    search.options.update((current) => ({ ...current, regexp: true, caseSensitive: true }));
    search.setReplacement(replacement);

    const matcher = buildSearchRegex(query, { ...plain, regexp: true });
    const match = findMatches(line, matcher).find((found) => found.previewOffset > 0);
    expect(match).toBeDefined();
    return { search, match: match! };
  }

  it('expands the group from the match position, not from a rescan of the window', () => {
    const { search, match } = windowedService('a'.repeat(400), 'a{7}', '[$&]');

    expect(search.previewReplacement(match)).toBe('[aaaaaaa]');
  });

  it('reports null when the window truncates the match it would preview', () => {
    // One 500-character match: the 320-character window cannot hold it, so no
    // honest preview of `$&` exists. Showing the truncated text would promise
    // a write that is 180 characters shorter than the real one.
    const { search } = setup();
    search.query.set('a+');
    search.options.update((current) => ({ ...current, regexp: true, caseSensitive: true }));
    search.setReplacement('[$&]');

    const line = 'a'.repeat(500);
    const match = findMatches(line, buildSearchRegex('a+', { ...plain, regexp: true }))[0]!;
    expect(match.length).toBe(500);
    expect(match.preview.length).toBe(PREVIEW_BUDGET);

    expect(search.previewReplacement(match)).toBeNull();
  });

  it('reports null when the results predate the current query', async () => {
    // The panel keeps the old rows through the debounce, so the query can be
    // one the stored match never came from. A literal `[$1]` in the row would
    // be a promise the write never keeps.
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    await runSearch(search, 'needle');

    search.options.update((current) => ({ ...current, regexp: true }));
    // Escaped, because `'\w'` is just `'w'` in a normal string — this query
    // never held the word class it appeared to. The assertion turns on the
    // query differing from the one the stored match came from, so the test
    // was always testing its subject; it just was not saying what it meant.
    search.query.set('const (\\w+)');
    search.setReplacement('[$1]');

    const match = search.results.get().find((file) => file.path === '/w/src/main.ts')!.matches[0]!;
    expect(match.column).toBe(6);

    expect(search.previewReplacement(match)).toBeNull();
  });
});

// --- Cancellation -----------------------------------------------------------

/**
 * A platform whose project search is driven by hand.
 *
 * `MemoryPlatform` walks its files in one go, which is fine for testing what
 * search *finds* but useless for testing what happens *during* a walk. These
 * tests need to stop halfway.
 *
 * Each call is recorded separately: a superseded search and the one that
 * replaced it are both in flight at once, and a harness that only remembered
 * "the current call" could not tell them apart.
 */
interface SearchCall {
  emit: (files: SearchFileResult[]) => void;
  finish: (summary?: Partial<SearchSummary>) => void;
  cancelled: () => boolean;
}

function controllableSearch() {
  const platform = new MemoryPlatform();
  platform.seedFile('/w/a.ts', 'needle\n');

  const calls: SearchCall[] = [];
  let announce: (() => void) | null = null;

  platform.searchProject = async (_root, _request, onBatch) => {
    let cancelled = false;
    let resolve!: (summary: SearchSummary) => void;
    const done = new Promise<SearchSummary>((res) => {
      resolve = res;
    });

    calls.push({
      emit: (files) => onBatch(files),
      finish: (summary = {}) =>
        resolve({
          totalMatches: 1,
          totalFiles: 1,
          truncated: false,
          cancelled: false,
          error: null,
          elapsedMs: 1,
          ...summary,
        }),
      cancelled: () => cancelled,
    });

    announce?.();
    return {
      cancel: () => {
        cancelled = true;
      },
      done,
    };
  };

  const workspace = new WorkspaceService(platform, () => []);
  const search = new SearchService(platform, workspace, new JobRunner());

  /** Resolves once the nth search call (1-based) has handed back its handle. */
  const nthCall = async (n: number): Promise<SearchCall> => {
    while (calls.length < n) {
      await new Promise<void>((resolve) => {
        announce = resolve;
      });
    }
    announce = null;
    return calls[n - 1]!;
  };

  return { platform, workspace, search, nthCall };
}

const oneResult: SearchFileResult[] = [
  {
    path: '/w/a.ts',
    matches: [{ line: 1, column: 0, length: 6, preview: 'needle', previewOffset: 0 }],
    truncated: false,
  },
];

describe('cancelling a search', () => {
  it('leaves nothing behind', async () => {
    const { workspace, search, nthCall } = controllableSearch();
    await workspace.openFolder('/w');

    search.query.set('needle');
    const running = search.run();
    const call = await nthCall(1);

    call.emit(oneResult);
    expect(search.results.get()).toHaveLength(1);
    expect(search.status.get()).toBe('searching');

    search.cancel();

    // Half a result set is worse than none: the panel goes back to how it
    // looked before the search was started.
    expect(search.results.get()).toEqual([]);
    expect(search.summary.get()).toBeNull();
    expect(search.status.get()).toBe('idle');
    // And the walk on the other side actually stops, rather than running on
    // with its results thrown away.
    expect(call.cancelled()).toBe(true);

    // Anything still in flight must not land afterwards.
    call.emit(oneResult);
    call.finish();
    await running;

    expect(search.results.get()).toEqual([]);
    expect(search.summary.get()).toBeNull();
    expect(search.status.get()).toBe('idle');
  });

  it('supersedes an in-flight search when a new one starts', async () => {
    const { workspace, search, nthCall } = controllableSearch();
    await workspace.openFolder('/w');

    search.query.set('needle');
    const first = search.run();
    const firstCall = await nthCall(1);

    search.query.set('other');
    const second = search.run();
    const secondCall = await nthCall(2);

    expect(firstCall.cancelled()).toBe(true);

    // The superseded search completing must not write over the new one.
    firstCall.finish({ totalMatches: 99 });
    await first;
    expect(search.summary.get()).toBeNull();

    secondCall.finish({ totalMatches: 3 });
    await second;
    expect(search.summary.get()?.totalMatches).toBe(3);
  });
});

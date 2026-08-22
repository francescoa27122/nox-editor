import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { JobRunner } from '../src/services/jobs';
import { SearchService } from '../src/services/search';
import { WorkspaceService } from '../src/services/workspace';

/**
 * Excluding and replacing one match.
 *
 * The panel could dismiss a whole *file* from a replace and nothing smaller,
 * which is the wrong granularity for the case people actually hit: forty
 * matches, thirty-eight wanted, two in a fixture or a comment that means
 * something else. Dismissing the file threw away the thirty-eight.
 *
 * `computeReplacements` has accepted a `skip` set since it was written and no
 * caller ever passed one — see `tests/replace.test.ts`. What was missing is
 * the state in between, and the one hard decision: an exclusion is stored as
 * an *identity*, never an index, because `#replacePaths` deliberately
 * recomputes from the file's current text rather than trusting the result
 * rows.
 *
 * See `docs/superpowers/specs/2026-08-22-replace-single-matches-design.md`.
 */

function setup() {
  const platform = new MemoryPlatform();
  platform.seedFile('/w/a.ts', 'const needle = 1;\nconst needle2 = needle;\n');
  platform.seedFile('/w/b.ts', 'import needle from "x";\n');

  const workspace = new WorkspaceService(platform, () => []);
  const search = new SearchService(platform, workspace, new JobRunner());
  return { platform, workspace, search };
}

async function searchFor(search: SearchService, query: string) {
  search.query.set(query);
  await search.run();
}

/** The nth match row of a file, as the panel would hand it back. */
function matchIn(search: SearchService, path: string, index: number) {
  const file = search.results.get().find((candidate) => candidate.path === path);
  return file!.matches[index]!;
}

const textsOf = (search: SearchService) =>
  search.results.get().map((file) => [file.path, file.matches.length] as const);

describe('dismissing one match', () => {
  it('takes the row out of the results', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');

    search.dismissMatch('/w/a.ts', matchIn(search, '/w/a.ts', 0));

    expect(textsOf(search)).toEqual([
      ['/w/a.ts', 2],
      ['/w/b.ts', 1],
    ]);
  });

  /** The counts the panel shows read `results`, so they follow for free. */
  it('is reflected in what a replace-all says it will do', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');
    expect(search.pendingReplaceCount()).toEqual({ files: 2, matches: 4 });

    search.dismissMatch('/w/a.ts', matchIn(search, '/w/a.ts', 0));

    expect(search.pendingReplaceCount()).toEqual({ files: 2, matches: 3 });
  });

  /** A file whose last match goes leaves too, exactly as `dismissFile` does. */
  it('drops the file when its last match is dismissed', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');

    search.dismissMatch('/w/b.ts', matchIn(search, '/w/b.ts', 0));

    expect(search.results.get().map((file) => file.path)).toEqual(['/w/a.ts']);
  });

  it('is forgotten when a new search runs', async () => {
    const { platform, workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');
    search.dismissMatch('/w/b.ts', matchIn(search, '/w/b.ts', 0));

    await searchFor(search, 'needle');
    search.setReplacement('pin');
    await search.replaceAll();

    expect(await platform.readTextFile('/w/b.ts')).toBe('import pin from "x";\n');
  });
});

describe('replacing with a match dismissed', () => {
  it('leaves that one alone and replaces the rest of the file', async () => {
    const { platform, workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');
    search.setReplacement('pin');

    // 'const needle = 1;\nconst needle2 = needle;' — the second line's first.
    search.dismissMatch('/w/a.ts', matchIn(search, '/w/a.ts', 1));
    const outcome = await search.replaceInFile('/w/a.ts');

    expect(outcome).toBe(2);
    expect(await platform.readTextFile('/w/a.ts')).toBe('const pin = 1;\nconst needle2 = pin;\n');
  });

  it('carries the exclusion through a project-wide replace', async () => {
    const { platform, workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');
    search.setReplacement('pin');

    search.dismissMatch('/w/a.ts', matchIn(search, '/w/a.ts', 0));
    const outcome = await search.replaceAll();

    expect(outcome.matches).toBe(3);
    expect(await platform.readTextFile('/w/a.ts')).toBe(
      'const needle = 1;\nconst pin2 = pin;\n',
    );
    expect(await platform.readTextFile('/w/b.ts')).toBe('import pin from "x";\n');
  });

  it('applies through an open buffer like any other replace', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    const id = (await workspace.open('/w/a.ts'))!;
    await searchFor(search, 'needle');
    search.setReplacement('pin');

    search.dismissMatch('/w/a.ts', matchIn(search, '/w/a.ts', 0));
    await search.replaceAll();

    expect(workspace.textOf(id)).toBe('const needle = 1;\nconst pin2 = pin;\n');
  });

  /**
   * The decision this feature turns on. `#replacePaths` recomputes from the
   * file's current text rather than trusting the stored rows, so an exclusion
   * cannot be an index — index 1 of the results and index 1 of the text being
   * replaced are the same match only while nothing has moved. When the match
   * the user protected is no longer where they protected it, Nox does not
   * know which text they meant, and replacing the rest would be replacing
   * something they said not to.
   *
   * The same rule rename uses for a file edited during review, and the same
   * one `undoLastReplace` uses for a file that no longer says what the replace
   * left there: when the world has moved, refuse rather than guess.
   */
  it('refuses a file whose dismissed match has moved', async () => {
    const { platform, workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');
    search.setReplacement('pin');
    search.dismissMatch('/w/a.ts', matchIn(search, '/w/a.ts', 1));

    // Something reindents the line the exclusion names, so the match it
    // protected is no longer at the column it was protected at.
    platform.externalWrite('/w/a.ts', 'const needle = 1;\n  const needle2 = needle;\n');

    const outcome = await search.replaceAll();

    expect(outcome.failed).toContain('/w/a.ts');
    expect(await platform.readTextFile('/w/a.ts')).toBe(
      'const needle = 1;\n  const needle2 = needle;\n',
    );
    // The other file is unaffected: one stale exclusion is not a whole-run
    // failure.
    expect(await platform.readTextFile('/w/b.ts')).toBe('import pin from "x";\n');
  });

  /** A file with no exclusions never pays for the extra walk or the refusal. */
  it('does not refuse a file that simply changed, with nothing dismissed in it', async () => {
    const { platform, workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');
    search.setReplacement('pin');

    platform.externalWrite('/w/a.ts', 'const first = 0;\nconst needle = 1;\n');
    const outcome = await search.replaceAll();

    expect(outcome.failed).toEqual([]);
    expect(await platform.readTextFile('/w/a.ts')).toBe('const first = 0;\nconst pin = 1;\n');
  });
});

describe('replacing exactly one match', () => {
  it('changes that match and no other', async () => {
    const { platform, workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');
    search.setReplacement('pin');

    const count = await search.replaceMatch('/w/a.ts', matchIn(search, '/w/a.ts', 2));

    expect(count).toBe(1);
    expect(await platform.readTextFile('/w/a.ts')).toBe(
      'const needle = 1;\nconst needle2 = pin;\n',
    );
  });

  /** Two matches on one line are told apart by column, not by line. */
  it('picks the right one when a line holds several', async () => {
    const { platform, workspace, search } = setup();
    platform.seedFile('/w/many.ts', 'needle needle needle\n');
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');
    search.setReplacement('pin');

    await search.replaceMatch('/w/many.ts', matchIn(search, '/w/many.ts', 1));

    expect(await platform.readTextFile('/w/many.ts')).toBe('needle pin needle\n');
  });

  /** It inherits the staleness refusal, because it is the same machinery. */
  it('does nothing when the match has moved', async () => {
    const { platform, workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');
    search.setReplacement('pin');
    const match = matchIn(search, '/w/a.ts', 0);

    platform.externalWrite('/w/a.ts', '\nconst needle = 1;\nconst needle2 = needle;\n');
    const count = await search.replaceMatch('/w/a.ts', match);

    expect(count).toBe(0);
    expect(await platform.readTextFile('/w/a.ts')).toBe(
      '\nconst needle = 1;\nconst needle2 = needle;\n',
    );
  });

  /** The undo a project replace offers covers a one-match replace too. */
  it('can be undone like any other replace', async () => {
    const { platform, workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');
    search.setReplacement('pin');

    await search.replaceMatch('/w/a.ts', matchIn(search, '/w/a.ts', 2));
    expect(await search.undoLastReplace()).toEqual({ restored: 1, skipped: 0 });

    expect(await platform.readTextFile('/w/a.ts')).toBe(
      'const needle = 1;\nconst needle2 = needle;\n',
    );
  });
});

import { JobRunner } from '../src/services/jobs';
import { history } from '@codemirror/commands';
import { describe, expect, it } from 'vitest';
import { applyEdits, computeReplacements, expandReplacement } from '../src/core/replace';
import { buildSearchRegex } from '../src/core/search-match';
import { MemoryPlatform } from '../src/platform/memory';
import { SearchService } from '../src/services/search';
import { WorkspaceService } from '../src/services/workspace';

/**
 * Replace is the one operation in Nox that rewrites files the user cannot see.
 * These tests lean hard on the cases where a bug would destroy work: dirty
 * buffers, stale results, and the undo path.
 */

const literal = { caseSensitive: true, wholeWord: false, regexp: false };
const asRegex = { ...literal, regexp: true };

function exec(pattern: string, text: string): RegExpExecArray {
  const matcher = new RegExp(pattern, 'd');
  const found = matcher.exec(text);
  if (!found) throw new Error('no match');
  return found;
}

describe('expandReplacement', () => {
  it('is literal when expansion is off', () => {
    expect(expandReplacement('$1 costs $5', exec('a', 'a'), false)).toBe('$1 costs $5');
  });

  it('substitutes numbered groups', () => {
    expect(expandReplacement('$2-$1', exec('(\\w+) (\\w+)', 'alpha beta'), true)).toBe(
      'beta-alpha',
    );
  });

  it('substitutes the whole match with $&', () => {
    expect(expandReplacement('[$&]', exec('\\w+', 'word'), true)).toBe('[word]');
  });

  it('unescapes $$ to a literal dollar', () => {
    expect(expandReplacement('$$5', exec('a', 'a'), true)).toBe('$5');
  });

  it('supports named groups', () => {
    expect(expandReplacement('$<who>', exec('(?<who>\\w+)', 'nox'), true)).toBe('nox');
  });

  it('leaves an out-of-range group reference literal', () => {
    // Silently deleting text the user typed would be worse than doing nothing.
    expect(expandReplacement('$9', exec('(\\w+)', 'a'), true)).toBe('$9');
  });

  it('yields empty for a group that did not participate', () => {
    expect(expandReplacement('[$1]', exec('(x)?y', 'y'), true)).toBe('[]');
  });
});

describe('applyEdits', () => {
  it('returns the text unchanged with no edits', () => {
    expect(applyEdits('hello', [])).toBe('hello');
  });

  it('applies several edits in order', () => {
    expect(
      applyEdits('aXbXc', [
        { from: 1, to: 2, insert: '1' },
        { from: 3, to: 4, insert: '2' },
      ]),
    ).toBe('a1b2c');
  });
});

describe('computeReplacements', () => {
  it('replaces every occurrence', () => {
    const result = computeReplacements('a b a', buildSearchRegex('a', literal), 'z');
    expect(result.text).toBe('z b z');
    expect(result.count).toBe(2);
  });

  it('handles matches spanning multiple lines of the document', () => {
    const result = computeReplacements(
      'one needle\ntwo needle\nthree\n',
      buildSearchRegex('needle', literal),
      'pin',
    );
    expect(result.text).toBe('one pin\ntwo pin\nthree\n');
    expect(result.count).toBe(2);
  });

  it('computes correct absolute offsets on later lines', () => {
    const result = computeReplacements('aaa\nbXb\n', buildSearchRegex('X', literal), 'Y');
    expect(result.edits).toEqual([{ from: 5, to: 6, insert: 'Y' }]);
  });

  it('expands groups only in regex mode', () => {
    const source = 'name: alpha';
    const withGroups = computeReplacements(
      source,
      buildSearchRegex('name: (\\w+)', asRegex),
      'who=$1',
      { expand: true },
    );
    expect(withGroups.text).toBe('who=alpha');

    const plain = computeReplacements(source, buildSearchRegex('name: alpha', literal), 'who=$1');
    expect(plain.text).toBe('who=$1');
  });

  it('skips indices the caller excluded', () => {
    const result = computeReplacements('a a a', buildSearchRegex('a', literal), 'z', {
      skip: new Set([1]),
    });
    expect(result.text).toBe('z a z');
    expect(result.count).toBe(2);
  });

  it('does not loop on a zero-width pattern', () => {
    const result = computeReplacements('abc', buildSearchRegex('x*', asRegex), 'Z', {
      expand: true,
    });
    expect(result.count).toBe(0);
    expect(result.text).toBe('abc');
  });

  it('supports deleting matches with an empty replacement', () => {
    const result = computeReplacements('keep DROP keep', buildSearchRegex('DROP ', literal), '');
    expect(result.text).toBe('keep keep');
  });

  it('preserves a trailing newline', () => {
    const result = computeReplacements('a\n', buildSearchRegex('a', literal), 'b');
    expect(result.text).toBe('b\n');
  });
});

// --- Service level ----------------------------------------------------------

function setup() {
  const platform = new MemoryPlatform();
  platform.seedFile('/w/a.ts', 'const needle = 1;\nconst needle2 = needle;\n');
  platform.seedFile('/w/b.ts', 'import needle from "x";\n');
  platform.seedFile('/w/c.md', 'no matches here\n');

  const workspace = new WorkspaceService(platform, () => []);
  const search = new SearchService(platform, workspace, new JobRunner());
  return { platform, workspace, search };
}

async function searchFor(search: SearchService, query: string) {
  search.query.set(query);
  await search.run();
}

describe('replace across files', () => {
  it('rewrites every matching file on disk', async () => {
    const { platform, workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');
    search.setReplacement('pin');

    const outcome = await search.replaceAll();

    expect(outcome.files).toBe(2);
    expect(outcome.matches).toBe(4);
    expect(await platform.readTextFile('/w/a.ts')).toBe('const pin = 1;\nconst pin2 = pin;\n');
    expect(await platform.readTextFile('/w/b.ts')).toBe('import pin from "x";\n');
    expect(await platform.readTextFile('/w/c.md')).toBe('no matches here\n');
  });

  it('replaces within a single file only', async () => {
    const { platform, workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');
    search.setReplacement('pin');

    expect(await search.replaceInFile('/w/b.ts')).toBe(1);
    expect(await platform.readTextFile('/w/b.ts')).toContain('pin');
    // The other file is untouched.
    expect(await platform.readTextFile('/w/a.ts')).toContain('needle');
  });

  it('drops replaced files from the results', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');
    search.setReplacement('pin');

    await search.replaceInFile('/w/b.ts');
    expect(search.results.get().map((f) => f.path)).toEqual(['/w/a.ts']);
  });

  it('expands capture groups in regex mode', async () => {
    const { platform, workspace, search } = setup();
    await workspace.openFolder('/w');
    search.setOption('regexp', true);
    await searchFor(search, 'const (\\w+)');
    search.setReplacement('let $1');

    await search.replaceAll();
    expect(await platform.readTextFile('/w/a.ts')).toBe('let needle = 1;\nlet needle2 = needle;\n');
  });

  it('deletes matches when the replacement is empty', async () => {
    const { platform, workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');
    search.setReplacement('');

    await search.replaceAll();
    expect(await platform.readTextFile('/w/b.ts')).toBe('import  from "x";\n');
  });

  it('does nothing when the query is empty', async () => {
    const { search } = setup();
    search.setReplacement('pin');
    expect(await search.replaceAll()).toEqual({ files: 0, matches: 0, failed: [] });
  });
});

describe('replace and open buffers', () => {
  it('applies through the buffer, not behind it', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    const id = (await workspace.open('/w/b.ts'))!;
    await searchFor(search, 'needle');
    search.setReplacement('pin');

    await search.replaceAll();

    // The in-memory buffer reflects the change immediately.
    expect(workspace.textOf(id)).toBe('import pin from "x";\n');
  });

  it('saves a clean buffer so disk and editor agree', async () => {
    const { platform, workspace, search } = setup();
    await workspace.openFolder('/w');
    const id = (await workspace.open('/w/b.ts'))!;
    await searchFor(search, 'needle');
    search.setReplacement('pin');

    await search.replaceAll();

    expect(await platform.readTextFile('/w/b.ts')).toBe('import pin from "x";\n');
    expect(workspace.buffers.get().find((b) => b.id === id)?.isDirty).toBe(false);
  });

  it('never discards unsaved edits in a dirty buffer', async () => {
    const { platform, workspace, search } = setup();
    await workspace.openFolder('/w');
    const id = (await workspace.open('/w/b.ts'))!;

    // Unsaved work the search results know nothing about.
    workspace.applyTransaction(
      id,
      workspace.stateOf(id)!.update({ changes: { from: 0, insert: '// unsaved\n' } }),
    );

    await searchFor(search, 'needle');
    search.setReplacement('pin');
    await search.replaceAll();

    const text = workspace.textOf(id)!;
    expect(text).toContain('// unsaved');
    expect(text).toContain('pin');
    // Still the user's to save: nothing was written under them.
    expect(workspace.buffers.get().find((b) => b.id === id)?.isDirty).toBe(true);
    expect(await platform.readTextFile('/w/b.ts')).toBe('import needle from "x";\n');
  });

  it('replaces against current buffer text, not the stale result rows', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');

    // Open and edit the file *after* the search ran, adding another match.
    const id = (await workspace.open('/w/b.ts'))!;
    workspace.applyTransaction(
      id,
      workspace.stateOf(id)!.update({ changes: { from: 0, insert: 'needle\n' } }),
    );

    search.setReplacement('pin');
    await search.replaceAll();

    // Both occurrences replaced, including the one added after the search.
    expect(workspace.textOf(id)).toBe('pin\nimport pin from "x";\n');
  });
});

describe('undoing a replace', () => {
  it('restores every file it changed', async () => {
    const { platform, workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');
    search.setReplacement('pin');
    await search.replaceAll();

    const result = await search.undoLastReplace();

    expect(result).toEqual({ restored: 2, skipped: 0 });
    expect(await platform.readTextFile('/w/a.ts')).toBe(
      'const needle = 1;\nconst needle2 = needle;\n',
    );
    expect(await platform.readTextFile('/w/b.ts')).toBe('import needle from "x";\n');
  });

  it('refuses to clobber a file changed since the replace', async () => {
    const { platform, workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');
    search.setReplacement('pin');
    await search.replaceAll();

    // Something else edits one of the files afterwards.
    platform.externalWrite('/w/b.ts', 'someone elses work\n');

    const result = await search.undoLastReplace();

    expect(result).toEqual({ restored: 1, skipped: 1 });
    expect(await platform.readTextFile('/w/b.ts')).toBe('someone elses work\n');
    expect(await platform.readTextFile('/w/a.ts')).toContain('needle');
  });

  it('is a one-shot', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');
    search.setReplacement('pin');
    await search.replaceAll();

    await search.undoLastReplace();
    expect(search.lastReplace.get()).toBeNull();
    expect(await search.undoLastReplace()).toEqual({ restored: 0, skipped: 0 });
  });

  it('is invalidated by a new search', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');
    search.setReplacement('pin');
    await search.replaceAll();
    expect(search.lastReplace.get()).not.toBeNull();

    await searchFor(search, 'const');
    expect(search.lastReplace.get()).toBeNull();
  });

  it('restores through an open buffer too', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    const id = (await workspace.open('/w/b.ts'))!;
    await searchFor(search, 'needle');
    search.setReplacement('pin');
    await search.replaceAll();

    await search.undoLastReplace();
    expect(workspace.textOf(id)).toBe('import needle from "x";\n');
  });
});

describe('replacement preview', () => {
  it('is the literal replacement for a plain search', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');
    search.setReplacement('pin');

    const match = search.results.get()[0]!.matches[0]!;
    expect(search.previewReplacement(match)).toBe('pin');
  });

  it('expands groups for a regex search', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    search.setOption('regexp', true);
    await searchFor(search, 'const (\\w+)');
    search.setReplacement('let $1');

    const match = search.results.get()[0]!.matches[0]!;
    expect(search.previewReplacement(match)).toBe('let needle');
  });

  it('reports null for an invalid pattern rather than throwing', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');

    search.setOption('regexp', true);
    search.query.set('(unclosed');
    search.setReplacement('x');

    expect(search.previewReplacement({ preview: 'needle', column: 0, length: 6 })).toBeNull();
  });
});

describe('pendingReplaceCount', () => {
  it('counts matches and files in the current results', async () => {
    const { workspace, search } = setup();
    await workspace.openFolder('/w');
    await searchFor(search, 'needle');

    expect(search.pendingReplaceCount()).toEqual({ files: 2, matches: 4 });
  });
});

describe('a project replace is one undo', () => {
  /**
   * Grouped undo rides on CodeMirror's history, so this harness installs it —
   * the default `() => []` factory above has none, and would let these pass
   * without exercising the mechanism at all.
   */
  function setupWithHistory() {
    const platform = new MemoryPlatform();
    platform.seedFile('/w/a.ts', 'const needle = 1;\nconst needle2 = needle;\n');
    platform.seedFile('/w/b.ts', 'import needle from "x";\n');

    const workspace = new WorkspaceService(platform, () => history());
    const search = new SearchService(platform, workspace, new JobRunner());
    return { platform, workspace, search };
  }

  it('takes every open file back in a single step', async () => {
    const { workspace, search } = setupWithHistory();
    await workspace.openFolder('/w');
    const a = (await workspace.open('/w/a.ts'))!;
    const b = (await workspace.open('/w/b.ts'))!;

    await searchFor(search, 'needle');
    search.setReplacement('pin');
    await search.replaceAll();

    expect(workspace.textOf(a)).toBe('const pin = 1;\nconst pin2 = pin;\n');
    expect(workspace.textOf(b)).toBe('import pin from "x";\n');

    // The whole replace is one action to the user, so it is one undo — not
    // one per file it happened to touch.
    const setId = workspace.pendingGroupedUndo();
    expect(setId).not.toBeNull();
    workspace.undoChangeSet(setId!);

    expect(workspace.textOf(a)).toBe('const needle = 1;\nconst needle2 = needle;\n');
    expect(workspace.textOf(b)).toBe('import needle from "x";\n');
  });

  it('records the replace in the transaction log', async () => {
    const { workspace, search } = setupWithHistory();
    await workspace.openFolder('/w');
    await workspace.open('/w/a.ts');
    await workspace.open('/w/b.ts');

    await searchFor(search, 'needle');
    search.setReplacement('pin');
    await search.replaceAll();

    const [entry] = workspace.log.recent(5);
    expect(entry?.description).toBe('Replace "needle"');
    expect(entry?.author).toEqual({ kind: 'user' });
    expect(entry?.bufferIds).toHaveLength(2);
  });

  it('leaves closed files to the panel journal, not the change set', async () => {
    const { platform, workspace, search } = setupWithHistory();
    await workspace.openFolder('/w');
    const a = (await workspace.open('/w/a.ts'))!;
    // b.ts stays closed.

    await searchFor(search, 'needle');
    search.setReplacement('pin');
    await search.replaceAll();

    // One buffer, so there is nothing to group — plain undo already covers it.
    workspace.setActive(a);
    expect(workspace.pendingGroupedUndo()).toBeNull();
    expect(await platform.readTextFile('/w/b.ts')).toBe('import pin from "x";\n');

    const outcome = await search.undoLastReplace();
    expect(outcome.restored).toBe(2);
    expect(await platform.readTextFile('/w/b.ts')).toBe('import needle from "x";\n');
    expect(workspace.textOf(a)).toBe('const needle = 1;\nconst needle2 = needle;\n');
  });
});

describe('replace is computed, then applied', () => {
  /**
   * Blocks the walk when it reaches `pauseAt`, so a test can act while the
   * replace is halfway through reading the project.
   */
  function pausableSetup(pauseAt: string) {
    const platform = new MemoryPlatform();
    platform.seedFile('/w/a.ts', 'const needle = 1;\n');
    platform.seedFile('/w/b.ts', 'import needle from "x";\n');

    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });

    const read = platform.readTextFile.bind(platform);
    platform.readTextFile = async (path: string) => {
      if (path === pauseAt) {
        reached();
        await paused;
      }
      return read(path);
    };

    const jobs = new JobRunner();
    const workspace = new WorkspaceService(platform, () => []);
    const search = new SearchService(platform, workspace, jobs);
    return { platform, workspace, search, jobs, arrived, release };
  }

  it('cancelling mid-walk changes nothing at all', async () => {
    const { platform, workspace, search, jobs, arrived, release } = pausableSetup('/w/b.ts');
    await workspace.openFolder('/w');
    const a = (await workspace.open('/w/a.ts'))!;

    await searchFor(search, 'needle');
    search.setReplacement('pin');

    const running = search.replaceAll();
    await arrived;

    jobs.cancelAll();
    release();
    const outcome = await running;

    expect(outcome.cancelled).toBe(true);
    // The whole point of computing before writing: a cancelled replace has
    // nothing to unwind, because it never wrote anything.
    expect(workspace.textOf(a)).toBe('const needle = 1;\n');
    expect(await platform.readTextFile('/w/b.ts')).toBe('import needle from "x";\n');
    expect(search.lastReplace.get()).toBeNull();
  });

  it('refuses to apply over a buffer edited while it was walking', async () => {
    const { workspace, search, arrived, release } = pausableSetup('/w/b.ts');
    await workspace.openFolder('/w');
    const a = (await workspace.open('/w/a.ts'))!;

    await searchFor(search, 'needle');
    search.setReplacement('pin');

    const running = search.replaceAll();
    await arrived;

    // The user types in a.ts while the walk is still reading b.ts. The text
    // the replace computed for a.ts no longer describes what is in it.
    workspace.applyTransaction(
      a,
      workspace.stateOf(a)!.update({ changes: { from: 0, insert: '// mine\n' } }),
    );

    release();
    const outcome = await running;

    // Their typing survives; the stale replacement is refused and reported.
    expect(workspace.textOf(a)).toBe('// mine\nconst needle = 1;\n');
    expect(outcome.failed).toContain('/w/a.ts');
  });

  it('applies normally when nothing moved during the walk', async () => {
    const { workspace, search, arrived, release } = pausableSetup('/w/b.ts');
    await workspace.openFolder('/w');
    const a = (await workspace.open('/w/a.ts'))!;

    await searchFor(search, 'needle');
    search.setReplacement('pin');

    const running = search.replaceAll();
    await arrived;
    release();
    const outcome = await running;

    expect(outcome.failed).toEqual([]);
    expect(workspace.textOf(a)).toBe('const pin = 1;\n');
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import ExplorerPanel from '../src/ui/ExplorerPanel.svelte';
import { parseGitStatus } from '../src/core/git-status';
import type { BufferId } from '../src/services/workspace';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * What the file tree says about change.
 *
 * The tree was the app's primary spatial model of a project and answered
 * neither "what have I changed" nor "what is unsaved": `FlatNode` carried
 * `path, name, isDirectory, depth, expanded, loading, empty, error` and
 * nothing else, so a user had to open the Git panel to learn anything had
 * changed and read the tab strip to learn what was unsaved. Both facts were
 * already in memory — `GitService.status` and `BufferSnapshot.isDirty`.
 *
 * Three things this suite exists to hold, beyond "the markers appear":
 *
 * 1. **The status map stays out of the model.** A git refresh must not
 *    re-flatten the tree. `nodes` identity is what the windowing slice, the
 *    `#each` key and every selection derived hang off, so republishing it
 *    for a fact none of them read would churn the whole panel.
 * 2. **Status paths join onto the repository toplevel, never the workspace
 *    root.** The two differ whenever a workspace is opened below the repo
 *    root, and the wrong join decorates a same-named file elsewhere in the
 *    tree — a wrong-file bug, not a cosmetic one.
 * 3. **Never colour alone (WCAG 1.4.1).** Six porcelain letters map onto
 *    four token colours, so colour could not separate them even for someone
 *    who can see all four. The letter is a character with a spelled-out
 *    accessible name, in the Git panel's vocabulary rather than a second one.
 *
 * Mutation checks (each made the named test red, then was reverted):
 * - `gitLetters` joining onto `$rootPath` instead of `status.toplevel` →
 *   "a status path joins onto the repository root, not the workspace root"
 *   (`inner.ts` lost its letter and the innocent `w/outer.ts` gained one).
 * - `status?.toplevel ?? $rootPath`, the fallback the guard exists to
 *   forbid → "a status with no toplevel decorates nothing".
 * - `status.unstaged` written before `status.staged`, so the index wins →
 *   "the worktree letter wins over the staged one".
 * - the `status.unstaged` pass deleted → seven tests, which is the shape a
 *   suite should have when the main path dies.
 * - `bufferPaths.dirty` adding every open path rather than the dirty ones →
 *   "saving clears the dot" and "an open but unmodified file gets no dot".
 * - a `files.refresh()` on every status change, standing in for the letter
 *   living on `FlatNode` → "a git refresh does not re-flatten the tree".
 * - `aria-label` dropped from the letter span → "the letter carries the Git
 *   panel's word…"; dropped from the dot → "marks an edited buffer…".
 * - the marks wrapper rendered unconditionally → "directories carry no
 *   marker".
 * - the dot rendered only `{#if dirty && !letter}` → "an unsaved file that
 *   git also knows about shows both".
 *
 * One survivor, recorded because it changes what the test means: dropping
 * only the `toplevel` half of the guard and joining onto `''` leaves every
 * test green. `join` discards empty segments, so the result is a *relative*
 * path that matches no row, and the panel silently does the right thing for
 * the wrong reason. The mutation above replaces it because it is the
 * failure that would really be written — a fallback to the root the panel
 * happens to have — and the survivor is not worth a test of its own.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

/** Longer than the git-panel suite's: `refreshStatus` sits behind the tree load. */
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  flush();
}

/** The row for `name`, by its label rather than its index. */
function row(container: HTMLElement, name: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('.row')].find(
    (element) => element.querySelector('.name')?.textContent === name,
  );
  if (!found) throw new Error(`no row for ${name} — rows: ${names(container).join(', ')}`);
  return found;
}

const names = (container: HTMLElement) =>
  [...container.querySelectorAll('.row .name')].map((n) => n.textContent);

/** `[letter, accessible name]` for a row, or null when it carries none. */
function letterOf(container: HTMLElement, name: string): [string | null, string | null] | null {
  const element = row(container, name).querySelector('.git-letter');
  return element ? [element.textContent, element.getAttribute('aria-label')] : null;
}

const hasDot = (container: HTMLElement, name: string) =>
  row(container, name).querySelector('.dirty-dot') !== null;

/** Dirty a buffer the way the editor does — through the one transaction door. */
function typeInto(app: Mounted['app'], id: BufferId): void {
  const state = app.workspace.stateOf(id)!;
  app.workspace.applyTransaction(id, state.update({ changes: { from: 0, insert: 'typed\n' } }));
}

/**
 * A repository at `/w` with one clean file, one edited, one untracked, and
 * one folder — the shapes the tree has to tell apart in a single render.
 */
async function setup() {
  mounted = mountComponent(ExplorerPanel);
  const { app, platform, container } = mounted;
  app.git.start();
  platform.seedGitRepo('/w');
  platform.seedGitBase('/w/clean.ts', 'same\n');
  platform.seedFile('/w/clean.ts', 'same\n');
  platform.seedGitBase('/w/edited.ts', 'one\n');
  platform.seedFile('/w/edited.ts', 'one\ntwo\n');
  platform.seedFile('/w/loose.ts', 'untracked\n');
  platform.mkdirp('/w/sub');
  await app.workspace.openFolder('/w');
  await app.files.setRoot('/w');
  await settle();
  return { app, platform, container };
}

describe('an untracked directory', () => {
  /**
   * The defect this guards, found by walking the packaged app and reachable
   * by no test before it: git collapses an untracked directory into a single
   * `? lib/` record and never names the files inside it. The tree matched
   * exact paths only, so a brand-new folder and everything in it carried no
   * marker at all — the one state where "is this new?" is the whole question.
   *
   * `seedGitUntrackedDirectory` exists so the fake emits that *shape*, not
   * merely those facts: seeding the files individually produces `? lib/a.ts`
   * records, which the old exact-match code already handled and which real
   * git never sends.
   */
  it('marks the files inside it, which git never names', async () => {
    mounted = mountComponent(ExplorerPanel);
    const { app, platform, container } = mounted;
    app.git.start();
    platform.seedGitRepo('/w');
    platform.seedGitBase('/w/tracked.ts', 'same\n');
    platform.seedFile('/w/tracked.ts', 'same\n');
    platform.mkdirp('/w/lib');
    platform.seedFile('/w/lib/helper.ts', 'new\n');
    platform.seedGitUntrackedDirectory('/w/lib');
    await app.workspace.openFolder('/w');
    await app.files.setRoot('/w');
    await settle();

    // The record really is the collapsed directory form, or this test would
    // be proving something easier than the defect.
    const raw = parseGitStatus(await platform.gitStatus('/w'));
    expect(raw.unstaged.map((e) => e.path)).toContain('lib/');
    expect(raw.unstaged.map((e) => e.path)).not.toContain('lib/helper.ts');

    await app.files.toggle('/w/lib');
    await settle();

    expect(letterOf(container, 'helper.ts')).toEqual(['U', 'Untracked']);
    expect(letterOf(container, 'tracked.ts')).toBeNull();
  });

  /**
   * The folder row itself, which was the one row this record could not reach.
   * The marks group used to be skipped for every directory, so `? lib/` — the
   * single case where git names a *folder* directly — decorated everything
   * inside `lib` and left `lib` bare. Collapsed, it is now the only row there
   * is, and it answers.
   */
  it('marks the folder row git named directly', async () => {
    mounted = mountComponent(ExplorerPanel);
    const { app, platform, container } = mounted;
    app.git.start();
    platform.seedGitRepo('/w');
    platform.mkdirp('/w/lib');
    platform.seedFile('/w/lib/helper.ts', 'new\n');
    platform.seedGitUntrackedDirectory('/w/lib');
    await app.workspace.openFolder('/w');
    await app.files.setRoot('/w');
    await settle();

    expect(letterOf(container, 'lib')).toEqual(['U', 'Contains untracked files']);
  });
});

describe('git status on the tree', () => {
  it('marks changed files with the porcelain letter and leaves clean ones bare', async () => {
    const { container } = await setup();

    expect(letterOf(container, 'edited.ts')?.[0]).toBe('M');
    expect(letterOf(container, 'loose.ts')?.[0]).toBe('U');
    expect(letterOf(container, 'clean.ts')).toBeNull();
  });

  it('the letter carries the Git panel’s word, not just its initial', async () => {
    // The whole point of a character over a colour swatch: a screen reader
    // and a hover both get "Modified", and the two views say the same word.
    const { container } = await setup();

    expect(letterOf(container, 'edited.ts')).toEqual(['M', 'Modified']);
    expect(letterOf(container, 'loose.ts')).toEqual(['U', 'Untracked']);
    const element = row(container, 'edited.ts').querySelector('.git-letter')!;
    expect(element.getAttribute('title')).toBe(element.getAttribute('aria-label'));
  });

  it('reads a conflict as C, the one state where staging does damage', async () => {
    const { app, platform, container } = await setup();
    platform.seedGitConflict('/w/edited.ts', '<<<<<<< HEAD\n');
    await app.files.refresh();
    await app.git.refreshStatus();
    await settle();

    expect(letterOf(container, 'edited.ts')).toEqual(['C', 'Conflicted']);
  });

  it('the worktree letter wins over the staged one', async () => {
    // The tree shows the file on disk, so when the index and the worktree
    // disagree the worktree is the fact the row is about.
    const { app, platform, container } = await setup();
    await platform.gitStage('/w', ['/w/loose.ts']); // staged A…
    platform.seedFile('/w/loose.ts', 'untracked\nmore\n'); // …then edited again
    await app.git.refreshStatus();
    await settle();

    expect(letterOf(container, 'loose.ts')?.[0]).toBe('M');
  });

  it('a status path joins onto the repository root, not the workspace root', async () => {
    // The two differ the moment a workspace is opened below its repo root,
    // and the wrong join is not a missing marker — it is a marker on the
    // wrong file. `/w/outer.ts` is the innocent bystander: git's record says
    // `outer.ts` relative to `/repo`, which joined onto the workspace root
    // would land squarely on it.
    mounted = mountComponent(ExplorerPanel);
    const { app, platform, container } = mounted;
    app.git.start();
    platform.seedGitRepo('/repo');
    platform.seedGitBase('/repo/outer.ts', 'one\n');
    platform.seedFile('/repo/outer.ts', 'one\ntwo\n');
    platform.seedGitBase('/repo/w/inner.ts', 'one\n');
    platform.seedFile('/repo/w/inner.ts', 'one\ntwo\n');
    platform.seedGitBase('/repo/w/outer.ts', 'untouched\n');
    platform.seedFile('/repo/w/outer.ts', 'untouched\n');
    await app.workspace.openFolder('/repo/w');
    await app.files.setRoot('/repo/w');
    await settle();

    expect(letterOf(container, 'inner.ts')?.[0]).toBe('M');
    expect(letterOf(container, 'outer.ts')).toBeNull();
  });

  it('a status with no toplevel decorates nothing', async () => {
    // "Cannot join honestly" must mean no answer, not a guess: a malformed
    // or pre-model status is exactly when a guess lands on the wrong file.
    const { app, container } = await setup();
    app.git.status.set(parseGitStatus('# branch.head main\0? loose.ts\0'));
    await settle();

    expect(letterOf(container, 'loose.ts')).toBeNull();
  });

  it('a folder with nothing changed inside it carries no marker', async () => {
    // The roll-up must stay silent as readily as it speaks: a wrapper that
    // renders empty would claim the free space the `empty` / `unreadable`
    // notes need at the same right edge, and a tree of quiet folders would
    // read as a wall of markers. `/w/sub` holds nothing at all.
    const { container } = await setup();

    expect(row(container, 'sub').querySelector('.marks')).toBeNull();
  });

  it('a git refresh does not re-flatten the tree', async () => {
    // The status map is view state layered onto the model, deliberately not
    // a `FlatNode` field. If it moved into `FileTreeService`, every
    // `refreshStatus` would publish a new `nodes` array — and that identity
    // is what the windowing slice, the `#each` key and every selection
    // derived hang off. The second assertion keeps the first honest: the
    // refresh has to have actually changed something.
    const { app, platform, container } = await setup();
    const before = app.files.nodes.get();

    platform.seedFile('/w/clean.ts', 'same\nchanged\n');
    await app.git.refreshStatus();
    await settle();

    expect(app.files.nodes.get()).toBe(before);
    expect(letterOf(container, 'clean.ts')?.[0]).toBe('M');
  });
});

describe('unsaved files on the tree', () => {
  it('marks an edited buffer with a dot and names it', async () => {
    const { app, container } = await setup();
    expect(hasDot(container, 'clean.ts')).toBe(false);

    const id = (await app.workspace.open('/w/clean.ts'))!;
    typeInto(app, id);
    await settle();

    expect(hasDot(container, 'clean.ts')).toBe(true);
    expect(row(container, 'clean.ts').querySelector('.dirty-dot')!.getAttribute('aria-label')).toBe(
      'Unsaved changes',
    );
  });

  it('saving clears the dot', async () => {
    const { app, container } = await setup();
    const id = (await app.workspace.open('/w/clean.ts'))!;
    typeInto(app, id);
    await settle();
    expect(hasDot(container, 'clean.ts')).toBe(true);

    await app.workspace.save(id);
    await settle();

    expect(hasDot(container, 'clean.ts')).toBe(false);
  });

  it('an open but unmodified file gets no dot', async () => {
    // The dirty set is derived beside the open set and from the same walk;
    // the cheapest way to break it is to let the two collapse into one.
    const { app, container } = await setup();
    await app.workspace.open('/w/clean.ts');
    await settle();

    expect(row(container, 'clean.ts').classList.contains('open')).toBe(true);
    expect(hasDot(container, 'clean.ts')).toBe(false);
  });

  it('an unsaved file that git also knows about shows both', async () => {
    // They occupy one wrapper, so the failure mode is one silently pushing
    // the other out of the row.
    const { app, container } = await setup();
    const id = (await app.workspace.open('/w/edited.ts'))!;
    typeInto(app, id);
    await settle();

    expect(letterOf(container, 'edited.ts')?.[0]).toBe('M');
    expect(hasDot(container, 'edited.ts')).toBe(true);
  });
});

describe('a collapsed folder', () => {
  /**
   * A repository whose changes all sit below `/w/src`, so the row under test
   * is a folder the tree has **never expanded**. That is the property the
   * roll-up turns on: `FileTreeService` loads directories lazily, so `#dirs`
   * holds no entries for `src` at all here, and anything deriving the marker
   * by walking the tree would answer "nothing in here" for exactly the
   * folders nobody has looked inside yet.
   */
  async function nested() {
    mounted = mountComponent(ExplorerPanel);
    const { app, platform, container } = mounted;
    app.git.start();
    platform.seedGitRepo('/w');
    platform.seedGitBase('/w/src/edited.ts', 'one\n');
    platform.seedFile('/w/src/edited.ts', 'one\ntwo\n');
    platform.seedGitBase('/w/src/deep/buried.ts', 'one\n');
    platform.seedFile('/w/src/deep/buried.ts', 'one\ntwo\n');
    platform.seedGitBase('/w/quiet.ts', 'same\n');
    platform.seedFile('/w/quiet.ts', 'same\n');
    await app.workspace.openFolder('/w');
    await app.files.setRoot('/w');
    await settle();
    return { app, platform, container };
  }

  it('says a change is inside it, and a quiet sibling still says nothing', async () => {
    const { container } = await nested();

    expect(letterOf(container, 'src')?.[0]).toBe('M');
    expect(letterOf(container, 'quiet.ts')).toBeNull();
  });

  it('shows the worst letter beneath it, not the first or the commonest', async () => {
    // Thirty ordinary edits must not bury the one file where staging the
    // folder would do damage. `deep/buried.ts` is two levels down, so this
    // also proves the fold survives the climb rather than only comparing
    // siblings.
    const { app, platform, container } = await nested();
    platform.seedGitConflict('/w/src/deep/buried.ts', '<<<<<<< HEAD\n');
    await app.git.refreshStatus();
    await settle();

    expect(letterOf(container, 'src')?.[0]).toBe('C');
  });

  it('says the letter is about its contents, not about itself', async () => {
    // A folder is not a modified file, and the accessible name is the only
    // place that distinction can live: the character and its colour are the
    // file vocabulary exactly, deliberately, so there is one visual language
    // rather than two.
    const { container } = await nested();

    expect(letterOf(container, 'src')).toEqual(['M', 'Contains modified files']);
    const element = row(container, 'src').querySelector('.git-letter')!;
    expect(element.getAttribute('title')).toBe(element.getAttribute('aria-label'));
  });

  it('hands the summary back to the detail when it is expanded', async () => {
    // The marker answers "is it worth opening this". Once it is open the rows
    // themselves answer, and leaving it would stack the same letter up every
    // ancestor of whatever file you were reading.
    const { app, container } = await nested();
    expect(letterOf(container, 'src')?.[0]).toBe('M');

    await app.files.toggle('/w/src');
    await settle();

    expect(letterOf(container, 'src')).toBeNull();
    expect(letterOf(container, 'edited.ts')).toEqual(['M', 'Modified']);
    expect(letterOf(container, 'deep')?.[0]).toBe('M');
  });

  it('clears when the change beneath it does', async () => {
    const { app, platform, container } = await nested();
    expect(letterOf(container, 'src')?.[0]).toBe('M');

    platform.seedFile('/w/src/edited.ts', 'one\n');
    platform.seedFile('/w/src/deep/buried.ts', 'one\n');
    await app.git.refreshStatus();
    await settle();

    expect(letterOf(container, 'src')).toBeNull();
  });

  it('carries the unsaved dot for a file inside it', async () => {
    // Opening a file reveals it, which expands every folder above it — so the
    // collapse is not test scaffolding, it is the gesture the feature exists
    // for: edit a file, fold the folder away, and it still says so.
    const { app, container } = await nested();
    expect(hasDot(container, 'src')).toBe(false);

    const id = (await app.workspace.open('/w/src/deep/buried.ts'))!;
    typeInto(app, id);
    await settle();
    expect(hasDot(container, 'src')).toBe(false);

    await app.files.toggle('/w/src');
    await settle();

    expect(hasDot(container, 'src')).toBe(true);
    expect(row(container, 'src').querySelector('.dirty-dot')!.getAttribute('aria-label')).toBe(
      'Contains unsaved changes',
    );
  });

  it('shows both when it holds a conflict and an unsaved file', async () => {
    // One wrapper holds both, so the failure mode is one silently pushing the
    // other out of the row — the same shape as the file-row case, which is
    // why it is worth asserting again a level up.
    const { app, platform, container } = await nested();
    platform.seedGitConflict('/w/src/deep/buried.ts', '<<<<<<< HEAD\n');
    await app.git.refreshStatus();
    const id = (await app.workspace.open('/w/src/edited.ts'))!;
    typeInto(app, id);
    await settle();
    await app.files.toggle('/w/src'); // opening revealed it; fold it back
    await settle();

    expect(letterOf(container, 'src')?.[0]).toBe('C');
    expect(hasDot(container, 'src')).toBe(true);
  });

  it('is marked even when it is the repository toplevel that differs', async () => {
    // The wrong-file bug the per-file map exists to prevent, one level up: a
    // roll-up joined onto the workspace root instead of `status.toplevel`
    // would mark `/repo/w/src` from a record about `/repo/src`.
    mounted = mountComponent(ExplorerPanel);
    const { app, platform, container } = mounted;
    app.git.start();
    platform.seedGitRepo('/repo');
    platform.seedGitBase('/repo/src/outer.ts', 'one\n');
    platform.seedFile('/repo/src/outer.ts', 'one\ntwo\n');
    platform.seedGitBase('/repo/w/src/quiet.ts', 'same\n');
    platform.seedFile('/repo/w/src/quiet.ts', 'same\n');
    await app.workspace.openFolder('/repo/w');
    await app.files.setRoot('/repo/w');
    await settle();

    expect(letterOf(container, 'src')).toBeNull();
  });
});

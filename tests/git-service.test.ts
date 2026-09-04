import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import { MAX_BLAME_BYTES, MAX_DIFF_BYTES } from '../src/services/git';
import { LARGE_FILE_BYTES } from '../src/services/workspace';

/**
 * GitService over a real workspace and a MemoryPlatform with seeded bases.
 *
 * Started directly, the way tests start the LSP service — the app only
 * starts it behind `capabilities.gitState`, which the memory platform
 * rightly reports false.
 *
 * Fake timers drive the 300 ms debounce; `flush()` is not used for the
 * typing test on purpose, so the debounce itself is what is proved.
 */

const FILE = '/w/main.ts';
const BASE = 'one\ntwo\nthree\n';

let app: NoxApp;
let platform: MemoryPlatform;

beforeEach(() => {
  vi.useFakeTimers();
  platform = new MemoryPlatform();
  app = new NoxApp(platform);
  app.git.start();
});

afterEach(() => {
  app.git.dispose();
  vi.useRealTimers();
});

async function openSeeded(text = BASE, base: string | null = BASE) {
  platform.seedFile(FILE, text);
  if (base !== null) platform.seedGitBase(FILE, base);
  await app.workspace.openFolder('/w');
  const id = (await app.workspace.open(FILE))!;
  // buffer-opened kicks off an async base fetch; let it land.
  await vi.runAllTimersAsync();
  return id;
}

describe('the git service', () => {
  it('has hunks for an opened file that differs from its base', async () => {
    const id = await openSeeded('one\nTWO\nthree\n');
    const entry = app.git.hunks.get().get(id)!;
    expect(entry).toBeDefined();
    expect(entry.hunks).toEqual([{ fromLine: 1, removed: ['two\n'], added: ['TWO\n'] }]);
    expect(entry.revision).toBe(app.workspace.revisionOf(id));
  });

  it('has no entry for a file that matches its base, or has no base', async () => {
    const same = await openSeeded(BASE, BASE);
    expect(app.git.hunks.get().has(same)).toBe(false);

    platform.seedFile('/w/loose.ts', 'untracked\n');
    const loose = (await app.workspace.open('/w/loose.ts'))!;
    await vi.runAllTimersAsync();
    expect(app.git.hunks.get().has(loose)).toBe(false);
  });

  it('recomputes after the debounce when the buffer changes', async () => {
    const id = await openSeeded();
    expect(app.git.hunks.get().has(id)).toBe(false);

    const state = app.workspace.stateOf(id)!;
    app.workspace.applyTransaction(id, state.update({ changes: { from: 0, insert: 'zero\n' } }));

    // Inside the debounce window: nothing yet.
    await vi.advanceTimersByTimeAsync(200);
    expect(app.git.hunks.get().has(id)).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    const entry = app.git.hunks.get().get(id)!;
    expect(entry.hunks).toEqual([{ fromLine: 0, removed: [], added: ['zero\n'] }]);
  });

  it('refetches the base on save, so a base changed behind its back is seen', async () => {
    const id = await openSeeded('one\nTWO\nthree\n');
    expect(app.git.hunks.get().has(id)).toBe(true);

    // The index moves (a stage made elsewhere): the buffer's text is now
    // exactly what git holds.
    platform.seedGitBase(FILE, 'one\nTWO\nthree\n');
    await app.workspace.save(id);
    await vi.runAllTimersAsync();

    expect(app.git.hunks.get().has(id)).toBe(false);
  });

  it('drops the entry when the buffer closes', async () => {
    const id = await openSeeded('one\nTWO\nthree\n');
    expect(app.git.hunks.get().has(id)).toBe(true);
    app.workspace.close(id, { force: true });
    expect(app.git.hunks.get().has(id)).toBe(false);
  });

  /**
   * A4-006: `#bases` is keyed by path, not by buffer id, and closing used to
   * clear every *other* per-buffer map (`hunks`, `#computed`, `#timers`,
   * blame) but never this one — a day-long session opening and closing
   * thousands of tracked files retained a full second copy of every one of
   * them, forever. `baseFor` is the only public window onto the map:
   * `undefined` means "never fetched", which is indistinguishable from
   * "fetched, then forgotten" from outside, so this pins the forgetting by
   * checking that a *reopen* pays for a fresh fetch rather than serving the
   * stale entry `refreshStatus`/`#refresh` would otherwise still find.
   */
  it('forgets a closed file base rather than keeping it for the rest of the session', async () => {
    const id = await openSeeded('one\nTWO\nthree\n');
    expect(app.git.baseFor(FILE)).toBe(BASE);

    app.workspace.close(id, { force: true });
    expect(app.git.baseFor(FILE), 'forgotten on close, not merely unread').toBeUndefined();

    // The index moved while the file was closed - a stage made elsewhere.
    // A stale #bases entry would mean the reopened buffer is diffed against
    // the wrong text; forgetting the base is what makes the reopen the one
    // thing that goes and asks git again.
    platform.seedGitBase(FILE, 'one\nTWO\nCHANGED\n');
    const reopened = (await app.workspace.open(FILE))!;
    await vi.runAllTimersAsync();

    expect(app.git.baseFor(FILE)).toBe('one\nTWO\nCHANGED\n');
    const entry = app.git.hunks.get().get(reopened)!;
    expect(entry.hunks).toEqual([{ fromLine: 2, removed: ['CHANGED\n'], added: ['three\n'] }]);
  });

  it('skips a base past the size guard', async () => {
    const id = await openSeeded('x\n', 'y\n'.repeat(MAX_DIFF_BYTES / 2 + 1));
    expect(app.git.hunks.get().has(id)).toBe(false);
  });

  it('does not invent hunks from a CRLF base against the LF buffer', async () => {
    const id = await openSeeded(BASE, '﻿one\r\ntwo\r\nthree\r\n');
    expect(app.git.hunks.get().has(id)).toBe(false);
  });

  it('bumps baseRevision whenever a base arrives, even for a clean file', async () => {
    // The hunks signal stays silent when a clean file's base lands — nothing
    // changed in it — but the diff view must still move from "asking git" to
    // "no changes", and baseRevision is the only tick it gets. jsdom cannot
    // stage that race (the base always lands before the first paint), so the
    // guarantee is pinned here at the service instead.
    platform.seedFile(FILE, BASE);
    platform.seedGitBase(FILE, BASE);
    await app.workspace.openFolder('/w');
    await vi.runAllTimersAsync();
    // After the folder settles: the only bump left to come is the fetch's.
    const before = app.git.baseRevision.get();
    const id = (await app.workspace.open(FILE))!;
    await vi.runAllTimersAsync();
    expect(app.git.hunks.get().has(id)).toBe(false);
    expect(app.git.baseRevision.get()).toBeGreaterThan(before);
  });

  it('re-asks for every base on refreshAll', async () => {
    const id = await openSeeded(BASE, BASE);
    expect(app.git.hunks.get().has(id)).toBe(false);

    // A commit in the terminal: the index now differs from the buffer.
    platform.seedGitBase(FILE, 'one\n');
    await app.git.refreshAll();
    await vi.runAllTimersAsync();

    const entry = app.git.hunks.get().get(id)!;
    expect(entry.hunks).toEqual([{ fromLine: 1, removed: [], added: ['two\n', 'three\n'] }]);
  });
});

describe('the status signal', () => {
  it('is populated after a folder with a repo opens', async () => {
    platform.seedGitRepo('/w');
    platform.seedFile(FILE, BASE);
    await app.workspace.openFolder('/w');
    await vi.runAllTimersAsync();

    const status = app.git.status.get()!;
    expect(status.branch).toBe('main');
    expect(status.unstaged).toContainEqual({ path: 'main.ts', status: 'U' });
  });

  it('is null over a folder that is not a repository', async () => {
    platform.seedFile('/plain/a.txt', 'x\n');
    await app.workspace.openFolder('/plain');
    await vi.runAllTimersAsync();
    expect(app.git.status.get()).toBeNull();
  });

  it('coalesces concurrent refreshes: one in flight, one queued, not N', async () => {
    platform.seedGitRepo('/w');
    platform.seedFile(FILE, BASE);
    await app.workspace.openFolder('/w');
    await vi.runAllTimersAsync();

    let calls = 0;
    const real = platform.gitStatus.bind(platform);
    platform.gitStatus = async (root: string) => {
      calls++;
      return real(root);
    };

    void app.git.refreshStatus();
    void app.git.refreshStatus();
    void app.git.refreshStatus();
    void app.git.refreshStatus();
    await vi.runAllTimersAsync();

    // The first call was in flight; the other three collapsed to one queued.
    expect(calls).toBe(2);
  });

  it('refreshes after a save, the way bases already do', async () => {
    platform.seedGitRepo('/w');
    const id = await openSeeded('one\nTWO\nthree\n');
    expect(app.git.status.get()!.unstaged).toContainEqual({ path: 'main.ts', status: 'M' });

    // The index moves behind our back; the save-triggered refresh sees it.
    await platform.gitStage('/w', [FILE]);
    await app.workspace.save(id);
    await vi.runAllTimersAsync();
    expect(app.git.status.get()!.staged).toContainEqual({ path: 'main.ts', status: 'M' });
  });

  it('lists branches, parsed', async () => {
    // openFolder requires the directory to exist on disk; seedGitRepo alone
    // only builds the fake repo model, the way tests/git-platform.test.ts
    // already documents with its own explicit mkdirp before seedGitRepo.
    platform.mkdirp('/w');
    platform.seedGitRepo('/w');
    await app.workspace.openFolder('/w');
    await vi.runAllTimersAsync();
    await platform.gitSwitch('/w', 'feature', true);
    expect((await app.git.listBranches()).sort()).toEqual(['feature', 'main']);
  });

  it('shows a staged-then-re-modified file in both staged and unstaged (porcelain MM)', async () => {
    // Deferred finding from Task 2's review: a file staged and then edited
    // again in the worktree is neither purely staged nor purely unstaged —
    // porcelain reports both halves on the same record, and the panel needs
    // both lists to carry it so neither section silently drops the file.
    platform.seedGitRepo('/w');
    // Committed base, then a worktree edit: unstaged M to start.
    await openSeeded('one\nTWO\nthree\n');
    await app.git.refreshStatus();
    await vi.runAllTimersAsync();
    expect(app.git.status.get()!.unstaged).toContainEqual({ path: 'main.ts', status: 'M' });

    // Stage that edit: the index now differs from HEAD (staged M), and the
    // worktree matches the index (nothing unstaged) — the ordinary case.
    await platform.gitStage('/w', [FILE]);
    // Re-modify in the worktree after staging: the worktree now differs
    // from the index too, while the index still differs from HEAD — MM.
    platform.seedFile(FILE, 'one\nTWO\nTHREE\n');
    await app.git.refreshStatus();
    await vi.runAllTimersAsync();

    const status = app.git.status.get()!;
    expect(status.staged).toContainEqual({ path: 'main.ts', status: 'M' });
    expect(status.unstaged).toContainEqual({ path: 'main.ts', status: 'M' });
  });
});

describe('the .git meta watch', () => {
  it('a commit made outside the service moves the status and the bases, debounced 300ms', async () => {
    platform.seedGitRepo('/w');
    const id = await openSeeded('one\nTWO\nthree\n');
    expect(app.git.hunks.get().has(id)).toBe(true);

    // "Committed in the terminal": stage + commit straight on the platform,
    // never through the service — only the watcher can carry the news.
    await platform.gitStage('/w', [FILE]);
    await platform.gitCommit('/w', 'terminal commit');

    // Inside the debounce window: the status still shows the pre-mutation
    // truth (the unstaged edit) — no refresh has run between the stage, the
    // commit, and now, which is exactly what "unchanged until 300 ms" means.
    await vi.advanceTimersByTimeAsync(200);
    expect(app.git.status.get()!.unstaged).toContainEqual({ path: 'main.ts', status: 'M' });

    await vi.advanceTimersByTimeAsync(200);
    await vi.runAllTimersAsync();
    expect(app.git.status.get()!.staged).toEqual([]);
    // The base refetch followed: the index now matches the buffer.
    expect(app.git.hunks.get().has(id)).toBe(false);
  });

  it('a burst of meta events collapses to one refresh at the end', async () => {
    platform.seedGitRepo('/w');
    platform.seedFile(FILE, BASE);
    await app.workspace.openFolder('/w');
    await vi.runAllTimersAsync();

    let calls = 0;
    const real = platform.gitStatus.bind(platform);
    platform.gitStatus = async (root: string) => {
      calls++;
      return real(root);
    };

    // A rebase in the terminal fires dozens; the fake fires one per write.
    await platform.gitStage('/w', [FILE]);
    await platform.gitCommit('/w', 'one');
    await platform.gitSwitch('/w', 'burst', true);
    await vi.runAllTimersAsync();

    // One debounced refresh (plus at most its queued follower) — not three.
    expect(calls).toBeLessThanOrEqual(2);
  });
});

/**
 * Blame, over the same seeded platform.
 *
 * `seedGitBlame` names one commit per line and the fake renders real
 * `--porcelain` from it, a commit stated once and repeats reduced to a bare
 * header, so these tests exercise the parser through the same shape the
 * Rust command produces rather than through a convenient one. The seed below
 * puts the same commit on lines 1 and 3 with another between them, which is
 * exactly the arrangement that produces a bare repeat.
 */
describe('the blame gutter´s service half', () => {
  const FIRST = 'a'.repeat(40);
  const SECOND = 'b'.repeat(40);
  const SEED = [
    { hash: FIRST, author: 'Jane Doe', summary: 'Add three lines' },
    { hash: SECOND, author: 'Bo', summary: 'Shout the middle one' },
    { hash: FIRST, author: 'Jane Doe', summary: 'Add three lines' },
  ];

  async function openBlamed(text = BASE) {
    platform.seedFile(FILE, text);
    platform.seedGitBase(FILE, text);
    platform.seedGitBlame(FILE, SEED);
    await app.workspace.openFolder('/w');
    const id = (await app.workspace.open(FILE))!;
    await vi.runAllTimersAsync();
    return id;
  }

  function type(id: string, insert: string) {
    const state = app.workspace.stateOf(id)!;
    app.workspace.applyTransaction(id, state.update({ changes: { from: 0, insert } }));
  }

  /**
   * The whole of "on demand, not always on" (ROADMAP v0.5). Opening a file,
   * editing it and saving it must not cost a `git blame`. That walk is the
   * most expensive read in the service, and nothing but the toggle may start
   * one.
   */
  it('asks git nothing until it is switched on', async () => {
    const spy = vi.spyOn(platform, 'gitBlame');
    const id = await openBlamed();
    type(id, 'zero\n');
    await app.workspace.save(id);
    await vi.runAllTimersAsync();
    expect(spy).not.toHaveBeenCalled();
    expect(app.git.blameShown(id)).toBe(false);
  });

  it('paints the blamed lines when switched on and drops them when switched off', async () => {
    const id = await openBlamed();

    await app.git.toggleBlame(id);
    const lines = app.git.blame.get().get(id)!;
    expect(lines.map((l) => l.line)).toEqual([1, 2, 3]);
    expect(lines.map((l) => l.commit.author)).toEqual(['Jane Doe', 'Bo', 'Jane Doe']);
    // The repeat carried its commit forward through the fake's real shape.
    expect(lines[2]!.commit).toBe(lines[0]!.commit);

    await app.git.toggleBlame(id);
    expect(app.git.blameShown(id)).toBe(false);
    expect(app.git.blame.get().has(id)).toBe(false);
  });

  /**
   * The `--contents` contract, asserted at the seam that would break it. The
   * gutter draws beside the buffer, so git must be given the buffer. Hand
   * it the saved file instead and every annotation below an unsaved
   * insertion names the wrong person.
   */
  it('sends the buffer´s text rather than the file´s', async () => {
    const id = await openBlamed();
    const spy = vi.spyOn(platform, 'gitBlame');
    type(id, 'unsaved\n');

    await app.git.toggleBlame(id);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toBe(app.workspace.textOf(id));
    // And not what is on disk, which is still the seeded text.
    expect(spy.mock.calls[0]![1]).not.toBe(BASE);
  });

  /**
   * Saving is where a blame taken mid-edit stops being an approximation, so
   * it is the one edit that refetches. A buffer blame is *off* for still
   * costs nothing: the switch is the user's, and a refresh must not flip it.
   */
  it('refetches on save, and only for the buffers it is on for', async () => {
    const id = await openBlamed();
    platform.seedFile('/w/other.ts', BASE);
    platform.seedGitBase('/w/other.ts', BASE);
    platform.seedGitBlame('/w/other.ts', SEED);
    const other = (await app.workspace.open('/w/other.ts'))!;
    await vi.runAllTimersAsync();

    await app.git.toggleBlame(id);
    const spy = vi.spyOn(platform, 'gitBlame');

    type(id, 'zero\n');
    await app.workspace.save(id);
    await vi.runAllTimersAsync();
    type(other, 'zero\n');
    await app.workspace.save(other);
    await vi.runAllTimersAsync();

    expect(spy.mock.calls.map((call) => call[0])).toEqual([FILE]);
  });

  it('switches off when the buffer closes', async () => {
    const id = await openBlamed();
    await app.git.toggleBlame(id);
    app.workspace.close(id, { force: true });
    expect(app.git.blame.get().has(id)).toBe(false);
  });

  /**
   * Absence, not refusal: a file outside a repository turns the gutter on
   * and shows nothing, the same degraded state the git gutter has. The entry
   * is what keeps the column installed, so the user can see that the toggle
   * did something and turn it back off.
   */
  it('switches on but shows nothing for a file git has no blame for', async () => {
    platform.seedFile('/w/loose.ts', BASE);
    await app.workspace.openFolder('/w');
    const id = (await app.workspace.open('/w/loose.ts'))!;
    await vi.runAllTimersAsync();

    await app.git.toggleBlame(id);
    expect(app.git.blameShown(id)).toBe(true);
    expect(app.git.blame.get().get(id)).toEqual([]);
  });

  it('does not ask git about a document past the size cap', async () => {
    const id = await openBlamed('x'.repeat(MAX_BLAME_BYTES + 1));
    const spy = vi.spyOn(platform, 'gitBlame');

    await app.git.toggleBlame(id);

    expect(spy).not.toHaveBeenCalled();
    expect(app.git.blame.get().get(id)).toEqual([]);
  });

  it('forgets every blame when the root changes', async () => {
    const id = await openBlamed();
    await app.git.toggleBlame(id);
    expect(app.git.blameShown(id)).toBe(true);

    platform.seedFile('/other/main.ts', BASE);
    await app.workspace.openFolder('/other');
    await vi.runAllTimersAsync();

    expect(app.git.blame.get().size).toBe(0);
  });

  /**
   * The race the retry exists for. git's answer describes the text the
   * request carried, so a *line* typed while it was working leaves every
   * annotation below it one row out until the next save. One re-request,
   * only when the revision actually moved, closes that, and it cannot loop,
   * because no edit ever triggers a fetch in the first place.
   *
   * Mutation check: disabling the `revisionOf(id) !== requestedAt` branch in
   * `#refreshBlame` turned this red (expected 2 calls, got 1) and left the
   * other 26 green; restored, suite green.
   */
  it('re-asks once, with fresh text, when the document moved while git worked', async () => {
    const id = await openBlamed();
    const real = platform.gitBlame.bind(platform);
    let release: (() => void) | null = null;
    const spy = vi
      .spyOn(platform, 'gitBlame')
      .mockImplementation(async (path: string, contents: string) => {
        if (spy.mock.calls.length === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return real(path, contents);
      });

    const toggling = app.git.toggleBlame(id);
    await Promise.resolve();
    type(id, 'typed while git was working\n');
    release!();
    await toggling;

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]![1]).toBe(app.workspace.textOf(id));
  });

  /**
   * Large files (A4-004): no gutter for a buffer over `LARGE_FILE_BYTES`.
   *
   * Read what this actually pins, because the obvious half of it has no
   * teeth. `MAX_DIFF_BYTES` is 2 MB, so a 5 MB buffer had no hunks before
   * this change either: asserting the empty map passes with the threshold
   * removed. What is new is that neither whole-file copy is *made* any more.
   * `gitFileBase` brought the base back across the IPC hop and `textOf` was a
   * whole-document `toString`, both before anything checked a size, and the
   * call count is the assertion with the mutation behind it.
   */
  it('fetches no base and reads no text for a buffer over the large-file threshold', async () => {
    const huge = 'x\n'.repeat(Math.ceil((LARGE_FILE_BYTES + 1) / 2));
    platform.seedFile('/w/huge.ts', huge);
    platform.seedGitBase('/w/huge.ts', 'one\n');
    await app.workspace.openFolder('/w');

    const base = vi.spyOn(platform, 'gitFileBase');
    const text = vi.spyOn(app.workspace, 'textOf');
    const id = (await app.workspace.open('/w/huge.ts'))!;
    await vi.runAllTimersAsync();

    expect(app.git.hunks.get().has(id)).toBe(false);
    expect(base).not.toHaveBeenCalled();
    expect(text.mock.calls.filter((call) => call[0] === id)).toEqual([]);
  });

  /**
   * The regression that matters more than the feature, and the inverse of the
   * assertion above: at the threshold the file is not over it, so the base is
   * fetched exactly as it always was. `LARGE_FILE_BYTES` itself is not large,
   * so this pins the comparison too.
   */
  it('still fetches the base for a buffer exactly at the large-file threshold', async () => {
    const at = 'x\n'.repeat(LARGE_FILE_BYTES / 2);
    platform.seedFile('/w/big.ts', at);
    platform.seedGitBase('/w/big.ts', 'one\n');
    await app.workspace.openFolder('/w');

    const base = vi.spyOn(platform, 'gitFileBase');
    const id = (await app.workspace.open('/w/big.ts'))!;
    await vi.runAllTimersAsync();

    expect(app.workspace.stateOf(id)!.doc.length).toBe(LARGE_FILE_BYTES);
    expect(app.workspace.activeSnapshot()?.isLarge).toBe(false);
    expect(base).toHaveBeenCalledWith('/w/big.ts');
    // No hunks all the same: `MAX_DIFF_BYTES` refuses the diff at 2 MB, and
    // always did. That is the line this threshold sits above so it takes
    // nothing away.
    expect(app.git.hunks.get().has(id)).toBe(false);
  });

  /**
   * An answer that lands after the user has already dismissed the gutter
   * must not put it back.
   *
   * Mutation check: deleting the post-await `blameShown` guard in
   * `#refreshBlame` turned this red, since the entry is written straight back
   * into the map and the column reappears on its own, and left the other 26
   * green; restored, suite green.
   */
  it('does not paint an answer that arrived after it was switched off', async () => {
    const id = await openBlamed();
    let release: (() => void) | null = null;
    vi.spyOn(platform, 'gitBlame').mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return null;
    });

    const toggling = app.git.toggleBlame(id);
    await Promise.resolve();
    // A second toggle while the first is in flight: the entry went in
    // synchronously, so this is the "off" half.
    void app.git.toggleBlame(id);
    release!();
    await toggling;

    expect(app.git.blame.get().has(id)).toBe(false);
  });
});

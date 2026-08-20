import { beforeEach, describe, expect, it } from 'vitest';
import { parseGitStatus } from '../src/core/git-status';
import { MemoryPlatform } from '../src/platform/memory';

/**
 * The fake repository, exercised directly. A small honest model, not
 * scripted replies: stage copies working text into the index, commit
 * snapshots the index, switch refuses over a dirty conflict — so the
 * service tests above it exercise real sequences. Refusal texts follow
 * git's shape; the Rust tests assert the same phrases against real git,
 * which is what keeps fake and real from drifting silently.
 */

const ROOT = '/w';

let platform: MemoryPlatform;

beforeEach(() => {
  platform = new MemoryPlatform();
  platform.mkdirp(ROOT);
  platform.seedGitRepo(ROOT);
});

async function status() {
  return parseGitStatus(await platform.gitStatus(ROOT));
}

describe('the fake repository', () => {
  it('reports an untracked file as ?, then stage starts tracking it', async () => {
    platform.seedFile('/w/a.txt', 'one\n');
    expect((await status()).unstaged).toContainEqual({ path: 'a.txt', status: 'U' });

    await platform.gitStage(ROOT, ['/w/a.txt']);
    const after = await status();
    expect(after.staged).toContainEqual({ path: 'a.txt', status: 'A' });
    expect(after.unstaged).toEqual([]);
    // The gutter's base is the index — it now holds the staged text.
    expect(await platform.gitFileBase('/w/a.txt')).toBe('one\n');
  });

  it('round-trips stage and unstage', async () => {
    platform.seedGitBase('/w/a.txt', 'one\n');
    platform.seedFile('/w/a.txt', 'one\ntwo\n');
    expect((await status()).unstaged).toContainEqual({ path: 'a.txt', status: 'M' });

    await platform.gitStage(ROOT, ['/w/a.txt']);
    expect((await status()).staged).toContainEqual({ path: 'a.txt', status: 'M' });

    await platform.gitUnstage(ROOT, ['/w/a.txt']);
    const back = await status();
    expect(back.staged).toEqual([]);
    expect(back.unstaged).toContainEqual({ path: 'a.txt', status: 'M' });
    // restore --staged touches the index only; the worktree is untouched.
    expect(await platform.readTextFile('/w/a.txt')).toBe('one\ntwo\n');
  });

  it('commits the index, returns "<hash> <subject>", and logs it', async () => {
    platform.seedFile('/w/a.txt', 'one\n');
    await platform.gitStage(ROOT, ['/w/a.txt']);
    const result = await platform.gitCommit(ROOT, 'Add a\n\nBody line.');
    expect(result).toMatch(/^[0-9a-f]{7} Add a$/);

    const state = platform.gitRepoState(ROOT)!;
    expect(state.commits.at(-1)!.subject).toBe('Add a');
    expect((await status()).staged).toEqual([]);
  });

  it('refuses to commit a clean index, with git-shaped words', async () => {
    await expect(platform.gitCommit(ROOT, 'nothing here')).rejects.toThrow(/nothing to commit/);
  });

  it('refuses a blank commit message, with git-shaped words', async () => {
    platform.seedFile('/w/a.txt', 'one\n');
    await platform.gitStage(ROOT, ['/w/a.txt']);
    await expect(platform.gitCommit(ROOT, '  \n ')).rejects.toThrow(/empty commit message/);
  });

  it('stages a deletion when the worktree file is gone', async () => {
    platform.seedGitBase('/w/a.txt', 'one\n');
    platform.seedFile('/w/a.txt', 'one\n');
    platform.externalRemove('/w/a.txt');
    expect((await status()).unstaged).toContainEqual({ path: 'a.txt', status: 'D' });

    await platform.gitStage(ROOT, ['/w/a.txt']);
    expect((await status()).staged).toContainEqual({ path: 'a.txt', status: 'D' });
  });

  it('creates a branch, switches, and lists both', async () => {
    platform.seedGitBase('/w/a.txt', 'one\n');
    platform.seedFile('/w/a.txt', 'one\n');
    await platform.gitSwitch(ROOT, 'feature', true);
    expect(platform.gitRepoState(ROOT)!.branch).toBe('feature');
    expect((await platform.gitBranches(ROOT)).split('\n').filter(Boolean).sort()).toEqual([
      'feature',
      'main',
    ]);
    expect((await status()).branch).toBe('feature');
  });

  it('refuses to switch over a dirty conflicting file, and touches nothing', async () => {
    platform.seedGitBase('/w/f.txt', 'v1\n');
    platform.seedFile('/w/f.txt', 'v1\n');
    await platform.gitSwitch(ROOT, 'other', true);
    // Commit a different version on `other`.
    platform.externalWrite('/w/f.txt', 'v2\n');
    await platform.gitStage(ROOT, ['/w/f.txt']);
    await platform.gitCommit(ROOT, 'v2 on other');
    await platform.gitSwitch(ROOT, 'main', false);
    // Dirty the worktree so main -> other would clobber it.
    platform.externalWrite('/w/f.txt', 'dirty\n');

    await expect(platform.gitSwitch(ROOT, 'other', false)).rejects.toThrow(
      /Your local changes to the following files would be overwritten/,
    );
    expect(platform.gitRepoState(ROOT)!.branch).toBe('main');
    expect(await platform.readTextFile('/w/f.txt')).toBe('dirty\n');
  });

  it('switching moves the worktree to the target branch content when clean', async () => {
    platform.seedGitBase('/w/f.txt', 'v1\n');
    platform.seedFile('/w/f.txt', 'v1\n');
    await platform.gitSwitch(ROOT, 'other', true);
    platform.externalWrite('/w/f.txt', 'v2\n');
    await platform.gitStage(ROOT, ['/w/f.txt']);
    await platform.gitCommit(ROOT, 'v2');
    await platform.gitSwitch(ROOT, 'main', false);
    expect(await platform.readTextFile('/w/f.txt')).toBe('v1\n');
    await platform.gitSwitch(ROOT, 'other', false);
    expect(await platform.readTextFile('/w/f.txt')).toBe('v2\n');
  });

  it('refuses an invalid branch name with git-shaped words', async () => {
    await expect(platform.gitSwitch(ROOT, 'bad name', true)).rejects.toThrow(
      /is not a valid branch name/,
    );
  });

  it('answers gitStatus on a non-repo root with git-shaped refusal', async () => {
    platform.mkdirp('/plain');
    await expect(platform.gitStatus('/plain')).rejects.toThrow(/not a git repository/);
  });

  it('keeps seedGitBase working with no explicit repo (a repo is implied at the parent)', async () => {
    // The pre-existing contract: tests seed a base and read it back.
    platform.seedGitBase('/x/main.ts', 'one\n');
    expect(await platform.gitFileBase('/x/main.ts')).toBe('one\n');
    expect(await platform.gitFileBase('/x/other.ts')).toBeNull();
  });
});

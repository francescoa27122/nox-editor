// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import DiffView from '../src/ui/DiffView.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * A file that is mid-merge, from the platform seam up to the words the diff
 * view puts on screen.
 *
 * The defect this file exists for: `git show :0:<path>` *fails* on an
 * unmerged path — stage 0 does not exist while a merge is in progress — and
 * `nox_git_file_base` read that failure as "not in the index". A conflicted
 * file therefore lost its gutter entirely, and the diff view told the user it
 * was "untracked, outside a repository, or there is no git to ask" about a
 * file that was tracked, inside a repository, and mid-merge. Wrong words at
 * the moment the user most needs right ones.
 *
 * It went unnoticed because `MemoryPlatform.seedGitConflict` wrote the
 * pre-merge text into the *index*, which real git never does for an unmerged
 * path, so the fake answered `gitFileBase` happily and no test could reach
 * the state. The fake now keeps stages instead, and these tests run over
 * that; `src-tauri/src/git.rs` pins the same behaviour against real git.
 */

const MERGED = '/w/merged.ts';
const OURS = 'our line\ncommon\n';
const MARKERS = '<<<<<<< HEAD\nour line\n=======\ntheir line\n>>>>>>> theirs\ncommon\n';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function settle() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
  flush();
}

/**
 * Seed first, then open the folder: `git.status` is refreshed off the root
 * change, so anything seeded afterwards is invisible to the panel-facing
 * signals until something asks again.
 */
async function boot(seed: (platform: Mounted['platform']) => void) {
  mounted = mountComponent(DiffView);
  const { app, platform, container } = mounted;
  app.git.start();
  // `seedGitRepo` records a repository, not a directory — without a real
  // node at `/w` the workspace refuses to open it and every git signal
  // stays null.
  platform.mkdirp('/w');
  platform.seedGitRepo('/w');
  seed(platform);
  await app.workspace.openFolder('/w');
  await settle();
  return { app, platform, container };
}

/** Open `path`, make it the active buffer, and let the git service answer. */
async function activate(app: Mounted['app'], path: string) {
  const id = (await app.workspace.open(path))!;
  app.workspace.setActive(id);
  await settle();
  await settle();
  return id;
}

function text(container: HTMLElement): string {
  return container.textContent!.replace(/\s+/g, ' ');
}

describe('the base of a file that is mid-merge', () => {
  it('is ours — the pre-merge HEAD side — and not the marker soup on disk', async () => {
    // Guards the whole defect at the seam: an unmerged path has no stage 0,
    // so a lookup that only ever asks the index answers null here and the
    // gutter goes blank exactly when a merge is in progress.
    const { platform } = await boot((p) => {
      p.seedGitBase(MERGED, OURS);
      p.seedGitConflict(MERGED, MARKERS);
    });

    expect(await platform.gitFileBase(MERGED)).toBe(OURS);
  });

  it('falls back to the merge base when our side deleted the file', async () => {
    // A modify/delete conflict carries stages 1 and 3 only — there is no
    // "ours" to diff against, and the merge base is the sole content git
    // holds for the path. Verified against real git in
    // `src-tauri/src/git.rs`'s `an_unmerged_path_without_ours_falls_back_to_the_merge_base`.
    const { platform } = await boot((p) => {
      p.seedGitBase('/w/deleted.ts', 'base\n');
      p.seedGitConflict('/w/deleted.ts', 'theirs edit\n', { ours: null, base: 'base\n' });
    });

    expect(await platform.gitFileBase('/w/deleted.ts')).toBe('base\n');
  });

  it('cannot be committed away, because there is no stage 0 to commit', async () => {
    // The trap the stage model opens if nobody closes it: a conflicted path
    // has no index entry, so a commit that snapshots the index would drop
    // the file out of HEAD entirely — the fake destroying work real git
    // protects. Git refuses instead, and
    // `src-tauri/src/git.rs`'s `a_commit_with_unmerged_files_is_refused_with_gits_words`
    // pins the wording this mirrors.
    const { platform } = await boot((p) => {
      p.seedGitBase(MERGED, OURS);
      p.seedGitConflict(MERGED, MARKERS);
    });

    await expect(platform.gitCommit('/w', 'resolve nothing')).rejects.toThrow(/unmerged files/);
    expect(platform.gitRepoState('/w')!.commits).toEqual([]);
  });

  it('gives the file hunks, so the gutter is not blank mid-merge', async () => {
    const { app } = await boot((p) => {
      p.seedGitBase(MERGED, OURS);
      p.seedGitConflict(MERGED, MARKERS);
    });
    const id = await activate(app, MERGED);

    expect(app.git.hunks.get().has(id), 'expected hunks for a conflicted file').toBe(true);
  });
});

describe('what the diff view says about a file that is mid-merge', () => {
  it('names the side it is diffing against, because it is not the index', async () => {
    // "N changes against the index" is a lie mid-merge: there is no stage 0
    // to be against, and the base on screen is ours. The tally is the only
    // place the view names its own reference point, so it has to be right.
    const { app, container } = await boot((p) => {
      p.seedGitBase(MERGED, OURS);
      p.seedGitConflict(MERGED, MARKERS);
    });
    await activate(app, MERGED);

    expect(text(container)).toContain('against ours');
    expect(text(container)).not.toContain('against the index');
  });

  it('still says "against the index" for an ordinary changed file', async () => {
    const { app, container } = await boot((p) => {
      p.seedGitBase('/w/edited.ts', 'one\n');
      p.seedFile('/w/edited.ts', 'one\ntwo\n');
    });
    await activate(app, '/w/edited.ts');

    expect(text(container)).toContain('against the index');
  });

  it('blames the merge, not "untracked or outside a repository", when it has no base', async () => {
    // The residual case after the stage fallback: a *binary* merge conflict
    // has stages, but none of them decode as text, so the base really is
    // null. The old wording listed every reason except the true one, and it
    // listed them at the moment the user most needs right words. The status
    // is reshaped directly because a `string`-valued fake filesystem cannot
    // hold a blob that fails to decode.
    const { app, container } = await boot((p) => p.seedFile('/w/binary.bin', 'not really binary\n'));
    await activate(app, '/w/binary.bin');
    const status = app.git.status.get()!;
    app.git.status.set({
      ...status,
      unstaged: [...status.unstaged.filter((e) => e.path !== 'binary.bin'), { path: 'binary.bin', status: 'C' }],
    });
    flush();

    const body = text(container);
    expect(body).toMatch(/mid-merge|unmerged/i);
    expect(body).not.toContain('it is untracked, outside a repository');
  });
});

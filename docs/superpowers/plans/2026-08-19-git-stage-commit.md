# Stage, Commit, Branch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Git sidebar panel that shows the working state (branch, staged, unstaged), stages and unstages by name, commits the index, and switches or creates branches — with real `.git` watching so a terminal commit moves the panel.

**Architecture:** Rust grows six argv-fixed `nox_git_*` commands in `src-tauri/src/git.rs` (raw output out, git's stderr verbatim on refusal) plus a targeted non-recursive `.git` watch in `watcher.rs`. All parsing lives in TypeScript (`src/core/git-status.ts`, pure, node-tested). `MemoryPlatform` grows an honest fake repository — head, index, commits, branches — so every service and panel test runs real sequences with no git binary. `GitService` grows a `status` signal and four thin writes, each ending in `refreshStatus()` + `refreshAll()`. The panel is built from the audit's primitives (`PanelHeader`, `PanelEmpty`); the branch picker is a new prefix-free `CommandPalette` mode.

**Tech Stack:** TypeScript, Rust (Tauri 2), Svelte 5, Vitest (node + jsdom).

**Spec:** `docs/superpowers/specs/2026-08-19-git-stage-commit-design.md` — the binding authority. Read it before implementing any task.

## Scope rulings (made before planning; record, do not relitigate)

- **v1 only.** Hunk staging is phase 2 per spec §1 and is OUT of this plan.
- **The envelope (spec §0) is binding verbatim** — carried below in Global Constraints.
- **Status-bar branch indicator: not in this plan.** Phase C of the UI audit deferred it "to the stage/commit row" (WORKLOG.md:42), but the spec — the binding authority — names exactly one branch surface: the panel's branch line (§1). Per the ruling "do not invent scope beyond the spec", the status-bar item stays deferred. Once `GitService.status` exists it is a five-line follow-up; note it in the WORKLOG entry (Task 10), do not build it.
- Everything in spec §8 stays out: push/pull/fetch, discard/stash, amend/rebase/cherry-pick, tags, log browsing, submodules, worktrees, hooks UI, multi-repo.

## Global Constraints

**The envelope — spec §0, verbatim:**

> Every command this feature adds is argv-fixed in Rust: a specific `nox_git_*` function running `git` with a hard-coded argument shape, `--literal-pathspecs`, no shell anywhere, `-C <workspace repo root>` only. There is no generic "run git" seam, and adding one later should read as the alarm it is. Within that:
>
> 1. **Nothing leaves the machine.** No push, pull, or fetch. Remotes mean credentials and networks; this row is local state only. (Later row, its own spec, its own read.)
> 2. **Nothing rewrites history.** No amend, no rebase, no reset below `--mixed`-on-nothing (see unstage), no force-anything. A commit only ever adds one.
> 3. **Nothing destroys working-tree work.** No discard, no `checkout -- <file>`, no stash. The README's first promise is *"It does not lose your work. Ever."* — and `git checkout -- file` is the canonical way to lose it. Discard arrives only if it ever gets a recovery story (the trash-not-delete shape), as its own decision.
> 4. **Git's refusals are surfaced, never overridden.** A branch switch with conflicting dirty files fails with git's own words; we do not pass `-f`. A commit with nothing staged, or no identity configured, fails with git's own words. The error convention of `fs.rs` carries the message; the panel shows it verbatim — the rename pattern: the one who knows why gets to say it.
> 5. **Commit commits the index.** Never `-a`, never pathspecs on commit. What you staged is what lands, and the staged list on screen *is* the commit preview.
> 6. **Every mutation refreshes.** Each `nox_git_*` write is followed by a status + gutter-base refresh, so the panel never shows a state its own action made stale.

**Project constraints:**

- **`ui/` may never import `@tauri-apps/*`.** UI talks to services; services talk to `Platform`.
- **Baseline to beat:** `npm test` 1257 tests / 76 files, `npm run check` 455 files 0 errors (both verified green on this worktree, 2026-08-19). Run both before every commit and report the real output.
- **No cargo on this machine may be assumed.** Rust changes are compiled and tested by CI. Write Rust so its logic sits beside the existing `git.rs` tests; state plainly in every report that Rust tests are unrun locally (run `cargo test` only if a local toolchain turns out to exist).
- **TypeScript tests must not require a real git binary.** They run against the `MemoryPlatform` fake repository. Rust unit tests use real git in a scratch repo, as `git.rs` already does (the `Scratch` pattern).
- **Commit author** is already configured per-repo (`francescoa27122 <42079355+frncescoa27122@users.noreply.github.com>` — note the missing `a`, matching the repo's convention). Plain `-m` messages in the house voice, like the existing log.
- **Do not push, open a PR, or merge.** Commit locally on `git-stage-commit` and stop.
- **Error string convention:** Rust returns `"<code>: <message>"`; `call` in `src/platform/tauri.ts:618` strips the first `<code>: ` and puts the rest in `PlatformError.message`. Git refusals therefore travel as `io: <git's stderr verbatim>` so `.message` is exactly git's words (verified against the `call` implementation).

## Ambiguities resolved during planning (each verified against live git or the code)

1. **`GitStatus` gains an `oid` field.** Spec §4's brace list omits it, but §1 requires rendering "detached at abc1234" and porcelain's `# branch.head` says only `(detached)` — the short hash comes from `# branch.oid`.
2. **Staging a deleted file:** the spec's "canonicalize-and-strip route" (`plain_canonical`) fails on a path that no longer exists. Fallback: canonicalize the parent and re-append the file name. Without this, the Changes list's `D` rows cannot be staged.
3. **`git branch --list --format=%(refname:short)` emits a bogus `(HEAD detached at …)` line on a detached HEAD** (verified live). The parser drops lines starting with `(`.
4. **Commit refusal text goes to stdout, not stderr** (`nothing to commit, working tree clean` — verified live). The Rust error helper uses stderr, falling back to stdout when stderr is empty.
5. **Porcelain letters beyond the spec's five:** `C` (copied) maps to `R` (a copy is a rename-shaped fact), `u` (unmerged) records land in unstaged as `M`, anything else maps to `M`. Documented in the parser.
6. **Workspace root is treated as the repo root for path joins in the renderer** (status paths are toplevel-relative). Spec §8's "one root, one repo" stance; the Rust side still resolves the true toplevel for stage/unstage per §2. A workspace opened *below* the repo root mis-joins — same limitation every git feature so far has, unchanged here.
7. **The fake repo's commit refusal always uses git's clean-tree wording** even when unstaged changes exist (real git says "no changes added to commit" then); only the clean case is exercised by tests, and the divergence is documented in `memory.ts`.

## File structure

| File | Role |
|---|---|
| `src/core/git-status.ts` (new) | Pure porcelain-v2 + branch-list parsers. |
| `src-tauri/src/git.rs` (grow) | Six `nox_git_*` commands + real-repo tests. |
| `src-tauri/src/watcher.rs` (grow) | Targeted `.git` meta watch. |
| `src-tauri/src/lib.rs` (grow) | Registration. |
| `src/platform/types.ts` (grow) | Six methods + `watchGitMeta` on `Platform`. |
| `src/platform/memory.ts` (grow) | The fake repository model. |
| `src/platform/tauri.ts` (grow) | Thin passthroughs. |
| `src/services/git.ts` (grow) | `status` signal, `refreshStatus`, four writes, meta-watch wiring. |
| `src/ui/GitPanel.svelte` (new) | Branch line, two sections, commit box. |
| `src/ui/Sidebar.svelte`, `src/services/ui.ts`, `src/ui/Icon.svelte` (grow) | Rail entry, view/focus plumbing, two icons. |
| `src/ui/CommandPalette.svelte`, `src/ui/Overlays.svelte` (grow) | The prefix-free branch picker mode. |
| `src/app.ts` (grow) | Service wiring, `git.focus`, extended refresh command. |
| `tests/git-status.test.ts` (new, node), `tests/git-platform.test.ts` (new, node), `tests/git-panel.test.ts` (new, jsdom), `tests/git-service.test.ts` (extend) | Coverage per spec §6. |

Build order follows spec §7: parser → platform → Rust → service reads → read-only panel → stage/unstage → commit → branch picker → `.git` watch → docs.

---

### Task 1: The porcelain v2 parser

**Files:**
- Create: `src/core/git-status.ts`
- Test: `tests/git-status.test.ts` (node)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type GitStatusLetter = 'M' | 'A' | 'D' | 'R' | 'U';
  export interface FileEntry { path: string; status: GitStatusLetter; origPath?: string }
  export interface GitStatus {
    branch: string | null;   // null when detached
    oid: string | null;      // full oid from `# branch.oid`, null in an empty repo ("(initial)")
    detached: boolean;
    staged: FileEntry[];
    unstaged: FileEntry[];
  }
  export function parseGitStatus(raw: string): GitStatus;
  export function parseGitBranches(raw: string): string[];
  ```

- [ ] **Step 1: Write the failing test**

The fixtures are **captured real output** (spec §6), taken from `git status --porcelain=v2 --branch -z` on 2026-08-19 (git 2.x, macOS): a repo with a staged-then-re-edited file (`MM`), a worktree-only edit (`.M`), a staged rename (`2 R.` + NUL-separated origPath), an untracked file, and an untracked file **with a newline in its name**. `-z` records are NUL-terminated; compose with `'\u0000'`.

`tests/git-status.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseGitBranches, parseGitStatus } from '../src/core/git-status';

// Captured from a real `git status --porcelain=v2 --branch -z` (2026-08-19).
const FIXTURE = [
  '# branch.oid 42772c8fbd3f6b6b5ed5d5358a0a7bdf89c99edb',
  '# branch.head main',
  '1 MM N... 100644 100644 100644 5626abf0f72e58d7a153368ba57db4c673c0e171 814f4a422927b82f5f8a43f8fab6d3839e3983f2 a.txt',
  '1 .M N... 100644 100644 100644 2fa992c0b8b5c6acd2bdd4fa31de29d29799bdd5 2fa992c0b8b5c6acd2bdd4fa31de29d29799bdd5 b.txt',
  '2 R. N... 100644 100644 100644 286c5f5776916d7d7d5849988ca9d83e722cf9c2 286c5f5776916d7d7d5849988ca9d83e722cf9c2 R100 mv-to.txt',
  'mv-from.txt',
  '? new\nline.txt',
  '? untracked.txt',
  '',
].join('\u0000');

// Captured from a detached HEAD in the same repo.
const DETACHED = [
  '# branch.oid e11ea47bca5991343e292175cbc91646cab62bd1',
  '# branch.head (detached)',
  '',
].join('\u0000');

describe('parseGitStatus', () => {
  it('reads the branch headers', () => {
    const status = parseGitStatus(FIXTURE);
    expect(status.branch).toBe('main');
    expect(status.detached).toBe(false);
    expect(status.oid).toBe('42772c8fbd3f6b6b5ed5d5358a0a7bdf89c99edb');
  });

  it('puts a file staged and re-edited (MM) in both lists', () => {
    const status = parseGitStatus(FIXTURE);
    expect(status.staged).toContainEqual({ path: 'a.txt', status: 'M' });
    expect(status.unstaged).toContainEqual({ path: 'a.txt', status: 'M' });
  });

  it('puts a worktree-only edit (.M) in unstaged only', () => {
    const status = parseGitStatus(FIXTURE);
    expect(status.staged.some((e) => e.path === 'b.txt')).toBe(false);
    expect(status.unstaged).toContainEqual({ path: 'b.txt', status: 'M' });
  });

  it('reads a rename with its NUL-separated original path', () => {
    const status = parseGitStatus(FIXTURE);
    expect(status.staged).toContainEqual({ path: 'mv-to.txt', status: 'R', origPath: 'mv-from.txt' });
  });

  it('labels untracked files U, a newline in the name included', () => {
    const status = parseGitStatus(FIXTURE);
    expect(status.unstaged).toContainEqual({ path: 'untracked.txt', status: 'U' });
    expect(status.unstaged).toContainEqual({ path: 'new\nline.txt', status: 'U' });
  });

  it('reports a detached HEAD with its oid', () => {
    const status = parseGitStatus(DETACHED);
    expect(status.branch).toBeNull();
    expect(status.detached).toBe(true);
    expect(status.oid).toBe('e11ea47bca5991343e292175cbc91646cab62bd1');
  });

  it('parses an empty repo status (headers only) to empty lists', () => {
    const status = parseGitStatus('# branch.oid (initial)\u0000# branch.head main\u0000');
    expect(status.branch).toBe('main');
    expect(status.oid).toBeNull();
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([]);
  });
});

describe('parseGitBranches', () => {
  it('splits lines and keeps order', () => {
    expect(parseGitBranches('feature/x\nmain\n')).toEqual(['feature/x', 'main']);
  });

  it('drops the "(HEAD detached at …)" pseudo-entry a detached HEAD emits', () => {
    // Verified live: `--format=%(refname:short)` still prints this line.
    expect(parseGitBranches('(HEAD detached at refs/heads/main)\nfeature/x\nmain\n')).toEqual([
      'feature/x',
      'main',
    ]);
  });

  it('handles empty output (a repo with no commits)', () => {
    expect(parseGitBranches('')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/git-status.test.ts`
Expected: FAIL — cannot resolve `../src/core/git-status`.

- [ ] **Step 3: Implement `src/core/git-status.ts`**

```ts
/**
 * Porcelain v2 parsing, in TypeScript where it is testable without a repo.
 *
 * The Rust side ships raw `git status --porcelain=v2 --branch -z` output
 * across the boundary; everything that understands it lives here. `-z`
 * because filenames contain anything (records are NUL-terminated, and a
 * rename's original path arrives as the *next* NUL token); porcelain v2
 * because it carries branch info and rename detail in one call.
 *
 * Letters follow porcelain: M, A, D, R for tracked changes, U for untracked.
 * Porcelain's C (copied) maps to R — a copy is a rename-shaped fact — and an
 * unmerged (`u`) record lands in unstaged as M: a conflicted file silently
 * missing from the list would be worse than an imprecise letter. Anything
 * unrecognised degrades to M for the same reason.
 *
 * See docs/superpowers/specs/2026-08-19-git-stage-commit-design.md §4.
 */

export type GitStatusLetter = 'M' | 'A' | 'D' | 'R' | 'U';

export interface FileEntry {
  /** Relative to the repository toplevel, exactly as git printed it. */
  path: string;
  status: GitStatusLetter;
  /** A rename's source, when there is one. */
  origPath?: string;
}

export interface GitStatus {
  /** Current branch name, or null when HEAD is detached. */
  branch: string | null;
  /** Full HEAD oid, or null in a repository with no commits yet. */
  oid: string | null;
  detached: boolean;
  staged: FileEntry[];
  unstaged: FileEntry[];
}

/** Everything after the nth space — the path field, which may itself contain spaces. */
function tailAfter(record: string, spaces: number): string {
  let index = 0;
  for (let n = 0; n < spaces; n++) {
    index = record.indexOf(' ', index) + 1;
    if (index === 0) return '';
  }
  return record.slice(index);
}

function letter(code: string): GitStatusLetter {
  if (code === 'A' || code === 'D' || code === 'R') return code;
  if (code === 'C') return 'R';
  return 'M';
}

export function parseGitStatus(raw: string): GitStatus {
  const records = raw.split('\u0000');
  const status: GitStatus = { branch: null, oid: null, detached: false, staged: [], unstaged: [] };

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;

    if (record.startsWith('# branch.oid ')) {
      const oid = record.slice('# branch.oid '.length);
      status.oid = oid === '(initial)' ? null : oid;
    } else if (record.startsWith('# branch.head ')) {
      const head = record.slice('# branch.head '.length);
      if (head === '(detached)') status.detached = true;
      else status.branch = head;
    } else if (record.startsWith('1 ')) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const x = record[2]!;
      const y = record[3]!;
      const path = tailAfter(record, 8);
      if (x !== '.') status.staged.push({ path, status: letter(x) });
      if (y !== '.') status.unstaged.push({ path, status: letter(y) });
    } else if (record.startsWith('2 ')) {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> NUL <origPath>
      const x = record[2]!;
      const y = record[3]!;
      const path = tailAfter(record, 9);
      const origPath = records[++i] ?? '';
      if (x !== '.') status.staged.push({ path, status: letter(x), origPath });
      if (y !== '.') status.unstaged.push({ path, status: letter(y) });
    } else if (record.startsWith('? ')) {
      status.unstaged.push({ path: record.slice(2), status: 'U' });
    } else if (record.startsWith('u ')) {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      status.unstaged.push({ path: tailAfter(record, 10), status: 'M' });
    }
    // '!' (ignored entries) never appear without --ignored; anything else is
    // a future porcelain addition and is skipped rather than guessed at.
  }

  return status;
}

/**
 * `git branch --list --format=%(refname:short)`, one name per line. On a
 * detached HEAD git still emits a "(HEAD detached at …)" pseudo-entry;
 * a real branch name can never start with "(", so those are dropped.
 */
export function parseGitBranches(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('('));
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/git-status.test.ts`
Expected: PASS.

- [ ] **Step 5: Type check and commit**

```bash
npm run check
git add src/core/git-status.ts tests/git-status.test.ts
git commit -m "Parse porcelain v2, renames and newline names included"
```

---

### Task 2: The Platform boundary and the fake repository

**Files:**
- Modify: `src/platform/types.ts` (six methods on `Platform`)
- Modify: `src/platform/memory.ts` (the fake repo model; `seedGitBase` re-expressed on it)
- Modify: `src/platform/tauri.ts` (six thin passthroughs — the Rust commands land in Task 3; nothing calls these until Task 4)
- Test: `tests/git-platform.test.ts` (node)

**Interfaces:**
- Consumes: nothing (raw strings out; parsing is Task 1's, used only by tests here).
- Produces, on `Platform` (spec §3 verbatim), all gated by the **existing** `capabilities.gitState` — no new capability flag:
  ```ts
  gitStatus(root: string): Promise<string>;
  gitBranches(root: string): Promise<string>;
  gitStage(root: string, paths: string[]): Promise<void>;
  gitUnstage(root: string, paths: string[]): Promise<void>;
  gitCommit(root: string, message: string): Promise<string>;
  gitSwitch(root: string, name: string, create: boolean): Promise<void>;
  ```
- Produces, on `MemoryPlatform` (seeding/inspection, test-only like `seedFile`):
  ```ts
  seedGitRepo(root: string, branch?: string): void;          // default branch 'main'
  seedGitBase(path: string, contents: string): void;         // now: head + index of the containing repo
  gitRepoState(root: string): { branch: string; branches: string[]; commits: { hash: string; subject: string }[] } | null;
  ```

- [ ] **Step 1: Write the failing test**

`tests/git-platform.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/git-platform.test.ts`
Expected: FAIL — `seedGitRepo` is not a function.

- [ ] **Step 3: Add the six methods to `src/platform/types.ts`**

In `interface Platform`, directly after `gitFileBase` (types.ts:277), add:

```ts
  /**
   * Raw `git status --porcelain=v2 --branch -z` output for the repository at
   * `root`. Parsing lives in `core/git-status.ts`, where it is testable
   * without a repo. Rejects with git's own words when git refuses — the one
   * git surface where failure is an error, not a null: a missing gutter is a
   * fine degraded state, but a write surface built on a silent non-answer
   * would act on stale truth. Check `capabilities.gitState` first.
   */
  gitStatus(root: string): Promise<string>;

  /** Raw `git branch --list --format=%(refname:short)` output. */
  gitBranches(root: string): Promise<string>;

  /** `git add --literal-pathspecs -- <paths>`. Absolute paths in; the platform relativizes. */
  gitStage(root: string, paths: string[]): Promise<void>;

  /**
   * `git restore --staged --literal-pathspecs -- <paths>`. Touches the index
   * only — the working tree is untouchable by construction of the command.
   */
  gitUnstage(root: string, paths: string[]): Promise<void>;

  /**
   * `git commit --file=-` with the message on stdin (messages contain
   * quotes, dashes, anything — never argv). Resolves to `git log -1
   * --format=%h %s`. Rejects with git's own words: nothing staged, no
   * identity, a failing hook — all verbatim, never overridden.
   */
  gitCommit(root: string, message: string): Promise<string>;

  /**
   * `git switch <name>` / `git switch -c <name>`, the name validated first
   * with `git check-ref-format --branch`. Rejects with git's own words —
   * a switch that would overwrite dirty files is git's refusal to make.
   */
  gitSwitch(root: string, name: string, create: boolean): Promise<void>;
```

- [ ] **Step 4: Grow the fake repository in `src/platform/memory.ts`**

Replace the `#gitBases` map and `seedGitBase` (memory.ts:88-94) with the model. Keep `gitFileBase` answering from the index, so every existing test's behavior is unchanged.

```ts
  /**
   * The fake repository — a small honest model, not scripted replies.
   *
   * One per seeded root: what HEAD holds per branch, what the index holds,
   * the commit log, the current branch. The six git methods behave like
   * git's — stage copies working text into the index, commit snapshots the
   * index and refuses when clean or when the message is blank, switch
   * refuses when a dirty file differs from the target — and the refusal
   * texts follow git's shape, which the Rust tests assert against real git
   * so fake and real cannot drift silently. Worktree text always comes from
   * `#nodes`: the same filesystem the app writes to is the one git sees.
   *
   * One deliberate divergence, documented: the clean-index commit refusal
   * always uses git's clean-tree wording ("nothing to commit, working tree
   * clean") even when unstaged changes exist; only the clean case is
   * exercised, and one message keeps the model small.
   */
  interface FakeGitRepo {
    branch: string;
    /** branch name -> path (repo-relative) -> text. */
    heads: Map<string, Map<string, string>>;
    index: Map<string, string>;
    commits: { hash: string; subject: string }[];
  }
```

(Declare the interface at module scope, below `MemoryPlatform`'s closing brace or above the class — module-private, not exported.)

Inside the class:

```ts
  /** root -> its fake repository. */
  #repos = new Map<string, FakeGitRepo>();

  /** Create an empty repository at `root`, for tests. */
  seedGitRepo(root: string, branch = 'main'): void {
    const r = normalize(root);
    if (this.#repos.has(r)) return;
    this.#repos.set(r, {
      branch,
      heads: new Map([[branch, new Map()]]),
      index: new Map(),
      commits: [],
    });
  }

  /**
   * Give the fake git a committed-and-clean version of `path`, for tests:
   * both HEAD and the index hold `contents` — "not mid-staging", the state
   * the gutter's docs call normal. Re-expressed on the repo model; a test
   * that never made a repo gets one implied at the file's parent, which is
   * what the pre-model `seedGitBase` behavior amounted to.
   */
  seedGitBase(path: string, contents: string): void {
    const p = normalize(path);
    if (!this.#repoFor(p)) this.seedGitRepo(dirname(p));
    const [root, repo] = this.#repoEntryFor(p)!;
    const rel = relative(root, p);
    repo.heads.get(repo.branch)!.set(rel, contents);
    repo.index.set(rel, contents);
  }

  /** Inspection for tests: the current branch, every branch, the log. */
  gitRepoState(root: string): { branch: string; branches: string[]; commits: { hash: string; subject: string }[] } | null {
    const repo = this.#repos.get(normalize(root));
    if (!repo) return null;
    return { branch: repo.branch, branches: [...repo.heads.keys()].sort(), commits: [...repo.commits] };
  }

  /** The deepest repo whose root contains `path`, as [root, repo]. */
  #repoEntryFor(path: string): [string, FakeGitRepo] | null {
    let best: [string, FakeGitRepo] | null = null;
    for (const [root, repo] of this.#repos) {
      if ((path === root || contains(root, path)) && (!best || root.length > best[0].length)) {
        best = [root, repo];
      }
    }
    return best;
  }

  #repoFor(path: string): FakeGitRepo | null {
    return this.#repoEntryFor(path)?.[1] ?? null;
  }

  #requireRepo(root: string): [string, FakeGitRepo] {
    const entry = this.#repoEntryFor(normalize(root));
    if (!entry) {
      throw new PlatformError(
        'fatal: not a git repository (or any of the parent directories): .git',
        'io',
        root,
      );
    }
    return entry;
  }
```

Rewrite `gitFileBase` on the model (same contract, same doc-comment spirit):

```ts
  async gitFileBase(path: string): Promise<string | null> {
    const p = normalize(path);
    const entry = this.#repoEntryFor(p);
    if (!entry) return null;
    const [root, repo] = entry;
    return repo.index.get(relative(root, p)) ?? null;
  }
```

The six methods (place after `gitFileBase`):

```ts
  async gitStatus(root: string): Promise<string> {
    const [repoRoot, repo] = this.#requireRepo(root);
    const head = repo.heads.get(repo.branch)!;

    const paths = new Set<string>([...repo.index.keys(), ...head.keys()]);
    for (const [node, value] of this.#nodes) {
      if (value !== null && contains(repoRoot, node)) paths.add(relative(repoRoot, node));
    }

    const records: string[] = [
      `# branch.oid ${repo.commits.length === 0 ? '(initial)' : fakeOid(repo.commits.length)}`,
      `# branch.head ${repo.branch}`,
    ];
    const zeros = '0'.repeat(40);
    for (const rel of [...paths].sort()) {
      const worktree = this.#nodes.get(join(repoRoot, rel));
      const inWork = typeof worktree === 'string';
      const inIndex = repo.index.has(rel);
      const inHead = head.has(rel);

      if (!inIndex && !inHead) {
        if (inWork) records.push(`? ${rel}`);
        continue;
      }
      const x = !inHead ? 'A' : !inIndex ? 'D' : head.get(rel) === repo.index.get(rel) ? '.' : 'M';
      const y = !inWork
        ? inIndex
          ? 'D'
          : '.'
        : !inIndex
          ? '.'
          : worktree === repo.index.get(rel)
            ? '.'
            : 'M';
      if (x === '.' && y === '.') continue;
      records.push(`1 ${x}${y} N... 100644 100644 100644 ${zeros} ${zeros} ${rel}`);
    }
    return records.join('\u0000') + '\u0000';
  }

  async gitBranches(root: string): Promise<string> {
    const [, repo] = this.#requireRepo(root);
    return [...repo.heads.keys()].sort().join('\n') + '\n';
  }

  async gitStage(root: string, paths: string[]): Promise<void> {
    const [repoRoot, repo] = this.#requireRepo(root);
    for (const path of paths) {
      const p = normalize(path);
      const rel = relative(repoRoot, p);
      const text = this.#nodes.get(p);
      if (typeof text === 'string') repo.index.set(rel, text);
      else if (repo.index.has(rel)) repo.index.delete(rel); // staging a deletion
      else {
        throw new PlatformError(`fatal: pathspec '${rel}' did not match any files`, 'io', p);
      }
    }
    this.#notifyGitMeta(repoRoot);
  }

  async gitUnstage(root: string, paths: string[]): Promise<void> {
    const [repoRoot, repo] = this.#requireRepo(root);
    const head = repo.heads.get(repo.branch)!;
    for (const path of paths) {
      const rel = relative(repoRoot, normalize(path));
      if (head.has(rel)) repo.index.set(rel, head.get(rel)!);
      else repo.index.delete(rel);
    }
    this.#notifyGitMeta(repoRoot);
  }

  async gitCommit(root: string, message: string): Promise<string> {
    const [repoRoot, repo] = this.#requireRepo(root);
    if (message.trim().length === 0) {
      throw new PlatformError('Aborting commit due to empty commit message.', 'io');
    }
    const head = repo.heads.get(repo.branch)!;
    const clean =
      head.size === repo.index.size && [...repo.index].every(([k, v]) => head.get(k) === v);
    if (clean) {
      throw new PlatformError('nothing to commit, working tree clean', 'io');
    }
    repo.heads.set(repo.branch, new Map(repo.index));
    const hash = fakeOid(repo.commits.length + 1).slice(0, 7);
    const subject = message.split('\n', 1)[0]!.trim();
    repo.commits.push({ hash, subject });
    this.#notifyGitMeta(repoRoot);
    return `${hash} ${subject}`;
  }

  async gitSwitch(root: string, name: string, create: boolean): Promise<void> {
    const [repoRoot, repo] = this.#requireRepo(root);
    // The same gate `git check-ref-format --branch` provides: only names git
    // itself would bless reach a write. ASCII control chars, space, and
    // git's reserved punctuation are refused with git's wording.
    if (create) {
      if (!/^[^\s~^:?*[\\]+$/.test(name) || name.startsWith('-') || name.includes('..') || name.endsWith('/') || name.endsWith('.lock')) {
        throw new PlatformError(`fatal: '${name}' is not a valid branch name`, 'io');
      }
      if (repo.heads.has(name)) {
        throw new PlatformError(`fatal: a branch named '${name}' already exists`, 'io');
      }
      repo.heads.set(name, new Map(repo.heads.get(repo.branch)!));
      repo.branch = name;
      this.#notifyGitMeta(repoRoot);
      return;
    }

    const target = repo.heads.get(name);
    if (!target) throw new PlatformError(`fatal: invalid reference: ${name}`, 'io');
    const current = repo.heads.get(repo.branch)!;

    // git's refusal: a file that differs between the two heads and carries
    // local (worktree or index) changes would be overwritten.
    const clobbered: string[] = [];
    for (const rel of new Set([...current.keys(), ...target.keys()])) {
      if (current.get(rel) === target.get(rel)) continue;
      const worktree = this.#nodes.get(join(repoRoot, rel));
      const dirty =
        repo.index.get(rel) !== current.get(rel) ||
        (typeof worktree === 'string' ? worktree : undefined) !== repo.index.get(rel);
      if (dirty) clobbered.push(rel);
    }
    if (clobbered.length > 0) {
      throw new PlatformError(
        `error: Your local changes to the following files would be overwritten by checkout:\n\t${clobbered.join('\n\t')}\nPlease commit your changes or stash them before you switch branches.\nAborting`,
        'io',
      );
    }

    for (const rel of new Set([...current.keys(), ...target.keys()])) {
      const path = join(repoRoot, rel);
      const text = target.get(rel);
      if (text === undefined) this.externalRemove(path);
      else if (this.#nodes.get(path) !== text) this.externalWrite(path, text);
    }
    repo.index = new Map(target);
    repo.branch = name;
    this.#notifyGitMeta(repoRoot);
  }

  /** Wired to real watchers in the .git meta-watch task; a no-op until then. */
  #notifyGitMeta(_root: string): void {}
```

Add `fakeOid` at module scope beside `sortEntries`:

```ts
/** A deterministic 40-hex stand-in for an oid, derived from a counter. */
function fakeOid(n: number): string {
  return n.toString(16).padStart(40, '0');
}
```

`join` is already imported from `@core/path` in memory.ts (line 1). `WebPlatform` extends `MemoryPlatform` and inherits everything; **no `web.ts` change**. No capabilities change anywhere: the gate is the existing `gitState` flag, `true` only on Tauri.

- [ ] **Step 5: Add the passthroughs to `src/platform/tauri.ts`**

After `gitFileBase` (tauri.ts:89-91):

```ts
  async gitStatus(root: string): Promise<string> {
    return call<string>('nox_git_status', { root });
  }

  async gitBranches(root: string): Promise<string> {
    return call<string>('nox_git_branches', { root });
  }

  async gitStage(root: string, paths: string[]): Promise<void> {
    await call<void>('nox_git_stage', { root, paths });
  }

  async gitUnstage(root: string, paths: string[]): Promise<void> {
    await call<void>('nox_git_unstage', { root, paths });
  }

  async gitCommit(root: string, message: string): Promise<string> {
    return call<string>('nox_git_commit', { root, message });
  }

  async gitSwitch(root: string, name: string, create: boolean): Promise<void> {
    await call<void>('nox_git_switch', { root, name, create });
  }
```

- [ ] **Step 6: Run the tests and the type check**

Run: `npx vitest run tests/git-platform.test.ts && npx vitest run tests/git-service.test.ts tests/git-gutter.test.ts tests/git-diff-view.test.ts && npm run check`
Expected: new tests PASS, the three existing git suites still PASS (the `seedGitBase` re-expression must not change observable behavior), 0 type errors.

- [ ] **Step 7: Full suite and commit**

```bash
npm test
git add src/platform/types.ts src/platform/memory.ts src/platform/tauri.ts tests/git-platform.test.ts
git commit -m "Grow the platform a fake repository that behaves like git"
```

---

### Task 3: The six Rust commands

**Files:**
- Modify: `src-tauri/src/git.rs` (helpers + six commands + tests)
- Modify: `src-tauri/src/lib.rs` (six `generate_handler!` entries after `git::nox_git_file_base` at lib.rs:67)

**Interfaces:**
- Consumes: `run_git`, `plain_canonical`, `relative_to_root`, `Scratch`, `git_in` — all already in `git.rs` (verified).
- Produces: commands `nox_git_status(root)`, `nox_git_branches(root)`, `nox_git_stage(root, paths)`, `nox_git_unstage(root, paths)`, `nox_git_commit(root, message) -> String`, `nox_git_switch(root, name, create)`.

**No cargo on this machine may be assumed:** write the tests, state in the commit and the report that they are unrun locally, and let CI execute them. (If `cargo test` happens to exist locally, run it and report the real output instead.)

- [ ] **Step 1: Write the tests first, extending the existing real-repo suite**

Append to `mod tests` in `src-tauri/src/git.rs`. These are spec §2's list, one test each. `git_in` already supplies an identity and disables signing.

```rust
    /// Read stdout of a git command that must succeed — for assertions.
    fn git_out(dir: &Path, args: &[&str]) -> String {
        let output = run_git(dir, args).expect("git runs");
        assert!(output.status.success(), "git {args:?} failed");
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    #[test]
    fn stage_and_unstage_round_trip_in_porcelain() {
        let scratch = Scratch::new("git-stage");
        git_in(&scratch.0, &["init"]);
        let file = scratch.join("a.txt");
        fs::write(&file, "one\n").unwrap();

        nox_git_stage(as_string(&scratch.0), vec![as_string(&file)]).unwrap();
        assert!(git_out(&scratch.0, &["status", "--porcelain"]).starts_with("A  a.txt"));

        nox_git_unstage(as_string(&scratch.0), vec![as_string(&file)]).unwrap();
        assert!(git_out(&scratch.0, &["status", "--porcelain"]).starts_with("?? a.txt"));
        // The working tree was never touched.
        assert_eq!(fs::read_to_string(&file).unwrap(), "one\n");
    }

    #[test]
    fn staging_a_deleted_file_records_the_deletion() {
        let scratch = Scratch::new("git-stage-del");
        git_in(&scratch.0, &["init"]);
        let file = scratch.join("a.txt");
        fs::write(&file, "one\n").unwrap();
        git_in(&scratch.0, &["add", "a.txt"]);
        git_in(&scratch.0, &["commit", "-m", "base"]);
        fs::remove_file(&file).unwrap();

        // The path no longer exists, so canonicalize-and-strip must fall
        // back to the parent — the case this test pins.
        nox_git_stage(as_string(&scratch.0), vec![as_string(&file)]).unwrap();
        assert!(git_out(&scratch.0, &["status", "--porcelain"]).starts_with("D  a.txt"));
    }

    #[test]
    fn commit_lands_the_exact_multiline_message_and_only_one_commit() {
        let scratch = Scratch::new("git-commit");
        git_in(&scratch.0, &["init"]);
        // `nox_git_commit` runs plain `git commit` — no inline `-c` identity
        // like `git_in` carries — so the repo itself must hold one, exactly
        // as a user's repo would. CI runners have no global identity.
        git_in(&scratch.0, &["config", "user.email", "t@t"]);
        git_in(&scratch.0, &["config", "user.name", "t"]);
        git_in(&scratch.0, &["config", "commit.gpgsign", "false"]);
        fs::write(scratch.join("a.txt"), "one\n").unwrap();
        git_in(&scratch.0, &["add", "a.txt"]);

        // Quotes, a lone `--`, a second paragraph: stdin makes them all safe.
        let message = "Say \"hello\" -- carefully\n\nBody with 'quotes' and -- dashes.\n";
        let result = nox_git_commit(as_string(&scratch.0), message.to_string()).unwrap();
        assert!(result.ends_with("Say \"hello\" -- carefully"), "got {result:?}");

        assert_eq!(git_out(&scratch.0, &["rev-list", "--count", "HEAD"]).trim(), "1");
        assert_eq!(git_out(&scratch.0, &["log", "-1", "--format=%B"]).trim_end(), message.trim_end());
    }

    #[test]
    fn commit_with_nothing_staged_fails_with_gits_words() {
        let scratch = Scratch::new("git-commit-clean");
        git_in(&scratch.0, &["init"]);
        git_in(&scratch.0, &["config", "user.email", "t@t"]);
        git_in(&scratch.0, &["config", "user.name", "t"]);
        git_in(&scratch.0, &["config", "commit.gpgsign", "false"]);
        git_in(&scratch.0, &["commit", "--allow-empty", "-m", "root"]);

        let error = nox_git_commit(as_string(&scratch.0), "message".to_string()).unwrap_err();
        // Git says this on stdout, which is why the helper falls back to it.
        assert!(error.contains("nothing to commit"), "got {error:?}");
    }

    #[test]
    fn switch_refuses_a_dirty_conflict_and_the_tree_is_byte_identical() {
        let scratch = Scratch::new("git-switch-dirty");
        git_in(&scratch.0, &["init", "-b", "main"]);
        let file = scratch.join("f.txt");
        fs::write(&file, "v1\n").unwrap();
        git_in(&scratch.0, &["add", "f.txt"]);
        git_in(&scratch.0, &["commit", "-m", "one"]);
        git_in(&scratch.0, &["switch", "-c", "other"]);
        fs::write(&file, "v2\n").unwrap();
        git_in(&scratch.0, &["add", "f.txt"]);
        git_in(&scratch.0, &["commit", "-m", "two"]);
        git_in(&scratch.0, &["switch", "main"]);
        fs::write(&file, "dirty\n").unwrap();

        let error = nox_git_switch(as_string(&scratch.0), "other".to_string(), false).unwrap_err();
        // The phrase the MemoryPlatform fake mirrors — this assertion is the
        // tripwire that keeps fake and real from drifting apart.
        assert!(
            error.contains("Your local changes to the following files would be overwritten"),
            "got {error:?}"
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "dirty\n");
        assert_eq!(git_out(&scratch.0, &["branch", "--show-current"]).trim(), "main");
    }

    #[test]
    fn created_branch_appears_in_the_list() {
        let scratch = Scratch::new("git-branch-create");
        git_in(&scratch.0, &["init", "-b", "main"]);
        git_in(&scratch.0, &["commit", "--allow-empty", "-m", "root"]);

        nox_git_switch(as_string(&scratch.0), "feature/x".to_string(), true).unwrap();
        let branches = nox_git_branches(as_string(&scratch.0)).unwrap();
        assert!(branches.lines().any(|l| l == "feature/x"), "got {branches:?}");
        assert!(branches.lines().any(|l| l == "main"));
    }

    #[test]
    fn invalid_branch_name_is_refused_by_the_validation_read() {
        let scratch = Scratch::new("git-branch-bad");
        git_in(&scratch.0, &["init", "-b", "main"]);
        git_in(&scratch.0, &["commit", "--allow-empty", "-m", "root"]);

        let error = nox_git_switch(as_string(&scratch.0), "bad name".to_string(), true).unwrap_err();
        assert!(error.contains("not a valid branch name"), "got {error:?}");
        // The write never ran: no such branch exists.
        let branches = nox_git_branches(as_string(&scratch.0)).unwrap();
        assert!(!branches.contains("bad"), "got {branches:?}");
    }

    #[test]
    fn status_carries_branch_and_entries_nul_terminated() {
        let scratch = Scratch::new("git-status");
        git_in(&scratch.0, &["init", "-b", "main"]);
        fs::write(scratch.join("a.txt"), "one\n").unwrap();

        let raw = nox_git_status(as_string(&scratch.0)).unwrap();
        assert!(raw.contains("# branch.head main"));
        assert!(raw.contains("? a.txt\u{0}"), "got {raw:?}");
    }
```

- [ ] **Step 2: Implement the helpers and commands in `git.rs`**

Above the existing `nox_git_file_base`, add (the module doc-comment should also be extended: it is no longer "one command"):

```rust
/// Run git and insist on success. Unlike `run_git`'s callers in the gutter
/// path — where every failure is an honest `None` — a failed *write* must say
/// why: the error carries git's own words, stderr first, stdout when stderr
/// is empty (git prints "nothing to commit" on stdout). The `io:` prefix is
/// the fs.rs error convention; `platform/tauri.ts` strips it, so what the
/// renderer sees is git verbatim.
fn run_git_ok(dir: &Path, args: &[&str]) -> Result<std::process::Output> {
    let output = run_git(dir, args).ok_or_else(|| "io: git could not be run".to_string())?;
    if output.status.success() {
        return Ok(output);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(format!("io: {}", if stderr.is_empty() { stdout } else { stderr }))
}

/// The repository toplevel for `root`, in git's own vocabulary.
fn repo_toplevel(root: &Path) -> Result<String> {
    let output = run_git_ok(root, &["rev-parse", "--show-toplevel"])?;
    let top = String::from_utf8_lossy(&output.stdout).trim_end_matches(['\r', '\n']).to_string();
    if top.is_empty() {
        return Err("io: fatal: not a git repository".to_string());
    }
    Ok(top)
}

/// A path made repo-relative by the same canonicalize-and-strip route
/// `nox_git_file_base` uses. A deleted file cannot canonicalize, so the
/// fallback resolves its parent and re-appends the name — staging a deletion
/// is a first-class action in the panel.
fn repo_relative(toplevel: &str, path: &str) -> Result<String> {
    let p = Path::new(path);
    let full = plain_canonical(p)
        .or_else(|| {
            let parent = plain_canonical(p.parent()?)?;
            let name = p.file_name()?.to_str()?;
            Some(format!("{parent}/{name}"))
        })
        .ok_or_else(|| format!("io: cannot resolve {path}"))?;
    relative_to_root(toplevel, &full)
        .ok_or_else(|| format!("io: {path} is not inside the repository"))
}
```

The six commands:

```rust
/// Raw porcelain v2 status. `-z` because filenames contain anything;
/// parsing lives in TypeScript where it is testable without a repo.
#[tauri::command]
pub fn nox_git_status(root: String) -> Result<String> {
    let output = run_git_ok(Path::new(&root), &["status", "--porcelain=v2", "--branch", "-z"])?;
    String::from_utf8(output.stdout).map_err(|_| "io: git status output was not utf-8".to_string())
}

/// Raw local branch list, one short refname per line.
#[tauri::command]
pub fn nox_git_branches(root: String) -> Result<String> {
    let output = run_git_ok(
        Path::new(&root),
        &["branch", "--list", "--format=%(refname:short)"],
    )?;
    String::from_utf8(output.stdout).map_err(|_| "io: git branch output was not utf-8".to_string())
}

/// `git add`. Argv-fixed; `--literal-pathspecs` so a `*` or `:` in a real
/// filename is a filename, and `--` so nothing is ever read as an option.
#[tauri::command]
pub fn nox_git_stage(root: String, paths: Vec<String>) -> Result<()> {
    let top = repo_toplevel(Path::new(&root))?;
    let mut args: Vec<String> = vec!["--literal-pathspecs".into(), "add".into(), "--".into()];
    for path in &paths {
        args.push(repo_relative(&top, path)?);
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git_ok(Path::new(&top), &refs)?;
    Ok(())
}

/// `git restore --staged`. The index only; the working tree is untouchable
/// by construction of the command chosen (this is why it is not `reset`).
#[tauri::command]
pub fn nox_git_unstage(root: String, paths: Vec<String>) -> Result<()> {
    let top = repo_toplevel(Path::new(&root))?;
    let mut args: Vec<String> =
        vec!["--literal-pathspecs".into(), "restore".into(), "--staged".into(), "--".into()];
    for path in &paths {
        args.push(repo_relative(&top, path)?);
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git_ok(Path::new(&top), &refs)?;
    Ok(())
}

/// `git commit --file=-`, the message on stdin — never argv: messages
/// contain quotes, dashes, anything. Never `-a`, never pathspecs: what you
/// staged is what lands. Hooks and signing run because git runs them; a
/// refusal is surfaced verbatim.
#[tauri::command]
pub fn nox_git_commit(root: String, message: String) -> Result<String> {
    use std::process::Stdio;

    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(&root)
        .args(["commit", "--file=-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command.spawn().map_err(|e| format!("io: git could not be run ({e})"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "io: no stdin handle".to_string())?
        .write_all(message.as_bytes())
        .map_err(|e| format!("io: could not write the message ({e})"))?;
    let output = child
        .wait_with_output()
        .map_err(|e| format!("io: git did not finish ({e})"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(format!("io: {}", if stderr.is_empty() { stdout } else { stderr }));
    }

    let log = run_git_ok(Path::new(&root), &["log", "-1", "--format=%h %s"])?;
    Ok(String::from_utf8_lossy(&log.stdout).trim().to_string())
}

/// `git switch`, the name validated first with `check-ref-format --branch`
/// (a read) so the only strings reaching the write are ones git itself
/// blessed. Never `-f`: a refusal over dirty files is git's to make and
/// ours to show.
#[tauri::command]
pub fn nox_git_switch(root: String, name: String, create: bool) -> Result<()> {
    let dir = Path::new(&root);
    run_git_ok(dir, &["check-ref-format", "--branch", &name])?;
    if create {
        run_git_ok(dir, &["switch", "-c", &name])?;
    } else {
        run_git_ok(dir, &["switch", &name])?;
    }
    Ok(())
}
```

`Command` and `Write` need importing: `use std::io::Write;` at the top of the commit function or the module (`std::process::Command` is already imported at git.rs:20).

- [ ] **Step 3: Register in `src-tauri/src/lib.rs`**

After `git::nox_git_file_base,` (lib.rs:67):

```rust
            git::nox_git_status,
            git::nox_git_branches,
            git::nox_git_stage,
            git::nox_git_unstage,
            git::nox_git_commit,
            git::nox_git_switch,
```

- [ ] **Step 4: Verify what can be verified here**

```bash
npm run check && npm test
```

Expected: unchanged green (no TS touched). If a local `cargo` exists, run `cd src-tauri && cargo test`; otherwise state plainly in the commit body and the task report that the Rust tests are **unrun locally** and CI is the first thing to execute them.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/git.rs src-tauri/src/lib.rs
git commit -m "Add the six git writes and reads, argv-fixed, refusals verbatim"
```

---

### Task 4: `GitService` learns the working state

**Files:**
- Modify: `src/services/git.ts` (status signal, `refreshStatus`, `listBranches`, triggers, notifications)
- Modify: `src/app.ts` (pass notifications at app.ts:228; extend `git.refreshGutter` at app.ts:2226-2234)
- Test: extend `tests/git-service.test.ts`

**Interfaces:**
- Consumes: `parseGitStatus`, `parseGitBranches`, `GitStatus` (Task 1); `Platform.gitStatus/gitBranches` (Task 2); `NotificationService` (`error(message, detail?)` — verified `src/services/notifications.ts:93`).
- Produces, on `GitService`:
  ```ts
  readonly status: Signal<GitStatus | null>;      // null: no repo / not started / no root
  refreshStatus(): Promise<void>;                  // coalesced: one in flight, one queued, not N
  listBranches(): Promise<string[]>;               // parsed local branches, [] on failure
  ```
  Constructor becomes `constructor(platform: Platform, workspace: WorkspaceService, notifications?: NotificationService)` — optional so every existing `new GitService(platform, workspace)` call in tests keeps compiling.

- [ ] **Step 1: Write the failing tests**

Append to `tests/git-service.test.ts` (the suite already runs fake timers and `openSeeded`):

```ts
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
    platform.seedGitRepo('/w');
    await app.workspace.openFolder('/w');
    await vi.runAllTimersAsync();
    await platform.gitSwitch('/w', 'feature', true);
    expect((await app.git.listBranches()).sort()).toEqual(['feature', 'main']);
  });
});
```

Note `openSeeded` already exists in this file; the new `describe` block reuses `app`/`platform` from the suite's `beforeEach`.

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run tests/git-service.test.ts`
Expected: FAIL — `status` / `refreshStatus` / `seedGitRepo`-driven expectations (the first two are missing).

- [ ] **Step 3: Implement in `src/services/git.ts`**

Imports: add `import { parseGitBranches, parseGitStatus, type GitStatus } from '@core/git-status';` and `import type { NotificationService } from './notifications';`.

Fields and constructor:

```ts
  /**
   * The working state: branch, staged, unstaged. Null before the first
   * answer, over no root, and over a folder that is not a repository — the
   * panel words each of those from its own context.
   */
  readonly status = new Signal<GitStatus | null>(null);

  #notifications: NotificationService | undefined;
  #statusInFlight = false;
  #statusQueued = false;

  constructor(platform: Platform, workspace: WorkspaceService, notifications?: NotificationService) {
    this.#platform = platform;
    this.#workspace = workspace;
    this.#notifications = notifications;
  }
```

Methods:

```ts
  /**
   * Re-ask git for the working state. Coalesced: one refresh in flight at a
   * time, and any number of requests arriving meanwhile queue exactly one
   * more — the second answer is already computed from the state the burst
   * produced, so a third would learn nothing.
   */
  async refreshStatus(): Promise<void> {
    if (this.#statusInFlight) {
      this.#statusQueued = true;
      return;
    }
    this.#statusInFlight = true;
    try {
      const root = this.#workspace.rootPath.get();
      if (!root) {
        this.status.set(null);
        return;
      }
      const raw = await this.#platform.gitStatus(root);
      this.status.set(parseGitStatus(raw));
    } catch {
      // Not a repository (or git absent). For a *read*, absence is the
      // honest degraded state — refusals only matter for writes.
      this.status.set(null);
    } finally {
      this.#statusInFlight = false;
      if (this.#statusQueued) {
        this.#statusQueued = false;
        void this.refreshStatus();
      }
    }
  }

  /** Local branches, parsed. Empty when git has no answer. */
  async listBranches(): Promise<string[]> {
    const root = this.#workspace.rootPath.get();
    if (!root) return [];
    try {
      return parseGitBranches(await this.#platform.gitBranches(root));
    } catch {
      return [];
    }
  }
```

Trigger wiring, in `start()` — status refreshes ride the exact events that already refetch bases:

- In the `saved` handler: `workspace.events.on('saved', ({ id }) => { void this.#refresh(id); void this.refreshStatus(); })`.
- In the `external-change` handler: likewise add `void this.refreshStatus();`.
- In the `rootPath` subscription: after `this.#reset()`, add `void this.refreshStatus();` (the subscription fires immediately with the current value — `Signal.subscribe` calls its handler synchronously — so a service started after a folder opened still gets its first status).
- In `#refetchOnActivation`, after the throttle check passes: `void this.refreshStatus();` (same 2 s throttle, one timestamp per path exactly as today — status piggybacks on the activation moment).
- In `#reset()`: `this.status.set(null);`.

In `src/app.ts:228`: `this.git = new GitService(platform, this.workspace, this.notifications);`

In `src/app.ts`, `git.refreshGutter` (app.ts:2226) — the "palette refresh" the spec's §5 keeps — now refreshes both:

```ts
        run: () => {
          void this.git.refreshStatus();
          void this.git.refreshAll();
        },
```

- [ ] **Step 4: Run and watch pass**

Run: `npx vitest run tests/git-service.test.ts && npm run check`
Expected: PASS, 0 errors.

- [ ] **Step 5: Full suite and commit**

```bash
npm test
git add src/services/git.ts src/app.ts tests/git-service.test.ts
git commit -m "Teach GitService the working state, one coalesced refresh at a time"
```

---

### Task 5: The Git panel, read-only

**Files:**
- Create: `src/ui/GitPanel.svelte`
- Modify: `src/services/ui.ts` (`SidebarView` + `FocusZone` gain `'git'`; `focusGitRequest`; `focusGit()`; `showView` branch)
- Modify: `src/ui/Sidebar.svelte` (rail entry + render branch)
- Modify: `src/ui/Icon.svelte` (two paths: `branch`, `minus`)
- Modify: `src/app.ts` (`git.focus` command)
- Test: `tests/git-panel.test.ts` (jsdom)

**Interfaces:**
- Consumes: `GitService.status`, `listBranches` (Task 4); `FileEntry` (Task 1); `PanelHeader` (`{ title, summary?, actions?, children? }`), `PanelEmpty` (`{ children, action? }`); `useApp()`; `workspace.open(path)`, `workspace.rootPath`; `ui.showDiff()`; `commands.execute`.
- Produces: the `git` sidebar view; command `git.focus`; icons `branch` and `minus`; `ui.focusGit()`. Later tasks add the stage/unstage/commit controls into this component.

- [ ] **Step 1: Write the failing test**

`tests/git-panel.test.ts` — the harness is `tests/support/component.ts` (`mountComponent`, `flush`), the pattern `tests/git-diff-view.test.ts` uses:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import GitPanel from '../src/ui/GitPanel.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * The Git panel over a real app and the MemoryPlatform repository model —
 * real sequences, not choreography. See the spec's §6.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

/** A microtask settle + flush: refreshStatus is one await chain deep. */
async function settle() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
  flush();
}

async function setup() {
  mounted = mountComponent(GitPanel);
  const { app, platform, container } = mounted;
  app.git.start();
  platform.seedGitRepo('/w');
  platform.seedGitBase('/w/clean.ts', 'same\n');
  platform.seedFile('/w/clean.ts', 'same\n');
  platform.seedGitBase('/w/edited.ts', 'one\n');
  platform.seedFile('/w/edited.ts', 'one\ntwo\n');
  platform.seedFile('/w/loose.ts', 'untracked\n');
  await app.workspace.openFolder('/w');
  await settle();
  return { app, platform, container };
}

describe('the git panel, read-only', () => {
  it('shows the branch on the branch line', async () => {
    const { container } = await setup();
    expect(container.querySelector('.branch-line')!.textContent).toContain('main');
  });

  it('lists worktree changes under Changes, untracked labelled U', async () => {
    const { container } = await setup();
    const rows = [...container.querySelectorAll('.section.changes .row')];
    const texts = rows.map((r) => r.textContent ?? '');
    expect(texts.some((t) => t.includes('edited.ts') && t.includes('M'))).toBe(true);
    expect(texts.some((t) => t.includes('loose.ts') && t.includes('U'))).toBe(true);
    expect(texts.some((t) => t.includes('clean.ts'))).toBe(false);
  });

  it('shows the staged section only when something is staged', async () => {
    const { container, platform, app } = await setup();
    expect(container.querySelector('.section.staged')).toBeNull();
    await platform.gitStage('/w', ['/w/edited.ts']);
    await app.git.refreshStatus();
    await settle();
    expect(container.querySelector('.section.staged .row')!.textContent).toContain('edited.ts');
  });

  it('opens the file on row click', async () => {
    const { container, app } = await setup();
    const row = [...container.querySelectorAll('.section.changes .row .open')].find((r) =>
      r.textContent!.includes('edited.ts'),
    ) as HTMLElement;
    row.click();
    await settle();
    expect(app.workspace.buffers.get().some((b) => b.path === '/w/edited.ts')).toBe(true);
  });

  it('the view affordance opens the file and the diff surface', async () => {
    const { container, app } = await setup();
    const view = [...container.querySelectorAll('.section.changes .row')]
      .find((r) => r.textContent!.includes('edited.ts'))!
      .querySelector('[title="Show Changes"]') as HTMLElement;
    view.click();
    await settle();
    expect(app.ui.diffOpen.get()).toBe(true);
  });

  it('says so over a folder that is not a repository', async () => {
    mounted = mountComponent(GitPanel);
    const { app, platform, container } = mounted;
    app.git.start();
    platform.seedFile('/plain/a.txt', 'x\n');
    await app.workspace.openFolder('/plain');
    await settle();
    expect(container.querySelector('.panel-empty')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run tests/git-panel.test.ts`
Expected: FAIL — cannot resolve `../src/ui/GitPanel.svelte`.

- [ ] **Step 3: The plumbing**

`src/services/ui.ts`:
- `SidebarView` (ui.ts:23) gains `'git'`: `export type SidebarView = 'explorer' | 'search' | 'notes' | 'answers' | 'problems' | 'references' | 'git';`
- `FocusZone` (ui.ts:45) gains `'git'`.
- Beside `focusReferencesRequest` (ui.ts:128): `/** Bumped to ask the git panel to take focus. */ readonly focusGitRequest = new Signal(0);`
- In `showView` (ui.ts:199): add `else if (view === 'git') this.focusGit();` before the final `else`.
- Beside `focusReferences` (ui.ts:246):

```ts
  focusGit(): void {
    this.sidebarView.set('git');
    this.focusZone.set('git');
    this.focusGitRequest.update((n) => n + 1);
  }
```

`src/ui/Icon.svelte` — two entries in `PATHS` (stroke-path style, matching the set; tune visually against the rail at 15px):

```ts
    // Two commits on a trunk and one on a branch, joined by the curve —
    // the universal "branch" glyph, drawn in this set's stroke style.
    branch: 'M5 4.25h.1 M5 6.5v5.25h.1 M11 4.25h.1 M11 6.5c0 3-6 2.25-6 5',
    // Unstage. `minimize` is the same stroke but means "window control".
    minus: 'M3.5 8h9',
```

`src/ui/Sidebar.svelte`:
- `import GitPanel from './GitPanel.svelte';`
- `VIEWS` (Sidebar.svelte:33) gains, after the `references` entry: `{ id: 'git', icon: 'branch', label: 'Git', command: 'git.focus' },`
- Render chain gains, after the `references` branch: `{:else if $view === 'git'}<GitPanel />`

`src/app.ts`, beside `references.focus` (app.ts:2205):

```ts
      {
        id: 'git.focus',
        title: 'Show Git',
        category: 'Git',
        keywords: ['git', 'stage', 'commit', 'branch', 'changes', 'status'],
        run: () => {
          this.config.set('workbench.showExplorer', true);
          this.ui.showView('git');
        },
      },
```

- [ ] **Step 4: The component**

`src/ui/GitPanel.svelte`:

```svelte
<script lang="ts">
  import { untrack } from 'svelte';
  import { join } from '@core/path';
  import type { FileEntry } from '@core/git-status';
  import { useApp } from './context';
  import Icon from './Icon.svelte';
  import PanelEmpty from './PanelEmpty.svelte';
  import PanelHeader from './PanelHeader.svelte';

  /**
   * The Git view: what is my working state, and how do I turn it into a
   * commit — nothing else. Two sections mirroring `git status`, a branch
   * line, a commit box. Everything it renders comes from `GitService.status`;
   * nothing here asks git directly, and every mutation goes through the
   * service so the refresh discipline (envelope §6) has one home.
   *
   * See docs/superpowers/specs/2026-08-19-git-stage-commit-design.md §1.
   */

  const app = useApp();
  const { git, ui, workspace } = app;
  const status = git.status;
  const focusRequest = ui.focusGitRequest;

  let panelEl = $state<HTMLElement | null>(null);

  // `git.focus` (and the rail) land here; give the keyboard somewhere real.
  $effect(() => {
    void $focusRequest;
    untrack(() => panelEl)?.focus();
  });

  const branchLabel = $derived.by(() => {
    const s = $status;
    if (!s) return '';
    if (s.detached) return `detached at ${s.oid?.slice(0, 7) ?? '?'}`;
    return s.branch ?? '?';
  });

  const summary = $derived.by(() => {
    const s = $status;
    if (!s) return '';
    const total = s.staged.length + s.unstaged.length;
    return total === 0 ? 'clean' : `${total} change${total === 1 ? '' : 's'}`;
  });

  function absolute(entry: FileEntry): string {
    // Status paths are toplevel-relative; the workspace root is the repo
    // root in every workflow this row supports (spec §8: one root, one repo).
    const root = workspace.rootPath.get();
    return root ? join(root, entry.path) : entry.path;
  }

  async function open(entry: FileEntry): Promise<void> {
    await workspace.open(absolute(entry));
  }

  async function view(entry: FileEntry): Promise<void> {
    // The diff view is where a change is *looked at*; the row only points.
    await workspace.open(absolute(entry));
    ui.showDiff();
  }
</script>

<div class="panel" bind:this={panelEl} tabindex="-1">
  <PanelHeader title="Git" {summary} />

  {#if !git.started}
    <PanelEmpty>Git is not available in this build.</PanelEmpty>
  {:else if !$status}
    <PanelEmpty>This folder is not a git repository.</PanelEmpty>
  {:else}
    <button
      class="branch-line"
      title="Switch or create a branch"
      onclick={() => ui.openOverlay('git-branch')}
    >
      <Icon name="branch" size={12} />
      <span class="name">{branchLabel}</span>
    </button>

    <div class="lists nox-scroll">
      {#if $status.staged.length > 0}
        <section class="section staged" aria-label="Staged changes">
          <h3>Staged</h3>
          {#each $status.staged as entry (entry.path)}
            {@render row(entry, 'staged')}
          {/each}
        </section>
      {/if}

      <section class="section changes" aria-label="Changes">
        <h3>Changes</h3>
        {#if $status.unstaged.length === 0}
          <p class="quiet">No changes.</p>
        {:else}
          {#each $status.unstaged as entry (entry.path)}
            {@render row(entry, 'unstaged')}
          {/each}
        {/if}
      </section>
    </div>

    <!-- The commit box lands in the commit task. -->
  {/if}
</div>

{#snippet row(entry: FileEntry, section: 'staged' | 'unstaged')}
  <div class="row" title={entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path}>
    <span class="letter letter-{entry.status}">{entry.status}</span>
    <button class="open" onclick={() => void open(entry)}>{entry.path}</button>
    <span class="actions">
      <button class="nox-button ghost small" title="Show Changes" onclick={() => void view(entry)}>
        <Icon name="file" size={11} />
      </button>
      <!-- Stage / unstage buttons land in the stage task; `section` is used there. -->
    </span>
  </div>
{/snippet}

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    outline: none;
  }

  .branch-line {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
    padding: var(--nox-sp-2) var(--nox-sp-5);
    font-size: var(--nox-fs-sm);
    color: var(--nox-text);
    flex: none;
  }

  .branch-line:hover {
    background: var(--nox-hover);
  }

  .branch-line .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .lists {
    min-height: 0;
    flex: 1;
  }

  .section h3 {
    margin: 0;
    padding: var(--nox-sp-2) var(--nox-sp-5) var(--nox-sp-1);
    font-size: var(--nox-fs-2xs);
    font-weight: var(--nox-fw-semibold);
    text-transform: uppercase;
    letter-spacing: var(--nox-tracking-wide);
    color: var(--nox-text-muted);
  }

  .quiet {
    margin: 0;
    padding: var(--nox-sp-1) var(--nox-sp-5);
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-muted);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-3);
    padding: var(--nox-sp-1) var(--nox-sp-3) var(--nox-sp-1) var(--nox-sp-5);
    font-size: var(--nox-fs-sm);
    white-space: nowrap;
  }

  .row:hover {
    background: var(--nox-hover);
  }

  .row .open {
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: left;
    min-width: 0;
    flex: 1;
    color: var(--nox-text);
  }

  .row .actions {
    display: none;
    align-items: center;
    gap: var(--nox-sp-1);
    flex: none;
  }

  .row:hover .actions {
    display: flex;
  }

  /* The tokens the gutter already uses (editor/theme.ts): added green,
     modified amber, deleted red. Untracked shares added's green — staging
     it is "start tracking this". A rename is informational blue. */
  .letter {
    flex: none;
    width: 1.5ch;
    text-align: center;
    font-family: var(--nox-font-mono);
    font-size: var(--nox-fs-xs);
  }

  .letter-A,
  .letter-U {
    color: var(--nox-success);
  }

  .letter-M {
    color: var(--nox-warning);
  }

  .letter-D {
    color: var(--nox-danger);
  }

  .letter-R {
    color: var(--nox-info);
  }
</style>
```

Two build notes for this task:
- `ui.openOverlay('git-branch')` will not type-check until the branch-picker task adds the overlay kind. **For this task**, wire the branch line's `onclick` to a no-op comment instead — `onclick={() => {/* the branch picker lands in its own task */}}` — and move the `openOverlay` call into Task 8. (The test suite here does not click it.)
- Place the `{#snippet row(...)}` block **above** the `<div class="panel">` markup rather than after it as printed, so the `{@render row(...)}` references never lean on hoisting.

- [ ] **Step 5: Run and watch pass**

Run: `npx vitest run tests/git-panel.test.ts && npm run check`
Expected: PASS, 0 errors. `svelte-check` will flag any capabilities or union member missed — fix each rather than widening a type.

- [ ] **Step 6: Full suite and commit**

```bash
npm test
git add src/ui/GitPanel.svelte src/ui/Sidebar.svelte src/ui/Icon.svelte src/services/ui.ts src/app.ts tests/git-panel.test.ts
git commit -m "Show the working state: a branch line and two honest lists"
```

---

### Task 6: Stage and unstage

**Files:**
- Modify: `src/services/git.ts` (`stage`, `unstage`)
- Modify: `src/ui/GitPanel.svelte` (the +/− row buttons)
- Test: extend `tests/git-panel.test.ts`

**Interfaces:**
- Consumes: `Platform.gitStage/gitUnstage` (Task 2), `refreshStatus`/`refreshAll` (Task 4 / existing `git.ts:114`), `NotificationService.error`.
- Produces, on `GitService`:
  ```ts
  stage(paths: string[]): Promise<void>;    // absolute paths
  unstage(paths: string[]): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/git-panel.test.ts`:

```ts
describe('stage and unstage', () => {
  it('stage moves the row between sections and the gutter base follows', async () => {
    const { app, container } = await setup();
    const id = (await app.workspace.open('/w/edited.ts'))!;
    await settle();
    // Before: the buffer differs from the index base ('one\n').
    expect(app.git.hunks.get().has(id)).toBe(true);

    const stage = [...container.querySelectorAll('.section.changes .row')]
      .find((r) => r.textContent!.includes('edited.ts'))!
      .querySelector('[title="Stage"]') as HTMLElement;
    stage.click();
    await settle();
    await settle();

    expect(container.querySelector('.section.staged')!.textContent).toContain('edited.ts');
    // Envelope §6: the mutation refreshed the gutter base — the index now
    // holds the buffer's text, so the hunks are gone.
    expect(app.git.hunks.get().has(id)).toBe(false);
  });

  it('unstage returns the row', async () => {
    const { app, container, platform } = await setup();
    await platform.gitStage('/w', ['/w/edited.ts']);
    await app.git.refreshStatus();
    await settle();

    const unstage = container
      .querySelector('.section.staged .row [title="Unstage"]') as HTMLElement;
    unstage.click();
    await settle();
    await settle();

    expect(container.querySelector('.section.staged')).toBeNull();
    expect(container.querySelector('.section.changes')!.textContent).toContain('edited.ts');
  });

  it('a refused stage becomes a notification with git\'s words, and the panel keeps the truth', async () => {
    const { app, container, platform } = await setup();
    platform.gitStage = async () => {
      throw new Error("fatal: pathspec 'edited.ts' did not match any files");
    };
    const stage = [...container.querySelectorAll('.section.changes .row')]
      .find((r) => r.textContent!.includes('edited.ts'))!
      .querySelector('[title="Stage"]') as HTMLElement;
    stage.click();
    await settle();
    await settle();

    const items = app.notifications.items.get();
    expect(items.some((n) => n.kind === 'error' && n.message.includes('did not match'))).toBe(true);
    expect(container.querySelector('.section.staged')).toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run tests/git-panel.test.ts`
Expected: the new tests FAIL — no `[title="Stage"]` element.

- [ ] **Step 3: Implement the service writes**

In `src/services/git.ts`, below `listBranches`:

```ts
  /**
   * One write, one shape: try, surface a refusal verbatim as a notification,
   * refresh regardless — the panel never shows a state its own action made
   * stale, and after a failure the refresh shows the truth (envelope §6, §4).
   */
  async #write(action: () => Promise<void>): Promise<boolean> {
    let ok = true;
    try {
      await action();
    } catch (error) {
      ok = false;
      this.#notifications?.error(error instanceof Error ? error.message : String(error));
    }
    await this.refreshStatus();
    await this.refreshAll();
    return ok;
  }

  /** `git add` by name. Absolute paths; the platform relativizes. */
  async stage(paths: string[]): Promise<void> {
    const root = this.#workspace.rootPath.get();
    if (!root) return;
    await this.#write(() => this.#platform.gitStage(root, paths));
  }

  /** `git restore --staged` by name. The index only, by construction. */
  async unstage(paths: string[]): Promise<void> {
    const root = this.#workspace.rootPath.get();
    if (!root) return;
    await this.#write(() => this.#platform.gitUnstage(root, paths));
  }
```

- [ ] **Step 4: Add the row buttons**

In `GitPanel.svelte`'s `row` snippet, inside `.actions` after the view button:

```svelte
      {#if section === 'unstaged'}
        <button
          class="nox-button ghost small"
          title="Stage"
          onclick={() => void git.stage([absolute(entry)])}
        >
          <Icon name="plus" size={11} />
        </button>
      {:else}
        <button
          class="nox-button ghost small"
          title="Unstage"
          onclick={() => void git.unstage([absolute(entry)])}
        >
          <Icon name="minus" size={11} />
        </button>
      {/if}
```

- [ ] **Step 5: Run and watch pass, then commit**

```bash
npx vitest run tests/git-panel.test.ts tests/git-service.test.ts
npm run check && npm test
git add src/services/git.ts src/ui/GitPanel.svelte tests/git-panel.test.ts
git commit -m "Stage and unstage by name, the gutter following the index"
```

---

### Task 7: Commit

**Files:**
- Modify: `src/services/git.ts` (`commit`)
- Modify: `src/ui/GitPanel.svelte` (the commit box)
- Test: extend `tests/git-panel.test.ts`

**Interfaces:**
- Consumes: `Platform.gitCommit` (Task 2), `#write` (Task 6), `NotificationService.success`.
- Produces, on `GitService`: `commit(message: string): Promise<string | null>` — `"<short-hash> <subject>"` on success, `null` on a refusal (which has already been surfaced as an error notification).

- [ ] **Step 1: Write the failing tests**

Append to `tests/git-panel.test.ts`:

```ts
describe('commit', () => {
  it('is disabled with nothing staged, and with a blank message', async () => {
    const { container, platform, app } = await setup();
    const button = () => container.querySelector('.commit button') as HTMLButtonElement;
    const box = () => container.querySelector('.commit textarea') as HTMLTextAreaElement;

    // Nothing staged: disabled even with a message.
    box().value = 'a message';
    box().dispatchEvent(new Event('input'));
    flush();
    expect(button().disabled).toBe(true);

    await platform.gitStage('/w', ['/w/edited.ts']);
    await app.git.refreshStatus();
    await settle();

    // Staged but blank message: still disabled.
    box().value = '   ';
    box().dispatchEvent(new Event('input'));
    flush();
    expect(button().disabled).toBe(true);

    box().value = 'a message';
    box().dispatchEvent(new Event('input'));
    flush();
    expect(button().disabled).toBe(false);
  });

  it('clears the staged list and the box, bumps the log, and names the commit', async () => {
    const { container, platform, app } = await setup();
    await platform.gitStage('/w', ['/w/edited.ts']);
    await app.git.refreshStatus();
    await settle();

    const box = container.querySelector('.commit textarea') as HTMLTextAreaElement;
    box.value = 'Widen the edit\n\nWith a body.';
    box.dispatchEvent(new Event('input'));
    flush();
    (container.querySelector('.commit button') as HTMLElement).click();
    await settle();
    await settle();

    expect(container.querySelector('.section.staged')).toBeNull();
    expect((container.querySelector('.commit textarea') as HTMLTextAreaElement).value).toBe('');
    const state = platform.gitRepoState('/w')!;
    expect(state.commits.at(-1)!.subject).toBe('Widen the edit');
    const toast = app.notifications.items.get().find((n) => n.kind === 'success')!;
    expect(toast.message).toMatch(/[0-9a-f]{7} Widen the edit/);
  });

  it('surfaces a refusal verbatim and keeps the staged list', async () => {
    const { container, platform, app } = await setup();
    await platform.gitStage('/w', ['/w/edited.ts']);
    await app.git.refreshStatus();
    await settle();
    platform.gitCommit = async () => {
      throw new Error('Aborting commit due to empty commit message.');
    };

    const box = container.querySelector('.commit textarea') as HTMLTextAreaElement;
    box.value = 'doomed';
    box.dispatchEvent(new Event('input'));
    flush();
    (container.querySelector('.commit button') as HTMLElement).click();
    await settle();
    await settle();

    expect(
      app.notifications.items.get().some((n) => n.kind === 'error' && n.message.includes('empty commit message')),
    ).toBe(true);
    // The box keeps the message — a failed commit must not eat the words.
    expect((container.querySelector('.commit textarea') as HTMLTextAreaElement).value).toBe('doomed');
    expect(container.querySelector('.section.staged')!.textContent).toContain('edited.ts');
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run tests/git-panel.test.ts`
Expected: FAIL — no `.commit` element.

- [ ] **Step 3: Implement the service method**

In `src/services/git.ts`:

```ts
  /**
   * `git commit --file=-` — commits the index, never `-a`, never pathspecs
   * (envelope §5): the staged list on screen is the commit preview. Returns
   * `"<short-hash> <subject>"`, or null after a refusal (already surfaced).
   */
  async commit(message: string): Promise<string | null> {
    const root = this.#workspace.rootPath.get();
    if (!root) return null;
    let result: string | null = null;
    const ok = await this.#write(async () => {
      result = await this.#platform.gitCommit(root, message);
    });
    return ok ? result : null;
  }
```

- [ ] **Step 4: Add the commit box**

In `GitPanel.svelte`, script additions:

```ts
  const { git, ui, workspace, notifications } = app;  // notifications joins the destructure

  let message = $state('');
  const canCommit = $derived(($status?.staged.length ?? 0) > 0 && message.trim().length > 0);
  let committing = $state(false);

  async function commit(): Promise<void> {
    if (!canCommit || committing) return;
    committing = true;
    try {
      const result = await git.commit(message);
      if (result !== null) {
        message = '';
        // The success names the short hash and subject — `result` is
        // exactly `git log -1 --format=%h %s`.
        notifications.success(`Committed ${result}`);
      }
    } finally {
      committing = false;
    }
  }
```

Markup, replacing the `<!-- The commit box lands in the commit task. -->` placeholder (after the lists, bottom of the panel per the spec's §1 order):

```svelte
    <div class="commit">
      <textarea
        class="nox-input"
        rows="3"
        placeholder="Commit message (first line becomes the subject)"
        bind:value={message}
        onkeydown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            void commit();
          }
        }}
      ></textarea>
      <button class="nox-button primary small" disabled={!canCommit || committing} onclick={() => void commit()}>
        Commit
      </button>
    </div>
```

Style:

```css
  .commit {
    display: flex;
    flex-direction: column;
    gap: var(--nox-sp-2);
    padding: var(--nox-sp-3) var(--nox-sp-5) var(--nox-sp-4);
    border-top: 1px solid var(--nox-border);
    flex: none;
  }

  .commit textarea {
    height: auto;
    resize: vertical;
    font-family: var(--nox-font-ui);
    line-height: 1.4;
  }
```

(`.nox-button.primary` is a real primitive — defined at `src/styles/base.css:199`, verified.)

Also point `ui.focusGitRequest`'s `$effect` at the textarea instead of the panel div — the one interactive text control is where focus is useful:

```ts
  let messageEl = $state<HTMLTextAreaElement | null>(null);
  $effect(() => {
    void $focusRequest;
    untrack(() => messageEl)?.focus();
  });
```

with `bind:this={messageEl}` on the textarea. Keep `tabindex="-1"` on the panel for the not-a-repo case.

- [ ] **Step 5: Run and watch pass, then commit**

```bash
npx vitest run tests/git-panel.test.ts
npm run check && npm test
git add src/services/git.ts src/ui/GitPanel.svelte tests/git-panel.test.ts
git commit -m "Commit the index, and say what landed"
```

---

### Task 8: The branch picker

**Files:**
- Modify: `src/services/git.ts` (`switch`)
- Modify: `src/services/ui.ts` (`OverlayKind` gains `'git-branch'`)
- Modify: `src/ui/Overlays.svelte` (`isPalette` includes it)
- Modify: `src/ui/CommandPalette.svelte` (the prefix-free branch mode)
- Modify: `src/ui/GitPanel.svelte` (branch line opens the picker)
- Test: extend `tests/git-panel.test.ts`

**Interfaces:**
- Consumes: `Platform.gitSwitch` (Task 2), `listBranches` (Task 4), `#write` (Task 6), `ui.askForText` (`src/services/ui.ts:318`), `fuzzyMatch` from `@core/fuzzy`.
- Produces: `GitService.switch(name: string, create: boolean): Promise<void>` (a method named `switch` is legal ES; spec §4 names it); overlay kind `'git-branch'`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/git-panel.test.ts` (service-level switch behavior through the panel, plus the picker's row source):

```ts
import CommandPalette from '../src/ui/CommandPalette.svelte';

describe('branch switch and create', () => {
  it('a refused switch leaves the panel unchanged and shows git\'s words', async () => {
    const { app, platform, container } = await setup();
    // A conflicting branch: f.txt differs and the worktree is dirty.
    platform.seedGitBase('/w/f.txt', 'v1\n');
    platform.externalWrite('/w/f.txt', 'v1\n');
    await platform.gitSwitch('/w', 'other', true);
    platform.externalWrite('/w/f.txt', 'v2\n');
    await platform.gitStage('/w', ['/w/f.txt']);
    await platform.gitCommit('/w', 'v2');
    await platform.gitSwitch('/w', 'main', false);
    platform.externalWrite('/w/f.txt', 'dirty\n');
    await app.git.refreshStatus();
    await settle();

    await app.git.switch('other', false);
    await settle();

    expect(container.querySelector('.branch-line')!.textContent).toContain('main');
    expect(
      app.notifications.items.get().some(
        (n) => n.kind === 'error' && n.message.includes('Your local changes'),
      ),
    ).toBe(true);
  });

  it('branch create + switch updates the branch line', async () => {
    const { app, container } = await setup();
    await app.git.switch('feature/picker', true);
    await settle();
    expect(container.querySelector('.branch-line')!.textContent).toContain('feature/picker');
  });
});

describe('the branch picker mode', () => {
  it('lists local branches with Create branch… at the top, prefix-free', async () => {
    const { app, platform } = await setup();
    await platform.gitSwitch('/w', 'feature/x', true);
    await platform.gitSwitch('/w', 'main', false);
    await app.git.refreshStatus();
    await settle();

    const picker = mountComponent(CommandPalette, { app, props: { mode: 'git-branch' } });
    try {
      await settle();
      const rows = [...picker.container.querySelectorAll('[role="option"]')].map(
        (r) => r.textContent ?? '',
      );
      expect(rows[0]).toContain('Create branch…');
      expect(rows.some((r) => r.includes('feature/x'))).toBe(true);
      expect(rows.some((r) => r.includes('main'))).toBe(true);
    } finally {
      picker.unmount();
    }
  });
});
```

The `[role="option"]` selector is verified: every palette row renders with `role="option"` (`src/ui/CommandPalette.svelte:570`).

`mountComponent(CommandPalette, { app, props: { mode: 'git-branch' } })` — the harness accepts a shared `app` (see `tests/git-diff-view.test.ts:44`'s `mountComponent(DiffView, { app })`).

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run tests/git-panel.test.ts`
Expected: FAIL — `app.git.switch` is not a function; the picker mode does not exist.

- [ ] **Step 3: Implement**

`src/services/git.ts`:

```ts
  /**
   * `git switch <name>` / `git switch -c <name>` (spec §2). A refusal —
   * dirty conflicting files, an invalid name — is git's to make and ours to
   * show verbatim; we never pass -f (envelope §4).
   */
  async switch(name: string, create: boolean): Promise<void> {
    const root = this.#workspace.rootPath.get();
    if (!root) return;
    await this.#write(() => this.#platform.gitSwitch(root, name, create));
  }
```

`src/services/ui.ts` — `OverlayKind` (ui.ts:13) gains `'git-branch'`.

`src/ui/Overlays.svelte` — `isPalette` (Overlays.svelte:23) gains `|| $overlay === 'git-branch'`.

`src/ui/CommandPalette.svelte`:

1. `initialText` returns `''` for `'git-branch'` (it already returns `''` in the default case — add an explicit branch or rely on the fallthrough; explicit reads better).
2. `effectiveMode` becomes prefix-free in this mode — at the top of the `$derived.by`:

```ts
    // The branch picker is a picker, not the multiplexed palette: no prefix
    // may switch it into another mode, because "?" or ">" are legal in what
    // the user might type while filtering.
    if (mode === 'git-branch') return 'branches';
```

(and widen the derived's type union with `'branches'`).

3. The `term` derived slices off the first character in every prefixed mode — but the branch mode is prefix-free, so it must keep the whole text:

```ts
  const term = $derived(
    effectiveMode === 'files' || effectiveMode === 'branches' ? text.trim() : text.slice(1).trim(),
  );
```

4. `placeholder` case: `'Switch to a branch, or create one…'`. `modeIcon` case: `'branch'`.
5. Branch data, near the symbol cache:

```ts
  // Fetched once per opening: the palette remounts per opening (Overlays
  // keys on the mode), which is exactly the freshness a picker needs.
  let branches = $state<string[] | null>(null);
  $effect(() => {
    if (mode !== 'git-branch') return;
    void app.git.listBranches().then((list) => {
      branches = list;
    });
  });
```

(`app.git` is reachable — `useApp()` returns the whole app; add `git` to the destructure or use `app.git` directly.)

6. The rows source, beside `bufferRows`:

```ts
  /**
   * Local branches, "Create branch…" pinned first (the spec's §1 order).
   * The current branch is shown but inert — switching to where you stand
   * is a no-op git would also shrug at.
   */
  function branchRows(query: string): RowsResult {
    const current = app.git.status.get()?.branch ?? null;
    const rows: Row[] = [
      {
        key: 'create-branch',
        title: 'Create branch…',
        positions: [],
        icon: 'plus',
        accept: () => {
          ui.closeOverlay();
          void ui
            .askForText({
              title: 'Create Branch',
              initialValue: '',
              placeholder: 'branch name',
              confirmLabel: 'Create',
            })
            .then((name) => {
              // Validation is git's: check-ref-format runs before the write,
              // and its refusal arrives verbatim (envelope §4).
              if (name) void app.git.switch(name.trim(), true);
            });
        },
      },
    ];

    const scored: { row: Row; score: number }[] = [];
    for (const branch of branches ?? []) {
      const match = query.length === 0 ? { score: 0, positions: [] as number[] } : fuzzyMatch(query, branch);
      if (!match) continue;
      const isCurrent = branch === current;
      scored.push({
        score: match.score,
        row: {
          key: `branch:${branch}`,
          title: branch,
          positions: match.positions,
          icon: 'branch',
          ...(isCurrent ? { badge: 'current', disabled: true } : {}),
          accept: () => {
            ui.closeOverlay();
            if (!isCurrent) void app.git.switch(branch, false);
          },
        },
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return { rows: [...rows, ...scored.map((s) => s.row)], total: 1 + scored.length };
  }
```

7. Dispatch in `result`: `if (effectiveMode === 'branches') return branchRows(term);` before the final fallthrough.

`src/ui/GitPanel.svelte` — the branch line's `onclick` becomes `() => ui.openOverlay('git-branch')` (deferred from Task 5).

- [ ] **Step 4: Run and watch pass, then commit**

```bash
npx vitest run tests/git-panel.test.ts
npm run check && npm test
git add src/services/git.ts src/services/ui.ts src/ui/Overlays.svelte src/ui/CommandPalette.svelte src/ui/GitPanel.svelte tests/git-panel.test.ts
git commit -m "Switch and create branches through the palette, prefix-free"
```

---

### Task 9: Watching `.git` — the blind spot closes

**Files:**
- Modify: `src-tauri/src/watcher.rs` (the targeted watch + its test)
- Modify: `src-tauri/src/lib.rs` (`.manage`, two handlers)
- Modify: `src/platform/types.ts` (`watchGitMeta`)
- Modify: `src/platform/tauri.ts`, `src/platform/memory.ts`
- Modify: `src/services/git.ts` (debounced wiring)
- Test: extend `tests/git-service.test.ts`

**Interfaces:**
- Consumes: `Unwatch` (types.ts:253), the `nox_watch` state pattern (watcher.rs:35-41), the `watch` listen/invoke shape (tauri.ts:152-171).
- Produces: `Platform.watchGitMeta(root: string, onChange: () => void): Promise<Unwatch>`; commands `nox_git_meta_watch`, `nox_git_meta_unwatch`; event `nox://git-meta-change`.

- [ ] **Step 1: Write the failing TypeScript test**

Append to `tests/git-service.test.ts` (fake timers already active in this suite):

```ts
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
```

The suite's `beforeEach` already runs fake timers; `platform.gitStage`/`gitCommit` called directly stand in for the terminal, because only the meta watch — not any service trigger — can carry that news back.

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run tests/git-service.test.ts`
Expected: FAIL — the status never moves (nothing watches the fake `.git`).

- [ ] **Step 3: The platform seam**

`src/platform/types.ts`, after `gitSwitch`:

```ts
  /**
   * Watch the repository metadata under `root` — `<root>/.git`'s `HEAD` and
   * `index` — calling `onChange` with no detail beyond "repository state
   * moved"; the subscriber refreshes. A fast path, not a load-bearing one:
   * the activation refetch and the palette refresh stay, because watchers
   * miss things (see the watcher service's own docs). Non-recursive on
   * purpose — a `.git` directory's object churn would flood a recursive
   * watch, which is why the workspace watcher hard-denies `.git` entirely.
   */
  watchGitMeta(root: string, onChange: () => void): Promise<Unwatch>;
```

`src/platform/memory.ts` — the model notifies; wire the no-op from Task 2:

```ts
  #gitMetaWatchers = new Set<{ root: string; onChange: () => void }>();

  async watchGitMeta(root: string, onChange: () => void): Promise<Unwatch> {
    const watcher = { root: normalize(root), onChange };
    this.#gitMetaWatchers.add(watcher);
    return () => {
      this.#gitMetaWatchers.delete(watcher);
    };
  }

  #notifyGitMeta(root: string): void {
    for (const watcher of [...this.#gitMetaWatchers]) {
      if (watcher.root === root || contains(watcher.root, root) || contains(root, watcher.root)) {
        watcher.onChange();
      }
    }
  }
```

(Replace the Task 2 no-op body. Every model write — `gitStage`, `gitUnstage`, `gitCommit`, `gitSwitch` — already calls `#notifyGitMeta`; `seedGitBase` and `seedGitRepo` deliberately do not: seeds are fixtures, not events.)

`src/platform/tauri.ts`, modelled on `watch` (tauri.ts:152):

```ts
  async watchGitMeta(root: string, onChange: () => void): Promise<Unwatch> {
    const unlisten = await listen<null>('nox://git-meta-change', () => onChange());
    try {
      await call<void>('nox_git_meta_watch', { root });
    } catch (error) {
      unlisten();
      throw error;
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      unlisten();
      void call<void>('nox_git_meta_unwatch', {}).catch(() => undefined);
    };
  }
```

- [ ] **Step 4: The Rust watcher**

In `src-tauri/src/watcher.rs`:

```rust
/// The second, targeted watch: `<root>/.git`, non-recursive, delivering
/// events only for `HEAD` and `index` (their `.lock` shadows included —
/// git writes via lock-and-rename, and which side of the rename an OS
/// reports varies). The recursive workspace watch keeps its DENY on `.git`;
/// this one exists precisely because of it. Debouncing lives in the
/// renderer's GitService, the one place that can be unit-tested.
pub struct GitMetaWatcherState(pub Mutex<Option<RecommendedWatcher>>);

impl Default for GitMetaWatcherState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

fn is_git_meta(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|n| n.to_str()),
        Some("HEAD" | "index" | "HEAD.lock" | "index.lock")
    )
}

/// Watch `<root>/.git`, replacing any previous meta watch. A `.git` that is
/// a *file* (a linked worktree) is watched as itself — a pointer change
/// still signals; the richer HEAD/index detail is out of reach there, and
/// the activation refetch remains the fallback, as §5 requires.
#[tauri::command]
pub fn nox_git_meta_watch(
    app: AppHandle,
    state: State<'_, GitMetaWatcherState>,
    root: String,
) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "io: git meta watcher lock poisoned".to_string())?;
    *guard = None;

    let target = Path::new(&root).join(".git");
    let watch_dir = target.is_dir();

    let emitter = app.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else { return };
        if classify(&event.kind).is_none() {
            return;
        }
        // For a directory watch, only HEAD/index matter; a file watch (the
        // worktree case) has exactly one path and it is always relevant.
        if watch_dir && !event.paths.iter().any(|p| is_git_meta(p)) {
            return;
        }
        let _ = emitter.emit("nox://git-meta-change", ());
    })
    .map_err(|e| format!("io: could not create git meta watcher ({e})"))?;

    watcher
        .watch(&target, RecursiveMode::NonRecursive)
        .map_err(|e| format!("io: could not watch {} ({e})", target.display()))?;

    *guard = Some(watcher);
    Ok(())
}

/// Stop the meta watch. Safe when nothing is being watched.
#[tauri::command]
pub fn nox_git_meta_unwatch(state: State<'_, GitMetaWatcherState>) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "io: git meta watcher lock poisoned".to_string())?;
    *guard = None;
    Ok(())
}
```

And a real-backend test beside `detects_a_write_through_a_real_recursive_watcher`:

```rust
    #[test]
    fn git_meta_filter_accepts_head_and_index_only() {
        assert!(is_git_meta(Path::new("/w/.git/HEAD")));
        assert!(is_git_meta(Path::new("/w/.git/index")));
        assert!(is_git_meta(Path::new("/w/.git/index.lock")));
        assert!(!is_git_meta(Path::new("/w/.git/objects/ab/cdef")));
        assert!(!is_git_meta(Path::new("/w/.git/COMMIT_EDITMSG")));
    }

    /// A real `git add` through a real non-recursive watch on `.git`:
    /// the index write must arrive, the object churn must not need to.
    #[test]
    fn detects_a_stage_through_a_real_git_meta_watcher() {
        use std::process::Command;
        use std::sync::mpsc;
        use std::time::Duration;

        let dir = std::env::temp_dir().join(format!("nox-gitmeta-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let run = |args: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"])
                .args(args)
                .output()
                .expect("git runs");
            assert!(output.status.success(), "git {args:?} failed");
        };
        run(&["init"]);
        std::fs::write(dir.join("a.txt"), "one\n").expect("write");

        let (tx, rx) = mpsc::channel::<()>();
        let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            let Ok(event) = result else { return };
            if classify(&event.kind).is_none() {
                return;
            }
            if event.paths.iter().any(|p| is_git_meta(p)) {
                let _ = tx.send(());
            }
        })
        .expect("create watcher");
        watcher
            .watch(&dir.join(".git"), RecursiveMode::NonRecursive)
            .expect("watch .git");

        run(&["add", "a.txt"]);

        let saw = rx.recv_timeout(Duration::from_secs(10)).is_ok();
        drop(watcher);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(saw, "expected a meta event for the index write");
    }
```

`src-tauri/src/lib.rs`: `.manage(watcher::GitMetaWatcherState::default())` beside the other `.manage` calls (lib.rs:46), and two handler lines after `watcher::nox_unwatch`:

```rust
            watcher::nox_git_meta_watch,
            watcher::nox_git_meta_unwatch,
```

- [ ] **Step 5: The service wiring**

In `src/services/git.ts`:

```ts
  #metaUnwatch: Unwatch | null = null;
  #metaTimer: ReturnType<typeof setTimeout> | null = null;
```

(`import type { Platform, Unwatch } from '@platform/types';`)

In `start()`, the `rootPath` subscription grows the (re)watch:

```ts
      workspace.rootPath.subscribe((root) => {
        this.#reset();
        void this.refreshStatus();
        void this.#watchMeta(root);
      }),
```

Methods:

```ts
  /**
   * The `.git` meta watch — spec §5. Debounced 300 ms (a rebase in the
   * terminal fires dozens), then status + bases. A watch that cannot be
   * established is swallowed: this is a fast path, and the activation
   * refetch and the palette refresh remain the load-bearing ones.
   */
  async #watchMeta(root: string | null): Promise<void> {
    this.#metaUnwatch?.();
    this.#metaUnwatch = null;
    if (!root) return;
    try {
      this.#metaUnwatch = await this.#platform.watchGitMeta(root, () => this.#onMetaChange());
    } catch {
      /* No watcher on this platform or this root; the slow paths remain. */
    }
  }

  #onMetaChange(): void {
    if (this.#metaTimer) clearTimeout(this.#metaTimer);
    this.#metaTimer = setTimeout(() => {
      this.#metaTimer = null;
      void this.refreshStatus();
      void this.refreshAll();
    }, DEBOUNCE_MS);
  }
```

In `dispose()`: clear `#metaTimer`, call and null `#metaUnwatch`.

- [ ] **Step 6: Run and watch pass, then commit**

```bash
npx vitest run tests/git-service.test.ts tests/git-panel.test.ts tests/git-platform.test.ts
npm run check && npm test
git add src-tauri/src/watcher.rs src-tauri/src/lib.rs src/platform src/services/git.ts tests/git-service.test.ts
git commit -m "Watch .git's HEAD and index, debounced: the blind spot closes"
```

State in the report that the two new Rust tests are unrun locally (CI runs them), unless a local cargo exists and was run.

---

### Task 10: Documentation

**Files:**
- Modify: `ROADMAP.md` (mark **Stage, commit, branch** shipped in the v0.5 table, line 116, in the ✅-plus-summary form its neighbours use)
- Modify: `ARCHITECTURE.md` (module map: `core/git-status.ts`, the grown `git.rs` and `watcher.rs`; state the envelope's headline once — argv-fixed commands only, no generic git seam, refusals verbatim — the non-obvious constraint a future reader would otherwise undo)
- Modify: `CHANGELOG.md` (an Unreleased entry)
- Modify: `WORKLOG.md` (a new entry on top, in the established Shipped / Verified / Next / Blocked / Confidence shape; note that the status-bar branch indicator is now a five-line follow-up on `GitService.status`, deliberately not taken here)

- [ ] **Step 1: Write the four updates.** Each is prose; match the neighbouring entries' voice and density. Record the mutation checks the previous rows recorded in docblocks (spec §6: "Mutation checks recorded in docblocks, as the previous two rows did") — during executor verification, break one load-bearing line per area (the parser's rename consumption, the service's queued-refresh flag, the fake's switch refusal) and confirm a test goes red, then note it in the relevant docblock.

- [ ] **Step 2: Verify and commit**

```bash
npm run check && npm test
git add ROADMAP.md ARCHITECTURE.md CHANGELOG.md WORKLOG.md
git commit -m "Write down the stage/commit row"
```

---

## Done when

- `npm test` passes with every new suite included, and the count is stated (baseline was 1257 / 76 files).
- `npm run check` reports 0 errors (baseline 455 files).
- The Rust tests are committed and — unless a local cargo ran them — **declared unrun locally**; CI is the first thing to execute them.
- Every mutation in the app refreshes status + gutter base (envelope §6), verified by the stage/commit/switch panel tests.
- Nothing is pushed, no PR is opened, nothing outside the worktree is touched.

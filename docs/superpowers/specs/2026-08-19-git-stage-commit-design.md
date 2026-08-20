# Stage, commit, branch — design

The third row of v0.5: a focused panel, not a full git client. This is
the first feature whose git commands **change repository state**, so the
spec leads with what it will never do, and the build waits for a human
read of exactly that section.

Status: proposed 2026-08-19, **not yet built**. Everything named here was
read in the file it names before being written down.

## 0. The envelope — read this section first

Every command this feature adds is argv-fixed in Rust: a specific
`nox_git_*` function running `git` with a hard-coded argument shape,
`--literal-pathspecs`, no shell anywhere, `-C <workspace repo root>` only.
There is no generic "run git" seam, and adding one later should read as
the alarm it is. Within that:

1. **Nothing leaves the machine.** No push, pull, or fetch. Remotes mean
   credentials and networks; this row is local state only. (Later row,
   its own spec, its own read.)
2. **Nothing rewrites history.** No amend, no rebase, no reset below
   `--mixed`-on-nothing (see unstage), no force-anything. A commit only
   ever adds one.
3. **Nothing destroys working-tree work.** No discard, no
   `checkout -- <file>`, no stash. The README's first promise is *"It
   does not lose your work. Ever."* — and `git checkout -- file` is the
   canonical way to lose it. Discard arrives only if it ever gets a
   recovery story (the trash-not-delete shape), as its own decision.
4. **Git's refusals are surfaced, never overridden.** A branch switch
   with conflicting dirty files fails with git's own words; we do not
   pass `-f`. A commit with nothing staged, or no identity configured,
   fails with git's own words. The error convention of `fs.rs` carries
   the message; the panel shows it verbatim — the rename pattern: the
   one who knows why gets to say it.
5. **Commit commits the index.** Never `-a`, never pathspecs on commit.
   What you staged is what lands, and the staged list on screen *is* the
   commit preview.
6. **Every mutation refreshes.** Each `nox_git_*` write is followed by a
   status + gutter-base refresh, so the panel never shows a state its own
   action made stale.

## 1. What it is

A **Git** sidebar view (rail entry beside Problems and References):

- **Branch line**: current branch (or "detached at abc1234"); click for
  a picker of local branches (the palette component, prefix-free) with
  "Create branch…" at the top. Switch = `git switch <name>`; create =
  `git switch -c <name>`. Both subject to envelope §4.
- **Changes list**, two sections mirroring `git status`:
  - **Staged** — files in the index that differ from HEAD; each row has
    an unstage button (−).
  - **Changes** — working-tree modifications and untracked files; each
    row has a stage button (+). Untracked files are labelled `U`, so
    staging one is visibly "start tracking this".
  - Row click opens the file; the diff view remains the place to *look*
    at a change (a "view" affordance per row opens Show Changes for it).
  - Status letters follow porcelain (`M`, `A`, `D`, `R`, `U`), rendered
    with the tokens the gutter already uses.
- **Commit box**: a message field and one Commit button, enabled only
  when the staged list is non-empty and the message is non-blank. On
  success the box clears and a notification names the short hash and
  subject. Multi-line messages allowed (first line = subject); no
  templates, no hooks UI — hooks run because git runs them, and a hook
  failure is envelope §4.

Deliberately absent, beyond the envelope: file history, log browsing,
merge/rebase UI, stashes, tags, submodule anything. The panel answers
"what is my working state, and how do I turn it into a commit" — nothing
else.

**Hunk staging** (stage part of a file) is phase 2 of this row, not v1:
it reuses the diff view's paired rows with a per-hunk stage button, and
lands through `git apply --cached` of a computed patch — the one place
this feature constructs input for git rather than naming files. It is
separated precisely because patch construction deserves its own tests
and its own read of this section.

## 2. The Rust commands — `src-tauri/src/git.rs` grows

All follow the existing module's conventions (String errors in the
`"<code>: <message>"` shape, `CREATE_NO_WINDOW`, direct spawn, no shell).
Reads return data; writes return `Result<()>` or a small DTO, with
**git's stderr as the error message** when the exit is non-zero — unlike
`nox_git_file_base`, where every failure is an honest `None`, a failed
*write* must say why.

Read:

- `nox_git_status(root) -> Result<String>` — `git status
  --porcelain=v2 --branch -z`, raw output; parsing lives in TypeScript
  where it is testable without a repo. `-z` because filenames contain
  anything; porcelain v2 because it carries branch info and rename
  detail in one call.
- `nox_git_branches(root) -> Result<String>` — `git branch
  --list --format=%(refname:short)`, raw.

Write (each: argv above, nothing interpolated except validated values):

- `nox_git_stage(root, paths: Vec<String>) -> Result<()>` —
  `git add --literal-pathspecs -- <paths…>`. Relative paths, computed by
  the same canonicalize-and-strip route `nox_git_file_base` uses.
- `nox_git_unstage(root, paths: Vec<String>) -> Result<()>` —
  `git restore --staged --literal-pathspecs -- <paths…>`. Touches the
  index only; the working tree is untouchable by construction of the
  command chosen (this is why it is `restore --staged` and not `reset`).
- `nox_git_commit(root, message) -> Result<String>` — `git commit
  --file=-` with the message on stdin (never argv: messages contain
  quotes, dashes, anything), returning `git log -1 --format=%h %s` on
  success. Respects the user's own signing/hook configuration; failures
  surface verbatim (envelope §4).
- `nox_git_switch(root, name, create: bool) -> Result<()>` —
  `git switch <name>` / `git switch -c <name>`. `name` validated first
  with `git check-ref-format --branch <name>` (a read), so the only
  strings reaching the write are ones git itself blessed.

Rust tests extend the existing real-repo suite: stage/unstage round-trip
visible in `status --porcelain`, commit creates exactly one commit with
the exact multi-line message (quotes and `--` included, via stdin),
commit with nothing staged fails with git's message, switch refuses on a
conflicting dirty file and the working tree is byte-identical after,
created branch appears in the list, invalid branch name is refused by
the validation read before any write runs.

## 3. Platform

Six explicit methods (the boundary's style — thin, named, no generic
exec), gated by the existing `capabilities.gitState`:

```ts
gitStatus(root: string): Promise<string>;
gitBranches(root: string): Promise<string>;
gitStage(root: string, paths: string[]): Promise<void>;
gitUnstage(root: string, paths: string[]): Promise<void>;
gitCommit(root: string, message: string): Promise<string>;
gitSwitch(root: string, name: string, create: boolean): Promise<void>;
```

`MemoryPlatform` grows a **small honest model**, not scripted replies: a
per-root fake repo holding `head: Map<path, text>`, `index: Map<path,
text>`, a commit list, and a branch set, whose six methods behave like
git's (stage copies working text into the index; commit snapshots the
index and refuses when clean or when the message is blank; switch
refuses when a dirty file differs from the target — the refusal text
matching git's shape, asserted against the real git in the Rust tests so
fake and real cannot drift silently). `seedGitBase` is re-expressed on
top of it. This is more work than stubs and is the point: the service
tests then exercise real sequences, not choreography.

## 4. The service — `GitService` grows

- `status: Signal<GitStatus | null>` where `GitStatus = { branch,
  detached, staged: FileEntry[], unstaged: FileEntry[] }`, parsed by a
  pure `src/core/git-status.ts` (porcelain v2 is a line format with
  documented fields — pure parsing, node-tested against captured real
  output, including renames and a `-z` name with a newline in it).
- Refresh triggers: everything that already refetches bases, plus after
  every write this service performs. One in-flight refresh at a time;
  a second request queues one more, not N.
- Writes: `stage(paths)`, `unstage(paths)`, `commit(message)`,
  `switch(name, create)` — thin, each ending in `refreshStatus()` +
  `refreshAll()` (bases move when the index moves; the gutter and the
  diff view follow automatically through signals that already exist).
- Failures become notifications carrying git's message, and the panel
  stays on the state before the attempt (the refresh shows the truth
  either way).

## 5. Watching `.git` — the blind spot closes here

The gutter and diff view deferred it; this row needs it (a commit made
in the terminal must move the panel, not just the next activation). The
Rust watcher keeps its `DENY` for the recursive workspace watch — a
`.git` directory's object churn would flood it — and gains a **second,
targeted, non-recursive watch** on `<root>/.git` delivering events only
for `HEAD` and `index`:

- Platform: `watchGitMeta(root, onChange): Promise<Unwatch>` — no event
  detail, just "repository state moved"; the subscriber refreshes.
- Service: debounced 300 ms (a rebase in the terminal fires dozens),
  then `refreshStatus()` + `refreshAll()`.
- The activation refetch and the palette refresh stay — a watcher is a
  fast path, not a load-bearing one (its own doc says external editors
  can substitute writes in ways watchers miss).

## 6. What is tested, and how

- `tests/git-status.test.ts` (node): the porcelain v2 parser, against
  captured real output fixtures.
- `tests/git-panel.test.ts` (jsdom): real app over the MemoryPlatform
  model — stage moves a row between sections and the gutter's base
  follows; unstage returns it; commit clears the staged list, the box,
  and bumps the model's log; commit disabled on empty stage/blank
  message; a refused switch leaves the panel unchanged and shows git's
  words; branch create + switch updates the branch line; untracked
  labelled U.
- Rust: §2's list, real repos, three platforms.
- Mutation checks recorded in docblocks, as the previous two rows did.

## 7. Build order (each step shippable)

1. `git-status.ts` parser + `nox_git_status`/`gitStatus` + read-only
   panel (status + branch line).
2. Stage/unstage.
3. Commit.
4. Branch picker (switch/create).
5. `.git` meta-watch.
6. *(Phase 2, separate PR and read)* hunk staging via the diff view.

## 8. Not in this

Push/pull/fetch (remotes row, later, own envelope). Discard/stash (needs
a recovery story first — README §"It does not lose your work"). Amend,
rebase, cherry-pick, tags, log/history browsing, submodules, worktrees.
Hooks UI (hooks still run — git runs them). Multi-repo workspaces: one
root, one repo, like every git feature so far.

# Git gutter — design

Added / modified / removed marks per line, against what git has for the
file. The first row of v0.5, and the first git wiring in the codebase.

Status: decided 2026-08-19. Everything named here was read in the file it
names (or mapped by an agent and re-checked) before being written down.

## 1. What it is

A colored bar per changed line in a gutter beside the fold gutter: green
for a line git does not have, amber for a line git has differently, a red
marker where lines git has are gone. The base of the comparison is **the
index** (`:0:` — what `git add` would leave alone), because the gutter's
question is "what have I changed that git doesn't hold yet", and for
anyone not mid-staging the index is HEAD anyway.

The gutter is presence, not a diff view. Clicking it does nothing yet; the
diff view is the next row and will own that.

## 2. The one Rust command

`src-tauri/src/git.rs`, registered in `lib.rs` — the codebase's first
one-shot process capture (`Command::output()`); everything before it is a
long-lived child or fire-and-forget.

```rust
#[tauri::command]
pub fn nox_git_file_base(path: String) -> Result<Option<String>>
```

- `git -C <parent> rev-parse --show-toplevel` finds the repo root; then
  `git -C <root> --literal-pathspecs show :0:<relpath>`, with `<relpath>`
  forward-slashed (git speaks `/` on Windows too; `--show-toplevel` prints
  it that way).
- **`None` is the answer to everything that isn't content**: no repo,
  untracked file, git not installed, non-UTF-8 blob. A missing gutter is
  the correct degraded state, and no failure here may become a dialog.
  `Err` is reserved for what the convention reserves it for and is not
  expected in practice.
- `#[cfg(windows)] creation_flags(CREATE_NO_WINDOW)`, as `lsp.rs` does —
  `git.exe` is console-subsystem and would flash a window without it. The
  direct-spawn path only; no `cmd /C` fallback (git is a real `.exe`, and
  the shell route re-splits paths with spaces).
- No timeout on `output()`. `git show` on a local repo does not hang in
  practice; if it ever does, the cost is a gutter that never arrives —
  never a blocked save or keystroke, because every caller is async and
  nothing awaits this on a critical path. Accepted and named.
- Inline `#[cfg(test)]` tests against a real temp repo (`git init` +
  commit in a `Scratch` dir): staged content comes back, an untracked file
  is `None`, a path outside any repo is `None`. CI runners all carry git;
  this PC carries no cargo, so **CI is where this module first compiles**
  — the tests are written to fail loudly there, not to be skipped.

## 3. Platform

- `PlatformCapabilities.gitState: boolean` — true on Tauri, false in
  `memory.ts` and `web.ts` (four literals, the compiler holds them
  together).
- `Platform.gitFileBase(path: string): Promise<string | null>` — one-line
  adapter in `tauri.ts` through `call()`. `MemoryPlatform` implements it
  honestly as a lookup into a seedable map (`seedGitBase(path, text)`),
  returning null for anything unseeded — a KV read is a legitimate fake,
  unlike a process spawn; the capability flag still says the *product*
  feature is absent in the browser, exactly as `languageServers` does
  while `languageServerFactory` exists for tests.

## 4. The service — `src/services/git.ts`

`GitService`, diagnostics-shaped:

- `hunks: Signal<ReadonlyMap<BufferId, { hunks: Hunk[]; revision: number }>>`
  — copy-on-write, key deleted when a buffer closes or has no changes.
- Base cache: `#bases: Map<path, string | null>`, filled by
  `platform.gitFileBase` and **normalized like `decode` normalizes a
  buffer** — BOM off, CRLF → LF — because the editor's document is always
  canonical LF and a CRLF repo would otherwise show every line modified.
- Recompute = `diffText(base, workspace.textOf(id))` → the signal. Skipped
  (key deleted, marked unavailable) when either side exceeds **2 MB**:
  `diffText`'s Myers trace is O(D·(N+M)) memory and a wholesale rewrite of
  a huge file is exactly the case that hits it.
- Triggers:
  - `workspace.buffers` with a per-buffer 300 ms trailing debounce, the
    `documents.ts` mechanism, **text and revision read at fire time**;
  - `buffer-opened` → fetch base, compute;
  - `saved`, `buffer-reset`, `external-change` → refetch base, recompute;
  - buffer activation (`activeId`) → refetch that buffer's base, throttled
    to once per 2 s per path — this is what catches "committed in the
    terminal, tabbed back";
  - `buffer-closed` → drop both entries; `rootPath` change → drop all.
- **The `.git` blind spot, named**: the watcher hard-denies `.git`
  (`watcher.rs DENY`), so a commit, stage, or branch switch emits no event.
  A checkout that rewrites working files does emit, and is covered. For
  the rest, the activation refetch above plus **Refresh Git Gutter**
  (`git.refreshGutter`, palette-only) are the answer; watching
  `.git/HEAD` + `.git/index` needs new Rust plumbing and belongs to the
  stage/commit row, which will need it anyway.
- Started by the app only when `capabilities.gitState` holds; tests
  construct and start it directly over `MemoryPlatform`, the LSP pattern.

## 5. The pure core — `src/core/git-gutter.ts`

```ts
export type GutterLineKind = 'added' | 'modified' | 'removed';
export interface GutterLine { line: number; kind: GutterLineKind } // line 1-based, current text
export function gutterLines(hunks: readonly Hunk[]): GutterLine[]
export function normalizeGitBase(text: string): string
```

`Hunk.fromLine` is 0-based **in the before text**; the gutter draws on the
current text, so `gutterLines` walks hunks carrying the cumulative
`added − removed` offset of the hunks before each one:

- both sides present → `modified` on the `added.length` current lines from
  the hunk's current-space start;
- added only → `added`, same lines;
- removed only → one `removed` mark on the current line *after* the
  deletion point (clamped to the last line when the tail was deleted) —
  the mark says "something is gone here", and between-line rendering is
  not a thing a line gutter has;
- a line claimed twice (a removal landing on a modified line) keeps the
  stronger claim: `modified` > `added` > `removed` never actually competes
  except removal-onto-other, where the other wins and the removal is
  still visible because the *bar* differs from a plain line anyway — the
  rule is: existing kind wins over `removed`.

Pure, node-tested, no imports beyond `diff.ts` types.

## 6. The editor extension — `src/editor/git-gutter.ts`

The provenance shape, as a sibling and not an extension of it:

- `setGitGutter: StateEffect<GutterLine[]>`; a `StateField<RangeSet>` of
  line-anchored markers that **maps through `tr.changes`** (so marks track
  keystrokes between debounce ticks) and is replaced wholesale when the
  effect arrives.
- The field is static (in `staticExtensions()` — removing a StateField
  destroys its state, the `extensions.ts` comment); the `gutter()`
  rendering sits in a new `gitGutter` settings compartment gated by
  **`editor.gitGutter`** (`bool(true)`, category Editor, "Git Gutter" —
  "Mark lines that differ from what git has for the file.").
- `lineMarkerChange` compares the field between states — the
  effect-with-no-doc-change repaint trap `provenance.ts:365` names.
- Theme: `.cm-gitGutter` in `theme.ts` beside the provenance block — 3px
  gutter, 2px full-height bar; `--nox-success` added, `--nox-warning`
  modified, `--nox-danger` removed (rendered as a short thick mark, not a
  bar, so a removal reads as a point, not a range).

Pane wiring in `EditorPane.svelte`: subscribe `git.hunks` beside
`lsp.diagnostics`, paint keyed off `currentId` (the wrong-buffer trap the
pane documents), repaint after `syncToBuffer`'s `setState`.

## 7. What is tested, and how

- `tests/git-gutter.test.ts` (node): `gutterLines` — added/modified/
  removed classification, the cumulative offset with multiple hunks, the
  deletion-at-EOF clamp, the collision rule, empty in/out;
  `normalizeGitBase` — BOM, CRLF, both, neither.
- `tests/git-service.test.ts` (node, MemoryPlatform + real workspace):
  open a seeded file with a seeded base → hunks appear with the buffer's
  revision; typing (applyTransaction) → recompute after the debounce
  (fake timers); save → base refetched; unseeded path → no entry;
  buffer close → entry dropped; >2 MB base → no entry; CRLF base against
  the LF buffer → no phantom all-modified hunks.
- `tests/git-gutter-render.test.ts` (jsdom, real pane): dispatching the
  effect paints bars with the right classes on the right lines; a
  keystroke shifts them; the setting off removes the gutter; the
  provenance gutter is untouched.
- `src-tauri/src/git.rs` `#[cfg(test)]`: §2. Runs on all three CI
  platforms; the Windows leg is the one that proves `CREATE_NO_WINDOW`
  compiles and relpath slashing holds.

## 8. Not in this

- Click-to-diff, hunk revert, staging — the diff view and stage/commit
  rows.
- Watching `.git` (stage/commit row, with its Rust plumbing).
- A branch/status indicator in the status bar — cheap later, not now.
- Blame.

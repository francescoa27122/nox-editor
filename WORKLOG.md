# Work log

State between sessions. Newest entry on top, roughly ten kept.

Durable knowledge — decisions, gotchas, the reasons behind a design — belongs
in `docs/superpowers/specs/` and in commit messages. **This file is state; those
are knowledge.**

---

## 2026-08-19 (PC, later) — Diff view

On branch `git-diff-view`, off `main` at `d888bbd`. Design in
`docs/superpowers/specs/2026-08-19-git-diff-view-design.md`. Same split as
the gutter: one Explore agent mapped ReviewPanel/editor-area conventions,
one build agent wrote the pure row model, I built the surface.

Shipped:

- `src/core/diff-view.ts` (agent-built, 17 tests): one paired-row model —
  context / paired change rows / folds with counts — serving both layouts;
  after-side numbers by running offset; folds only when at least 2 lines
  hide; the change-rows-separated invariant the inline regrouping leans on.
- `src/ui/DiffView.svelte` — **Show Changes**: side-by-side and inline
  (regrouped from the same rows, no second differ), layout toggle writing
  `workbench.diffLayout` (new setting), fold click = expand all, honest
  empty states (no file / untitled / asking git / no base / too large /
  no changes). Read-only on purpose.
- `ui.diffOpen`, layered **below** review and agents: staging over an open
  diff shows the review, Escape uncovers the diff. Survives tab switches —
  the deliberate deviation from review/agents, which close on activeId.
- `GitService.baseFor(path)` plus a `baseRevision` signal (a clean file's
  base arrival is otherwise invisible — hunks stay silent when nothing
  changed); the bump is pinned at the service after a survived mutation
  showed the folder-open reset was masking it in the UI test.
- `onGitGutterClick` facet: gutter mousedown opens Show Changes. The first
  draft used pane-level `EditorView.domEventHandlers` and never fired —
  those listen on the content element and gutters are siblings; the jsdom
  suite caught it, plus the pre-existing jsdom `Range.getClientRects` gap
  the gutter's measure path trips (installRangeRects, as lsp-format does).
- `git.showDiff` and `git.refreshGutter` both category **Git**; enabled on
  `git.started` (the service, not the capability — the LSP pattern; the
  capability gate was untestable and wrong for the same reason).

Verified:

- `npm test` 1224/1224, 71 files (+17 core, +10 view, +1 service).
  `npm run check` 447 files 0 errors 0 warnings. Build green. Browser
  build boots with all five gutters registered, no console errors.
- Mutations: core x2 (agent's own), view x5 — two survivors did real
  work: the gutter-click one exposed the sibling-element bug above, and
  the baseRevision one exposed that the UI test was passing because of
  the folder-open reset bump (now isolated at the service and red under
  mutation).
- NOT verified on a screen: everything (jsdom only). The desktop-pass
  checklist now carries the gutter and this view.

Next:

- **Stage, commit, branch** (v0.5 row 3): a focused panel. Wants the
  `.git` watching the gutter deferred, hunk staging with the revert/stage
  confirmation shape, and the first write-path git commands — a real
  capability step, so the spec comes first and should be short-listed for
  a human read before building.

Blocked:

- Nothing technical.

Confidence:

- High on the row model and the surface (mutation-checked); medium on the
  visuals until a human sees them.

---

## 2026-08-19 (PC, v0.5 begins) — Git gutter

On branch `git-gutter`, off `main` at `1000921`. Design in
`docs/superpowers/specs/2026-08-19-git-gutter-design.md`. Built with three
Explore agents mapping the seams in parallel, then two build agents
(`git.rs`, the pure core) alongside my own middle layer — the first
multi-agent feature in this repo, and the split held: no file conflicts.

Shipped:

- `src-tauri/src/git.rs` — `nox_git_file_base(path)`: repo root via
  `rev-parse --show-toplevel`, index content via `--literal-pathspecs show
  :0:<relpath>`, `CREATE_NO_WINDOW` on Windows, **None for everything that
  is not content** (no repo / untracked / no git / binary). The codebase's
  first `Command::output()` capture. Inline tests against a real temp repo
  (staged-vs-working divergence, untracked, no-repo, subdirectory).
  **Reviewed by eye, never compiled here — no cargo on this PC; CI is
  where it first builds.** My review caught one real hazard in the agent's
  draft: the textual repo-root prefix match breaks under macOS's
  `/var → /private/var` symlink and Windows runners' 8.3 short paths;
  fixed by canonicalizing the file and stripping the `\?\` prefix.
- Platform: `capabilities.gitState` (4 literals) + `gitFileBase(path)`;
  MemoryPlatform fakes it as a seedable lookup (`seedGitBase`).
- `src/core/git-gutter.ts` (agent-built, mutation-checked by its builder):
  `gutterLines(hunks)` maps before-space hunks to current-space 1-based
  marks with cumulative offsets; `normalizeGitBase` mirrors `decode`
  (BOM/CRLF), else a CRLF repo marks every line.
- `src/services/git.ts` — per-buffer hunks signal, 300 ms per-buffer
  debounce off `workspace.buffers`, base refetch on open/save/reset/
  external-change/activation (2 s throttle)/`refreshAll`, 2 MB size guard.
- `src/editor/git-gutter.ts` + wiring: StateField (static — survives the
  settings toggle) mapping marks through keystrokes; gutter rendering in a
  `gitGutter` compartment behind **`editor.gitGutter`** (on by default);
  theme bars green/amber + red deletion tick; pane paints keyed off
  `currentId` and after every state swap.
- `git.refreshGutter` — **Refresh Git Gutter**, palette-only.
- CHANGELOG `[Unreleased]`, ROADMAP row ✅.

Verified:

- `npm test` 1196/1196, 69 files (was 1162/66: +20 core, +8 service,
  +6 render). `npm run check` 443 files 0 errors. Build green.
- Mutations seen red: core offset (agent's own), service ×5 (normalize,
  debounce, close-drop, size guard, save-refetch), render ×4 — including
  one that **survived and taught something**: removing the repaint after
  the state swap passed the original swap test because marks persist in
  each buffer's own EditorState; the killer is hunks that change while
  the buffer is in the background (stage in terminal, swap back), and
  that test now exists.
- NOT verified: the Rust module has never compiled (no cargo here) and no
  real repo has been diffed end-to-end — MemoryPlatform seeds stand in.
  CI's three-platform `cargo test` is the compile and the real-git proof;
  the desktop pass sees the pixels.

Done after this entry was first written: PR #45 CI green on the first
compile — all three platforms, real-git tests included — and merged.

Next:

- (was: push and watch CI — no iteration was needed).
  Then the **diff view** (v0.5 row 2): the hunk-review panel and line diff
  already exist; it is git wiring plus a second layout.
- The v0.4.3 desktop pass on the MacBook still stands, now with the gutter
  added to the checklist.

Blocked:

- Nothing technical.

Confidence:

- High on the TS layers (mutation-checked locally). Medium on git.rs until
  CI compiles it — the risk is concentrated in the `#[cfg(windows)]` lines
  and path canonicalization, and the tests there are the ones that would
  catch it.

---

## 2026-08-19 (PC, release) — Cut v0.4.3

On branch `release-0.4.3`, off `main` at `f3de46c`. The section this tags:
find references, the definitions list, rename symbol, Format Document and
Format on Save — the release whose point is that language intelligence is
finished.

Shipped:

- The three version files (`package.json`, `src-tauri/tauri.conf.json`,
  `src-tauri/Cargo.toml`) and both lockfiles at 0.4.3. `Cargo.lock` edited
  by hand — the `nox` entry's version line only — because this PC has no
  Rust toolchain; the gate job cross-checks all three and the Rust CI job
  builds with the lockfile, so a hand edit that lied would fail there.
- CHANGELOG: `[Unreleased]` → `[0.4.3] — 2026-08-19`, compare links.
- README: 1092 → 1162 tests; the status paragraph now says language
  servers *finished* in 0.4.3 and names all seven surfaces.

Verified:

- `npm test` 1162/1162 (66 files), `npm run check` 437 files 0 errors,
  `npm run build` green, versions agree (checked with the gate's own
  commands locally).

Done after the entry above was first written: #44 merged (`87d4d48`),
tag `v0.4.3` pushed, Release run 32312237740 green on all four builders —
**draft release up with all seven installers.**

Next:

- The thing this tag exists for: **the desktop pass** — references list,
  definitions list, rename prompt + review, Shift+Alt+F, format-on-save,
  F12 / Shift+F12 / F2 on a real keyboard — recorded here. The MacBook has
  the toolchain; `git pull`, install the dmg from the draft (or
  `npm run app`), ten minutes. Then publish (human), and Git gutter starts.
- The **v0.4.2 draft** is superseded; delete it rather than publish both
  (Francesco's call).

Blocked:

- Publishing the release is his; the tag build was not, and is done.

Confidence:

- High; the release procedure was re-derived from 8b622d3 and the gate
  re-run locally.

---

## 2026-08-19 (PC, night) — Formatting: on demand and on save

On branch `lsp-format`, stacked on `lsp-rename` (#42). Design in
`docs/superpowers/specs/2026-08-19-lsp-format-design.md`. The LSP half of
the roadmap row; the external-command half is deliberately a separate row
(spec §1) — **scope narrowed on purpose, say so**: a formatter binary wants
a process seam and a per-language table, neither of which belongs inside a
save path.

Shipped:

- `src/core/lsp-text-edit.ts` — `TextEdit`, `textEditsOf`, `changesOf`;
  the reading rename had privately, moved out so rename and formatting
  share one. `lsp-rename.ts` and `#renameSymbol` now use it.
- `NoxApp.formatBuffer(id, { timeoutMs? })` → `formatted | unchanged |
  unavailable | stale | failed | timeout`. `textDocument/formatting` with
  `editor.tabSize` / `editor.insertSpaces`; applied via `workspace.apply`
  with `baseRevisions`, so one undo takes it back and a keystroke during the
  request is refused, not formatted over. The timeout race lives **inside**,
  before the apply, so a late answer is never applied.
- `lsp.formatDocument` — **Format Document**, `Shift+Alt+F`, enabled on
  `documentFormattingProvider`. Reports `failed` and `unavailable`; says
  nothing otherwise.
- `files.formatOnSave` (bool, off) and `#formatBeforeSave` in `save` and
  `saveAs`: skipped when off or under `afterDelay` autosave; 2 s bound;
  timeout/failed → saved anyway with a warning; stale → saved as typed,
  silently. **The save always happens.**
- `tests/support/fake-lsp-process.ts` awaits a handler that returns a
  promise — "answers late / never" is now stageable.
- CHANGELOG `[Unreleased]`, ROADMAP row ✅ (LSP half), README.

Verified:

- `npm test` — 1162 passed, 66 files (was 1144/64). `npm run check` — 437
  files, 0 errors. `npm run build` green.
- `tests/lsp-text-edit.test.ts` (6), `tests/lsp-format.test.ts` (jsdom, 11:
  real pane, real save path, in-memory disk read back). Six mutations seen
  red: options not from config; `#formatBeforeSave` not awaited; setting
  unchecked; autosave unchecked; `baseRevisions` dropped; the race removed.
  **The late-answer test caught the first design**: racing the whole
  `formatBuffer` from the save path and checking a flag afterwards let the
  edit land before the flag was read, so the buffer went dirty right after
  the save. The race moved inside, before the apply; the spec was rewritten
  to match.
- Real `typescript-language-server`: advertises formatting; its edits turn
  `const  x=1` / `let   y = 2` into `const x = 1` / `let y = 2` (it does
  not add semicolons). Asserted.
- Browser build: *Format on Save* in Settings with its description;
  "Language: Format Document Alt+Shift+F" in the palette; no console
  errors. The format itself needs a server, so: seen in jsdom, not on a
  screen.

Next:

- **A tag build.** Five LSP surfaces since 0.4.2 — references, the
  definitions list, rename, format, format-on-save — none seen on a
  display. `v0.4.3` and ten minutes with the desktop app before Git
  starts.
- Then the v0.5 table: Git gutter first.

Blocked:

- Nothing technical.

Confidence:

- High on the save invariant — it is the thing the suite tries hardest to
  break, and the one mutation that survived the first draft was the one
  that mattered.
- Medium on the 2 s bound as a number: it is a guess at "fast enough not
  to notice, slow enough for tsserver on a big file". Tune from use.

---

## 2026-08-19 (PC, evening) — Rename symbol

On branch `lsp-rename`, off `main` at `cfe3db4` (#39, #40, #41 merged).
Design in `docs/superpowers/specs/2026-08-19-lsp-rename-design.md`.

Shipped:

- `src/core/lsp-rename.ts` — `renameEdits(WorkspaceEdit)` reads `changes`
  or `documentChanges` (the latter wins when both are present), merges
  entries per URI, drops malformed edits, and lists resource operations as
  `unsupported`; `prepareRenameSeed` reduces the four prepare shapes to a
  prompt seed or null.
- `lsp.renameSymbol` — **Rename Symbol**, `F2`, category Language, enabled
  on `renameProvider`. `prepareRename` first when offered (null → "Nothing
  to rename here", no prompt); the prompt is seeded from the
  placeholder / range / word; the rename is sent with `newName`; every
  touched file is opened (one unopenable file stops the whole rename before
  anything is staged; a resource op refuses it whole); the edits are
  converted against each buffer's current text and staged as **one change
  set** through `review.stage`, so the review panel shows every hunk and
  `review.apply` lands it as one transaction — one undo across all files,
  stale buffers refused. The file the command was run from is made active
  again afterwards, since opening activates. Applied buffers stay dirty,
  by design (spec §4).
- `session.ts` now declares `textDocument.rename.prepareSupport: true` —
  without it tsserver advertises `renameProvider: true` and the prepare
  path would never have fired against the server the feature was built for.
  Found by the integration test, which asserts the shape it now sends: a
  bare `Range`, no placeholder.
- CHANGELOG `[Unreleased]`, ROADMAP row ✅, README's "not there yet".

Verified:

- `npm test` — 1144 passed, 64 files (was 1119/62). `npm run check` — 434
  files, 0 errors. `npm run build` green.
- `tests/lsp-rename.test.ts` (node, 10), `tests/lsp-rename-symbol.test.ts`
  (jsdom, 14: real pane, real review service, prompt resolved through
  `ui.prompt`). Mutations seen red: prepare skipped, `unsupported` check
  removed, rename sent on cancel, `setActive` not restored, unopenable file
  `continue`d instead of stopping. **One mutation survived and changed the
  code**: dropping the `baseRevisions` the command passed to `stage` changed
  nothing, because `ReviewService.stage` records revisions itself and
  `apply` refuses a moved buffer. The dead argument was removed and the
  stale test now documents whose guard it is.
- Against the real `typescript-language-server`: `renameProvider` is
  `{ prepareProvider: true }` once asked, `prepareRename` returns the
  identifier's range, `rename` returns a `WorkspaceEdit` editing 0:6-12 and
  1:15-21 to `result`. Asserted.
- Browser build: "Language: Rename Symbol F2" in the palette (disabled,
  rightly — no server there), no console errors. The prompt, the review
  panel full of a rename, and F2 on a keyboard: not seen on a screen. Same
  gap as the rest of the LSP surfaces; a desktop build closes it.

Next:

- **Formatting on save** — the last v0.4 row before Git on the 1.0 order.
  `textDocument/formatting` → `TextEdit[]` → one change set applied before
  the write; a configured external command as the alternative the row
  names. Decide whether it goes through review (no — a format is not a
  proposal) and how `documents.ts`'s didSave interacts.
- A tag build (`v0.4.3`?) so the four LSP surfaces since 0.4.2 are seen on
  a screen before anything else stacks on them.

Blocked:

- Nothing technical.

Confidence:

- High on the wire, the normaliser and the review path; the real server
  agreed and each claim was mutation-checked.
- Medium on the prompt ergonomics (seed selected whole, validation text) —
  unseen.

---

## 2026-08-19 (PC, later) — Find references

On branch `lsp-references`, stacked on `v1-bar` (#39) — it continues that
branch's WORKLOG entry, so merge #39 first. Design in
`docs/superpowers/specs/2026-08-19-lsp-references-design.md`.

Shipped:

- `src/core/lsp-references.ts` — `referenceTargets` (the definition
  normaliser under the name of the question asked; `Location[] | null` is a
  subset of what it reads) and `locationRows(locations, texts, root)`: file
  rows over location rows, files by label, locations by position, the
  location row's label the trimmed line text, a non-file URI dropped.
- `NoxApp.locations: Signal<LocationList | null>` and
  `showLocations(title, subject, locations)` — reads each file's text once
  (open buffer from the workspace, otherwise `platform.readTextFile`, a
  failure becoming an empty line), builds the rows, shows the view.
- `lsp.findReferences` — **Find References**, `Shift+F12`, category
  Language, enabled on `referencesProvider`. Sends
  `context: { includeDeclaration: true }`. Empty → "No references found"
  and the previous list is left alone. The cursor does **not** move.
- `references.focus` — **Show References**, reopens the view without
  re-asking.
- `src/ui/ReferencesPanel.svelte`, the `references` sidebar view (rail icon
  `search`), rows/focused keyboard shape copied from `ProblemsPanel`; a
  location row lands through `revealLocation`, a file row opens the file.
- `lsp.goToDefinition` with several results now reveals the first **and**
  lists them all as "Definitions" in the same view; the "went to the first"
  notification is gone.
- CHANGELOG `[Unreleased]`, the ROADMAP row, README's "not there yet".

Verified:

- `npm test` — 1119 passed, 62 files (was 1095/60). `npm run check` — 431
  files, 0 errors. `npm run build` green.
- `tests/lsp-references.test.ts` (node, 11) and
  `tests/lsp-find-references.test.ts` (jsdom, 11: real pane + real
  `ReferencesPanel` over one app + fake server). Five mutations recorded in
  the docblock, each seen red: `includeDeclaration` dropped, `showView`
  removed, the panel landing through `workspace.open` instead of
  `revealLocation`, the no-result notification removed, the platform read
  replaced by ''.
- Against the real `typescript-language-server`: references to `answer`
  come back as `Location[]` naming the declaration (0:6-12) and the use
  (1:15-21). Asserted.
- Browser build (`npm run dev`): the References rail button renders and
  activates, the empty state reads as written, both commands appear in the
  palette with `Shift+F12`, no console errors. The list itself cannot show
  in the browser — no language server there — so, like every LSP surface
  before it, the populated panel has been seen in jsdom and not on a screen.

Next:

- **Rename symbol.** `textDocument/rename` → a `WorkspaceEdit` → one change
  set through the review panel (M6), so every edit is seen before it is
  written. `prepareRename` first where the server offers it.
- Merge #39 then this; the populated References view wants a tag build and
  a human.

Blocked:

- Nothing technical.

Confidence:

- High on the wire and the rows; the real server agreed with the fixtures
  and each test was made to fail.
- Unverified: the panel's look with real rows, and `Shift+F12` on a real
  keyboard (`Shift+F3` is bound and used, same parser).

---

## 2026-08-19 (PC) — The 1.0 bar, and the Problems-panel race closed

On branch `v1-bar`, on the Windows PC, after pulling #36–#38 (main at
`39d3999`, tag `v0.4.2`). The v0.4.2 GitHub release is still a **draft** with
all seven assets attached — publishing it is a human act, not done here.

Shipped:

- `ROADMAP.md` — a **1.0** section: what the number means (installs without a
  workaround and self-updates; find references / rename / format on save;
  Git gutter, diff, stage-and-commit; keybinding editor + workspace settings;
  explorer virtualisation; a recorded real-keyboard pass), what is 1.x on
  purpose (plugins, modal editing, Tree-sitter, the rest), and the order of
  work. Written as a proposal to edit, not a decree.
- `tests/problems-panel-open.test.ts` — the follow-up the previous entry left
  open ("if the pane's swap can ever run after `open()`'s continuation, the
  cursor lands on the previous buffer") is now **measured, not argued**: a
  real `ProblemsPanel` over the same app as a real `EditorPane`, a diagnostic
  in a file never opened, a click on the row. Cursor lands in the named file
  on both the fresh-open and the already-open branches, and the showing
  buffer is untouched. Mutation-checked: moving `goToLine` ahead of the
  `await` turns all three red.
- `README.md` — `npm test` comment said 779 tests (Status said 1092); now
  points at Status. The Status paragraph now says *how* `servers.json` comes
  to exist (**Configure Language Servers** writes a working template,
  **Reload Language Servers** picks up edits) and that Nox starts no server
  you did not list.
- This repo's local `user.email` read `frncescoa27122` — one letter short of
  the noreply address, so a commit from this PC would not have attributed to
  the account. Fixed in `.git/config`; nothing in history carries it.

Verified:

- `npm ci` then `npm test` — 1092 passed before the new file; 1095 after,
  60 files. `npm run check` — 427 files, 0 errors, 0 warnings. Windows,
  Node 24.15.0.

Next:

- **Find references.** First on the 1.0 order, and go to definition's
  "several results" case is waiting on its picker. Same door as definition:
  `requestFor('textDocument/references')`, a results list, `revealLocation`.
- Publish the v0.4.2 draft (human). Decide on signing — a purchase.

Blocked:

- Nothing technical. Not pushed, no PR — by instruction.

Confidence:

- High on the test and the doc fixes; each claim in the 1.0 table was checked
  against the file it describes, and the "Git next" line was traced to 0.2.0.
- The 1.0 bar itself is a judgement call, labelled as one.

---

## 2026-08-19 (later) — Go to definition

On branch `lsp-definition`, stacked on `lsp-render-verify` (it needs the
fake-server seam and the jsdom harness that branch adds). Same worktree,
`../nox-verify`. Pushed as #37, on top of #36; the 0.4.2 bump is #38 on top
of that. Merge in order, then tag `v0.4.2`.

Shipped:

- `src/core/lsp-definition.ts` — `Location | Location[] | LocationLink[] |
  null` reduced to `{ uri, range }[]`; links land on `targetSelectionRange`
  (the identifier) over `targetRange` (the declaration); malformed entries
  dropped, negative positions refused, duplicates removed.
- `lsp.goToDefinition` — **Go to Definition**, `F12`, category Language.
  Enabled only when the active buffer has a path and its server advertises
  `definitionProvider`, so a server still initializing greys the command
  rather than erroring. `NoxApp.revealLocation(location)` is public because
  find references will land the same way: `workspace.open(path)` (returns
  the existing id when already open) then `workspace.setSelection`, which
  dispatches to the pane showing the buffer and otherwise updates the
  buffer's own state so the pane's swap carries the cursor. Several results
  take the first and say how many; a picker is find references' list.
- CHANGELOG `[Unreleased]` and the ROADMAP row.

Verified:

- `npm test` — 1092 passed, 59 files. `npm run check` — 426 files, 0 errors.
- `tests/lsp-go-to-definition.test.ts` (jsdom, real pane + real app + fake
  server): enabled/disabled, the request's uri and position, cross-file
  jump, same-file jump, no result, many results, unopenable URI, a server
  error, and a count message that must not follow a failed reveal. Four
  mutations recorded in the docblock, each seen red.
- Against the real `typescript-language-server`: it sends `Location[]`, not
  links, and points at the identifier (line 0, 6-12). Asserted, so a change
  is a failing test.

Two things worth carrying forward:

- **`workspace.open` on an open path returns the existing id and re-reports
  nothing**, and every `null` it returns has already gone through `#fail` →
  `notifications.error`. A caller that checks "is it already active" first,
  or toasts on `null`, is doing something already done. The first version
  here did both; the review caught it.
- **`FakeLanguageServer` now answers a throwing handler with a JSON-RPC
  error**, which is what makes a request's failure path testable through
  the real service. Hover, completion and rename can use the same trick.

Follow-up worth a look, not a bug claim: `ProblemsPanel.open()` does
`await workspace.open(path)` then `app.goToLine(...)` on `this.view.get()`.
If the pane's state swap can ever run after that continuation, the cursor
lands on the previous buffer. Svelte flushes effects in a microtask queued
before `open()`'s continuation, so it is probably fine — but nothing proves
it, and `revealLocation` deliberately went through `setSelection` so as not
to depend on the answer.

Next:

- Merge #36 → #37 → #38, push the tag `v0.4.2`, publish the draft.
- Find references — the results list, and the "several definitions" picker
  with it. Then rename symbol.

Confidence:

- High on the command and the normaliser; each test was made to fail first,
  and the real server agreed with the fixtures.
- Unverified: F12 on a real keyboard in the desktop build. The keymap parses
  it exactly as it parses F3, which is bound and used, so the risk is small
  and named.

---

## 2026-08-19 — The three unseen surfaces, seen in a DOM

On branch `lsp-render-verify`, in a **worktree** at `../nox-verify` (own
`npm ci` — the shared `node_modules` predated the desktop's
`typescript-language-server` devDependency, and the integration suite failed
9/9 until it was reinstalled). Pushed as #36.

The gap: diagnostics, completion and hover each had a wire test and no
rendering test — the sources were exercised against `{ state } as
EditorView`, and nothing proved the pane's `lspCompartment` delivered them
into a live view. Closed by measuring what jsdom can drive rather than
arguing about it; the measurements and the decision are in
`docs/superpowers/specs/2026-08-19-lsp-rendering-verification-design.md`.

Shipped:

- `tests/lsp-rendering.test.ts` — the real `EditorPane` over a real `NoxApp`
  whose real `LspService` runs against an in-memory server. Seven tests: a
  published diagnostic paints `.cm-lintRange-error` under exactly `total`
  plus a gutter mark, and clears on an empty batch; typing `.` sends
  `textDocument/completion` for the pane's URI and the picker lists the
  server's labels, with `completionItem/resolve` documentation shown for the
  highlighted item; resting the pointer sends `textDocument/hover` and the
  tooltip carries the code block and prose as text — `<script>` in the
  server's markdown is characters, not an element — and leaves with the
  pointer.
- `tests/support/fake-lsp-process.ts` — the fake that `lsp-service.test.ts`
  kept privately, extracted and taught `handle(method, fn)`.
- `MemoryPlatform.languageServerFactory` — a test installs a server there;
  `capabilities.languageServers` stays false because the browser build still
  cannot start one.
- `tests/support/jsdom-layout.ts` — jsdom's `Range` has no `getClientRects`,
  and CodeMirror's `HoverPlugin` calls `coordsAtPos` from a bare `setTimeout`,
  so hover threw before the source was asked. Filled with one all-zero
  rectangle. **The rectangle's existence is invented; its numbers are
  jsdom's.** Consequence, written where the polyfill lives: `posAtCoords` is
  always 0, so the suite proves the request and the DOM, never which symbol
  was under the pointer.

Verified:

- `npm test` — 1074 passed, 57 files. `npm run check` — 423 files, 0 errors.
- Every rendering test mutation-checked against `EditorPane.svelte`: dropping
  `lspHoverExtension` reddens all three hover tests, dropping
  `lspCompletionExtension` both completion tests, no-op'ing
  `applyDiagnostics` both diagnostic tests. Recorded in the suite's docblock.

Found by looking, before a line was written:

- **CodeMirror's `hoverTooltip` underlines nothing.** `pos`/`end` on the
  returned tooltip decide when it *closes*; no decoration is applied.
  `CHANGELOG.md` `[Unreleased]` said "underlining exactly the span the server
  is talking about", `ROADMAP.md` said "highlighting the span", and
  `hover.ts` said "the highlight covers the symbol". All three corrected to
  what happens (the tooltip stays while the pointer is anywhere over the
  span), and the 2026-08-18 hover design note marked superseded on that
  point. Nobody had seen the tooltip, so nobody had seen that it did not.

Decided, and why (short form; the spec has the long one):

- **jsdom, not Playwright.** Two of three surfaces render under jsdom with no
  polyfill and the third with a one-rectangle one; zero new dependencies.
  Playwright against `npm run dev` would need a fake server injected into
  the web build, a browser download on every CI push, and still would not
  reach the WebView where both real rendering bugs lived. The next four v0.4
  features are wiring and text, which this harness reaches. Revisit —
  as vitest browser mode, which reuses the new seam — at the first feature
  whose *claim* is geometric.
- `ARCHITECTURE.md` §7's "Components embedding CodeMirror are untested" row
  was already false (`lsp-paint-target.test.ts` mounted `EditorPane`) and now
  states the real boundary. `CONTRIBUTING.md` allows a second jsdom file over
  the same component for a distinct named concern.

Next:

- Merge this, then the release ([Unreleased] holds hover, completion and the
  language-server support). Both need a push, which needs a human.
- Go to definition on the same door; then find references, rename.

Blocked:

- Nothing technical. Not pushed, no PR — by instruction.

Confidence:

- High on what the suite proves, because each test was made to fail first.
- Unverified, and now written down as such rather than as a gap: tooltip
  placement, and pointer→symbol mapping. Both are CodeMirror's.

---


## 2026-08-18 (later still) — Hover, and a shared-checkout collision

Shipped, on branch `lsp-hover`, in a **worktree** at `../nox-hover`:

- `src/core/lsp-hover.ts` — the three shapes of LSP `contents` reduced to
  ordered code/prose blocks. Pure.
- `src/editor/hover.ts` — the `hoverTooltip` source and its DOM.
- `completionCompartment` renamed `lspCompartment` and widened to hold both
  editor extensions, so the next feature is an array entry.

Verified:

- `npm test` — 1063 passed, 55 files. `npm run check` — 419 files, 0 errors.
- The no-HTML guard was checked by breaking it: swapping one `textContent`
  for `innerHTML` produces a live `<img onerror>` and a `<script>` element,
  and two tests fail. That is the assertion the design's §4 rests on.
- The language-tagged `MarkedString` branch was checked the same way; two
  tests fail, which is what renders a type signature as a paragraph.
- Against the real server: tsserver sends `MarkupContent` markdown **and**
  names a range. Both design assumptions held — unlike diagnostics, where the
  equivalent test found no `version` and turned a safeguard into dead code.

**Two sessions shared this checkout, and it went wrong three times.** Worth
writing down properly, because the lesson sharpened at each step:

1. My commit landed on the other session's branch, and `git add -A` swept its
   uncommitted work into mine.
2. It happened again with `git add <named files>` — nothing of theirs was
   captured, but it caught them with work *staged*.
3. Then the real lesson: **`git add <file>` scopes what you add; `git commit`
   commits the whole index.** A commit of mine carried four of their files
   purely because they were staged when I ran it. Found by auditing
   `git show --name-only` over every commit on the branch, and fixed by
   rebuilding it from the last clean commit — nothing had been pushed.

The fix that actually works: `git worktree add ../nox-hover lsp-hover`, plus
a **directory junction** for `node_modules` so there is no second install
(`New-Item -ItemType Junction`). The suite runs unchanged in it. Do this the
moment a second session starts, not after the third incident.

Next:

- **The tooltip has never been seen.** Same gap as the picker and the squiggle.
  A tag build and a human.
- Then go-to-definition, which is the same door and needs no new rendering.

Blocked:

- Nothing. Not pushed.

Confidence:

- High on the conversion and the source, both mutation-checked.
- Unverified: the tooltip rendering on a real hover.

---

## 2026-08-18 (later still) — The apt step that hangs

On branch `ci-apt-mirror-stall`, merged to `main` as #34. The
`rust (ubuntu-22.04)` job's dependency install hung five times in one day,
10-26 minutes against ~1.8 minutes healthy, each time needing a human to
cancel and `gh run rerun`.

What it actually is, from the run logs rather than from the symptom:

- `apt-get update` is **not** the problem. It finishes in 3-8s even on the bad
  runs (32s on the worst). The whole stall is inside `apt-get install`.
- Nothing fails, times out, or errors. apt just crawls: run 32163740199
  reported `Fetched 55.6 MB in 22min 12s (41.7 kB/s)` against `in 9s` on a
  healthy run of the same commit.
- Time per package is **uncorrelated with package size** — 14.2 kB took 17.9s,
  356 kB took 5.0s. So it is per-request latency across 137 serial requests,
  not bandwidth. That is why `Acquire::Retries` and `Acquire::http::Timeout`
  are both no-ops here: there is no error to retry and no idle socket to time
  out. A plain retry is also weak, because the degradation is sustained for
  the whole 22 minutes rather than bursty.

So the fix is to stop asking the mirror at all, and to bound what is left:

- `.github/actions/linux-build-deps/` — new composite action, used by both
  `ci.yml` and `release.yml` (which carried the identical block plus
  `patchelf`). One copy, because the retry shell is subtle enough that two
  copies would drift.
- `actions/cache@v6` over `~/apt-archives`, seeded into
  `/var/cache/apt/archives` **after** `apt-get update`. On a warm cache apt
  downloads nothing, so the mirror cannot affect the step at all.
- Download and install are split. A `timeout` can then only ever interrupt the
  network half; dpkg is never killed part-way through unpacking. Completed
  `.debs` survive the kill, so the three attempts accumulate progress rather
  than restarting.
- `--no-install-recommends` drops 42 packages of gstreamer, pipewire, pulse,
  polkit and codecs that a compile-only job never uses.
- `Acquire::ForceIPv4` — the one unproven piece, see Blocked.

Verified, locally in Docker against a runner-like image:

- Cold cache: 239 packages, exit 0, 48s, `pkg-config --modversion
  webkit2gtk-4.1` → 2.50.4.
- Warm cache: `Seeded 239 package(s)` → `Need to get 0 B/124 MB`. Zero
  archives fetched. With `extra-packages: patchelf`, exactly `72.1 kB`.
- Resume is real, not assumed: a download killed at 3s kept 55 of 281 `.debs`
  and the retry fetched only `115 MB/133 MB`.
- The retry function against a hang → three attempts then `::error::` and
  nonzero, in 21s; against a twice-failing command → recovers on attempt 3;
  `set -e` does not abort the script on a failed attempt.
- `bash -n` clean, shellcheck clean, all three YAML files parse, CRLF intact.

Then confirmed on the real runners, two `workflow_dispatch` runs on the pushed
branch (32184094506 cold, 32184425793 warm), all ten jobs green:

- Cold: `Cache not found`, `Seeded 0`, `Fetched 52.8 MB in 51s`, then
  `Need to get 0 B/52.8 MB` for the install half. Step took 1m52s.
- Warm: `Cache hit`, `Seeded 122 package(s)`, `Need to get 0 B/52.8 MB`.
  **Nothing was fetched from the mirror at all.** Step took 1m09s.
- `--no-install-recommends` is worth more on the runner than in the container:
  137 packages and 55.6 MB become 122 and 52.8 MB. Fewer serial requests is
  the axis that matters, since the stall is per-request.
- **A PR run reads caches from its base branch, not from a sibling.** PR #34's
  own check therefore ran cold; the cache only starts serving PRs once `main`
  has run once and saved it. Confirmed afterwards on PR #35: `Cache hit`,
  `Seeded 122`, `Need to get 0 B/52.8 MB` on someone else's branch.
- The repo was at 9.8 GB of its 10 GB Actions cache limit, 7.71 GB of it stale
  `v0.4.1-*-test` tag caches. Cleared — a 50 MB apt cache was otherwise a
  plausible eviction, which would have quietly undone all of this.
- actionlint clean over both workflows — which, until the tag run below, was
  the only check `release.yml` got.

And `release.yml`, which had never run, exercised by a throwaway tag
`v0.4.1-apt-test1` off `main` (run 32207771888, since deleted along with its
draft and caches). All four platforms built:

- The `extra-packages: patchelf` input reaches the action — `EXTRA_PACKAGES:
  patchelf` — and takes its own cache key, `apt-jammy-patchelf-`, separate
  from CI's `apt-jammy-base-`. Worth keeping separate even though `patchelf`
  turns out to be preinstalled on the runner and downloads nothing.
- **The mirror degraded mid-run and the retry caught it**, unplanned. Two
  120s attempts at `apt-get update` timed out, the third got through at
  `Fetched 257 kB in 38s (6695 B/s)`, and the build went green with nobody
  watching. Cold path cost 6m24s. That is the whole point of the change,
  observed rather than argued.

Two things worth carrying forward:

- **Seed the apt cache after `apt-get update`, never before.** The first
  version seeded first and silently re-downloaded all 124 MB — an
  `APT::Update::Post-Invoke` hook can empty `/var/cache/apt/archives`. Caught
  only because the warm-cache run was actually executed rather than reasoned
  about.
- **`apt-get update` degrades too.** Every one of the five logged incidents
  sat in `apt-get install`, and the entry above says so — but the release run
  stalled in `update` instead, at 6.7 kB/s. The pattern held across five
  samples and still was not the rule. `update` is wrapped in the same retry
  on general principle, and that is the only reason that run passed.

Next:

- Watch whether a stall ever recurs on a *cold* cache. That is the only path
  still exposed, and it is now bounded at three 5-minute attempts rather than
  open-ended.

Blocked:

- `Acquire::ForceIPv4` is a hypothesis, not a measurement. Constant
  size-independent per-request latency is what a failed IPv6 connect followed
  by IPv4 fallback looks like, but the runner logs do not say so outright. It
  is harmless if wrong, and the cache does not depend on it being right.
  The release run degraded straight through it, so whatever it does, it is
  not a cure on its own — the cache and the retry are what carry this.

## 2026-08-18 (later) — Completion

Shipped, on branch `lsp-completion`, all six planned tasks:

- `LspService.requestFor` / `capabilitiesFor` — the request door. Diagnostics
  arrive by push; everything else in v0.4 has to ask, and `#running` was
  private. Hover, go-to-definition and rename reuse this.
- `src/core/lsp-completion.ts` — items to CodeMirror completions, pure.
- `src/editor/completion.ts` — the source, and the DOM half of lazy docs.
- Wired through a compartment the pane reconfigures, keyed off `currentId`.

Verified:

- `npm test` — 1031 passed, 53 files. `npm run check` — 415 files, 0 errors.
- Four guards mutation-checked rather than trusted: the `textEdit` range,
  `filterText`, the `context.aborted` check, and `isIncomplete` suppressing
  `validFor`. Each fails its own test when removed.
- Against a real server: `s.` returns members with kinds, and **none of the
  items carry documentation** — asserted, because that is what makes
  `completionItem/resolve` load-bearing rather than an optimisation.

Two things worth carrying forward:

- **`npm run check` exits 0 even when it reports errors.** A
  `check && test && commit` chain therefore does not gate on it. One commit
  went in with a type error before this was noticed; grep the output for
  `0 ERRORS` instead of trusting the exit code.
- That error was real and reshaped the design: `CompletionInfo` is
  `Node | null | {dom}`, never a string, so lazy documentation cannot return
  text. `core/` stays DOM-free and the editor layer owns the callback.

Next:

- **The picker has never been seen.** Same gap as the squiggle before it: the
  wire behaviour is proven and the rendering is not. A tag build and a human.
- Then hover, which is the smallest feature left on the door this opened.

Blocked:

- Nothing. Not pushed.

Confidence:

- High on the conversion and the source — mutation-checked, and the real
  server contradicted nothing this time.
- Unverified: the picker itself, and the compartment actually delivering the
  source into a live view. The test proves the compartment exists in a built
  state, not that a keystroke reaches the server.

---

## 2026-08-18 — A real server, and what it changed

Shipped:

- `tests/lsp-integration.test.ts` — drives `typescript-language-server` 5.3.0
  through the same adapter the fake server uses, now extracted to
  `tests/support/lsp-child.ts` so a difference between fake and real cannot be
  a difference in the harness. Runs in CI, ~10s.
- `src-tauri/src/lsp.rs` — a Windows `.cmd` fallback via `cmd /C`.

Verified, and two of these contradict what the spec assumed:

- **tsserver sends no `version` on `publishDiagnostics`.** The field is
  optional and it omits it, so `LspService`'s stale-batch check never fires for
  the primary server. The range clamp in `editor/lsp.ts` is the only safeguard
  actually carrying the feature. Recorded as an assertion, so a future tsserver
  that starts sending one is a test failure someone reads.
- **tsserver advertises `textDocumentSync: 2` (incremental) and accepts a
  full-document change anyway**, clearing the diagnostic when the error is
  fixed. Full-text sync costs nothing against it. Mutation-checked: a change
  that does not fix the error leaves the diagnostic and fails the test.
- URI round-trips exactly, `c%3A` percent-encoding included.
- `npm test` — 979 passed, 50 files. `npm run check` — 410 files, 0 errors.
  CI green on all five jobs.

Smoke-tested on real hardware, from the `v0.4.1-lsp-test1` tag build:

- Nox spawned the server through the fallback and the process tree proved it:
  `Nox.exe -> cmd.exe "/C typescript-language-server --stdio" -> node.exe`.
  Both untested paths — `lsp.rs` supervision and the Windows `.cmd` fallback —
  confirmed working, not merely compiling.
- Same server pid for 40s, so the handshake completed; a failed one restarts at
  1s/2s/4s and then stays down.
- A real window close (WM_CLOSE, not a kill) stopped the server with **no
  orphans**. The one process that first appeared to be an orphan was the
  PowerShell command doing the searching — its own command line contained the
  search string.
- The fallback was then widened: it retried only on `NotFound`, which covers a
  bare command on PATH but not an absolute path to a `.cmd`, where
  `CreateProcess` fails with a different error. Someone writing a full path
  into `servers.json` is at least as likely.

Second build (`v0.4.1-lsp-test2`), after Francesco reported an empty console
window appearing on reload:

- **Windows gives a console-subsystem child its own window when the parent is
  a GUI app.** The `cmd` shim and the server are both console apps, so an empty
  console sat in front of the editor for the session — empty because the output
  is piped to Nox, permanent because the server is meant to keep running.
  Fixed with `CREATE_NO_WINDOW` on both spawn attempts.
- The first check for the fix was wrong and nearly reported a failure:
  `conhost.exe` is still created under the shim, because `CREATE_NO_WINDOW`
  hides the console rather than preventing one. The right measurement is window
  *visibility* — `EnumWindows` + `IsWindowVisible` finds no window belonging to
  the `cmd` or `conhost`, and no `ConsoleWindowClass` visible anywhere.
- Server stable for 25s afterwards, so the flag did not break the pipes.
- **`agent.rs` has the identical defect** and was left alone to keep the PR
  scoped. Spun off as its own task.

Third build (`v0.4.1-lsp-test3`) — **the squiggle is confirmed on real
hardware**, on the right buffer, with the server connected in the status bar.

Two bugs found by looking at a screen, both invisible to every test here:

- **A console window on every reload.** Windows gives a console-subsystem
  child its own window when the parent is a GUI app. Fixed with
  `CREATE_NO_WINDOW`; see the second build's entry.
- **The squiggle for `x.ts` appeared inside `servers.json`.** `EditorPane`
  holds one view and re-points it per tab, routing transactions to
  `workspace.applyTransaction(currentId, …)`. The app painted from a
  `workspace.activeId` subscription, which fires synchronously, while the pane
  swaps state in an effect, which runs later — so the newly-active buffer's
  diagnostics were dispatched while the *previous* buffer's state was loaded,
  and recorded against it permanently. Two owners of "which buffer is this
  view showing"; now one, the pane. **The tests added with the fix do not
  reproduce the race** — restoring the old paint leaves them green, because
  the harness drives effects through `flushSync`. Said out loud in the file.

Also confirmed, and not a bug: the squiggle sits under the *variable name*,
not the offending literal. `tsc --noEmit` reports `x.ts(1,7)` for
`const n: number = "x";` — column 7 is the `n`. TypeScript reports an
assignability error at the declaration, and Nox renders the range faithfully.

The setup that finally worked, worth writing down: a **global**
`typescript-language-server` needs a **global `typescript@6`** beside it.
`npm install -g typescript` now installs TypeScript 7, which no longer ships
`lib/tsserver.js`, and the server refuses to start without it.

Debt, deliberate:

- ~~**The squiggle has never been seen.**~~ Seen, on the right buffer. Kept
  below for the record of what it cost to get there.
- **The squiggle had never been seen** when the first two builds shipped. The UI could not be driven this
  session, so "diagnostics appear" is proved as far as the server running and
  the pipes connecting, and no further. The console-window bug is a reminder
  that a process tree is not a screen: it was invisible to every check made
  here and obvious the moment a human looked.

Confidence:

- High on the protocol layer — it has met a real server and been contradicted
  by it, which is worth more than the tests that agreed with me.
- High on supervision and Windows launching, now that the process tree has
  been read directly.
- Unverified: the rendering itself.

---

## 2026-08-17 — LSP client and diagnostics, all 16 tasks

Shipped:

- `src/services/search.ts:331` — `previewReplacement` resolves capture groups
  with a sticky match at the match's own column and returns `null` unless the
  result reproduces exactly what search reported. It previously fell through to
  the raw template, so a project-search row previewed a literal `$1` while the
  write substituted the capture. Branch `fix-replace-preview-groups`.
- Deleted the two merged preserve-case plan docs. Branch
  `retire-preserve-case-plans`.
- The LSP client, on branch `lsp-client`, all sixteen tasks of
  `docs/superpowers/plans/2026-08-17-lsp-client.md`:
  `src/core/uri.ts`, `src/core/lsp-position.ts`, the `LanguageServerProcess`
  boundary, `src-tauri/src/lsp.rs` (framing + supervision + four commands),
  `src/services/lsp/{transport,session,documents,registry,index}.ts`,
  `src/editor/lsp.ts`, `src/ui/{lsp-status,problems}.ts`,
  `src/ui/ProblemsPanel.svelte`, and the `app.ts` wiring with **Configure
  Language Servers**, **Reload Language Servers** and **Show Problems**.

Verified:

- `npm test` — 971 passed, 49 files. `npm run check` — 408 files, 0 errors.
  Baseline at session start was 855 / 37 and 385 files.
- The replace bug was reproduced in node before any code changed: window lead
  143, match column 60, rescan lands on 56/63/70, never 60.
- Four load-bearing tests were mutation-checked rather than trusted — the
  pre-initialize queue, the document version, the stale-diagnostic drop, and
  the preview fix itself. Each fails when its production line is removed.
- `tests/lsp-session.test.ts` runs a real Node child speaking genuine
  `Content-Length` framing, including a non-ASCII payload.

Next:

- **A desktop smoke test.** Push a throwaway `v0.4.1-lsp-test1` tag, let CI
  build the Windows installer, install it, and open a `.ts` file with an error
  in a workspace with `servers.json` configured. That exercises the two things
  no test here can: `lsp.rs`'s supervision, and whether a squiggle actually
  appears. It is also the only way to confirm the Windows `.cmd` fallback works
  rather than merely compiles.
- Then completion, the cheapest remaining v0.4 item
  (`@codemirror/autocomplete` is already a dependency).

Blocked / unverified:

- ~~`src-tauri/src/lsp.rs` has never been compiled.~~ **Resolved.** CI built
  it on Linux, macOS and Windows and ran all nine framing tests green (run
  32090362916). It did not compile on the first try: `push` was written before
  the crate's `Result<T>` alias existed and returned `Result<Vec<String>,
  String>`, which is E0107 against a one-argument alias. That is exactly the
  class of error the Python port could not catch, and exactly why the PR went
  up as a draft.
- ~~No real language server has ever talked to this.~~ **Mostly resolved.**
  `tests/lsp-integration.test.ts` drives `typescript-language-server` 5.3.0 and
  runs in CI on Node 20 and 22. It turned one design assumption around and
  confirmed another — see the entry below. What is *still* untested is
  `lsp.rs`'s own supervision (the integration test reaches the server through
  the Node adapter, not through Rust) and the UI end of it: squiggles actually
  painting, the panel actually rendering. Both need a desktop build.
- `lsp-client` is pushed as draft PR #28, CI green. The other two branches
  (`fix-replace-preview-groups`, `retire-preserve-case-plans`) are unpushed.

Confidence:

- High on the TypeScript: red-green watched on every task, four mutation
  checks, and the full suite green.
- High on `lsp.rs` now: compiled and tested on all three platforms by CI.
- Low on the end-to-end claim. "Diagnostics appear" is true of the code paths
  and untested against a real server.

# Upstream delta: RATING.md findings against origin/main

The audit in `AUDIT/RATING.md` was run against `54cece6e` believing it was the
tip of `main`. `origin/main` is five commits ahead, at `8823567`:

```
8823567 Clear the five remaining review findings from the 1.0 debt table (#181)
77f41e1 Make net.request a gate rather than a sentence (#180)
17b679d Put the terminal under WebDriver, and fix what a four-agent review found (#179)
6837dd7 Run the project's own commands as tasks (#178)
8761862 Prepare 0.12.0 (#177)
```

Method: for every finding, `git show origin/main:<path>` and
`git diff 54cece6..origin/main -- <path>` against the exact citation. A file
absent from `git diff --stat 54cece6..origin/main` is byte-identical between
the two commits, so any finding whose citation lives there is unchanged by
construction; those are marked STILL PRESENT without further narration beyond
confirming the file did not move. 51 files changed in total (4,947
insertions, 87 deletions); the rest of the tree, including
`src/services/workspace.ts`, `src/services/session.ts`, `src/services/review.ts`,
`src/ui/ReviewPanel.svelte`, `src-tauri/src/pty.rs`, `src-tauri/src/lsp.rs`,
`src-tauri/src/git.rs`, `src-tauri/src/fs.rs`, `src-tauri/src/watcher.rs`,
`src-tauri/src/http.rs`, `src/services/commands.ts`, `src/services/agent/runtime.ts`,
`src/services/agent/stdio.ts`, `.github/workflows/*.yml`, is untouched.

## Findings table

Ordered FIXED UPSTREAM, then CHANGED, then STILL PRESENT, then N/A.

| ID | Sev | Status | Justification |
|---|---|---|---|
| A7-010 (contains A6-003) | P2 | CHANGED | The net.request/audit-trail overclaim A6-003 named is fixed: `ARCHITECTURE.md` now reads "The text leaves the machine only once `net.request` is granted, which the commands that can reach the network declare as of 2026-08-31 and did not before" (was: unqualified). `context.ts`'s comment got the same correction. But the rest of A7-010 stands: README.md's BYO-agent section (109-143) and the Answers "never prompted" claim (177-179) are byte-identical (diff touches only the Status section), and no trust warning was added where a stdio agent is configured. |
| A2-003 | P2 | CHANGED | Still broken, and worse documented. `view.reloadWindow`'s `run` body is still exactly `this.notifications.info(...); globalThis.location.reload();`. There is no `dispose()` call, language servers are still orphaned (confirmed: `beforeUnload` in `App.svelte` kills agents and closes terminals but never touches `this.lsp`). A **third** comment now asserts the opposite: `#restartLanguageServers` (~app.ts:1503) says a teardown "now lives in `dispose()`, which is what a reload actually runs", which is untrue, joining the two comments the original finding already caught. New locations: `src/app.ts:3368-3401` (command), `~1490-1503` (new false comment), `5647` (`dispose()` itself, still never called by reload). |
| A2-007 | P2 | CHANGED | Same shape, bigger. `#registerCommands()` still is the composition root's command table; it now runs `src/app.ts:2859` to just before `#registerKeybindings()` at `4890` (~2,030 lines, was 2715-4533, ~1,818 lines). The file grew from ~5,314 to 5,700 lines mostly by inserting Tasks and capability-declaration comments into the same method. The structural defect (one method mixing composition root and feature logic) is unaffected. |
| A8-010 | P3 | CHANGED | Half fixed. `e2e/README.md`'s stale claim ("Needs a Rust toolchain, which the development machine does not have") is rewritten: "Needs a Rust toolchain. The Windows development machine does not have one on git-bash's PATH... **It does run locally where a toolchain exists**... Check for `cargo` before assuming it is absent." `README.md`'s "about 4 MB" claim is untouched (`README.md:26`, now `339` not `340` for the second instance) while live release assets are still 5.19-5.38 MB (checked `gh release view v0.11.0`), so that half of the finding stands. |
| A7-001 | P1 | CHANGED | The twelve specific commands the finding's evidence rested on now declare capabilities and are enforced: `view.reloadWindow` → `permissions.revoke`; `plugins.reload`, `lsp.reload`, `terminal.toggle`, `terminal.focus`, `terminal.restart` → `shell.exec`; `notes.new`, `notes.newFromSelection` → `fs.create`; `notes.rename`, `prefs.reset`, `search.undoReplace` → `fs.write`; `notes.delete` → `fs.delete`; `agents.undoLastSession` → `buffer.edit`+`permissions.revoke`. Pinned by new `tests/command-capabilities.test.ts`, whose own docstring names the same six-plus-six commands the audit would have found. A related bug in the same review, explorer commands' `resourceFrom` accepting only a string and falling through to the lead selection while `run` acted on an array argument, is also fixed via a new `permissionTarget()` helper. **But the root cause is untouched**: `src/services/commands.ts:200` still reads `if (this.#guard && principal && principal.kind !== 'user' && command.capabilities?.length)`. A command that declares nothing is still never guarded, for anyone. The fix is enumerative (fix (a), add declarations), not the dispatcher-level rule the audit recommended (fix (b)); the new `docs`/Known-debt row for this literally says so: "What is not fixed is that there is still no way to ask a `run` function whether it reaches the OS." A future command that forgets to declare `capabilities` reaches an agent unchecked exactly as before. `src/services/commands.ts:200-202` unchanged; `src/app.ts` command definitions moved into the 2859-4890 range. |
| A3-001 | P0 | STILL PRESENT | `src/services/workspace.ts` is untouched (absent from the diff). Same code at `workspace.ts:966-1019`. |
| A3-003 | P1 | STILL PRESENT | `src/services/workspace.ts` and `src/ui/TabBar.svelte` both untouched. |
| A3-004 | P1 | STILL PRESENT | `src/services/session.ts` untouched. |
| A3-005 | P1 | STILL PRESENT | `src/services/workspace.ts` and `src/ui/EditorPane.svelte` untouched. |
| A4-001 | P1 | STILL PRESENT | `src/editor/sticky.ts` and `src/core/symbols.ts` untouched. |
| A4-002 | P1 | STILL PRESENT | `src/ui/EditorPane.svelte` and `src/editor/find.ts` untouched. |
| A4-003 | P1 | STILL PRESENT | `src/core/diff.ts`, `src/services/git.ts`, `src/services/review.ts` all untouched. |
| A2-002 | P1 | STILL PRESENT | `src-tauri/src/lib.rs`, `git.rs`, `fs.rs`, `lsp.rs` all untouched; the five commits are frontend/TS-side plus one Rust file (`agent.rs`). |
| A1-001 | P1 | STILL PRESENT | `src-tauri/src/lib.rs` and `geometry.rs` untouched. `tauri.conf.json` changed only its `version` field (0.11.0 to 0.12.0); no argv/`Opened`/associations/single-instance change. |
| A8-001 | P1 | STILL PRESENT | The `v0.12.0` tag on the remote still points at `54cece6e` (`git ls-remote --tags origin` confirms), whose manifests still read 0.11.0 at that commit, unchanged, since 54cece6e itself did not move. Its release run is still the same 15-second failure at the version gate (`gh run list --workflow=release.yml`: `v0.12.0` / failure / 15s, same run). **New nuance**: commit `8761862` ("Prepare 0.12.0", one of the five) did bump `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `CHANGELOG.md` to a consistent 0.12.0, so `origin/main` now has a commit whose manifests would satisfy the tag gate, but no new tag was cut against it, and the stray `v0.12.0` ref is still the only one that exists. The premature tag is not "orphaned" so much as it is now redundant with a correctly-versioned commit that was never retagged; deleting/moving the tag is still outside this task's read-only scope to confirm further, and remains a decision for the operator either way. |
| A6-001 | P2 | STILL PRESENT | `src-tauri/src/lsp.rs` untouched. `Cargo.toml` changed only the package version. |
| A6-002 | P2 | STILL PRESENT | `src-tauri/src/git.rs` and `src/services/git.ts` untouched. |
| A7-002 | P2 | STILL PRESENT | `src/services/review.ts` and `src/ui/ReviewPanel.svelte` untouched, so the re-tick and cross-session-discard logic is identical. The audit's "closed by A7-001" note does not hold: `review.discard`, `review.keepAll`, `review.rejectAll` are explicitly still in `command-capabilities.test.ts`'s `NEEDS_NOTHING` list ("deciding about a staged review"), i.e. upstream deliberately left them undeclared, so a non-user principal still passes the dispatcher's `command.capabilities?.length` check straight through for these three. |
| A7-004 | P2 | STILL PRESENT (Gated) | `src/services/context.ts`'s only change is a comment fixing the net.request cross-reference (see A7-010); the read-scoping logic at the cited lines is untouched. `runtime.ts` untouched. |
| A7-005 | P2 | STILL PRESENT | `src/services/agent/runtime.ts` and `src/services/agent/stdio.ts` untouched. (A related but distinct Rust-side bug, an agent stdout line growing unboundedly and the newline search rescanning quadratically, was fixed in `agent.rs`'s `LineStream`, but that bounds a single line's bytes, not the trail count, republish cost, or the idle-only timeout this finding names.) |
| A7-007 | P2 | STILL PRESENT | `src/ui/ReviewPanel.svelte` untouched. |
| A7-008 | P2 | STILL PRESENT | `permissions.ts`'s changes are additive (grant now carries `commandId`/`description`, keyed narrower, see A7-002/A7-001 write-ups) but the trail is still an in-memory array, still no cap change, still no export, still lost on reload/quit. `AgentPanel.svelte`'s only change is displaying the new `via <command>` label; no export UI added. |
| A7-009 | P2 | STILL PRESENT | `App.svelte`'s `beforeUnload` handler (now at `~89-108`, was `62-71`) is byte-identical in content to the version at 54cece6, it already called `killAllAgents()`/`closeAllTerminals()` before these five commits; nothing changed. `agent.rs`'s spawn/kill logic is untouched apart from the unrelated `LineStream` fix. A host crash still bypasses `beforeunload` exactly as before. |
| A3-002 | P2 | STILL PRESENT | `src/services/workspace.ts` untouched. |
| A3-006 | P2 | STILL PRESENT | `src/services/workspace.ts` untouched. |
| A3-007 | P2 | STILL PRESENT | `src/services/watcher.ts` and `workspace.ts` untouched. |
| A2-004 | P2 | STILL PRESENT | `src-tauri/src/watcher.rs` untouched. |
| A2-005 | P2 | STILL PRESENT | `agent.rs`'s reaping code is untouched: `child.lock().ok().and_then(|mut child| child.wait().ok())` still holds the `Mutex<Child>` through `wait()`, now at line ~143-146 (was 143-147). `lsp.rs` and `pty.rs` untouched. |
| A2-006 | P2 | STILL PRESENT | `pty.rs` untouched; `agent.rs`'s change bounds one line's byte length and stops quadratic rescanning inside `LineStream`, which is a different problem from the absence of backpressure/coalescing from the process into the webview that this finding names. No coalescing or backpressure was added. |
| A4-004 | P2 | STILL PRESENT (Gated) | `src/services/lsp/documents.ts` and `session.ts` untouched. |
| A4-005 | P2 | STILL PRESENT | `src-tauri/src/search.rs` untouched. |
| A4-006 | P2 | STILL PRESENT | `src/services/git.ts` untouched. |
| A4-007 | P2 | STILL PRESENT | `src/main.ts` and `session.ts` untouched. |
| A1-002 | P2 | STILL PRESENT | `src/ui/EditorPane.svelte` untouched. |
| A1-003 | P2 | STILL PRESENT | `src/services/menu.ts`'s only change adds a `Tasks` category to the existing `Tools` group; the cited Windows/Linux menu definitions (73-76, 103-113) are untouched, no Cut/Copy/Paste/Exit/About/Full Screen added. |
| A1-004 | P2 | STILL PRESENT (Gated) | `src/editor/extensions.ts` untouched. |
| A1-005 | P2 | STILL PRESENT | `src/core/languages.ts` untouched. |
| A5-001 | P2 | STILL PRESENT | `src/ui/StatusBar.svelte` untouched. |
| A5-002 | P2 | STILL PRESENT | `--nox-gutter-fg: #3d4657;` is byte-identical in `tokens.css` (moved from line 125 to 133 as five new selection/bracket tokens were inserted above it); `editor/theme.ts`'s gutter styling untouched. The two new token-related tests (`component-css-tokens.test.ts`, `token-definitions.test.ts`) check token-only CSS and that every referenced token is defined, neither is a contrast check, so the 2.03:1 ratio is neither measured nor changed. |
| A5-003 | P2 | STILL PRESENT (Gated) | `src/ui/MenuBar.svelte` untouched. `app.ts`'s keybinding table (now ~4930, was 4573) still binds only bare `F10` to `menubar.focus`; no `Alt` binding, no mnemonics, the surrounding new comment even says so explicitly: "Alt-mnemonics were the alternative and collide, `Alt+G` is already `nav.goToLine` off macOS." |
| A8-002 | P2 | STILL PRESENT | `src-tauri/Cargo.toml` changed only the version field; `lib.rs` untouched. `panic = "abort"` and the absence of a panic hook are unaffected. |
| A8-006 | P2 | STILL PRESENT | `tauri.conf.json`'s `minimumSystemVersion` field is untouched at whatever value it held (only `version` changed); `src/ui/DiffView.svelte` untouched. |
| A1-006 | P3 | STILL PRESENT | `CommandPalette.svelte`'s changes add a `tasks` picker mode; `recentFirst()` and the empty-query quick-open path are untouched. |
| A1-007 | P3 | STILL PRESENT (Gated) | `app.ts:5003` (was 4639-4641) still reads `this.keymap.bind(platformIsMac ? 'Ctrl+G' : 'Alt+G', 'nav.goToLine')`, and `'Mod+G': 'edit.findNext'` (line 4955) is unchanged, so Ctrl+G off macOS still goes to Find Next. |
| A1-008 | P3 | STILL PRESENT | The near-duplicate New File/New Folder command pairs are unchanged in substance, now at `src/app.ts:~2866-2900` (was 2735-2755) and `~3187-3210` (was 3038-3060; the second pair's only change is `resourceFrom` switching to the new `permissionTarget()` helper, not a behavioural fix to the duplication). |
| A1-009 | P3 | STILL PRESENT | `agents.show` (now `~3404-3409`, was different) and `agents.undoLastSession` (now `~3811`) both still declare `category: 'View'`. |
| A1-010 | P3 | STILL PRESENT | `edit.foldLevel` is still registered (now `~4154`) and still has no keybinding or menu entry dispatching it, confirmed by a single grep hit (the registration) in the whole file. |
| A1-011 | P3 | STILL PRESENT | No `print` command exists in `origin/main`'s `app.ts` (grep for "print" turns up only unrelated comments); `ROADMAP.md` records no decision either way. Not affected by the new Tasks feature, which is unrelated to printing. |
| A1-012 | P3 | STILL PRESENT | `src/services/workspace.ts` untouched; none of the five new test files (`command-capabilities`, `net-request-gate`, `permission-grant-scope`, `permission-resource-target`, `tasks`) name the fourteen previously-untested commands, the `restoreSession=false` path, or the 64 MB refusal. |
| A2-008 | P3 | STILL PRESENT | `app.ts`'s `start()` still calls `config.loadWorkspace()` once during boot and again from the folder-open handler (now with `tasks.load()` added alongside it), and `filetree.ts` is untouched, still no in-flight guard on `setRoot()`. |
| A2-009 | P3 | STILL PRESENT | `TitleBar.svelte` untouched. `App.svelte`'s `beforeUnload` block (now `~89-108`) is unchanged in content; minimise/maximise/close are still direct `app.platform.*` calls with no `Command`. |
| A2-010 | P3 | STILL PRESENT | `agent.rs`'s cited comment block (id-reuse handling, now `~149-152`, was 149-152) is byte-identical; `memory.ts` and `git.rs` untouched. |
| A3-009 | P3 | STILL PRESENT | `src/services/workspace.ts` untouched. |
| A3-010 | P3 | STILL PRESENT | `src/services/workspace.ts` untouched. |
| A3-011 | P3 | STILL PRESENT | `core/replace.ts` and `search.rs` untouched. |
| A3-012 | P3 | STILL PRESENT | `README.md:80` ("It does not lose your work. Ever.") is outside the diff's Status-section hunk. `ARCHITECTURE.md`'s reload-wording section (~370-394, now shifted a handful of lines by earlier insertions) is untouched. Still overclaims relative to the still-unfixed A3-001. |
| A4-009 | P3 | STILL PRESENT | `workspace.ts`'s `#sync` fan-out is untouched. `app.ts`'s `buffers.subscribe`/`activeId.subscribe` pair moved to `~661` (was ~630) with identical bodies. |
| A4-010 | P3 | STILL PRESENT | `src/services/lsp/index.ts` and `src/ui/StatusBar.svelte` untouched. |
| A4-011 | P3 | STILL PRESENT | `src/services/notifications.ts` untouched. |
| A4-013 | P3 | STILL PRESENT | `tests/browser/support/keystroke.ts` untouched, still an empty syntax tree. (The new `tests/browser/blame-gutter.test.ts` is a different, unrelated browser test added alongside it, not a fix to this one's scope.) |
| A5-004 | P3 | STILL PRESENT | `tests/token-contrast.test.ts` untouched, still measures flat surfaces only. `CommandPalette.svelte`'s `.detail`/`.badge` rules are byte-identical in content, now at `~1228-1255` (was 1174-1201; the file grew by adding a Tasks picker mode above this point). |
| A5-005 | P3 | STILL PRESENT | `src/services/keymap.ts` and `src/ui/ExplorerPanel.svelte` untouched. |
| A5-006 | P3 | STILL PRESENT | `src/ui/MenuBar.svelte` untouched. |
| A5-007 | P3 | STILL PRESENT | `src/ui/Toasts.svelte` untouched. |
| A5-008 | P3 | STILL PRESENT | `src/ui/EditorPane.svelte` untouched; `CommandPalette.svelte`'s accessible-name/labelling issues at the cited lines are unaffected by the Tasks-mode additions. |
| A5-009 | P3 | STILL PRESENT (Gated) | `src/ui/Welcome.svelte` untouched; `app.ts`'s keyboard-trap-relevant logic is unaffected by the unrelated command/capability changes. |
| A5-010 | P3 | STILL PRESENT | `src/ui/Sidebar.svelte`, `StatusBar.svelte`, `SettingsPanel.svelte` untouched. `AgentPanel.svelte`'s two `font-size: 0.92em;` literals are byte-identical, now at lines 378 and 504 (was 360 and 478; the file grew ~18 lines from the new `via <command>` grant label above the first one). |
| A5-011 | P3 | STILL PRESENT | `README.md`'s hero screenshot markup (`docs/screenshots/editor.png`, lines 15-16) is outside the diff's only hunk (the Status section). |
| A5-012 | P3 | STILL PRESENT | The "no Close Window item" Known-debt row is byte-identical, now at `ARCHITECTURE.md:2778` (was in the pre-existing table, shifted down by the ~90 lines of new debt rows inserted above it): "the traffic light and ⌘Q are the ways out", still macOS-shaped. |
| A6-004 | P3 | STILL PRESENT | `src-tauri/src/fs.rs` untouched. |
| A6-005 | P3 | STILL PRESENT | `src-tauri/src/http.rs` untouched. |
| A6-006 | P3 | STILL PRESENT | `src-tauri/src/fs.rs` untouched. |
| A6-007 | P3 | STILL PRESENT (Gated) | `src/services/config/schema.ts` untouched. |
| A6-008 | P3 | STILL PRESENT | `src-tauri/src/lsp.rs` untouched. |
| A7-011 | P3 | STILL PRESENT | `src/services/agent/runtime.ts` untouched. `app.ts`'s `agents.undoLastSession` run body is unchanged apart from the new `capabilities` declaration (A7-001), still reports "Took back everything ${session.label} did" with no save-awareness. `AgentPanel.svelte`'s only change is the unrelated `via` label. |
| A8-004 | P3 | N/A | No `SECURITY.md`, disclosure contact, or issue templates were added; repository root and `.github/` are absent from the changed-file list entirely. |
| A8-005 | P3 | N/A | `tauri.conf.json`'s `bundle` block changed nothing but top-level `version`; still no `licenseFile`/NOTICE. |
| A8-007 | P3 | STILL PRESENT | `README.md`'s relevant section is outside the diff's only hunk; `src/services/updates.ts` untouched. |
| A8-008 | P3 | N/A | `gh release list` still shows `Nox v0.9.1` as `Draft`, unaffected by any of the five commits (none touch GitHub Releases state, which isn't a repo file). |
| A8-009 | P3 | N/A | `.github/workflows/release.yml` is absent from the changed-file list; `--locked` is still not used. |
| A8-011 | P3 | N/A | `.github/workflows/ci.yml` untouched. `src-tauri/Cargo.toml`'s `rust-version = "1.77"` line is unchanged (confirmed by direct read of `origin/main`'s `Cargo.toml`), still never compiled against in CI. |
| A8-012 | P3 | N/A | `tauri.conf.json`'s `bundle.copyright` field is unaffected by the version-only diff; still empty. |

## Counts

| Status | Count |
|---|---|
| FIXED UPSTREAM | 0 |
| CHANGED | 5 |
| STILL PRESENT | 71 |
| N/A | 6 |
| **Total** | **82** |

## What this does to the score

**The number does not move.** No finding is fully FIXED UPSTREAM, so the P0
cap (A3-001, still present, unchanged in `workspace.ts:966-1019`) still
applies: Nox is still 59/100 capped, 64/100 uncapped, against `origin/main`.

Per-category, against the rubric in `RATING.md`'s Category table:

- **AI agent integration readiness (5/10)** is where the five commits did
  the most real work, and where the audit's own "five things that move the
  score most" list named the biggest lever (#2: "Close the undeclared-command
  hole (A7-001)... moves agent readiness from 5 toward 8"). What actually
  shipped is the enumerative fix (a), thirteen specific commands now declare
  capabilities, including the exact ones the audit's evidence rested on
  (`view.reloadWindow`, `plugins.reload`, `agents.undoLastSession`, etc.) -
  not the dispatcher-level fix (b) the audit recommended and the Gated table
  asked him to decide on. The gap in `commands.ts:200` that lets a command
  declaring nothing bypass the guard for any principal is unchanged, so a
  future or missed command is exactly as exposed as before. A6-003's
  documentation half (the `net.request` overclaim) is genuinely fixed. Net
  effect: worth perhaps 1 of the ~3 points the audit priced for a full A7-001
  fix, not the full move, because the structural hole A7-001 is graded on
  remains open, and A7-002/A7-004/A7-005/A7-008/A7-009 (the rest of the
  category's P2 debt) are all still present.
- **Security and memory safety (11/16)** gets a fractional nudge from the
  same A7-001/A6-003 partial fix (the audit's item #2 also said "security up
  a point" for the full close), but not the full point: A6-001, A6-002 are
  untouched, and the closing mechanism for A7-001 is the same partial one.
  Round to no change.
- **Feature completeness and correctness (13/20)**, **Architecture and
  systems quality (11/18)**, **Performance and multi-file editing (8/14)**,
  **UI and UX (11/14)**, and **Ship readiness for public release (5/8)** are
  all unchanged: every finding costing points in those categories (A3-001/
  A3-003/A3-004/A3-005, A2-002/A2-005/A2-006, A4-001/A4-002/A4-003, A5-001/
  A5-002/A5-004/A5-005, A8-001/A8-002/A8-004/A8-005/A8-006) is STILL PRESENT.
  The Tasks feature that shipped in `#178` is new, ungraded scope, it did
  not exist as a ROADMAP gap at audit time in a way that cost the category
  points, so building it doesn't add points back either, though it forecloses
  what would have been a future finding.

The honest read: five commits, two of them explicitly framed as
review-remediation ("fix what a four-agent review found", "clear the five
remaining review findings"), fixed real bugs the *later* reviews found -
several found in the same code paths this audit flagged, but landed zero of
this audit's 82 findings outright. The pattern worth naming for whoever reads
this next: upstream's own reviews are choosing the narrower, enumerative fix
over the structural one in more than one place (A7-001's dispatcher rule,
A7-002's undeclared review commands), which closes today's known instances
while leaving the shape of hole that produced them intact.

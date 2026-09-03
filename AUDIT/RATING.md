# Nox: audit rating

Audited commit: `54cece6e5fa50d7e9b35718e12f59a29d759b362` (`main`, 2026-08-29).
Audit date: 2026-09-02. Eight parallel read-only lanes (A1 to A8), then five adversarial verifiers over every P0 and P1. Lane reports are `AUDIT/A*.md`; verifier verdicts are `AUDIT/VERIFICATION.md`.

## The number

**Nox: 59 / 100 before remediation.** Category scores sum to **64**, and one unresolved P0 caps the total at 59.

The cap is applied because of A3-001: a keystroke typed while a save's write is in flight is silently reverted, never written, marked clean, and not recoverable by undo. Reproduced twice against the real `WorkspaceService` and once with the production history extension. It is a few-percent chance per manual save on a fast disk and the normal path under after-delay autosave. By the handoff's definition ("data loss on a normal path") that is P0, and in an editor whose first product claim is "it does not lose your work, ever" it is the right call. It is classified Safe and is the first thing Phase 3 fixes; the post-fix score is uncapped.

Anchor: 60 to 74 is "solid foundation, not ready for strangers". Uncapped, Nox is at the bottom of that band. Capped, it is at the top of "works, but with structural problems that will get worse". Both descriptions are fair. The architecture is unusually disciplined for a project this age, the product ideas are real, and the defects that cost the most points are all fixable in bounded diffs.

## Category table

| Category | Score | Max | What cost the points |
|---|---|---|---|
| Feature completeness and correctness | 13 | 20 | Completeness alone is a 15: the expected editor set is present, discoverable by construction, and mostly tested. Correctness costs two more: the P0 save race (A3-001), a tab strip that freezes after Close Editor Pane on a mirrored buffer (A3-003), a dirty tab silently dropped on restore with its backup clobbered (A3-004), and the cursor sent to offset 0 on every save of an unterminated file (A3-005). The OS cannot hand Nox a file (A1-001). |
| Architecture and systems quality | 11 | 18 | Zero import cycles across 144 files, lint-enforced layers, one failure sink. Against that: 48 of 49 IPC commands run on the main thread including `git commit` with hooks and every `fsync` (A2-002), Reload Window never runs `dispose()` and orphans language servers (A2-003), reader threads hold a child's mutex through `wait()` so kill can block (A2-005), no backpressure from pty or agent output (A2-006), and a 5,338-line composition root that 39 test files boot whole (A2-007). |
| Security and memory safety | 11 | 16 | Strict CSP, no renderer injection sink, argv-fixed git, loopback HTTP enforced in Rust and proven with an attacker listener, worker plugins contained by CSP plus Tauri's invoke key, zero `unsafe`. Costs: the permission dispatcher skips every command that declares no capabilities and a dozen side-effecting ones declare none (A7-001, reproduced under deny-all), a repository's own `core.fsmonitor` runs on open (A6-002, reproduced), an LSP header that aborts the process (A6-001, downgraded to P2: 40 exact values), plaintext secrets and umask-default modes on unsaved-text backups (A6-006). |
| Performance and multi-file editing | 8 | 14 | Typing path proven flat in Chromium, opens bounded at 64 MB, nearly every log capped, 7 us per keystroke at 50 open files. Costs: sticky scroll walks the whole syntax tree per keystroke once a file is parsed, 28 ms at 64k lines (A4-001); with Find open every dispatch rescans the document, 500 ms at 10 MB, and the cost survives closing the bar (A4-002); the Myers diff allocates 2 GB on 8,000 changed lines and Review is uncapped (A4-003); git base text retained for every file ever opened (A4-006); session restore serial and eager before first paint (A4-007). |
| UI and UX | 11 | 14 | Coherent tokens held by three tests, every icon-only button labelled, correct ARIA on tree, tablist, menubar and listbox, full reduced-motion coverage, humane error copy. Costs: line numbers at 2.03:1 against a documented 4.5:1 floor (A5-002), a corrupted glyph prefixing plugin status items with "2" (A5-001), Alt does not open the Windows/Linux menu and there are no mnemonics (A5-003), two text-on-wash pairs under the floor (A5-004), macOS glyphs on every platform (A5-005). |
| AI agent integration readiness | 5 | 10 | The Ollama path is genuinely read-and-propose: one guard, one write path, review-only, loopback proven. The bring-your-own path is not what the README says: `command.execute` reaches any undeclared command unchecked and unlogged (A7-001), so a stdio agent can undo another session's applied edits, write a closed file back to disk, reload the window and erase its own trail. Nothing bounds a runaway agent (A7-005), the trail is in-memory and not exportable (A7-008), agents outlive Nox on a host crash (A7-009), and the review panel has no bidi or zero-width defence (A7-007). |
| Ship readiness for public release | 5 | 8 | Installers on three platforms driven on every PR, minisign-signed updater verified against live assets, eleven required checks with admins enforced. Costs: a `v0.12.0` tag on the public remote whose release run failed at the version gate (A8-001), a Rust panic in release writes nothing anywhere (A8-002), no SECURITY.md or disclosure route (A8-004), no third-party licence attribution in any bundle (A8-005), `color-mix()` used under a 10.15 minimum that cannot render it (A8-006). |
| **Total** | **64, capped to 59** | **100** | |

## Counts

| | P0 | P1 | P2 | P3 | Total |
|---|---|---|---|---|---|
| Raw, all lanes | 0 | 16 | 34 | 41 | 91 |
| After dedupe and verification | 1 | 10 | 32 | 39 | 82 |
| Safe | 1 | 7 | 28 | 35 | 71 |
| Gated | 0 | 3 | 4 | 4 | 11 |

Merges: A8-003 into A1-001; A2-001 into A3-001; A3-008 and A4-012 into A2-002; A7-006 into A4-003; A4-008 into A2-006; A6-003 into A7-010; A6-009 into A8-011; A7-003 into A7-001. Verifier changes: A3-001 raised to P0; A6-001, A3-002 and A7-002 lowered to P2; A1-001 split into a Safe half and a Gated half.

## The five things that move the score most

1. **Fix A3-001.** Lifts the cap: 59 becomes 64 on its own. Then A3-003, A3-004, A3-005 together take correctness from 13 toward 16. All Safe, all in `workspace.ts` and `session.ts`.
2. **Close the undeclared-command hole (A7-001).** One dispatcher rule: a non-user principal may only execute a command that declares capabilities. Closes A7-002 and A7-003 with it, makes the README true, and moves agent readiness from 5 toward 8 and security up a point. Gated, and the one decision that most needs an answer.
3. **Bound the three per-keystroke and per-diff costs (A4-001, A4-002, A4-003) and move git and fs IPC off the main thread (A2-002).** Performance from 8 toward 11, architecture from 11 toward 13. All Safe.
4. **Let the OS hand Nox a file (A1-001).** Argv and the macOS `Opened` event are Safe and one wiring step; file associations and single-instance are Gated. Features and ship readiness both move.
5. **Make a crash leave a trace and a stranger able to report one (A8-002, A8-004, A8-005), and settle the stray tag (A8-001).** Ship readiness from 5 toward 7.

## Gated findings: the decisions

| ID | Sev | What he is deciding |
|---|---|---|
| A7-001 | P1 | Whether a non-user principal (agent, plugin) may execute a command that declares no `capabilities`. Today yes, silently. Fix (b) refuses it at the dispatcher, one rule; fix (a) adds declarations per command. Either changes what an agent can do without a prompt, in the closing direction. Recommended: (b). |
| A7-002 | P2 | Same decision as A7-001; closed by fix (b). Whether `review.*` commands should be reachable by agents at all. |
| A8-001 | P1 | Whether to delete the `v0.12.0` tag from the public remote (its release run failed in 15 s at the version gate, so no release exists) or to prepare 0.12.0 and re-tag. Deleting published refs is outside the audit's authority. |
| A1-001 (Gated half) | P1 | Whether the installers should register file associations (`.txt`, `.md`, code extensions) and whether a second launch should reuse the running window (single-instance). Both change first-run behaviour for existing users. The Safe half (argv and `Opened`) is fixed regardless. |
| A1-004 | P2 | Whether to detect indentation per file and honour `.editorconfig`. Changes what a keypress inserts in an existing file. |
| A4-004 | P2 | Whether to add a large-file mode below the 64 MB refusal that switches off LSP sync, full-copy session backup and the gutter diff. Changes behaviour on files users open today. |
| A7-004 | P2 | Whether the agent context reader should be scoped to the workspace root. Today it can read any path and the active selection of any file. Narrows what an agent sees. |
| A6-007 | P3 | Whether `files.excludeFromExplorer` should stay workspace-scoped (a cloned repo can hide its own entries from the explorer). |
| A1-007 | P3 | Whether Go to Line should be Ctrl+G off macOS (a keybinding default). |
| A5-003 | P3 | Whether Alt should open the Windows/Linux menu bar and whether menus get mnemonics (a keybinding default). |
| A5-009 | P3 | Whether the editor should offer a toggle-tab-focus command so Tab can leave it (a keybinding default). |

## Full finding list

Ordered by severity. Risk class after verification. Locations are `path:line` at the audited commit.

### P0

| ID | Risk | Title | Location |
|---|---|---|---|
| A3-001 | Safe | Keystrokes typed while a save's write is in flight are reverted, never written, buffer marked clean; not recoverable by undo (A2-001 merged) | `src/services/workspace.ts:966-1019` |

### P1

| ID | Risk | Title | Location |
|---|---|---|---|
| A7-001 | Gated | Side-effecting commands with no `capabilities` reach `command.execute` unchecked and unlogged; a stdio agent can undo another session, write a closed file to disk, spawn, reload the window (A7-003 merged) | `src/services/commands.ts:200-202`, `src/app.ts:3599-3621` |
| A3-003 | Safe | Close Editor Pane and Move Editor to Next Pane put a mirrored buffer twice in one pane; keyed tab strip throws `each_key_duplicate` and stays frozen until the tab is closed twice | `src/services/workspace.ts:784-797, 815-830`; `src/ui/TabBar.svelte:264` |
| A3-004 | Safe | Session restore silently drops a dirty tab whose file vanished; backup counter restarts at 1 and overwrites a different tab's unsaved text | `src/services/session.ts:148, 187, 385` |
| A3-005 | Safe | Save with `insertFinalNewline` (default on) and every external reload replace the whole document; cursor to offset 0, save scrolls to top, next keystroke after a reload lands at the top | `src/services/workspace.ts:991-999, 1131`; `src/ui/EditorPane.svelte:211, 321, 353` |
| A4-001 | Safe | Sticky scroll walks the whole syntax tree on every keystroke once the file is parsed: 9.7 ms at 16k lines, 28 ms at 64k, on by default | `src/editor/sticky.ts:181-201`; `src/core/symbols.ts:235-272` |
| A4-002 | Safe | With Find open every dispatch rescans the document: 43 ms at 1 MB, 500 ms at 10 MB; the query is never cleared so it persists after the bar is closed | `src/ui/EditorPane.svelte:146-147`; `src/editor/find.ts:420-445` |
| A4-003 | Safe | Myers diff keeps every frontier: 8,000 changed lines is 1.3 s and 2 GB; the 2 MB git cap bounds nothing and Review is uncapped (A7-006 merged) | `src/core/diff.ts:81-82`; `src/services/git.ts:529-557`; `src/services/review.ts:117-121` |
| A2-002 | Safe | 48 of 49 IPC commands run inline on the main thread: `git commit` with hooks, `git switch`, every `sync_all` on save; the three un-awaited senders must keep ordering (A3-008, A4-012 merged) | `src-tauri/src/lib.rs:129-180`; `git.rs:263-331`; `fs.rs:186`; `lsp.rs:346-358` |
| A1-001 | Split | Nox cannot receive a file from the OS: argv ignored beyond `--geometry`, no `RunEvent::Opened`, no file associations, no single instance (A8-003 merged). Argv and `Opened` are Safe; associations and single instance are Gated | `src-tauri/src/lib.rs:44-60`; `geometry.rs:79-96`; `tauri.conf.json:45-62` |
| A8-001 | Gated | `v0.12.0` tag on the public remote at the audited commit while every version file reads 0.11.0; the release run failed at the gate in 15 s and the tag remains | `.github/workflows/release.yml:33-58` |

### P2

| ID | Risk | Title | Location |
|---|---|---|---|
| A6-001 | Safe | A `Content-Length` within 40 of `usize::MAX` overflows `body_start + length` on the LSP reader thread and aborts the process under `panic = "abort"` (downgraded from P1) | `src-tauri/src/lsp.rs:116-121`; `Cargo.toml:80-85` |
| A6-002 | Safe | Opening a folder runs the repository's own `core.fsmonitor` through the automatic `git status`; needs an attacker-written `.git/config` | `src-tauri/src/git.rs:75-83, 202-208`; `src/services/git.ts:386, 411` |
| A7-002 | Gated | `review.keepAll` re-ticks out-of-selection hunks the scoped-review defence started unticked; `review.discard` dismisses another session's review (downgraded from P1; closed by A7-001) | `src/app.ts:3673-3693`; `src/services/review.ts:129-142` |
| A7-004 | Gated | Context reads are not workspace-scoped; the brief ships the active selection of any file | `src/services/context.ts:13-22, 158-205`; `runtime.ts:613-641` |
| A7-005 | Safe | Nothing bounds a runaway agent: uncapped trail, O(n) republish per action, idle-only timeout | `src/services/agent/runtime.ts:357-360, 529-544`; `stdio.ts:32-42` |
| A7-007 | Safe | Review panel has no bidi or zero-width defence (Trojan Source) | `src/ui/ReviewPanel.svelte:101-108` |
| A7-008 | Safe | Audit trail in-memory, capped at 500, not exportable, lost on reload and quit | `src/services/permissions.ts:330-335`; `context.ts:123-127` |
| A7-009 | Safe | Agent processes outlive Nox on a host crash: only `beforeunload` kills them | `src/ui/App.svelte:62-71`; `src-tauri/src/agent.rs:39-45, 210-244` |
| A7-010 | Safe | README and ROADMAP overclaim for BYO agents ("cannot run commands", "you are never prompted", audit trail complete); no trust warning where a stdio agent is configured (A6-003 merged) | `README.md:109-143, 177-179`; `ROADMAP.md:55`; `config.ts:89-106` |
| A3-002 | Safe | Grouped undo from the palette throws `RangeError` with a mirrored pane; caught and surfaced as an "Undo failed" toast, first buffer already undone (downgraded from P1) | `src/services/workspace.ts:1577-1590, 405-411` |
| A3-006 | Safe | Grouped undo false positive after history trimming undoes the user's last edit instead of the set | `src/services/workspace.ts:1421, 1520, 1549` |
| A3-007 | Safe | Reload decided for a clean buffer overwrites keystrokes typed during the read, marks clean | `src/services/watcher.ts:233-235`; `workspace.ts:1104-1142` |
| A2-003 | Safe | Reload Window calls `location.reload()` and never runs `dispose()`; every reload orphans the language servers; two comments claim the opposite | `src/app.ts:3230-3232, 1441-1443, 5299-5303` |
| A2-004 | Safe | Linux: `nox_watch` registers inotify watches for every directory synchronously on the main thread under the watcher lock | `src-tauri/src/watcher.rs:113-150` |
| A2-005 | Safe | Reader threads hold `Mutex<Child>` through `wait()`; kill on the main thread blocks behind a child that closed stdout but kept running | `agent.rs:143-147, 219`; `lsp.rs:296-300, 392`; `pty.rs:257-261, 359` |
| A2-006 | Safe | No backpressure or coalescing from pty, agent or LSP output into the webview (A4-008 merged) | `pty.rs:223-253`; `agent.rs:117-138` |
| A2-007 | Safe | `app.ts` is composition root plus feature logic; 39 test files boot the whole app to test one feature | `src/app.ts:2715-4533` |
| A4-004 | Gated | No large-file threshold below 64 MB: full-text LSP didChange, full-copy session backup with fsync, `textOf` before the diff cap | `src/services/lsp/documents.ts:156-172`; `session.ts:381-407` |
| A4-005 | Safe | Project search has no per-file match cap; one minified file yields one enormous event | `src-tauri/src/search.rs:180-211, 376-408` |
| A4-006 | Safe | `GitService` retains git base text of every file ever opened; `#drop` never clears `#bases` | `src/services/git.ts:102-103, 327-341` |
| A4-007 | Safe | Session restore is serial and eager (3 IPC plus `EditorState` per tab) before first paint | `src/main.ts:18-20`; `src/services/session.ts:161-249` |
| A1-002 | Safe | After-delay autosave saves whichever buffer is current when the timer fires, not the one edited; timer never cleared on tab switch | `src/ui/EditorPane.svelte:149, 315, 387-398` |
| A1-003 | Safe | Windows/Linux drawn menu has no Cut, Copy, Paste, Exit, About or Full Screen | `src/services/menu.ts:73-76, 103-113, 254-255` |
| A1-004 | Gated | No per-file indentation detection and no `.editorconfig` | `src/editor/extensions.ts:131` |
| A1-005 | Safe | 24 languages; C#, Kotlin, Swift, Lua, PowerShell, INI, Dockerfile, Makefile absent | `src/core/languages.ts:17, 23-71` |
| A5-001 | Safe | Plugin status-bar items prefixed with a literal "2": a corrupted glyph (bytes C2 82 32) in the stylesheet | `src/ui/StatusBar.svelte:425-429` |
| A5-002 | Safe | Line numbers paint at 2.03:1; DESIGN.md promises 4.5:1 and the contrast suite does not list the gutter token | `src/styles/tokens.css:125`; `src/editor/theme.ts:102` |
| A5-003 | Gated | Alt does not open the in-window menu bar on Windows/Linux; no mnemonics; F10 only | `src/ui/MenuBar.svelte:110-149`; `src/app.ts:4573` |
| A8-002 | Safe | Rust panic in release (`panic = "abort"`, no hook, Windows subsystem hides stderr) writes nothing anywhere | `src-tauri/Cargo.toml:78-84`; `src-tauri/src/lib.rs:24-183` |
| A8-004 | Safe | No SECURITY.md, disclosure contact, or issue templates | repository root, `.github/` |
| A8-005 | Safe | Third-party licences attributed nowhere in app or bundle; no `licenseFile`, no NOTICE | `src-tauri/tauri.conf.json:45-58` |
| A8-006 | Safe | `minimumSystemVersion` 10.15 while 20 `color-mix()` declarations need Safari 16.2; diff colouring vanishes on Catalina through Monterey | `src-tauri/tauri.conf.json:56`; `src/ui/DiffView.svelte:372-381` |

### P3

| ID | Risk | Title | Location |
|---|---|---|---|
| A1-006 | Safe | Recent files surface only as empty-query quick-open order; no `file.openRecent` | `src/ui/CommandPalette.svelte:718-722` |
| A1-007 | Gated | Go to Line is Alt+G off macOS; Ctrl+G given to Find Next | `src/app.ts:4639-4641` |
| A1-008 | Safe | File menu lists two near-duplicate New File/New Folder pairs resolving the target folder differently | `src/app.ts:2735-2755, 3038-3060` |
| A1-009 | Safe | `agents.show` and `agents.undoLastSession` carry category View | `src/app.ts:3238, 3601` |
| A1-010 | Safe | `edit.foldLevel` is a hidden command nothing dispatches | `src/app.ts:3925-3934` |
| A1-011 | Safe | No print command and no recorded decision not to have one | command table; `ROADMAP.md` |
| A1-012 | Safe | Fourteen commands, the `restoreSession=false` path and the 64 MB refusal have no test naming them | `tests/`; `src/services/workspace.ts:490-493` |
| A2-008 | Safe | Boot walks the project and loads workspace config twice; `start()`/`setRoot()` have no in-flight guard | `src/app.ts:386, 418, 580-588`; `filetree.ts:120-134` |
| A2-009 | Safe | Components call `app.platform.*` directly; minimise, maximise and close have no Command | `TitleBar.svelte:256-272`; `App.svelte:62-71` |
| A2-010 | Safe | No shared Platform contract suite; three Rust comments describe an id-reuse collision `tauri.ts` already prevents | `memory.ts:39-66`; `git.rs:913-918`; `agent.rs:149-152` |
| A3-009 | Safe | Save As onto an already-open path leaves two buffers on one file | `workspace.ts:1053-1080`; `app.ts:1868-1886` |
| A3-010 | Safe | Mixed line endings silently normalised to CRLF on save | `workspace.ts:1942` |
| A3-011 | Safe | Replace on closed CRLF files leaves `\r` on lines; `$`-anchored regex matches fewer than search reported (Likely) | `core/replace.ts:118`; `search.rs:184` |
| A3-012 | Safe | README "does not lose your work. Ever." and ARCHITECTURE reload wording overclaim | `README.md:80-91`; `ARCHITECTURE.md:390-394` |
| A4-009 | Safe | `#sync` fans every buffer snapshot to eight subscribers per keystroke, plus a `setTitle` IPC even when unchanged | `src/services/workspace.ts:1894-1914`; `src/app.ts:630-637, 861-869` |
| A4-010 | Safe | Diagnostics bursts are quadratic: map copy plus full re-total per publish | `src/services/lsp/index.ts:318-342`; `src/ui/StatusBar.svelte:15` |
| A4-011 | Safe | Sticky error toasts are unbounded | `src/services/notifications.ts:70-84` |
| A4-013 | Safe | Typing-path browser test uses an empty syntax tree, so grammar-dependent extensions are outside its guarantee | `tests/browser/support/keystroke.ts:47-50` |
| A5-004 | Safe | Contrast suite only measures tokens on flat surfaces; two shipped text-on-wash pairs are under the floor | `tests/token-contrast.test.ts:125-131, 332-340`; `src/ui/CommandPalette.svelte:1174-1201` |
| A5-005 | Safe | macOS key glyphs rendered on every platform; explorer Delete hint hardcoded | `src/services/keymap.ts:198-233`; `src/ui/ExplorerPanel.svelte:493` |
| A5-006 | Safe | At the 640 px minimum the menu bar clips "Tools" behind a hidden scrollbar | `src/ui/MenuBar.svelte:246-275` |
| A5-007 | Safe | Error toasts share one `role="status" aria-live="polite"` region with successes | `src/ui/Toasts.svelte:17` |
| A5-008 | Safe | CodeMirror textbox has no accessible name; palette dialog is "Command palette" in all nine modes; result count unlabelled | `src/ui/EditorPane.svelte:505-516`; `src/ui/CommandPalette.svelte:971, 988` |
| A5-009 | Gated | Editor is a keyboard trap with no documented exit; status bar unreachable by Tab | `src/ui/Welcome.svelte:53-60`; `src/app.ts:3742-3755` |
| A5-010 | Safe | Five hardcoded font sizes outside the scale; token test checks colours only | `src/ui/Sidebar.svelte:239`; `StatusBar.svelte:428`; `AgentPanel.svelte:360, 478`; `SettingsPanel.svelte:499` |
| A5-011 | Safe | README hero screenshots show a 2-view rail; product has 7 | `docs/screenshots/editor.png`; `README.md:15-16` |
| A5-012 | Safe | Known-debt "no Close Window item" row's "ways out" line is macOS-shaped | `ARCHITECTURE.md` §7 |
| A6-004 | Safe | `config_path` rejects separators but not a Windows drive-relative name (`C:evil.json`) | `src-tauri/src/fs.rs:421-436` |
| A6-005 | Safe | Loopback check accepts literal `localhost` and lets the system resolver decide | `src-tauri/src/http.rs:42-50, 67-77` |
| A6-006 | Safe | Umask-default modes: unsaved-buffer backups and `agents.json` readable by other local users on Linux | `src-tauri/src/fs.rs:178-195, 426-433, 466-482` |
| A6-007 | Gated | `files.excludeFromExplorer` is workspace-scoped, so a repo can hide its own entries | `src/services/config/schema.ts:321-326` |
| A6-008 | Safe | Windows LSP fallback routes the configured command line through `cmd /C` | `src-tauri/src/lsp.rs:194-203` |
| A7-011 | Safe | "Undo session" after Save leaves agent text on disk and reports "Took back everything" | `src/services/agent/runtime.ts:568-585`; `AgentPanel.svelte:149-154` |
| A8-007 | Safe | README never states the one default outbound call (GitHub release feed, 10 s after launch) | `README.md:121-127`; `src/services/updates.ts:66-78` |
| A8-008 | Safe | v0.9.1 sits as an unpublished draft while CHANGELOG records it as released | `CHANGELOG.md:262-274` |
| A8-009 | Safe | Release workflow never builds with `--locked`; a tag off main bypasses CI's lockfile check | `.github/workflows/release.yml:124-126, 347` |
| A8-010 | Safe | README "about 4 MB" vs 5.2 to 5.4 MB live assets; `e2e/README.md` stale | `README.md:26, 340`; `e2e/README.md:22-24, 68` |
| A8-011 | Safe | CI: no `permissions:` block, actions pinned by major tag, no Dependabot, no `cargo audit`, `rust-version = "1.77"` never compiled (A6-009 merged) | `.github/workflows/ci.yml:1-14`; `src-tauri/Cargo.toml:6` |
| A8-012 | Safe | `bundle.copyright` is empty, so Info.plist, exe version info and deb/rpm metadata carry no copyright | `src-tauri/tauri.conf.json:51` |

## What is good, so the score is read fairly

- The layering is real and enforced: zero import cycles across 144 files, `Platform` as the one OS door, every service testable against a fake disk with no mocking library.
- The threat model is written down and mostly true: strict CSP, no `{@html}`, argv-fixed git, loopback HTTP enforced in Rust, an 8-key workspace allowlist, plugins in workers contained by CSP and the invoke key.
- The local-model agent path does what the README says: read through one door, propose through one review panel, one transaction, one undo.
- Test discipline: 2,439 unit tests with zero skips, a complexity suite, a real-Chromium typing-path test, a token contrast suite, Rust integration tests, and e2e against the packaged app on three platforms on every PR.
- Accessibility is ahead of most editors this age: every icon button labelled, correct roles on every composite widget, reduced motion honoured in a way themes cannot undo.
- The Known-debt table is honest. Nine of its rows were checked and eight are accurate; two understate.

# A4 Performance

Audited at `54cece6e`. Read-only. Every number below was measured on this machine (Windows 11, Node 24.15, Chromium via Playwright) unless it says "not measured". Scratch scripts lived under the Temp scratchpad and were deleted afterwards.

## Summary

The core editing path is what the docs say it is: CodeMirror's own work is viewport-bounded, every Nox `StateField` on the typing path is a `RangeSet.map`, and `npm run test:editor` ran here in real Chromium and passed (7 tests, 27.9 s). The pure layers are fast and their exponents are guarded in CI. The design also has an unusual number of deliberate, measured caps (`MAX_FILE_BYTES`, `EXACT_DIRTY_LIMIT`, `MAX_DIFF_BYTES`, `INDEX_MAX_FILES`, `MAX_DECORATIONS`, `WORD_COMPLETION_MAX_BYTES`, `MAX_COUNTED_MATCHES`).

Three things sit outside that story, and two of them are on the typing path with default settings. Sticky scroll re-walks the entire syntax tree on every keystroke once a grammar is attached (8.2 ms at 16,000 lines, 37 ms at 64,000), and the browser test that "proves the typing path flat" mounts no grammar, so it cannot see it. With the find bar open, every keystroke and every cursor move rescans the whole document (454 ms per keystroke at 10 MB). And the line diff keeps a copy of Myers' frontier per round, so a file whose lines mostly differ costs O(D^2) time and O(D*(N+M)) memory: 8,000 changed lines took 2.3 s and 2 GB, which puts a 16,000-line reformat or agent rewrite at an out-of-memory renderer.

Sub-score 4/7: the base path is flat and proven, but two default-on features scale with document size per keystroke, one path is quadratic to the point of a crash, and one map grows for the life of the session.

## Sub-score

4 / 7

Justification: A4-001 (sticky scroll, O(document) per keystroke, on by default) and A4-002 (find count, O(document) per dispatch) are hot-path work that scales with the document, which the rubric places at 3 to 4. A4-003 (quadratic diff to OOM) is the cliff, and A4-006 (git bases retained for every file ever opened) is unbounded growth. What keeps this at 4 rather than 3 is that the CodeMirror path itself is genuinely flat and measured, opens and startup are bounded, and every other growth point I traced is capped.

## Findings

```
ID:          A4-001
Lane:        Performance
Severity:    P1
Title:       Sticky scroll walks the whole syntax tree on every keystroke; O(document), on by default, invisible to the typing-path test
Location:    src/editor/sticky.ts:181-201, src/core/symbols.ts:235-272 and 292-306, src/services/config/schema.ts:274, tests/browser/support/keystroke.ts:47-50, ARCHITECTURE.md:2611-2615
Evidence:    sticky.ts:186-190 admits it: "The same cache still misses on every
             keystroke regardless of pane count: `createSymbolCache` keys on tree
             identity, and every edit produces a new tree, so `docChanged` is a
             guaranteed miss and pays the full ~1.378 ms walk on the most
             latency-sensitive path in the editor. Left alone deliberately rather
             than debounced". sticky.ts:199 schedules it on `update.docChanged`.
             symbols.ts:235-272 `fileSymbols` is `tree.iterate({...})` over the
             entire tree. `editor.stickyScroll` defaults to `bool(true, ...)`
             (schema.ts:274).
             Measured (TypeScript grammar, tree fully parsed, best of 5, this
             machine): 2,000 lines 1.50 ms; 16,000 lines 8.20 ms; 64,000 lines
             36.99 ms per call. Linear in document, not in viewport.
             The browser test cannot see it: keystroke.ts:47-50 builds the state
             with `buildExtensions(defaultSettings())`, whose language
             compartment is `languageCompartment.of([])` (extensions.ts:289), so
             `syntaxTree(state)` is empty and the walk is a no-op. ARCHITECTURE
             §6 then generalises: "Flat in document size because every editor
             extension is viewport-bounded".
Impact:      In a 16,000-line TypeScript file with default settings, every
             keystroke pays 8 ms of tree walk on top of the 0.34 ms CodeMirror
             cost, inside the frame. At 64,000 lines (a large generated .ts or
             .json, under the 64 MB cap) it is 37 ms per keystroke: the editor
             drops frames while typing. The stated typing-path guarantee is
             false for any file with a grammar.
Fix sketch:  Compute the pinned rows from the ancestors of the node at the top
             visible position (`tree.resolveInner(pos, 1)` and walk `.parent`),
             which is O(depth) and needs no document walk; or keep the walk but
             defer it off the keystroke (idle callback, or reuse the previous
             symbol list mapped through `tr.changes` and re-walk only after a
             quiet period). Add a grammar-loaded variant to
             tests/browser/typing-path.test.ts so this class of regression is
             caught.
Confidence:  Confirmed (pure-function cost measured; in-app frame cost inferred from it)
Risk class:  Safe
```

```
ID:          A4-002
Lane:        Performance
Severity:    P1
Title:       With the find bar open, every keystroke and cursor move rescans the whole document to count matches
Location:    src/ui/EditorPane.svelte:146-147, src/editor/find.ts:420-445
Evidence:    EditorPane.svelte:146-147, inside `dispatchTransactions`, outside
             the `docChanged` branch:
               publishCursor();
               find.refresh();
             find.ts:443-445:
               refresh(): void {
                 if (this.query.get().length > 0) this.#count();
               }
             find.ts:427-437 `#count` runs `query.getCursor(view.state)` from
             offset 0 and iterates until done or `MAX_COUNTED_MATCHES`
             (10,000). The cap bounds matches, not text scanned: a query with
             few hits walks the whole document every time.
             Measured (`SearchQuery.getCursor` over a doc, non-matching literal,
             best of 3): 1 MB 39.7 ms; 10 MB 454 ms; 64 MB 3,161 ms.
Impact:      Open Find in a 10 MB log or data file, type a term that is rare or
             absent, then keep editing or press arrow keys: each dispatch costs
             ~450 ms synchronously before the view can paint. At 1 MB it is
             already 40 ms, over two frames, on every keystroke.
Fix sketch:  Count only when `docChanged` or the query changed; on selection-only
             dispatches recompute `current` from the cached match positions.
             Debounce the count (the status text does not need to be
             keystroke-accurate), and bound scanned bytes the way
             `WORD_COMPLETION_MAX_BYTES` bounds word completion, reporting
             "10000+" or "counting" past the bound.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A4-003
Lane:        Performance
Severity:    P1
Title:       Line diff is quadratic in changed lines and keeps every Myers frontier, so a large reformat or full-file rewrite runs seconds and gigabytes and can OOM the renderer
Location:    src/core/diff.ts:71-105 (myers), src/services/git.ts:529-557 (#compute), src/services/review.ts:117-121 (stage), tests/complexity.test.ts:49-73
Evidence:    diff.ts:81-82:
               for (let d = 0; d <= max; d++) {
                 trace.push(v.slice());
             `v` is `new Int32Array(2 * (n + m) + 1)` and a copy of it is kept
             for every round, so memory is O(D * (N + M)) and time is O(D^2).
             The prefix/suffix trim (diff.ts:43-52) only helps when the ends
             match; a reindent or a regenerated file leaves D close to N + M.
             Measured, every line different:
               500 lines    9 ms      +9 MB
               1,000 lines  37 ms     +33 MB
               2,000 lines  130 ms    +86 MB
               4,000 lines  603 ms    +365 MB
               8,000 lines  2,347 ms  2,122 MB RSS (1,954 MB in ArrayBuffers)
             Reindent with matching first and last lines: 4,000 lines 420 ms.
             Each doubling is 4x time and 4x memory, so 16,000 lines is on the
             order of 9 s and 8 GB.
             Reachable inside the caps: git.ts:543-544 refuses only above
             `MAX_DIFF_BYTES` (2 MB), and a 16,000-line source file is well
             under 1 MB; `#refresh` runs on every `saved` (git.ts:144-146).
             review.ts:117-120 diffs `before` and `after` with no size cap at
             all. complexity.test.ts:49-60 says in its own words that it holds
             only the one-line-edit case: "`diffText` on a big file with a
             small edit is structurally linear".
Impact:      Format on Save (or any formatter) on a large, previously
             unformatted file, `git checkout` of a rewritten generated file
             while it is open, or an agent proposing a whole-file rewrite
             through Review: the renderer stalls for seconds at 8,000 changed
             lines and exhausts memory somewhere above that. The gutter and the
             review panel are the two features most likely to see a large D.
Fix sketch:  Bound D: if `d` passes a limit (a few thousand) return one
             replacement hunk for the trimmed middle, which is what the user
             sees anyway for a rewrite; store only the `[-d, d]` slice of `v`
             per round (halves memory, still quadratic); or move to a
             linear-space variant. Add a "many lines changed" growth guard to
             tests/complexity.test.ts next to the one-line case.
Confidence:  Confirmed (cost measured); renderer OOM at 16k lines Likely (extrapolated, not run)
Risk class:  Safe
```

```
ID:          A4-004
Lane:        Performance
Severity:    P2
Title:       Nothing degrades between 2 MB and the 64 MB refusal: LSP full-text sync, session backups and grammar all run at full size, and two of those writes happen on the Tauri main thread
Location:    src/services/lsp/documents.ts:8-13 and 156-172, src-tauri/src/lsp.rs:347-361, src/services/session.ts:278-282 and 381-407, src-tauri/src/fs.rs:466-488 and 175-192, src/services/git.ts:529-545, src/ui/EditorPane.svelte:372-380, ARCHITECTURE.md:2656
Evidence:    documents.ts:9-13 chooses full sync deliberately ("Full-text sync,
             deliberately, even where a server offers incremental"), and
             `#changed` (documents.ts:156-170) sends `contentChanges: [{ text }]`
             with `text = this.#workspace.textOf(buffer.id)` 300 ms after the
             last edit; there is no size gate anywhere in services/lsp/.
             lsp.rs:347-361 `nox_lsp_send` is a plain `#[tauri::command]` that
             does `server.stdin.write_all(&frame(&message))` synchronously. The
             Known-debt row at ARCHITECTURE.md:2656 records that plain commands
             "run inline on the thread that handles the IPC message and draws
             the window". A pipe write blocks once the pipe buffer is full
             until the server drains it.
             session.ts:381-407 `#backUp` writes `this.#workspace.textOf(id)`
             for every dirty buffer whose revision moved, 400 ms after the last
             change (session.ts:278-282); fs.rs:485-488 `nox_write_config` is
             also a sync command and goes through `write_then_rename`, which
             calls `file.sync_all()` (fs.rs:186).
             git.ts:530-531 calls `textOf(id)` (a full `doc.toString()`) before
             the `MAX_DIFF_BYTES` check at :543-544.
             Measured `doc.toString()`: 10 MB 4.5 ms, 64 MB 23 ms; then the
             string is JSON-serialised across IPC and copied again in Rust.
Impact:      Typing in a 40 MB file with a language server configured for its
             language: each pause ships 40 MB to Rust, which then blocks the
             main thread writing it into the server's stdin while a single
             threaded server parses the previous 40 MB message. Same file,
             dirty: each pause also writes 40 MB plus fsync on the main thread.
             The window, not just the editor, freezes for the duration.
             Without a server it is "only" a 23 ms toString plus IPC per pause.
Fix sketch:  One `LARGE_FILE_BYTES` threshold (single-digit MB) that skips
             didOpen/didChange, sticky scroll and full-copy backups; check
             `state.doc.length` before `toString` in `#compute`; make
             `nox_lsp_send`, `nox_pty_write` and `nox_write_config`
             `#[tauri::command(async)]` so a slow reader never holds the UI
             thread.
Confidence:  Confirmed for the code paths; the main-thread freeze is Likely (not run in the packaged app)
Risk class:  Gated (a large-file threshold is a user-visible behaviour change and probably a setting)
```

```
ID:          A4-005
Lane:        Performance
Severity:    P2
Title:       Project search has no per-file match cap, so one minified file can produce a single event carrying hundreds of megabytes
Location:    src-tauri/src/search.rs:180-211 (search_file), 376-408 (collector), 36-42 (constants)
Evidence:    search.rs:180-211 collects every match in the file into `matches`
             before returning, each with its own `preview` String of up to
             `PREVIEW_BUDGET` (320) UTF-16 units. The `max_results` check is
             in the collector (search.rs:379-386) and runs only after a whole
             `FileResult` has arrived over the channel:
               total_matches += result.matches.len();
               ...
               if total_matches >= request.max_results {
             `read_text` accepts files up to `max_file_size`, which the
             renderer sets to 8 MB (services/search.ts:44). `ALWAYS_EXCLUDE`
             covers `dist/` and `node_modules/` but not `vendor/`, `public/`,
             `static/` or `assets/`.
Impact:      A two-character query against a repository with an 8 MB minified
             bundle under `public/` yields hundreds of thousands of matches in
             one file: each becomes a 320-char preview (hundreds of MB in Rust),
             then one `nox://search-batch` payload of that size is serialised
             into the WebView, then `results.update` spreads it and the panel
             windows it. The 5,000 cap is checked too late to help.
Fix sketch:  Cap matches per file (say 1,000) inside the line loop and flag the
             file truncated; also check the running total inside `search_file`
             through a shared atomic so a single huge file stops early.
Confidence:  Confirmed by reading (not measured)
Risk class:  Safe
```

```
ID:          A4-006
Lane:        Performance
Severity:    P2
Title:       GitService retains the git index text of every file ever opened; closing a tab never releases it
Location:    src/services/git.ts:102-103, 327-341 (#drop), 195 and 316 (the only clears)
Evidence:    git.ts:102-103 `#bases = new Map<string, string | null>()` holds
             the normalised index text per path. `#drop` (git.ts:327-341), run
             on `buffer-closed`, deletes from `#timers`, `#computed`, blame and
             `hunks`, and never touches `#bases` or `#refetched`. The only
             `#bases.clear()` calls are `refreshAll` (:195) and `#reset` on a
             root change (:316), and `refreshAll` immediately refetches for
             every open file. Each entry is a full second copy of the file
             (`normalizeGitBase` returns a new string).
Impact:      A day-long session that opens and closes 2,000 tracked files of
             50 KB average retains ~100 MB of base text that nothing will read
             again, plus the `#refetched` timestamps. Bounded only by the number
             of files the user has ever opened in the workspace.
Fix sketch:  In `#drop`, delete `#bases` and `#refetched` for the closed
             buffer's path when no other open buffer shares that path.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A4-007
Lane:        Performance
Severity:    P2
Title:       Session restore is serial and eager, and the shell does not paint until it has finished
Location:    src/main.ts:18-20, src/app.ts:376-424 (#boot), src/services/session.ts:161-249 (restore), src/services/workspace.ts:471-531 (open)
Evidence:    main.ts:19-20 mounts only after `await NoxApp.create()`, whose
             `#boot` (app.ts:376-424) awaits thirteen config and plugin steps in
             sequence and then `session.restore()` before `files.setRoot`.
             restore (session.ts:161-249) is `for (const tab of group.tabs)`
             with, per tab, `await this.#platform.exists(tab.path)` then
             `await this.#workspace.open(...)`, and `open` (workspace.ts:483-
             499) awaits `stat` and `readEncodedFile` and then builds an
             `EditorState` from the whole file, regardless of whether the tab
             is the active one. Nothing runs in parallel and nothing is lazy.
             Measured `EditorState.create` with Nox's extensions: 1 MB 3.9 ms,
             10 MB 7.7 ms, 64 MB 72 ms (plus grammar: 8, 11, 61 ms).
Impact:      Thirty restored tabs is about ninety serial IPC round trips plus
             thirty state builds before the first frame; a session that held a
             20 MB file pays that file's read and state build before the window
             shows anything, even though it is a background tab. Boot time was
             not measured in the packaged app.
Fix sketch:  Mount the shell first and restore into it; restore the active tab
             of the active group first, then the rest with `Promise.all`; or
             record background tabs as placeholders that read their file on
             first activation (the session format already carries paths).
Confidence:  Confirmed by reading; wall-clock not measured
Risk class:  Safe
```

```
ID:          A4-008
Lane:        Performance
Severity:    P2
Title:       Terminal output is forwarded one 8 KB read per IPC event with no coalescing or backpressure
Location:    src-tauri/src/pty.rs:222-250, src/ui/TerminalPanel.svelte:129
Evidence:    pty.rs:225-247: `let mut buffer = [0u8; 8192];` then for every
             `reader.read` the decoded chunk is `app.emit("nox://pty-data", ...)`
             immediately. There is no accumulation, no time window, and nothing
             that slows the reader when the renderer is behind. The module
             header says why chunks are forwarded instantly (prompts have no
             newline), which is right for latency and wrong for throughput.
             TerminalPanel.svelte:129 hands each event to `terminal.write`, so
             xterm.js's own write buffering only starts after the IPC hop.
Impact:      `cat` of a 100 MB file, or a build with verbose output, produces
             ~12,800 events per second, each JSON-serialised and delivered
             through the WebView on the main thread. The renderer's main thread
             spends its time in event dispatch rather than in xterm's parser,
             and the UI stutters or freezes until the program finishes. Not
             measured in the app; the shape of the code is the evidence.
Fix sketch:  In the reader thread, after a read, keep draining while data is
             available for up to ~8 ms or 64 KB before emitting; emit on a
             timer if the buffer is non-empty. Optionally let the renderer ack
             so the reader pauses when it is more than N chunks ahead.
Confidence:  Likely
Risk class:  Safe
```

```
ID:          A4-009
Lane:        Performance
Severity:    P3
Title:       Every document change republishes every buffer snapshot to eight subscribers and issues a window-title IPC even when the title has not changed
Location:    src/services/workspace.ts:899-923 and 1894-1914, src/app.ts:630-637 and 861-869, src/platform/tauri.ts:290-292, src/ui/TabBar.svelte:29, src/ui/StatusBar.svelte:114, src/services/git.ts:142 and 344-358, src/services/lsp/documents.ts:55 and 101-121
Evidence:    `applyTransaction` calls `#sync()` on every `docChanged`
             (workspace.ts:921), and `#sync` (:1894-1914) rebuilds a snapshot
             (`snapshot()` includes `isDirty`) for every tab of every group and
             sets `groups`, `activeGroupId`, `buffers` and `activeId`. Signal
             uses `Object.is`, and the arrays are new each time, so every
             subscriber runs: `GitService.#reconcile` (loops all buffers),
             `DocumentSync.#reconcile` (loops all buffers), `app.ts:630-633`
             which calls `#updateWindowTitle()` and `session.schedule()`,
             `TabBar` (`tabLabels($groups.flatMap(...))`, :29), `StatusBar`
             (`$buffers.filter((b) => b.isDirty)`, :114), `ExplorerPanel`,
             `TitleBar`, `CommandPalette`. `#updateWindowTitle` (app.ts:861-
             869) always calls `platform.setWindowTitle`, and tauri.ts:290-292
             always calls `getCurrentWindow().setTitle(title)`: one IPC per
             keystroke with no comparison against the last title.
Impact:      Each piece is small, but the sum is O(open tabs) times eight per
             keystroke plus an IPC and a native SetWindowText. With 100 tabs
             open it is a few hundred microseconds of snapshot building plus
             the IPC round trip on every character typed. Not a frame-breaker;
             it is the kind of thing rule 5 exists to keep off the path.
Fix sketch:  Remember the last title string and skip `setWindowTitle` when
             unchanged; consider a dedicated `changed` signal for document
             edits and republishing snapshots once per microtask.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A4-010
Lane:        Performance
Severity:    P3
Title:       A diagnostics burst is quadratic in the renderer: each publish copies the whole map and re-totals every diagnostic
Location:    src/services/lsp/index.ts:318-342, src/ui/StatusBar.svelte:15, src/ui/problems.ts:98-115, src/ui/ProblemsPanel.svelte:45-46
Evidence:    index.ts:333 `const next = new Map(this.diagnostics.get());` then
             `this.diagnostics.set(next)` (:341) once per `publishDiagnostics`
             notification, with no coalescing. StatusBar.svelte:15
             `problemTotals($diagnostics)` walks every diagnostic of every file
             on each emission (problems.ts:105-113); ProblemsPanel.svelte:45
             rebuilds and sorts every row when open (and the Known-debt row at
             ARCHITECTURE.md:2633 already records it is not windowed).
Impact:      A server that publishes for 5,000 files on startup (rust-analyzer,
             typescript-language-server on a large tree) does ~5,000 map copies
             of up to 5,000 entries and 5,000 full totals passes, plus a Svelte
             update each. Tens of millions of operations on the main thread in
             a burst; a stutter, not a hang.
Fix sketch:  Buffer publishes and emit once per animation frame or
             `setTimeout(0)`; keep running totals updated per URI delta rather
             than recounting.
Confidence:  Confirmed by reading (not measured)
Risk class:  Safe
```

```
ID:          A4-011
Lane:        Performance
Severity:    P3
Title:       Sticky (error) notifications accumulate without bound; per-session agent action trails and answers are copied on every append
Location:    src/services/notifications.ts:70-84, src/services/agent/runtime.ts:351-358 and 467
Evidence:    notifications.ts:72-74 evicts only among `transient = next.filter(
             (n) => n.timeout > 0)`; an error has `timeout: 0` (:37) and is
             never evicted, so `items` grows with every error until each is
             dismissed by hand. runtime.ts:358 `actions.update((current) =>
             [...current, {...}])` copies the whole trail per action with no
             cap (context.ts caps its read log at 500, permissions.ts at 500,
             transactions.ts at 200; this one has none).
Impact:      Autosave `afterDelay` into a read-only file, or a failing formatter
             on save, raises one sticky error per attempt; over an afternoon the
             toast column holds hundreds of identical errors, each a DOM node.
             An agent session that loops on reads grows its trail quadratically
             in copies. Neither is large in bytes; both are unbounded.
Fix sketch:  Collapse duplicate messages into one toast with a count, and cap
             sticky notifications at a small number. Cap the per-session action
             trail the way the read log is capped.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A4-012
Lane:        Performance
Severity:    P3
Title:       The git panel renders one row per changed file with no windowing, and its status read runs on the main thread on every save (Known-debt row understates the frequency)
Location:    src/ui/GitPanel.svelte:275-300, src/services/git.ts:144-170 and 429-455, src-tauri/src/git.rs:202-203 and 361-362, ARCHITECTURE.md:2656
Evidence:    GitPanel.svelte:284 `{#each $status.staged as entry (entry.path)}`
             and :295 `{#each changes as entry (entry.path)}` render every
             entry. `refreshStatus` is called on every `saved` (git.ts:146),
             every external change (:158), every buffer activation more than
             2 s apart (:165-166, `#refetchOnActivation`), and every `.git`
             write (:411). git.rs:202-203 `nox_git_status` is a plain
             `#[tauri::command]`; git.rs:361-362 `nox_git_file_base` likewise.
             The Known-debt row (ARCHITECTURE.md:2656) is accurate that both
             run on the main thread and that "one blob, one index scan" is
             usually quick; it does not say that the status read fires on
             every save and every tab activation.
Impact:      A working tree with 10,000 changed files (a vendored dependency
             update, a generated directory) rebuilds 10,000 keyed rows on every
             save while the panel is open, and runs `git status --porcelain=v2`
             on the window's main thread at the same cadence. On a cold cache
             that is a visible freeze per save. Severity of the debt row should
             read "felt on large dirty trees, per save", not "no failure to
             point at".
Fix sketch:  Window the git panel with the explorer's `ROW_HEIGHT` slice; make
             the two git reads `#[tauri::command(async)]` as the row itself
             suggests.
Confidence:  Confirmed by reading (not measured)
Risk class:  Safe
```

```
ID:          A4-013
Lane:        Performance
Severity:    P3
Title:       The typing-path browser test exercises an empty syntax tree, so any grammar-dependent extension is outside its guarantee
Location:    tests/browser/support/keystroke.ts:47-50, src/editor/extensions.ts:289, CONTRIBUTING.md:88-93, ARCHITECTURE.md:2611-2615
Evidence:    keystroke.ts:47-50 creates the state with
             `buildExtensions(defaultSettings())` and no language; extensions.ts
             :289 is `languageCompartment.of([])`. Every extension that reads
             `syntaxTree` (sticky scroll, folding, bracket matching,
             `indentOnInput`, highlighting) therefore runs against an empty
             tree in the test. CONTRIBUTING.md:88-90 says the test "asserts a
             keystroke costs the same in a 16,000-line document as in a
             2,000-line one" without that qualification, and ARCHITECTURE §6
             says "every editor extension is viewport-bounded".
Impact:      A4-001 shipped past this gate. Any future extension keyed on the
             tree will too. The rule 5 gate is narrower than it is described.
Fix sketch:  Add a second case that loads `javascript({ typescript: true })`,
             forces the parse with `ensureSyntaxTree` before timing, and holds
             the same 3x ratio.
Confidence:  Confirmed
Risk class:  Safe
```

## What is good

- **The CodeMirror path is flat and measured for real.** `npm run test:editor` ran here in Chromium (2 files, 7 tests, 27.9 s, all passed), and `tests/browser/support/keystroke.ts:96-135` handles the `performance.now()` clamp honestly. Every Nox `StateField` on the path is a `RangeSet.map`: `editor/git-gutter.ts:44-49`, `editor/git-blame.ts:66-70`, `editor/plugin-decorations.ts:73-82` (with a filter that drops zero-width survivors so they stop costing), `editor/provenance.ts:47-53`. Search highlighting is `view.visibleRanges` only (`editor/search-highlight.ts:27-36`).
- **`npm run bench` numbers (this machine).** diffText 16k lines one edit 2.9 ms; findMatches 16k 1.2 ms; computeReplacements 16k 0.8 ms; quick-open 16k index one char 2.8 ms, nine chars 10.3 ms, no match 1.8 ms; fuzzyFilter 200 commands 0.09 ms; objectSpans 16k braces 3.9 ms; unfence 512 KB 0.18 ms. All under a 16 ms frame; quick-open's worst case at the cap is the one that matters and `filetree.ts:44-72` records the curve that set `INDEX_MAX_FILES`.
- **Exponent guards in CI** (`tests/complexity.test.ts`) for diff, blame parse, fuzzy, search, replace, and the two ollama scanners, with a 24x budget derived from 90 runs. The comments say what each test does not catch, which is rarer than it should be.
- **Every debounce is where it belongs and has a ceiling where one is needed.** LSP didChange 300 ms (`lsp/documents.ts:28`), git gutter 300 ms per buffer (`git.ts:60`), session 400 ms (`session.ts:278`), plugin `document.changed` 400 ms and only to plugins that decorated the buffer (`plugin/host.ts:383-412`), file watcher 180 ms with a 1 s hard ceiling and a separate 2 s reindex governor (`watcher.ts:28-61`, with the measured storm that motivated the ceiling).
- **Rust filters before IPC.** `watcher.rs:22-34` drops `.git`, `node_modules`, `target` and the rest before emitting; `search.rs` batches every 90 ms or 40 files and cancels the previous search on a new one (`search.rs:214-238`); `lsp.rs` frames by byte count and drains the buffer per message so the header scan stays O(header).
- **Grammars are lazy, chunked per language, and never on the open path** (`editor/languages.ts:1-11`, `scripts/chunks.mjs`, `EditorPane.svelte:372-380`). No Lezer parse budget is overridden anywhere in `src/` (searched for `Work`, `parseWorker`, `syntaxParserRunning`); the one forced parse is the symbol palette's 100 ms `ensureSyntaxTree` (`CommandPalette.svelte:780, 818`), user-triggered.
- **File open is bounded and cheap.** `EditorState.create` with Nox's full extension set: 1 MB 3.9 ms, 10 MB 7.7 ms, 64 MB 72 ms, 100 MB 169 ms (the cap refuses above 64 MB, `workspace.ts:122`). `looksBinary` stops at 8 KB (`workspace.ts:1975-1981`). `isDirty` compares lengths first and walks only up to `EXACT_DIRTY_LIMIT` (`workspace.ts:214-224`); measured `doc.eq` is 1.8 ms at 1 MB, so the 2 MB cut-off is placed sensibly.
- **Explorer and search results are windowed** (`ExplorerPanel.svelte`, `SearchPanel.svelte:85-103`), directories load lazily, and the quick-open index is built off the boot path, bounded at 14,000 files and 12 levels, and abandoned on root change (`filetree.ts:194-226`).
- **Closed buffers really are released.** `workspace.close` deletes the `Buffer` (and so its `EditorState` and history) plus `#mru`, `#undoIndex`, `#redoIndex` (`workspace.ts:584-596`); `DocumentSync` sends didClose and drops timers (`documents.ts:176-193`); plugin decorations drop per buffer (`plugin/decorations.ts:69`); LSP diagnostics are cleared per server on exit (`lsp/index.ts:384-387`). Bounded logs: transactions 200 (`transactions.ts:125`), context reads 500 (`context.ts:123`), permission decisions 500 (`permissions.ts:332`), diagnostics log 400 lines (`diagnostics.ts:38`), recent files 24, jobs retire on settle, search results 5,000.
- **The terminal service keeps no copy of output** (`terminal.ts:6-14`); scrollback is xterm's, default 1,000 lines, max 100,000 (`schema.ts:168`).

## Not checked

- **Startup wall-clock in the packaged app.** Reasoned from `#boot` and `restore` (A4-007); not timed. The Windows build was not launched during this audit.
- **The IPC cost of a large file crossing as a JSON string**, and peak memory with the transferred string, parsed string and `Text` tree all live. `workspace.ts:114-120` already records both as unmeasured; still unmeasured here. My `EditorState.create` numbers are renderer-side only.
- **A4-004's main-thread freeze and A4-008's event flood** are inferred from the command attributes and the reader loop, not reproduced against a live server or shell.
- **Memory over a genuinely long session** was audited by reading every growth point I could find (survey below), not by running the app for hours with a heap profiler.
- **`core/anchor.ts` and `core/tab-labels.ts`** are not on a hot path: `resolveAnchor` splits the whole text but runs on a note jump, and `tabLabels` is O(tabs times path depth) per `#sync` (covered in A4-009). Neither warranted a finding of its own.
- **Language-server-side costs** (what a server does with a 40 MB didOpen) are outside Nox's code and were not measured.

## Survey: what runs per keystroke

| Where | What | Cost | Bounded by |
|---|---|---|---|
| `editor/git-gutter.ts:44-49` | `RangeSet.map` | O(marks) | hunks in file |
| `editor/git-blame.ts:66-70` | `RangeSet.map` | O(marks) | lines blamed, empty when off |
| `editor/plugin-decorations.ts:73-82` | `map` + filter | O(marks) | `MAX_DECORATIONS` 2,000, measured flat |
| `editor/provenance.ts:47-53` | `map` + subtract | O(marks) | change-set spans |
| `editor/search-highlight.ts:41-58` | rebuild decorations | O(visible) | `view.visibleRanges` |
| `editor/sticky.ts:199` | full `fileSymbols` walk | **O(document)** | nothing (A4-001) |
| `editor/find.ts:443` via `EditorPane.svelte:147` | count scan | **O(document)** while find open | 10,000 matches, not text (A4-002) |
| `EditorPane.svelte:146` `publishCursor` | `cursorInfo` | O(1) | |
| `EditorPane.svelte:149-155` | reset autosave and plugin timers | O(1) | |
| `workspace.ts:899-923` `applyTransaction` | `#sync` snapshots | O(open buffers) | tab count (A4-009) |
| `workspace.ts:214-224` `isDirty` | length compare; `doc.eq` on same-length edits | O(1), or O(doc) up to 2 MB | `EXACT_DIRTY_LIMIT` |
| `git.ts:344-358` `#reconcile` | loop, schedule timer | O(open buffers) | 300 ms timer per buffer |
| `lsp/documents.ts:101-121` `#reconcile` | loop, schedule timer | O(open buffers) | 300 ms timer |
| `app.ts:630-633` | `setWindowTitle` IPC, `session.schedule` | 1 IPC | none (A4-009) |
| `TabBar.svelte:29`, `StatusBar.svelte:114`, `ExplorerPanel.svelte:110-125` | derived over tabs | O(open buffers) | tab count |
| `keymap.ts:622-627` capture keydown | chord lookup | O(bindings for chord) | |

After a pause (debounced, so O(document) per pause rather than per key): LSP didChange with the full text at 300 ms; git gutter `textOf` + `diffText` at 300 ms (2 MB cap on the diff, none on the toString); session backup full text + fsync at 400 ms; plugin `document.changed` at 400 ms.

## Survey: memory over a long session

| Store | Bound | Evidence |
|---|---|---|
| Transaction log | 200 entries | `transactions.ts:125 and 139-145` |
| Permission decisions | 500 | `permissions.ts:331-332` |
| Context read log | 500 | `context.ts:123, 160-165` |
| Agent action trail | **none** per session | `runtime.ts:358` (A4-011) |
| Notifications | 4 transient; **errors unbounded** | `notifications.ts:70-84` (A4-011) |
| Diagnostics service | 400 lines | `diagnostics.ts:37, 179` |
| LSP diagnostics map | per file; cleared on server exit | `lsp/index.ts:384-387` |
| LSP `DocumentSync.#open` | per open buffer; dropped on close | `documents.ts:176-193` |
| LSP progress | per token, replaced on end | `lsp-progress.ts:86-102` |
| Git `#bases` / `#refetched` | **per path ever opened, never dropped** | `git.ts:327-341` (A4-006) |
| Git `hunks`, `blame`, `#computed` | dropped on close | `git.ts:327-341` |
| Jobs | retire on settle or cancel | `jobs.ts:169 and 208-221` |
| Closed buffers | `Buffer`/`EditorState` deleted; indexes cleaned | `workspace.ts:584-596` |
| Session `#backups` | released when not live | `session.ts:345-351` |
| Search results | 5,000 matches total, per-file unbounded in Rust | `search.ts:44`, `search.rs:194-212` (A4-005) |
| Quick-open index | 14,000 paths | `filetree.ts:76` |
| Recent files / folders | 24 / 12 | `workspace.ts:1891, 1625` |
| Terminal output | not kept; xterm scrollback setting | `terminal.ts:6-14`, `schema.ts:168` |
| Watcher `#warned` | cleared on buffer close | `app.ts:600`, `watcher.ts` |

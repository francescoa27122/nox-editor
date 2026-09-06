# A2 Architecture and Systems

## Summary

The architecture is real and mostly enforced: `eslint.config.js` mechanically holds the `Platform` door and the headless-services rule, a hand-rolled import graph over all 144 `src/` files finds zero value-import cycles, `core/` has no side effects, and every failure path in the renderer funnels through one sink into toasts and `diagnostics.log`. What the design does not have is a concurrency model. The renderer treats `await` as if the buffer were frozen underneath it, and the Rust host runs 48 of its 49 IPC commands inline on the thread that draws the window. The strongest finding is confirmed by a reproduction run against the real `WorkspaceService`: a keystroke typed while a save is writing to disk is reverted from the buffer and the tab is marked clean (A2-001). The second is that the Known-debt row "the two older git reads still run on the main thread" undercounts by 46 commands, including `git commit` with its hooks, every fsync, and every whole-document `didChange` write into a language server's stdin (A2-002). Reload Window does not run `dispose()` despite two comments saying it does, so each reload orphans every language server (A2-003). Sub-score 11 of 18: a sound, enforced design carrying multiple real concurrency defects.

## Sub-score

11 / 18

Justification: the boundaries are clean and lint-enforced, there are no import cycles and the error strategy is coherent, which keeps this out of the 4 to 7 band. But A2-001 is a confirmed data race with a user-visible loss, A2-002 is a systemic main-thread blocking model rather than the two commands the debt table admits to, and A2-003, A2-005 and A2-006 are further lifecycle and backpressure issues, which is "multiple concurrency issues" under the rubric and caps the score at the top of the 8 to 11 band.

## Findings

```
ID:          A2-001
Lane:        Architecture and Systems
Severity:    P1
Title:       A keystroke typed while a save is in flight is reverted from the buffer and the tab is marked clean
Location:    src/services/workspace.ts:966-1019
Evidence:    `save()` captures the text before the await and compares against the live document after it:
               973:  let text = buffer.state.doc.toString();
               983:  await this.#platform.writeEncodedFile(buffer.path, onDisk, buffer.encoding);
               991:  if (text !== buffer.state.doc.toString()) {
               992:    const transaction = buffer.state.update({
               993:      changes: { from: 0, to: buffer.state.doc.length, insert: text },
               996:    buffer.state = transaction.state;
               999:    this.events.emit('buffer-reset', { id });
              1002:  buffer.savedDoc = buffer.state.doc;
              1003:  buffer.savedChangeCount = buffer.changeCount;
             The comment at 989-990 says this branch exists for "formatting on save", but the condition is true for any
             edit that landed during the await. The branch assigns `buffer.state` directly rather than dispatching to
             the pane, then `buffer-reset` makes `EditorPane` call `view.setState(state)` (src/ui/EditorPane.svelte:210-212,
             321), so the pane adopts the pre-save text.
             Executed, not inferred. A scratch test (deleted) subclassed `MemoryPlatform` to hold `writeEncodedFile`
             open, exactly as `tests/notes.test.ts:30-45` does for config writes, opened a file holding `hello`,
             applied ` world`, called `save`, applied `!!!` while the write was held, then released it. Output:
               {"onDisk":"hello world","inBuffer":"hello world","dirty":false}
             The `!!!` is gone from the buffer and the tab reports clean. `tests/workspace.test.ts` has no test that
             edits during a save (its save tests are at 87, 148, 154, 171, 300, 464, 508 and all await the save first).
Impact:      With `files.autoSave: afterDelay` (src/ui/EditorPane.svelte:387-398) the save fires after a typing pause
             and the user routinely resumes typing while the write, the IPC hop and the `sync_all` in
             `src-tauri/src/fs.rs:186` are still running. Characters typed in that window vanish from the screen a
             moment later, and the tab shows clean while the disk holds text the user never saw as final. The text is
             on the undo stack, so Ctrl+Z recovers it, but nothing tells the user it happened. Manual Ctrl+S on a large
             file over a slow disk has the same window. `reloadFromDisk` (1089-1148) shares the shape: the dirty check
             in the watcher runs before an await, and edits made during the read are overwritten by the disk text.
Fix sketch:  Compare the post-write document against the revision captured at 973, not against `text`: if the revision
             moved during the await, do not replace the document and do not mark it clean; set `savedDoc` to the
             `Text` that was actually written and let `isDirty` fall out of the comparison. Add the held-write test.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A2-002
Lane:        Architecture and Systems
Severity:    P1
Title:       48 of 49 IPC commands run inline on the main thread, including git commit with hooks, every fsync and every whole-document write into a language server
Location:    src-tauri/src/lib.rs:129-180; src-tauri/src/git.rs:263-331; src-tauri/src/fs.rs:145-195; src-tauri/src/lsp.rs:346-358; src-tauri/src/agent.rs:194-207; src-tauri/src/pty.rs:285-297
Evidence:    `generate_handler!` registers 49 commands (lib.rs:129-180). Exactly one is `#[tauri::command(async)]`,
             `nox_git_blame` (git.rs:474). The Tauri macro only moves a body off the calling thread for that
             attribute: tauri-macros 2.6.3 `src/command/wrapper.rs:263-266` labels a plain command `"sync"` and an
             `(async)` one on a non-async fn `"sync_threadpool"`. The project's own Known-debt row agrees on the
             mechanism: "a plain `#[tauri::command]` ... runs inline on the thread that handles the IPC message and
             draws the window" (ARCHITECTURE.md §7, row "The two older git reads still run on the main thread").
             That row names two reads. The commands that block are:
               - `nox_git_commit` (git.rs:264-315): `child.wait_with_output()` at 305 runs `git commit`, which runs
                 pre-commit and commit-msg hooks; `nox_git_switch` (322-331) runs a checkout; `nox_git_stage`,
                 `nox_git_unstage`, `nox_git_status`, `nox_git_branches` each spawn git and wait.
               - `nox_write_text_file` and `nox_write_encoded_file` go through `write_then_rename`, which calls
                 `file.sync_all()` (fs.rs:186), a device flush, on every save.
               - `nox_read_encoded_file` reads up to `MAX_FILE_BYTES` (64 MB, src/services/workspace.ts:122) and
                 decodes it inline (fs.rs:95-108).
               - `nox_lsp_send` holds the registry `Mutex` while `write_all` pushes the message into the server's
                 stdin pipe (lsp.rs:348-357). `DocumentSync` sends the entire document on every debounced change
                 (`contentChanges: [{ text }]`, src/services/lsp/documents.ts:164-167, debounce 300 ms at 28), so on a
                 multi-megabyte file each pause in typing writes megabytes through a pipe whose kernel buffer is
                 64 KB on Linux and smaller on Windows; the write returns only when the server has drained it.
                 `nox_agent_send` (agent.rs:195-207) and `nox_pty_write` (pty.rs:286-297) have the same shape.
               - `nox_trash` (fs.rs:337-355) and `nox_copy_file` (358-371) do their IO inline.
Impact:      A repository with a pre-commit hook that runs a linter or a test suite freezes the whole window, menu
             bar and all, for the hook's duration when the user clicks Commit. Saving to a slow or network disk
             freezes the window for the fsync. Typing in a large file with a language server that is busy indexing
             freezes the window until the server reads the document. None of these are rare configurations for a
             text editor's audience.
             Known-debt assessment: the row's mechanism is right and its scope is wrong. It should say that every
             command except blame runs on the main thread and that the writes are the ones that hurt.
Fix sketch:  Mark every command that spawns a process, waits, flushes or writes to a pipe `#[tauri::command(async)]`;
             the bodies need no change because they have nothing to await. For the three `*_send` commands, take the
             stdin handle out from under the registry lock (an `Arc<Mutex<ChildStdin>>` per process) so one slow
             consumer cannot hold the registry against `kill` and the reader threads' `remove`.
Confidence:  Confirmed (mechanism and call sites); the felt durations are Likely and were not measured on this machine
Risk class:  Safe
```

```
ID:          A2-003
Lane:        Architecture and Systems
Severity:    P2
Title:       Reload Window never runs dispose(), so every reload orphans the running language servers; two comments say the opposite
Location:    src/app.ts:3218-3234, 1434-1443, 5285-5323; src/ui/App.svelte:57-78; src/platform/tauri.ts:503-505
Evidence:    The command body is a bare reload:
               3230:  run: () => {
               3231:    this.notifications.info('Reloading…');
               3232:    globalThis.location.reload();
             `dispose()` is wired only to `platform.onCloseRequested` (471-475), which fires on window close, not on a
             navigation. The only thing that runs on reload is `App.svelte`'s `beforeunload` (62-71), which calls
             `session.save()`, `config.flush()`, `killAllAgents()` and `closeAllTerminals()`, all `void`, and does not
             stop language servers or plugins. `stopAllLanguageServers` (tauri.ts:503-505) has exactly one caller,
             `dispose()` at 5303. Yet the code claims otherwise in two places: 1441-1443 "the teardown it was
             reaching for is a *reload* concern and now lives in `dispose()`, which is what a reload actually runs",
             and 5299-5301 "a reload does not kill the processes the renderer started, so without this every reload
             leaves a server orphaned". The Known-debt row "Reloading the window drops in-memory agent state" says the
             reload "kills any running agent", which is true via `beforeunload`, and says nothing about servers.
             Teardown is therefore split across two paths that disagree: `dispose()` stops LSP and plugins and awaits
             the flushes; `beforeunload` kills agents and terminals and cannot await anything.
Impact:      Each Reload Window starts a fresh set of servers via `#restartLanguageServers` (1432-1447) while the
             previous set keeps running with nobody reading its stdout (the reader thread breaks only when `emit`
             fails, lsp.rs:274-290, and a reloaded webview still accepts emits). A rust-analyzer or tsserver per
             reload accumulates until quit, when `nox_lsp_stop_all` drains the registry. On reload the session index
             write in `beforeunload` is issued after an `await Promise.all(writes)` (src/services/session.ts:368-369),
             one microtask after the handler returns, so whether it lands depends on the webview honouring an IPC
             call from an unloading page; the per-buffer backups are dispatched synchronously and do land.
Fix sketch:  Make `view.reloadWindow` `await this.dispose()` before `location.reload()`, delete the `beforeunload`
             handler's duplicate teardown, and correct the two comments. Then there is one teardown path.
Confidence:  Confirmed (control flow); the process count was not observed in the packaged app
Risk class:  Safe
```

```
ID:          A2-004
Lane:        Architecture and Systems
Severity:    P2
Title:       On Linux, opening a folder registers inotify watches for every directory on the main thread under the watcher lock
Location:    src-tauri/src/watcher.rs:113-150; notify 8.2.0 src/inotify.rs:400-412
Evidence:    `nox_watch` is a plain `#[tauri::command]` (A2-002 applies). It takes the `WatcherState` lock at 115-118
             and calls `watcher.watch(Path::new(&path), RecursiveMode::Recursive)` at 145-147 while holding it.
             `notify`'s inotify backend implements a recursive watch by walking the tree synchronously inside that
             call:
               400: fn add_watch(&mut self, path: PathBuf, is_recursive: bool, mut watch_self: bool) -> Result<()> {
               407:     for entry in WalkDir::new(path)
               412:         self.add_single_watch(entry.into_path(), is_recursive, watch_self)?;
             The walk visits every directory the DENY list does not prune (the DENY list is applied to events at
             129-134, not to the walk). FSEvents on macOS and ReadDirectoryChangesW on Windows register in constant
             time, so this is Linux-specific.
Impact:      Opening a large monorepo on Linux freezes the window for the duration of a full directory walk plus one
             `inotify_add_watch` syscall per directory, and hits `max_user_watches` on big trees, which surfaces as
             "could not watch" after the freeze rather than before it.
Fix sketch:  Mark `nox_watch` `(async)`, or construct and start the watcher on a spawned thread and store it into the
             registry when ready; either way stop holding the registry lock across `watch()`.
Confidence:  Likely (code path confirmed in both crates; not timed on a Linux machine during this audit)
Risk class:  Safe
```

```
ID:          A2-005
Lane:        Architecture and Systems
Severity:    P2
Title:       Reader threads reap the child while holding Mutex<Child>, so kill on the main thread blocks behind a child that closed stdout but kept running
Location:    src-tauri/src/agent.rs:140-147 and 216-221; src-tauri/src/lsp.rs:293-300 and 390-395; src-tauri/src/pty.rs:255-261 and 354-362
Evidence:    In every reader thread the wait holds the lock for the whole wait:
               agent.rs:143: let code = child
               agent.rs:144:     .lock()
               agent.rs:146:     .and_then(|mut child| child.wait().ok())
             The guard returned by `lock()` lives until the closure returns, which is when `wait()` returns, which is
             when the process exits. `nox_agent_kill` runs on the main thread (A2-002) and does:
               agent.rs:219: if let Ok(mut child) = agent.child.lock() {
               agent.rs:220:     let _ = child.kill();
             The reader thread reaches `wait()` when stdout returns EOF (agent.rs:127-138 falls through on `Ok(0)`).
             A child that closes its stdout and keeps running, which is what a daemonising agent or a server that
             redirects its output after startup does, puts the reader into `wait()` holding the lock, and every later
             `kill` for that id parks the main thread until the child decides to exit on its own. The same three
             lines exist in `lsp.rs` and `pty.rs`. `nox_agent_kill_all` and `nox_lsp_stop_all` iterate every entry
             (agent.rs:237-242, lsp.rs:382-384), so one such child blocks quit's `stopAllLanguageServers` at
             src/app.ts:5303 and with it the session flush that follows.
Impact:      A misbehaving child makes Kill, Reload Language Servers and Quit hang the window. The 10 s shutdown
             timeout in src/services/lsp/transport.ts:15 does not help because the hang is in the Rust command, not
             in the request.
Fix sketch:  Call `child.kill()` without taking the same mutex the waiter holds: keep a separate handle for signalling
             (the pid, or `Child::id()` captured at spawn), or wait on a cloned handle, and make `kill` a
             try-then-signal rather than a blocking lock.
Confidence:  Likely (Rust semantics are certain; the triggering child behaviour was not reproduced)
Risk class:  Safe
```

```
ID:          A2-006
Lane:        Architecture and Systems
Severity:    P2
Title:       No backpressure between a child's output and the webview: terminal, agent and server output is emitted as fast as it is produced
Location:    src-tauri/src/pty.rs:223-253; src-tauri/src/agent.rs:117-138; src/ui/TerminalPanel.svelte:129-130; src/services/terminal.ts:86
Evidence:    The pty reader emits every chunk immediately:
               pty.rs:228: match reader.read(&mut buffer) {
               pty.rs:233:     let data = decoder.push(&buffer[..count]);
               pty.rs:238:     if app.emit("nox://pty-data", DataPayload { id: id.clone(), data }).is_err()
             Nothing throttles, coalesces or waits for the renderer to catch up. Each `emit` serialises JSON and posts
             a script evaluation to the webview, which runs on the main thread. The renderer writes straight into
             xterm with no write callback (`terminal.onData((data) => view?.write(data))`,
             TerminalPanel.svelte:130), so xterm's internal write queue grows without bound. The agent reader
             (agent.rs:127-138) emits one event per line, which for a chatty agent is one main-thread hop per
             `print`. Compare `search.rs`, which batches deliberately (BATCH_INTERVAL and BATCH_FILES at 36-38): the
             author solved this problem for search and not for the three streaming processes.
Impact:      `cat` of a large file, a build with verbose output or `yes` in the integrated terminal queues tens of
             thousands of main-thread emits and the editor stops responding until the queue drains. This is the
             single most common way a user stresses an integrated terminal.
Fix sketch:  Coalesce in the reader threads the way `run_search` does: accumulate for a few milliseconds or until N
             KB, then emit one event; on the renderer side use xterm's write callback to gate the next batch.
Confidence:  Likely (mechanism confirmed; throughput not measured in the packaged app)
Risk class:  Safe
```

```
ID:          A2-007
Lane:        Architecture and Systems
Severity:    P2
Title:       app.ts is both the composition root and the home of several features' logic, so the file is 5,338 lines and every feature test boots the whole application
Location:    src/app.ts:135-5324
Evidence:    `#registerCommands` runs from 2715 to 4533 (1,818 lines, all 160 command definitions as one array
             literal). Around it, `NoxApp` carries logic that belongs in services by CONTRIBUTING.md rule 1's own
             argument: note anchor location and healing (2327-2460), review application (1178-1400), LSP rename and
             workspace-edit planning (4883-5140), location listing (5184-5240), format-on-save policy (1770-1798),
             pending code actions state (4995), and provenance navigation (947-1002). The class exposes ~60 public
             methods and 3 signals of its own (`view`, `locations`, `cursor`, 191-206) that components read via
             `useApp()`. Consequence in the tests: 39 files under `tests/` import `../src/app` to test one feature
             each (`notes-anchor-heal.test.ts`, `lsp-code-action-apply.test.ts`, `git-diff-view.test.ts`, ...), which
             means constructing every service and running `#registerCommands` to test note anchor healing.
             The dependency graph itself is clean: zero value-import cycles across `src/` (hand-rolled Tarjan over
             144 files, madge not installed); only two type-only cycles (`transactions.ts` with `workspace.ts`, and
             `agent/provider.ts` with `agent/protocol.ts`), both harmless. Services are constructed in one place
             (220-365) with explicit constructor injection and late-bound callbacks where a cycle would otherwise
             form (`search.onReveal`, `permissions.setPrompter`, `commands.setGuard`).
Impact:      The cost is on extension, not on today's build. Adding a command means editing a 1,800-line array plus
             `#registerKeybindings` (4533) plus `services/menu.ts` if it has a menu slot; there is already an
             untracked `.claude/skills/new-command/` skill written to walk that path. Any feature logic added to
             `NoxApp` is untestable without the full boot. Six months of this is a 10,000-line file.
Fix sketch:  Split `#registerCommands` into per-category registration modules that take `NoxApp` (or narrower
             interfaces) and return `Command[]`; move the note-anchor, review-apply and LSP-edit logic into the
             services that own the data. No behaviour change, and the registry already supports registering in
             groups.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A2-008
Lane:        Architecture and Systems
Severity:    P3
Title:       Boot runs the project walk and the workspace-config load twice, and the async start() methods have no in-flight guard against overlap
Location:    src/app.ts:376-426 and 580-588; src/services/filetree.ts:120-134 and 194-227; src/services/watcher.ts:96-113
Evidence:    `#wireServices` subscribes to the root (580-588):
               580: this.workspace.rootPath.subscribe((root) => {
               581:   void this.files.setRoot(root);
               582:   void this.watcher.start(root);
               585:   void this.config.loadWorkspace(root);
             `Signal.set` emits synchronously (src/core/signal.ts:26-30), so `session.restore()` -> `openFolder` ->
             `rootPath.set(path)` (workspace.ts:1624) fires this during `#boot` line 405. `#boot` then calls the same
             two things again explicitly: `await this.config.loadWorkspace(...)` at 386 (with a null root, before
             restore) and `await this.files.setRoot(this.workspace.rootPath.get())` at 418. `setRoot` clears
             `#dirs`, reloads the root and starts `buildIndex()` (filetree.ts:120-134), whose only abort check is
             `if (this.#root !== root) return` (221), which two walks of the same root both pass. `FileWatcherService
             .start` guards with `root === this.#root && this.#unwatch` (97), which is false while the first call's
             `await this.#platform.watch(...)` (103) is pending, so a second overlapping call registers a second
             `listen('nox://fs-change')` (tauri.ts:228) and the first disposer is overwritten at 103 and leaked.
Impact:      Every launch with a restored folder walks the project tree twice concurrently; on a 14,000-file tree
             that is two full `readDir` sweeps competing for the same IPC channel during the seconds the user is
             waiting for the window. The watcher overlap needs two root changes inside one IPC round trip, which the
             `rootPath` dedupe makes rare, so that half is a latent leak rather than a present one.
Fix sketch:  Delete the explicit `files.setRoot` and the pre-restore `loadWorkspace` from `#boot` and let the
             subscription own them, or give `setRoot`, `buildIndex` and `start` a generation token checked after
             each await.
Confidence:  Confirmed (ordering is synchronous and read from code; the doubled IO was not traced at runtime)
Risk class:  Safe
```

```
ID:          A2-009
Lane:        Architecture and Systems
Severity:    P3
Title:       Components reach `app.platform` and `app.workspace` directly, which the lint does not catch and which leaves window controls outside the command registry
Location:    src/ui/TitleBar.svelte:82, 101, 256, 264, 272; src/ui/App.svelte:62-71; src/ui/ReferencesPanel.svelte:53; eslint.config.js:270-294
Evidence:    `nox/components-do-not-construct-services` (eslint.config.js:277-293) forbids importing
             `@platform/index` and `@tauri-apps/*` from a component. It cannot see a component that gets the platform
             from `useApp()`:
               TitleBar.svelte:256: onclick={() => void app.platform.minimizeWindow()}
               TitleBar.svelte:264: onclick={() => void app.platform.toggleMaximizeWindow()}
               TitleBar.svelte:272: onclick={() => void app.platform.closeWindow()}
               App.svelte:67:       void app.platform.killAllAgents();
               ReferencesPanel.svelte:53: else await app.workspace.open(row.path);
             Minimise, maximise and close have no `Command`, so they are absent from the palette and from
             `keybindings.json`, contrary to "Every user action is a Command" (CLAUDE.md, and ARCHITECTURE.md §2). The
             Known-debt row "The menu has no Close Window item" says "Nox has no `window.close` command to offer", so
             the gap is known for the menu but not recorded as a rule violation. `ReferencesPanel` opening a file
             bypasses `file.open`'s capability check and its `resourceFrom`.
             The other layering probes came back clean: no `document`, `window` or `navigator` use in `services/` or
             `core/` (the one `window.workDoneProgress` at src/services/lsp/session.ts:326 is an LSP capability
             object); `@codemirror/view` outside `editor/` is type-only in `app.ts` and a comment in `workspace.ts`;
             `core/` has no `console`, `Date.now`, `Math.random` or DOM access; `services/` never imports `ui/`.
Fix sketch:  Add `window.minimize`, `window.toggleMaximize`, `window.close` commands and dispatch them from
             `TitleBar`; route `ReferencesPanel` through `file.open`. A `no-restricted-syntax` rule on
             `MemberExpression[object.property.name="platform"]` inside `src/ui/**` would hold the line.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A2-010
Lane:        Architecture and Systems
Severity:    P3
Title:       The two Platform implementations are kept in step by hand-mirrored phrases, not by a shared contract suite, and three Rust comments describe a collision the renderer already prevents
Location:    src/platform/memory.ts:39-66; src/platform/tauri.ts:75-101; src-tauri/src/git.rs:913-918; src-tauri/src/agent.rs:149-152; src-tauri/src/lsp.rs:302-305; src-tauri/src/pty.rs:263-265
Evidence:    `MemoryPlatform` (1,312 lines) and `TauriPlatform` (894 lines) each restate the 19-field capability
             table and each implement the 71-method interface. Nothing runs one suite against both: the fake's git
             behaviour is pinned by Rust tests that assert git's wording so the fake can copy it ("The phrase the
             MemoryPlatform fake mirrors -- this assertion is the tripwire that keeps fake and real from drifting
             apart", git.rs:913-918), and the search walker already diverged in a way the debt table records ("The
             browser search walks `node_modules` and `.git`"). Separately, the three reader threads carry the same
             comment: "Forget it, or the id stays registered for the life of the app and spawning under it again is
             refused as 'already running' -- which is exactly what happens after the window reloads and the
             renderer's counter starts over" (agent.rs:149-152). `tauri.ts` prevents that: ids carry a per-load token
             (`#instance` at 70, used at 435, 623, 695, 765). The comments describe a failure that cannot occur and
             the real reason for the `remove` (a stale entry) is not written down.
Impact:      A method added to one platform and forgotten in the other is caught by TypeScript, but a behaviour that
             differs (an error code, a path spelling, an exclusion list) is caught only when someone writes a Rust
             test that quotes the fake. That is how the search divergence shipped. The stale comments will send the
             next reader looking for a reload bug that is not there.
Fix sketch:  A contract test file parameterised over `Platform` factories, run against `MemoryPlatform` in `unit` and
             against `TauriPlatform` in the `e2e` job, for the observable behaviours (error codes, `readDir` order,
             atomic write, exclusion list). Rewrite the three comments to say what they do.
Confidence:  Confirmed
Risk class:  Safe
```

## What is good

- **The Platform door is enforced, not just described.** `eslint.config.js:207-228` forbids `@tauri-apps/*` and the storage globals everywhere but `src/platform/`; `239-268` forbids `@codemirror/view` in `core/` and `services/` and repeats `NO_TAURI` there because flat config replaces rule options rather than merging them, which the comment says was found by planting a violation. The grep-based probes in this audit found no leak past it.
- **Zero import cycles.** A Tarjan pass over all 144 `src/` files found no value-import cycle and two harmless type-only ones. Services are built once in `NoxApp`'s constructor with constructor injection, and the three places a cycle would form use late-bound callbacks instead (`src/app.ts:239, 244, 248`).
- **`core/` is genuinely pure.** No `console`, `Date.now`, `Math.random`, `fetch` or DOM access anywhere under `src/core/`.
- **One failure sink.** `CommandRegistry.setFailureSink` (`src/app.ts:259-261`) plus `unhandledrejection` and `error` backstops (`1031-1102`) plus the notifications tap into `diagnostics.log` (`269-276`) means a failure anywhere in the renderer ends up in a toast and a log without each site knowing. The `ResizeObserver loop` filter at 1088 records its own earlier bug honestly.
- **The 74 bare `catch {}` blocks are almost all deliberate and say why.** Sampled thirty; each is either "absence is the answer" (`git.ts`, `notes.ts`, `session.ts:263-272`), a fall-through to a second strategy (`app.ts:2639`), or teardown that must not stop the other teardowns (`jobs.ts:150`). Rust has exactly two `unwrap`/`expect` outside test modules, `http.rs:75` and `lib.rs:182`, both justified in place.
- **Rust lock discipline is otherwise careful.** Every `Mutex` acquisition maps poisoning to a typed error string; `http.rs` never holds its lock across an await (`99-106`, `130-134`); `search.rs` batches, cancels on `max_results`, and joins its walker (`343-414`).
- **Per-load ids in `tauri.ts:69-70`** close the id-reuse race that the Rust comments still worry about.
- **`dispose()` order is argued for.** Notes before config before session, diagnostics last in a `finally` (`src/app.ts:5297-5322`), with LSP shutdown capped at 10 s by `transport.ts:15`.
- **State has one source of truth per concern.** `WorkspaceService` keeps private `#groups`/`#activeGroupId` and projects four signals from them in one `#sync()` (`workspace.ts:1894-1914`); `activeId` is documented as derived and never set directly. The only double-writer found, `ui.reviewOpen` (set from `review.staged` at 489 and cleared on tab change at 532), is deliberate and commented.

## Not checked

- **Runtime measurement of A2-002, A2-004 and A2-006.** The mechanisms are read from the macro and the code; how long a hook, an inotify walk or a `cat` actually freezes the packaged window was not timed. `nox-desktop-walk` is the harness for that and was out of scope for a read-only lane.
- **`services/lsp/` request lifecycle for closed documents** (responses arriving after `didClose`, code actions applied to a buffer that changed) beyond the revision guard at `workspace.ts:1339-1342`. `nox-lsp` is its own subsystem and A3/A5 may cover it.
- **`plugin/host.ts` and `agent/runtime.ts` concurrency** (two sessions on one buffer, a plugin request arriving mid-`stopAll`). Only their teardown was read.
- **`Signal` glitch-freedom.** `#sync()` sets four signals in sequence with synchronous emission, so a subscriber to `groups` that reads `activeId` inside the callback sees the previous active id for one call. No concrete victim was found in the time available, so it is recorded here rather than as a finding.
- **`window_state.rs`, `menu.rs`, `geometry.rs`, `encoding.rs`.** Not on the concurrency or lifecycle path; read only for `unwrap`.
- **Memory growth across many Reload Window cycles** on the renderer side (listeners registered by `listen()` are released per process object; whether Tauri's event registry itself is cleared on navigation was not verified).

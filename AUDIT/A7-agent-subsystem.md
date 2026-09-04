# A7 AI Agent Subsystem

## Summary

The agent layer is better built than most: one guard in one dispatcher, one write path (`workspace.apply`) that validates whole change sets before dispatching any, a review panel that is the only route from a proposal to a buffer, a session undo indexed on CodeMirror's own history, a read API that hands out nothing live, and a Rust HTTP client that is loopback-only with redirects and proxies refused and a real attacker-listener test proving it. The local-model path (Ollama) is exactly what the README says: read and propose, no commands.

The bring-your-own stdio path is not what the README says, and that is the strongest finding. The protocol exposes `command.execute`, the guard runs only when a command declares `capabilities`, and about a dozen commands with real side effects declare none. Executed against the real `NoxApp` under a deny-everything policy with a prompter that was never called: an agent reverted another session's applied edits and revoked its grants (`agents.undoLastSession`), re-ticked the out-of-selection hunks its own proposal had left unticked (`review.keepAll`), discarded a pending review, and closed the workspace folder. None of it reached the decision log. The same class reaches `search.undoReplace` (writes files on disk), `terminal.restart` and `lsp.reload` (spawn processes), `app.checkForUpdates` (network egress), and `view.reloadWindow` (kills every agent and drops the transaction log, which is the session undo).

Sub-score 5 / 10. The model is sound and enforced in code, not prose, but a real bypass of the buffer-edit and revoke rules exists, the scoped-review injection defence is agent-controllable, and the audit trail is erasable by the thing it audits.

## Sub-score

5 / 10

Justification: A7-001 is a real bypass (an agent mutates buffers and revokes grants with no check and no log entry), A7-002 makes the one prompt-injection defence for scoped sessions agent-controllable, and A7-003 lets an agent erase its own rollback and audit. Those three keep it out of the 6 to 8 band. What keeps it out of 3 to 4 is that every finding is a declaration gap on top of an enforcement point that works, the local-model path is genuinely bounded, and the fixes are small and testable.

## Findings

```
ID:          A7-001
Lane:        AI Agent Subsystem
Severity:    P1
Title:       Side-effecting commands with no `capabilities` are reachable through `command.execute` with no permission check and no decision-log entry
Location:    src/services/commands.ts:200-202; src/app.ts:3599-3621 (agents.undoLastSession), 3024-3030 (search.undoReplace), 2772-2779 (file.closeFolder), 2861-2883 (file.closeAll), 4252-4264 (terminal.restart), 3406-3428 (lsp.reload), 3318-3334 (plugins.reload), 3243-3252 (agents.run), 3588-3598 (agents.cancel), 3695 (jobs.cancel), 4487-4498 (app.checkForUpdates), 4375-4399 (notes.new/rename/delete), 3219-3234 (view.reloadWindow)
Evidence:    The dispatcher consults the guard only when a command declares something:
             `if (this.#guard && principal && principal.kind !== 'user' && command.capabilities?.length) { await this.#guard(...) }` (commands.ts:200-202).
             The contract for an absent declaration is "nothing with a side effect" (commands.ts:47-52), and `tests/permissions.test.ts:320-325` pins the behaviour ("does not gate commands that declare no capability").
             The runtime forwards any `commandId` an agent names: `const ran = await this.#commands.execute(commandId, arg, { principal })` and records it `granted: true` (runtime.ts:786-807).
             Commands that violate the contract, each with no `capabilities` field:
             - `agents.undoLastSession` (app.ts:3599-3621) calls `this.agents.undoSession(session.id)`, which runs `workspace.undoChangeSet` per set and then `this.#permissions.forgetSession(...)` (runtime.ts:568-585). That is a buffer mutation without `buffer.edit` and a grant revocation without `permissions.revoke`, the capability that exists precisely so that "a revoke command with none would be a side-effecting command any agent could reach" (permissions.ts:30-44) and that `DEFAULT_POLICY` denies (permissions.ts:105).
             - `search.undoReplace` (app.ts:3024-3030) reaches `search.undoLastReplace`, which writes files on disk: `if (await this.#writeText(entry.path, entry.before, source.bufferId)) restored++` (services/search.ts:767). No `fs.write`.
             - `terminal.restart` (app.ts:4252-4264) and `terminal.toggle` start a shell; `lsp.reload` (app.ts:3406-3428) and `plugins.reload` (app.ts:3318-3334) restart child processes. No `shell.exec`.
             - `app.checkForUpdates` (app.ts:4487-4498) runs `this.updates.checkNow({ manual: true })`, an outbound request to the updater endpoint. No `net.request`, the capability the design calls "the gate that matters" (context.ts:19-20).
             - `file.closeFolder` (app.ts:2772-2779) sets the root to null; `file.closeAll`/`closeOthers`/`closeToRight`/`closeSaved` (app.ts:2861-2925) close tabs, putting a "Don't Save" dialog in front of the user for each dirty one.
             - `agents.run` with a string arg (app.ts:3243-3252, 1209-1224, 1300-1316) skips the agent picker and opens "Ask <label>" for the named agent. The dialog does not say an agent opened it. If the user types and confirms, a second process spawns. `agent.rs:13-15`, `config.ts:12-15` and `AGENT-PLATFORM.md:475-478` all state an agent cannot spawn another agent.
             - `agents.cancel` and `jobs.cancel` stop another session's or the user's work.
             Executed repro (scratch test against the real `NoxApp` over `MemoryPlatform`, default policy `{ fallback: 'deny', rules: {} }`, prompter counting calls and answering deny), 4 of 4 passed:
             1. session A staged an edit, the human applied it (`app.applyReview()` returned true, text became `ONE...`); session B executed `agents.undoLastSession`; text reverted to the original, prompter called 0 times, B's trail ends `{ kind: 'command', commandId: 'agents.undoLastSession', granted: true }`.
             2. see A7-002.
             3. session executed `review.discard` then `file.closeFolder`; `review.staged` became null and `workspace.rootPath` became null; prompter called 0 times.
             4. after `review.rejectAll`, `file.closeFolder`, `agents.cancel`, `permissions.decisions.get()` was `[]`.
Impact:      A stdio agent that decides (or is prompt-injected by a file it read) to call `agents.undoLastSession` silently takes back edits the user reviewed and kept from a different session, and strips that session's standing grants; the Agents panel shows the action as granted and the decision log shows nothing. The same agent can write to disk through `search.undoReplace` when a project replace is pending, start a shell, restart language servers, trigger an update check, and close the project, all without a prompt. The README's "everything it was refused shows up in the Agents panel" (README.md:114-115) is true; the problem is that nothing here is refused.
Fix sketch:  Declare capabilities on every command above (`buffer.edit` on the undo and review-mutation commands, `permissions.revoke` on `agents.undoLastSession` or split the revoke out of `undoSession`, `fs.write` on `search.undoReplace`, `shell.exec` on the terminal, LSP and plugin restarts and `agents.run`, `net.request` on `app.checkForUpdates`, `workspace.open` on `file.closeFolder`). Then add a test that walks `commands.all()` and asserts every command whose `run` touches workspace, platform, terminal, lsp, plugins, updates or review declares at least one capability, so the class cannot reopen. Consider inverting the default for agent principals: an undeclared command is refused rather than allowed.
Confidence:  Confirmed
Risk class:  Gated
```

```
ID:          A7-002
Lane:        AI Agent Subsystem
Severity:    P1
Title:       The scoped-review defence against out-of-selection edits is agent-controllable: `review.keepAll` re-ticks the hunks the runtime deliberately left unticked
Location:    src/app.ts:3673-3693 (review.keepAll, review.rejectAll, review.discard); src/services/review.ts:129-142, 175-180
Evidence:    Scoped sessions default out-of-scope hunks to unaccepted on purpose: `inScope, accepted: inScope` with the comment "A scoped proposal inverts that only outside the scope, which is exactly where an unnoticed change would be a surprise" (review.ts:135-142). The README sells this as the safeguard: "they start unticked and labelled outside your selection so you notice them" (README.md:148-153).
             `review.keepAll` is `run: () => this.review.setAllAccepted(true)` with no `capabilities` (app.ts:3673-3679), so per A7-001 an agent executes it unchecked. `review.discard` (app.ts:3687-3693) lets an agent throw away a proposal staged by another agent, a plugin, or an LSP rename.
             Executed repro: a session started with `scope: { bufferId: a, fromLine: 0, toLine: 0 }` staged an edit to line 5, then executed `review.keepAll`. After settling, every hunk had `inScope === false` and `accepted === true`, the prompter was called 0 times, and the trail's only command entry was `{ granted: true }`.
Impact:      A file in the workspace containing injected instructions can, through the model, produce a proposal whose out-of-selection hunk (the real payload, say a change in a different function) arrives pre-ticked. The "outside your selection" label still renders (ReviewPanel.svelte:97-99), but the box the README says starts unticked is ticked, and the user who clicks Apply on a 3-hunk diff for a 1-line request keeps the payload. This only applies to stdio agents; the Ollama provider's vocabulary omits `command.execute` (ollama.ts:24-35).
Fix sketch:  Declare `buffer.edit` on `review.keepAll` and `review.rejectAll` (`review.apply` already has it), and make `review.discard` and `review.show` principal-aware (an agent may discard only its own staged set, or not at all). Better: refuse `review.*` from any non-user principal in the runtime, since review decisions are by definition the human's.
Confidence:  Confirmed
Risk class:  Gated
```

```
ID:          A7-003
Lane:        AI Agent Subsystem
Severity:    P1
Title:       An agent can erase its own rollback and audit trail with `view.reloadWindow`; Known debt rows 2666 and 2671 understate this
Location:    src/app.ts:3219-3234; src/ui/App.svelte:62-71; src/services/transactions.ts:389-397; ARCHITECTURE.md:2666, 2671
Evidence:    `view.reloadWindow` declares no `capabilities` and runs `globalThis.location.reload()` (app.ts:3219-3234). Its own comment says what that costs: "In-memory state does not [survive]: agent sessions and the transaction log start again, so this stays off the keyboard where it cannot be hit by accident." It is not off the protocol.
             On unload, `beforeunload` kills every agent and terminal (App.svelte:62-71). The transaction log is "In memory only" (transactions.ts:391-397), and `undoSession` walks it (`this.#workspace.log.bySession(sessionId)`, runtime.ts:557-559), so after a reload there is no session to undo and no "Undo session" button (AgentPanel.svelte:257-259 renders it from `session.changes`). CodeMirror history is per-`EditorState` and is rebuilt from `session.json`, so plain undo is gone too.
             Known debt row 2666 says the log's volatility is "Deliberate" because "a persisted log would list changes it could not undo"; row 2671 says reload "kills any running agent, which is the point". Neither considers that the agent can trigger the reload.
Impact:      Sequence: agent stages, user reviews and applies, agent (still running, or a later session of the same program) executes `view.reloadWindow`. Nox reloads, the applied edits come back as unsaved text from `session.json`, and the one-button undo the README promises ("one button takes a whole session back out again", README.md:112-113) is gone along with the trail showing the agent did it. Recovery is `file.revert` if the buffer was not saved, or git if it was.
Fix sketch:  Declare a capability on `view.reloadWindow` (or refuse it from non-user principals outright, as `prefs.reset` effectively is by its confirm dialog). Separately, reassess rows 2666 and 2671: the log could persist the per-session change-set ids and buffer texts before/after so that "Undo session" degrades to the journal mechanism `search.undoLastReplace` already has (search.ts:754-770) rather than vanishing.
Confidence:  Likely
Risk class:  Gated
```

```
ID:          A7-004
Lane:        AI Agent Subsystem
Severity:    P2
Title:       Context reads are not scoped to the workspace, and the design premise that "context cannot leave the process on its own" is false for the stdio transport
Location:    src/services/context.ts:13-22, 158-205; src/services/agent/runtime.ts:613-641; AGENT-PLATFORM.md:217-222, 538; src/services/permissions.ts:320-328
Evidence:    `ContextService` exposes every open buffer regardless of path: `openBuffers()` maps `this.#workspace.buffers.get()` (context.ts:171-183) and `bufferText(id)` returns any buffer's full text (context.ts:189-205). Nothing consults the workspace root. The comment justifying that reads are logged rather than gated is: "Context cannot leave the process on its own, `net.request` is the capability that matters, and it is checked" (context.ts:18-20; AGENT-PLATFORM.md:217-219 and the decision table at 538 repeat it).
             A stdio agent is another process (stdio.ts:13-27; agent.rs:1-15) with whatever network it likes, and `net.request` is never consulted for it because reads are not commands. The runtime's opening brief sends the active file's selection, up to 8,000 characters, before the agent asks for anything (runtime.ts:44-45, 613-641), and does so for every session including "Explain Selection".
             By contrast, the permission layer does scope `fs.*` commands: a path outside the root escalates `allow` to `prompt` (permissions.ts:320-328). No equivalent exists for context reads.
Impact:      A user with `~/.aws/credentials`, a `.env`, or `servers.json` open in a tab (Nox opens files outside the root without complaint; Known debt says so for the watcher) runs any agent on any instruction. The agent lists it, reads it, and can send it anywhere; the only trace is a `read` row in a panel that does not survive restart (A7-008). This is inside the trust model of Known debt row 2667 ("trusted code you chose to run"), but that row is about what the process can reach on its own; this is about what Nox hands it.
Fix sketch:  Apply the workspace boundary to reads: buffers whose path is outside the root are omitted from `openBuffers()` for non-user principals and refused by `bufferText`/`selection`/`viewport` with `permission-denied`, or escalated through the existing prompter as `fs.read` on that path. Keep the selection in the brief only when the active buffer is inside the root. Rewrite the context.ts and AGENT-PLATFORM.md rationale so it does not rest on "cannot leave the process".
Confidence:  Confirmed
Risk class:  Gated
```

```
ID:          A7-005
Lane:        AI Agent Subsystem
Severity:    P2
Title:       Nothing bounds a runaway agent: the session trail is uncapped, every append republishes the whole trail, and stdio has only an idle timeout
Location:    src/services/agent/runtime.ts:357-360, 529-544; src/services/agent/stdio.ts:32-42, 143-164
Evidence:    `record` appends without a cap: `actions.update((current) => [...current, { ...action, at: Date.now() }]); this.#publish();` (runtime.ts:357-360). `#publish` rebuilds a snapshot of every session including `actions: session.actions.get()` (runtime.ts:529-544). The two 500-entry caps in the codebase are on `permissions.decisions` and `context.reads`, not on a session's `actions`.
             The stdio transport's only deadline is silence: `RUN_IDLE_TIMEOUT_MS = 300_000`, and the comment says "This is not a budget for the work" (stdio.ts:32-42). Each line resets it (stdio.ts:143-164). There is no rate limit on requests, no cap on requests per session, and no wall-clock budget. `maxTurns` exists only for the Ollama provider (ollama.ts:334-335, 550-553).
             Measured in a scratch test on this machine (`ScriptedProvider` emitting only `session.note`): 2,000 notes 16 ms, 8,000 notes 68 ms, 32,000 notes 2,751 ms, trail length 32,001. Growth is superlinear because each append copies the array and republishes it.
Impact:      A looping or malicious stdio agent that prints a note every few milliseconds keeps the session alive indefinitely, grows renderer memory without bound, and makes the Agents panel (which renders `session.actions` in an `{#each}`, AgentPanel.svelte:286-293) progressively slower until the window is unresponsive. `agents.cancel` still works if the user can reach it.
Fix sketch:  Cap `actions` per session (keep the first N and the last M, with a "k actions elided" marker), cap requests per session and per second with a `cancelled` failure past the cap, and add a wall-clock budget alongside the idle timeout. Publish per-session snapshots rather than rebuilding all of them on every action.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A7-006
Lane:        AI Agent Subsystem
Severity:    P2
Title:       Proposal size is uncapped and `review.stage` diffs on the main thread; a whole-file rewrite of a few thousand lines freezes the window
Location:    src/services/review.ts:104-152; src/core/diff.ts:40-90; src/services/agent/runtime.ts:932-939
Evidence:    `proposal.stage` passes `request.params.edits` straight to `this.#review.stage(...)` with no count or byte limit (runtime.ts:932-939). `stage` computes `after = state.update({ changes }).state.doc.toString()` and `diffText(before, after)` synchronously per buffer (review.ts:118-120). `diffText` is Myers O(ND) with prefix/suffix trimming (diff.ts:40-90) and no size guard; the `MAX_DIFF_BYTES` guard exists only for the git diff view (DiffView.svelte:4, 40-44), not for review.
             Measured in a scratch test: a full rewrite of a 2,000-line buffer staged in 112 ms, 4,000 lines in 456 ms, 8,000 lines in 1,674 ms. Quadratic; extrapolated, a 30,000-line rewrite is on the order of 25 s with the renderer blocked.
Impact:      An agent (or a model that decides to "reformat the whole file") stages a rewrite of a large file and the editor stops painting for seconds to tens of seconds, on the same thread the user is typing on. CONTRIBUTING rule 5 ("nothing new on the typing path") is not violated per keystroke, but a single stage can cost more than thousands of keystrokes.
Fix sketch:  Refuse a `proposal.stage` above a byte or edit-count budget with `invalid-request` and a message naming the limit; for sets under the limit but above a few hundred KB, run the diff in a `JobRunner` job and stage on completion. Reuse `MAX_DIFF_BYTES` so review and git diff agree on "too large".
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A7-007
Lane:        AI Agent Subsystem
Severity:    P2
Title:       The review panel renders proposed lines with no defence against bidirectional controls or zero-width characters, so a diff can look benign and apply something else
Location:    src/ui/ReviewPanel.svelte:38-39, 101-108; src/core/diff.ts (no handling); src/services/review.ts (no handling)
Evidence:    Each hunk line is rendered as a text node with `white-space: pre`: `<div class="line added"><span class="sign">+</span>{display(line)}</div>` where `display` only strips the trailing newline (ReviewPanel.svelte:38-39, 101-108, 240-243). A grep across `src/core/diff.ts`, `src/services/review.ts`, `src/ui/ReviewPanel.svelte` and `src/editor/*.ts` for U+202E/U+202D/U+2066, "bidi", "zero-width" or U+200B finds nothing that strips, escapes or highlights them.
             Human review is the whole defence against prompt injection on this path (README.md:109-113: "You get a diff, hunk by hunk"), and the injection surface is real: the Ollama provider feeds file contents to the model verbatim (ollama.ts:626, `Result: ${describeResponse(response)}`).
Impact:      A proposal containing `if (isAdmin) {` followed by a U+202E override and reversed text renders in the diff in the order the override dictates, not the order the file will hold (the "Trojan Source" class, CVE-2021-42574). Zero-width joiners hide inside identifiers. The user accepts what they see; the buffer gets what was sent. The same rendering gap exists in CodeMirror, but the review panel is the one place a human is explicitly relying on the rendering to decide.
Fix sketch:  In `stage`, scan each added line for Unicode bidi controls (U+202A to U+202E, U+2066 to U+2069) and zero-width characters (U+200B to U+200D, U+2060, U+FEFF) and either refuse the proposal with a named reason or mark the hunk with a visible warning and render those characters as escaped code points. A pure function in `core/` with a test that feeds it the Trojan Source samples.
Confidence:  Likely
Risk class:  Safe
```

```
ID:          A7-008
Lane:        AI Agent Subsystem
Severity:    P2
Title:       The audit trail is in-memory, capped, not exportable, and gone on reload or quit; "you can check what happened rather than trust it" holds only while the window is open
Location:    src/services/permissions.ts:183, 330-335; src/services/context.ts:123-127, 158-167; src/services/agent/runtime.ts:263, 357-360; src/ui/AgentPanel.svelte (whole file); src/app.ts:264-278
Evidence:    `decisions` is a `Signal<PermissionDecision[]>` sliced to the last 500 (permissions.ts:183, 330-335). `reads` is a `Signal<ContextRead[]>` sliced to `READ_LOG_LIMIT = 500` (context.ts:123-127, 162-166). Session trails live in `AgentRuntime.sessions`, a `Signal` (runtime.ts:263). None of the three is written anywhere; `AgentPanel.svelte` has no export, copy or save control (the only buttons are Configure, Run, Revoke access, Undo session). The persisted `diagnostics.log` receives only `warning` and `error` notifications (app.ts:264-278), so a granted command, a read, or an applied proposal never reaches disk.
             README.md:114-115: "Everything it read, everything it ran, and everything it was refused shows up in the Agents panel. You can check what happened rather than trust it."
Impact:      After a crash, a quit, or an agent-triggered reload (A7-003), there is no record that an agent ran, what it read, or what it wrote. The 500-entry caps mean a long session on a large workspace pushes its early reads out before the user looks. A user who wants to answer "did the agent read my .env yesterday" cannot.
Fix sketch:  Append session events (instruction, reads with targets, commands with decisions, proposals with file lists, applied change-set ids) to a per-session JSONL file under the config directory, rotated by size; add "Copy session log" to the panel. The existing `DiagnosticsService` already owns a bounded on-disk log and the flush ordering at quit (app.ts:5310-5323), so it is the natural sink.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A7-009
Lane:        AI Agent Subsystem
Severity:    P2
Title:       Agent processes outlive Nox on a host crash: the only kill is a renderer `beforeunload`, with no Rust-side drop, exit hook, job object or death signal. Known debt row 2667 covers privilege, not lifetime
Location:    src/ui/App.svelte:62-71; src-tauri/src/agent.rs:39-45, 116, 143-147, 210-244; src-tauri/src/lib.rs:121; src/app.ts:5285-5327; ARCHITECTURE.md:2667
Evidence:    The kill path is `window.addEventListener('beforeunload', () => { ... void app.platform.killAllAgents(); ... })` (App.svelte:62-71). `NoxApp.dispose()` stops language servers and plugins but never calls `killAllAgents` (app.ts:5285-5327). On the Rust side `AgentState` holds `Arc<Mutex<Child>>` (agent.rs:39-45); `std::process::Child` does not kill on drop, there is no `impl Drop`, no `RunEvent::Exit` or `on_window_event` handler in `lib.rs` (the only `on_window_event` in the crate is `window_state.rs:93`, for geometry), and a grep for job objects, `PR_SET_PDEATHSIG` or `kill_on_drop` finds nothing. The stdout thread only `wait()`s once the child closes stdout (agent.rs:143-147).
Impact:      If the Rust host panics, is killed, or the WebView dies without firing `beforeunload`, every running agent keeps running as the user with the workspace as cwd and `NOX_CONFIG_DIR` in its environment (agent.rs:94-96), with nobody reading its stdout. A stuck agent survives a Nox restart, and the next launch cannot see it (the registry is per process). Known debt row 2667 says "runs with Nox's own privileges", which is accurate but says nothing about processes surviving Nox.
Fix sketch:  On Windows, put spawned agents (and terminals and language servers) in a Job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; on Linux, `prctl(PR_SET_PDEATHSIG, SIGTERM)` in `pre_exec`; on macOS, a watchdog pipe the child polls. Also call `nox_agent_kill_all` from a `RunEvent::Exit` handler so a clean host exit does not depend on the renderer. Update row 2667 to name process lifetime.
Confidence:  Likely
Risk class:  Safe
```

```
ID:          A7-010
Lane:        AI Agent Subsystem
Severity:    P2
Title:       README and ROADMAP overclaim for bring-your-own agents: "cannot run commands", "no way to express run this", "cannot touch your files", "you are never prompted" describe the local model only, and nothing tells a user configuring a stdio agent that it runs as them with open network
Location:    README.md:109-110, 129-130, 141-143, 177-179; ROADMAP.md:55, 61; src/services/agent/config.ts:89-106 (AGENTS_TEMPLATE); src/ui/AgentPanel.svelte:213-216; src/services/agent/protocol.ts:13-15, 40-41
Evidence:    README.md:109-110: "that agent cannot touch your files". README.md:129-130, in the model section: "It reads and it proposes. It cannot run commands. That isn't a switch you left off. Nox has no way to express 'run this' to an agent yet." README.md:141-143, three paragraphs later: "Or bring your own. An agent can be any program that reads and writes a small JSON format". The JSON format's protocol says "The only way an agent changes anything is `command.execute`" (protocol.ts:13-15) and defines it (protocol.ts:40-41). With the default policy, a stdio agent's `command.execute` of `explorer.delete`, `file.saveAll`, `search.replaceAll` or `explorer.rename` produces one dialog (app.ts:1114-1133) and, on "Allow for this session", proceeds; the A7-001 set proceeds with no dialog. ROADMAP.md:55: "You are never prompted." The user is exactly who is prompted (permissions.ts:285-307).
             Where a user configures a stdio agent, nothing states the trust model: `AGENTS_TEMPLATE` (config.ts:89-106) is a bare example; the panel's empty state says an agent "reads through the context API, proposes edits you review, and can be undone in one step" (AgentPanel.svelte:213-216). The one sentence saying an agent runs with Nox's privileges is Known debt row 2667 in ARCHITECTURE.md, which no user reads.
             Separately, the provider's HTTP call is not a command and is never checked against `net.request` (ollama.ts:702-714 goes straight to `platform.streamJsonLines`); today that is moot because `http.rs:94-96` refuses non-loopback URLs, but the README's planned "Remote models" (README.md:196-197) would have to add that check, not merely widen `is_loopback`.
Impact:      A stranger reading the README concludes a stdio agent is as bounded as the local model. It is not: it can run commands, some gated by a prompt and some (A7-001) by nothing, it runs as the user, and it can send whatever it reads anywhere. The gap between the claim and the code is the thing a security-minded evaluator will find first.
Fix sketch:  Split the README claims by path: the local-model paragraph stays as is; the "bring your own" paragraph states that a program you configure runs as you, can reach the network, and can ask Nox to run commands, which Nox gates by permission and prompt. Put the same two sentences as a comment in `AGENTS_TEMPLATE` and in the panel's empty state. Fix ROADMAP.md:55 to "The user is never prompted for their own actions". When remote models land, route the provider's request through a `net.request` check keyed on the host.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A7-011
Lane:        AI Agent Subsystem
Severity:    P3
Title:       "Undo session" after the user has saved leaves the agent's text on disk and reports "Took back everything"
Location:    src/services/agent/runtime.ts:568-585; src/services/workspace.ts:1472-1474, 1528-1565; src/ui/AgentPanel.svelte:110-155; src/app.ts:3599-3621
Evidence:    `undoSession` walks `undoChangeSet` per set (runtime.ts:572-576), which undoes the buffer's CodeMirror history event when the set is still on top (workspace.ts:1528-1565). A save adds no history event, so after Save the set is still on top and the undo succeeds in the buffer; the file on disk keeps the agent's text until the user saves again. The panel then says "Took back everything <label> did across N files" (AgentPanel.svelte:149-154); the palette command says the same (app.ts:3614-3616). A buffer closed since is reported in `skipped` and described as "edited since" (AgentPanel.svelte:143-147), which is a different reason.
Impact:      A user who applied, saved, noticed, and pressed Undo session sees a success toast, closes Nox, and ships the agent's edit. The dirty marker on the tab is the only hint, and nothing in the toast mentions disk.
Fix sketch:  In `undoSession`, report separately the buffers whose file on disk still carries the change (buffer was clean before the undo) and say "N files still need saving to take the change off disk"; distinguish "closed" from "edited since" in `skipped`.
Confidence:  Likely
Risk class:  Safe
```

## What is good

- Enforcement is one guard in one dispatcher, and the user principal bypasses it deliberately and visibly (`commands.ts:187-217`, `permissions.ts:262-267`). When a command declares a capability the check is real, tested (`tests/permissions.test.ts:255-355`), and refusals throw rather than return false.
- There is exactly one write path. `workspace.apply` validates every buffer's `ChangeSet` before dispatching any (`workspace.ts:1329-1436`), so a half-applied set is unrepresentable; `review.apply` narrows and goes through it (`review.ts:210-257`); `proposal.stage` can only stage (`runtime.ts:822-952`); a proposal cannot create, delete or rename a file because `Edit` is `bufferId` plus a `ChangeSpec` (`transactions.ts:321-326`).
- Stale-edit refusal is layered and honest: the runtime remembers the revision of each read and refuses a stage against a moved buffer with a message naming the read that clears it (`runtime.ts:364-384, 902-930`); `ReviewFile.baseRevision` refuses at Apply and keeps the review on screen (`review.ts:68-74, 245-256`).
- The Ollama path is genuinely read-and-propose: `command.execute` is absent from its vocabulary (`ollama.ts:24-35`), edits are quoted not positional and ambiguity is refused (`ollama.ts:309-332`), turns are capped (`ollama.ts:334-335`), and prose sessions refuse every method but note and summary at the runtime, not the prompt (`runtime.ts:668-682`).
- Loopback is enforced where the request is made: host parsed not prefix-matched, http only, redirects never followed, proxies ignored, and a test that stands up an attacker listener and asserts it is never contacted (`http.rs:42-77, 251-302`). The browser build refuses model calls outright (`memory.ts:1098-1104`).
- Model output is rendered as text everywhere: no `{@html}` in `src/ui`, `answerParts` deliberately does not render markdown (`runtime.ts:178-201`), and the answers panel and agent panel interpolate into text nodes.
- The permission prompt defaults to Deny, marks the session-wide grant as the destructive choice, and names the file for resource-scoped capabilities (`app.ts:1114-1133`, `tests/permissions.test.ts:356-420`). Grants are visible and revocable without reverting work (`AgentPanel.svelte:243-252, 264-282`; `app.ts:3623-3651`), and `permissions.revoke` is denied by policy so an agent cannot clear the ledger through the intended door (`permissions.ts:30-44, 105`; `tests/permission-grants.test.ts:207`).
- `agents.json` holds no secret today: the Ollama record is host and model only (`config.ts:41-51`), so Known debt row 2651's plaintext concern is accurate but currently moot for agents.
- The stdio supervisor survives non-UTF-8 bytes, split characters, CRLF and a missing final newline, with tests for each (`agent.rs:266-353, 388-506`); the transport buffers a handshake written before anyone listens (`tauri.ts:618-690`).
- Known debt rows 2635 (`undoSession` revokes grants) and 2667 (not sandboxed) are accurate descriptions; the panel text says so before the user presses Undo (`AgentPanel.svelte:110-121`).

## Readiness for what is planned

- **Running commands, gated.** The prompt path exists and is tested end to end: policy fallback `prompt` (`permissions.ts:95-107`), prompter with Deny default and session grants (`app.ts:1114-1133`), grants scoped per file or buffer (`permissions.ts:386-404`), 20 test cases in `tests/permissions.test.ts:99-420` and `tests/permission-grants.test.ts`. For the local model it is one line (add `command.execute` to the Ollama vocabulary) plus a `shell.exec` command. It must not be wired until A7-001 is fixed, or the undeclared class widens to the model path too.
- **Remote models.** `is_loopback` is the only gate and it is in Rust (`http.rs:42-50, 94-96`); the TS provider never consults `net.request`. Widening means adding a host allowlist to `agents.json`, a `net.request` check per host through `PermissionService`, and a Rust check that the URL matches what was approved. Gated.
- **Workspace-aware chat.** Reads are already logged per principal and the brief is already the context set; the missing pieces (a visible, editable context set, and A7-004's workspace scoping) are additive.

## Not checked

- `npm run test:editor` and the packaged app were not run; A7-007's rendering claim and A7-003's reload chain are from code, marked Likely.
- `tests/stdio.test.ts` runs `examples/uppercase-agent.mjs` as a real child; I did not run a hostile stdio agent end to end (a scripted in-process provider was used for the executed repros, which goes through the same `#handle` and `commands.execute`).
- `examples/orchestrator-agent.mjs` and `examples/orchestrators/memory.mjs` were skimmed for trust statements only, not audited for their own behaviour.
- The Tauri IPC surface (`nox_agent_spawn` accepting any command line from the renderer) is A6's lane; I took the renderer as trusted.
- Whether `context.workspaceTree` leaks paths of gitignored or dot files depends on the quick-open index rules in `services/filetree.ts`, which I did not read.
- Rust tests were not re-run; the orientation records them green at this SHA, and `http.rs`'s attacker-listener test was read rather than executed.

Scratch files used for the executed repros lived under the session scratchpad and were deleted.

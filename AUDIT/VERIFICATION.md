
## A4-001 Sticky scroll walks the whole syntax tree on every keystroke
Verdict:     CONFIRMED
Reproduced:  yes. Plain Node 24 script against `src/core/symbols.ts` with `@codemirror/lang-javascript`
             (`javascript({ typescript: true })`) over `tests/support/corpus.ts` `sourceFile(n)`, best of 5:
             fully parsed tree, `fileSymbols` walk: 2,000 lines (48 KB) 1.16 ms; 16,000 lines (383 KB)
             9.68 ms; 64,000 lines (1.5 MB) 28.1 ms. Then one 1-char `state.update` on the fully parsed
             state: the new `syntaxTree` covers the whole doc (`tree.length` == `doc.length`), is a
             different object, and `createSymbolCache` misses and re-walks: 6.6 ms at 16k, 32.4 ms at 64k.
             So the per-keystroke miss the code comment admits (sticky.ts:184-190) is real and the walk is
             O(parsed tree), not O(viewport). `stickyRows` on top adds 1.3 ms (16k) and 7.3 ms (64k),
             which the auditor did not count.
Guard found: one, and it is a precondition rather than a bound. Lezer's `parseWorker` stops at
             `viewport.to + 100000` chars (`@codemirror/language/dist/index.js:612,618`, `Work.MaxParseAhead`),
             so a file opened and left near the top holds a tree of about 100 KB plus the viewport whatever
             its size: measured 1.7 to 2.0 ms per walk for both the 16k and 64k files in that state. The
             full-document cost needs the whole file parsed once, which any of these does on a normal path:
             scrolling to the end (the worker parses up to the viewport, and `LanguageState.apply`
             (index.js:527-537) then keeps the tree full across every later edit, verified above), a session
             restore with the cursor near the bottom, or the symbol palette's `ensureSyntaxTree` at
             `CommandPalette.svelte:818` (100 ms budget; enough for about 16k lines, measured 102 ms). Nothing
             else bounds it: no size gate on the grammar or on `editor.stickyScroll` (default `true`,
             `schema.ts:274`; the only consumer is `extensions.ts:191`); the panel's `update` fires on
             `update.docChanged` (sticky.ts:199); `requestMeasure` keyed on `dom` (sticky.ts:157-165)
             collapses to one walk per animation frame, which at typing speed is one per keystroke; no
             debounce; `fileSymbols` is `tree.iterate` over the whole tree (symbols.ts:250-271).
             `tests/browser/support/keystroke.ts` builds the state with no language, so the typing-path
             test cannot see any of this; the auditor is right about that.
Severity:    P1, because once a large file has been parsed (a normal thing to have happened) every keystroke
             pays 7 to 10 ms at 16k lines and 30 to 40 ms at 64k lines, inside the frame, with the feature on
             by default and no setting short of turning sticky scroll off. Below about 100 KB of parsed tree
             it is a flat ~2 ms, which is a P2-sized tax and not a cliff; the P1 is the large-file case and
             the false "flat in document size" claim in ARCHITECTURE §6 that rests on a test with no grammar.
Risk class:  Safe. Nothing public changes: no schema, keybinding, on-disk or permission surface.
Minimal fix: In `paint`, derive the rows from the ancestor chain of the node at the top visible position
             (`syntaxTree(state).resolveInner(topLinePos, 1)` then `.parent` while checking `RULES`), which is
             O(depth) and needs no document walk, and keep `fileSymbols` for the palette only. If the walk
             must stay, skip it on `docChanged` and reuse the previous list mapped through `update.changes`,
             re-walking after a quiet period. Either way `stickyRows` should not filter the full list per frame.
Notes:       Add a grammar-loaded case to `tests/browser/typing-path.test.ts` (load
             `javascript({ typescript: true })` and call `ensureSyntaxTree(state, doc.length, 1e9)` first, or
             the parse-ahead cap hides the regression). A unit test can pin the shape headlessly: the
             ancestor approach touches no `@codemirror/view` API, so it can live in `core/symbols.ts` and be
             tested like `tests/symbols.test.ts`. Trap: `resolveInner` on an unparsed region returns the top
             node, which must pin nothing (the file's own "honest answer" comment at sticky.ts:16-19).

## A4-002 With the find bar open, every keystroke and cursor move rescans the whole document to count matches
Verdict:     CONFIRMED, and wider than reported: the cost survives closing the find bar.
Reproduced:  yes. Plain Node 24 script, `new SearchQuery(spec).getCursor(state)` iterated to done or 10,000,
             over `sourceFile` text padded to size, best of 3. 1 MB (42,889 lines): literal `zzqx` 43.4 ms,
             case-sensitive 39.9 ms, whole-word 49.9 ms, literal `buffer` (2,897 hits) 58.6 ms. 10 MB: 496 ms,
             505 ms, 707 ms, and `buffer` hits the 10,000 cap at 238 ms. The regexp cursor is a different
             animal: `zzq[xy]` regexp 2.0 ms at 1 MB, 19.9 ms at 10 MB, because `RegExpCursor` hands whole
             chunks to the native engine while the literal `SearchCursor` walks code points one at a time
             through a normaliser. The slow path is the default (regexp off).
Guard found: none on the scan. `EditorPane.svelte:146-147` calls `find.refresh()` on every transaction
             batch, outside the `docChanged` branch, so arrow keys and mouse clicks pay it; `find.ts:443-445`
             `refresh` gates only on `this.query.get().length > 0`; `#count` (find.ts:395-440) walks from 0
             with `MAX_COUNTED_MATCHES` (10,000) bounding matches, not text. No debounce, no byte cap, no
             `docChanged` check, and `search-highlight.ts:41-58` is viewport-bounded so the highlighter is
             not the problem. The widening: `app.ts:516-517` runs `find.clear()` when `ui.findOpen` goes
             false, and `clear()` (find.ts:227-233) resets the view's `SearchQuery` and the status but not
             `this.query`, deliberately ("query outlives a close", find.ts:212). `refresh()` reads
             `this.query`, so after Escape the count still runs on every dispatch, in a document with no find
             bar on screen, until the user reopens Find and empties the field. Nothing in `src/` sets the
             find query to an empty string (a grep for `setQuery('')` hits only project search).
             CodeMirror's own `@codemirror/search` panel has no match counter, so it never scans for one;
             Nox added the counter and the scan with it.
Severity:    P1, because 40 ms per keystroke at 1 MB and ~500 ms at 10 MB on the synchronous dispatch path,
             on by default the moment a term is typed, and persisting after the panel closes. The 64 MB open
             cap is the only bound. The closed-bar case is what lifts it above "has a workaround": the
             user has no signal that Find is still costing them.
Risk class:  Safe.
Minimal fix: Count only when a transaction has `docChanged` or the query, options or view changed; on
             selection-only dispatches recompute `current` by binary search over the cached match
             positions. Skip counting entirely when `ui.findOpen` is false (or make `clear()` drop the count
             without dropping `query`). Bound scanned text the way `WORD_COMPLETION_MAX_BYTES` bounds word
             completion and report "10,000+" past it; a 300 ms debounce on the count is fine since the
             status text is not keystroke-critical.
Notes:       Fix agent: `refresh()` must stay dispatch-free (find.ts:219-221 says why). Tests: a unit test
             that a selection-only `refresh` does not rebuild the query (spy on `SearchQuery` construction or
             on `#count` via the status signal's update count), and one that `closeFind` stops the counting.
             Trap: `find.attach(view)` is the active pane, so a dispatch in a split pane counts the other
             pane's document; not part of this finding, but the fix should not make it worse.

## A4-003 Line diff is quadratic in changed lines and keeps every Myers frontier
Verdict:     CONFIRMED. A7-006 is the same defect seen from Review; record it as merged into this one.
Reproduced:  yes. Plain Node 24 script importing `diffText` from `src/core/diff.ts`, one process per case,
             `process.memoryUsage()` read straight after the call (the frontier copies are unreachable but
             not yet collected, so `arrayBuffers` is the peak):
               all lines different  2,000 lines   88 ms   +120 MB arrayBuffers
               all lines different  4,000 lines  353 ms   +488 MB
               all lines different  8,000 lines 1,326 ms  +1,953 MB (RSS 2,015 MB)
               reindent, first and last line equal, a blank every 6th line: 4,000 lines 301 ms +407 MB;
               8,000 lines 1,200 ms +1,628 MB (1,334 hunks, 319 KB of text)
               tab-to-spaces on half the lines: 8,000 lines 601 ms +977 MB (4,000 hunks)
             Each doubling is 4x on both axes, so 16k all-changed lines is ~5 s and ~8 GB, and the renderer
             dies before that. The auditor's numbers stand; mine are slightly faster on time and identical on
             memory. The arithmetic matches the code: `trace.push(v.slice())` (diff.ts:82) keeps
             `Int32Array(2(N+M)+1)` per round for D+1 rounds; 8,000 vs 8,000 all different is D = 16,000
             rounds of 128 KB.
Guard found: partial. `git.ts:543-544` refuses when either side exceeds `MAX_DIFF_BYTES` (2 MB,
             git.ts:46); at the 30 to 40 bytes per line of ordinary source that is 50,000 to 70,000 lines, so
             the 8k-line case above is 250 to 320 KB, inside the cap by a factor of six, and an all-changed
             file at the cap would need on the order of 80 GB. The cap bounds nothing relevant. The trim
             (diff.ts:43-54) and the one-side-empty shortcut (diff.ts:62-64) help only when one end matches
             or one side is empty. `review.ts:117-120` has no cap: `diffText(before, after)` on
             `state.doc.toString()` for every proposed buffer, synchronously, and `runtime.ts:932-939`
             passes `request.params.edits` straight in. `tests/complexity.test.ts:49-73` holds only the
             one-line-edit case and says so ("D at 2 whatever the file size"); nothing holds D. Both paths
             run on the main thread (setTimeout callback at git.ts:352-356; synchronous call in `stage`).
             Line endings are not a trigger: `normalizeGitBase` (`core/git-gutter.ts:80-83`) strips CRLF and
             BOM from the base and the buffer tracks `eol` separately (workspace.ts:145-217).
             Real triggers, all under the git cap: `lsp.formatDocument` (Shift+Alt+F, app.ts:3483, 4619) or
             `files.formatOnSave` (off by default, schema.ts:314) on a previously unformatted file, then the
             300 ms `#reconcile` timer and again `#refresh` on `saved` (git.ts:144-146); select-all and paste
             a regenerated or minified file over the old one; opening a tracked generated file a build has
             just rewritten, which runs `#compute` synchronously from `buffer-opened` (git.ts:143, 363-376)
             with no debounce at all; and any agent proposal that rewrites a file through Review (A7-006,
             uncapped, `proposal.stage` in runtime.ts).
Severity:    P1, because a reformat of a few thousand lines stalls the renderer for a second and takes a
             gigabyte, on the default-on git gutter, with no setting or cap in the way, and the memory curve
             reaches renderer OOM within the sizes the caps permit. The Review side has no cap at all.
Risk class:  Safe. `diffText`'s output contract is unchanged; a bounded-D fallback returns the same
             one-replacement hunk the empty-side shortcut already returns.
Minimal fix: In `myers`, stop at a D limit (a few thousand) and return one replacement hunk for the trimmed
             middle, which is what a user sees for a rewrite anyway; and store only the `[-d, d]` slice of
             `v` per round, which halves memory but leaves it quadratic, so the D limit is the part that
             matters. Longer term, the linear-space (Hirschberg-style) Myers variant removes the trace
             entirely.
Notes:       Add a growth guard to `tests/complexity.test.ts` next to the one-line case: all-different inputs
             at 1,000 and 8,000 lines, ratio under 24 (the current code is 4x per doubling, about 64x at 8x input, so
             any linear or D-bounded fix passes and the current code fails). Keep the existing test; it
             guards a different property. `A7-006`'s fix sketch (refuse or job-run oversized proposals) is a
             second layer on the Review side and can wait for the core fix; with a D limit in `diffText`,
             Review no longer needs its own cap for safety, only for UX.

<!-- Verifier V-E: A7-001, A7-002, A7-003. Repros run as scratch vitest files against the real NoxApp over MemoryPlatform at 54cece6e, deleted afterwards. -->

## A7-001 Side-effecting commands with no `capabilities` reach `command.execute` unchecked and unlogged
Verdict:     CONFIRMED
Reproduced:  yes. Scratch vitest (jsdom) built `new NoxApp(new MemoryPlatform())`, opened `/w`, set `setDefaultPolicy({ fallback: 'deny', rules: {} })` and a prompter that counts calls and answers `deny`, then drove `app.agents.start(new ProviderTransport(new ScriptedProvider(...)))` with `command.execute` requests. Printed:
             1. Session A staged `one` -> `ONE`, human `app.applyReview()` returned true. Session B executed `agents.undoLastSession`: text after B `"one\ntwo\nthree\nfour\nfive\n"` (reverted), prompts 0, `permissions.decisions` `[]`, B's trail `[{"kind":"command","commandId":"agents.undoLastSession","granted":true}]`, B status `done`.
             2. With a replace journal pending for the closed file `/w/b.txt` (`search.lastReplace` set to `[{path, before:'alpha\nbeta\n', after:'REPLACED\nbeta\n', count:1}]`, disk holding `REPLACED`), an agent executed `search.undoReplace`: disk read back `"alpha\nbeta\n"`, prompts 0, trail `granted: true`. That is a file write from an agent with no decision-log entry.
             3. One session executed `lsp.reload`, `terminal.restart`, `app.checkForUpdates`, `agents.run 'nope'`, `file.closeFolder`: `lsp.reload` and `file.closeFolder` ran (`workspace.rootPath` became `null`); the other three were recorded `granted: true, detail: 'disabled'` only because `MemoryPlatform` has no terminal, no updater and no runnable agent. On the desktop platform all three predicates are true (`tauri.ts:86` `terminals: true`; `updates.started`; a configured agent), so they run there. Decisions `[]` throughout.
Guard found: none. Checked all four places one could live. (1) `runtime.ts:786-807`: the `command.execute` branch checks only `this.#commands.has(commandId)`, then calls `execute(commandId, arg, { principal })` and records `granted: true` on return; there is no allowlist of command ids, and `StdioTransport` (`stdio.ts`) is transport only. (2) `commands.ts:200-202` is the only guard call and is conditioned on `command.capabilities?.length`; nothing treats "no capabilities" as "deny for non-user". (3) `permissions.ts` never sees the request because the guard is never invoked. (4) Tests: `tests/permissions.test.ts:320-325` pins "does not gate commands that declare no capability" but exercises it with `nav.goToLine`, a UI command, so it pins the mechanism, not that side-effecting commands may go undeclared. `tests/permission-grants.test.ts:207-214` asserts the two `permissions.revoke*` commands carry the capability "an agent cannot help itself to", and `agents.undoLastSession` reaches the same `forgetSession` without it, so that test's guarantee is bypassed by the finding. No test asserts any of the listed commands is agent-reachable by design.
             The prose-session refusal (`runtime.ts:668-682`) and the Ollama vocabulary (`ollama.ts:24-35` omits `command.execute`) are real limits, but neither covers a stdio agent in an actions session, which is the path the finding names.
             Full enumeration (165 registered commands, listed from `app.commands.all()` with `capabilities` and `run` source). Commands with no `capabilities` whose `run` has an effect beyond the renderer's own UI or preferences:
             - Buffer or file mutation: `agents.undoLastSession` (undoes change sets, then `forgetSession`), `search.undoReplace` (writes files on disk through the journal).
             - Review decisions: `review.keepAll`, `review.rejectAll`, `review.discard` (A7-002), `review.show`.
             - Workspace and tabs: `file.closeFolder`, `file.close`, `file.closeAll`, `file.closeOthers`, `file.closeToRight`, `file.closeSaved` (closes only clean buffers, so lowest impact of the set).
             - Child processes: `terminal.toggle` and `terminal.restart` (shell), `lsp.reload` (restart language servers), `plugins.reload` (restart plugin hosts), `agents.run`, `agents.runOnSelection`, `agents.askAboutSelection`, `agents.explainSelection` (each opens the Ask dialog; the process spawns only if the user confirms, and the dialog does not say an agent opened it).
             - Network: `app.checkForUpdates`.
             - Cancelling someone else's work: `agents.cancel`, `jobs.cancel`.
             - Renderer teardown: `view.reloadWindow` (A7-003).
             - Persisted notes: `notes.new`, `notes.newFromSelection` (write `notes.json` with no dialog), `notes.rename` and `notes.delete` (each behind a dialog the user sees without knowing an agent raised it).
             - Config reloads from disk with no process restart: `themes.reload`, `snippets.reload`, `agents.reloadConfig`.
             - Clipboard egress: `app.copyDiagnostics`, `explorer.copyPath`, `explorer.copyRelativePath` (text leaves Nox for the system clipboard).
             - Persisted preferences: every `view.toggle*` / font size / `view.toggleTheme`, `lang.setLanguage`, `prefs.reset` (behind a confirm dialog). These write `settings.json`; low impact, listed for completeness.
             Not counted: `file.revealInExplorer` (selects the file in Nox's own tree, `app.ts:5272-5277`, not the OS file manager; `explorer.revealInFileManager` is the OS one and does declare `shell.exec`), `git.refreshGutter`, `git.toggleBlame`, `explorer.refresh` (reads only), and the `nav.*`, `edit.fold*`, `edit.select*`, `view.split*`, `*.focus` family.
             The auditor's list is accurate and, if anything, short: `notes.new`, `terminal.toggle`, the three `agents.*Selection` commands, the two clipboard copies and the reload family belong on it.
Severity:    P1. The documented model is "the guard covers everything a plugin or an agent could ask for" (`commands.ts:11-14`, `ARCHITECTURE.md:1537-1541`, `AGENT-PLATFORM.md:377-378` "command.execute lands in the dispatcher under the permission model") and `commands.ts:47-52` makes an absent declaration mean "nothing with a side effect". Two of the undeclared commands violate the two rules that have their own capabilities precisely to stop this (`buffer.edit`, `permissions.revoke`), one writes disk, and nothing reaches the decision log, so the Agents panel shows `granted` and the audit trail is silent. That is a meaningful security weakness in the one enforcement point the design rests on, not a friction. Trigger is not contrived: any configured stdio agent, on any instruction, at the default policy. README.md:129-130 ("cannot run commands") is about the model path and stays true; README.md:114-115 ("everything it was refused shows up") is true because nothing here is refused.
Risk class:  Gated, by the letter of the definition, with a note. Reading (1), Gated: adding `capabilities` to these commands changes what an agent principal may do without a prompt, which is "permission behaviour" and an "agent capability boundary"; under the shipped `DEFAULT_POLICY` (`fallback: 'prompt'`) an agent that today silently runs `review.keepAll` would start raising a dialog, and `agents.undoLastSession` would go from silently succeeding to a policy denial (`permissions.revoke` is `deny`). Reading (2), Safe: no public API, on-disk format, config schema or keybinding default moves; the user principal is untouched; the change only makes the code match what `commands.ts:47-52`, the decision log and AGENT-PLATFORM already promise, and no shipped example agent calls `command.execute` at all (`grep` over `examples/*.mjs`). Verdict: Gated, because the definition says any permission-behaviour change is, but it is a gate that should open without argument: every effect is in the closing direction, and the "existing users" it could break are agents relying on an undocumented hole.
Minimal fix: Option (b), a dispatcher rule in `commands.ts:execute`, is the smallest and the only one that closes the class rather than today's instances: when `principal.kind !== 'user'` and the command declares no `capabilities`, refuse (throw a `PermissionError`-shaped error the runtime already maps to `permission-denied`, and record a decision so the panel shows it). About five lines plus flipping `tests/permissions.test.ts:320-325` from "not gated" to "refused for a non-user principal", and a one-row decision-log entry in ARCHITECTURE.md. Option (a), per-command declarations (`buffer.edit` on the review and undo commands, `permissions.revoke` on `agents.undoLastSession` or split the revoke out, `fs.write` on `search.undoReplace`, `shell.exec` on the two terminal commands, `lsp.reload`, `plugins.reload` and the four `agents.run*`, `net.request` on `app.checkForUpdates`, `workspace.open` on `file.closeFolder`) is around fifteen edits and reopens with the next command someone adds. (b) also removes the legitimate agent use of undeclared UI commands (`review.show`, `nav.goToLine`), which no shipped agent uses; if that matters, (b) plus a short explicit allowlist of UI-only ids is still smaller than (a).
Notes:       Whichever option lands, `agents.undoLastSession` needs the revoke split out of `undoSession` or the command declared `permissions.revoke`, because under `DEFAULT_POLICY` a declared `permissions.revoke` is denied outright, which would make the palette command unusable for agents and (correctly) leave the human path untouched. Add tests that (i) walk `commands.all()` and assert every id in the enumeration above either declares a capability or is on the UI-only allowlist, (ii) re-run repro 1 and assert the text is NOT reverted and a decision is logged, (iii) re-run repro 2 and assert disk is unchanged. Trap: `tests/permissions.test.ts:320` will fail under (b) and must be rewritten, not deleted. Trap: the `disabled` detail in the trail is recorded `granted: true`, so a refusal test must look at `decisions`, not only the trail. Trap: `terminal.restart`, `app.checkForUpdates` and `agents.run` are `enabled: false` on `MemoryPlatform`, so a test of those needs a fake terminal-capable platform or must assert on the guard rather than the effect.

## A7-002 The scoped-review defence is agent-controllable via `review.keepAll`; `review.discard` dismisses another session's review
Verdict:     CONFIRMED, severity revised to P2 (see below); the finding itself stands.
Reproduced:  yes. Same harness. A session started with `scope: { bufferId: a, fromLine: 0, toLine: 0 }` staged two edits (line 1 and line 5), then executed `review.keepAll`, then `review.apply`. Printed hunks `[line, inScope, accepted]` = `[[1,true,true],[5,false,true]]`: the out-of-selection hunk that `review.ts:135-142` started unticked is ticked. Trail: `review.keepAll` `granted: true`; `review.apply` `granted: false, detail: "E is not allowed to buffer.edit"` and one decision logged (`source: 'policy'`). Buffer text unchanged after the agent's turn. Then the human `app.applyReview()` returned true and the text became `"ONE\ntwo\nthree\nfour\nFIVE\n"`: the out-of-selection payload landed. Second test: session F staged a proposal, session G executed `review.discard`; `review.staged` became `null`, prompts 0.
             Reachability: `runAgentOnSelection` (`app.ts:1231-1251`) picks from `#runnableAgents()`, which includes process (stdio) agents (`config.ts:75-82`), and `#startAgentSession(chosen, instruction, scope)` (`app.ts:1334-1360`) passes the scope into a `StdioTransport` session. So a scoped session with a stdio agent is the normal "Edit Selection with a Model" path, not contrived state.
Guard found: partial, and it is the reason for the severity change. `review.apply` declares `buffer.edit` (`app.ts:3654-3663`) and the repro shows the agent's own Apply refused under deny and, under the shipped `DEFAULT_POLICY`, prompted with Deny as the default (`app.ts:1114-1133`). So the agent can tick the box but cannot apply; the write still needs the human's click. The "outside your selection" label still renders on the ticked hunk (`ReviewPanel.svelte:97-99`), and the hunk is not collapsed or hidden, so the diff is on screen. Nothing else stops it: `review.keepAll`, `review.rejectAll`, `review.discard` and `review.show` declare no capabilities (enumeration above), and `ReviewService` has no notion of a principal (`review.ts` never reads `staged.author` for authorisation).
Severity:    P2, because the last step is still a human clicking Apply on a diff that shows the payload with its label, and the README's promise is specifically about which box starts ticked ("All that changes is which box starts ticked", README.md:153). What the agent defeats is a default, not a barrier; the barrier (`review.apply` gated, human Apply) holds. It is a real weakening of the one injection defence for scoped sessions, and a narrow trigger (a stdio agent, a scoped session, a user who applies a multi-hunk diff for a one-line request without reading it), so P2 by the orientation's definitions. It would be P1 if `review.apply` were undeclared or if the tick were the only signal; neither is the case. `review.discard` across sessions is a nuisance (the other session's status stays `awaiting-review` for a proposal that no longer exists) rather than a loss: nothing was written.
Risk class:  Gated, same reasoning as A7-001: gating `review.*` for non-user principals changes agent capability boundaries. Closed entirely by A7-001 option (b); under option (a) it needs its own declarations.
Minimal fix: Under A7-001 (b) nothing extra. Otherwise declare `buffer.edit` on `review.keepAll` and `review.rejectAll` (the prompt then reads "E wants to edit what is open (Keep All Changes)", which is the right question), and make `review.discard` refuse a non-user principal in the command's `run` or in `ReviewService.discard(principal)` when `staged.author` is a different principal. Simpler and defensible: refuse every `review.*` id for non-user principals in `runtime.ts`'s `command.execute` branch, since review decisions are the human's by definition (`app.ts:3648-3650` says exactly that in its own comment).
Notes:       Test to add: the scoped repro above asserting `[5,false,false]` survives an agent `review.keepAll` and that a decision is logged. Do not gate `review.show`: it is UI-only and an agent opening the panel is harmless. If `buffer.edit` is used for `keepAll`, note it is not resource-scoped in a useful way here (no `resourceFrom`, as `review.apply` already documents at `app.ts:3656-3659`), so an "Allow for this session" answer covers every future keepAll, which is acceptable because it still cannot apply.

## A7-003 An agent can execute `view.reloadWindow` and erase its own rollback and audit trail
Verdict:     CONFIRMED as a consequence of A7-001; DOWNGRADE to P2 as a standalone item and merge into A7-001's command list.
Reproduced:  yes. Same harness: an agent executed `view.reloadWindow`; trail `[{"commandId":"view.reloadWindow","granted":true}]`, prompts 0, decisions `[]`, and `notifications.items` held `"Reloading…"`, with jsdom printing `Not implemented: navigation to another Document` for the `location.reload()` call, so the handler ran to the reload. The reload itself cannot be observed under jsdom; on the desktop WebView `location.reload()` is real and `App.svelte:62-71`'s `beforeunload` calls `killAllAgents()` and `closeAllTerminals()`.
             What is lost is confirmed from the code, not executed: the transaction log is "In memory only" (`transactions.ts:130`), `AgentRuntime.sessions` is a `Signal` on the runtime instance (`runtime.ts:263`), and `PermissionService.decisions` is a `Signal` sliced to 500 (`permissions.ts:183, 330-335`); a reload constructs a new `NoxApp`, so all three start empty, and `undoSession` walks `this.#workspace.log.bySession` (`runtime.ts:557-559`), so there is nothing to undo. Applied edits survive as unsaved text through `session.json`. Known debt rows at `ARCHITECTURE.md` ("The transaction log does not survive a restart", "Reloading the window drops in-memory agent state") describe the loss accurately and do not consider the agent as the trigger; the command's own comment (`app.ts:3223-3230`) keeps it "off the keyboard" and says nothing about the protocol.
Guard found: none beyond those already listed under A7-001. `view.reloadWindow` declares no `capabilities`, is not `hidden`, has no `enabled` predicate, and the runtime forwards any known id.
Severity:    P2 on its own. The effect is real (rollback and trail gone in one call, no prompt, no log) but the agent has to already be running with the user's applied edits in the buffer, the edits are not lost (they are in the session as unsaved text, recoverable with `file.revert` or git), and the trail's volatility is already A7-008. As a distinct P1 it double-counts A7-001: the defect is the same undeclared-command hole, and the same fix closes it. Keep it in the report as the sharpest example of why the hole matters (the audited thing can erase the audit), but under A7-001.
Risk class:  Gated, as A7-001. A7-001 option (b) closes it with no further change; option (a) needs a capability on `view.reloadWindow`, and none of the nine fits well (`shell.exec` is the nearest in spirit), which is itself an argument for (b) or for the runtime refusing `view.reloadWindow` from non-user principals by id.
Minimal fix: Under (b), none. Otherwise a one-line id refusal in `runtime.ts`'s `command.execute` branch for `view.reloadWindow`, recorded as a denied command in the trail and a decision in the log. The auditor's second suggestion (persist per-session change-set ids so "Undo session" degrades to the journal mechanism) is a feature against Known debt rows, not part of this fix.
Notes:       Test to add: agent `command.execute view.reloadWindow` yields `permission-denied` and never reaches `location.reload` (stub `globalThis.location.reload` with `vi.fn()` under jsdom, or assert `notifications.items` never carries "Reloading…"). Trap: jsdom's `location.reload` does not throw, it logs "Not implemented", so a test that only checks the command did not throw proves nothing.

## A3-001 Keystrokes typed while a save's write is in flight are reverted, never written, and the buffer is marked clean (A2-001 merged: same defect, same lines)
Verdict:     CONFIRMED
Reproduced:  yes. Scratch vitest file (deleted) against the real `WorkspaceService` and a `MemoryPlatform` subclass whose `writeEncodedFile` awaits a gate, the shape `tests/notes.test.ts:30-45` uses for config writes. Open 'alpha\n', type 'A', start `save()`, type 'B' once the write is reached, release, await. Printed, for both `insertFinalNewline` true and false:
             `{"duringWrite":"ABalpha\n","disk":"Aalpha\n","after":"Aalpha\n","dirty":false,"events":["buffer-reset","saved"]}`
             Control (type 'B' after the save resolved): `{"control":"ABalpha\n","dirty":true}`.
             The auditors' "recoverable by Cmd+Z" claim is wrong, and it makes the finding worse. With the production `history()` extension and realistic timing ('A' typed, 600 ms idle to clear `newGroupDelay` 500 ms, save, 'B' during the write) the first undo printed `"Aalpha\n"`: the 'B' insert and the whole-document replacement at workspace.ts:993 are adjacent and within 500 ms, so `@codemirror/commands` joins them into one history event (node_modules/@codemirror/commands/dist/index.js:213, 487-488) and undoing it returns the same text. The second undo removes the 'A'. Redo twice gives `"Aalpha\n"` again. The 'B' is not reachable from undo, redo, disk, or the session backup (the buffer is clean, so `SessionService.save` writes no backup for it).
Guard found: none. `save()` (workspace.ts:966-1019) has no in-flight flag, `Buffer` has no saving state, `EditorPane.svelte` never toggles `EditorView.editable` or blocks `dispatchTransactions` during a save, `app.save` (app.ts:1730-1770) only checks `externalState === 'modified'` before the write, and `revision`/`changeCount` are not captured before the await. The `setState` on `buffer-reset` (EditorPane.svelte:210-212, 321) is a full replace, not a mapped change: the pane adopts `buffer.state`, which is the pre-save text. `tests/workspace.test.ts` has no edit-during-save case.
Severity:    P1 stands. The window is the `writeEncodedFile` round trip: IPC to a synchronous `#[tauri::command]` (fs.rs:116), temp file, `write_all`, `sync_all` (fs.rs:186), rename. Inference, not measured: a few ms on NVMe, tens of ms on SATA or with Defender scanning the temp file, hundreds on an HDD or network share, plus JSON serialisation of a large file over IPC. A keystroke gap at 60 to 100 wpm is 100 to 200 ms, so a manual Cmd+S mid-sentence hits it a few percent of the time on a fast disk and often on a slow one. `files.autoSave: afterDelay` (default off, schema.ts:291; delay 1000 ms, schema.ts:297) makes it a normal path once enabled: the save fires exactly when the user pauses and the resumed typing is what lands in the write. `onFocusChange` also inherits it. By the letter of the orientation's definitions (silent, unrecoverable loss of typed text) this is P0 territory; the loss is a few characters per event, so P1 is defensible. Lead's call; do not drop below P1.
Risk class:  Safe. No API, format, schema, keybinding or permission change.
Minimal fix: Before the await, capture `const written = buffer.state.doc` and `const writtenCount = buffer.changeCount`. After it, if `buffer.state.doc !== written` (a keystroke landed), skip the replacement entirely and set `savedDoc` to the `Text` that was actually written (`Text.of(text.split('\n'))`, or keep `written` when no reformat applied) and `savedChangeCount = writtenCount`, so the buffer stays dirty by exactly the edits that arrived. Only when the document is unchanged apply the formatting edit, and apply it as a minimal change through `#dispatchToView` rather than `buffer.state = ...` plus `buffer-reset` (see A3-005). A per-buffer `saving` promise that a second `save()` awaits closes the double-save variant.
Notes:       Test to add in `tests/workspace.test.ts`: the gated-platform repro above, asserting `textOf` is `"ABalpha\n"`, `isDirty` true, disk `"Aalpha\n"`, and that one `undo` restores the pre-'B' text. Also assert that a save with no concurrent edit and `insertFinalNewline` still writes the newline (the existing `adds a final newline when asked` test at workspace.test.ts:140). Trap: `savedDoc` must be a `Text` that `doc.eq` can compare; `isDirty` (workspace.ts:214-225) short-circuits on `changeCount === savedChangeCount`, so the captured count is load-bearing. A2-001 in `AUDIT/A2-architecture.md` is the same defect and the same lines; record it as merged into this verdict.

## A3-004 Session restore silently drops a dirty tab whose file is missing, and the backup counter restarting at 1 then overwrites its unsaved text
Verdict:     CONFIRMED
Reproduced:  yes. Scratch vitest (deleted): two dirty file tabs, `session.save()`, `platform.trash('/work/a.ts')`, fresh `WorkspaceService` and `SessionService` on the same platform, `restore()`, then one `save()` with no user edit. Printed:
             BEFORE: `unsaved-1.txt = "UNSAVED-A alpha\n"`, `unsaved-2.txt = "UNSAVED-B beta\n"`, session.json names both.
             AFTER RESTORE: tabs `[{"name":"b.ts","dirty":true}]`, a.ts gone, no notification path exists (the `continue` at session.ts:187 is silent). Both backup files still intact at this instant.
             AFTER SAVE: `unsaved-1.txt = "UNSAVED-B beta\n"`, `unsaved-2.txt = "UNSAVED-B beta\n"`, session.json now points b.ts at `unsaved-1.txt`. a.ts's unsaved text is gone from the config directory.
             Variant: a lone dirty a.ts plus an untitled scratch tab. After trash, restore, save: `unsaved-1.txt = "scratch"`. The untitled tab takes the name too.
             Control with nothing vanished: names are reissued in tab order, so each file gets its old name back by luck of ordering, not by design.
Guard found: none for the dirty case. `tests/session.test.ts:218-234` ("skips files that no longer exist") pins the skip for clean tabs only. `#unsavedText` returning null for a missing backup (session.ts:258-261) is a different guard. The counter is only ever seeded from a damaged index (session.ts:492); `#read`'s success path never touches it, and `restore()` never registers restored backups into `#backups`, so every restored dirty buffer is renamed on the first save after boot. The first save happens 400 ms after any `buffers`/`activeId`/`rootPath` change once `markReady` runs (app.ts:425, 632-637; session.ts:277-283): the first tab switch is enough, no edit required.
Severity:    P1 stands. Normal path: edit, quit (no prompt by design), `git checkout` a branch lacking the file, relaunch. While running, the watcher keeps the same tab open as `deleted` with a warning (watcher.ts:204-214); across a restart the policy silently inverts. The overwrite clobbers a *different* tab's backup (b's text lands on a's file), and the untitled variant shows any surviving dirty or scratch tab does it. Data-loss by the orientation's definition; the trigger needs an external delete between sessions, so P1 rather than P0 is reasonable.
Risk class:  Safe. session.json version 4 is unchanged; backup file names keep their pattern.
Minimal fix: Two independent halves. (1) In `restore()`, when the path is missing and `tab.unsaved` names a backup with text, restore the buffer anyway and mark it `externalState: 'deleted'`, matching the watcher; that needs a workspace entry point that creates a path-bearing buffer without reading the disk (`open` reads the file), or falls back to `newUntitled({ content, name })` with a warning toast. (2) On a good index, seed `#nextBackup` from `highestNumbered(raw, /unsaved-(\d+)\.txt/g) + 1` exactly as `#damaged` does, and have `restore()` register each restored buffer's backup name into `#backups` with its current revision so the name is kept rather than reissued.
Notes:       Tests to add in `tests/session.test.ts`: the two-tab repro asserting a.ts is restored dirty and `unsaved-1.txt` still holds its text after a save; the counter test asserting a fresh `SessionService` on a good index never writes a name the index already uses. Trap: restored buffers whose backup name is registered must record the revision *after* `restoreUnsaved` runs, or the first save rewrites every backup once (harmless but wasteful). The orphaned `unsaved-2.txt` in the repro is a side effect of the same missing registration and goes away with fix (2).

## A3-005 Save with insertFinalNewline and every external reload replace the whole document, sending the cursor to offset 0; on save the pane then scrolls to the top
Verdict:     CONFIRMED
Reproduced:  yes, with a real `EditorView` under jsdom (scratch, deleted), wired as `EditorPane` wires it: `dispatchTransactions` forwarding to `applyTransaction`, a `ViewDispatcher` accepting the buffer, and `buffer-reset` handled as `view.setState(workspace.stateOf(id))` (EditorPane.svelte:210-212, 321). Printed:
             Save, file lacking a final newline, cursor at 10 after an edit: `{"before":10,"after":0,"doc":"line one\nXline two\nline three\n","dirty":false}`. Second save of the now-terminated file: `{"secondSave":10}` (no jump).
             Save with both options off: `{"saveNoOptions":10}` (no jump).
             External reload of a clean buffer with one line appended, cursor at 14: `{"head":0,"dirty":false}`.
             `EditorState` alone, whole-doc replace: cursor 0 -> 0, 3 -> 0, end-of-doc 11 -> 12. Only a cursor at the very end survives.
             `files.insertFinalNewline` defaults to true: schema.ts:308 `bool(true, ...)`, and `app.ts:2660-2663` passes it on every save.
Guard found: none. No selection mapping or restoration exists on the save path: `save()` assigns `buffer.state` directly and emits `buffer-reset` (workspace.ts:996-999); `syncToBuffer({ force: true })` calls `setState`, `takePaneSelection` returns nothing for a save, and the trailing dispatch is `scrollIntoView: true` (EditorPane.svelte:348-353), which scrolls to the cursor now at 0. Consumers of `'saved'` (app.ts:611, git.ts:144) do not touch the selection. Reload goes through `#dispatchToView` (workspace.ts:1136), so the viewport stays but the caret still maps to 0. `tests/workspace.test.ts:140-146` checks only the bytes written.
Severity:    P1 stands, narrowly. Default on; triggers on every save of a document whose last line is unterminated, which is exactly the state of a user appending at the end of a file, and it costs cursor, viewport and any transient view state through `setState`. The pure jump has a workaround (turn the setting off, or end the file with a newline), which alone would be P2. What keeps it P1 is the reload half: after a `git checkout` or an external formatter rewrites a clean open file, the caret is silently at offset 0 while the viewport has not moved, so the next keystroke inserts at the top of the file. `trimTrailingWhitespace` (default off) takes the same save path.
Risk class:  Safe. No schema change (the setting keeps its meaning), no API or format change.
Minimal fix: Stop replacing the whole document. For the final newline the edit is `{ from: doc.length, insert: '\n' }`; for trailing-whitespace trimming, one change per affected line; dispatch through `#dispatchToView` with `buffer.state` as the fallback, exactly as `reloadFromDisk` already does, so selection and scroll map naturally and `buffer-reset` (and the `setState`) is no longer needed on save. For reload, turn `src/core/diff.ts` hunks into a `ChangeSet` so unchanged regions map cursors and folds untouched. Doing the save half first also removes the `setState` that A3-001's fix would otherwise still trigger.
Notes:       Tests to add: in `tests/workspace.test.ts`, a `() => []` state with a selection at 10, `save(id, { insertFinalNewline: true })`, assert `stateOf(id).selection.main.head === 10` and no `buffer-reset` emitted; same for reload with a background buffer. A jsdom `EditorView` test (pattern: `tests/find-focus.test.ts`) can hold the view's `selection.main.head` across the save. Trap: `git.ts:155` refreshes gutters on `buffer-reset`; if save stops emitting it, make sure the `'saved'` handler at git.ts:144 still refreshes. Ordering: fix A3-005's save path together with A3-001, since both edit the same block at workspace.ts:989-999.
## A6-001 A language server can abort the whole editor with one Content-Length header
Verdict:     DOWNGRADE to P2
Reproduced:  yes. `MessageStream` copied verbatim from `src-tauri/src/lsp.rs:73-129` into a scratch crate
             with the same `[profile.release]` (`panic = "abort"`, no overflow-checks; the repo has no
             `.cargo/config.toml` at any level, so rustc's release default applies). Fed
             `Content-Length: 18446744073709551615\r\n\r\n{}`:
             release, main thread:   `panicked at src\main.rs:46:36: slice index starts at 40 but ends at 39`, exit 0xC0000409
             release, std::thread:   same panic on `<unnamed>`, process exit 0xC0000409 (main never resumed)
             debug, std::thread:     `attempt to add with overflow` on `<unnamed>`, main printed
                                     `main thread survived; reader thread join = Err(panic)`, exit 0
             `Content-Length: 4294967296` (4 GiB, valid): `Ok(0)`, `buffer_cap=32`. No allocation, the
             stream just waits for a body that never completes. No abort from a huge valid length.
             Band check: `usize::MAX - 39` panics (`starts at 40 but ends at 0`); `usize::MAX - 40` returns
             `Ok(0)`. So for this header exactly 40 values of the 2^64 space crash, all 20-digit.
             Mechanism confirmed exactly as the auditor said: `length` is `usize` from `str::parse`
             (lsp.rs:100-105); `body_start + length` wraps in release (lsp.rs:116-117), the `len <` test
             then passes, and the slice at lsp.rs:121 panics. In debug the add itself panics. The parser
             runs on the plain `std::thread::spawn` at lsp.rs:244, outside any Tauri command catch, and
             `panic = "abort"` (Cargo.toml:85) turns any thread panic into process termination.
Guard found: none in the parser. No length cap, no `checked_add`. The only other panic-capable line in the
             reader loop is the same slice; `String::from_utf8` and `drain` are behind the check.
Severity:    P2, because the trigger is 40 exact values near 2^64 rather than any malformed header. An
             ordinary buggy server (off-by-one, wrong encoding count) desynchronises framing and hits the
             existing `Err` paths, not this. Reaching the band needs a hostile server or a C/C++ server
             whose `size_t` length underflowed to `(size_t)-1`, which is exactly `usize::MAX`. And the
             "hostile server" threat adds nothing: a server in `servers.json` already runs unsandboxed
             with the user's privileges (the Known debt row on agent and plugin processes covers the same
             class), so crashing Nox is the least it could do. What remains is a robustness defect with a
             bad outcome (abort, no dialog; unsaved edits bounded by the 400 ms session backup debounce at
             `src/services/session.ts:278`) and a narrow trigger. That is P2 by the orientation's
             definitions. It should still be fixed: it is three lines.
Risk class:  Safe. Parser-internal; no API, format or config change.
Minimal fix: In `MessageStream::push`, replace `body_start + length` with `body_start.checked_add(length)`
             and return `Err("lsp: Content-Length out of range")` on `None`; optionally also refuse a
             length above a cap (64 MiB is generous for LSP). Both go down the existing framing-error
             path, which the reader thread already reports on `nox://lsp-stderr` and then stops.
Notes:       Add two tests beside `errors_on_an_unparseable_length` (lsp.rs:534): `usize::MAX` must be
             `Err`, and a 4 GiB length with a short body must be `Ok(empty)` (or `Err` if a cap is added;
             say which). Note for the wider audit: with `panic = "abort"`, every reader thread in the
             crate (lsp, agent, pty, watcher) is one latent panic away from killing the app. That is a
             profile decision, not a bug, but it raises the cost of any `unwrap` or index on those
             threads. The repro crate was deleted after the run.

## A2-002 48 of 49 IPC commands run inline on the main thread
Verdict:     CONFIRMED (P1), with one correction to the fix
Reproduced:  partly. Count verified: `generate_handler!` at `src-tauri/src/lib.rs:129-180` lists 49 commands
             (fs 17, git 8, http 2, watcher 6, search 2, agent 4, pty 5, lsp 4, menu 1); grep over
             `src-tauri/src` finds exactly one `#[tauri::command(async)]`, `nox_git_blame` at git.rs:474,
             and 48 plain `#[tauri::command]`. Macro verified in the vendored source: tauri-macros 2.6.3
             `src/command/wrapper.rs:262-266` labels a plain command `"sync"` and `(async)` on a non-async
             fn `"sync_threadpool"`; `body_blocking` (wrapper.rs:404-435) emits `let result = $path(...)`
             inline in the handler, while `body_async` (361-402) wraps the call in
             `resolver.respond_async_serialized(async move { ... })`, whose release body
             (`tauri-2.11.5/src/ipc/mod.rs:371-375`) calls `crate::async_runtime::spawn`, the tokio pool.
             The handler itself is reached from `webview.on_message` (tauri `webview/mod.rs:1742`) called
             by the custom-protocol handler in `ipc/protocol.rs:60-70` or `handle_ipc_message`
             (protocol.rs:185), which wry hands to Tauri from the webview's own callback. That those
             callbacks fire on the UI thread (WebView2 event handlers, WebKitGTK scheme handlers, WKWebView
             message handlers) is platform knowledge I did not instrument; it is stated by Tauri's docs
             and by this repo's own reading in `ARCHITECTURE.md:1673-1674` and the `nox_git_blame` doc
             comment (git.rs:437-454). Not measured: the felt durations. Not attempted because it needs a
             packaged build with a hook; the durations are not in doubt for the commit case.
Guard found: none. The auditor's claim that every renderer caller awaits is true and beside the point,
             as the Known debt row already says.
Severity:    P1, because `nox_git_commit` (git.rs:264-315) calls `child.wait_with_output()` at git.rs:305,
             so a pre-commit hook that runs a linter or tests holds the window, menu and repaint for the
             hook's whole duration; that is seconds to tens of seconds on a normal path for this
             audience, with no workaround inside the app. `nox_git_switch` (checkout of a large tree) and
             `write_then_rename`'s `file.sync_all()` at fs.rs:186 on every save (network or slow disk)
             are the same shape. The LSP pipe-write case is real but weaker than stated: servers drain
             stdin on their own reader thread, so a multi-megabyte `didChange` blocks for pipe throughput,
             not for the server's indexing, unless the server has stalled. I would rate that part Likely
             rather than Confirmed. The Known debt row "The two older git reads still run on the main
             thread" (`ARCHITECTURE.md:2656`) has the right mechanism and the wrong scope: it names two
             reads, and the writes are the ones that hurt. Agree with the auditor on that.
Risk class:  Safe for the awaited commands; NOT Safe as a blanket `(async)` conversion. Every `Platform`
             call in `src/platform/tauri.ts` routes through `call()` (tauri.ts:883) and every fs/git/watch
             call is awaited, so promise order is preserved and a write-then-read stays ordered. But three
             commands are fired without awaiting: `nox_pty_write` per keystroke (`src/services/terminal.ts:121`
             `void this.#session?.write(data)`), `nox_lsp_send` from `void session.notify(...)`
             (`src/services/lsp/documents.ts:164`, `session.ts:301`), and `nox_agent_send`. Today they
             arrive in order because each sync body runs to completion inline before the next IPC message
             is handled. Under `sync_threadpool` each becomes an independent tokio task racing for the
             registry mutex, so typed bytes can reach the shell out of order and `didChange` versions can
             go backwards. So `(async)` is fine for git and fs; the three `*_send`/`_write` commands need
             an ordered hand-off instead.
Minimal fix: Mark `nox_git_commit`, `nox_git_switch`, `nox_git_stage`, `nox_git_unstage`, `nox_git_status`,
             `nox_git_branches`, `nox_git_file_base`, `nox_write_text_file`, `nox_write_encoded_file`,
             `nox_read_encoded_file`, `nox_read_text_file`, `nox_trash`, `nox_copy_file`
             `#[tauri::command(async)]`; bodies unchanged. For `nox_lsp_send`, `nox_agent_send` and
             `nox_pty_write`, keep them sync and make them non-blocking: give each spawned process a
             `std::sync::mpsc::Sender<Vec<u8>>` drained by one writer thread that owns the stdin handle.
             The command does `sender.send(frame(&message))` under the registry lock and returns; order is
             the channel's order, and the registry lock is never held across a pipe write (which also
             gives the auditor's "kill cannot be blocked by a slow consumer" for free).
Notes:       All 48 already return `Result`, so the `(async)` compile rule about borrowed args is not hit;
             `State<'_, T>` args are fine under `sync_threadpool`, but run `cargo clippy --all-targets
             -- -D warnings` after the change because the macro's expansion differs. Update the Known
             debt row and the `nox_git_blame` comment ("the crate's only `(async)`") in the same PR, and
             the `ARCHITECTURE.md:1671` heading. A writer thread must exit when the process does: drop the
             sender on `stop`/exit so the thread's `recv` returns `Err`. Tests: the existing
             `fileops_integration` covers the fs bodies; add a Rust test that two `send`s through the
             channel path land in order, and leave the "window does not freeze" claim to a manual
             desktop walk with a `sleep 5` pre-commit hook (`nox-desktop-walk` skill).

## A1-001 / A8-003 Nox cannot receive a file from the OS
Verdict:     CONFIRMED at P1 (A1's rating); A8's P2 is the rating for the association and single-instance halves
Reproduced:  not attempted as a runtime test (needs a packaged build); each absence verified by reading.
             (1) argv: the only `std::env::args()` read is `geometry::geometry_from_args(std::env::args())`
             at lib.rs:57-58, and `geometry_from_args` (geometry.rs:79-96) scans for `--geometry` /
             `--geometry=` only and returns `None` for anything else. (2) `fileAssociations`: absent from
             the `bundle` block (tauri.conf.json:45-62), which has targets, category, descriptions, icons
             and `macOS.minimumSystemVersion` only. (3) `RunEvent::Opened`: the builder ends in
             `.run(tauri::generate_context!())` at lib.rs:181, not `.build().run(|app, event| ...)`, so
             no run-event callback exists; grep for `RunEvent` and `Opened` over `src-tauri/src` is empty.
             (4) single instance: `Cargo.toml:16-58` lists dialog, updater, process and the optional wdio
             plugin; grep for `single-instance`, `single_instance`, `deep-link`, `plugin-cli`,
             `getMatches` over `src-tauri/` and `src/platform/` is empty. `dragDropEnabled: true`
             (tauri.conf.json:27) feeding `openDroppedPaths` (`src/app.ts:2165`) is the only OS-to-editor
             path, and `e2e/wdio.conf.js:89` already records that two instances would fight over one
             session. No doc mentions Open With, a command line or associations (grep over README,
             ARCHITECTURE, ROADMAP, docs/, plans/: one unrelated hit), so this is an omission, not a
             recorded decision, even though ROADMAP says unlisted things are unplanned.
Guard found: none. Drag-and-drop is a partial workaround only once the window is already open; it does
             not cover `nox notes.txt`, Open With, or a double-click, all of which launch a process that
             ignores the path and shows the previous session.
Severity:    P1 for "the app ignores a file it is handed" (argv on Windows/Linux, `Opened` on macOS).
             Reasoning: the orientation's P1 is "materially incomplete" or "significant UX failure"; P2
             needs a workaround or a narrow trigger. Being handed a file is the base entry point of a text
             editor, every user hits it in the first minute, and the observed behaviour (launches, shows
             the old session, drops the argument silently) is a failure rather than a missing nicety.
             Drag-and-drop is not a workaround for a launch that has already discarded the path. The two
             other halves are P2 on their own: no registered associations means Nox is absent from the
             Open With list until the user browses to the binary (friction, not failure), and a second
             instance is a session-file race the e2e config already knows about (real, but needs two
             launches). A8 rated the whole as P2; I side with A1 for the argv/Opened core and with A8 for
             the rest.
Risk class:  Split. Argv parsing plus a macOS `RunEvent::Opened` handler that emits the paths to the
             renderer is Safe: no public API, config schema, keybinding or permission change; a new
             internal event on the same door `openDroppedPaths` already uses; behaviour changes only for
             a launch that passes a path, which is discarded today. `bundle.fileAssociations` is Gated:
             it changes what the NSIS installer, the .app's Info.plist and the deb/rpm desktop entry
             register, which is user-visible on install and upgrade. `tauri-plugin-single-instance` is
             Gated: it changes what a second launch does and adds a plugin with its own capability entry.
             So: agree the finding as a whole is Gated, disagree that all of it is. Land the Safe half
             first.
Minimal fix: In `setup`, collect positional args (skipping `--geometry` and its value, which
             `geometry_from_args` must keep seeing), canonicalise, and hold them in managed state; on
             macOS handle `RunEvent::Opened { urls }` the same way. Expose one command or event the
             renderer reads after boot and feeds to `openDroppedPaths`. Then, separately and Gated,
             `fileAssociations` for the extensions in `core/languages.ts` and the single-instance plugin
             forwarding argv to the live window.
Notes:       Ordering trap: on macOS `Opened` can fire before the webview has booted, and on all
             platforms argv exists before the renderer is listening, so buffer the paths in state and let
             the renderer pull them (the same buffered-until-handler pattern `tauri.ts` uses for LSP and
             agent events), rather than emitting into a window that is not there yet. Finder-launched
             apps get no argv (the comment at lib.rs:46 is right), so argv alone does not fix macOS.
             Directories in argv should open a folder, not a file. Keep the `--geometry` test affordance
             working: `tests`/`e2e` and the desktop-walk skill depend on it. Tests: a Rust unit test for
             the arg splitter (positional vs `--geometry`), and a renderer test that the boot path calls
             `openDroppedPaths` with what the platform reports.


## A3-002 Grouped undo throws RangeError when a file is in two panes and the second pane dispatched last
Verdict:     DOWNGRADE to P2
Reproduced:  yes. Two real `EditorView`s under jsdom wired exactly as `EditorPane.svelte` wires them
             (`dispatchTransactions` forwarding non-mirrored transactions to `applyTransaction`, a
             view dispatcher per pane with `owner: view`), `openCopyToSide()`, a two-buffer
             `workspace.apply`, a selection-only `dispatch` in the second pane, then
             `undoChangeSet(pendingGroupedUndo())`. Printed, in both set orderings:
             `RangeError: Trying to update state with a transaction that doesn't start from the
             previous state.` from `EditorView.update` via `#dispatchToView` (workspace.ts:409) inside
             `#runOnBuffer` (1581-1584). With the mirrored buffer second in the set, the first buffer
             was already undone when the throw landed (`b` back to `beta`, `a` still `X alpha`) and
             its `#undoIndex` entry popped: the half-undone state the auditor describes.
             `pendingGroupedUndo()` still returns the set afterwards, so a retry throws again.
             Control runs (single pane; or first pane dispatched last) undo cleanly.
Guard found: two, and together they change the severity, not the verdict.
             (1) The exception is caught. `#step` runs inside `CommandRegistry.execute`
             (commands.ts:205-214), whose `catch` logs, calls the failure sink (`app.ts:259`, a red
             toast "Undo failed: Trying to update state...") and rethrows into a promise every
             caller `void`s; the `unhandledrejection` backstop then dedupes the same error object
             (`#reportedErrors`, app.ts:1014-1021). One toast, no crash, no broken pane.
             (2) The keyboard never reaches this code. `edit.undo` has no application keybinding
             (`#registerKeybindings`, app.ts:4533ff has no Mod+Z; `keyHint` is display-only, see
             EditorPane.svelte:422 and CommandPalette.svelte:299; `tests/keybindings-panel.test.ts:110`
             asserts `displayFor('edit.undo')` is undefined). Cmd+Z is CodeMirror's own
             `historyKeymap` (extensions.ts:211) against the focused view's state, which cannot
             mismatch, and Edit > Undo is the predefined system item (`COVERED_BY_SYSTEM_ITEMS`,
             menu.ts:73-77) that goes down the responder chain to the same place. The auditor's
             "click into the second pane, press Cmd+Z" scenario therefore does not throw. What does:
             the Command Palette's "Undo" entry, "Undo Last Project Replace" (`search.undoReplace` ->
             `undoLastReplace`, search.ts:748, no try/catch of its own, toast reads "Undo Last Project
             Replace failed"), and any agent or plugin calling `commands.execute('edit.undo')`.
             Workaround verified: one click in the first pane makes `buffer.state` that pane's again
             and the same `undoChangeSet` then succeeds (`{"undone":["buf-1","buf-2"]}`).
Severity:    P2, because the trigger needs four things at once (a mirrored pane, a multi-buffer change
             set, the second-registered pane touched last, and undo through the palette, the replace
             panel or an agent rather than Cmd+Z), the outcome is a toast and a no-op rather than a
             crash or lost text, and clicking the other pane clears it. The real cost is the index left
             describing a half-undone set when the mirrored buffer is not first, and an agent's
             `edit.undo` failing with an error it cannot act on. That is "correctness issue with a
             workaround", not "feature broken".
Risk class:  Safe. Fix is inside `WorkspaceService`, no API, format, keybinding or permission change.
Minimal fix: In `applyTransaction` remember which pane produced `buffer.state` (the `origin`), and have
             `#runOnBuffer` run the command through that pane (add a `run(id, command)` on the view
             channel that calls `command(view)`, so the transaction is built from and dispatched to the
             same state), falling back to the first acceptor only when no pane owns the current state.
             Never hand a `Transaction` object to a view whose state is not its `startState`.
Notes:       Test it with two real `EditorView`s in jsdom (they mount fine outside `EditorPane`; see the
             repro shape above). `tests/groups.test.ts:660-705` and `tests/pane-fidelity.test.ts`'s
             `FakePane` model a pane as an `EditorState.update`, which accepts any start state, so they
             cannot see this; say so in the new test's comment. `undoActive`/`redoActive`
             (workspace.ts:1488-1496) take the same path and throw the same way, but nothing calls
             them. Separate wrinkle the fix should not paper over: each view keeps its own history
             field, so the depth check in `#stepChangeSet` (1549) reads one pane's history while the
             undo may run on the other's; routing by origin keeps the two on the same pane.

## A3-003 Close Editor Pane and Move Editor to Next Pane put the same buffer twice in one pane, which the keyed tab strip refuses to render
Verdict:     CONFIRMED
Reproduced:  yes, at both levels.
             Service: open `a.ts`, `openCopyToSide()`, then `closeGroup(copy)` -> `[["buf-1","buf-1"]]`;
             `closeGroup(original)` -> same; focus the original and `moveActiveToGroup(1)` -> same;
             the drag-and-drop route `moveTab(a, 0, copyGroup)` (TabBar.svelte:241) -> same. One
             direction the auditor did not list, `moveActiveToGroup(-1)` from the copy, does not
             duplicate but silently does nothing: `#groupOf(id)` without a group id (workspace.ts:846)
             finds the first group showing the buffer, which is the original, so `moveTab` removes and
             reinserts it there and the layout stays `[["buf-1"],["buf-1"]]`.
             UI: `EditorArea` mounted through `tests/support/component`, same sequence. `closeGroup`
             threw `Svelte error: each_key_duplicate ... duplicate key buf-1 at indexes 0 and 2` out of
             the flush. The strip kept its pre-close DOM (`["buf-1","buf-2"]`, stale) while the
             workspace held `[["buf-1","buf-2","buf-1"]]`. Every later `#sync` threw again: three
             keystrokes into `b` produced three more throws, the dirty dot never appeared, and
             `setActive(b)` threw with the strip still highlighting `buf-1`. Closing `a` once removed
             one copy and the strip repainted correctly (`["buf-2","buf-1"]`, dirty dot on `b`); the
             buffer itself stayed open because `close` (workspace.ts:571) only removes one occurrence
             per group and `stillShown` is then true, so a user has to press Cmd+W twice.
             Production: confirmed from `node_modules/svelte/src/internal/client/dom/blocks/each.js:355-361`
             (the non-DEV branch calls `e.each_key_duplicate('', '', '')`, which throws
             `new Error('https://svelte.dev/e/each_key_duplicate')`, errors.js:145-146), and the string
             is present in the built bundle `dist/assets/index-BPrsOkEZ.js`. The throw is before any
             DOM reconciliation in both modes, so the stale-strip behaviour is the same in production.
Guard found: none upstream. `mirrorInto` (870-871) is the only route that checks; `closeGroup` (791),
             `moveTab` (698) and `moveActiveToGroup` (829) do not, and `#sync` (1899) snapshots
             `group.order` verbatim. `EditorArea`/`EditorGroupView` pass the list through. One
             downstream guard the auditor got wrong: session restore does not replay the duplicate.
             Save writes the second copy with `mirror: true` (session.ts:293-297; verified in the
             written `session.json`), and restore routes a mirror through `mirrorInto` (192-196), which
             refuses it, so the restored layout was `[["a.ts"]]`. A relaunch heals it; the running
             session does not.
Severity:    P1, because both commands are shipped and Close Editor Pane is the natural way to end
             "Open Copy to the Side"; the outcome is a tab strip that stops updating (no active
             highlight, no dirty dot, no new tabs) plus, in the packaged app, a "Something went wrong"
             toast on every keystroke and tab switch from the `error` backstop (app.ts:1052-1093), a
             fresh Error object each time so `#reportedErrors` cannot dedupe it. Recovery (close the
             tab twice, or relaunch) is not discoverable from the symptom. No data loss: the workspace
             state is coherent and text is intact. The claim about the toast is the one thing not
             observed: jsdom routes a microtask throw to `process`, not `window`, so the browser-side
             `error` event reaching `#reportFailure` is derived, not run.
Risk class:  Safe. Contained to `WorkspaceService` (and a `groupId` parameter on `moveTab` that the
             existing caller can supply); no format, API, keybinding or permission change. Session
             files already tolerate the duplicate.
Minimal fix: `closeGroup`: push only ids the neighbour lacks and keep `activeId` on the existing tab.
             `moveTab`: when `to !== from` and `to.order.includes(id)`, remove from `from`, activate in
             `to`, and skip the insert. `moveActiveToGroup` should pass the active group to
             `#groupOf` so the move from the copy pane works instead of no-op'ing.
Notes:       Add to `tests/groups.test.ts`: close-pane over a mirrored buffer in both directions,
             move-to-next from the original, move-to-previous from the copy, and `moveTab` onto a strip
             already showing the buffer. Existing `closeGroup` (215-225) and `moveTab` (149-180) tests
             never use a mirrored buffer. A cheap belt for the future: an invariant in `#sync` (or a
             test over every group-mutating method) that no `order` holds an id twice, since three
             separate routes got this wrong independently. `TabBar.svelte`'s "Close this pane" button
             (374) and `EditorGroupView.svelte:49` reach `closeGroup` too, so the fix covers the mouse
             path as well.

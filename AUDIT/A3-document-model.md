# A3 Multi-file Editing and Document Model

Audited at commit `54cece6e`. Read-only. Every scenario marked "probe" below was executed against the real `WorkspaceService`, `SessionService` and `MemoryPlatform` (and, where the view matters, a real `@codemirror/view` `EditorView` under jsdom) from a throwaway vitest file in the temp directory, since deleted. The lane's own suites were run first: `tests/workspace.test.ts`, `session.test.ts`, `session-backups.test.ts`, `transactions.test.ts`, `groups.test.ts`, `watcher.test.ts`, `search.test.ts`, `replace.test.ts`, `replace-single-matches.test.ts`, `encoding-round-trip.test.ts`, `tab-dirty-affordance.test.ts`: 11 files, 262 tests, all pass in 1.4 s.

## Summary

The document model is well shaped: one `EditorState` per buffer owned by `WorkspaceService`, a `savedDoc` that shares structure with the live `Text` rather than copying it, atomic temp-and-rename writes with `sync_all`, change sets validated in full before any dispatch, a 64 MB open guard, a NUL sniff for binaries, and per-buffer backups that keep `session.json` small. Fifty open files cost nothing measurable per keystroke (7 us for `applyTransaction` plus the full re-snapshot). What lets it down is the seams where an `await` sits inside a mutation, and the places where a whole document is replaced as one change. The strongest finding is A3-001: a keystroke typed while a save's write is in flight is reverted out of the buffer, never reaches disk, and the buffer reports clean. Close behind are A3-004 (a dirty tab whose file vanished between sessions is dropped and its backup file is then reused for another buffer) and two crash-shaped defects in split panes (A3-002, A3-003). Sub-score 4 of 7: the model holds up at 50 files and refuses rather than falls over on a huge file, but there are two real data-loss paths and a normal-path exception, and the README's "It does not lose your work. Ever." is not true as written.

## Sub-score

4 / 7

Justification: A3-001 and A3-004 are data-loss paths, which the rubric places at 3 to 4. The rest of the model is sound, deliberately designed and mostly tested, and no cliff was found at 50 files or at the 64 MB limit, which is why this is a 4 rather than a 3. A3-002 and A3-003 (uncaught exceptions from mirrored panes) and A3-005 (save and reload send the cursor to offset 0) cost the point that A3-001 alone would not have.

## Findings

```
ID:          A3-001
Lane:        Multi-file editing and document model
Severity:    P1
Title:       Keystrokes typed while a save's write is in flight are reverted from the buffer, never written, and the buffer is marked clean
Location:    src/services/workspace.ts:966-1017 (save), specifically 973, 983, 991-999, 1002-1003
Evidence:    `save()` snapshots the text, awaits the write, then compares the snapshot against whatever the document is now:
               973:  let text = buffer.state.doc.toString();
               983:  await this.#platform.writeEncodedFile(buffer.path, onDisk, buffer.encoding);
               991:  if (text !== buffer.state.doc.toString()) {
               993:    changes: { from: 0, to: buffer.state.doc.length, insert: text },
               996:    buffer.state = transaction.state;
              1002:  buffer.savedDoc = buffer.state.doc;
              1003:  buffer.savedChangeCount = buffer.changeCount;
             The comment at 989-990 says this branch exists for "Formatting on save", but the condition is simply "the document differs from what was written", which is also true when the user typed during the await. Nothing guards against a save in flight; there is no in-flight flag on `Buffer`.
             Probe (real WorkspaceService, MemoryPlatform with a gated `writeEncodedFile`): open 'alpha\n', type 'A', start `save()`, type 'B' while the write is pending, release the write. Result: disk 'Aalpha\n', document 'Aalpha\n', isDirty false. The 'B' was removed from the buffer by the whole-document replacement at 993 and is on disk nowhere. Same result with `insertFinalNewline: true`.
Impact:      Any save whose write takes longer than the gap to the next keystroke. Concretely: `files.autoSave: afterDelay` fires after a 1 s pause (src/ui/EditorPane.svelte:387-398); the user resumes typing as the write and its `sync_all` (src-tauri/src/fs.rs:186) are still running, which on a laptop HDD, a network share, or a large file is tens to hundreds of milliseconds; the first characters they typed vanish from the screen and the tab shows clean. The same applies to Cmd+S pressed mid-sentence, and to `onFocusChange`. The text is still in undo history (the replacement at 993 is a real transaction), so it is recoverable by Cmd+Z, but nothing tells the user that, and `buffer-reset` at 998 makes the pane `setState` (src/ui/EditorPane.svelte:211, 321), so the cursor also moves (see A3-005). README.md:80 ("It does not lose your work. Ever.") does not hold here.
Fix sketch:  Compute the formatted text and the on-disk text once; if the document changed during the await, do not replace it. Instead diff `text` against the current document and apply only the formatting edits (or simply mark the buffer dirty and skip the reformat), and set `savedDoc` to the `Text` that was actually written rather than to `buffer.state.doc`. A per-buffer `saving` promise that a second `save()` awaits would also close the double-save case.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A3-002
Lane:        Multi-file editing and document model
Severity:    P1
Title:       Grouped undo throws RangeError when a file is in two panes and the second pane dispatched last
Location:    src/services/workspace.ts:1577-1590 (#runOnBuffer), 405-411 (#dispatchToView), 895-898 (applyTransaction); src/ui/EditorPane.svelte:130-142, 165-174
Evidence:    `applyTransaction` makes `buffer.state` whichever pane's state dispatched last, including for selection-only transactions:
               895:  applyTransaction(id: BufferId, transaction: Transaction, origin?: object): void {
               898:    buffer.state = transaction.state;
             `#runOnBuffer` builds an undo transaction from that state and hands the *Transaction object* to the first pane that accepts the buffer id:
              1582:      state: buffer.state,
              1584:        if (this.#dispatchToView(id, transaction)) return;
               405:  #dispatchToView(id: BufferId, spec: TransactionSpec | Transaction): boolean {
               409:      if (channel.dispatch(id, spec)) return true;
             The pane's channel is `view.dispatch(spec)` (EditorPane.svelte:168). `@codemirror/view` 6.43.8 refuses a transaction whose `startState` is not the view's own state (node_modules/@codemirror/view/dist/index.js:7953-7954: "Trying to update state with a transaction that doesn't start from the previous state"). The first registered pane is the original one; the state the transaction was built from belongs to the copy.
             Probe (two real `EditorView`s wired exactly as EditorPane wires them, `openCopyToSide`, a two-buffer change set applied through `workspace.apply`, then a click in the second pane as a selection-only dispatch, then `undoChangeSet`): `pendingGroupedUndo()` returned the set id and `undoChangeSet` threw `RangeError: Trying to update state with a transaction that doesn't start from the previous state.`
Impact:      Open Copy to the Side, run a project replace (or any multi-buffer change set: an LSP rename, an agent edit), click into the second pane, press Cmd+Z. `NoxApp.#step` (src/app.ts:890-901) calls `undoChangeSet` synchronously from the keymap; the exception is uncaught, the grouped undo does not happen, and because `#stepChangeSet` (1540-1573) pops `#undoIndex` per buffer as it goes, any buffer earlier in the set than the mirrored one has already been undone and re-indexed when the throw lands, leaving the index and the log describing a half-undone set. `undoLastReplace` in src/services/search.ts:745-750 takes the same path. `tests/groups.test.ts:660-705` model a pane as a bare `EditorState`, which cannot see this, because only the real view enforces `startState`.
Fix sketch:  Never dispatch a `Transaction` to a view; dispatch the spec. In `#runOnBuffer`, hand the view `{ changes: tr.changes, selection: tr.selection, effects: tr.effects, annotations: tr.annotations }` (or run the command against the view's own state by asking the pane to run it), and keep `buffer.state` for the background fallback only. Alternatively make `#dispatchToView` route to the pane whose `owner` produced `buffer.state`.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A3-003
Lane:        Multi-file editing and document model
Severity:    P1
Title:       Close Editor Pane and Move Editor to Next Pane put the same buffer twice in one pane, which the keyed tab strip refuses to render
Location:    src/services/workspace.ts:784-797 (closeGroup), 815-830 (moveActiveToGroup), 690-702 (moveTab); src/ui/TabBar.svelte:264; src/app.ts:4078-4086, 4109-4124
Evidence:    `mirrorInto` refuses a duplicate ("a tab cannot be shown twice in one pane", workspace.ts:870-871) but the two other routes into a group do not check:
               791:    neighbour.order.push(...group.order);
               698:    to.order.splice(clamped, 0, id);
               829:    this.moveTab(id, target.order.length, target.id);
             The tab strip is a keyed each over the group's tabs (TabBar.svelte:21, 264: `{#each buffers as buffer, index (buffer.id)}`). Svelte 5.56.9 throws `each_key_duplicate` for a duplicate key in production as well as dev (node_modules/svelte/src/internal/client/dom/blocks/each.js:355-361: the non-DEV branch calls `e.each_key_duplicate('', '', '')`).
             Probe: open a file, `openCopyToSide()`, `closeGroup(group-2)`: group-1 tabs are `["buf-1","buf-1"]`. Open a file, `openCopyToSide()`, focus group-1, `moveActiveToGroup(1)`: layout is `[["buf-1","buf-1"]]`.
Impact:      View > Open Copy to the Side, then Close Editor Pane (Cmd+Shift+\) or Move Editor to Next Pane, both shipped commands. The workspace publishes a group with a duplicated id, `TabBar`'s keyed block throws during the update, and the reactive graph is left mid-flush with an uncaught error; the tab strip stops updating at best. Session save then records the same tab twice and restore replays it. `tests/groups.test.ts` covers `closeGroup` folding tabs into the neighbour (215) and `moveTab` (149) but never with a mirrored buffer.
Fix sketch:  In `closeGroup`, push only the ids the neighbour does not already hold (and keep `activeId` sensible when the folded tab already exists); in `moveTab`, when `from !== to` and `to.order.includes(id)`, treat the move as a close in `from` plus an activate in `to`. Add the two probe cases above to `tests/groups.test.ts`.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A3-004
Lane:        Multi-file editing and document model
Severity:    P1
Title:       Session restore silently drops a dirty tab whose file is missing, and the backup counter restarting at 1 then overwrites its unsaved text
Location:    src/services/session.ts:148, 187, 385-394, 492
Evidence:    Restore skips a tab whose path does not exist before it ever looks at `tab.unsaved`:
               187:          if (!(await this.#platform.exists(tab.path))) continue;
             The comment reads "A file may have been deleted since last launch; skip it quietly." Backup names come from a counter that is a fresh field on every launch and is only ever recovered from a *damaged* index, never from a good one:
               148:  #nextBackup = 1;
               385:    const name = existing?.name ?? `unsaved-${this.#nextBackup++}.txt`;
               492:    this.#nextBackup = highestNumbered(raw, /unsaved-(\d+)\.txt/g) + 1;   // #damaged only
             Probe: two dirty file tabs saved as `unsaved-1.txt` (a.ts) and `unsaved-2.txt` (b.ts); trash a.ts; new WorkspaceService and SessionService on the same platform; `restore()`; `save()`. a.ts is not open, and `unsaved-1.txt` now reads `"UNSAVED-B beta\n"`. The unsaved text for a.ts is gone.
Impact:      Edit a file, quit (no prompt, by design), and let anything remove or rename that file before the next launch: `git checkout` of a branch that lacks it, a `git stash`, a build that regenerates a directory, a rename in another tool. On relaunch the tab is gone with no notice, and within 400 ms of the first edit to any other dirty buffer (session.ts:281) the backup holding the lost text is overwritten. While Nox is running the same event keeps the tab open and marked `deleted` (src/services/watcher.ts:204-214, "The tab is still open. Saving will recreate the file."); across a restart the policy silently inverts. This is the case README.md:80-84 promises against.
Fix sketch:  When `tab.unsaved` names a backup that still holds text and the path is gone, restore the buffer anyway, marked `externalState: 'deleted'`, exactly as the watcher does (`newUntitled` with the content and the old name is the minimal version). Independently, seed `#nextBackup` from the highest `unsaved-N` named in a *good* index too, or from a directory listing, so a name is never reissued while a file of that name still holds text.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A3-005
Lane:        Multi-file editing and document model
Severity:    P1
Title:       A save that adds the final newline, and every external reload, replace the whole document as one change and send the cursor to offset 0; on save the pane then scrolls to the top
Location:    src/services/workspace.ts:991-999 (save), 1131 (reloadFromDisk); src/ui/EditorPane.svelte:211, 321, 353; ARCHITECTURE.md:390-394
Evidence:    Both paths replace `[0, doc.length)` with the new text as a single change:
               993:        changes: { from: 0, to: buffer.state.doc.length, insert: text },
              1131:      changes: { from: 0, to: buffer.state.doc.length, insert: doc },
             `@codemirror/state` maps a position strictly inside a replaced range to the start of the replacement, so every cursor that is not at the very end of the document maps to 0. Save then emits `buffer-reset` (998), and the pane responds with `view.setState(state)` followed by `scrollIntoView: true` (EditorPane.svelte:211, 321, 353). ARCHITECTURE.md:393 says reload "maps the selection through the change", which is true and is exactly the problem.
             Probe (real EditorView, `buffer-reset` handled as EditorPane handles it): document 'alpha typed' with the cursor at 3, `save(id, { insertFinalNewline: true })`: cursor at 0. Clean buffer 'line one\nline two\nline three\n' with the cursor at 14, file rewritten externally with one appended line, `reloadFromDisk`: cursor at 0, buffer clean.
Impact:      `files.insertFinalNewline` defaults to true (src/services/config/schema.ts:308). Open any file that does not end in a newline, edit line 40, press Cmd+S: the cursor jumps to line 1 and the pane scrolls to the top, on every save until the file ends with a newline. For reload: save, let an external formatter or `git checkout` rewrite the file (the exact "save-plus-formatter burst" src/services/watcher.ts:28-29 is tuned for), and the cursor is now silently at offset 0 while the viewport has not moved (reload passes `scrollIntoView: false`); the next keystroke inserts text at the top of the file and scrolls there. `trimTrailingWhitespace` takes the same path.
Fix sketch:  Replace the whole-document change with a minimal diff. `src/core/diff.ts` already exists; turn its hunks into a `ChangeSet` for both the save reformat and the reload, so unchanged regions map cursors and folds through untouched. For the final-newline case the edit is literally `{ from: doc.length, insert: '\n' }`. Then `save` no longer needs `buffer-reset` and the `setState` that costs scroll and view state.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A3-006
Lane:        Multi-file editing and document model
Severity:    P2
Title:       Grouped undo has a false positive once a buffer's history has been trimmed, and undoes the user's latest edit instead of the set; the Known debt row records only the benign direction
Location:    src/services/workspace.ts:1421, 1513-1523, 1549; ARCHITECTURE.md:2665; node_modules/@codemirror/commands/dist/index.js:211, 393-398
Evidence:    Grouped undo decides "is the set still on top" by comparing CodeMirror's `undoDepth` against the depth recorded at apply time:
              1421:      stack.push({ id, depth: undoDepth(buffer.state) });
              1520:    if (!top || depthOf(buffer.state) !== top.depth) return null;
              1549:      if (!buffer || !top || top.id !== id || depthBefore(buffer.state) !== top.depth) {
             CodeMirror's history keeps `minDepth: 100` (dist:211) and trims the branch only once it exceeds `maxLen + 20`, back to `maxLen + 1` (dist:393-398), so above 100 events the depth cycles 102..120 and a previously recorded depth recurs. The Known debt row (ARCHITECTURE.md:2665) says only that an old set "cannot be undone as a group".
             Probe: 110 isolated edits in buffer a, then a set across a and b (recorded depth 111), then more isolated edits in a. After 19 of them `pendingGroupedUndo()` returned the set id again (depth back to 111). `undoChangeSet` reported `{"undone":["buf-1","buf-2"],"skipped":[]}`; a still contains 'SET' and is one character shorter (the user's last edit was undone), b lost its 'SET'.
Impact:      A buffer edited for a while (100 undo events is a few minutes of typing; events group at 500 ms), a project replace or LSP rename across it and others, about twenty more edits in it, then Cmd+Z: Nox reports "Undid Replace across N files", the other buffers do revert, this one keeps the replacement and loses the user's last keystroke instead. Redo re-applies the wrong thing symmetrically. Silent and misattributed rather than destructive, hence P2.
Fix sketch:  Stop using depth as identity. Tag the change-set transaction (it already carries `changeSetAnnotation`) and check whether the history event on top of the buffer's done branch *is* that transaction, for instance by recording the `Text` object or a `ChangeSet` fingerprint of the set's inverted change and comparing against what `undo` would pop; or raise `minDepth` and treat the cap as the honest bound the debt row already describes. Update the row either way.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A3-007
Lane:        Multi-file editing and document model
Severity:    P2
Title:       A reload decided for a clean buffer overwrites keystrokes typed during the read and marks the buffer clean
Location:    src/services/watcher.ts:233-238; src/services/workspace.ts:1089-1146, specifically 1104-1105, 1121, 1131, 1142-1143
Evidence:    The watcher checks dirtiness, then awaits a reload that itself awaits a read and a stat before it replaces the document:
               233:    if (!buffer.isDirty) {
               235:      const reloaded = await this.#workspace.reloadFromDisk(id);
              1104:      raw = (await this.#platform.readEncodedFile(buffer.path, charset)).text;
              1105:      mtime = (await this.#platform.stat(buffer.path)).modified;
              1131:      changes: { from: 0, to: buffer.state.doc.length, insert: doc },
              1142:    buffer.savedDoc = buffer.state.doc;
             There is no re-check of `isDirty` or `revision` after the awaits. Rule 1 of the module header (watcher.ts:18-20) is "A dirty buffer is never overwritten".
             Probe (gated `readEncodedFile`): clean buffer, external write, `reloadFromDisk` started, 'X' typed while the read is pending (isDirty true at that moment), read released: document is the disk text, 'X' gone, isDirty false.
Impact:      The window is one IPC read plus one stat, so this needs an external write to land as the user is typing: a watch-mode formatter or `tsc --watch` writing into an open file the user has just saved and gone back to. The reload is a real transaction, so Cmd+Z recovers the keystroke, but the buffer reports clean and nothing says a reload happened, so the user is more likely to retype than to undo.
Fix sketch:  Capture `buffer.revision` before the awaits in `reloadFromDisk`; after them, if it moved, mark `externalState: 'modified'` and return false instead of replacing. Same shape as `apply()`'s `baseRevisions` check.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A3-008
Lane:        Multi-file editing and document model
Severity:    P2
Title:       Every file save and every session backup runs synchronously on the Tauri main thread with an fsync, and a dirty large buffer is rewritten in full on every typing pause; the Known debt row scopes main-thread blocking to two git reads
Location:    src-tauri/src/fs.rs:115-118, 134-136, 178-195 (sync_all at 186), 484-488; src-tauri/src/lib.rs:129-146; src/services/session.ts:281, 385-394; ARCHITECTURE.md:2656
Evidence:    All 17 commands in `fs.rs` are plain `#[tauri::command] pub fn` (the only `command(async)` in the crate is in git.rs:474). Tauri 2 runs a non-async command inline on the main thread. `nox_write_encoded_file` and `nox_write_config` both go through `write_then_rename`, which calls `file.sync_all()` (fs.rs:186). The Known debt row at ARCHITECTURE.md:2656 identifies the main-thread property for `nox_git_file_base` and `nox_git_status` only and calls them "the two older" ones.
             On the renderer side, `SessionService.#backUp` rewrites a buffer's whole text whenever its revision moved (session.ts:390-394), and `schedule()` fires 400 ms after the last change (281), so a dirty buffer's entire text crosses IPC and is fsynced on every typing pause. The version-4 comment (session.ts:27-33) presents this as fixed; what moved is the index, not the body.
             Probe, renderer side only: for a 32 MB dirty buffer, `textOf` 7 ms and `JSON.stringify` 57 ms per backup; the IPC copy, `serde_json` parse, write and `sync_all` on the Rust side are not measurable here and are the larger part.
Impact:      A user with a 20 MB log or data file open and dirty pays a full serialise-transfer-write-fsync of it after every pause in typing, with the host main thread (window messages, native menu, resize) blocked for the Rust half. Save All over 50 dirty files is 50 sequential fsyncs on the main thread (src/app.ts:1888-1892). Not a correctness defect, and the renderer keeps painting, but it is the cost the typing-path rule (CONTRIBUTING.md rule 5) exists to keep off the keyboard.
Fix sketch:  Mark the fs write commands `#[tauri::command(async)]` (they take owned `String`s and no `State`, so this is a one-word change each), and cap or throttle the backup for large buffers (for example, back up buffers above a few MB on a longer timer and on quit only). Widen the Known debt row to say the property applies to every sync command, not two.
Confidence:  Confirmed (shape); Likely (felt cost, not measured through IPC)
Risk class:  Safe
```

```
ID:          A3-009
Lane:        Multi-file editing and document model
Severity:    P3
Title:       Save As onto a path that another tab already has open leaves two buffers on one file
Location:    src/services/workspace.ts:1053-1080; src/app.ts:1868-1886
Evidence:    `saveAs` re-points the buffer and saves; neither it nor `NoxApp.saveAs` calls `findByPath` first. `open()` does (workspace.ts:472), which is what keeps ordinary opens unique. After a Save As over an open path, `findByPath` returns whichever buffer was inserted first, the watcher reconciles both against the same file, and each save clobbers the other's content without a conflict prompt, because both record their own `diskMtime`.
Impact:      Save As is a dialog with an overwrite confirmation from the OS, so the user has already said yes to replacing the file; what they have not been told is that the other tab is now stale and will silently write its old content back on its next save. Rare, and needs the dialog path, hence P3.
Fix sketch:  In `saveAs`, if `findByPath(path)` returns a different buffer, either refuse with a message or close that buffer (prompting if dirty) before re-pointing.
Confidence:  Confirmed (by reading; not probed)
Risk class:  Safe
```

```
ID:          A3-010
Lane:        Multi-file editing and document model
Severity:    P3
Title:       A file with mixed line endings is silently normalised to CRLF on its first save
Location:    src/services/workspace.ts:1930-1950 (decode), specifically 1942
Evidence:    `const eol: Eol = body.includes('\r\n') ? '\r\n' : '\n';` then `body.replace(/\r\n/g, '\n')`; `encode` (1947-1950) applies the single `eol` to every line. Probe: 'a\r\nb\nc\r\n' opens and saves as 'a\r\nb\r\nc\r\n'. Lone `\r` is turned into a line break by CodeMirror's default split and comes back as the buffer's eol.
Impact:      A save of an unrelated edit rewrites every LF line of a mixed file as CRLF, which shows up as a whole-file diff in git. Most editors do the same, and Nox has a per-buffer EOL toggle, so this is a documentation and status-bar matter: nothing says the file was mixed.
Fix sketch:  Detect mixed endings in `decode`, surface "Mixed" in the status bar, and pick the majority ending rather than "any CRLF means CRLF".
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A3-011
Lane:        Multi-file editing and document model
Severity:    P3
Title:       Replace in a closed CRLF file splits on LF and leaves the CR on each line, so an end-anchored regex matches fewer places than the search reported
Location:    src/core/replace.ts:118; src/core/search-match.ts:86; src-tauri/src/search.rs:184
Evidence:    Search on the Rust side iterates `contents.lines()`, which strips `\r` (search.rs:184). Replace recomputes matches on the raw text from `readTextFile` with `text.split('\n')` (replace.ts:118, mirrored in search-match.ts:86), so each line still ends in `\r`. A regex such as `foo$` or `;\s*$` (the second happens to match through `\s`) can therefore find a hit in the results panel and no hit at replace time on a Windows-ending file that is not open in a buffer. Open buffers are LF-normalised (workspace.ts:1942) and unaffected.
Impact:      Replace All reports fewer replacements than matches shown, for `$`-anchored patterns on CRLF files that are not open. Bounded in the safe direction (nothing wrong is written).
Fix sketch:  Strip a trailing `\r` per line in `computeReplacements` and `findMatches` before matching, and add it back to the edit's `to` offset, or normalise the disk text to LF for matching and re-encode on write with the file's detected eol.
Confidence:  Likely (read, not probed)
Risk class:  Safe
```

```
ID:          A3-012
Lane:        Multi-file editing and document model
Severity:    P3
Title:       README and ARCHITECTURE overclaim on work preservation and reload selection mapping
Location:    README.md:80-91; ARCHITECTURE.md:390-394, 848-860
Evidence:    README.md:80 "It does not lose your work. Ever."; 90-91 "If something else changes a file while you have it open, Nox tells you instead of quietly picking a winner." A3-001, A3-004 and A3-007 are three paths where work is lost or a winner is picked quietly. ARCHITECTURE.md:393 "maps the selection through the change" is technically accurate and, per A3-005, means the cursor lands at 0. ARCHITECTURE.md:848-860 describes the quit path correctly but does not mention the 400 ms debounce window a crash (as opposed to a quit) can lose, nor the missing-file case at restore.
Impact:      A user who has read the README trusts the editor with unsaved work across a branch switch; the doc promises more than the code delivers.
Fix sketch:  Soften "Ever." to what is true once A3-001/004/007 are fixed, and list the residual (a crash inside the 400 ms debounce). Reword the reload paragraph once A3-005 is diffed.
Confidence:  Confirmed
Risk class:  Safe
```

## Lane walkthrough

Answers to the nine questions in the brief, with pointers, so the lead does not have to re-derive them.

1. **The buffer.** `Buffer` (workspace.ts:160-231) holds one `EditorState` and a `savedDoc: Text` (167-168). `savedDoc` is assigned the state's own `Text` at open, save and reload (206, 1002, 1142), and CodeMirror's `Text` is a persistent tree, so it is not a second copy of the string; after edits the two share every untouched chunk. There is no string copy held at rest. A background buffer costs its `Text`, its history (inverted changes only), the state fields from `buildExtensions` (provenance, git gutter, blame, plugin decorations), and, if it was ever shown, the syntax tree that the pane reconfigured into it (EditorPane.svelte:345); the grammar is not loaded for buffers that were never shown (app.ts:224-228). Full strings are materialised transiently by `save`, `reloadFromDisk`, `replaceContents`, `textOf` and the session backup. The 2 MB `EXACT_DIRTY_LIMIT` (91-108) is reached only when the change counter moved and the length is unchanged; the Known debt row at ARCHITECTURE.md:2641 is accurate.

2. **Dirty and save.** `isDirty` (214-225): eol changed, else counter equal means clean, else length differs means dirty, else exact `doc.eq` under 2 MB. Save in flight: A3-001. Deleted externally: `save()` ignores `externalState: 'deleted'` and `write_atomic` recreates the parent and the file (fs.rs:147-151); the watcher then sees the new mtime as ours. Disk full: `write_then_rename` fails at `write_all` or `sync_all`, the temp is removed (fs.rs:170-173), the original is untouched; covered by `a_failed_write_reports_it_and_cleans_up`. Windows: `fs::rename` uses `MoveFileExW` with replace, which fails with "Access is denied" while another process holds the target open without delete sharing (antivirus, another editor); the error surfaces as a toast and the original is intact, which is the right failure. Permissions are carried across on unix (fs.rs:192, tested at 649); on Windows only the read-only bit is, and a read-only target refuses the rename, which is also right. Symlinks are canonicalised first (156, tested at 668). The rename replaces the inode, so hard links and xattrs/ACLs on the old file are not carried; standard for atomic saves, and undocumented. Outside the workspace root: no restriction on saving; the watcher does not cover it (Known debt row 2643, accurate, severity right).

3. **External change.** `#reconcile` (watcher.ts:203-260): missing means `deleted` and a one-time warning; `mtime === knownMtime` means ours (225); clean reloads silently; dirty is marked and prompted at save (app.ts:1738-1755). The mtime equality test is the only signal; size is available from the same `stat` and unused. Same-tick edit: A3-007. Root-only: confirmed, row accurate.

4. **Undo.** Per buffer, CodeMirror's. Change sets: validated in full before any dispatch (1329-1400), rejected with `stale`, `missing`, `invalid`, `empty`; the probe and `tests/transactions.test.ts` confirm nothing is half-applied. One file of forty edited since: skipped and reported (1549-1552). Closed since: skipped (`!buffer`). Deleted since: the buffer is still there (dirty ones stay open), so it is undone in memory. User undid one file's part manually then undid the group: that buffer's depth no longer matches, so it is skipped, and its stale index entry stays until `resetState` clears it; redoing it manually puts the depth back and the group check works again. The depth-as-identity check fails after trimming: A3-006. Mirrored panes: A3-002.

5. **Splits and tabs.** Flat list of groups (workspace.ts:264-275). One buffer in two panes is one `Buffer` with two `EditorView`s; a pane forwards non-mirrored transactions to the workspace (EditorPane.svelte:130-142), which mirrors the `changes` to the other panes with `mirroredAnnotation` (413-427). Documents cannot diverge (`tests/groups.test.ts:660`, `tests/pane-fidelity.test.ts:95-140`). What does diverge is history and selection: each view keeps its own, `buffer.state` is whichever dispatched last (898), and a pane that switches tabs and back adopts the other pane's cursor via `setState` (321). Closing one pane keeps the document (`close`, 570-582). Session restore of a mirror works through the `mirror: true` record (session.ts:55-83, 192-202). Closing a pane or moving a tab into a pane that already shows it: A3-003.

6. **Session.** Version 4 (session.ts:20-25). Written 400 ms after any change to `buffers`, `activeId` or `rootPath` (app.ts:587, 632, 637; session.ts:277-283) and once more on quit through `onCloseRequested`, which holds the window open with `preventDefault` until `dispose()` finishes (tauri.ts:507-522, app.ts:5312-5316). Per-buffer backup files are written first, the index last (session.ts:368-369), and both through `write_config_atomically` (fs.rs:466-481). A crash inside the debounce loses at most 400 ms of typing plus whatever was already in flight. Corrupt index: preserved as `.damaged`, the backup counter is salvaged from it by regex (491-495), and the tabs are lost; the damaged signal surfaces it. File changed between quit and restart with unsaved edits: `restoreUnsaved` re-applies on top of the disk text and flags `modified` when `baseMtime` differs (workspace.ts:1285-1298), tested at session.test.ts:105. File missing at restart: A3-004. No size cap on backups: A3-008; a 64 MB dirty buffer at quit is one 64 MB JSON string through IPC and one fsync, which the close handler waits for.

7. **Large files.** `open` stats first and refuses above `MAX_FILE_BYTES` (64 MB, workspace.ts:122, 478-481) with a toast naming the size, and refuses directories. Then `readEncodedFile` (Rust reads the whole file, validates UTF-8 or a BOM, returns a `String`), the string crosses IPC as JSON, `looksBinary` sniffs the first 8 KB for NUL (1975-1981, after the whole transfer), `decode` scans for CRLF and copies if needed, `EditorState.create` splits into lines. At the limit that is roughly four 64 MB strings live at once plus the `Text` tree; the file's own comment (110-120) says the IPC hop and peak memory are unmeasured, and this audit did not measure them either (see Not checked). A 500 MB file is refused in one `stat`. Fifty ordinary files: per keystroke, `applyTransaction` republishes a snapshot of every tab (`#sync`, 1894-1918) and `session.schedule` resets one timer; measured at 7 us per keystroke with 50 files in the probe. Tab switch is `view.setState` plus compartment reconfiguration. Save is per file and sequential (A3-008). Nothing found that is O(open files) in a way that matters at 50.

8. **Cross-file replace.** Search reads from disk in Rust (search.rs:132-149), UTF-8 only, 8 MB cap, NUL sniff. Replace reads the open buffer when there is one and disk otherwise (search.ts:440-454), recomputes matches from the current text rather than trusting stored rows (611-628), applies buffer edits as one change set with `baseRevisions` (642, 679-686) so a buffer edited during the walk is refused rather than clobbered, saves back only buffers that were clean before (511-518, 714), and writes closed files with `writeTextFile`. A dirty open file keeps its edits and stays dirty. Non-UTF-8 files never appear in results, so they cannot be replaced; the Known debt row at ARCHITECTURE.md:2664 says so. CRLF on closed files: A3-011. BOM on a closed file is preserved (the U+FEFF is in the string and written back).

9. **Encoding and line endings.** Per buffer: `eol` and `encoding` (workspace.ts:165-166), restored by `encode` at save, and the eol survives a reload (1116-1118). BOM: stripped from the document and put back (1931-1945, 1947-1950; tests at workspace.test.ts:300-320). UTF-16: detected by BOM only, decoded in Rust, always written with a mark (encoding.rs:146-165, with tests against Python-derived bytes). Legacy charsets: choice-only, refused on detection, unmappable characters refuse the save before touching the file (fs.rs:115-118, test at 601). Mixed endings: A3-010. Lone CR: becomes a line break on open and the buffer's eol on save, undocumented.

## What is good

- Validation before dispatch in `apply()` (workspace.ts:1329-1400) with the comment explaining why the ordering is the guarantee; the probe and `tests/transactions.test.ts:53-140` confirm nothing is half-applied.
- `write_atomic` (src-tauri/src/fs.rs:145-195): sibling temp, `sync_all`, permissions carried, symlink canonicalised, temp removed on failure, and each of those has a Rust test that names the failure it prevents (fs.rs:491-690).
- The encoding layer is in Rust for a stated, correct reason (encoding.rs:7-13): the WebView cannot encode legacy charsets, and `encode_utf16` documents the WHATWG trap it avoids (107-113) with tests against independently derived bytes.
- Replace prefers the buffer over disk, recomputes matches from current text, and refuses a file whose dismissed matches it can no longer locate (search.ts:440-454, 462-505): the most destructive feature in the editor is also the most carefully written.
- The first-acceptor-not-broadcast rule in `#dispatchToView` (workspace.ts:381-411) is a real fix to a real data-loss bug, argued in place, with `tests/pane-fidelity.test.ts:95-140` holding it.
- Session backups are written before the index (session.ts:368-369), backups are only rewritten when their buffer moved (385-394), a failed backup write drops the revision so it is retried (395-403), and a damaged index still yields the counter that stops the next write landing on a live backup (491-495).
- `MAX_FILE_BYTES` and `EXACT_DIRTY_LIMIT` carry measurements and the direction the number should move (workspace.ts:91-120), and `tests/complexity.test.ts` exists to hold pure functions to their stated cost.
- `#sync` at 50 files is 7 us per keystroke: the "one snapshot per tab per transaction" design is cheap enough to be a non-issue.

## Not checked

- The IPC cost and peak memory of opening a file near the 64 MB limit in the packaged app. The workspace comment says these are unmeasured; this audit confirms they still are. Needs the desktop build and a profiler (A4's lane).
- `npm run test:editor` was not run; nothing in this lane's findings depends on layout.
- Rust tests were not re-run; the orientation records them green at this SHA, and the `fs.rs` tests were read rather than executed.
- Windows rename-over-open-file behaviour and hard-link, xattr and ACL loss through rename were reasoned from `std::fs` semantics, not exercised.
- The Svelte `each_key_duplicate` throw in A3-003 was confirmed from Svelte 5.56.9's source; the resulting UI state was not observed in the packaged app.
- Cursor and history behaviour of two panes over one file under real typing (the `newGroupDelay` grouping differences between a pane's own transactions and the mirrored ones) was reasoned about but not probed beyond A3-002.
- The autosave `onFocusChange` path and format-on-save's 2 s timeout were read (app.ts:1758-1800, EditorPane.svelte:387-405) but not driven; both funnel into `workspace.save` and inherit A3-001.

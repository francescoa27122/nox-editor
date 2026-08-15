# Nox — Agent Platform

Captured requirements for the agent-facing layer, reconciled against what
v0.1.0 already ships. This document is the source of truth for scope; when it
disagrees with [ROADMAP.md](ROADMAP.md), fix the roadmap.

The governing principle from the roadmap stands and is not renegotiated here:
**AI is a panel and a set of commands, not a rewrite of the editor.** If a
feature would make Nox worse for someone who never turns AI on, it does not
ship. Everything below is designed to be useful to the editor on its own
terms — the transaction layer improves undo for humans, the permission layer
protects against plugins, the job runner fixes project search cancellation —
so that none of it is dead weight if the agent never arrives.

---

## 1. Multi-file editing — shipped

Status after **M1** (see §5).

| Requirement | Status |
|---|---|
| Independent buffers: own undo history, cursor, dirty flag | ✅ Each buffer owns a CodeMirror `EditorState` (ARCHITECTURE §4) |
| Per-buffer line endings | ✅ Already modelled end to end before M1: detected on open, normalised to LF in the document, restored byte-for-byte on save, shown in the status bar |
| Per-buffer encoding | ✅ **M1.** UTF-8 with or without a BOM, detected and preserved. Legacy encodings are recorded as debt rather than half-supported |
| Buffer list independent of view layout | ⚠️ **Partial.** Groups model tabs independently of the view, but *a buffer belongs to exactly one group* |
| One buffer visible in several views, edits synced live | ❌ **Gap.** Known debt. Needs a second CodeMirror view over one document with transactions forwarded |
| Split panes, keyboard navigation | ✅ Horizontal and vertical, `Mod \`, `Mod ⌥ ←/→` |
| Nestable splits | ❌ **Gap.** The layout is a flat list, deliberately (ROADMAP v0.3) |
| Tabs | ✅ |
| File tree scoped to a workspace | ✅ Explorer, with multi-select, context menu, drag-move |
| Fuzzy file finder over the workspace | ✅ `Mod P`, `core/fuzzy.ts` |
| Fast buffer switcher over open files | ✅ **M1.** `Mod E`, or `~` in the palette. MRU-ordered, opening on the previously-viewed file |
| Project-wide search and replace across unopened files | ✅ Rust walk, `.gitignore`-aware, streaming results |
| Reviewable result list, undoable bulk apply | ✅ Per-match diff preview, one-shot Undo that skips files changed since |
| Save-all, close-all | ✅ `file.saveAll`, `file.closeAll` |
| No work lost on quit with unsaved buffers | ✅ **M1.** Unsaved edits are persisted and restored — deliberately instead of a prompt, see §6 |
| External change detection, reload-or-keep, no silent clobber | ✅ Clean buffers reload silently; dirty buffers are marked and resolved at save time |
| Session persistence: files, layout | ✅ `session.json` v3 — root, groups, tab order, active tab |
| Session persistence: cursor positions | ✅ **M1.** Every selection range per tab, clamped to the document on restore |
| Session persistence: scroll position | ⚠️ **Partial.** Scroll is a view concern and not part of `EditorState`; the restored cursor is scrolled into view instead, which is what the requirement was actually for |

**What M1 found that these drafts did not anticipate.** Unsaved edits to a file
buffer were neither prompted for *nor* persisted — they were silently discarded
on quit, and `NoxApp.dispose()` was dead code that nothing ever called. Both are
fixed. An older bug surfaced alongside them: session restore focused whichever
tab was opened last rather than the one the session named, which the existing
test could not catch because its fixture made those the same tab.

---

## 2. Agent-ready foundation

Built now, with the agent absent. Each piece has a non-agent justification.

### 2.1 Authored transactions — shipped

Lives in [`src/services/transactions.ts`](src/services/transactions.ts) and the
transaction section of [`workspace.ts`](src/services/workspace.ts).

```ts
type Author =
  | { kind: 'user' }
  | { kind: 'agent'; sessionId: string; label: string }
  | { kind: 'plugin'; pluginId: string }
  | { kind: 'script'; name: string };

interface Edit {
  bufferId: BufferId;
  changes: ChangeSpec;
  selection?: EditorSelection;
}

interface ChangeSetSpec {
  description: string;                          // "Replace \"needle\""
  author: Author;
  edits: Edit[];                                // may span buffers
  baseRevisions?: ReadonlyMap<BufferId, number>;
}
```

`workspace.apply(spec)` is the single entry point for programmatic edits:

1. Resolves every named buffer. One missing → reject whole, `reason: 'missing'`.
2. Checks each `baseRevisions` entry against the buffer's current revision. Any
   mismatch → reject whole, `reason: 'stale'`.
3. Builds every buffer's `ChangeSet` — pure, and the step that rejects an
   offset past the end, a backwards range, or two edits that overlap
   (`reason: 'invalid'`). **This is what makes a half-applied set
   unrepresentable**, and it was the one thing the original implementation got
   wrong: it built each transaction as it dispatched, so a bad offset in the
   *second* buffer threw after the first had already been written, leaving
   nothing in the log to undo it with. Validating every buffer up front means
   the dispatch loop cannot fail, so there is nothing to roll back.
4. Dispatches one transaction per buffer, annotated with the change-set id and
   `isolateHistory: 'full'` — so the set is exactly one history event in each
   buffer and can never be merged into adjacent typing.
5. Records the set in the transaction log (§2.4).

`baseRevisions` is optional: edits computed from a buffer's current state in
the same tick have nothing to be stale against. It is mandatory in spirit for
any caller that read a buffer, went away, and came back — which is every agent.

**Revisions are monotonic and separate from `changeCount`.** `changeCount`
is zeroed by `resetState` as part of dirty tracking, and a revision that can go
backwards is worse than none: a caller holding revision 3 across a reload would
pass the check against an entirely different document.

**Grouped undo indexes CodeMirror's history rather than replacing it.** For each
buffer, the workspace records the `undoDepth` each change set produced.
`undoChangeSet(id)` undoes a buffer only when that depth still matches — which
is CodeMirror's own accounting, so it stays correct across edits, undos and
redos the workspace never saw. A buffer the user has edited since is skipped and
*reported*, never silently taken back. `Mod Z` consults
`pendingGroupedUndo()` first and falls through to the plain command for
single-buffer sets, where the two are identical.

*Non-agent payoff:* a project-wide replace is one undo step across every file
rather than one per open buffer, with a toast that names what was undone and
how many files it reached.

### 2.2 Attribution — partly shipped

`Author` is carried on every change set and stored in the log, and every
transaction is annotated with its change-set id (`changeSetAnnotation`), so the
editor layer can already tell a programmatic edit from typing.
`TransactionLog.bySession()` answers "what did this agent session do".

Still to build, all of it reading what is now recorded rather than needing new
plumbing:

- Agent-authored ranges get a subtle gutter mark and a decoration, both
  themeable and both off by default for `{ kind: 'user' }`.
- "Revert everything this agent session did" — `bySession()` plus
  `undoChangeSet()` per entry, newest first. No special code path.
- The status bar saying *3 changes by agent* rather than leaving the user to
  guess what moved.

### 2.3 Staged change sets and diff review — shipped

Diff in [`src/core/diff.ts`](src/core/diff.ts), staging and review in
[`src/services/review.ts`](src/services/review.ts), the panel in
[`ReviewPanel.svelte`](src/ui/ReviewPanel.svelte).

A staged set is a proposal that has been **built but not applied**. Staging
computes what each buffer *would* say — CodeMirror states are immutable, so the
transaction is computed and dropped, with no dispatch, no history entry and
nothing on screen — then diffs that against the current text to produce hunks.

**Rejecting hunks narrows rather than diverts.** The accepted hunks are turned
back into offsets and applied through `workspace.apply` like anything else. So
there is exactly one write path, the whole reviewed result lands in a single
transaction, and one ⌘Z takes it back. Nothing partially applied ever exists on
screen, because nothing is applied until Apply.

**Everything starts accepted.** Review is for catching the wrong ones; making
someone tick every box to get the thing they asked for is how review panels end
up being clicked through blind.

**A buffer edited during review is refused, not overwritten.** The revision at
staging time rides along as `baseRevisions`, so the offsets computed from hunks
are only ever used against the document they were computed from. When that
happens the review *stays on screen* — it holds the user's decisions, and
discarding those because a file moved would be its own small betrayal.

The diff is Myers' O(ND) algorithm over lines, with common prefix and suffix
trimmed first. `splitLines` keeps terminators, which makes `lines.join('')`
exact and makes a line index a CodeMirror line number minus one — so none of
the offset arithmetic has to reason about where newlines went.

*Non-agent payoff:* this is the view v0.5's Git diff needs. It is built once.

### 2.4 Transaction log — shipped

An append-only, bounded (200 entries) in-memory ring of applied change sets: id,
author, description, buffers touched, timestamp. Exposed as a `Signal` so a UI
can render it, with `recent(n)` for the context API and `bySession(id)` for the
agent audit trail.

Not persisted, deliberately: undo history does not survive a restart, so a
persisted log would list changes it could not undo — and a button that lies is
worse than one that is absent.

### 2.5 Context extraction API — shipped

Lives in [`src/services/context.ts`](src/services/context.ts). A read-only
facade over the workspace: what an agent reads from.

```ts
class ContextService {
  reader(principal: Principal): ContextReader;   // bound, and logged

  openBuffers(): BufferSummary[];       // + revision, lineCount, isActive
  activeBuffer(): BufferId | null;
  bufferText(id, opts?: { lines?: LineRange; withLineNumbers?: boolean }): string | null;
  selection(id): SelectionInfo | null;  // per range: offsets, lines, the text
  viewport(id): LineRange | null;       // null when nothing is showing it
  workspaceTree(opts?: { depth?: number }): WorkspaceTree;
  recentTransactions(limit?): ChangeSetSummary[];
}
```

**Nothing live is handed out.** Every return value survives `JSON.stringify`
and compares equal after a round trip — there is a test that asserts exactly
that, because a class instance would not survive it. A caller holding a
`Buffer` or an `EditorState` could mutate it, and every mutation is supposed to
go through `workspace.apply` under the permission model; a read API that leaks
a handle is a hole in that. Even the log's own `bufferIds` array is copied
before it leaves.

**Reads are recorded, not gated.** Context cannot leave the process on its own
— `net.request` is the capability that matters and it is checked — so gating
reads would mean a dialog for every keystroke of an agent's thinking. Instead
`reader(principal)` binds the caller once, so no call site can forget to
identify itself and the audit trail is complete by construction. The user's
reads are not recorded, for the same reason their permission decisions are not.

**Everything is synchronous**, including `workspaceTree` — which the sketch had
going through `Platform`. It is built from the quick-open index instead, so it
shows exactly what `Mod P` shows: the same exclusions, the same bounds, and no
second definition of "the project" to drift from the first. The costs are
reported rather than hidden: directories containing no indexed file do not
appear, and `indexing` says when the answer may still be partial.

**`viewport` returns null for a background tab.** "Open" and "on screen" are
different questions; an agent asking the second one should not be handed the
answer to the first.

### 2.6 Permission model — shipped

Lives in [`src/services/permissions.ts`](src/services/permissions.ts), enforced
in [`commands.ts`](src/services/commands.ts). The only non-user caller today is
`tests/permissions.test.ts`, which is the point: a permission model retrofitted
around an existing agent is a permission model with holes in it.

```ts
type Capability =
  | 'fs.read' | 'fs.write' | 'fs.create' | 'fs.delete'
  | 'shell.exec' | 'net.request' | 'buffer.edit' | 'workspace.open';

type Decision = 'allow' | 'deny' | 'prompt';
type Principal = Author;              // the same taxonomy as a change set's
```

`Principal` *is* `Author`, deliberately. The thing that requested an edit and
the thing accountable for it are not two concepts, and two parallel enums would
drift apart the first time one of them gained a case.

**Enforcement is in one place.** `CommandRegistry.execute` takes a principal and
consults a single guard. Because every action in Nox is already a command, that
one check covers everything a plugin or an agent could ask for, and there is no
second path to forget. Commands declare `capabilities`, and — this is the part
the sketch missed — a `resourceFrom` that pulls the subject out of the argument
or the app state. The dispatcher cannot know which file `file.save` is about to
write, but the command can, and without it a grant could only ever be
"may write files", which is not a question worth asking.

**The user is exempt, and not even logged.** A model that can interrupt a human
mid-keystroke is a model they turn off within a day, and a permission layer
nobody runs protects nothing. Their decisions are not recorded either: "the
user was allowed to type" would bury the entries an audit is looking for.

**Grants are path-scoped.** Approving a write to `src/app.ts` does not approve
one to `~/.ssh/config` — remembered grants key on the resource for `fs.*`, and
on the capability alone for the rest, which is the granularity each is asked at.

**Denials throw.** A denial that returned `false` would be indistinguishable
from a disabled command, and "nothing happened" is the worst possible answer to
"may I".

**The workspace boundary tightens, never loosens.** A path outside the open
folder turns an `allow` into a question. It must never turn a `deny` into one —
that would be a weaker rule wearing a stronger rule's name. (The first
implementation got this backwards; the test caught it.)

**No prompter means no.** Failing closed is the only safe reading of "ask the
user" when there is nobody to ask — which is the state a headless or scripted
run is in.

### 2.7 Async job runner — shipped

Lives in [`src/services/jobs.ts`](src/services/jobs.ts).

```ts
interface Job<T> {
  id: JobId;
  title: string;
  progress: Signal<{ done: number; total?: number; message?: string }>;
  status: Signal<JobStatus>;
  cancel(): void;
  result: Promise<JobOutcome<T>>;      // never rejects
}

type JobOutcome<T> =
  | { status: 'done'; value: T }
  | { status: 'cancelled' }
  | { status: 'failed'; error: unknown };
```

**The corruption rule is structural, not disciplinary: a job never mutates a
buffer.** It computes and returns a plan — for editing work, the edits of a
change set — and applying happens on the main path once the job resolves,
through `workspace.apply` with the base revisions the job recorded as it read.
Cancelling is therefore `discard`: there is no unwinding, because nothing was
written. Every step that would need its own correctness argument is a step that
does not exist.

Three things the shape enforces rather than documents:

- **`JobOutcome` is a union, not a value-or-null.** A caller that forgets
  cancellation exists is the exact bug this milestone is about, so the type
  makes you look.
- **`result` settles the moment the job is cancelled**, without waiting for
  the body to notice. Cancellation is cooperative, so a body can be mid-`await`
  — or poll nothing at all. The caller has already been told to ignore the
  value; making it wait on that function spreads one unresponsive job into
  everything downstream. The body runs on and its value is dropped, which is
  safe precisely because it cannot have touched a buffer.
- **`onCancel` fires immediately if cancellation already happened**, closing
  the window between starting a native operation and getting back the handle
  that would cancel it. Without that, cancelling during `searchProject`'s own
  await would never reach the Rust walker.

Keyed jobs supersede: starting a search cancels the one already walking. That
replaced a hand-rolled generation counter checked by hand in the batch
callback — the same idea, in one place, for everything.

*Non-agent payoff:* project search and replace are jobs now. Cancelling a
search stops the walk on the Rust side and returns the panel to how it looked
before it started, rather than leaving however far it happened to get; the
status bar shows what is running, with progress, and cancels on click or from
the palette. And replace gained a safety property it never had: the walk reads
files across many awaits, so the user can type into a buffer partway through —
the recorded base revisions now catch that and refuse, instead of writing text
computed before they typed it.

---

## 3. Agent runtime — shipped

Protocol in [`src/services/agent/protocol.ts`](src/services/agent/protocol.ts),
provider interface in [`provider.ts`](src/services/agent/provider.ts), runtime
in [`runtime.ts`](src/services/agent/runtime.ts), panel in
[`AgentPanel.svelte`](src/ui/AgentPanel.svelte).

**Almost all of it is wiring, and that is the result the ordering was for.** An
agent reads through `ContextService`, acts through `CommandRegistry` under
`PermissionService`, proposes through `ReviewService`, applies through
`workspace.apply`, runs under `JobRunner`, and is undone by `undoChangeSet`.
Every one of those existed and was tested before the runtime did. Needing a
privileged path here would have been the sign that something underneath was
wrong.

**The protocol is data, not method calls.** Every message survives
`JSON.stringify`, because an agent is expected to be a separate process
eventually and designing for in-process first is how that stops being possible.
`AgentTransport` is the seam; `ProviderTransport` is the in-process
implementation.

**One verb reaches a side effect.** `command.execute`, which lands in the
dispatcher under the permission model. `proposal.stage` is deliberately not a
command: a command is the thing that has an effect and staging has none. The
moment it becomes a write is Apply, which is the user's own action in their own
UI.

**Concurrency is resolved by rejection, not by locking.** Sessions run
concurrently and are not serialised. Two agents on one buffer is settled where
it is actually decidable, and there are two such places now. The earlier one
is `proposal.stage`: if a buffer this session has read — whole or in part —
has since moved, staging is refused before the proposal exists, with
`{"code":"stale", "message":"<file> changed after you read it — read it
again before staging an edit against it"}`. This applies to every agent, not
just to any one provider — read the buffer again and stage from that. What
gets past that still has to clear `workspace.apply`, which refuses whichever
session is working from a revision that has moved by the time it lands. A
lock would block the user's own typing; a queue would hide the staleness
until after the edit landed.

**The provider stream is two-way.** `complete()` returns an async generator,
and each `yield` returns the response Nox produced for that chunk. A one-way
stream — which is what this was first built as — makes an agent emit every
action blind: it can ask to read a file and never see the contents, which makes
the context API useless to the one thing it exists for.

**Providers are the only vendor-shaped thing, and Nox ships none.** A default
provider would mean shipping a vendor, which is the thing the interface exists
to avoid. `ScriptedProvider` is the reference implementation and what the tests
drive the whole runtime with.

**Every session is a record.** Instruction, narration, each context read, each
command with whether it was granted, the proposal, the summary, and any error —
in order, in the Agents panel, with one button that takes back everything the
session landed. A refused action is part of the record, not an error to hide:
an audit has to show what an agent *tried* as well as what it managed.

### Agents in another process

`StdioTransport` ([`stdio.ts`](src/services/agent/stdio.ts)) speaks the
protocol as one JSON object per line over a child process's stdin and stdout,
supervised by [`agent.rs`](src-tauri/src/agent.rs). Line-delimited rather than
length-prefixed like LSP: an agent is very often a script someone wrote in an
afternoon, and `print(json.dumps(...))` in a loop should be enough to speak it.

It was a codec and a lifecycle, as predicted — nothing above the transport
needed changing, because nothing above it ever treated the agent as local.

The transport takes an `AgentProcess`, not a command line, and that is what
makes it testable: no fixture binary to keep working on three platforms, and
the failure modes that matter become ordinary tests — an agent that never
speaks, one that crashes mid-sentence, one that writes a Python traceback where
JSON was expected, one that talks before saying hello.

[`examples/uppercase-agent.mjs`](examples/uppercase-agent.mjs) is the
reference implementation, about eighty lines. `tests/stdio.test.ts` runs it as
a real child process, so the wire format, the example and the transport are all
exercised over genuine pipes.

**Starting a process is not reachable from the protocol.** An agent cannot
spawn another agent; only the user, through configuration, can. It is the most
powerful thing Nox does on anyone's behalf and it stays outside the surface an
agent can reach.

### What is not built

**A model provider.** Nox ships none, deliberately — shipping one means
shipping a vendor. `ModelProvider` is the interface a plugin implements, and
`ScriptedProvider` is the reference for its shape.

## 4. Baseline editor requirements

All shipped in v0.1.0: syntax highlighting (9 language families), find and
replace within a buffer, multiple cursors, undo/redo, auto-indent, line
numbers, a config file, and incremental rendering.

Two clarifications on the drafts:

- **Keybindings are data but not yet editable.** The panel lists them; it
  cannot rebind. Booked at v0.6.
- **Buffer storage is already a rope.** CodeMirror's `Text` is a persistent
  rope. No piece table work is needed or wanted.

---

## 5. Milestone plan

Ordered so each milestone is independently runnable and independently useful.

| M | Milestone | Contents | Done when |
|---|---|---|---|
| **M1** ✅ | Finish multi-file editing | Cursor in `session.json` (v3), unsaved file contents through quit, a real quit hook, MRU buffer switcher, BOM modelling | **Shipped.** Restart restores where you were, to the character, including work you never saved |
| **M2** ✅ | Transactions | `ChangeSet`, `Author`, `workspace.apply`, base-revision rejection, transaction log, grouped undo and redo. Project replace ported onto it | **Shipped.** One `Mod Z` undoes a project-wide replace across every open file |
| **M3** ✅ | Job runner | `Job`, progress signals, cooperative cancellation, keyed supersession. Project search and replace ported onto it | **Shipped.** Cancelling a search mid-walk leaves nothing behind, and cancelling a replace changes nothing at all |
| **M4** ✅ | Permissions | Capability and resource declarations on commands, principal policy, dispatcher enforcement, prompt UI, decision log. Only caller is tests | **Shipped.** A test principal denied `fs.write` cannot save, and the user never sees a prompt |
| **M5** ✅ | Context API | `ContextService` facade, serialisable throughout, per-principal read logging, live viewports | **Shipped.** An integration test drives a fake agent end to end: read, propose, be refused, be allowed, be undone |
| **M6** ✅ | Diff and review | Myers line diff in `core/`, staged change sets, hunk-level accept/reject, review panel | **Shipped.** A staged set is reviewed hunk by hunk and partially accepted, landing as one undoable change |
| **M7** ✅ | Agent runtime | Protocol, in-process and stdio transports, process supervision, provider interface, session panel, audit log, reference agent | **Shipped.** An agent in another process proposes a multi-file edit, three hunks of five are accepted, and one button reverts it all |

M1–M3 are editor improvements that happen to be prerequisites. M4–M6 are
platform. M7 is the only milestone that is visibly about agents, and it is last
by design: if it slips indefinitely, M1–M6 still made Nox better.

**Against the roadmap:** M1 belongs in v0.2. M2–M6 form a new **v0.6.5 —
Platform**, sitting after Extensibility, since a plugin API and a permission
model want to land near each other. M7 is the "Later — AI" entry, made
concrete.

---

## 6. Design decisions, with the alternative rejected

| Decision | Alternative | Tradeoff |
|---|---|---|
| **Reject on stale base revision** for concurrent writers | Buffer locking, or queuing edits | Locking would block the user's own typing while an agent thinks; queuing applies edits against context the agent never saw. Rejection costs a retry and is the only option that cannot silently produce a wrong edit. |
| **Change sets validate wholly, then dispatch** | Apply per buffer, roll back on failure | Rollback across CodeMirror histories is genuinely hard to get right and impossible to test exhaustively. Validating first makes the half-applied state unrepresentable rather than merely rare. |
| **Grouped undo indexes CodeMirror's history** | A bespoke undo stack in the workspace | A second history would have to stay consistent with CM's per-buffer one forever. Indexing costs a lookup; replacing costs the invariant. |
| **The user principal bypasses permission checks** | One uniform path for every caller | Uniformity is prettier, but any model that can prompt a human mid-keystroke gets disabled within a day. The boundary is *programmatic caller vs. human*, and it should be visible in the code. |
| **Jobs never mutate buffers; they return change sets** | Let jobs apply edits incrementally with a cancellation guard | Incremental application means every cancellation path needs its own correctness proof. Returning a change set means cancellation is `discard`. |
| **Transaction log is in-memory and bounded** | Persist it across sessions | Undo history does not survive restart, so a persisted log would list changes it could not undo — a button that lies is worse than an absent one. |
| **Agents are external processes over a protocol** | In-process JS plugins with direct API access | External costs serialisation and a protocol version. It buys a crash boundary, real capability enforcement, and language independence — none of which are retrofittable. |
| **Line-based Myers diff in `core/`** | A diff library, or word/character diff | A dependency in `core/` breaks the zero-imports rule that makes it testable. Line granularity matches how hunks are reviewed; word-level refinement can layer on later. |
| **Read access is logged, not gated** | Permission-check every context read | Context reads cannot exfiltrate on their own — the network capability is the real gate, and it is checked. Gating reads would mean a prompt per keystroke of agent thinking. |
| **M1: persist unsaved work through quit; no prompt** | The conventional "you have unsaved changes — save / discard / cancel" dialog | A dialog can be answered wrong, and it makes quitting slow for the one case it exists to protect. Persisting cannot lose work whatever the user does, and it already matched how scratch buffers behaved. |
| **M1: restoring unsaved work is not a merge** | Reconcile the recorded edits against the file's new contents | The buffer comes back exactly as the user left it, and a file that moved underneath gets flagged through the watcher's existing conflict path. Inventing a merge would produce text neither side ever wrote. |
| **M1: BOM only, no legacy encodings** | Full encoding detection and transcoding | BOM sniffing is exact and cannot be wrong. Charset heuristics are occasionally wrong and confusingly so, and real support belongs in Rust with a proper decoder — recorded as debt instead. |
| **M1: MRU switcher is a palette mode, not a hold-to-cycle chord** | ⌃Tab-style cycling while a modifier is held | Hold-to-cycle needs global modifier-release tracking and does not compose with a search field. A prefix mode reuses the palette's ranking, keyboard handling and rendering, and stays typeable. |
| **M2: grouped undo compares CodeMirror's `undoDepth`** | Track our own stack of history events per buffer | Any bookkeeping we maintain ourselves has to stay in step with CodeMirror's forever, through coalesced typing, undo and redo. Asking CodeMirror what depth it is at costs a function call and cannot drift. |
| **M2: a buffer edited since is skipped, and said out loud** | Undo the set everywhere regardless | Undoing a buffer whose top history event is the user's own typing would destroy work they never asked to lose. Reporting the skip keeps a partial result from reading as a complete one. |
| **M2: `workspace.ts` imports `@codemirror/commands`** | Inject history operations the way `StateFactory` injects view extensions | The rule that matters is staying headless, and it holds — `tests/transactions.test.ts` drives real undo history under Node. An injection seam with exactly one implementation would be ceremony. |
| **M2: the replace journal stays as a backstop** | Retire it now that open buffers undo through the change set | CodeMirror's history has a bounded depth, and closed files were never in it at all. The journal restores by text and refuses when the file no longer matches, so it covers what history cannot. |
| **M2: view dispatchers are a set, not a slot** | Keep the single slot and accept one live pane | With splits, every pane owns a view; a single slot meant the last one to mount silently claimed the channel, and edits aimed elsewhere left that pane rendering stale text. This was a live bug, not a hypothetical. |
| **M3: `result` settles on cancel, not when the body returns** | Tie the result to the body finishing, as cooperative cancellation implies | A body can be mid-`await`, or poll nothing at all. Since the caller has been told to discard the value anyway, waiting only propagates one unresponsive job into everything downstream. Found by probing the running app, not by reasoning. |
| **M3: `JobOutcome` is a union, not `T \| null`** | Resolve with the value, or null when cancelled | A null is easy to miss and easy to conflate with a legitimately empty result. The union makes the caller name the cancelled case, which is the bug this milestone exists to prevent. |
| **M3: cancelling a search clears the panel** | Keep whatever results arrived before the stop | Half a result set looks like a complete one and there is no honest way to label it. Returning to the pre-search state is the only outcome that cannot mislead. |
| **M3: replace records base revisions during the walk** | Apply whatever the walk computed | The walk spans many awaits, so the user can type into a buffer partway through. Without the check, replace would write text computed before that keystroke and silently eat it — a latent bug the port surfaced. |
| **M4: `Principal` is `Author`** | A separate enum for who-may-do-this vs who-did-this | They are the same taxonomy, and two of them would drift the first time one gained a case. Reusing it also means a change set's author is exactly the principal that was checked. |
| **M4: commands declare `resourceFrom`** | Capability-level checks only | The dispatcher cannot know which file `file.save` will write, but the command can. Without it every grant would be "may write files" — a question too coarse to answer meaningfully, so people would answer it without reading. |
| **M4: the workspace boundary only escalates `allow` → `prompt`** | Escalate any outside-workspace decision to a prompt | Turning a `deny` into a question makes a policy that forbids something merely ask about it. The first implementation did exactly that; the test caught it before it shipped. |
| **M4: no prompter means deny** | Fall back to the policy, or allow | A headless or scripted run has nobody to ask, and "ask the user" with no user has one safe reading. |
| **M4: the user's decisions are not logged** | Log every check uniformly | An audit trail is for finding what a non-human did. Recording that the user was permitted to save would bury those entries under thousands of their own keystrokes. |
| **M5: the context reader is bound to a principal** | Pass the principal to each method | A per-call argument is a per-call opportunity to forget, and an audit trail with anonymous entries is not one. Binding once makes the log complete by construction. |
| **M5: `workspaceTree` reads the quick-open index, synchronously** | Walk the disk through `Platform`, asynchronously, as sketched | A second walk would be a second definition of "the project", free to drift from the one `Mod P` uses. Reusing the index also keeps every method on the API synchronous, which is one fewer await for a caller to get wrong. The cost — no empty directories, possibly still indexing — is reported in the result. |
| **M5: `viewport` is null for a background tab** | Fall back to the whole document, or to the last known viewport | Both would answer a question that was not asked. "What can the user see" has a real answer of "nothing" when no pane is showing the buffer. |
| **M6: review narrows the set, rather than applying hunks one by one** | Apply each accepted hunk as its own change | One transaction means one undo and no window in which half a review is on screen. Applying per hunk would reintroduce exactly the partially-applied state §2.1 was built to make unrepresentable. |
| **M6: hunks start accepted** | Start rejected, opt in to each | Making someone tick every box to get what they asked for trains them to click through without reading, which is the failure mode a review panel exists to prevent. |
| **M6: a stale review stays on screen** | Discard it and make them start again | The staged set holds their accept/reject decisions. Losing those because a buffer moved punishes the user for the timing of someone else's edit. |
| **M6: line granularity, terminators kept** | Word or character diff; strip newlines and re-add them | Hunks are reviewed by line, so that is the unit. Keeping terminators on the line makes `join('')` exact and removes every newline special case from the offset maths — the fiddliest part of turning a diff back into edits. |
| **M7: the protocol is serialisable data** | Method calls on an in-process object, since that is the only implementation today | Designing for in-process first is exactly how "external process later" stops being possible. Everything above the transport already treats the agent as remote. |
| **M7: `proposal.stage` is not a command** | Route every agent verb through the registry for uniformity | A command is the thing that has an effect, and staging has none. Making it one would blur what the permission model is actually protecting. |
| **M7: Nox ships no model provider** | Bundle one so the feature is usable out of the box | A default provider is a vendor in the core, which is precisely what the interface exists to prevent. The panel says so plainly rather than offering an input that cannot work. |
| **Stdio: line-delimited JSON, not LSP framing** | Content-Length headers, as LSP uses | An agent is often a script someone wrote in an afternoon. `print(json.dumps(...))` should be enough to speak the protocol; a header framing turns the smallest possible agent into a parsing exercise. |
| **Stdio: the transport takes an `AgentProcess`, not a command** | Spawn inside the transport | A fixture binary would have to keep working on three platforms, and the failure modes worth testing — a silent agent, a crash mid-sentence, garbage on the wire — are near impossible to provoke on purpose with a real process. A fake makes each of them one test. |
| **`AgentProcess` must buffer output until a handler attaches** | Deliver only to handlers present at the time | A child can write its handshake before `spawnAgent` has returned. Dropping those lines loses the one message every session begins with — which is exactly what the first implementation did, and what the transport tests caught. |
| **Spawning is outside the agent protocol** | Expose it as a capability like any other | An agent that can start processes can start an agent with a different policy, which makes every other permission decision negotiable. It stays a user action. |
| **Audit: `apply` builds every `ChangeSet` before dispatching any** | Build each transaction as its turn comes, as originally written | The original was wrong, not merely slower: CodeMirror throws on a range the document cannot honour, so a bad offset in the second buffer left the first already written and nothing logged. The invariant this whole layer advertises was false until the audit. |
| **Audit: overlapping edits are refused, not merged** | Let CodeMirror combine them | It does not reject them — it produces text nobody asked for. Silently inventing content is the exact failure this layer exists to prevent. |
| **Audit: the review panel closes without deciding** | Leave Apply and Discard as the only exits | Both are decisions, and the panel covers the editor — so there was no way to look at the file you were reviewing without resolving the review first. Escape now puts it away and the status bar offers it back. |
| **Provider interface is streaming-first** | Request/response with an optional stream | Every provider worth using streams; making it the base case avoids a second code path that only the slow providers exercise. |

---

## 7. Open questions

Answered in M1:

- ~~Does a dirty *file* buffer prompt on quit, or is it persisted like a scratch
  buffer?~~ **Neither.** It was silently discarded. Now persisted; no prompt.
- ~~Encoding detection: BOM sniffing or legacy heuristics?~~ **BOM only.**

Still open:

- Should agent-authored decorations persist after the user edits inside an
  agent-authored range, or does any human edit clear attribution for that range?
- Does the transaction log need a size cap in entries, in bytes, or both? A
  single project-wide replace can carry a very large change set.

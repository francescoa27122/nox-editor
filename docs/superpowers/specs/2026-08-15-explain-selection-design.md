# Explain selection — design

Two commands that ask a model about the text you have selected, and a fourth
sidebar section to read the answer in.

Status: approved 2026-08-15. Implementation follows in a separate plan.

This is the half of the roadmap's *Explain selection* line that
[2026-08-15-selection-scoped-edits-design.md](2026-08-15-selection-scoped-edits-design.md)
deliberately left out, for the reason it gave: prose "produce[s] no edits, so
[it] need[s] a result surface this codebase does not have". That surface is
most of this document. The other part is a provider defect found while
designing it, described in §4, which is the reason the feature does not work
today at all.

Everything below was checked against the code on `main` rather than
remembered.

## 1. Why this, and what it is not

**Edit Selection with a Model…** shipped, and it can only change code. Asking
what code *does* — the more common question, and the safer one — has no route
at all. Running a plain **Run Agent…** with "explain this" does not work: §4
shows it ends in a failed session with the explanation discarded.

It is not a chat panel. The roadmap lists "Workspace-aware chat with an
explicit, visible context set" as a separate later item and this design keeps
that line where the roadmap drew it: one question, one answer, no thread, no
accumulated model-side context.

**The roadmap principle is what keeps it small:** AI is a panel and a set of
commands, not a rewrite of the editor. A user who never configures a model
must see exactly the Nox they see now — which is why §7 hides the section
rather than showing an empty one.

## 2. Scope

In:

- **Ask About Selection…** — a free-form question about the selected text.
- **Explain Selection** — the same path with a built-in instruction and no
  dialog.
- `ModelRequest.expects`, so a provider knows Nox wants prose rather than
  actions (§5).
- A fourth sidebar section holding this session's answers (§7).
- Staleness marking when the code an answer describes has changed (§8).

Out, and deliberately:

- **Follow-up questions.** That is the chat feature, and it needs a visible
  context set and a story for code changing mid-thread. One-shot needs
  neither.
- **Persisting answers past quit.** §7 gives the reasoning; it is the same
  reasoning that keeps provenance marks session-scoped.
- **Markdown rendering** beyond fenced code (§7). A renderer is a dependency
  and a sanitisation surface for model output.
- **A family of preset verbs** (Document, Review, Critique). One free-form
  command plus one preset; more presets are prompt templates to defend, and
  the previous spec's §9 already measured that a canned prompt gives a small
  model less to aim at, not more.
- **Anchoring answers to lines in the editor.** Considered and rejected: it
  only earns its cost if it persists, persisting is ruled out above, and the
  hover affordance it would depend on has a confirmed defect (§12).
- Remote models, and any change to the permission model.

## 3. What already exists

The reason this is mostly composition. Verified, not assumed.

| Seam | Where | What it gives us |
|---|---|---|
| Session machinery | `runtime.ts` `AgentRuntime.start` | Job, cancellation, status, audit trail, principal — unchanged |
| Selection in the brief | `runtime.ts#brief` | The selected text already reaches the model, recorded as a `brief` action |
| Scope capture | `runtime.ts:156-164` `scopeFromSelection` | `{ bufferId, fromLine, toLine }` from the primary range, 0-based |
| Command shape | `app.ts:551-572` `runAgentOnSelection` | Chooser, prompt dialog, enablement predicate — copied, not reinvented |
| Enablement | `app.ts:1729` | `#runnableAgents().length > 0 && #selectionScope() !== null` |
| Text chunks | `provider.ts:28-30`, `runtime.ts:852-859` | `{ type: 'text' }` already exists and is already converted to `session.note` |
| Prose verbs | `protocol.ts:80-83` | `session.note` and `session.summary` already in the protocol |
| Revisions | `workspace.ts:925-927` `revisionOf` | Monotonic per buffer; `-1` when the buffer is gone |
| Sidebar | `Sidebar.svelte:22-26` | "Adding one is an entry in `VIEWS` and a branch below" |

Nothing in the protocol needs a new verb. Nothing in the permission model
changes.

## 4. The reason it does not work today

This is the finding the design exists around, and it is not in the UI.

`ollama.ts` runs an action-mandatory loop. Each turn, `parseTurn(content)`
splits the reply into narration and one JSON action. A reply that is pure
prose returns `{ text, action: null, error: 'no JSON object in the reply' }`
(`ollama.ts:226-228`). An actionless turn increments `consecutiveFailures`,
pushes `Error: … Reply with one JSON object` back at the model, and **on the
second one throws** (`ollama.ts:536-567`) — which the runtime turns into a
`failed` session.

So a model asked to explain something does the natural thing, is told twice
that it is wrong, and Nox reports its own feature as broken. The narration is
yielded (`ollama.ts:519`) and lands in the trail as a `note`, where nobody is
looking for an essay.

Two properties of this are worth naming, because they decide §5:

- It is **not a prompt problem.** The loop structurally cannot terminate on
  prose. No instruction to the model changes what happens when it complies.
- It is **invisible to the test suite.** Every scripted provider yields the
  actions the test wrote, so no test can reach a turn that produced none. It
  is the same class as the `name [id]` defect: only a model capable of
  answering naturally can provoke it.

## 5. How prose comes back

`ModelRequest` gains one optional field:

```ts
/** What Nox wants back. Absent means actions, which is what every agent
 *  written before this expects. */
expects?: 'actions' | 'prose';
```

It threads: `SessionOptions.expects` → `AgentRun.expects` → `ModelRequest.expects`
(via `ProviderTransport.run`) → and onto the wire in `Outbound`'s `run`
message, so a child process is told the same thing rather than the wire
quietly lying about what the session is.

`OllamaProvider.complete` branches once, at the top. In `prose` mode it makes
**one** round trip, yields the content as `{ type: 'text' }` chunks as it
streams, and returns. No `parseTurn`, no action loop, no turn cap, no JSON.

Three consequences, all of them wanted:

- The §4 failure stops existing by construction rather than by instruction.
- A local model is asked for the one thing every model does well.
- The seam stays vendor-neutral: the field says what *Nox* wants back, never
  who is answering. `ScriptedProvider` ignores it and every existing test is
  untouched.

**Why not make the model emit `session.summary` instead** (the no-interface-change
option): it asks a small local model to put multi-paragraph markdown inside a
JSON string — newlines, quotes, backticks, fences — which is exactly the
surface `ARCHITECTURE.md` §4 already records as unreliable, "stripping code
fences the model applies inconsistently between turns of one conversation".
An explanation of code is the prose *most* likely to contain a fence, and the
failure mode is a failed session rather than a degraded answer.

**Why not a second provider method:** `provider.ts:46-52` argues against that
shape in advance — "offering both would create a second code path exercised
only by the slow ones" — and every future provider would owe two
implementations.

### The safety property this buys

In a prose session the runtime **refuses any request other than
`session.note` and `session.summary`**, with `invalid-request`. An Explain
session therefore cannot stage a change set or execute a command, by
construction and not by convention — including from an out-of-process agent
that ignores `expects`. Worth having: "explain this" should never be able to
edit anything.

## 6. The commands

| id | title | behaviour |
|---|---|---|
| `agents.askAboutSelection` | Ask About Selection… | Prompt for a question, then run |
| `agents.explainSelection` | Explain Selection | No prompt; a built-in instruction |
| `answers.focus` | Show Answers | Reveal the panel. `Mod+Shift+A` — verified unbound anywhere in `src/` |

The first two share `app.ts`'s existing shape exactly: capture the scope
*before* the dialog, choose an agent, run. Enablement for all three is the
predicate `agents.runOnSelection` already uses — `#runnableAgents().length > 0`,
plus a selection for the two that need one — which exists so that "a command
offered and then refused is the drift this predicate was extracted to
prevent". `answers.focus` takes the agent half only, so that the command and
the sidebar rail can never disagree about whether the section exists.

The built-in instruction for **Explain Selection** is one exported constant in
`app.ts`, so a test asserts the string that actually ships rather than a copy
of it.

Both run with `expects: 'prose'` and pass the captured scope. The scope's job
here is different from the edit path's — it does not default a hunk, because
there are no hunks. It records what the answer is *about*, for §7's header and
§8's staleness.

## 7. The Answers panel

A fourth `SidebarView`, `'answers'`, rendered by `AnswersPanel.svelte`.

**Lifetime is the session, and no longer.** The same rule and the same reason
as provenance marks: an explanation of code that has since changed is
confidently wrong, and `ARCHITECTURE.md` §4 already settles what to do about
that — "a mark that lies is worse than no mark". Answers live in the runtime's
existing session list, whose lifetime is already exactly this, so nothing new
persists and nothing new has to be cleaned up.

**Hidden until there is a runnable agent.** `VIEWS` in `Sidebar.svelte` is
filtered by the same `runnableAgents()` predicate the commands use. Someone
who never configures a model sees three sections, as today, and no dead icon.
Two rules fall out and both need writing down:

- If the section is showing when the last runnable agent disappears (an edit
  to `agents.json`, a reload), the sidebar falls back to the explorer rather
  than rendering a view that is no longer in the rail.
- `showView('answers')` with no runnable agent does nothing.

**No new service.** The runtime already publishes `AgentSessionSnapshot[]`;
it gains `expects`, `answer: string | null`, and the `scope` and revision the
answer was about. The panel filters on `expects === 'prose'`. A separate
`AnswersService` mirroring runtime state would be a second history that has to
stay in step forever — the shape `ARCHITECTURE.md` §4 rejects for grouped
undo, for the same reason.

**The answer is not an action.** Text chunks in a prose session accumulate
into `answer` and are *not* also recorded as `note` actions. The trail means
what the agent did; an essay filed as an action would bury the reads the trail
exists for. This is the distinction the `brief` variant already makes and it
is made the same way here.

Because chunks stream, `answer` fills in progressively and the panel shows the
answer arriving.

**An entry shows:** the question asked, the file and line range it was about,
the agent's label, a relative time, and the body. Newest first. A failed
session shows its failure message in place of a body, so a question you asked
never silently vanishes — consistent with "None of them report success".

**Rendering is bounded on purpose.** Plain text with line breaks preserved,
plus runs fenced in triple backticks rendered as monospace blocks. Nothing
else: no headings, no emphasis, no links, no HTML, and no `innerHTML` anywhere
— Svelte text interpolation only, so model output cannot inject markup. Any
other markdown arrives as the characters the model typed. This is a limitation
(§11) and a deliberate one.

**Clicking an entry** reveals the buffer and selects the lines it was about,
when that buffer is still open.

## 8. Staleness

At brief time an ask session records `workspace.revisionOf(scope.bufferId)`
alongside the scope. The panel compares that against the buffer's current
revision:

| Current revision | Meaning | Shown |
|---|---|---|
| Equal to recorded | The code is as the model saw it | Nothing |
| Different | Edited since | *the code has changed since* |
| `-1` | Buffer no longer open | *file is closed*, and the entry is not clickable |

`-1` is called out explicitly because it is *also* "different", and reporting
a closed file as edited would be a small lie in the same family as the ones
this design is trying not to tell.

This is a label, never a refusal — the answer is still the answer, and the
user decides what it is worth. It is the same posture the review scope takes:
it "only ever decides a default", never blocks.

## 9. Failure handling

Nothing new. The provider already throws on an unreachable host or a rejecting
server, naming the host or quoting the server, and the runtime turns that into
a `failed` session with the message in its trail. §7 puts that message where
the question was asked. Cancellation is the existing job cancellation and the
existing **Stop the Running Agent** command.

## 10. Testing

Unit and service tests:

- `parseTurn` is untouched and its existing tests must still pass unchanged.
- Prose mode makes exactly one round trip, yields only `text` chunks, and
  yields no action — asserted against a fake HTTP stream, not a live server.
- Actions mode is byte-for-byte unchanged when `expects` is absent.
- **The regression this feature exists for:** a session whose model replies
  with prose and no JSON ends `done` with an answer, not `failed`. This test
  fails on `main`.
- A prose session refuses `proposal.stage` and `command.execute` with
  `invalid-request` (§5).
- A prose session ends `done`, never `awaiting-review`.
- Staleness: unchanged buffer → clean; edited → stale; closed → gone.
- Sidebar: absent with no runnable agent; present with one; falls back to the
  explorer if the last agent disappears while it is showing.

In-app walk against a real model, which is **not optional** — the two defects
this design is built on (§4, and the `name [id]` bug before it) were both
invisible to every scripted test. Per this project's recorded environment
notes: build with `npm run app:build` and run the bundled `Nox.app`, never
`npm run app`; check for the `.app` rather than the exit code, because the DMG
step fails after the app succeeds; drive from the command palette, because a
full-screen overlay can swallow direct clicks; and verify the palette actually
opened before typing.

The walk must cover at least: an explanation containing a fenced code block,
an answer whose buffer is then edited, and an answer whose buffer is then
closed.

## 11. Known limitations, stated rather than discovered

- **Markdown is not rendered** beyond fenced code. Emphasis and headings
  arrive as their characters.
- **Answers do not survive quit.** Deliberate (§7); the alternative is
  attribution that goes quietly wrong.
- **One-shot only.** A follow-up is a second question with no memory of the
  first, and the model is told nothing about the earlier exchange.
- **The brief truncates at `SELECTION_MAX_CHARS`** (8,000) exactly as it does
  for the edit path. A very large selection is explained from its start, and
  the brief says so.
- **An out-of-process agent may ignore `expects`.** It is told, and its
  non-prose requests are refused (§5) — but a stdio agent that simply narrates
  nothing will produce an empty answer and a `done` session.

## 12. Related known defect

Not fixed here, and recorded so the next person does not rediscover it. The
provenance tooltip does not respond to hovering the gutter bar: `hoverTooltip`
resolves document positions and only fires over `.cm-content`, while the
marker lives in a separate gutter element. Hovering the changed *text* works
and shows the correct tooltip; hovering the mark — the only affordance
announcing there is anything to read — does nothing. Confirmed in the running
browser target on 2026-08-15. It is a separate, bounded fix.

## 13. Files

New:

- `src/ui/AnswersPanel.svelte`
- `tests/answers.test.ts`

Changed:

- `src/services/agent/provider.ts` — `ModelRequest.expects`
- `src/services/agent/protocol.ts` — `AgentRun.expects`, `Outbound`'s `run`
- `src/services/agent/ollama.ts` — the prose branch
- `src/services/agent/runtime.ts` — `SessionOptions.expects`, prose-session
  request refusal, answer accumulation, scope and revision on the snapshot
- `src/services/ui.ts` — `SidebarView` gains `'answers'`, `focusAnswers`
- `src/ui/Sidebar.svelte` — the filtered `VIEWS` entry and its branch
- `src/app.ts` — three commands and one keybinding
- `ROADMAP.md`, `CHANGELOG.md`, `ARCHITECTURE.md` §4

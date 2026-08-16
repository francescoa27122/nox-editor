# Selection-scoped model edits — design

One command that asks a local model to change the text you have selected, and
puts the answer through the review panel like any other proposal.

Status: approved 2026-08-15. Implementation follows in a separate plan.

Everything this design depends on is on `main`, checked rather than assumed:
the stale-read guard and `runnableAgents` both landed with the provider and
stale-read work. It does **not** depend on the `baseRevisions` declaration,
which is a separate protocol change — nothing here needs an agent to declare
anything.

## 1. Why this, and what it is not

The Ollama provider shipped, and the only way to reach it is **Run Agent…**,
which starts a full session against the whole workspace. For a two-line change
that is a heavy instrument: you describe the file, the model goes looking for
it, and several turns later it proposes something. The gap this closes is
between *the model works* and *you would reach for it*.

It is not a chat panel, not an inline completion, and not a second way to
apply edits. It is one command that reuses the session machinery already
built.

**The principle from the roadmap is unchanged and is the reason this stays
small:** AI is a panel and a set of commands, not a rewrite of the editor. A
user who never configures a model sees one more disabled command.

## 2. Scope

In:

- One command, **Edit Selection with a Model…**, taking a free-form
  instruction.
- The selection reaching the model as part of the session's context brief.
- Hunks that fall outside the selection starting *unkept* in the review panel.

Out, and deliberately:

- **Explain / prose commands.** They produce no edits, so they need a result
  surface this codebase does not have — `NotesPanel` is the user's own notes,
  toasts are transient, and the agents panel is a session trail. That is a
  larger piece of work than the edit path and it is separable.
- **Named verbs** (`Refactor Selection`, `Fix Selection`). A canned prompt
  gives a 7B model nothing to aim at, which is the input shape §9 shows it
  handles worst. One free-form instruction is both smaller and better.
- **Multi-range selections.** The primary range only; inventing multi-range
  semantics before anyone has used the single-range case is guessing.
- **Refusing out-of-scope edits.** See §6.
- Remote models, applying without review, and any change to the agent
  vocabulary.

## 3. What already exists

Verified against the code rather than assumed. This section is the reason the
design is mostly composition.

| Seam | Where | What it gives us |
|---|---|---|
| `ModelProvider.complete(request)` | `services/agent/provider.ts:42-53` | Streams from a model with no dependency on `AgentRuntime`. |
| `AgentRuntime.start(transport, instruction, options)` | `services/agent/runtime.ts:201` | Sessions, audit trail, session-level undo, provenance author, permission model, job cancellation. |
| `AgentRuntime.brief()` | `services/agent/runtime.ts:376-386` | The context string handed to the provider. Today: open files, active file, viewport. **Not the selection.** |
| `SessionOptions` | `services/agent/runtime.ts:113-116` | Currently `{ label?: string }`. |
| `ReviewService.stage(spec)` | `services/review.ts:70` | Stages a change set; every hunk gets `accepted: true` at `review.ts:102`. |
| `ReviewHunk` | `services/review.ts:21-26` | `extends Hunk` with `id`, `displayLine` (1-based), `accepted`. |
| `Hunk` | `core/diff.ts:14-21` | `fromLine` (0-based, into the *before* lines), `removed[]`, `added[]`. |
| `runnableAgents(agents, {canSpawn, providerIds})` | `services/agent/config.ts` | Which configured agents this build can actually start. |
| The stale-read guard | `services/agent/runtime.ts` | Refuses a stage against a buffer that moved since the session read it. |

Nothing here needs a new provider interface, a new transport, or a second
path that services protocol requests.

## 4. The command

`agents.runOnSelection` — **"Edit Selection with a Model…"**, category Agents.

**Enabled when** the active editor has a non-empty selection *and*
`runnableAgents(...)` finds at least one model-backed agent. It reuses that
predicate rather than re-deriving one, because a task on the provider branch
shipped exactly that drift — a command offered by the palette and refused by
the panel — and the fix was to make the predicate shared.

**Flow.** Pick the agent (skipped when only one) → prompt for an instruction →
start a session. Identical to `runAgent` after the pick, and that tail is
extracted rather than copied.

**Where the logic lives: `app.ts`.** `runAgent` and this share everything from
the instruction prompt onward — transport selection, `agents.start`,
`ui.showAgents()`. The alternative considered and rejected was a
`startOnSelection` method on `AgentRuntime`: the runtime is deliberately
wiring, and *which command the user ran* is composition-root knowledge. What
the runtime does gain is a scope in `SessionOptions` (§6), which is a property
of the run in the same way `label` already is.

## 5. How the selection reaches the model

`brief()` gains it. One method, and **every** session benefits — an ordinary
`Run Agent…` started with text selected now tells the model where the user is
looking, which is information it never had.

```
Selected in math.js, lines 3–5:
export function add(a, b) {
  return a + b;
}
```

Two constraints decided now rather than discovered later:

- **A size cap on the selection text: 200 lines or 8,000 characters,
  whichever comes first.** Over it, truncate and say so in the brief, so the
  model knows it is working from a fragment rather than silently assuming it
  has the whole thing. A selection larger than that is not a selection someone
  is editing, it is a file. The exact number is a judgement, not a
  measurement — the implementer should sanity-check it against real inference
  and say so if it is wrong, rather than treating it as settled.
- **The primary range only** when several are selected, per §2.

Rejected: putting the selection in the *instruction*. The instruction is what
the audit trail and the job title show, and it should stay the user's own
words. Rejected: relying on the model to call `context.selection` itself —
it costs a round trip against a small turn cap, and it can decline.

## 6. Edits outside the selection

The review panel's rule is that everything starts kept — review is for
catching the wrong ones. That is right for a change set you asked for
wholesale. It is wrong here: a hunk *outside* what you selected would be
pre-accepted, and stopping it depends on you noticing.

**`SessionOptions` gains `scope?: { bufferId, fromLine, toLine }`**, captured
when the command runs and passed through to `review.stage`. A hunk whose line
range does not overlap the scope starts `accepted: false`, labelled *outside
your selection* so the state is not mysterious.

Three properties this is chosen for:

1. **Nothing is refused.** A companion edit — a new import at the top for a
   change you asked for in the middle — is still proposed, and is one click
   from being kept. Refusing it would mean refusing the model for doing the
   right thing.
2. **Scope only ever decides a default.** It never rejects, never blocks, and
   never interacts with the stale-read guard. If the buffer moved between
   invocation and staging, the worst case is a checkbox defaulted wrongly; the
   guard is what protects the text.
3. **Line ranges, not character offsets.** A hunk that touches the selection's
   lines counts as inside. That is the forgiving direction, and it matches
   what `Hunk` already carries.

**The overlap rule, stated exactly**, because "does not overlap" has an
off-by-one and an edge case that would otherwise be guessed:

- `scope.fromLine` / `scope.toLine` are **0-based, inclusive**, in the same
  *before*-document space as `Hunk.fromLine`. Not `displayLine`, which is
  1-based and for rendering.
- A hunk spans `[hunk.fromLine, hunk.fromLine + hunk.removed.length - 1]`.
- **A pure insertion** has `removed.length === 0` and so spans nothing. Treat
  it as the single line `hunk.fromLine`, and count it inside when
  `scope.fromLine <= hunk.fromLine <= scope.toLine + 1` — the `+ 1` because
  text inserted immediately after the last selected line is the natural result
  of "add something at the end of this", and refusing to call that inside
  would default the most ordinary case to unkept.

A session with no scope — every plain `Run Agent…` — is unchanged. That is a
test, not an assumption.

## 7. Failure handling

Every row already has an owner; none is new work.

| Situation | Behaviour | Owner |
|---|---|---|
| No model-backed agent configured | The command is disabled, not offered and then refused | `runnableAgents` |
| Server unreachable | Session ends `failed`, naming the host | provider branch |
| Model not pulled | Session ends `failed`, repeating the server's own message | provider branch |
| Model stages nothing, gives up, or hits the turn cap | Ends with a summary saying which — never a bare `Done` | provider branch |
| Buffer moved under the model | The stage is refused, and the model is told to re-read | stale-read guard |
| Selection over the cap | Truncated, with the truncation stated in the brief | §5 |
| User cancels | The session's `AbortSignal` closes the stream | `JobRunner` |

## 8. Testing

- `brief()` with a selection, without one, at the cap boundary, and with
  several ranges selected.
- Scope defaulting: a hunk inside the scope starts kept; a hunk outside starts
  unkept; a session with **no** scope leaves every hunk kept.
- A pin that the extracted shared tail does not change `runAgent`'s
  behaviour. That code came through four review rounds on the provider branch
  and this must not quietly alter it.

Every test carries a comment naming the failure it prevents.

## 9. A known limitation, stated rather than discovered

The in-app walk against `qwen2.5-coder:7b` recorded the model **under**-reaching:
asked to rename `add` to `sum`, it renamed the declaration at line 3 and left
the call site at line 12 untouched. The edit it made was correct; the job it
did was partial.

So "edit this selection" will often produce an incomplete edit. That is a
model limitation, not a defect in this feature, and the documentation should
say so plainly rather than let a user read it as a bug. It also argues that
§6's default is about **safety** — nothing lands outside what you asked for —
and not about completeness, which no default can supply.

## 10. Files

- Modify: `src/app.ts` (the command, and the extracted shared tail)
- Modify: `src/services/agent/runtime.ts` (`brief()`, `SessionOptions.scope`,
  passing scope to `review.stage`)
- Modify: `src/services/review.ts` (`stage` accepting a scope; hunk default)
- Modify: `src/ui/ReviewPanel.svelte` (the *outside your selection* label)
- Modify: `tests/agent.test.ts`, `tests/review.test.ts`
- Docs: `ARCHITECTURE.md` §4, `CHANGELOG.md`, `README.md`, `ROADMAP.md`

`src/services/config/schema.ts` is not in this list: there is nothing here a
user configures. The size cap in §5 is a constant, not a setting — a
preference whose wrong value silently degrades model output is a preference
that should not exist.

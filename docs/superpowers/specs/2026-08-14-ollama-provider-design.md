# Ollama provider — design

The first `ModelProvider` Nox ships: a local model, reachable over loopback,
that can read the workspace and offer a change set for review.

Status: approved 2026-08-14. Implementation follows in a separate plan.

## 1. Why this, and what it is not

`ModelProvider` has existed since v0.2 and has never been implemented.
`runtime.ts` says so deliberately — `providers` is an empty signal and
`registerProvider` waits for a caller. Everything above it is built: the
context API, the permission model, staged change sets with hunk review, the
session audit trail, and now the provenance marks that make an agent's edits
visible after the fact.

This connects the last wire. It is not a rewrite of the editor and it is not
Nox becoming an AI product: the roadmap's principle stands — *if a feature
would make Nox worse for someone who never turns AI on, it does not ship*.
Nothing here changes behaviour for a user who never configures a model.

**Local first, and only.** No account, no telemetry, no remote endpoint. That
is a position VS Code and Cursor structurally cannot take, and it is the
reason to build this before any hosted provider.

## 2. Scope

An agent that can **read and propose**. In:

- The six `context.*` reads
- `session.note` for narration, `session.summary` to finish
- `proposal.stage`, which lands in the existing hunk-review panel

Out, and deliberately:

- **`command.execute`.** The one method with a side effect. The permission
  model is built for it and would do its job, but the first thing an unproven
  local-model integration can do should not be taking real actions. It is one
  entry in a tool list when it is time.
- Hosted providers, model management (pulling, listing), conversation history
  across sessions, and any UI beyond registering the provider so the existing
  agent panel can start a session with it.

## 3. What the probes established

The design below is not reasoned from documentation. Seven probes were run
against Ollama 0.32.13 with `qwen2.5-coder:7b` before any of it was decided,
and three of them overturned a choice that had already been made.

| Probe | Finding |
|---|---|
| Tool definition with a dotted name, streaming | No `tool_calls` field. The call arrived as text content. |
| Same with an underscored name | Identical. The dots were not the cause. |
| Same, `stream: false` | Identical. Not a streaming artefact. |
| No custom system message at all | Identical. Not a conflict with Ollama's template. |
| `ollama show qwen2.5-coder:7b` | Advertises `tools` under Capabilities — while producing none. |
| Two-turn loop with our vocabulary, offset edits | Correct method and shape; **offsets were garbage** — a zero-width insertion at position 10 of a whole function body, without deleting what it replaced. |
| Same loop with quoted search/replace | Correct, minimal, unique edit, verbatim from the buffer. |

Two conclusions follow, and both are load-bearing:

**Native tool calling is not available, and advertising it proves nothing.** A
model can list `tools` in its capabilities and still never produce a
`tool_calls` field. Building on that would make the feature work with an
unknowable subset of models and fail opaquely for the rest.

**A 7B model cannot compute character offsets.** It gets the intent right and
the arithmetic wrong, which is the worse failure: `proposal.stage` would
accept it, the review panel would render a corrupt diff, and the user would
spend their attention rejecting garbage. The same model, given a quoted
search/replace interface, produced a correct edit on the first attempt. The
interface was the difference, not the model.

## 4. Network access

This section and the provider in §6 are two distinct pieces of work, and the
plan should sequence them as such — the Rust streaming path is testable and
reviewable before a provider exists. They stay in **one** spec rather than
two because the seam has no purpose without its only caller: shipping it alone
was offered as an option and declined, and a `Platform` method with no
consumer is a design waiting to be got wrong.

### Where it lives

**In Rust, behind a new `Platform` method.** Not a `fetch` from the renderer.

`tauri.conf.json`'s CSP is `default-src 'self'` with no `connect-src`, so a
renderer request to `127.0.0.1:11434` is blocked outright. Widening the CSP
would open the app's network surface permanently to buy one feature, and the
roadmap already names the intended shape: *"`Platform` isolates network
access."*

### The method

```ts
export interface JsonLinesSpec {
  /** Loopback only. Rejected otherwise, in Rust. */
  url: string;
  body: unknown;
}

export interface JsonLinesStream {
  /** Stop the request and drop the connection. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * POST JSON to a loopback endpoint and stream newline-delimited JSON back.
 *
 * Deliberately not named for a vendor: nothing at the platform boundary knows
 * what Ollama is. The path, the request shape and the frame shape all live in
 * `services/agent/ollama.ts`.
 */
streamJsonLines(
  spec: JsonLinesSpec,
  onLine: (line: string) => void,
  onEnd: (error: string | null) => void,
): Promise<JsonLinesStream>;
```

The callback shape mirrors `openTerminal`: data as it arrives, an end event
carrying a failure or null, and a handle whose `close()` stops it. The
terminal established that pattern for a streaming Rust resource, and a second
one should not invent a second idiom.

### Loopback only

Enforced in Rust, not in TypeScript: the host must resolve to `127.0.0.1`,
`::1`, or `localhost`. A local-model feature has no business reaching the open
internet, and refusing everything else keeps the security story as tight as
the CSP it replaces. A remote provider later is a deliberate widening with its
own argument, not something that falls out of this.

### Capability

`capabilities.localModels`, false on the browser target, which has no Rust.
The provider is not registered there and the agent panel says so — the same
honest degradation the terminal already does.

## 5. Configuration

`agents.json` gains a discriminated union:

```jsonc
{
  "agents": [
    { "id": "local", "label": "Qwen coder", "kind": "ollama",
      "host": "http://127.0.0.1:11434", "model": "qwen2.5-coder:7b" },
    { "id": "example", "label": "Example agent",
      "command": "node", "args": ["./my-agent.js"] }
  ]
}
```

**An absent `kind` means `"process"`**, so every existing `agents.json` keeps
working with no migration.

Rejected: **settings-schema scalars** (`agent.ollamaHost`, `agent.ollamaModel`).
They would fit the generated Settings UI, but they permit exactly one Ollama
agent — while `runtime.providers` is a list and `registerProvider` returns an
unregister, because it was built for many. `config.ts`'s own doc comment
already argues that a list of records does not belong in a schema of scalars;
that reasoning covers this unchanged.

## 6. The provider

`src/services/agent/ollama.ts`, implementing `ModelProvider`.

The interesting constraint is that `ModelStream` is an async generator that
**receives the `CoreResponse` back at each yield**. The conversation loop
therefore lives inside the provider rather than above it:

1. Build the message list: a system prompt stating the method vocabulary and
   the one-JSON-object-per-reply rule, then the instruction and the session's
   context brief.
2. POST `/api/chat` with `stream: true` and `temperature: 0`.
3. Accumulate `message.content` deltas across frames. The model streams a
   single JSON object a few characters at a time.
4. When a complete object parses, yield it as `{type: 'action', request}`.
   Prose that is not an action is yielded as `{type: 'text'}`.
5. Append the `CoreResponse` received at the yield as the next user message,
   and loop.
6. Stop on `session.summary`, on the turn cap, or on abort.

### Parsing, and what the probes require of it

- **Strip code fences.** The model wrapped turn 1 in ```` ```json ```` and
  turn 3 in nothing, having been told not to fence at all. Consistency is not
  available; tolerance is.
- **Accumulate across frames.** Content arrives character by character; no
  single frame contains a parseable object.
- **One object per reply.** Anything after the first complete object is
  ignored rather than guessed at. Prose *before* it is yielded as a `text`
  chunk first — a model that says "Let me look at the file" and then acts is
  narrating, and the interface exists to carry exactly that.
- **Unparseable output is a turn, not a crash.** The provider feeds the parse
  error back as the result and lets the model retry. Two consecutive failures
  end the session with a plain message, because a model that cannot emit the
  format twice will not manage it on the third attempt.

### Guards

- **A turn cap**, `maxTurns` in the agent's `agents.json` record, defaulting
  to 12 when absent. A small model will re-read the same buffer indefinitely
  given the chance. It belongs in the record rather than the settings schema
  for the same reason the host and model do: it is per-agent, and a schema of
  scalars cannot hold a per-record value.
- **`temperature: 0`.** This is a structured-output task, not a creative one,
  and determinism makes failures reproducible.

## 7. Edits: quoted search/replace

The model emits, inside `proposal.stage`:

```jsonc
{ "bufferId": "b1",
  "find": "export function add(a: number, b: number) {",
  "replace": "export function sum(a: number, b: number) {" }
```

The provider locates `find` in the buffer and converts it to the
`{from, to, insert}` that `proposal.stage` actually takes. **The protocol is
unchanged** — `proposal.stage` still receives real offsets, and the runtime,
the review panel and the change-set machinery below it never learn that a
model was involved.

Refusal rules, both of which fail loudly rather than corrupting a file:

| Case | Result |
|---|---|
| `find` does not appear in the buffer | Refused: "text not found". Fed back so the model can requote. |
| `find` appears more than once | Refused: "text is ambiguous, N matches". The model must quote more surrounding context. |
| `find` is empty | Refused. An empty match would be an insertion at position 0, which is never what was meant. |

Ambiguity is refused rather than resolved by taking the first match. Editing
the wrong one of three identical lines is exactly the silent corruption this
whole interface exists to avoid.

## 8. Failure handling

| Situation | Behaviour |
|---|---|
| No server on the configured host | The session fails to start, saying the host is unreachable. Not a crash, and it names the host so the fix is obvious. |
| The model is not pulled | Ollama's own error is surfaced verbatim. It already says `model "x" not found, try pulling it first`. |
| Stream ends mid-object | Treated as an unparseable turn. |
| The user cancels | The session's `AbortSignal` closes the stream; Rust drops the request. |
| Turn cap reached | The session ends with a summary saying so, rather than silently stopping. |
| Browser target | The provider is never registered; `capabilities.localModels` is false. |

## 9. Testing

The fake goes at the `streamJsonLines` seam — the same shape as
`tests/terminal.test.ts`'s fake pty.

**Fixtures are recorded, not invented.** The frames captured during the probes
are real Ollama output and become the test corpus. An integration whose
fixtures are guesses passes its tests and fails on contact; that is the
failure mode this project has already been bitten by twice.

| Test | The failure it prevents |
|---|---|
| A single object split across many frames parses once complete | A parser that assumes one frame is one message |
| A fenced reply parses | The model's inconsistent code fencing, observed between turns of one conversation |
| An unfenced reply parses | A parser that requires the fence it learned to strip |
| Unparseable output feeds the error back and continues | A malformed turn ending the session |
| Two consecutive unparseable turns end the session | An infinite retry loop against a model that cannot emit the format |
| `find` not present is refused with a message naming that | A silent no-op edit |
| `find` matching twice is refused as ambiguous | Editing the wrong one of several identical lines |
| A found `find` produces the correct `{from, to}` | Off-by-one offsets reaching `proposal.stage` |
| The turn cap ends the session | A model re-reading one buffer forever |
| Abort mid-stream closes the stream and stops | A cancelled session leaving a request open |

One test is Rust, in `src-tauri/src/http.rs`, because the restriction it
guards is enforced there:

| Test | The failure it prevents |
|---|---|
| A non-loopback host is refused before any request is made | The loopback restriction existing only in a comment, so a typo'd host silently reaches the internet |

Then the running app, against the real Ollama: a session that reads a file and
stages a rename, accepted through the review panel, with the resulting edit
carrying an agent-authored provenance mark.

## 10. Files touched

| File | Change |
|---|---|
| `src/platform/types.ts` | `streamJsonLines`, its types, `capabilities.localModels` |
| `src/platform/tauri.ts` | the adapter over the Rust command and its events |
| `src/platform/memory.ts` | unsupported; `localModels: false` |
| `src/platform/web.ts` | inherits the memory behaviour |
| `src-tauri/src/http.rs` | new — the streaming POST, loopback enforcement, cancellation |
| `src-tauri/src/lib.rs` | command registration |
| `src-tauri/Cargo.toml` | an HTTP client dependency |
| `src/services/agent/ollama.ts` | new — the provider, the prompt, the parser, the loop |
| `src/services/agent/config.ts` | the `kind` union; `AGENTS_TEMPLATE` gains an Ollama example |
| `src/app.ts` | register a provider per configured Ollama agent |
| `tests/ollama.test.ts` | new |
| `tests/agent-config.test.ts` | the union, and that an absent `kind` still parses |
| `ARCHITECTURE.md`, `CHANGELOG.md`, `ROADMAP.md` | the decision, the feature, the roadmap entry |

`src/services/agent/runtime.ts` and `protocol.ts` are **not** in this list.
The interface they define is exactly what was needed; that is what a seam
built ahead of its first user is supposed to feel like.

## 11. Out of scope, named so they are deferred rather than forgotten

`command.execute` for agents; hosted providers; model pulling or listing from
inside Nox; multi-turn conversation history across sessions; streaming the
model's narration into the editor as it types; a settings UI for model
parameters; and any attempt to make this work with models that cannot follow
the format — the honest answer there is a clear failure message, not a
cleverer parser.

# LSP client — design

A language server's diagnostics appear in Nox, and the machinery that carries
them is general enough that completion, hover, go-to-definition, rename and
format-on-save are wiring rather than architecture.

Status: approved 2026-08-17. Implementation follows in a separate plan.

The first item of **v0.4 — Language intelligence**, and the one the roadmap
calls "unlocks everything below". Diagnostics ride along as its first consumer,
because a transport with no consumer is an interface designed against a guess.

Everything below was checked against the installed CodeMirror packages, the
existing `agent.rs` / `pty.rs` supervision modules and the `agents.json`
configuration flow rather than remembered.

## 1. Why the existing transport does not fit

`agent.rs` already spawns a child, pipes its stdio and streams it to the
renderer. It is the right shape and the wrong framing, and its own header says
so:

> Line-delimited JSON rather than a length-prefixed framing like LSP's: an
> agent is very often a script someone wrote in an afternoon, and `print(...)`
> in a loop should be enough to speak it.

Its read loop is `BufReader::new(stdout).lines()`. An LSP message body carries
no trailing newline, so a line-buffered reader holds each message until the
*next* one arrives — the handshake would appear to hang, and every subsequent
message would be delivered one message late.

The deeper problem rules out fixing this in TypeScript. `Content-Length` counts
**bytes**; `pty.rs` hands the renderer decoded strings, and JavaScript string
length counts UTF-16 code units. A single realistic payload shows the gap:

```
{"jsonrpc":"2.0","id":1,"result":{"label":"café — naïve"}}
  JS .length : 58
  UTF-8 bytes: 62
```

Framing computed over decoded text desynchronises on the first non-ASCII
character in a hover string or a completion label and never recovers. So the
framing must happen where the bytes are still bytes: in Rust.

## 2. Scope

In:

- `src-tauri/src/lsp.rs` — process supervision and `Content-Length` framing.
- A `LanguageServerProcess` on the `Platform` boundary, shaped like
  `AgentProcess`.
- `src/services/lsp/` — JSON-RPC, session lifecycle, document synchronisation,
  server registry.
- `src/core/uri.ts` — path to `file://` conversion, pure and tested.
- Diagnostics end to end: squiggles, gutter marks, a problems panel.
- `servers.json`, mirroring `agents.json`.
- A status-bar item naming the server and its state.

Out, and deliberately:

- **Completion, hover, go-to-definition, find references, rename,
  format-on-save.** Each is a separate spec against this foundation. They are
  the reason it exists; they are not part of it.
- **Incremental document sync.** §6 argues the case.
- **Multi-root workspaces.** Nox opens one folder. A second root is a
  workspace-model change, not an LSP change.
- **A built-in server registry.** §8.
- **Tree-sitter.** Unrelated to LSP; it shares only a roadmap heading.

## 3. Layering

The split already stated twice in this codebase — Rust moves messages, the
renderer decides what they mean, "which is where it can be unit-tested against
a fake process instead of a real one" — is kept exactly.

```
src-tauri/src/lsp.rs          supervision + framing. Knows no method names.
  MessageStream               pure: push(&[u8]) -> Vec<String>
  nox_lsp_start / _send / _stop / _stop_all
  nox://lsp-message / -stderr / -exit

src/platform/types.ts         LanguageServerSpec, LanguageServerProcess,
                              capability `languageServers`
src/platform/tauri.ts         real
src/platform/web.ts           PlatformError('unsupported')
src/platform/memory.ts        a scriptable fake server

src/services/lsp/
  transport.ts   JSON-RPC: id correlation, timeouts, notification dispatch
  session.ts     lifecycle state machine for one server
  documents.ts   didOpen / didChange / didClose against workspace buffers
  registry.ts    servers.json -> which server for which language
  index.ts       LspService facade

src/core/uri.ts               path <-> file:// URI
src/editor/lsp.ts             CodeMirror bridge (diagnostics -> lint)
src/ui/ProblemsPanel.svelte   the panel
```

`ui/` reaches none of this directly; it talks to `LspService`, which talks to
`Platform`. The rule that `ui/` never imports `@tauri-apps/*` is unchanged.

## 4. `MessageStream`, and why it is a separate type

The direct analogue of `pty.rs`'s `Utf8Stream`, and it exists for the reason
that module already gives: a read boundary falls anywhere, and provoking that
against a real server on purpose is near impossible while writing it down as a
test is trivial.

It accumulates bytes, parses headers until a blank line, reads exactly
`Content-Length` bytes of body, and only then decodes UTF-8. Anything it cannot
parse is a hard error surfaced on the stderr channel, not a silent resync — a
stream that has lost framing cannot be recovered by guessing.

Its Rust unit tests, which CI runs on every push:

1. One message arriving in one read.
2. A read boundary inside the header block.
3. A read boundary inside the body.
4. Two complete messages in a single read.
5. A body containing a literal blank-line sequence inside a JSON string.
6. A non-ASCII body where byte length exceeds character count — the case
   from §1.
7. A malformed header, which must error rather than hang.

Everything else in `lsp.rs` is spawn, thread and kill plumbing whose shape is
copied from `agent.rs`.

## 5. The Platform boundary

```ts
export interface LanguageServerSpec {
  command: string;
  args?: string[];
  /** Defaults to the workspace root. */
  cwd?: string;
}

export interface LanguageServerProcess {
  /** Write one JSON-RPC message. Framing is added for you. */
  send(message: string): Promise<void>;
  /** Each complete message the server writes. Buffered before subscription. */
  onMessage(handler: (message: string) => void): void;
  /** Each stderr line — diagnostics about the server, never protocol. */
  onStderr(handler: (line: string) => void): void;
  onExit(handler: (code: number | null) => void): void;
  kill(): Promise<void>;
}
```

`AgentProcess`'s buffering rule is repeated here, and it is load-bearing rather
than merely prudent: a server can emit `window/logMessage` and its `initialize`
response in the same tick it starts, well before the caller has subscribed.
Dropping those loses the handshake the entire session is predicated on.

`capabilities.languageServers` gates it, as `agentProcesses` and `terminals`
already do for their subsystems.

## 6. Document synchronisation

The part where being wrong is expensive, so both choices are conservative.

**Full-text sync, debounced, even where the server offers incremental.**
Incremental is a performance optimisation whose failure mode is silent: one
off-by-one in a range conversion desynchronises the server's copy of the file,
and from then on every diagnostic lands on the wrong line while looking
entirely plausible. Full sync cannot drift. This is revisited when a real
document proves it too slow, and not before — and the session still *reads* the
server's advertised sync kind rather than assuming one, so the negotiation is
honest.

**The document version is `workspace.revisionOf(id)`.** Reusing the number the
editor already tracks means a `publishDiagnostics` batch computed for revision
12, arriving after the user has typed their way to 14, is dropped rather than
painted. Two parallel counters would drift, and the drift would be invisible.

`didOpen` fires when a buffer for a configured language opens, `didChange` on an
edit debounced by 300ms — long enough that a typed word is one message, short
enough that diagnostics feel live — `didClose` when the buffer closes — and closing must also clear
that URI's diagnostics, because a squiggle that outlives its document is a lie
about a file nobody is looking at.

## 7. Diagnostics

**Push, not poll.** `@codemirror/lint`'s headline API, `linter()`, pulls on a
timer, which is the wrong shape for a server that pushes when it is ready. The
bridge dispatches `setDiagnostics(state, ...)` on receipt and adds
`lintGutter()`. Squiggles, gutter marks and the hover tooltip all come from that
one extension; nothing is drawn by hand. `@codemirror/lint` is already in the
dependency tree transitively, so making it direct adds no install weight.

**Stored by URI, not by buffer.** A server publishes diagnostics for files that
were never opened — `tsserver` does this for project-wide errors — and a
problems panel listing only open tabs would be the wrong feature. `LspService`
holds `Signal<Map<string, Diagnostic[]>>`; the panel renders all of it, the
editor bridge renders only the URI it is showing.

**Ranges are clamped to the document, and this is correctness rather than
defensiveness.** `publishDiagnostics`'s `version` field is optional, so a server
that omits it defeats the revision check in §6 entirely. CodeMirror throws on
out-of-range positions, which makes an unclamped stale batch a crash in the
editor rather than a cosmetic error. Severity maps 1-4 to
`error | warning | info | hint`.

**The panel copies `SearchPanel`'s shape**, not merely its styling: grouped by
file, flattened to a `rows()` list with a `focused` index, arrow-key navigable,
Enter opens the file at the diagnostic. That panel's own docstring makes the
argument — a results tree you cannot drive with the arrow keys is half a feature
in a keyboard-first editor — and a second tree that behaved differently would be
worse than either.

## 8. Configuration

`servers.json`, mirroring `agents.json` in every respect: absent by default,
created on demand by a **Configure Language Servers** command, hot-reloaded,
with a **Reload Language Server Configuration** command beside it.

```json
[
  {
    "languages": ["typescript", "javascript", "typescriptreact"],
    "command": "typescript-language-server",
    "args": ["--stdio"]
  }
]
```

The file Nox creates already contains that entry, working and commented, so
enabling a server is uncommenting a block rather than research.

**Nothing spawns until the user writes one.** Starting a process is, in this
codebase's own words, the single most powerful thing Nox does on someone's
behalf, reachable only by the user through configuration. A built-in registry
that spawns whatever it finds on `PATH` would quietly revise that stance; if it
is ever revised it should be deliberate and its own decision.

The workspace root is the LSP root. `rootMarkers` is omitted: a single-folder
workspace has exactly one answer, and the setting would be a knob with no
question behind it.

## 9. Failure paths

Each of these is a test, not an intention.

| Failure | Behaviour |
|---|---|
| Command not found | Session ends `failed`; status bar says which command; no retry loop. |
| Server exits during `initialize` | `failed`, stderr tail retained and reachable from the status item. |
| Server crashes while running | Its diagnostics are cleared, then restart with backoff (1s, 2s, 4s), capped at 3 attempts inside 60s; after the cap it stays down and says so. A silent respawn loop is worse than a stop. |
| Request never answered | A 10s per-request timeout rejects the promise. No unbounded pending map. |
| Message sent before `initialize` completes | Queued, not written. |
| Server-to-client request Nox does not implement | A JSON-RPC method-not-found error response, never silence. |
| Renderer reloads | `nox_lsp_stop_all` on close, as `killAllAgents` already does — a reload otherwise orphans servers with nothing to talk to them. |
| `servers.json` is malformed | Reported by notification; the previous good configuration stays live. |
| Diagnostics for a closed or deleted file | Dropped, and the URI removed from the map. |
| Platform without language servers (web) | `capabilities.languageServers` is false; the panel and status item do not appear. |

## 10. Testing

**Rust:** `MessageStream`'s seven cases (§4), run by CI on Linux, macOS and
Windows. There is no cargo toolchain on the development machine, which is
precisely why the framing logic is a pure function with unit tests rather than
something only observable through a running server.

**TypeScript, against `MemoryPlatform`'s scriptable fake server** — no child
process, no cargo, no network:

- Lifecycle: initialize handshake; traffic queued before it completes; clean
  shutdown ordering; crash, clear, restart, cap.
- Transport: id correlation across interleaved replies; timeout; unknown server
  request answered with an error.
- Documents: open/change/close notification sequence; version equals the buffer
  revision; close clears diagnostics.
- Diagnostics: stale batch by version is dropped; a batch with no version is
  clamped and applied; severity mapping; a range past end of document does not
  throw.
- URI: round trip for POSIX, Windows drive letters, UNC paths and spaces.
- Position: line/character to offset over an emoji and over a CRLF document.

**Manual, once:** `typescript-language-server` against this repository, which is
the dogfooding case — an error in a `.ts` file here shows a squiggle, a gutter
mark and a panel row, and fixing it clears all three.

## 11. Files

New:

- `src-tauri/src/lsp.rs`
- `src/core/uri.ts`
- `src/services/lsp/{transport,session,documents,registry,index}.ts`
- `src/editor/lsp.ts`
- `src/ui/ProblemsPanel.svelte`
- tests alongside each

Changed:

- `src-tauri/src/lib.rs` — register the commands and state
- `src/platform/{types,tauri,web,memory}.ts` — the boundary
- `src/editor/extensions.ts` — the lint extension
- `src/ui/{StatusBar,Sidebar}.svelte` — status item, panel registration
- `src/app.ts` — wiring, commands, `servers.json` handling
- `package.json` — `@codemirror/lint` becomes a direct dependency
- `ROADMAP.md`, `ARCHITECTURE.md`, `CHANGELOG.md`

---
name: nox-lsp
description: Use when working on Nox's language-server support — adding an LSP request (completion, hover, definition, references, rename, formatting, code actions), touching document sync or diagnostics, changing the session handshake or restart behaviour, editing servers.json handling, or debugging a server that answers about stale text, never starts, or hangs.
---

# Nox's LSP client

## Overview

Five layers, each testable alone. Read them in this order before changing anything:

| File | Owns | Never |
|---|---|---|
| `src-tauri/src/lsp.rs` | `Content-Length` framing, the process | Protocol meaning |
| `services/lsp/transport.ts` | JSON-RPC 2.0: ids, pending, timeouts | Framing, processes |
| `services/lsp/session.ts` | One server: spawn → handshake → exit | Which document |
| `services/lsp/documents.ts` | Keeping the server's copy in step | Requests |
| `services/lsp/index.ts` | Wiring, restart policy, diagnostics store | |

Pure conversions live in `core/lsp-*.ts` (`lsp-position`, `lsp-text-edit`, `lsp-completion`, `lsp-hover`, `lsp-definition`, `lsp-references`, `lsp-rename`) and are unit-tested without a server.

**Framing is not the renderer's business and cannot be.** `Content-Length` counts bytes; every string on the TS side is measured in UTF-16 code units. The two disagree at the first non-ASCII character in a hover string or completion label.

## Adding a request

Use `LspService.requestFor(languageId, method, params)`. It does two things you must not reimplement:

1. Picks a session whose status is **`running`**. `initializing` would queue behind a cold start and answer long after the keystroke; `failed` never answers.
2. **Calls `entry.sync.flush()` before asking.**

That flush is the single most important line in the subsystem (`services/lsp/index.ts:150`, immediately before `session.request` at `:152`). Document changes are debounced at 300 ms, but every request is *about* the document and completion fires on the keystroke — well inside that window. A server that has not been sent the change answers about the text it still holds. The comment at `documents.ts:76` records the symptom against a real tsserver: typing `console.` offered ~2010 globals instead of ~20 members. Hover, definition and rename would each have hit this separately.

Then put the response conversion in a pure `core/lsp-*.ts` function and test it there.

Check `capabilitiesFor(languageId)` before sending — capabilities are read from the server's `initialize` reply, never assumed.

## Document sync

**Full-text sync, deliberately, even where the server offers incremental.** Incremental is an optimisation whose failure mode is silent: one off-by-one desynchronises the server's copy, and from then on every diagnostic lands on the wrong line while looking entirely plausible. Full sync cannot drift.

The `version` sent is the **buffer's own revision**, not a counter kept in `DocumentSync`. Two counters would drift invisibly, and a diagnostic batch can be checked against the text it was computed from.

Reconciliation is driven off `workspace.buffers` rather than edit events — that list is already republished on every document change, which is exactly the right cadence and one fewer thing to keep in step. Untitled buffers (`path === null`) are skipped: no URI to give a server.

On close, pending debounced changes are **dropped, not flushed** — a `didChange` after `didClose` describes a document the server has forgotten, and servers may treat that as a protocol error.

## Session lifecycle

Two edges are correctness, not tidiness:

- **Nothing may be written before the `initialize` reply.** Requests made while `initializing` are queued in `#queue` and flushed on success. Note the failure path: `#fail` clears the queue (`session.ts:255`) *without rejecting* the queued promises, so a caller whose request landed during a handshake that then failed waits forever. Do not add a caller that awaits `request()` without its own timeout until that is fixed.
- **Nothing may be written after the process is gone.**

`start()` resolves either way — a server that cannot start is a state to render, not an exception every caller handles. Failure lands in `status = 'failed'` with `error` and the last 20 stderr lines, which are usually the only explanation.

`onNotification` registers against the **session**, not the transport, so a caller can subscribe before `start()` builds one. Diagnostics arrive unasked and a server can publish during the handshake; handlers are replayed onto the new transport. Subscribe before starting.

`stop()` is **ask, tell, then kill** — `shutdown` request, `exit` notification, then `kill()`. A server killed outright can leave its own child running; tsserver does. A failed or timed-out shutdown falls through to the kill so a broken server cannot hold the window open.

The ask-tell pair is gated on `status === 'running'` (`session.ts:198`), so a `failed` or still-`initializing` session goes straight to `kill()`.

Restart backoff is `[1000, 2000, 4000]` then stop — three attempts rides out a flap without spinning.

## Positions

Always convert through `core/lsp-position.ts`. LSP characters and JS string indices are both UTF-16 code units, so the mapping is mechanical — which is exactly why it is written once with tests instead of open-coded where an off-by-one is invisible.

Both directions **clamp**, and that is correctness: a server computes against a copy that may be a revision behind, and `publishDiagnostics` carries an *optional* version, so a stale batch cannot always be rejected before it arrives. An out-of-range position is a crash in CodeMirror.

Diagnostics also get normalised in `editor/lsp.ts#toCodeMirrorDiagnostics`: reversed ranges are flipped, and zero-width ranges widened by one character (nobody can see or click a squiggle of no width).

## servers.json

`services/lsp/registry.ts`. A separate file rather than a settings-schema entry, because these are a *list of records* and the settings UI is generated from a schema of scalars.

**Nothing here discovers a server and nothing here starts one.** Starting a process is the most powerful thing Nox does on someone's behalf, so it stays behind something the user wrote down. Do not add PATH probing or autodetection without treating it as a deliberate policy change.

Entries with no `command` or no `languages` are dropped — an entry claiming no language could never be chosen, so it is a mistake rather than an idle server.

## Common mistakes

| Mistake | What happens |
|---|---|
| Calling `session.request` directly | Skips the sync flush; server answers about stale text |
| Requesting from an `initializing` session | Answer arrives long after the keystroke that asked |
| Switching to incremental sync | Silent desync; every diagnostic plausibly wrong |
| Assuming a capability | Server rejects, or silently never answers |
| A second version counter | Drifts from the buffer revision, invisibly |
| Trusting a diagnostic range | Out-of-range throws in CodeMirror |
| Subscribing to notifications after `start()` | Misses the first diagnostics batch |
| Framing/`Content-Length` in TS | Byte vs UTF-16 mismatch on the first non-ASCII character |

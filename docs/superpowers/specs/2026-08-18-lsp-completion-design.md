# LSP completion — design

Typing `console.` offers `log`, `warn`, `error` from the language server, with
the same keyboard the rest of Nox uses.

Status: approved 2026-08-18. Implementation follows in a separate plan.

The second item of **v0.4 — Language intelligence**, and the first feature to
need the LSP client's *request* direction rather than its push direction. The
door it opens is reused by hover, go-to-definition and rename.

Checked against the installed `@codemirror/autocomplete` 6.20.3 and against
`typescript-language-server` 5.3.0's real `initialize` response rather than
remembered.

## 1. What the server actually offers

Measured, not assumed. `typescript-language-server` 5.3.0 replies:

```json
"completionProvider": {
  "triggerCharacters": [".", "\"", "'", "/", "@", "<"],
  "resolveProvider": true
}
```

Two consequences shape the design. The trigger characters are the server's to
declare, so nothing here hardcodes `.`. And `resolveProvider: true` means
documentation arrives only if asked for per item — §6.

## 2. Scope

In:

- `LspService.requestFor` / `capabilitiesFor` — the request door.
- `src/core/lsp-completion.ts` — LSP items to CodeMirror completions, pure.
- `src/editor/completion.ts` — the completion source and its extension.
- Lazy documentation through `completionItem/resolve`.

Out, and deliberately:

- **Snippets.** `insertTextFormat: 2` is stripped rather than honoured; §7.
- **`additionalTextEdits`** (auto-import side edits). They arrive with resolve
  and mutate parts of the file the user is not looking at. That deserves its
  own design, and half of it is worse than none.
- **Commit characters.** CodeMirror supports them; no evidence yet that
  anyone wants `.` to accept a selection here.
- **Hover, definition, rename.** Each is its own spec against the same door.

## 3. The request door

`LspService` exposes diagnostics and status, and keeps `#running` private, so
nothing outside it can talk to a server. Completion needs to ask a question and
get an answer, so:

```ts
/** The server serving this language, or null when none is running. */
capabilitiesFor(languageId: string): ServerCapabilities | null;

/**
 * Ask the server serving `languageId`. Rejects when none is running, so a
 * caller cannot mistake "no server" for "no results" — the two mean very
 * different things to a user staring at an empty picker.
 */
requestFor<T>(languageId: string, method: string, params: unknown): Promise<T>;
```

Both look up the first **running** session whose config claims the language. A
session that is `failed` or still `initializing` is not a candidate; queuing a
completion behind a cold start would arrive long after the keystroke that asked
for it.

## 4. Conversion, and why it is its own module

`src/core/lsp-completion.ts` turns `CompletionItem[]` into CodeMirror
`Completion[]`. Pure, and separate for the reason `toCodeMirrorDiagnostics` is:
this is where being wrong is invisible. A mis-mapped kind is a wrong icon; a
mishandled `textEdit` silently corrupts the line the user is typing on.

**Kinds.** LSP numbers them 1–25; CodeMirror takes a `type` string that drives
the icon. Mapped explicitly, with anything unrecognised falling back to
`variable` rather than to `undefined` — an unknown kind is a rendering
question, not an error.

**What is inserted.** In order of authority:

1. `textEdit` — the server naming the exact range it wants replaced. Honoured
   as `from`/`to`, because ignoring it is how `console.log` becomes
   `console.console.log` when the client guesses the range differently.
2. `insertText` — text without a range.
3. `label` — the fallback, and what CodeMirror does by default.

**Sorting and filtering.** `sortText` and `filterText` are passed through where
present; CodeMirror does its own matching against the text in range, and a
server's `filterText` is what makes that match the right thing for items whose
label is decorated.

## 5. The completion source

`src/editor/completion.ts` builds a `CompletionSource`:

- **Position.** `context.pos` to an LSP position through `positionAt`, against
  `context.state.doc.toString()`.
- **The replaced range.** `context.matchBefore(/[\w$]*/)` gives the word start;
  a `textEdit` on any item overrides it.
- **When to fire.** On an explicit request, on a word character, or on one of
  the server's own trigger characters. Otherwise null, so an idle keystroke
  does not become a round trip.
- **`context.aborted` is checked after the await.** CodeMirror cancels stale
  requests as the user keeps typing, and a result that outlives its keystroke
  must be dropped rather than shown against text it no longer describes.
- **`isIncomplete: true` suppresses `validFor`.** That flag is the server
  saying "ask again on the next character"; caching such a list is how a
  picker shows suggestions for a prefix the user has already left behind.

**No server, or a server that errors, yields `null`** — no picker, and the
editor's other completion sources are unaffected. An empty list and no server
must not look the same from here, which is why §3's `requestFor` rejects.

## 6. Documentation, lazily

tsserver sends no `documentation` in the initial list and advertises
`resolveProvider: true`. So `info` is set as a **function**, which CodeMirror
calls only when an item is highlighted, and that function issues
`completionItem/resolve` for that one item.

Resolving the whole list eagerly would mean hundreds of round trips to render
one tooltip. Skipping resolve entirely would mean the feature has no
documentation at all against its primary server.

A resolve that fails returns no documentation rather than propagating: a
missing tooltip is a small loss, and an exception inside the picker is not.

## 7. Snippets are stripped, not inserted

An item with `insertTextFormat: 2` carries snippet syntax — `foo(${1:arg})`.
Inserting that verbatim puts `${1:arg}` in the user's buffer, which is the
failure they would actually notice and have to undo.

Until snippets are implemented properly, the placeholders are stripped to
their default text and the tab stops discarded. That is a real reduction in
capability, stated here so it is a decision rather than a bug, and the reason
it is not simply "support snippets" is that doing so through CodeMirror's
`snippet()` interacts with its own completion lifecycle and deserves its own
design.

## 8. Failure paths

Each is a test.

| Failure | Behaviour |
|---|---|
| No server for this language | Source returns null. No picker, no error. |
| Server not yet initialized | Treated as no server; the request is not queued. |
| Request rejects or times out | Source returns null; the 10s transport timeout applies. |
| Request outlives its keystroke | `context.aborted` is checked after the await; result dropped. |
| `isIncomplete: true` | Applied without `validFor`, so the next character re-queries. |
| `completionItem/resolve` fails | Item shows without documentation. |
| Item has an unknown kind | Rendered as `variable` rather than untyped. |
| Item is a snippet | Placeholders stripped to their default text. |
| Empty result list | An empty picker rather than a stale one. |

## 9. Testing

**Pure, against no server:** every kind 1–25; `textEdit` beating `insertText`
beating `label`; `sortText` and `filterText` passthrough; snippet stripping;
an unknown kind; an empty list.

**The source, against a fake session:** fires on a trigger character; does not
fire on an idle keystroke; drops an aborted result; returns null with no
server and with a rejecting server; omits `validFor` when `isIncomplete`.

**Against the real server:** extend `tests/lsp-integration.test.ts` — request
completion after `console.` in a real TypeScript file and assert `log` is
among the results with a plausible kind. That is the test that would have
caught the diagnostics-version assumption, and the equivalent assumption here
is that tsserver returns anything useful for a bare member access.

**Not testable here:** the picker itself. As with the squiggle, the rendering
needs a real build and a human. Stated so it is not mistaken for covered.

## 10. Files

New: `src/core/lsp-completion.ts`, `src/editor/completion.ts`, and tests
alongside each.

Changed: `src/services/lsp/index.ts` (the request door),
`src/editor/extensions.ts` (the `autocompletion` extension),
`tests/lsp-integration.test.ts`, `ROADMAP.md`, `CHANGELOG.md`, `WORKLOG.md`.

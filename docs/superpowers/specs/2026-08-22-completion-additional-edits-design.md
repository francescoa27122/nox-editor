# Auto-imports on completion — design

Accepting `readFileSync` from the completion list inserted `readFileSync` and
nothing else. The `import` the server had already computed was dropped on the
floor.

Status: approved 2026-08-22.

Everything below was read out of `src/editor/completion.ts`,
`src/core/lsp-completion.ts` and the installed `@codemirror/autocomplete`
rather than remembered.

## 1. The defect

`additionalTextEdits` is how the protocol says "and also make these other
changes" — an import at the top of the file, a `use` line, a `#include`. It is
the mechanism behind auto-import in every editor that has one.

`LspCompletionItem` has no such field (`src/core/lsp-completion.ts:13-25`), so
`toCodeMirrorCompletions` cannot see it and `apply` is only ever the
replacement string. Accepting an auto-import completion therefore inserts a
symbol that is not in scope — code that does not compile, produced by the
feature whose whole job is to write code that does.

It is **silent wrong output**, not a missing feature: the completion appears
to work.

`completionItem/resolve` is already wired (`src/editor/completion.ts:104-116`)
and already discards everything but the documentation:

```ts
const resolved = await deps.lsp.requestFor(…, 'completionItem/resolve', item);
const documentation = documentationOf(resolved);
```

That matters, because tsserver — the server most Nox users will point at —
sends `additionalTextEdits` **only** on resolve. The list carries `data` and
nothing else.

## 2. Two shapes, and only one of them can be atomic

Servers split into two camps and both have to work:

| | Who | When the edits are known |
|---|---|---|
| **In the list** | rust-analyzer, gopls, many others | Before the user accepts |
| **On resolve only** | tsserver, pyright | After the user accepts, or after the tooltip resolved the item |

The first can be applied in the **same transaction** as the completion: one
change set, one ⌘Z, no window in which the symbol exists without its import.

The second cannot, without making Enter wait on a round trip.

## 3. The typing path decides the shape

`CONTRIBUTING.md:65-69` is the rule and format-on-save is the precedent:
*"the save always happens… a late answer is dropped, a keystroke during the
request wins"* (`app.ts:1247-1276`).

So: **the completion is inserted synchronously, always.** Accepting a
completion never gets slower than it is today, whatever the server is doing.
The import follows in a second transaction when it has to.

Concretely, `apply` becomes a function:

1. **Insert the completion** via `insertCompletionText`, the same helper
   CodeMirror's own string `apply` uses — so the transaction carries
   `userEvent: "input.complete"` and the `pickedCompletion` annotation exactly
   as before.
2. **If the edits are already known** — from the list, or from a resolve the
   tooltip already did (§4) — they go in **that same transaction**.
3. **Otherwise**, if the server advertises `resolveProvider`, a bounded
   `completionItem/resolve` runs and its edits are applied in a second
   transaction.

## 4. The tooltip has usually already resolved it

`info` is already a lazy resolve, and CodeMirror calls it when an item is
highlighted — which for a keyboard user is *before* they press Enter, and for
tsserver items is always, because they carry no documentation in the list.

So the resolved item is cached per option, and `apply` reads the cache first.
In the common path the resolve has already happened and case 2 applies: one
transaction, one undo, no window. Case 3 is the fallback for accepting an item
whose tooltip never opened.

This is not an optimisation bolted on; it is the reason the asynchronous path
is rare enough to be acceptable.

## 5. Offsets: request-time coordinates, and the prefix guard

`additionalTextEdits` ranges are relative to the document **the completion was
requested against**. By the time the user accepts, that document has moved: the
list is filtered locally while they keep typing (`validFor: /^[\w$]*$/`), so no
new request is made and the offsets go stale by however many characters were
typed at the cursor.

Every one of those characters is *after* an import at the top of the file, so
offsets before the cursor still mean what they said. The protocol also
requires `additionalTextEdits` not to overlap the main edit's range.

That is exactly the property to check, so it is checked rather than assumed:

> the current document and the request-time document must agree on
> `[0, max(to))` — everything up to the last position the edits touch.

A prefix compare, cheap for a top-of-file import. If it fails, the edits are
**dropped rather than applied at a guessed position**. Dropping them is the
same call `undoLastReplace` and rename make: when the world has moved, refuse
rather than guess.

The conversion itself reuses `changesOf` from `core/lsp-text-edit.ts`, which
rename and formatting already share — one reading of `TextEdit`, one
conversion, already clamping a range past the end of the document.

## 6. What this is not

- **Not snippet support.** `insertTextFormat: 2` is still reduced to its
  default text by `stripSnippet`. Unchanged.
- **Not honouring the item's own `textEdit` range.** `toCodeMirrorCompletions`
  computes `from`/`to` from the server's `textEdit` and *nothing reads them* —
  the source inserts at the list-level `from` instead
  (`completion.ts:127`). A real gap, a different one, and it needs its own
  answer for a range that has gone stale. Recorded in the debt table rather
  than smuggled in here.
- **Not `command`.** An item may carry a `Command` to run after insertion.
  Nox does not run it, and running arbitrary server-named commands is a
  permission question, not a completion one.

## 7. Failure paths

| Case | Behaviour |
|---|---|
| No `additionalTextEdits` anywhere | Exactly today's behaviour, one transaction |
| Edits in the list | Same transaction as the completion |
| Edits on resolve, tooltip already opened | Same transaction — the cache hit |
| Edits on resolve, no tooltip | Completion lands now, import lands after the resolve |
| Resolve rejects or times out | Completion stands; no import; nothing thrown into the picker |
| Document moved under the offsets | Edits dropped, completion stands |
| Malformed edits from the server | `textEditsOf` drops anything not well-formed |
| Server has no `resolveProvider` | No resolve is attempted at all |

# Formatting — design

Format the document through the language server: on demand, and on save
when asked to.

Status: decided 2026-08-19. Everything named here was read in the file it
names before being written down.

## 1. What it is

Two things sharing one mechanism:

- **Format Document** (`lsp.formatDocument`, category Language,
  `Shift+Alt+F`): ask the server serving the active buffer for
  `textDocument/formatting` and apply the answer **now**, as one change set
  with the user as author — one undo takes it back. Not through the review
  panel: a format is not a proposal, it is the same text arranged the way
  the project already agreed on, and a review you click through on every
  save is a review nobody reads.
- **Format on Save** (`files.formatOnSave`, default **off**): the same
  request, made by `NoxApp.save` just before the write, bounded in time, so
  the bytes that reach the disk are the formatted ones and a slow or absent
  server never costs a save.

The roadmap row says "through LSP or a configured external command". This
is the LSP half. The external-command half — `prettier --stdin-filepath`
and friends, for languages whose server does not format or that have no
server — is a separate row, because it wants a process-spawning seam and a
per-language table in `servers.json`'s style, and neither should be
invented inside a save path. Stated here so it is a decision, not a gap.

## 2. The request

`textDocument/formatting` with `{ textDocument, options: { tabSize,
insertSpaces } }`, the options read from `editor.tabSize` and
`editor.insertSpaces` — the editor's own indentation, so a formatter and a
keystroke agree. The answer is `TextEdit[] | null`.

## 3. The response, reduced and applied

`src/core/lsp-text-edit.ts` — the `TextEdit` reading rename already does,
moved out so both use one:

```ts
export interface TextEdit { range: LspRange; newText: string }
export function textEditsOf(value: unknown): TextEdit[]   // malformed entries dropped
export function changesOf(text: string, edits: readonly TextEdit[]): { from: number; to: number; insert: string }[]
```

`changesOf` converts with `offsetAt` against the text the edits are for and
clamps an inverted range (`to ≥ from`). `offsetAt` already clamps a position
past the end of the text to the end, so an edit a server aims beyond the
document becomes an append rather than an offset `ChangeSet.of` would throw
on — a first draft had a separate "drop past-the-end" branch, which that
clamp made unreachable. The app then
`workspace.apply({ description: 'Format <name>', author: { kind: 'user' },
edits: [{ bufferId, changes }], baseRevisions })`. `apply` refuses
overlapping edits and a moved buffer; both are reported, never forced.

`NoxApp.formatBuffer(id, { timeoutMs? }): Promise<FormatOutcome>` where the
outcome is one of `formatted | unchanged | unavailable | stale | failed |
timeout`. It is the one function both the command and the save path call:

1. No buffer, no path, or no running server with
   `documentFormattingProvider` for the language → `unavailable`.
2. `revision = workspace.revisionOf(id)`; request. With `timeoutMs`, the
   request is raced against a timer **here, before anything is applied**:
   past the bound → `timeout`, and the server's eventual answer is never
   applied because nothing awaits it any more. (A first version raced the
   whole call from the save path and checked a flag afterwards; the edit
   had already landed by the time the flag was read, and the test for a
   late answer caught it.) On rejection → `failed` (the message is kept for
   the caller).
3. `textEditsOf(response)` empty → `unchanged`.
4. `changesOf(workspace.textOf(id), edits)`; `workspace.apply` with
   `baseRevisions = { id → revision }`. Stale → `stale`; invalid → `failed`;
   ok → `formatted`.

The command reports `failed` as an error with the server's message and
`unavailable` as info; `unchanged`, `formatted` and `stale` say nothing —
the document shows the result, and a stale format during a keystroke is
not worth a toast.

## 4. On save

In `NoxApp.save`, after the external-modification check and before
`workspace.save`:

- Only when `files.formatOnSave` is on **and** `files.autoSave` is not
  `afterDelay`. A format that fires on every pause in typing rewrites the
  text under the cursor; that is the rule every editor with both settings
  has arrived at, and Nox arrives at it the same way.
- `formatBuffer(id, { timeoutMs: 2000 })`. Past the bound, the save goes
  ahead with the text as it is and a warning says *Saved without formatting
  — the language server did not answer in time*; the late answer is never
  applied (§3 step 2), because landing it after the write would leave a
  just-saved file dirty with an edit the user did not see coming.
- `failed` → the save goes ahead, and the warning carries the server's
  message. `stale` → the save goes ahead with what the user typed, no
  message: they were typing; the keystroke wins. `unavailable` and
  `unchanged` → the save goes ahead, silently.

**The save always happens.** The format is a courtesy on the way to the
disk, and nothing about it may turn Save into a thing that sometimes does
not save. Written here because it is the one property of this feature
worth a test that tries to break it.

`saveAs` formats the same way when the buffer already has a path (Save As
of an existing file); an untitled buffer has no document the server knows,
so `formatBuffer` reports `unavailable` and the save goes ahead. `saveAll`
inherits it through `save`. The `trimTrailingWhitespace` and
`insertFinalNewline` options `workspace.save` already applies run after,
on the formatted text, and are no-ops when the formatter agreed.

## 5. Settings and key

`files.formatOnSave` — `bool(false)`, category Files: *Format on Save* —
"Ask the language server to format the file just before each save. Needs a
server that offers formatting; skipped when Auto Save is After Delay."

`Shift+Alt+F` for the command: the convention, and unclaimed.

## 6. What is tested, and how

- `tests/lsp-text-edit.test.ts` (node): `textEditsOf` shapes;
  `changesOf` — offsets, inverted range, an edit at exactly the end kept
  (appending is how a formatter adds the final newline), an edit aimed past
  the end becoming an append.
- `tests/lsp-format.test.ts` (jsdom): the harness of the other LSP command
  suites. Command: disabled without a provider; the request's options come
  from the config; edits land and one undo reverts them; `null` changes
  nothing; a server error is reported. Save: with the setting on, the
  request precedes the write and the disk holds the formatted text; off, no
  request; on with autosave `afterDelay`, no request; a server that never
  answers → saved unformatted within the bound, warned, and a late answer
  changes nothing; a keystroke during the request → saved as typed, not
  formatted. Mutation-checked before shipping.
- `tests/lsp-integration.test.ts`: the real `typescript-language-server`
  advertises `documentFormattingProvider` and its edits, applied the way the
  app applies them, turn `const  x=1` / `let   y = 2` into `const x = 1` /
  `let y = 2` (tsserver spaces; it does not add semicolons).
- `tests/support/fake-lsp-process.ts` learns to await a handler that
  returns a promise, which is what makes "never answers" and "answers late"
  stageable.

## 7. Not in this

- External formatter commands (§1).
- Range formatting (`textDocument/rangeFormatting`) and on-type formatting.
- A per-language switch for format on save. One setting; a project that
  wants it for TypeScript and not Markdown will get it when workspace
  settings (v0.6) exist to hold that.

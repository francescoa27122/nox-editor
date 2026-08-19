# Rename symbol — design

Rename a symbol everywhere the language server says it appears, with every
edit shown before any of it is written.

Status: decided 2026-08-19. Everything named here was read in the file it
names before being written down.

## 1. What it is

A command, **Rename Symbol** (`lsp.renameSymbol`, category Language, `F2`),
that asks for a new name, asks the server for `textDocument/rename`, and
stages the resulting `WorkspaceEdit` as **one change set in the review
panel** — the hunk-by-hunk review M6 built and project replace and agent
proposals already go through. Accepting applies it as one transaction, which
means one ⌘Z takes the whole rename back, across every file, and a file
edited during review is refused rather than overwritten. Nothing is written
until the user says so.

This is the promise the roadmap row made ("project-wide, via LSP") plus the
one the review panel makes for every programmatic edit: **seen before
written**. A rename that lands blind in twelve files is the kind of edit
that makes someone stop trusting an editor; a rename that shows its twelve
diffs first is the kind that makes them trust it more.

## 2. The two requests

### `textDocument/prepareRename` (when offered)

If the server's `renameProvider` is an object with `prepareProvider: true`,
ask first. The answer is one of: `Range`, `{ range, placeholder }`,
`{ defaultBehavior: true }`, or `null`. `null` means "not a thing that can be
renamed here" — a keyword, whitespace, a symbol from a library — and the
command says so (`notifications.info('Nothing to rename here')`) instead of
opening a prompt that can only fail. A `placeholder` seeds the prompt; a
`range` seeds it with the document text it names; `defaultBehavior` and a
server without prepare seed it with the word at the cursor.

### `textDocument/rename`

`{ textDocument, position, newName }`. The response is a `WorkspaceEdit` or
`null`. A rejection (the usual reason: the server refuses the new name)
becomes `notifications.error('Rename failed', message)` — the message is the
server's, because it is the one that knows why.

## 3. The response, reduced

`src/core/lsp-rename.ts`, pure:

```ts
export interface FileEdits { uri: string; edits: { range: LspRange; newText: string }[] }
export interface RenamePlan { files: FileEdits[]; unsupported: string[] }
export function prepareRenameSeed(response: unknown, fallback: string, textAt: (range: LspRange) => string): string | null
export function renameEdits(response: unknown): RenamePlan
```

A `WorkspaceEdit` carries its edits in one of two places — `changes`
(`{ [uri]: TextEdit[] }`) or `documentChanges` (`TextDocumentEdit[]`,
possibly interleaved with `CreateFile` / `RenameFile` / `DeleteFile`). Both
are read; when both are present `documentChanges` wins, as the
specification says. Edits for one URI from several entries are merged.
Malformed entries are dropped, not thrown on. Resource operations are
**not performed**: their kinds are listed in `unsupported`, the command
refuses the whole rename and says what it would have needed to do, because
a rename that moves the file's text and leaves the file where it was is a
half-rename nobody asked for. (tsserver sends none for a symbol rename; a
file-rename refactor is a different command.)

`renameEdits` does not convert positions. That needs each file's text, and
the app has it only after opening the file.

## 4. The staging

In `app.ts`, `#renameSymbol()`:

1. View + snapshot; `position` at the main cursor; `subject = wordAt(view)`.
2. If the server offers prepare, request it; `null` → say so and stop.
3. `ui.askForText({ title: 'Rename Symbol', label: 'New name',
   initialValue: seed, confirmLabel: 'Rename', validate })` — empty or
   unchanged is refused by `validate`. Cancel → stop, nothing said.
4. Request `rename`. `renameEdits` — `unsupported` non-empty → refuse with
   the list; no files → `'Nothing to rename'`.
5. For each file: `uriToPath`; `workspace.open(path)` — a file already open
   keeps its buffer and its unsaved edits; a file that was not open opens
   as a tab (that is where it will be reviewed and, after apply, saved
   from). A file that cannot be opened (`null`) is reported and **the whole
   rename stops** before anything is staged: a rename applied to eleven of
   twelve files is the half-rename again.
6. With every file open, convert each edit to `{ from, to, insert }` with
   `offsetAt(text, …)` against the buffer's *current* text and
   `review.stage({ description, author: { kind: 'user' }, edits })` with the
   description "Rename old → new". No `baseRevisions` of its own: `stage` records each
   buffer's revision at that moment and `apply` refuses a buffer that has
   moved since — the guard is the review's, and a first version that passed
   its own was found, by mutation, to be passing nothing. Then
   `workspace.setActive` back to the file the command was run from, because
   opening activates and the review panel is what the user looks at next.
   The staged set shows in the review panel because `app.ts` already binds
   `review.staged` to `ui.reviewOpen`. `stage` returning `null` (the edit
   would change nothing) → say so.

Ordering matters between 5 and 6: the positions the server sent are against
the text it was sent, which for an open buffer is the buffer (document sync
sends whole documents) and for a closed file is the disk. Opening reads the
disk, so after step 5 every buffer's text is what the server saw —
*unless* the user types in the meantime, which the review's revision guard
turns into a refusal at apply time rather than a wrong edit.

Accepting is `review.apply` (⌘⏎ in the panel, or the command). Applied
buffers are left **dirty**, as every other reviewed change set is: the
review panel's contract is "nothing is written until you apply", and "and
then we also saved" would be a second contract this command has no business
adding. **Save All** (`file.saveAll`) is one command away, and the
notification after apply says how many files changed. Written down here so
nobody later "fixes" rename to save by itself without deciding that for
every reviewed edit.

## 5. Capability and key

`enabled`: an active buffer with a path and `capabilitiesFor(languageId)?.
renameProvider` truthy (boolean or object). `F2` in the default keymap — the
convention in every editor, and nothing in Nox claims it.

## 6. What is tested, and how

- `tests/lsp-rename.test.ts` (node): `renameEdits` on `null`, on `changes`,
  on `documentChanges`, on both (documentChanges wins), on a malformed
  entry, on a resource operation (listed, edits still returned);
  `prepareRenameSeed` on the four shapes.
- `tests/lsp-rename-symbol.test.ts` (jsdom): the harness of
  `tests/lsp-find-references.test.ts` — real pane, real app, fake server.
  Cases: disabled without a provider; prepare `null` stops before the
  prompt; the prompt is seeded from the placeholder, from the range, from
  the word; cancel sends no rename; the rename request carries `newName`;
  a `changes`-shaped edit over an open and a closed file stages one set
  with both files, the closed one now open, hunks showing the new name;
  `review.apply` lands both in one change set and one undo reverts both;
  a resource operation refuses; an unopenable file refuses and stages
  nothing; a server error is reported. Mutation-checked before shipping.
- `tests/lsp-integration.test.ts`: the real `typescript-language-server`
  renames `answer` to `result` — `prepareRename` returns the range of the
  identifier, `rename` returns a `WorkspaceEdit` with `changes` (or
  `documentChanges` — whichever it sends is asserted) naming both
  occurrences.

## 7. Not in this

- Saving after apply. See §4.
- Resource operations (create/rename/delete file) from a `WorkspaceEdit`.
- Rename from the explorer (that is `files.rename`, a different thing with
  the same word).
- `workspace/applyEdit` from the server — a server-initiated edit is a
  different trust conversation; this command is user-initiated.

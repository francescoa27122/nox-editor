# Find references — design

List every place a symbol is used, through the language server, and go to
any of them. The list is the picker go to definition has been waiting for.

Status: decided 2026-08-19. Everything named here was read in the file it
names before being written down.

## 1. What it is

A command, **Find References** (`lsp.findReferences`, category Language,
`Shift+F12`), that asks the server serving the active buffer's language for
`textDocument/references` at the main cursor and shows the answer as a list
in the sidebar — a **References** view beside Problems, one row per file and
one row per location, each location row showing the line it is on. Clicking
or pressing Enter on a row lands there through `NoxApp.revealLocation`, the
door go to definition opened and made public for exactly this.

The same request door as definition, hover and completion:
`LspService.requestFor`. Nothing new on the wire.

## 2. The response, reduced

`textDocument/references` returns `Location[] | null` — never links. That is
a subset of what `definitionTargets` already reads, so
`src/core/lsp-references.ts` exports `referenceTargets(response)` as a named
reading of the same normaliser: malformed entries dropped, negative
positions refused, duplicates removed. One normaliser, two names, because
the day one of them needs to differ the call sites already say which they
are.

The request carries `context: { includeDeclaration: true }`. A list of uses
that omits the declaration makes the reader go to definition separately to
find it; including it costs one row.

## 3. The list, built

`locationRows(locations, texts, root)` in the same file, pure:

```ts
export interface LocationRow {
  kind: 'file' | 'location';
  label: string;      // file row: path relative to root (or absolute); location row: the line's text, trimmed
  path: string;
  line: number;       // one-based; 0 on a file row
  column: number;     // one-based; 0 on a file row
  count: number;      // file row: how many locations; 0 otherwise
  location: LspLocation | null;  // null on a file row
}
```

- Grouped by path, files sorted by label, locations within a file by
  position — `problemRows` in `src/ui/problems.ts` is the model, and the
  component copies `ProblemsPanel`'s rows/focused keyboard shape for the
  reason that file gives.
- A URI that is not a file is dropped; `revealLocation` could not open it.
- `texts` is `ReadonlyMap<path, string>`; a path with no text gets an empty
  label rather than a missing row. The app assembles the map before calling:
  `workspace.textOf` for an open buffer, `platform.readTextFile` otherwise,
  a read failure becoming an empty string. Reading happens once, at request
  time — the panel is a snapshot of an answer, not a live view; the server's
  answer was already a snapshot.
- The line text is the *whole* line trimmed, not a window around the column.
  A sidebar row has the width of the sidebar; the file row above it carries
  the path, the number before it carries the line, and the text is there to
  recognise the use, not to read it.

## 4. State and the view

`NoxApp.locations: Signal<LocationList | null>` where

```ts
export interface LocationList { title: string; subject: string; rows: LocationRow[]; files: number; total: number }
```

`title` is "References" or "Definitions"; `subject` is the word at the
cursor (`state.wordAt(head)`), or `''` when there is none. One signal, not
one per command, because the view is one panel and the most recent answer
is the one the user asked for.

`NoxApp.showLocations(title, subject, locations)` fills it and calls
`ui.showView('references')` (after `config.set('workbench.showExplorer',
true)`, the trap `problems.focus` documents). `'references'` joins
`SidebarView`; `ReferencesPanel.svelte` joins the rail with the `search`
icon — a list of places something appears is what that icon already means
in the rail. A `references.focus` command, **Show References**, so the
panel reopens without re-asking the server.

The empty state says how to fill it. The header shows the title, the
subject, and "N in M files".

## 5. The commands

`lsp.findReferences`:

- `enabled`: an active buffer with a path, and
  `capabilitiesFor(languageId)?.referencesProvider` truthy.
- `run`: view + snapshot (return if either is missing); `requestFor(
  languageId, 'textDocument/references', { textDocument, position,
  context: { includeDeclaration: true } })`; a rejection →
  `notifications.error('Find references failed', message)`;
  `referenceTargets(response)` empty → `notifications.info('No references
  found')` and the list is left as it was; otherwise `showLocations(
  'References', subject, targets)`. The cursor does not move: a list of
  twenty places is a choice, and choosing for the user is what "went to the
  first" was apologising for.

`lsp.goToDefinition`, with several results: still reveals the first (the
common case is one, and a jump that sometimes does not jump is worse), and
now `showLocations('Definitions', subject, targets)` instead of the "went to
the first" notification. The notification is removed: the panel says how
many and which.

## 6. What is tested, and how

- `tests/lsp-references.test.ts` (node): `referenceTargets` on `null`, an
  array, a bad entry, a duplicate; `locationRows` grouping, ordering,
  relative labels, the line text, the missing text, the dropped non-file
  URI.
- `tests/lsp-find-references.test.ts` (jsdom): the harness of
  `tests/lsp-go-to-definition.test.ts` — real pane, real app, fake server —
  plus a real `ReferencesPanel` mounted over the same app. Cases: disabled
  without a provider; the request's method, uri, position and
  `includeDeclaration`; results fill the list, the view switches, the panel
  shows the file and location rows with line text; clicking a row lands the
  cursor in that file at that range; no results → notification and the list
  unchanged; a server error → error notification; go to definition with two
  results reveals the first and fills the list titled Definitions.
  Mutation-checked before shipping, each recorded in the docblock.
- `tests/lsp-integration.test.ts`: against the real
  `typescript-language-server`, references to a declared-and-used symbol
  come back as `Location[]` naming both, and `referenceTargets` reads them.

## 7. Not in this

- Rename symbol — it is the next row, and it wants its own confirmation
  shape (a preview of every edit), not this list.
- A peek widget in the editor. The sidebar list is the same information
  without a second scrolling surface inside the first.
- Highlighting the column within the line text. The row's number and the
  landing selection carry it.

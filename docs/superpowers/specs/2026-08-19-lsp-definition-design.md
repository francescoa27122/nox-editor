# Go to definition — design

Jump from a symbol to where it is defined, through the language server.

Status: decided 2026-08-19. Everything named here was read in the file it
names before being written down.

## 1. What it is

A command, **Go to Definition** (`lsp.goToDefinition`, category Language,
`F12`), that asks the server serving the active buffer's language for
`textDocument/definition` at the main cursor and moves the cursor there —
opening the target file first when it is a different one.

The hover session called this "the same door and needs no new rendering",
and that holds: the request goes through `LspService.requestFor`, which
completion and hover already use, and the jump goes through primitives that
already exist — `workspace.open(path)` and a selection dispatch on the pane's
view, the pair `ProblemsPanel` and the search panel's `onReveal` use.

## 2. The response, reduced

The LSP answer is one of four shapes: `Location`, `Location[]`,
`LocationLink[]`, or `null`. Nox does not advertise
`textDocument.definition.linkSupport`, so a conforming server sends the first
two — but a normaliser that reads all four costs one function and removes
one way to be wrong about a server.

`src/core/lsp-definition.ts`, pure, DOM-free:

```ts
export interface LspLocation { uri: string; range: LspRange }
export function definitionTargets(response: unknown): LspLocation[]
```

- A `Location` is `{ uri, range }`.
- A `LocationLink` is `{ targetUri, targetRange, targetSelectionRange? }`.
  The selection range is the identifier; the range is the whole declaration.
  Prefer `targetSelectionRange`, fall back to `targetRange` — landing on the
  name is what "go to definition" means.
- Anything without a string `uri`/`targetUri` and a well-formed range is
  dropped, not thrown on. A server that sends one bad entry among good ones
  should still take the user to the good ones.
- Duplicates by `(uri, start, end)` are removed. tsserver has been seen to
  repeat a location for an overloaded declaration.

Ranges are LSP positions (UTF-16 columns), converted with the existing
`offsetAt(text, position)` against the *target* buffer's text after it is
open — the same conversion diagnostics and hover use, so a non-BMP character
before the symbol cannot shift the landing.

## 3. The command

In `app.ts`, next to the other `lsp.*` commands:

- `enabled`: there is an active buffer with a path, and
  `lsp.capabilitiesFor(languageId)?.definitionProvider` is truthy. The
  palette therefore hides the command from a Markdown file and from a
  workspace with no server, rather than offering it and doing nothing.
- `run`:
  1. Read the pane's view (`this.view.get()`) and the active buffer's
     snapshot. Both are needed: the view for the cursor, the snapshot for
     `path` and `languageId`. If either is missing, return.
  2. `position = positionAt(view.state.doc.toString(), view.state.selection.main.head)`.
  3. `requestFor(languageId, 'textDocument/definition', { textDocument: { uri: pathToUri(path) }, position })`.
     A rejection (server not running, request error) becomes
     `notifications.error('Go to definition failed', message)`.
  4. `targets = definitionTargets(response)`. Empty →
     `notifications.info('No definition found')` and stop.
  5. `await this.revealLocation(targets[0])`.
  6. If `targets.length > 1`,
     `notifications.info(\`${targets.length} definitions — went to the first\`)`.
     One picker for many locations is a list UI, and *find references* needs
     the same list; it arrives with that feature and this command will grow
     to use it. Until then, honesty about what was skipped beats a wrong
     guess about which one was wanted.

`revealLocation({ uri, range })`, public on `NoxApp` because find references
will call it too:

1. `path = uriToPath(uri)`. A URI that is not a file (`untitled:`, a
   virtual scheme) throws in `uriToPath`; catch it and
   `notifications.info('Definition is not in a file Nox can open', uri)`.
2. If `path` is not the active buffer's path, `await workspace.open(path)`;
   a `null` result (unreadable, outside the workspace's reach) →
   `notifications.error('Could not open', path)` and stop.
3. Read `this.view.get()` **after** the open — the pane re-points the same
   view, so it is the same object, but its state is now the target's.
   `from = offsetAt(text, range.start)`, `to = offsetAt(text, range.end)`,
   clamped to the document; dispatch `{ selection: { anchor: from, head: to }, scrollIntoView: true }`
   and `view.focus()`. The identifier is selected, not merely pointed at —
   the shape every editor uses for this jump, and it makes the landing
   visible on a line the user has never seen.

The keybinding is `F12` in the default keymap beside `F3`. Nothing else
claims it, and it is what every other editor uses.

## 4. What is tested, and how

- `tests/lsp-definition.test.ts` (node): the four shapes, the
  `targetSelectionRange` preference, the dropped bad entry, the de-dup.
- `tests/lsp-go-to-definition.test.ts` (jsdom): the real `EditorPane` over a
  real `NoxApp` with a `FakeLanguageServer` advertising `definitionProvider`,
  through the harness `tests/lsp-rendering.test.ts` established. Cases:
  same-file jump (selection lands on the range); cross-file jump (the other
  file becomes active and the selection lands); no result (a notification,
  the cursor unmoved); many results (first taken, notification names the
  count); command disabled without a provider. Each mutation-checked: the
  cross-file test must fail when `revealLocation` stops opening the file,
  the same-file test when the selection dispatch is removed.
- `tests/lsp-integration.test.ts`: one case against the real
  `typescript-language-server` — definition of a use of `answer` resolves to
  its declaration's `uri` and `range`, and `definitionTargets` reads what it
  actually sends. The shape it sends is asserted, as the hover test asserts
  its `contents` shape: if it ever starts sending `LocationLink`, someone
  reads a failing test rather than a bug report.

## 5. Not in this

- A picker for multiple definitions (with find references).
- Go to type definition / implementation — same door, later rows.
- ⌘-click. It wants a hover-time underline and a pointer-position mapping
  the rendering suite cannot verify (see 2026-08-19-lsp-rendering-verification
  §2); a keybinding is enough to make the feature real.

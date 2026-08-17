# Sticky scroll — design

Keep the enclosing declaration on screen when you have scrolled past its
header, so you always know what you are inside.

Status: approved 2026-08-16. Implementation follows in a separate plan.

The second item taken from **v0.3 — Navigation at scale**, and the one the
go-to-symbol spec named as the beneficiary of `core/symbols.ts`: "It is also
the honest prerequisite for sticky scroll." That module has exactly one
consumer today; this is the second, and it is a reader rather than a new
source.

Everything below was checked against the installed CodeMirror, the existing
extensions and the settings schema rather than remembered.

## 1. Why this, and what it is not

Scroll into the body of a long method and the editor stops answering the
question it was answering a moment ago: *what is this code inside?* The
breadcrumb says which file. Nothing says which class, or which method.

It is not an outline, not a minimap, and not a second navigation surface.
⌘R already jumps to a symbol; this shows the one you are standing in without
being asked.

**What makes it affordable:** the symbol scan exists, is tested against real
parses for nine grammars, and already produces ranges. This adds a reader and
a strip of DOM.

## 2. Scope

In:

- `src/editor/sticky.ts` — the extension, mirroring `foldingExtension`.
- A pure function deciding which symbols pin, tested headlessly.
- A `showPanel` strip above the scroller.
- `editor.stickyScroll`, on by default.
- Clicking a row jumps to that declaration.

Out, and deliberately:

- **Control blocks.** `if`, `for` and `while` do not pin. The alternative was
  weighed: it would need a second definition of "structure" alongside
  `core/symbols.ts`'s, and the header gets deep fast in nested code. One
  definition, shared with ⌘R.
- **A floating overlay inside `.cm-scroller`.** That is the exact VS Code look
  and it costs real geometry work — positioning against `scrollTop`, keeping
  clear of the fold and provenance gutters, horizontal scroll, and keeping the
  covered lines clickable. §6 says why the panel is the better trade here.
- **A depth setting.** §7.
- **Sticky scroll in the browser target's minimap or elsewhere.** There is no
  minimap.

## 3. What already exists

Verified, not assumed.

| Seam | Where | What it gives us |
|---|---|---|
| The symbol scan | `src/core/symbols.ts:235` | `fileSymbols(tree, doc)` → `{ name, qualified, kind, from, to }[]` in document order |
| A one-slot cache | `src/core/symbols.ts:292` | `createSymbolCache()` keyed on tree *and* doc, so scrolling re-reads rather than re-walks |
| The extension pattern | `src/editor/folding.ts:71` | `foldingExtension(enabled: boolean): Extension`, returning `[]` when off |
| Settings → live reconfigure | `src/editor/extensions.ts:43-62` | A `Compartment` per feature and `SETTING_TO_COMPARTMENTS` mapping settings to them |
| Panels | `@codemirror/view` | `showPanel: Facet<PanelConstructor \| null>`; `Panel` is `{ dom, mount?, update? }` |
| Viewport geometry | `@codemirror/view` | `lineBlockAtHeight(height)`, `documentTop`, `scrollDOM`, and `update.viewportMoved` |
| A settings precedent | `src/services/config/schema.ts` | `editor.codeFolding` is the same shape this needs |

## 4. What pins, and the rule that is easy to get wrong

A symbol pins when **it contains the first visible line** and **its own
declaration is above that line**.

The second half is the whole of it. If `class Foo {` is still on screen,
pinning a copy of it is a duplicated line and a stolen row of editor height.
The rule is *strictly above*, not *contains*, and nothing about the feature
looks wrong until you scroll to exactly the boundary.

Rows render outermost first, so the strip reads down into the code the way the
code is nested.

**A row shows the declaration's own source line**, trimmed of leading
whitespace and indented by depth — not the qualified name. `Foo.bar` is right
for a searchable list; `async reveal(path: string): Promise<void> {` is what
the reader was looking at thirty lines ago and is trying to recover.

## 5. The pure core

The decision is a pure function of four inputs, and lives where it can be
tested:

```ts
export interface StickyRow {
  /** The declaration's source line, trimmed. */
  text: string;
  /** Nesting depth, 0 for the outermost. */
  depth: number;
  /** Where clicking the row jumps to. */
  from: number;
}

export function stickyRows(
  symbols: readonly FileSymbol[],
  topLine: number,
  doc: Text,
  max: number,
): StickyRow[];
```

This is the third time this repo has moved a decision out of a place it could
not be tested — `symbolListState` came out of `CommandPalette` and
`answerFreshness` out of `AnswersPanel`, both for the same reason. The
precedent is established and it is what makes this feature testable at all.

Whether it belongs in `core/symbols.ts` or in `editor/sticky.ts` is settled by
one question: does it touch CodeMirror? `Text` is `@codemirror/state`, which
`core/symbols.ts` already imports. It goes beside `symbolListState`.

## 6. The panel

`showPanel` with `{ top: true }`, constructed once and updated in place.

**The two paragraphs this replaces were wrong, and "checked against the
installed CodeMirror" at the top of this document was not true of either
claim in them** — both were worked out from the API surface, not from reading
CodeMirror's own measure/update machinery, and both broke Task 2's first
implementation in ways only running the editor surfaced.

**The top visible line is a layout read, and it has to happen in a measure
phase.** `view.lineBlockAtHeight(...)` calls into CodeMirror's
`readMeasured`, which throws when called outside one:

```js
readMeasured() {
    if (this.updateState == 2 /* UpdateState.Updating */)
        throw new Error("Reading the editor layout isn't allowed during an update");
```

The panel constructor runs from inside the `EditorView` constructor, and
`Panel.update` runs from inside `updatePlugins` — both are within that
window. Reading layout directly from either, as this section originally said
to, throws on every editor open; `PluginInstance` catches the throw, logs
"CodeMirror plugin crashed", and deactivates `panelPlugin` entirely, so no
panel container is ever built. The fix is `view.requestMeasure({ read,
write })`, called from the constructor, from `Panel.update`, and from the
scroll hook below — `read` runs in CodeMirror's own measure phase, where
`readMeasured` is permitted, and `write` then builds the DOM from what `read`
found.

**The height expression was also wrong**, independently of when it ran:
`view.scrollDOM.scrollTop - view.documentTop` double-counts the scroll
offset. `lineBlockAtHeight` wants a document-relative height, and
`scrollDOM.scrollTop` already is one — CodeMirror's own equivalent
(`scrollAnchorAt`) passes it straight through with no adjustment.
`documentTop` is a *screen* coordinate
(`contentDOM.getBoundingClientRect().top + paddingTop`), which goes more
negative as the document scrolls, so subtracting it does not cancel the
scroll offset, it adds a second copy of it. The correct read is
`view.lineBlockAtHeight(view.scrollDOM.scrollTop)`. The bug is invisible at
the top of a file, where the error is exactly zero, and grows toward double
the true depth as you scroll — a 100-line file scrolled to line 50 pinned
whatever enclosed roughly line 94, which is why it survived a glance at the
top of the file and nothing further.

**`update.docChanged` / `viewportMoved` / `geometryChanged` is the right set
of conditions, but not a sufficient trigger on its own.** Plain scrolling
usually produces no `ViewUpdate` at all: CodeMirror's `measure()` bails when
nothing changed, and it tolerates roughly 250px of scroll drift before
recomputing the viewport and setting `viewportMoved` — so relying on `update`
alone lags the true top line by up to ~13 lines of ordinary scrolling, for a
feature whose entire job is tracking that line. The fix composes with the
measure-phase fix above rather than replacing it:
`EditorView.domEventHandlers({ scroll(event, view) { view.requestMeasure(...) } })`
hooks the scroller's native `scroll` event directly, and a `requestMeasure`
request scheduled from there runs regardless of whether an update would have
justified it — so the panel's `update` still guards against unnecessary work
on unrelated transactions, and the scroll hook is what actually keeps the
strip current while scrolling.

**Why a panel rather than an overlay.** CodeMirror positions and sizes panels
itself and accounts for them in its own layout, so the last line of the
document is never hidden behind the strip and there is no `scrollTop` maths to
get wrong. The overlay is the more familiar look; the panel is the one that
cannot be subtly mispositioned, and every pixel of geometry this design avoids
owning is geometry no test in this repo can check.

The trade, stated rather than discovered: the strip pushes content down
instead of floating over it, so it is not pixel-for-pixel VS Code.

**Nothing to pin renders nothing.** The panel stays mounted — `showPanel`
closes a panel only when its constructor stops being provided, which would
mean reconfiguring on every scroll — so instead its DOM is emptied and the
element takes no height. A file with no structure, a language with no parser,
and an unparsed region all reach this same state, and none of them should cost
a row of editor height.

## 7. Depth is a constant

Five rows, in `sticky.ts`, not a setting.

With declarations only, real depth is three: class → method → nested function.
A preference for a limit nobody reaches is a preference to maintain, document
and migrate forever. If someone hits five, that is a bug report with a real
file attached, which is a better basis for a setting than a guess now.

## 8. The setting

`editor.stickyScroll`, boolean, default true, beside `editor.codeFolding`.

The `editor.` prefix is mechanical, not cosmetic: `settingsAffectingEditor`
returns true for that prefix, and `SETTING_TO_COMPARTMENTS` maps it to a new
`sticky` compartment, so toggling it reconfigures the live view through
machinery that already exists. `stickyScrollExtension(false)` returns `[]`,
exactly as `foldingExtension` does.

## 9. Clicking a row

Selects the declaration's start and scrolls it into view. A header you cannot
click is a label; ⌘R already proves people want to jump to these things.

The row is a `<button>`. That matters beyond semantics — Tauri's drag regions
treat clickable elements as drag-blockers, and the editor is not inside one
today, but a `<div>` with a click handler would be the kind of thing that
works until the layout moves.

## 10. Testing

- `stickyRows` against real parses, headless: a method inside a class pins
  both; a symbol whose declaration is still visible does **not** pin; a
  position inside nothing pins nothing; the cap truncates from the innermost,
  keeping the outermost context; rows come back outermost-first.
- The "declaration still visible" boundary gets its own case at exactly the
  line where it flips, because that is the rule with no second signal.
- A file with no symbols, and one whose language has no parser, both yield an
  empty list rather than throwing.

**The panel gets no automated coverage**, and that is `ARCHITECTURE.md` §7's
row rather than an oversight: it reads `scrollTop` and line geometry, and jsdom
has neither. It is verified by walking the app — scroll a long file, watch the
header change at the boundary, click a row, toggle the setting.

That boundary has already produced one real defect this cycle: the dev server
broke on a config line that every test passed through, because tests run with
`VITEST` set and nothing in CI opens the browser target. Sticky scroll sits
further inside that gap than anything built so far.

## 11. What is not yet measured

**The per-scroll cost.** `createSymbolCache` amortises the *walk*, since
scrolling does not change the tree, but filtering every symbol for containment
on every scroll is O(symbols) per frame. On a file with a few thousand symbols
that may be irrelevant or may be visible; a sorted array and a binary search
would remove it, and would be premature before a measurement says so.

This is a measurement to take during implementation, against a real large
file — not a number to guess here. The go-to-symbol work guessed once and
sized a test from a wall-clock assumption: the comment claimed ~40 chars/ms
and a margin of 60×, and the measurement came back at ~2,437 chars/ms and a
margin of 3.5× (`tests/symbols.test.ts:429-432`). The test had to be rewritten
to derive its size from a rate measured on the machine running it.

## 12. Files

New:

- `src/editor/sticky.ts`
- `tests/sticky.test.ts`

Changed:

- `src/core/symbols.ts` — `stickyRows` and `StickyRow`
- `src/editor/extensions.ts` — the `sticky` compartment and its setting mapping
- `src/services/config/schema.ts` — `editor.stickyScroll`
- `README.md`, `CHANGELOG.md`, `ROADMAP.md`, `ARCHITECTURE.md` §4

Not changed:

- `src/ui/EditorPane.svelte`. The feature is an extension; the component
  already passes `buildExtensions(settings)` and needs to learn nothing.

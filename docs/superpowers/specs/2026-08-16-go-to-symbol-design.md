# Go to Symbol — design

A fourth mode on the command palette: type `@` and jump to a function, class
or heading in the file you are looking at.

Status: approved 2026-08-16. Implementation follows in a separate plan.

The first item taken from **v0.3 — Navigation at scale**, which has been
untouched apart from the terminal that shipped early. It is also the honest
prerequisite for sticky scroll, and the place v0.4's LSP will later swap its
source without changing the surface.

Everything below was checked against the installed parsers and the existing
palette rather than remembered.

## 1. Why this, and what it is not

Nox can open any file in the project in two keystrokes and jump to any line
number, but nothing gets you to a *named thing*. In a 600-line file the only
route to `packRow` is search, which finds every call site as well as the
definition.

It is not an outline panel, not a project-wide symbol index, and not a
dependency on a language server. It is a palette mode over a parse Nox already
has, for the file you are already in.

**What makes it affordable:** the grammar is already loaded and already
parsed, because folding depends on it. This adds a reader, not a source.

## 2. Scope

In:

- A `@` mode on the command palette, listing the symbols in the active file.
- `core/symbols.ts`: a pure scan from a `Tree` to a list of symbols.
- A command, **Go to Symbol in File…**, on <kbd>Mod R</kbd>.

Out, and deliberately:

- **Project-wide symbols.** The roadmap specifies a per-file scan; searching
  every file for a symbol wants the index a language server maintains, and
  building a worse one first is work thrown away at v0.4.
- **An outline panel.** A fifth sidebar section for something you use for two
  seconds is the wrong shape, and the palette already switches modes on a
  prefix without reopening.
- **Symbols for languages with no parser.** Folding settled this: "indentation
  guessed folds are wrong often enough to be worse than none". The same is
  true of regex-guessed symbols, and more so — a wrong fold wastes a
  keystroke, a wrong symbol sends you to the wrong line.
- **Variables, constants and imports.** §5 gives the reasoning.
- **Following the cursor** to preselect the symbol you are inside. Worth
  having, not worth guessing at before the list exists.

## 3. What already exists

Verified, not assumed. This is the reason the feature is small.

| Seam | Where | What it gives us |
|---|---|---|
| Prefix modes | `CommandPalette.svelte:44-53` | `>`, `~` and `:` switch mode from the query without reopening. `@` is unused — checked across `src/`. |
| The row shape | `CommandPalette.svelte` `Row` | `{ key, title, positions, detail, icon, accept, disabled }`, already used by four modes |
| Fuzzy matching | `core/fuzzy.ts` | Runs over `title` and returns the `positions` the palette highlights |
| Empty-state precedent | `lineRows`, `CommandPalette.svelte:275-285` | A `disabled` hint row rather than an empty list |
| A parsed tree | `editor/folding.ts` | Folding already depends on the grammar being loaded and parsed |
| Headless parse testing | `foldRangesAtLevel` | A pure function tested against a real parse with no DOM |

## 4. What counts as a symbol

Structure only: the things you navigate *to*. Not variables, not constants,
not imports.

A jump list you scroll is a jump list that failed. A file exporting thirty
constants would bury its own functions, and fuzzy matching stops
discriminating once everything is in the list.

The node names below were read out of the installed parsers
(`parser.nodeSet.types`), not guessed:

| Grammar | Nodes collected | Name taken from |
|---|---|---|
| JS / TS / JSX / TSX | `FunctionDeclaration`, `ClassDeclaration`, `MethodDeclaration`, `InterfaceDeclaration`, `TypeAliasDeclaration`, `EnumDeclaration`, `NamespaceDeclaration` | `VariableDefinition`, `PropertyName` or `TypeDefinition` child |
| Python | `FunctionDefinition`, `ClassDefinition` | the name child |
| Rust | `FunctionItem`, `ModItem` | `BoundIdentifier` |
| Rust | `StructItem`, `EnumItem`, `TraitItem`, `ImplItem`, `TypeItem` | `TypeIdentifier` |
| CSS / SCSS | `RuleSet` | the text from the node's start to its `Block` child |
| Markdown | `ATXHeading1`–`6`, `SetextHeading1`–`2` | the heading's text |

**JSON and HTML collect nothing.** JSON has no declarations. HTML's only
structural node is `Element`, so its outline would be every `<div>` in the
file — the parse-tree outline this design exists to avoid.

## 5. One table, not one per language

The rules live in a single map from Lezer node name to `{ kind, name }`, with
no dispatch on the file's language.

That works because the grammar authors chose names that do not collide:
`FunctionDeclaration`, `FunctionDefinition` and `FunctionItem` are three
different strings for the same idea in three grammars.

The decisive argument is **mixed-language files**, and it is not hypothetical:
`@codemirror/lang-html` configures the HTML grammar to nest the CSS and
JavaScript ones, so a single `.html` tree contains `RuleSet` *and*
`FunctionDeclaration` nodes. Checked, because bare `@lezer/html` does **not**
nest — it yields `StyleText` and raw script text — and the difference decides
whether this argument holds at all.

Rules keyed by the file's language would look up "html", find the rules for a
grammar that deliberately collects nothing, and miss every symbol in the
`<script>` and `<style>` blocks. A shared name table has nothing to get wrong:
it matches whatever node it meets, whichever grammar produced it.

Svelte and Vue would be the sharper example and are deliberately not cited:
`core/languages.ts` registers them for detection, but no parser ships for
either, so they have no tree to walk.

The cost is that two grammars using one name for different things would have
to agree. None of the five above does, and the table is one file to change if
that ever stops being true.

## 6. Qualified names

A symbol's title is its path by tree containment: `PackRow.render`, not
`render`.

Fuzzy matching runs over the title, so this is what lets you type `packrender`
*or* `render` and find the method. With the bare name, a file with four
classes each having a `render` gives four identical rows and no way to
separate them.

**Markdown headings come back flat, and need no special case to.** They nest
by *level*, not by containment: an `ATXHeading1` node covers only its own
line, so `# Title` and `## Subtitle` are siblings of the document rather than
parent and child. The generic containment walk therefore yields them
unqualified already — the stack is empty again before the next heading is
entered.

This corrects an earlier version of this section, which drew the opposite
conclusion from the same fact and specified a `flat` flag to exempt them. The
flag was written, and then found to be unreachable: forcing it off against a
real parse produced byte-identical output. Deriving a hierarchy from the level
numbers would be a second, different algorithm, and is still not wanted — but
nothing has to be done to *avoid* one.

## 7. The palette mode

`@` selects it, the same way `~` and `:` already select theirs, and it is
listed in the prefix hints at the foot of the palette beside them.

Each row: `title` is the qualified name, `detail` is the kind, and the icon is
`dot` for every symbol. Accepting scrolls to the symbol and puts the cursor at
its start, through `app.goToLine`, which already does both.

**One icon, not one per kind.** `IconName` has 27 members and none of them
draws a function, a class or a heading. Adding three would mean new paths in a
visual system that has a document of its own, for information the row already
carries one word away in `detail`.

**No viewport preview as you arrow through.** Go-to-line established the
convention: it puts the line's *text* in the row rather than moving the
editor behind the palette, and moving the view under an overlay the user is
about to dismiss is disorienting.

### The chord

<kbd>Mod R</kbd>, which opens the palette with `@` already in it.

**Not <kbd>Mod ⇧ O</kbd>**, the chord VS Code uses and the obvious first
choice: it is already `file.openFolder` here. Checked rather than assumed,
and it is the reason this section exists.

<kbd>Mod R</kbd> is Sublime Text's chord for exactly this feature, it is free
(along with every other `Mod+Shift+` letter outside A, E, F, G, K, L, N, O, P,
S and Z), and a single-modifier chord suits something reached as often as
quick-open.

**The empty case is a hint row, not an empty list**, following `lineRows`.
Three different states, three different sentences, because they call for
different actions:

| State | The row says |
|---|---|
| Parser ships, file has no symbols | No functions or classes in this file |
| No parser for this language | Nox has no parser for *Ruby* |
| No file open | Open a file to list its symbols |

## 8. Where the code lives

`core/symbols.ts`, pure: given a `Tree` and a `Text`, return
`{ name, qualified, kind, from, to }[]` in document order. No view layer, no
`EditorView`, so it is tested headlessly against a real parse exactly as
`foldRangesAtLevel` is.

One walk, keeping a stack of enclosing symbol names for the qualified path —
the same shape `foldRangesAtLevel` already uses to get depth without
re-walking per line.

## 9. Large files, and the thing that is not yet measured

`syntaxTree(state)` returns only what CodeMirror has parsed so far, which on a
large file can stop partway through the document. A symbol list that silently
ends at the parse frontier would be worse than one that says so: it looks
complete.

`ensureSyntaxTree(state, doc.length, timeout)` forces more parsing with a
deadline and returns `null` if it cannot finish. So: ask for the whole
document with a budget, and when the budget runs out, list what was parsed
**and say the file is still parsing** in a hint row.

**Not yet measured:** the file size at which this bites on this codebase, and
what the budget should be. That is a measurement to take during
implementation, against a real large file, not a number to guess here.

## 10. Testing

- `core/symbols.ts` against real parses, headless, one case per grammar in §4:
  a nested method's qualified name, a Rust `impl` block, a CSS rule set, a
  Markdown heading list, and a JSON file yielding nothing.
- Node types that are *not* symbols stay out: a variable declaration, an
  import, a call to a function of the same name as a declaration.
- Mixed-language: an HTML document parsed through `@codemirror/lang-html`
  yields its `<script>`'s functions *and* its `<style>`'s rule sets from one
  tree. This is §5's whole argument, and it would regress silently under a
  per-language table — HTML's own rules collect nothing, so the file would
  come back empty.
- The three empty states in §7 produce the three different sentences.
- `@` switches mode from within an open palette, and `>`, `~`, `:` still do
  what they did.

The palette component itself has no automated coverage — this repo has no
Svelte component harness, which is the piece of work queued directly behind
this one. Until it exists, the mode's wiring is checked in the browser target
against the demo project.

## 11. Files

New:

- `src/core/symbols.ts`
- `tests/symbols.test.ts`

Changed:

- `src/ui/CommandPalette.svelte` — the `@` mode, its rows and its prefix hint
- `src/app.ts` — the command and its keybinding
- `README.md`, `CHANGELOG.md`, `ROADMAP.md`, `ARCHITECTURE.md` §4

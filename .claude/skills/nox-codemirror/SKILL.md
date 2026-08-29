---
name: nox-codemirror
description: Use when working on Nox's editor surface — adding or changing a CodeMirror extension, gutter, tooltip, decoration, fold, grammar, keybinding inside the editor, or a setting that reconfigures the editor; also when an editor test is flaky, a mark disappears when a setting is toggled, or undo history is lost after a preference change.
---

# Nox + CodeMirror 6

## Overview

CodeMirror *extensions* live in `src/editor/`. The layer rule is narrower than "all CodeMirror in one folder", and stating it loosely will mislead you:

- **`services/` and `core/` never import `@codemirror/view`.** That is the invariant that keeps them headless — verify with `grep -rn "from '@codemirror/view'" src/services src/core`, which returns nothing.
- They *do* use `@codemirror/state` and `@codemirror/commands` on purpose: `services/workspace.ts` owns an `EditorState` per buffer (that is what makes per-tab undo work) and `services/transactions.ts` defines an `Annotation`. Both are DOM-free, so Vitest still runs them under Node.
- `ui/EditorPane.svelte:2` value-imports `EditorView` because it owns the single view instance, and `app.ts:16` type-imports it to hold the reference. Neither is a violation; the rule is about `services/` and `core/`.

Nothing enforces this with a lint rule — it holds by review.

Composition happens in one place: `src/editor/extensions.ts#buildExtensions`. `WorkspaceService` receives it wrapped in a closure that discards the factory args (`app.ts:226-228`), so `buildExtensions` takes `Settings`, not `StateFactoryArgs`.

## Quick reference

| Task | Where | Note |
|---|---|---|
| Add a setting-driven extension | `extensions.ts` | Three edits — see below |
| Add an always-on extension | `extensions.ts#staticExtensions` | |
| Add an editor-only chord | `extensions.ts#editorKeymap` | App chords go in `services/keymap.ts` |
| Add a grammar | `editor/languages.ts#LOADERS` | Dynamic import, cached |
| Draw in the gutter | Copy `git-gutter.ts` or `provenance.ts` | `RangeSet` + `GutterMarker` |
| Draw diagnostics | `editor/lsp.ts` | Push via `setDiagnostics`, never `linter()` |

## The three invariants

### 1. Compartments, never state rebuilds

Every setting-driven extension sits in its own `Compartment` so a preference change is a targeted `reconfigure`. Rebuilding the `EditorState` discards undo history and scroll position — users notice immediately.

Adding one is exactly three edits in `extensions.ts`:

1. a key in `compartments`
2. an entry in `SETTING_TO_COMPARTMENTS` mapping the settings key to it
3. a `case` in `compartmentContent`

**Only edits 1 and 3 are compiler-checked.** `compartmentContent`'s switch has no `default:` and returns `Extension`, so a missing case fails with TS2366. But `SETTING_TO_COMPARTMENTS` is a `Partial<Record<…>>` (`extensions.ts:78`) — **omitting edit 2 compiles cleanly and silently produces a setting that never reconfigures anything.** That is the likeliest mistake and the one nothing will catch for you. Check it by hand.

### 2. A StateField must be unconditional; only its rendering is compartmentalised

**Removing a `StateField` destroys the state it holds.** A compartment reconfigured to `[]` removes its extensions — so gating a field on a setting throws away every mark the moment the user toggles it off.

The pattern (`extensions.ts:224-230`): the field goes in `staticExtensions()` unconditionally, and only the gutter/tooltip that renders it goes in the compartment. `provenanceField` and `gitGutterField` both do this. Copy it.

### 3. StateField vs ViewPlugin is a question about derivability

- **Derivable from document + inputs → `ViewPlugin`.** Search highlighting (`search-highlight.ts`): given the query and the doc you can always recompute matches.
- **Not recoverable once it happens → `StateField`.** Provenance (`provenance.ts:17-24`): nothing in the document remembers who made a change, so it must be recorded as it happens and mapped forward. A `StateField` also accumulates in background buffers, because the workspace updates their state whether or not a view exists.

## Keymap ownership

Exactly one layer claims any given chord, so there is never a race over `preventDefault`:

- `editor/extensions.ts#editorKeymap` — text editing (`Mod-d`, multi-cursor, `Tab`)
- `services/keymap.ts` — application chords (open, save, palette)

Order inside `keymap.of([...])` *is* the mechanism. `Tab` runs `acceptCompletion` first, which returns `false` when no picker is open, so `indentWithTab` below it runs instead. No mode flag. Don't "tidy" that ordering.

## Grammars

`editor/languages.ts` loads parsers by dynamic import and caches them. Buffers are created with **no grammar** and get one reconfigured in a moment later — a 400 KB parser must never sit between the click and the text appearing. `loadLanguage` returns `null` for unknown languages; those files still open, just unhighlighted. Check with `hasGrammar` before promising highlighting.

## Testing editor code

**The parse-snapshot trap.** `EditorState.create` runs the initial parse on a ~20 ms budget *and* caps it at the first ~3000 characters, so the tree stops short on any file over ~3 KB — not just on a loaded machine. `ensureSyntaxTree` finishes the parse but only in the shared `ParseContext` — `syntaxTree(state)`, which `foldable()` reads, keeps returning the stale snapshot until a transaction makes the language field re-snapshot it. **Both steps are required:**

```ts
const tree = ensureSyntaxTree(state, state.doc.length, 10_000);
if (tree === null) throw new Error('syntax tree did not finish parsing within 10s');
return state.update({}).state;   // forces the re-snapshot — do not omit
```

`tests/folding.test.ts:36-48` is the reference; that suite failed under CPU contention with only the first step.

**jsdom has no layout.** Components embedding CodeMirror are tested for wiring and text, not geometry. `tests/support/jsdom-layout.ts` fills `Range.getClientRects` with a single all-zero rectangle — enough for CodeMirror to *run*, not enough to claim anything about placement. A test must not assert where a tooltip sits or which symbol was under the pointer.

Prefer pure, view-free functions so they can be tested against a real parse headlessly — `foldRangesAtLevel` is written that way on purpose.

## Common mistakes

| Mistake | What happens |
|---|---|
| Gating a `StateField` on a setting | Toggling the setting wipes accumulated state |
| Rebuilding `EditorState` on a settings change | Undo history and scroll position lost |
| `linter()` for diagnostics | Polls on a timer; servers push. Use `setDiagnostics` |
| Trusting a server's diagnostic range | CodeMirror throws out of range. Clamp and widen — `editor/lsp.ts#toCodeMirrorDiagnostics` |
| Importing `@codemirror/view` in `services/` or `core/` | Those layers must stay headless; nothing lints it, so review is the only guard |
| `syntaxTree(state)` right after `ensureSyntaxTree` | Stale snapshot, flaky test |

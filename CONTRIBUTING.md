# Contributing to Nox

## Setup

```bash
npm install
npm run dev      # browser target — instant HMR, in-memory workspace
npm run app      # desktop target — real window, real disk
```

Use `npm run dev` for UI work. It needs no Rust toolchain and no rebuild loop,
and it runs the *same code* as the desktop build with a different `Platform`.

Before pushing:

```bash
npm test
npm run check
npm run lint
```

`npm run lint` is a linter and not a formatter: it has no opinion about
whitespace or quote style, and it is what enforces rules 1 and 2 below rather
than leaving them to a reviewer. Warnings are advisory; errors block CI.

---

## The five rules

These are not style preferences. Each one keeps a specific kind of mess out of
the codebase.

### 1. Logic lives in services, never in components

A Svelte component renders state and forwards input. If you are writing an
`if` about *what should happen*, it belongs in a service. Components import
services through `useApp()`; they never construct them.

*Why:* it keeps the framework swappable, and it makes the logic testable in
Node in milliseconds instead of in a browser in seconds.

### 2. Only `platform/` touches the OS

Nothing in `ui/`, `services/` or `core/` may import `@tauri-apps/*` or touch
`window.localStorage` directly. If you need a new OS capability, add a method
to the `Platform` interface and implement it in **both** `tauri.ts` and
`memory.ts`.

*Why:* it is what lets the app run in a browser, lets every service be tested
without mocks, and confines Tauri API churn to one file.

### 3. Every user action is a command

Register it in `app.ts#registerCommands` with a category and keywords. Do not
wire a button straight to a service method — give it a command id and dispatch
that.

*Why:* the palette, the shortcut reference and future keybinding customisation
all come from the command table. A feature that skips this is a feature that
is invisible to all three, forever.

### 4. Every preference goes in the schema

Add it to `services/config/schema.ts`. Never hardcode a default in a component
or read a magic number inline.

*Why:* the `Settings` type, the persisted-file validator and the whole Settings
UI are derived from that one object.

### 5. Nothing new on the typing path

Before adding work that runs per keystroke, per scroll or per cursor move, ask
what it costs on a 10 MB file. Prefer viewport-bounded work
(`view.visibleRanges`), debouncing, or doing it in Rust.

---

## Adding a feature

1. Model it in a service; expose state as a `Signal`.
2. Register a command.
3. Bind a key if it deserves one.
4. Add a setting if it is configurable.
5. Write tests against `MemoryPlatform`.
6. *Then* build the component.

If a step needs an exception, the feature is probably in the wrong layer.

### Adding a language

One entry in `core/languages.ts` (identity) and, if a Lezer grammar exists, one
loader in `editor/languages.ts`. Add the package to `dependencies`; Vite chunks
grammars separately, so it costs nothing until a file of that type is opened.

### Adding a theme

Add the name to the `workbench.theme` enum in `config/schema.ts` and a
`[data-nox-theme='…']` block in `styles/tokens.css` overriding only what
differs. See `Umbra` for the pattern, and [DESIGN.md](DESIGN.md) §9.

---

## Testing

Vitest, `tests/` mirroring `src/`. Node with no DOM is the default; a suite
opts into one with `// @vitest-environment jsdom` on its first line.

**What to test:** file operations, document state, dirty tracking, undo
boundaries, search, configuration coercion and persistence, command
dispatch, keybinding resolution, path handling, fuzzy ranking. For a
component: rendered behaviour and branch selection — that the newest answer
renders first is ordering, not markup, and is fair game.

**What not to test:** component markup, CSS, or anything whose test would just
restate the implementation. Coverage percentage is not a goal — behaviour that
would break someone's work is. A test asserting a `font-weight` is still
worthless, in a component suite exactly as it was everywhere else.

Component suites are named after the component and grouped by component, not
split per behaviour: one jsdom file costs roughly half a second of environment
setup, against a suite that otherwise runs in about a second total, so a new
file is worth it when it tests a different component — or when it covers a
distinct, named concern over the same one, which costs a second jsdom
environment, a quarter to half a second. `tests/lsp-paint-target.test.ts` and
`tests/lsp-rendering.test.ts` both mount `EditorPane` on that footing: one is
a named regression, the other the LSP surfaces. Mount through
`mountComponent` in `tests/support/component.ts`, which puts a real app in
context the way `App.svelte` does; see its doc comment for what it does and
does not support.

Two habits worth keeping:

- Test against `MemoryPlatform`, not a mock. It is a real implementation, so a
  passing test means the behaviour works rather than that a stub was configured
  correctly.
- When you fix a bug, add the test that would have caught it, and say in a
  comment what it guards. `tests/session.test.ts` has an example — the
  save-before-restore race.

---

## Conventions

**TypeScript** — strict, including `noUncheckedIndexedAccess`. No `any`; use
`unknown` and narrow. Prefer `interface` for object shapes and `type` for
unions.

**Naming** — services are `XService`, commands are `category.verbNoun`
(`file.saveAs`, `view.toggleExplorer`), tokens are `--nox-*`.

**Comments** — explain *why*, never *what*. A comment restating the code is
noise; a comment recording a constraint, a trade-off or a non-obvious ordering
is the most valuable thing in the file. If you take a shortcut, say so and add
it to the Known debt table in [ARCHITECTURE.md](ARCHITECTURE.md).

**CSS** — component-scoped, tokens only, no utility classes, no `!important`
(the one exception is documented where it appears).

**Accessibility** — every interactive element is keyboard-reachable and
labelled. Overlays trap focus and are dismissible with <kbd>Esc</kbd>. If you
need to silence an a11y lint, write down why in the ignore comment.

**Commits** — imperative and specific. `Fix session overwrite on boot` rather
than `fix bug`.

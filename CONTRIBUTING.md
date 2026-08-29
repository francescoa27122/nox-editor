# Contributing to Nox

## Setup

```bash
npm install
npm run dev      # browser target: instant HMR, in-memory workspace
npm run app      # desktop target: real window, real disk
```

Use `npm run dev` for UI work. It needs no Rust toolchain and no rebuild loop,
and it runs the *same code* as the desktop build with a different `Platform`.

Before pushing:

```bash
npm test
npm run check
npm run lint
```

`npm run lint` is a linter and not a formatter. It has no opinion about
whitespace or quote style, and it is what enforces rules 1 and 2 below rather
than leaving them to a reviewer. Warnings are advisory. Errors block CI.

**Do not run prettier.** There is no prettier config in this repo, so it
rewrites files to double quotes against house style. `eslint.config.js` says
so at the top. Single quotes, two-space indent and semicolons are matched by
hand.

---

## The five rules

These are not style preferences. Each one keeps a specific kind of mess out of
the codebase.

### 1. Logic lives in services, never in components

A Svelte component renders state and forwards input. If you are writing an
`if` about *what should happen*, it belongs in a service. Components import
services through `useApp()`. They never construct them.

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
wire a button straight to a service method. Give it a command id and dispatch
that.

*Why:* the palette, the shortcut reference and keybinding customisation all
come from the command table. A feature that skips this is a feature that is
invisible to all three, forever.

### 4. Every preference goes in the schema

Add it to `services/config/schema.ts`. Never hardcode a default in a component
or read a magic number inline.

*Why:* the `Settings` type, the persisted-file validator and the whole Settings
UI are derived from that one object.

### 5. Nothing new on the typing path

Before adding work that runs per keystroke, per scroll or per cursor move, ask
what it costs on a 10 MB file. Prefer viewport-bounded work
(`view.visibleRanges`), debouncing, or doing it in Rust.

Three things help you answer that rather than guess. `npm run bench` reports
durations for the pure layers against a 16 ms frame. Read it. Nothing gates on
it. `tests/complexity.test.ts` *does* gate: it measures how each function's
cost grows with its input and fails if the exponent moves, which is the one
performance property a shared CI runner can check honestly. If you add a
function to a hot path, add it there too.

And `npm run test:editor` gates **this rule specifically**. It drives a real
`EditorView` in chromium and asserts a keystroke costs the same in a
16,000-line document as in a 2,000-line one. Flat is what viewport-bounded
work looks like, and a document-wide scan is what it is not. A keystroke
currently costs **0.34 ms** at 16,000 lines and does not move at 64,000. It
cannot run under jsdom, which measures everything as zero. That is why it is a
browser project rather than another file in `tests/`.

That project reaches further than its name suggests, and it is worth knowing.
It is a real browser with real layout, so anything *drawn* can be checked there
too. `tests/browser/blame-gutter.test.ts` uses it for geometry the blame gutter
depends on and jsdom cannot see, and writes screenshots of a passing run into
the gitignored `__screenshots__/` for a person to open. If you build something
whose correctness is partly visual, that is where it goes.

---

## Adding a feature

1. Model it in a service. Expose state as a `Signal`.
2. Register a command.
3. Bind a key if it deserves one.
4. Add a setting if it is configurable.
5. Write tests against `MemoryPlatform`.
6. *Then* build the component.
7. Give it a story if it has a state that is awkward to reach by hand.

If a step needs an exception, the feature is probably in the wrong layer.

### Adding a language

One entry in `core/languages.ts` (identity) and, if a Lezer grammar exists, one
loader in `editor/languages.ts`. Add the package to `dependencies`. Vite chunks
grammars separately, so it costs nothing until a file of that type is opened.

### Adding a theme

Add the name to the `workbench.theme` enum in `config/schema.ts` and a
`[data-nox-theme='…']` block in `styles/tokens.css` overriding only what
differs. See `Umbra` for the pattern, and [DESIGN.md](DESIGN.md) §9.

---

## Testing

Vitest, `tests/` mirroring `src/`. Node with no DOM is the default. A suite
opts into one with `// @vitest-environment jsdom` on its first line.

**What to test:** file operations, document state, dirty tracking, undo
boundaries, search, configuration coercion and persistence, command dispatch,
keybinding resolution, path handling, fuzzy ranking. For a component: rendered
behaviour and branch selection. That the newest answer renders first is
ordering, not markup, and is fair game.

**What not to test:** component markup, CSS, or anything whose test would just
restate the implementation. Coverage percentage is not a goal. Behaviour that
would break someone's work is. A test asserting a `font-weight` is still
worthless, in a component suite exactly as it was everywhere else.

The two stylesheet suites are not an exception to that.
`tests/token-contrast.test.ts` measures the contrast ratios `tokens.css`
argues in prose, and `tests/component-css-tokens.test.ts` fails on a colour
literal anywhere in `src/ui`. Neither asserts what a component looks like.
Both fail on something that otherwise only holds while someone keeps noticing
it.

Component suites are named after the component and grouped by component, not
split per behaviour. One jsdom file costs roughly half a second of environment
setup, against a suite that otherwise runs in about a second total, so a new
file is worth it when it tests a different component, or when it covers a
distinct, named concern over the same one, which costs a second jsdom
environment at a quarter to half a second. `tests/lsp-paint-target.test.ts` and
`tests/lsp-rendering.test.ts` both mount `EditorPane` on that footing: one is a
named regression, the other the LSP surfaces. Mount through `mountComponent` in
`tests/support/component.ts`, which puts a real app in context the way
`App.svelte` does. See its doc comment for what it does and does not support.

Three habits worth keeping:

- Test against `MemoryPlatform`, not a mock. It is a real implementation, so a
  passing test means the behaviour works rather than that a stub was configured
  correctly.
- **Make the fake produce the shape the real thing produces**, not a
  convenient one. `MemoryPlatform.gitBlame` renders real `--porcelain` output,
  asymmetries and all, because a tidier shape would let a parser that
  mishandles the real one pass the whole suite. `seedGitConflict` carries the
  same warning from the time it did not.
- When you fix a bug, add the test that would have caught it, and say in a
  comment what it guards. `tests/session.test.ts` has an example: the
  save-before-restore race.

**Say what a test does not catch.** Several suites here record the mutation
they were checked against, and a few record one they turned out *not* to
catch. Both are worth more than the assertion on its own. A guard nobody has
probed is a guard nobody knows the reach of.

---

## Conventions

**TypeScript.** Strict, including `noUncheckedIndexedAccess`. No `any`. Use
`unknown` and narrow. Prefer `interface` for object shapes and `type` for
unions.

**Naming.** Services are `XService`, commands are `category.verbNoun`
(`file.saveAs`, `view.toggleExplorer`), tokens are `--nox-*`.

**Comments.** Explain *why*, never *what*. A comment restating the code is
noise. A comment recording a constraint, a trade-off or a non-obvious ordering
is the most valuable thing in the file. If you take a shortcut, say so and add
it to the Known debt table in [ARCHITECTURE.md](ARCHITECTURE.md).

**CSS.** Component-scoped, tokens only, no utility classes, no `!important`
(the one exception is documented where it appears).

**Accessibility.** Every interactive element is keyboard-reachable and
labelled. Overlays trap focus and are dismissible with <kbd>Esc</kbd>. If you
need to silence an a11y lint, write down why in the ignore comment.

**Commits.** Imperative and specific. `Fix session overwrite on boot` rather
than `fix bug`.

---

## Cutting a release

A tag is a promise, and `release.yml`'s gate refuses one it does not believe
in. But a gate can only check what is machine-readable. This is the rest, and
it exists because the version files once agreed with each other and with the
tag while the README still said *"Not there yet: plugins"* and undercounted the
suite by two hundred.

**What the gate already refuses**, so you do not need to check it by hand:

- `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`
  disagreeing with each other or with the tag.
- A `CHANGELOG.md` with no `## [<version>]` section, or an empty one. That
  section *is* the release body.
- A README whose Status section still opens with the previous series
  (`scripts/readme-series.mjs`). This is a proxy. It cannot read the prose, it
  can only make sure you opened the paragraph the prose is in.

**What only you can do:**

1. **Rewrite README §Status, all of it.** Move anything under "Landed since X
   and not in a release yet" into the history above it, and re-read the "Not
   there yet:" line. That is the sentence that goes quietly false. The test
   count in the first paragraph is held to a floor by
   `tests/release-readme.test.ts`, not to the exact number. Raise both when it
   drifts far enough to look silly.
2. **Move `## [Unreleased]` to `## [<version>]`** and leave a fresh empty
   `Unreleased` above it. Write it for the person downloading the binary, not
   for the person who wrote the commit.
3. **Check ROADMAP.md's shipped tables say which release each row landed in.**
   The milestones and the releases have never lined up and the file says so.
   What makes that survivable is each row naming its own release.
4. **Run the desktop walk** for anything the browser target cannot exercise.
   See the `nox-desktop-walk` skill. The 1.0 bar says no release note may say
   "unverified", and the browser build cannot tell you about the terminal, the
   native dialogs, the title bar or a real repository.

Then bump the three version files in one commit, merge it, and tag.

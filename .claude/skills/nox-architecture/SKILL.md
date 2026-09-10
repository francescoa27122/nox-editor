---
name: nox-architecture
description: Use when adding or changing a feature in Nox outside the editor and Rust layers: a service, a Svelte component, a command, a keybinding, a setting, or anything touching the Platform boundary. Also when deciding which layer code belongs in, when a component needs state from a service, or when a test needs a fake filesystem.
---

# Writing code in Nox

## Read first, in this order

1. **`CONTRIBUTING.md:33-103`** (`## The five rules`), the five rules and the feature checklist. Non-negotiable, and this skill does not restate them.
2. **`ARCHITECTURE.md:45-191`** (`## 2. Layers`), the layer diagram and where everything lives.
3. **`ARCHITECTURE.md:195-2250`** (`## 4. Key design decisions`), the decision log. Before changing anything load-bearing, check whether the current shape is already argued for there. It usually is.

Sibling skills own their own domains. Defer to them rather than duplicating: **`nox-codemirror`** for `src/editor/`, **`nox-lsp`** for `services/lsp/`, **`nox-tauri-ipc`** for anything crossing into `src-tauri/`.

This skill is the *idioms*: how the code is actually written once you know which layer it goes in.

## The order that matters

Service → `Signal` → command → keybinding → setting → tests → **then** the component. If a step needs an exception, the feature is probably in the wrong layer.

Rule 5 of the five is the easiest to forget: **nothing new on the typing path.** Before adding per-keystroke, per-scroll or per-cursor work, ask what it costs on a 10 MB file; prefer `view.visibleRanges`, debouncing, or pushing it to Rust.

## Signals

`core/signal.ts` is 84 lines with zero imports: `get`, `set`, `update`, `touch`, `subscribe`. `set` no-ops when `equals` says unchanged; `update` always emits (use it for mutable structures); `touch` announces an in-place mutation.

Services expose state as public readonly fields:

```ts
readonly buffers = new Signal<BufferSnapshot[]>([]);
```

**In a component, bind the signal to a local `const` first, then use the `$` prefix.** That prefix only works on a plain identifier, so the two-step is unavoidable, and it is the most repeated pattern in the codebase. `const app = useApp();` (`src/ui/StatusBar.svelte:10-15`) binds four signals and reads one back through `$derived`:

```svelte
const app = useApp();
const { workspace, config, lsp } = app;
const buffers = workspace.buffers;          // bind…
const active = $derived($buffers.find((b) => b.id === $activeId) ?? null);   // …then read
```

**`derived()` in `core/signal.ts` is dead code.** Nothing in `src/` or `tests/` imports it. Derive with `$derived` / `$derived.by` in components, or with a plain method on the service (`review.acceptedCount()`). Don't reach for the helper.

`core/emitter.ts` is the other primitive, for fire-and-forget events rather than state. One consumer: `readonly events = new Emitter<WorkspaceEvents>()` (`src/services/workspace.ts:408`).

## Svelte 5

`runes: true` (`svelte.config.js:6`) turns legacy mode off at the compiler level. In use: `$state`, `$derived`, `$derived.by`, `$effect`, `$props`. Never used anywhere in `src/`: `svelte/store`, `writable`, `export let`, `createEventDispatcher`, `on:click`, `<slot>`, `$:`, all verified at zero occurrences.

Callbacks are props (`onSelect: (id: string) => void`), children are `Snippet`s rendered with `{@render}`, and props get a named interface:

```svelte
interface Props {
  title: string;
  summary?: string;
  actions?: Snippet;
}
let { title, summary, actions }: Props = $props();
```

**The focus-request pattern.** Services expose a counter signal bumped to request focus (nine of them on `UIService`). The component subscribes to the counter but deliberately *not* to the element ref, as `let messageEl = $state<HTMLTextAreaElement | null>(null)` (`src/ui/GitPanel.svelte:25-32`) does:

```svelte
let messageEl = $state<HTMLTextAreaElement | null>(null);
$effect(() => {
  void $focusRequest;
  untrack(() => messageEl)?.focus();
});
```

`svelte-ignore state_referenced_locally` is legitimate when reading a never-reassigned singleton eagerly, but write the reason above it, as `src/ui/App.svelte:20-25` (`is a singleton created once at bootstrap`) does. Same for every `a11y_*` ignore.

## Commands

Every user action is a command, and **`capabilities` is the whole basis of permission enforcement.** A command with a side effect that omits it is a hole. Enforcement happens in exactly one place, the guard installed at `src/app.ts:274-283` (`this.commands.setGuard(`), and the user principal skips it.

Since 2026-09-03 that guard **refuses** any command declaring nothing to a plugin or an agent, so an omission costs an agent workflow rather than an unlogged write. It is still an omission: the user is exempt, so a missing declaration is still wrong, and a new command that genuinely needs no capability must join the pinned groups in `tests/command-capabilities.test.ts` or that suite fails.

Register in the one array in `#registerCommands` (`src/app.ts:2961`): `const commands: Command[] = [` (`src/app.ts:2965-4774`), under its banner comment:

```ts
{
  id: 'file.save',                                   // category.verbNoun
  resourceFrom: () => this.workspace.activeSnapshot()?.path ?? undefined,
  capabilities: ['fs.write'],
  title: 'Save',
  category: 'File',
  enabled: bufferEnabled,
  run: () => this.save(),
},
```

Use `keyHint: 'Mod+Z'` when CodeMirror owns the chord rather than `services/keymap.ts`. `register` throws on a duplicate id: `Duplicate command id:` (`src/services/commands.ts:126`). `execute` is async: `async execute(` (`src/services/commands.ts:193`), so call it as `void commands.execute('…')`.

`enabled` gates on **service state, not a platform capability flag**, wherever a service owns the capability: `() => this.git.started`, `() => this.updates.started`. The service only starts where the capability holds, and jsdom tests start it directly over `MemoryPlatform`, where a `platform.capabilities.*` gate reads false and the command becomes untestable. This repo learned it twice, on the LSP commands and then on `git.showDiff`. The exception is a capability with no service behind it: exactly three commands read `platform.capabilities` directly (`applicationMenu`, and `nativeDialogs` twice), because there is nothing else to ask.

Keybindings go in the `bindAll` table in `#registerKeybindings`: `this.keymap.bindAll({` (`src/app.ts:5191`). Only three bindings sit outside it, and each earns it: platform-conditional (`Ctrl+G`/`Alt+G`), argument-carrying (`nav.goToTab` with `{ arg: index }`), and `when`-guarded (`Escape`).

## Settings

One entry in `config/schema.ts` and the Settings panel, persistence, coercion and reset all follow. No per-preference UI is ever hand-written.

```ts
'workbench.explorerWidth': num(248, { min: 150, max: 520 }, {
  label: 'Explorer Width',
  description: 'Width of the sidebar in pixels.',
  category: 'Workbench',
  advanced: true,
}),
```

Use the `bool` / `num` / `str` / `pick` factories, never a descriptor literal.

The schema closes with `} as const satisfies Record<string, SettingDescriptor>` (`src/services/config/schema.ts:334`), and **both halves are load-bearing**: `as const` keeps literal defaults so `Settings` gets `'eclipse' | 'umbra'` instead of `string`, and `satisfies` validates without widening.

Two caveats to "one entry":

- A setting in a **new category** needs three edits. `SettingCategory` is a closed union at `src/services/config/schema.ts:11` (`export type SettingCategory`), and `src/ui/SettingsPanel.svelte:89` (`const CATEGORIES: SettingCategory[]`) hardcodes the same list again as a value.
- `workspace: true` is a deliberate **allowlist**, not a default. `src/services/config/schema.ts:22-30` (`An **allowlist**, not a denylist`) sets the bar: never a fact about the person reading it, and never anything naming a program, a path or an address.

Three layers: schema defaults < user `settings.json` < workspace `.nox/settings.json`. Writes always go to the user layer. `coerce` falls back to the default on a type mismatch, because a corrupt settings file must never stop the editor starting.

## Imports and aliases

`@core`, `@platform`, `@services`, `@editor`, `@ui`, declared at `vite.config.ts:34-40` (`alias: {`) and `tsconfig.json:19-25` (`"paths": {`), and they agree.

Reality: `@ui` is configured but **never used**. Components import siblings relatively, and `src/app.ts` sits outside every alias root so it is reached as `'../app'`. Within a directory, relative imports are the norm. **Tests use no aliases at all**: `'../src/…'` throughout, with zero exceptions.

Do not touch the conditions spread at `vite.config.ts:33` (`conditions: ['browser']`); the comment above it records that the obvious rewrite broke `npm run dev`.

## Tests

`MemoryPlatform` is the fixture, not a mock. It is the same code path the browser build uses, so a pass means the behaviour works rather than that a stub was configured correctly. Seed with `seedFile`, `seedGitRepo`, `seedGitBase`, `seedGitBlame`. Simulate outside changes with `externalWrite` / `externalRemove` / `externalRename`.

Node with no DOM is the default. A suite opts in with `// @vitest-environment jsdom` on its **first line**, mounts via `tests/support/component.ts#mountComponent`, and must `unmount()` in `afterEach`. It never runs on its own, which `tests/support/component.ts:25-28` (`is the caller's responsibility`) says in as many words.

```ts
let mounted: Mounted | null = null;
afterEach(() => { mounted?.unmount(); mounted = null; });
```

Assert signals with `.get()` in Node suites; the `$` prefix only exists inside components.

**When you fix a bug, add the test that would have caught it and say in a comment what it guards.** Several suites go further and record which edit to the implementation made the test go red. `tests/ui-primitives.test.ts:16-18` (`Mutation-checked on 2026-08-19`) is the pattern.

Do not test markup, CSS, or anything whose assertion would restate the implementation. Coverage percentage is not a goal.

## Verifying

```bash
npm test && npm run check
```

Both are mandatory before pushing. CI additionally runs `npm run build`, which catches bundler-level breaks that neither tests nor `svelte-check` see. Rust is a separate job: see `nox-tauri-ipc`.

## Comments

The house style is **why, never what**. A comment restating the code is noise. One recording a constraint, a trade-off or a non-obvious ordering is the most valuable thing in the file. Match the density of the file you are editing; this codebase comments heavily and in full sentences.

**If you take a shortcut, say so and add it to the Known debt table at `ARCHITECTURE.md:2826` (`## 7. Known debt`).**

## Common mistakes

| Mistake | Why it's wrong |
|---|---|
| Logic in a component | If you're writing an `if` about *what should happen*, it belongs in a service |
| Wiring a button to a service method | Give it a command id and dispatch that |
| A side-effecting command with no `capabilities` | Unenforceable for the user, refused outright to an agent: the declaration *is* the enforcement |
| Reading a signal without binding it to a local const | The `$` prefix only works on a plain identifier |
| Reaching for `derived()` from `core/signal.ts` | Dead code; use `$derived` or a service method |
| A hardcoded default in a component | Every preference goes in the schema |
| `@tauri-apps/*`, or `window.localStorage`, outside `platform/` | Breaks the browser build and every headless test |
| A new `Platform` method with no `memory.ts` fake | Same |
| Using `any` | Repo is strict with `noUncheckedIndexedAccess`; use `unknown` and narrow |
| Aliases in a test file | Tests use `'../src/…'` |
| New work on the typing path | Rule 5. Measure it against a 10 MB file first |

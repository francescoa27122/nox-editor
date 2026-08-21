# Nox

A fast, dark, keyboard-first text editor. Tauri 2 (Rust) + Svelte 5 (runes) + CodeMirror 6 + Vite 8 + TypeScript strict. Tests are Vitest; the pure layers run headless in Node.

## Verify before claiming anything works

```bash
npm test && npm run check
```

Both are mandatory before pushing. CI also runs `npm run build` — it catches bundler-level breaks that neither tests nor `svelte-check` see, so run it before claiming a release-path change is good.

Rust: `cargo test --manifest-path src-tauri/Cargo.toml`. **`cargo` may not be installed on this machine.** If it isn't, write the tests, say plainly they are unrun locally, and let CI run them — do not report them as passing.

| Task | Command |
|---|---|
| Browser dev (no Rust rebuild) | `npm run dev` |
| Desktop dev | `npm run app` |
| Desktop build | `npm run app:build` |
| Tests, watch | `npm run test:watch` |

## Read before changing code

- **`CONTRIBUTING.md:23-82`** — the five rules and the feature checklist. Read these first; they are not style preferences.
- **`ARCHITECTURE.md:45-189`** — layers and where everything lives.
- **`ARCHITECTURE.md:190-1477`** — the decision log. Before changing anything load-bearing, check whether its current shape is already argued for. It usually is.
- **`ARCHITECTURE.md:1519`** — the Known debt table. If you take a shortcut, add it here.
- **`AGENT-PLATFORM.md`** — the agent runtime, permissions and context API.

## Skills

Five project skills cover the subsystems in depth. Use them rather than re-deriving:

| Skill | Covers |
|---|---|
| `nox-architecture` | Services, components, commands, settings, signals, tests |
| `nox-codemirror` | Anything in `src/editor/` |
| `nox-lsp` | `services/lsp/` and `core/lsp-*.ts` |
| `nox-tauri-ipc` | Anything crossing into `src-tauri/` |
| `nox-desktop-walk` | Verifying in the packaged app rather than the browser |

## The two rules everything else rests on

**1. `Platform` is the only door to the OS.** Nothing in `ui/`, `services/` or `core/` imports `@tauri-apps/*` **or touches `window.localStorage` directly**. That is what lets the whole app run in a browser against an in-memory filesystem, and every service be tested against a fake disk with no mocking library. A new OS capability means a method on the `Platform` interface implemented in `tauri.ts` **and** `memory.ts`. (`web.ts` extends `MemoryPlatform` and overrides only capabilities and localStorage persistence, so it usually needs no edit.)

**2. Every user action is a `Command`.** Menus, palette, keybindings and buttons all dispatch the same `commandId`, which is why the palette and keybinding customisation are complete for free. A feature is not done until it has a command. A command with a side effect must declare `capabilities` — that declaration is the entire basis of permission enforcement.

**And the one that is easiest to forget:** *nothing new on the typing path* (`CONTRIBUTING.md:65-69`). Before adding per-keystroke, per-scroll or per-cursor work, ask what it costs on a 10 MB file; prefer `view.visibleRanges`, debouncing, or pushing it to Rust.

**`services/` and `core/` never import `@codemirror/view`** — that is what keeps them runnable headless under Vitest. They do use `@codemirror/state` and `@codemirror/commands` deliberately: `services/workspace.ts` owns an `EditorState` per buffer, which is what makes per-tab undo work. CodeMirror *extensions* live in `src/editor/`; `ui/EditorPane.svelte` owns the one `EditorView` instance. Nothing lints this — it holds by review.

## House style

- **Comments explain *why*, never *what*.** A comment restating the code is noise; one recording a constraint, trade-off or non-obvious ordering is the most valuable thing in the file. This codebase comments heavily, in full sentences — match the file you are editing.
- Strict TypeScript with `noUncheckedIndexedAccess`. No `any` — use `unknown` and narrow.
- Naming: services are `XService`, commands are `category.verbNoun`, CSS tokens are `--nox-*`.
- CSS is component-scoped and token-only. No utility classes, no `!important`.
- Silencing an a11y lint requires the reason in the ignore comment.
- Commit messages are imperative and specific — `Fix session overwrite on boot`, not `fix bug`. No conventional-commits prefixes, no emoji.
- When you fix a bug, add the test that would have caught it and say in a comment what it guards.

## Gotchas

- **The version is triple-sourced.** `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` must agree or the release workflow refuses the tag (`.github/workflows/release.yml:28-54`).
- Do not touch the `conditions` spread at `vite.config.ts:28` — the comment above it records that the obvious rewrite broke `npm run dev`.
- Tests use relative `'../src/…'` imports, never the `@core`/`@services` aliases.

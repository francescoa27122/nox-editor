# Nox

A fast, dark, keyboard-first text editor. Tauri 2 (Rust) + Svelte 5 (runes) + CodeMirror 6 + Vite 8 + TypeScript strict. Tests are Vitest, and the pure layers run headless in Node.

## Verify before claiming anything works

```bash
npm test && npm run check && npm run lint
```

All three are mandatory before pushing. CI also runs `npm run build`, which catches bundler-level breaks that neither tests nor `svelte-check` see, so run it before claiming a release-path change is good.

`npm run bench` reports durations for the pure layers. Nothing gates on them. `tests/complexity.test.ts` is what actually holds those functions to their stated complexity in CI.

`npm run test:editor` is a real browser with real layout, and it covers two things. It holds the typing path flat in document size, which is the check behind `CONTRIBUTING.md` rule 5. It is also where a claim about **geometry** goes, because jsdom measures everything as zero: `tests/browser/blame-gutter.test.ts` holds a gutter column to one width and writes screenshots of a passing run into the gitignored `__screenshots__/`. If a change is partly visual, run it and look at them.

Rust: `cargo test --manifest-path src-tauri/Cargo.toml`.

**Check that cargo really is missing before saying so.** This file used to claim it "may not be installed", and that was wrong on both machines this project has been built on. On the Windows PC it is on PowerShell's PATH and not git-bash's, so five sessions in a row recorded it absent after checking only from Bash. In a fresh Linux container it is installed, but `cargo test` fails at `gdk-sys` with "the system library `gdk-3.0` was not found", which reads like a broken toolchain and is a missing apt package: `libgtk-3-dev libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev`. If it genuinely will not run, write the tests, say plainly they are unrun locally, and let CI run them. Do not report them as passing.

| Task | Command |
|---|---|
| Browser dev (no Rust rebuild) | `npm run dev` |
| Desktop dev | `npm run app` |
| Desktop build | `npm run app:build` |
| Tests, watch | `npm run test:watch` |
| Component workbench | `npm run storybook` |

## Read before changing code

- **`CONTRIBUTING.md:33-103`** is the five rules and the feature checklist. Read these first. They are not style preferences.
- **`ARCHITECTURE.md:45-191`** is the layers and where everything lives.
- **`ARCHITECTURE.md:192-2247`** is the decision log. Before changing anything load-bearing, check whether its current shape is already argued for. It usually is.
- **`ARCHITECTURE.md:2625`** is the Known debt table. If you take a shortcut, add it there.
- **`AGENT-PLATFORM.md`** is the agent runtime, permissions and context API.

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

**2. Every user action is a `Command`.** Menus, palette, keybindings and buttons all dispatch the same `commandId`, which is why the palette and keybinding customisation are complete for free. A feature is not done until it has a command. A command with a side effect must declare `capabilities`, and that declaration is the entire basis of permission enforcement.

**And the one that is easiest to forget:** *nothing new on the typing path* (`CONTRIBUTING.md:75-103`). Before adding per-keystroke, per-scroll or per-cursor work, ask what it costs on a 10 MB file. Prefer `view.visibleRanges`, debouncing, or pushing it to Rust.

**`services/` and `core/` never import `@codemirror/view`.** That is what keeps them runnable headless under Vitest. They do use `@codemirror/state` and `@codemirror/commands` deliberately: `services/workspace.ts` owns an `EditorState` per buffer, which is what makes per-tab undo work. CodeMirror *extensions* live in `src/editor/`, and `ui/EditorPane.svelte` owns the one `EditorView` instance. `npm run lint` enforces this, along with the `Platform` boundary above it. See `eslint.config.js`.

## House style

- **No em dashes.** Full stops, colons, commas and parentheses do the same work and read like a person wrote them. This applies to prose, comments, commit messages and documentation.
  Applies to what you write and what you edit, not as a licence to sweep. The prose docs were cleaned on 2026-08-29; the source comments were not, so there are still a few thousand in `src/` and `tests/` that predate the rule. Leave them where you are not otherwise touching the line.
- **Comments explain *why*, never *what*.** A comment restating the code is noise. One recording a constraint, a trade-off or a non-obvious ordering is the most valuable thing in the file. This codebase comments heavily, in full sentences. Match the file you are editing.
- **Do not run prettier.** There is no prettier config here, so it rewrites files to double quotes against house style. `eslint.config.js` says so at the top. Single quotes, two-space indent and semicolons are matched by hand.
- Strict TypeScript with `noUncheckedIndexedAccess`. No `any`. Use `unknown` and narrow.
- Naming: services are `XService`, commands are `category.verbNoun`, CSS tokens are `--nox-*`.
- CSS is component-scoped and token-only. No utility classes, no `!important`.
- Silencing an a11y lint requires the reason in the ignore comment.
- Commit messages are imperative and specific: `Fix session overwrite on boot`, not `fix bug`. No conventional-commits prefixes, no emoji.
- When you fix a bug, add the test that would have caught it and say in a comment what it guards. Where you can, say what the test does *not* catch too.

## Gotchas

- **The version is triple-sourced, and `CHANGELOG.md` is the fourth.** `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` must agree or the release workflow refuses the tag (`.github/workflows/release.yml:33-69`), and `CHANGELOG.md` must carry a `## [<version>]` section with something under it. That section *is* the release body (`.github/workflows/release.yml:71-94`).
- The release gate also reads the `**vX.Y.**` line opening README §Status (`scripts/readme-series.mjs`). Keep that line, and rewrite the whole section at a tag rather than just its number.
- Do not touch the `conditions` spread at `vite.config.ts:28`. The comment above it records that the obvious rewrite broke `npm run dev`.
- Tests use relative `'../src/…'` imports, never the `@core`/`@services` aliases.

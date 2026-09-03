# Nox audit: orientation

Shared context for every audit subagent. Read this first. Do not re-derive it.

## Audited revision

- Repository: `github.com/francescoa27122/nox-editor`, branch `main`
- Commit: `54cece6e5fa50d7e9b35718e12f59a29d759b362` (2026-08-29, "Record the skill-anchor session in the work log (#176)")
- Working tree at audit time carries uncommitted edits to `.claude/skills/*`, `CLAUDE.md`, an untracked `.claude/skills/new-command/` and an untracked `tests/skill-refs.test.ts`. None of these is product code. Audit the tracked source; ignore those files.
- Version: `0.11.0` in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` (they must agree, the release workflow checks). `CHANGELOG.md` has an `[Unreleased]` section carrying blame.

## Correction to the handoff's premise

The handoff describes Nox as "native GUI application (Swift / C++ / Rust)". That is not what is in the repo. Nox is a **Tauri 2** application: a Rust host process (`src-tauri/`, ~7,000 lines) that opens the platform WebView, and a **Svelte 5 + CodeMirror 6 + TypeScript** renderer (`src/`, ~91,000 lines) that is the entire UI and most of the logic. The one Swift file is a 1-file helper script for macOS window ids. There is no C++.

Judge it by native-app standards as asked, but audit what is actually there: a WebView-hosted editor with a Rust IPC boundary. The relevant native-app questions (memory growth, startup, packaging, signing, crash handling) still apply, and the WebView adds its own (CSP, IPC capability scope, what the renderer can reach).

## Repo map

Tracked lines by language (excluding `dist/` and `storybook-static/`):

| Language | Lines | Where |
|---|---|---|
| TypeScript | 77,421 | `src/` (app), `tests/` (172 test files), `bench/`, `e2e/` |
| Svelte | 14,042 | `src/ui/` (45 components) |
| Rust | 6,969 | `src-tauri/src/` (14 modules) + 2 integration test files |
| Markdown | 37,068 | Docs, specs, plans |
| CSS | 611 | `src/styles/` (tokens) |

Key file sizes: `src/app.ts` 5,338 lines (the composition root and all 160 command definitions), `src/services/workspace.ts` 1,993, `src/platform/memory.ts` 1,312, `src/platform/tauri.ts` 894.

### Layers (from ARCHITECTURE.md §2, enforced by `eslint.config.js`)

Dependencies point inward only.

```
ui/          Svelte components. Rendering + input. No fs, no logic.
services/    Application logic, framework-free. commands, keymap, config,
             workspace, transactions, review, context, permissions, jobs,
             lsp/, agent/, plugin/, filetree, session, watcher, search, git,
             terminal, notes, updates, themes, snippets, diagnostics, ui
editor/      Everything CodeMirror-shaped. The ONLY place @codemirror/view
             is imported. ui/EditorPane.svelte owns the one EditorView.
core/        Pure TS, zero imports: path, fuzzy, signal, emitter, diff,
             git-status, git-blame, replace, languages, symbols, lsp-* helpers
platform/    interface Platform (types.ts, 72 methods). Implementations:
             tauri.ts (desktop, wraps Rust IPC), memory.ts (in-memory FS for
             tests and browser dev), web.ts (browser: memory + localStorage)
src-tauri/   Rust. 52 #[tauri::command] entry points across fs, encoding,
             git, http, lsp, pty, search, watcher, agent, menu, window_state,
             geometry. Zero `unsafe` blocks in the crate.
```

### The two rules everything rests on

1. **`Platform` is the only door to the OS.** Nothing in `ui/`, `services/`, `core/` imports `@tauri-apps/*` or touches `localStorage`. A new OS capability is a method on `Platform` implemented in both `tauri.ts` and `memory.ts`.
2. **Every user action is a `Command`.** Menus, palette, keybindings, buttons all dispatch a `commandId`. A command with a side effect declares `capabilities`, and that declaration is the whole basis of permission enforcement (`services/permissions.ts`).

Plus rule 5 of CONTRIBUTING.md: **nothing new on the typing path**. `tests/complexity.test.ts` holds pure functions to stated complexity; `npm run test:editor` (real Chromium) holds typing flat in document size.

### Subsystem pointers

| Area | Files |
|---|---|
| Buffers, tabs, dirty, undo, change-set application | `services/workspace.ts`, `services/transactions.ts`, `services/session.ts` |
| Review of proposed edits (hunk accept/reject) | `services/review.ts`, `core/diff.ts`, `core/diff-view.ts`, `ui/ReviewPanel.svelte`, `ui/DiffView.svelte` |
| Permissions and audit | `services/permissions.ts`, `services/context.ts`, `services/agent/runtime.ts` |
| Agents | `services/agent/{protocol,provider,runtime,stdio,ollama,config}.ts`, `src-tauri/src/agent.rs`, `src-tauri/src/http.rs` (loopback-only HTTP client), `examples/*.mjs`, `AGENT-PLATFORM.md` |
| Plugins | `services/plugin/*`, `core/plugin-manifest.ts`, `examples/plugins/` |
| LSP | `services/lsp/*`, `core/lsp-*.ts`, `editor/lsp.ts`, `src-tauri/src/lsp.rs` |
| Git | `services/git.ts`, `core/git-*.ts`, `editor/git-*.ts`, `src-tauri/src/git.rs`, `ui/GitPanel.svelte` |
| File ops, watching, search | `src-tauri/src/{fs,watcher,search,encoding}.rs`, `services/{watcher,search,filetree}.ts` |
| Terminal | `services/terminal.ts`, `src-tauri/src/pty.rs`, `ui/TerminalPanel.svelte` |
| Config, settings, keymap, themes, snippets | `services/config/{schema,index}.ts`, `services/keymap.ts`, `services/themes.ts`, `services/snippets.ts`, `services/config-watcher.ts`, `services/damaged-config.ts` |
| Updater | `services/updates.ts`, `tauri-plugin-updater` (pubkey and endpoint in `tauri.conf.json`) |
| UI shell | `ui/App.svelte`, `ui/EditorArea.svelte`, `ui/EditorGroupView.svelte`, `ui/EditorPane.svelte`, `ui/Sidebar.svelte`, `ui/CommandPalette.svelte`, `ui/SettingsPanel.svelte`, `src/styles/` |

## Build, test and CI

- Build: Vite 8 for the renderer, `tauri build` for the desktop app. Bundle targets: app, dmg, deb, rpm, nsis. Updater configured with a minisign pubkey pointing at GitHub releases `latest.json`.
- Tauri capabilities (`src-tauri/capabilities/default.json`): `core:default`, a handful of window ops, `dialog:allow-open/save`, `updater:default`, `process:allow-restart`. Custom commands are the `nox_*` set.
- CSP: `default-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: asset: http://asset.localhost; font-src 'self' data:`.
- Tests: Vitest. Projects: `unit` (172 files, jsdom), `stories` (Storybook, Playwright), `editor` (real Chromium), `bench`. Rust: 132 `#[test]` across modules plus 2 integration files. E2E: WebdriverIO against the packaged app (`e2e/specs/`), CI-only.
- CI (`.github/workflows/ci.yml`): lint; web matrix (check, test, build, storybook, stories, editor); rust matrix (clippy `-D warnings`, test, `cargo metadata --locked`); e2e matrix (tauri build with `wdio` feature). `main` is protected with 7 required checks. Release workflow (`release.yml`) fires on `v*` tags and refuses a tag whose version disagrees with the three manifests or lacks a CHANGELOG section.
- License: MIT.
- `npm audit`: 0 vulnerabilities in production deps. 3 moderate in dev deps, all via `@storybook/addon-mcp` → `valibot` (GHSA-5qjj-4xww-7phc). `cargo audit` is not installed on this machine.

### Local verification result at the audited SHA

- `npm test`: **pass**. 169 files, 2439 tests, 32.6 s.
- `npm run check`, `npm run lint`, `npm run build`: see "Build status" below.
- `cargo clippy --all-targets -- -D warnings` and `cargo test`: see "Build status" below.

## Build status

All local checks at the audited SHA pass. This is not a P0.

| Check | Result |
|---|---|
| `npm test` | pass, 169 files, 2439 tests, 32.6 s |
| `npm run check` (svelte-check) | pass, 0 errors |
| `npm run lint` | pass, 0 errors, 9 warnings (all `no-useless-assignment`, recorded in Known debt) |
| `npm run build` | pass, 2.15 s, one Vite warning: a chunk is over 500 kB after minification |
| `cargo clippy --all-targets -- -D warnings` | exit 0 |
| `cargo test` | exit 0, unit tests plus `fileops_integration` and `search_integration` (4 passed) |

Toolchain on the audit machine: Node 24.15, npm 11.12, cargo 1.98 (Windows 11). `cargo` is on PowerShell's PATH only.

## Docs the subagents should know exist

- `README.md`: product pitch, first-run instructions (unsigned on macOS and Windows, explains the SmartScreen and `xattr` workaround), status section.
- `ARCHITECTURE.md`: §2 layers, §4 decision log (2,000 lines; most load-bearing shapes are argued for there), §7 Known debt (a long table; many defects are already recorded there, cite the row rather than rediscovering it).
- `AGENT-PLATFORM.md`: the agent runtime requirements and milestone status. Source of truth for agent scope.
- `CONTRIBUTING.md` §The five rules.
- `DESIGN.md`: visual design language and tokens.
- `ROADMAP.md`: what is planned, and explicitly "anything not listed is not planned". Vim mode, nested splits, tasks, remote models, and agent command execution are all unbuilt and listed as such.
- `CHANGELOG.md`, `WORKLOG.md`.
- `docs/superpowers/specs/*.md` and `plans/*.md`: per-feature design docs including `2026-08-23-production-readiness.md`.
- `.claude/skills/nox-*`: five deep subsystem skills. Line anchors in them rot; re-derive before trusting one.

## Things already known and recorded as debt (do not report as new)

The Known debt table in `ARCHITECTURE.md` §7 records, among others: agent and plugin processes are not sandboxed (they run with Nox's privileges); a plugin setting cannot hold a secret; `servers.json` and `agents.json` are plaintext; the watcher is root-only so files outside the workspace never get the save-overwrite dialog; two git reads run on the main thread; no charset auto-detection beyond UTF-8 and BOM'd UTF-16; the transaction log does not survive restart; splits do not nest; no light theme by design; macOS trash has no Put Back; custom themes have no contrast floor. **If you find one of these, cite the row and say whether the recorded description is accurate and whether the severity is right. That is a finding; rediscovering it is not.**

## Finding schema

Every finding, without exception:

```
ID:          A6-003
Lane:        Security
Severity:    P0 | P1 | P2 | P3
Title:       One line, states the defect, not the vibe
Location:    path/to/file.rs:120-148
Evidence:    What in the code proves this. Quote the relevant lines.
Impact:      Concrete failure scenario. Specific inputs or state -> specific bad outcome.
Fix sketch:  What the fix looks like, in 1 to 3 sentences.
Confidence:  Confirmed | Likely | Speculative
Risk class:  Safe | Gated
```

- P0: exploitable security hole, data loss, corruption, crash on a normal path, broken build.
- P1: feature broken or materially incomplete, serious performance cliff, significant UX failure, meaningful security weakness.
- P2: correctness or quality issue with a workaround, notable friction, debt with real cost.
- P3: polish, consistency, minor cleanup.
- Safe: fix contained, no change to public API, on-disk formats, config schema, keybinding defaults, or permission behaviour.
- Gated: fix changes any of those, or agent capability boundaries, or breaks existing users.

No finding without evidence from the code. Speculation is allowed but labelled. Twelve real findings beat sixty filler ones. No em dashes in anything you write.

---
name: nox-tauri-ipc
description: Use when adding or changing anything that crosses Nox's Rust boundary — a new `#[tauri::command]`, a streamed `nox://` event, a `Platform` method, filesystem/git/pty/LSP/search/http work in src-tauri, error codes the renderer branches on, or Tauri capabilities. Also when a command works in the desktop build but not the browser build, or an id cannot be reused after a window reload.
---

# Adding to Nox's Rust boundary

## Overview

**A Rust command is half the change.** The contract is the `Platform` interface, and it has three implementations that must all move together:

1. `src/platform/types.ts` — add the method (with the doc comment; this file is the spec)
2. `src/platform/tauri.ts` — a thin adapter via `call<T>('nox_…', {…})`. Its own rule: *if you find yourself writing an `if` in this file, it belongs in a service* (`platform/tauri.ts:49-52`)
3. **`src/platform/memory.ts`** — the fake. `web.ts` *extends* `MemoryPlatform` (`web.ts:13`) and overrides only `capabilities` and localStorage persistence, so it usually needs no edit; touch it only to flip a capability flag.

Skipping step 3 breaks `npm run dev` and every headless test. Where the browser genuinely cannot do it, note the argument order — the code is the **second** argument, and getting this wrong silently degrades to `io`:

```ts
throw new PlatformError('this build cannot start language servers', 'unsupported');
```

Then gate callers on `capabilities.*`.

## Command shape

```rust
pub type Result<T> = std::result::Result<T, String>;   // per module, at the top

#[tauri::command]
pub fn nox_thing_start(
    app: AppHandle,                    // first, if needed
    state: State<'_, ThingState>,      // second — always the '_ lifetime
    id: String,                        // then payload
) -> Result<()> {
```

- **Prefix `nox_`, snake_case.** No unprefixed command exists. `<module>_<verb>` is the pattern in `agent`/`git`/`http`/`lsp`/`pty`/`search`, but not a rule: all 15 `fs.rs` commands are bare (`nox_read_text_file`, `nox_stat`, `nox_trash`), and `watcher.rs` exports `nox_watch` and `nox_git_meta_watch`. Match the module you are editing.
- **`pub fn`, never `async fn`.** There is not one async command in the crate. Validate, register, return immediately; move long work to `std::thread::spawn` (or `tauri::async_runtime::spawn` in `http.rs`). Awaiting in the command means the handle needed to *cancel* only arrives once there is nothing left to cancel (`http.rs:82-88`).
- **Error type is always `String`.** No error enum, no `thiserror`. Five of the eight command modules declare `pub type Result<T> = std::result::Result<T, String>;` at the top (`agent`, `fs`, `git`, `lsp`, `pty`); `http`, `search` and `watcher` spell it out inline. Either is fine.
- Structs crossing the boundary derive `Serialize`/`Deserialize`. Add `#[serde(rename_all = "camelCase")]` whenever a field is multi-word — about half the derive sites have it. The ones without (`LinePayload`, `ExitPayload`, `DataPayload`, `MessagePayload`) are single-word throughout, so it would be a no-op rather than a deliberate exception.
- Register in `lib.rs`: `.manage(...)` if stateful, and the path in `generate_handler![]`, grouped by module.

## Errors the renderer can branch on

Rust returns `"<code>: <message>"`; `platform/tauri.ts:714-728` splits on the first `": "` and matches against six codes: `not-found`, `permission`, `exists`, `not-text`, `unsupported`, `io`.

Reuse `fs.rs:37-47`'s `describe()` for anything touching `std::fs`; write the code by hand otherwise (`format!("exists: a terminal with id {id} is already open")`).

Three traps:

- **`unsupported` is never emitted by Rust.** It means "this platform has no such thing" and belongs to the memory/web platforms only.
- **An unrecognised prefix silently degrades.** `spawn:`, `pty:`, `lsp:`, `refused:` all become `code: 'io'` **and the prefix is stripped from the message**. Accepted behaviour — but if the renderer must branch on it, use one of the six.
- **Name your path argument `path`** — `PlatformError.path` is populated from `args.path`.

Git is deliberately different: git's own words come back verbatim under `io:`, with a stdout fallback because git prints "nothing to commit" on stdout (`git.rs:129-140`).

## Streaming

Tauri app-global events via `AppHandle::emit` (needs `use tauri::Emitter`) — never channels. Names are `nox://…`; every multi-session stream carries its `id` **in the payload** and the renderer filters.

Ids are **chosen by the renderer** (agent, lsp, pty, http) so replies match without a round trip. Search is the exception: Rust allocates a `u64`.

**Self-cleanup on child exit is mandatory.** The reader thread must deregister the id when the child dies, or the id stays registered for the life of the app and respawning under it is refused as "already running" — exactly what happens after a window reload restarts the renderer's counter (`agent.rs:150-158`):

```rust
if let Some(state) = app.try_state::<AgentState>() {
    if let Ok(mut agents) = state.0.lock() { agents.remove(&id); }
}
```

`try_state`, not `state` — the app may be tearing down, and a missing registry is nothing to panic over.

Emit failure means the window is gone: `let _ = app.emit(...)` for fire-and-forget, or check and `break` out of a hot loop.

On the TS side, attach the listener **before** calling the start command, and release it if the command throws (`platform/tauri.ts:376-408`).

## State

Always `std::sync::Mutex`. No `DashMap`, no `RwLock`, no `parking_lot`.

```rust
#[derive(Default)]
pub struct ThingState(Mutex<HashMap<String, Running>>);   // access via state.0.lock()
```

Named-field structs when there is more than one thing to hold. A type that is not `Default` (like `RecommendedWatcher`) needs a hand-written `impl Default`.

Lock poisoning gets a module-level `fn poisoned<T>(_: T) -> String`, used as `.map_err(poisoned)?` — that is the pattern in `agent.rs:245`, `lsp.rs:394` and `pty.rs:357`. Modules with one lock site inline it instead (`search.rs:233`).

`*_all` teardown **drains into a `Vec` first, then acts** — that releases the lock before the killing.

## Security invariants — do not relax these

| Rule | Where | Why |
|---|---|---|
| Loopback is **parsed**, not prefix-matched | `http.rs:42-53` | `localhost.evil.com` must fail |
| Redirects `Policy::none()`, `.no_proxy()` | `http.rs:70-80` | `is_loopback` only proves the first hop |
| No shell — argv only | `fs.rs`, `git.rs`, `lsp.rs` | `cmd /C` re-splits on spaces; only `lsp.rs` falls back, and only after a direct spawn fails |
| Six fixed git *writes and reads*, plus the read-only `nox_git_file_base` | `git.rs:19-27` | Nothing that leaves the machine, rewrites history, or destroys working-tree work |
| `--literal-pathspecs` + `--` on every pathspec | `git.rs:216`, `:241` | A `*` in a filename is a filename |
| Commit message on **stdin**, never argv | `git.rs:250-252` | Messages contain quotes, dashes, anything |
| Branch name validated by `check-ref-format` first | `git.rs:304` | Only strings git blessed reach the write |
| Empty unstage list returns early | `git.rs:237-239` | Bare `git reset --` resets the whole index |
| Every path forced inside the repo | `git.rs:167-178` | |
| `Content-Length` framing lives in Rust | `lsp.rs:8-13`, `:142-146` | Header counts bytes; the IPC string is UTF-16 |
| Lost framing is an error, not a resync | `lsp.rs:106-111` | Guessing where the next message starts cannot recover |
| Config names reject separators and `..` | `fs.rs:365-368` | Path traversal |
| Rename/copy refuse to clobber | `fs.rs:248-250`, `:306-308` | `fs::rename` silently replaces on unix |
| Writes go to a sibling temp, fsync, rename | `fs.rs:122-139` | Cross-filesystem temp reintroduces the truncation window |
| Agents cannot spawn agents | `agent.rs:13-15` | Only the user, through configuration |

## Capabilities

**A new application command needs no capability entry.** `capabilities/default.json` gates *plugin* and *core* verbs only; commands registered through `generate_handler!` are not ACL'd in Tauri v2. The proof is in the file: 43 shipping commands, and not one `nox_*` among its 14 permission strings.

You only edit it when the TS caller reaches for a plugin API or an unlisted core verb. The file mostly names narrow verbs (`core:window:allow-minimize`, `dialog:allow-open`) but does use `core:default` and `updater:default` where a bundle is wanted — prefer the narrow form, and follow the existing entries for the plugin you are touching.

## Testing

**Design rule: if a command takes `State` or `AppHandle`, put the testable logic in a free function beside it.** That is why `write_config_atomically` (`fs.rs:408-410`) and `pty::open` (`pty.rs:121-125`) exist — tests drive those directly, with no Tauri application around them.

Unit tests are `#[cfg(test)] mod tests` at the bottom of the module — in 7 of the 8 command modules (`agent.rs` has none; it is covered by the renderer's fake-process tests in `services/agent/`). Where a test needs a temp directory, `fs.rs:439` and `git.rs:370` each hand-roll a `Scratch(PathBuf)` RAII helper rather than adding a `tempfile` dependency — copy one of those instead of reaching for a crate.

Pure helpers are made `pub` purely so tests can reach them (`MessageStream`, `frame`, `Utf8Stream`, `is_loopback`).

Roughly a quarter of the Rust tests carry a doc comment naming the failure they prevent — concentrated in `pty.rs` (6 of 8) and `http.rs` (2 of 2), absent in `lsp.rs` and `search.rs`. It is the better half of the codebase and worth imitating, but it is not yet uniform, so do not assume an undocumented test is an oversight.

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

CI runs `cargo test` from `src-tauri` on Linux, macOS and Windows — Windows is in the matrix so the `#[cfg(windows)]` branches compile. **There is no `cargo fmt --check` and no `cargo clippy` step.**

`cargo` may not be installed on this machine. If it isn't, write the tests, say plainly that they are unrun locally, and let CI execute them — do not claim they pass.

## Common mistakes

| Mistake | What happens |
|---|---|
| Rust command only, no `memory.ts`/`web.ts` fake | Browser build and headless tests break |
| `async fn` command | Renderer can't get a cancel handle until the work is done |
| Forgetting to deregister the id on child exit | Respawn refused as "already running" after a reload |
| `app.state::<T>()` in a spawned thread | Panics during teardown; use `try_state` |
| Emitting `unsupported:` from Rust | Not one of the six; degrades to `io` |
| Building a git argv by string concatenation | Breaks the argv-only invariant |
| Listener attached after the start command | Misses everything emitted before subscription |

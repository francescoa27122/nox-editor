# Verification notes for fixes without a test of their own

Each heading is a finding ID from `AUDIT/`. Everything a test could hold is
held by one; this records the remainder and how it was checked.

## A2-002

The change is an attribute: `#[tauri::command]` became
`#[tauri::command(async)]` on 22 commands, bodies untouched. The macro then
runs each body on Tauri's async runtime (`sync_threadpool` in tauri-macros'
own vocabulary) instead of inline on the thread that draws the window. No
Rust test can observe which thread a Tauri command ran on without a running
application, so this note stands in for one.

Converted, and why each can block:

- `git.rs`: `nox_git_status`, `nox_git_branches`, `nox_git_stage`,
  `nox_git_unstage`, `nox_git_commit`, `nox_git_switch`, `nox_git_file_base`.
  Each spawns `git` and waits; commit runs the repository's hooks, switch
  checks out a tree. `nox_git_blame` was already `(async)`.
- `fs.rs`: `nox_read_text_file`, `nox_read_encoded_file`,
  `nox_write_encoded_file`, `nox_write_text_file`, `nox_read_dir`,
  `nox_exists`, `nox_stat`, `nox_create_dir`, `nox_create_file`,
  `nox_rename`, `nox_trash`, `nox_copy_file`, `nox_read_config`,
  `nox_write_config`. The writes go through `write_then_rename`, which calls
  `sync_all`; the reads decode up to 64 MB inline; trash and copy do their IO
  inline.
- `watcher.rs`: `nox_watch`. On Linux `notify`'s recursive watch walks the
  tree inside `watch()`, which is A2-004; running it on the pool closes that
  finding too.

Left as plain `#[tauri::command]`, on purpose:

- `nox_pty_write`, `nox_lsp_send`, `nox_agent_send`. The first two are fired
  without awaiting (`src/services/terminal.ts` `void this.#session?.write`,
  `src/services/lsp/documents.ts` `void session.notify`). A sync body runs to
  completion before the next IPC message is read, so their order is the
  order they were issued in. Under `(async)` each becomes its own pool task
  racing for the registry mutex, and keystrokes or `didChange` versions can
  arrive swapped. `src/services/agent/stdio.ts:222` does await each agent
  send, so that one is kept sync for consistency and so a future un-awaited
  caller inherits the guarantee. Each carries a doc comment saying so.
- `nox_unwatch`. The disposer in `src/platform/tauri.ts` fires it without
  awaiting and the next `nox_watch` follows immediately; sync-then-async keeps
  that order, async-then-async would not, and the losing order drops the new
  watcher.
- `nox_home_dir`, `nox_config_dir`, `nox_reveal` (spawns without waiting),
  the git-meta and config watch commands, and every `*_start`, `*_open`,
  `*_kill`, `*_stop`, `*_close` and search command: cheap, or a registry
  operation that must stay ordered against its own reader thread's `remove`.

Ordering check in `src/platform/tauri.ts`: every converted command is awaited
by its `Platform` method, and every service call chain awaits the platform
method, so a write followed by a read is ordered by the promise chain. The
only un-awaited calls to converted commands are none; the un-awaited calls
that exist (`nox_unwatch`, `nox_git_meta_unwatch`, `nox_config_unwatch`,
`nox_search_cancel`, the three sends) all remain sync.

Compile check: `#[tauri::command(async)]` on a non-async `fn` taking
`State<'_, T>` and `AppHandle` compiles (`nox_watch`, `nox_read_config`,
`nox_write_config`); the bodies have no `.await`, so no `MutexGuard` is held
across one. Verified by `cargo clippy --all-targets -- -D warnings` and
`cargo test` from `src-tauri`, both exit 0, output recorded in the fix
report.

Not measured: how long a hook, a fsync or an inotify walk held the window
before the change. That needs a packaged build with a `sleep 5` pre-commit
hook and the `nox-desktop-walk` skill.

## A2-006

`pty::coalesce` is new, so its four tests cannot be compiled against the
code before the fix; the before-state was one `app.emit` per `read`, with no
function to test. What the tests hold is the property that shape lacked:
`joins_a_burst_into_fewer_events_without_reordering` asserts 200 chunks
become fewer than 200 events with every byte in order, which the old shape
fails by construction (200 reads were 200 emits). `caps_a_batch_at_the_byte_budget`
pins the split at the byte cap, `a_lone_chunk_is_not_held_back_for_company`
holds the zero-latency rule for a prompt, and `stops_reading_when_the_emitter_breaks`
holds the window-gone path.

Not measured: throughput in the packaged app. The renderer still writes
straight into xterm with no write callback, so there is still no
acknowledgement from the webview back to Rust; the batching bounds the event
rate, not the byte rate. Recorded as debt in the fix report.

## A2-010

Two halves. `tests/platform-contract.test.ts` is a suite over a `Platform`
factory, run against `MemoryPlatform` here; it guards drift between the two
implementations rather than a defect, so there is no "fails before" run to
record. It is green on the fake (8 cases). Plugging `TauriPlatform` in from
the e2e job is the follow-up the file's comment names.

The other half is comment-only: the three reader threads in `agent.rs`,
`lsp.rs` and `pty.rs` said the `remove` after reaping exists because a
reload restarts the renderer's counter and a reused id would be refused.
`src/platform/tauri.ts` puts a per-load token in every id (`#instance`), so
that collision cannot happen; the comments now give the real reason (a
stale entry that later kills and `*_all` would act on, and a registry that
grows by one per process). Verified by reading `tauri.ts` and by `cargo
clippy --all-targets -- -D warnings` plus `cargo test`, both exit 0.

## A8-002

The hook itself is tested end to end: `panic_log::tests::a_panic_lands_in_the_file`
installs it into a scratch directory, panics on another thread, and asserts
the message, the location line and the redaction in `panic.log`. The
formatter, the timestamp arithmetic and the line cap each have their own
test. The renderer side (`DiagnosticsService` carrying the last entry into
Copy Diagnostics) is in `tests/diagnostics.test.ts`.

What no test holds is the three-line call in `lib.rs`'s `setup` that
resolves the app config directory and installs the hook. It was verified by
reading: `_app.path().app_config_dir()` is the same call `fs::config_path`
uses for `diagnostics.log`, so the two files land side by side, and
`fs::dirs_home()` is what `nox_home_dir` already hands the renderer for its
own redaction. It is compiled by `cargo clippy --all-targets -- -D warnings`
on all three platforms in CI. It was not exercised in a packaged build,
because nothing in the app can be made to panic from the UI and adding a
crash trigger to verify a crash logger would be the wrong trade.

Two things the test deliberately does not claim. It runs under the test
profile's `panic = "unwind"`, so it says nothing about the abort that
follows the hook in a release build (the hook runs before the abort by
definition; `panic = "abort"` is kept, see `Cargo.toml`). And it does not
cover a panic that happens before `setup` runs, which is a Tauri
initialisation failure with no window to lose yet.

## A3-012

Prose only, so no test. Each sentence that stayed is one the suite already
holds: unsaved changes surviving a quit (`tests/session*.test.ts`), the
temp-and-rename save (`src-tauri/src/fs.rs` tests), config-directory write
failures surfacing (`tests/write-failures.test.ts`).

Two sentences were added on the lead's word that the performance branch
lands them, and are not verified in this worktree: a keystroke during an
in-flight save being kept (A3-001) and a dirty tab whose file has gone
being restored as unsaved (A3-004). If that branch does not merge, those
two sentences overclaim and should be cut.

The two residuals were re-derived here rather than taken from the audit:
the session file is written 400 ms after a change (`services/session.ts`,
`schedule()`, the `setTimeout` at the end of that method), so a crash inside
that window loses what was typed in it; and an external change is told
apart from Nox's own save by mtime equality alone
(`services/watcher.ts:225`, `mtime === this.#workspace.knownMtime(id)`), so a
change in the same filesystem tick as a save reads as ours. The ARCHITECTURE
reload paragraph now says the selection is mapped rather than re-anchored,
which underclaims if A3-005 is fixed elsewhere and was true at the audited
commit.


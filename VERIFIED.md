# Verification notes for fixes without a test of their own

Each heading is a finding ID from `AUDIT/`. Everything a test could hold is
held by one; this records the remainder and how it was checked.

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


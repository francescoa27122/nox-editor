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

# Work log

State between sessions. Newest entry on top, roughly ten kept.

Durable knowledge — decisions, gotchas, the reasons behind a design — belongs
in `docs/superpowers/specs/` and in commit messages. **This file is state; those
are knowledge.**

---

## 2026-08-18 (later still) — The apt step that hangs

On branch `ci-apt-mirror-stall`, not pushed. The `rust (ubuntu-22.04)` job's
dependency install hung five times in one day, 10-26 minutes against ~1.8
minutes healthy, each time needing a human to cancel and `gh run rerun`.

What it actually is, from the run logs rather than from the symptom:

- `apt-get update` is **not** the problem. It finishes in 3-8s even on the bad
  runs (32s on the worst). The whole stall is inside `apt-get install`.
- Nothing fails, times out, or errors. apt just crawls: run 32163740199
  reported `Fetched 55.6 MB in 22min 12s (41.7 kB/s)` against `in 9s` on a
  healthy run of the same commit.
- Time per package is **uncorrelated with package size** — 14.2 kB took 17.9s,
  356 kB took 5.0s. So it is per-request latency across 137 serial requests,
  not bandwidth. That is why `Acquire::Retries` and `Acquire::http::Timeout`
  are both no-ops here: there is no error to retry and no idle socket to time
  out. A plain retry is also weak, because the degradation is sustained for
  the whole 22 minutes rather than bursty.

So the fix is to stop asking the mirror at all, and to bound what is left:

- `.github/actions/linux-build-deps/` — new composite action, used by both
  `ci.yml` and `release.yml` (which carried the identical block plus
  `patchelf`). One copy, because the retry shell is subtle enough that two
  copies would drift.
- `actions/cache@v6` over `~/apt-archives`, seeded into
  `/var/cache/apt/archives` **after** `apt-get update`. On a warm cache apt
  downloads nothing, so the mirror cannot affect the step at all.
- Download and install are split. A `timeout` can then only ever interrupt the
  network half; dpkg is never killed part-way through unpacking. Completed
  `.debs` survive the kill, so the three attempts accumulate progress rather
  than restarting.
- `--no-install-recommends` drops 42 packages of gstreamer, pipewire, pulse,
  polkit and codecs that a compile-only job never uses.
- `Acquire::ForceIPv4` — the one unproven piece, see Blocked.

Verified, locally in Docker against a runner-like image:

- Cold cache: 239 packages, exit 0, 48s, `pkg-config --modversion
  webkit2gtk-4.1` → 2.50.4.
- Warm cache: `Seeded 239 package(s)` → `Need to get 0 B/124 MB`. Zero
  archives fetched. With `extra-packages: patchelf`, exactly `72.1 kB`.
- Resume is real, not assumed: a download killed at 3s kept 55 of 281 `.debs`
  and the retry fetched only `115 MB/133 MB`.
- The retry function against a hang → three attempts then `::error::` and
  nonzero, in 21s; against a twice-failing command → recovers on attempt 3;
  `set -e` does not abort the script on a failed attempt.
- `bash -n` clean, shellcheck clean, all three YAML files parse, CRLF intact.

One thing worth carrying forward:

- **Seed the apt cache after `apt-get update`, never before.** The first
  version seeded first and silently re-downloaded all 124 MB — an
  `APT::Update::Post-Invoke` hook can empty `/var/cache/apt/archives`. Caught
  only because the warm-cache run was actually executed rather than reasoned
  about.

Next:

- Push the branch and let CI run it. Cold on the first run, warm on the
  second; the second is the one that proves the cache. Nothing here has been
  through GitHub Actions yet.

Blocked:

- Not pushed — asking first, since it is a public repo.
- `Acquire::ForceIPv4` is a hypothesis, not a measurement. Constant
  size-independent per-request latency is what a failed IPv6 connect followed
  by IPv4 fallback looks like, but the runner logs do not say so outright. It
  is harmless if wrong, and the cache does not depend on it being right.

## 2026-08-18 (later) — Completion

Shipped, on branch `lsp-completion`, all six planned tasks:

- `LspService.requestFor` / `capabilitiesFor` — the request door. Diagnostics
  arrive by push; everything else in v0.4 has to ask, and `#running` was
  private. Hover, go-to-definition and rename reuse this.
- `src/core/lsp-completion.ts` — items to CodeMirror completions, pure.
- `src/editor/completion.ts` — the source, and the DOM half of lazy docs.
- Wired through a compartment the pane reconfigures, keyed off `currentId`.

Verified:

- `npm test` — 1031 passed, 53 files. `npm run check` — 415 files, 0 errors.
- Four guards mutation-checked rather than trusted: the `textEdit` range,
  `filterText`, the `context.aborted` check, and `isIncomplete` suppressing
  `validFor`. Each fails its own test when removed.
- Against a real server: `s.` returns members with kinds, and **none of the
  items carry documentation** — asserted, because that is what makes
  `completionItem/resolve` load-bearing rather than an optimisation.

Two things worth carrying forward:

- **`npm run check` exits 0 even when it reports errors.** A
  `check && test && commit` chain therefore does not gate on it. One commit
  went in with a type error before this was noticed; grep the output for
  `0 ERRORS` instead of trusting the exit code.
- That error was real and reshaped the design: `CompletionInfo` is
  `Node | null | {dom}`, never a string, so lazy documentation cannot return
  text. `core/` stays DOM-free and the editor layer owns the callback.

Next:

- **The picker has never been seen.** Same gap as the squiggle before it: the
  wire behaviour is proven and the rendering is not. A tag build and a human.
- Then hover, which is the smallest feature left on the door this opened.

Blocked:

- Nothing. Not pushed.

Confidence:

- High on the conversion and the source — mutation-checked, and the real
  server contradicted nothing this time.
- Unverified: the picker itself, and the compartment actually delivering the
  source into a live view. The test proves the compartment exists in a built
  state, not that a keystroke reaches the server.

---

## 2026-08-18 — A real server, and what it changed

Shipped:

- `tests/lsp-integration.test.ts` — drives `typescript-language-server` 5.3.0
  through the same adapter the fake server uses, now extracted to
  `tests/support/lsp-child.ts` so a difference between fake and real cannot be
  a difference in the harness. Runs in CI, ~10s.
- `src-tauri/src/lsp.rs` — a Windows `.cmd` fallback via `cmd /C`.

Verified, and two of these contradict what the spec assumed:

- **tsserver sends no `version` on `publishDiagnostics`.** The field is
  optional and it omits it, so `LspService`'s stale-batch check never fires for
  the primary server. The range clamp in `editor/lsp.ts` is the only safeguard
  actually carrying the feature. Recorded as an assertion, so a future tsserver
  that starts sending one is a test failure someone reads.
- **tsserver advertises `textDocumentSync: 2` (incremental) and accepts a
  full-document change anyway**, clearing the diagnostic when the error is
  fixed. Full-text sync costs nothing against it. Mutation-checked: a change
  that does not fix the error leaves the diagnostic and fails the test.
- URI round-trips exactly, `c%3A` percent-encoding included.
- `npm test` — 979 passed, 50 files. `npm run check` — 410 files, 0 errors.
  CI green on all five jobs.

Smoke-tested on real hardware, from the `v0.4.1-lsp-test1` tag build:

- Nox spawned the server through the fallback and the process tree proved it:
  `Nox.exe -> cmd.exe "/C typescript-language-server --stdio" -> node.exe`.
  Both untested paths — `lsp.rs` supervision and the Windows `.cmd` fallback —
  confirmed working, not merely compiling.
- Same server pid for 40s, so the handshake completed; a failed one restarts at
  1s/2s/4s and then stays down.
- A real window close (WM_CLOSE, not a kill) stopped the server with **no
  orphans**. The one process that first appeared to be an orphan was the
  PowerShell command doing the searching — its own command line contained the
  search string.
- The fallback was then widened: it retried only on `NotFound`, which covers a
  bare command on PATH but not an absolute path to a `.cmd`, where
  `CreateProcess` fails with a different error. Someone writing a full path
  into `servers.json` is at least as likely.

Second build (`v0.4.1-lsp-test2`), after Francesco reported an empty console
window appearing on reload:

- **Windows gives a console-subsystem child its own window when the parent is
  a GUI app.** The `cmd` shim and the server are both console apps, so an empty
  console sat in front of the editor for the session — empty because the output
  is piped to Nox, permanent because the server is meant to keep running.
  Fixed with `CREATE_NO_WINDOW` on both spawn attempts.
- The first check for the fix was wrong and nearly reported a failure:
  `conhost.exe` is still created under the shim, because `CREATE_NO_WINDOW`
  hides the console rather than preventing one. The right measurement is window
  *visibility* — `EnumWindows` + `IsWindowVisible` finds no window belonging to
  the `cmd` or `conhost`, and no `ConsoleWindowClass` visible anywhere.
- Server stable for 25s afterwards, so the flag did not break the pipes.
- **`agent.rs` has the identical defect** and was left alone to keep the PR
  scoped. Spun off as its own task.

Third build (`v0.4.1-lsp-test3`) — **the squiggle is confirmed on real
hardware**, on the right buffer, with the server connected in the status bar.

Two bugs found by looking at a screen, both invisible to every test here:

- **A console window on every reload.** Windows gives a console-subsystem
  child its own window when the parent is a GUI app. Fixed with
  `CREATE_NO_WINDOW`; see the second build's entry.
- **The squiggle for `x.ts` appeared inside `servers.json`.** `EditorPane`
  holds one view and re-points it per tab, routing transactions to
  `workspace.applyTransaction(currentId, …)`. The app painted from a
  `workspace.activeId` subscription, which fires synchronously, while the pane
  swaps state in an effect, which runs later — so the newly-active buffer's
  diagnostics were dispatched while the *previous* buffer's state was loaded,
  and recorded against it permanently. Two owners of "which buffer is this
  view showing"; now one, the pane. **The tests added with the fix do not
  reproduce the race** — restoring the old paint leaves them green, because
  the harness drives effects through `flushSync`. Said out loud in the file.

Also confirmed, and not a bug: the squiggle sits under the *variable name*,
not the offending literal. `tsc --noEmit` reports `x.ts(1,7)` for
`const n: number = "x";` — column 7 is the `n`. TypeScript reports an
assignability error at the declaration, and Nox renders the range faithfully.

The setup that finally worked, worth writing down: a **global**
`typescript-language-server` needs a **global `typescript@6`** beside it.
`npm install -g typescript` now installs TypeScript 7, which no longer ships
`lib/tsserver.js`, and the server refuses to start without it.

Debt, deliberate:

- ~~**The squiggle has never been seen.**~~ Seen, on the right buffer. Kept
  below for the record of what it cost to get there.
- **The squiggle had never been seen** when the first two builds shipped. The UI could not be driven this
  session, so "diagnostics appear" is proved as far as the server running and
  the pipes connecting, and no further. The console-window bug is a reminder
  that a process tree is not a screen: it was invisible to every check made
  here and obvious the moment a human looked.

Confidence:

- High on the protocol layer — it has met a real server and been contradicted
  by it, which is worth more than the tests that agreed with me.
- High on supervision and Windows launching, now that the process tree has
  been read directly.
- Unverified: the rendering itself.

---

## 2026-08-17 — LSP client and diagnostics, all 16 tasks

Shipped:

- `src/services/search.ts:331` — `previewReplacement` resolves capture groups
  with a sticky match at the match's own column and returns `null` unless the
  result reproduces exactly what search reported. It previously fell through to
  the raw template, so a project-search row previewed a literal `$1` while the
  write substituted the capture. Branch `fix-replace-preview-groups`.
- Deleted the two merged preserve-case plan docs. Branch
  `retire-preserve-case-plans`.
- The LSP client, on branch `lsp-client`, all sixteen tasks of
  `docs/superpowers/plans/2026-08-17-lsp-client.md`:
  `src/core/uri.ts`, `src/core/lsp-position.ts`, the `LanguageServerProcess`
  boundary, `src-tauri/src/lsp.rs` (framing + supervision + four commands),
  `src/services/lsp/{transport,session,documents,registry,index}.ts`,
  `src/editor/lsp.ts`, `src/ui/{lsp-status,problems}.ts`,
  `src/ui/ProblemsPanel.svelte`, and the `app.ts` wiring with **Configure
  Language Servers**, **Reload Language Servers** and **Show Problems**.

Verified:

- `npm test` — 971 passed, 49 files. `npm run check` — 408 files, 0 errors.
  Baseline at session start was 855 / 37 and 385 files.
- The replace bug was reproduced in node before any code changed: window lead
  143, match column 60, rescan lands on 56/63/70, never 60.
- Four load-bearing tests were mutation-checked rather than trusted — the
  pre-initialize queue, the document version, the stale-diagnostic drop, and
  the preview fix itself. Each fails when its production line is removed.
- `tests/lsp-session.test.ts` runs a real Node child speaking genuine
  `Content-Length` framing, including a non-ASCII payload.

Next:

- **A desktop smoke test.** Push a throwaway `v0.4.1-lsp-test1` tag, let CI
  build the Windows installer, install it, and open a `.ts` file with an error
  in a workspace with `servers.json` configured. That exercises the two things
  no test here can: `lsp.rs`'s supervision, and whether a squiggle actually
  appears. It is also the only way to confirm the Windows `.cmd` fallback works
  rather than merely compiles.
- Then completion, the cheapest remaining v0.4 item
  (`@codemirror/autocomplete` is already a dependency).

Blocked / unverified:

- ~~`src-tauri/src/lsp.rs` has never been compiled.~~ **Resolved.** CI built
  it on Linux, macOS and Windows and ran all nine framing tests green (run
  32090362916). It did not compile on the first try: `push` was written before
  the crate's `Result<T>` alias existed and returned `Result<Vec<String>,
  String>`, which is E0107 against a one-argument alias. That is exactly the
  class of error the Python port could not catch, and exactly why the PR went
  up as a draft.
- ~~No real language server has ever talked to this.~~ **Mostly resolved.**
  `tests/lsp-integration.test.ts` drives `typescript-language-server` 5.3.0 and
  runs in CI on Node 20 and 22. It turned one design assumption around and
  confirmed another — see the entry below. What is *still* untested is
  `lsp.rs`'s own supervision (the integration test reaches the server through
  the Node adapter, not through Rust) and the UI end of it: squiggles actually
  painting, the panel actually rendering. Both need a desktop build.
- `lsp-client` is pushed as draft PR #28, CI green. The other two branches
  (`fix-replace-preview-groups`, `retire-preserve-case-plans`) are unpushed.

Confidence:

- High on the TypeScript: red-green watched on every task, four mutation
  checks, and the full suite green.
- High on `lsp.rs` now: compiled and tested on all three platforms by CI.
- Low on the end-to-end claim. "Diagnostics appear" is true of the code paths
  and untested against a real server.

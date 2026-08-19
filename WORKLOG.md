# Work log

State between sessions. Newest entry on top, roughly ten kept.

Durable knowledge — decisions, gotchas, the reasons behind a design — belongs
in `docs/superpowers/specs/` and in commit messages. **This file is state; those
are knowledge.**

---

## 2026-08-19 (later) — Go to definition

On branch `lsp-definition`, stacked on `lsp-render-verify` (it needs the
fake-server seam and the jsdom harness that branch adds). Same worktree,
`../nox-verify`. Not pushed.

Shipped:

- `src/core/lsp-definition.ts` — `Location | Location[] | LocationLink[] |
  null` reduced to `{ uri, range }[]`; links land on `targetSelectionRange`
  (the identifier) over `targetRange` (the declaration); malformed entries
  dropped, negative positions refused, duplicates removed.
- `lsp.goToDefinition` — **Go to Definition**, `F12`, category Language.
  Enabled only when the active buffer has a path and its server advertises
  `definitionProvider`, so a server still initializing greys the command
  rather than erroring. `NoxApp.revealLocation(location)` is public because
  find references will land the same way: `workspace.open(path)` (returns
  the existing id when already open) then `workspace.setSelection`, which
  dispatches to the pane showing the buffer and otherwise updates the
  buffer's own state so the pane's swap carries the cursor. Several results
  take the first and say how many; a picker is find references' list.
- CHANGELOG `[Unreleased]` and the ROADMAP row.

Verified:

- `npm test` — 1092 passed, 59 files. `npm run check` — 426 files, 0 errors.
- `tests/lsp-go-to-definition.test.ts` (jsdom, real pane + real app + fake
  server): enabled/disabled, the request's uri and position, cross-file
  jump, same-file jump, no result, many results, unopenable URI, a server
  error, and a count message that must not follow a failed reveal. Four
  mutations recorded in the docblock, each seen red.
- Against the real `typescript-language-server`: it sends `Location[]`, not
  links, and points at the identifier (line 0, 6-12). Asserted, so a change
  is a failing test.

Two things worth carrying forward:

- **`workspace.open` on an open path returns the existing id and re-reports
  nothing**, and every `null` it returns has already gone through `#fail` →
  `notifications.error`. A caller that checks "is it already active" first,
  or toasts on `null`, is doing something already done. The first version
  here did both; the review caught it.
- **`FakeLanguageServer` now answers a throwing handler with a JSON-RPC
  error**, which is what makes a request's failure path testable through
  the real service. Hover, completion and rename can use the same trick.

Follow-up worth a look, not a bug claim: `ProblemsPanel.open()` does
`await workspace.open(path)` then `app.goToLine(...)` on `this.view.get()`.
If the pane's state swap can ever run after that continuation, the cursor
lands on the previous buffer. Svelte flushes effects in a microtask queued
before `open()`'s continuation, so it is probably fine — but nothing proves
it, and `revealLocation` deliberately went through `setSelection` so as not
to depend on the answer.

Next:

- Find references — the results list, and the "several definitions" picker
  with it. Then rename symbol.
- Both branches need a push and a PR; ask.

Confidence:

- High on the command and the normaliser; each test was made to fail first,
  and the real server agreed with the fixtures.
- Unverified: F12 on a real keyboard in the desktop build. The keymap parses
  it exactly as it parses F3, which is bound and used, so the risk is small
  and named.

---

## 2026-08-19 — The three unseen surfaces, seen in a DOM

On branch `lsp-render-verify`, in a **worktree** at `../nox-verify` (own
`npm ci` — the shared `node_modules` predated the desktop's
`typescript-language-server` devDependency, and the integration suite failed
9/9 until it was reinstalled). Not pushed.

The gap: diagnostics, completion and hover each had a wire test and no
rendering test — the sources were exercised against `{ state } as
EditorView`, and nothing proved the pane's `lspCompartment` delivered them
into a live view. Closed by measuring what jsdom can drive rather than
arguing about it; the measurements and the decision are in
`docs/superpowers/specs/2026-08-19-lsp-rendering-verification-design.md`.

Shipped:

- `tests/lsp-rendering.test.ts` — the real `EditorPane` over a real `NoxApp`
  whose real `LspService` runs against an in-memory server. Seven tests: a
  published diagnostic paints `.cm-lintRange-error` under exactly `total`
  plus a gutter mark, and clears on an empty batch; typing `.` sends
  `textDocument/completion` for the pane's URI and the picker lists the
  server's labels, with `completionItem/resolve` documentation shown for the
  highlighted item; resting the pointer sends `textDocument/hover` and the
  tooltip carries the code block and prose as text — `<script>` in the
  server's markdown is characters, not an element — and leaves with the
  pointer.
- `tests/support/fake-lsp-process.ts` — the fake that `lsp-service.test.ts`
  kept privately, extracted and taught `handle(method, fn)`.
- `MemoryPlatform.languageServerFactory` — a test installs a server there;
  `capabilities.languageServers` stays false because the browser build still
  cannot start one.
- `tests/support/jsdom-layout.ts` — jsdom's `Range` has no `getClientRects`,
  and CodeMirror's `HoverPlugin` calls `coordsAtPos` from a bare `setTimeout`,
  so hover threw before the source was asked. Filled with one all-zero
  rectangle. **The rectangle's existence is invented; its numbers are
  jsdom's.** Consequence, written where the polyfill lives: `posAtCoords` is
  always 0, so the suite proves the request and the DOM, never which symbol
  was under the pointer.

Verified:

- `npm test` — 1074 passed, 57 files. `npm run check` — 423 files, 0 errors.
- Every rendering test mutation-checked against `EditorPane.svelte`: dropping
  `lspHoverExtension` reddens all three hover tests, dropping
  `lspCompletionExtension` both completion tests, no-op'ing
  `applyDiagnostics` both diagnostic tests. Recorded in the suite's docblock.

Found by looking, before a line was written:

- **CodeMirror's `hoverTooltip` underlines nothing.** `pos`/`end` on the
  returned tooltip decide when it *closes*; no decoration is applied.
  `CHANGELOG.md` `[Unreleased]` said "underlining exactly the span the server
  is talking about", `ROADMAP.md` said "highlighting the span", and
  `hover.ts` said "the highlight covers the symbol". All three corrected to
  what happens (the tooltip stays while the pointer is anywhere over the
  span), and the 2026-08-18 hover design note marked superseded on that
  point. Nobody had seen the tooltip, so nobody had seen that it did not.

Decided, and why (short form; the spec has the long one):

- **jsdom, not Playwright.** Two of three surfaces render under jsdom with no
  polyfill and the third with a one-rectangle one; zero new dependencies.
  Playwright against `npm run dev` would need a fake server injected into
  the web build, a browser download on every CI push, and still would not
  reach the WebView where both real rendering bugs lived. The next four v0.4
  features are wiring and text, which this harness reaches. Revisit —
  as vitest browser mode, which reuses the new seam — at the first feature
  whose *claim* is geometric.
- `ARCHITECTURE.md` §7's "Components embedding CodeMirror are untested" row
  was already false (`lsp-paint-target.test.ts` mounted `EditorPane`) and now
  states the real boundary. `CONTRIBUTING.md` allows a second jsdom file over
  the same component for a distinct named concern.

Next:

- Merge this, then the release ([Unreleased] holds hover, completion and the
  language-server support). Both need a push, which needs a human.
- Go to definition on the same door; then find references, rename.

Blocked:

- Nothing technical. Not pushed, no PR — by instruction.

Confidence:

- High on what the suite proves, because each test was made to fail first.
- Unverified, and now written down as such rather than as a gap: tooltip
  placement, and pointer→symbol mapping. Both are CodeMirror's.

---


## 2026-08-18 (later still) — Hover, and a shared-checkout collision

Shipped, on branch `lsp-hover`, in a **worktree** at `../nox-hover`:

- `src/core/lsp-hover.ts` — the three shapes of LSP `contents` reduced to
  ordered code/prose blocks. Pure.
- `src/editor/hover.ts` — the `hoverTooltip` source and its DOM.
- `completionCompartment` renamed `lspCompartment` and widened to hold both
  editor extensions, so the next feature is an array entry.

Verified:

- `npm test` — 1063 passed, 55 files. `npm run check` — 419 files, 0 errors.
- The no-HTML guard was checked by breaking it: swapping one `textContent`
  for `innerHTML` produces a live `<img onerror>` and a `<script>` element,
  and two tests fail. That is the assertion the design's §4 rests on.
- The language-tagged `MarkedString` branch was checked the same way; two
  tests fail, which is what renders a type signature as a paragraph.
- Against the real server: tsserver sends `MarkupContent` markdown **and**
  names a range. Both design assumptions held — unlike diagnostics, where the
  equivalent test found no `version` and turned a safeguard into dead code.

**Two sessions shared this checkout, and it went wrong three times.** Worth
writing down properly, because the lesson sharpened at each step:

1. My commit landed on the other session's branch, and `git add -A` swept its
   uncommitted work into mine.
2. It happened again with `git add <named files>` — nothing of theirs was
   captured, but it caught them with work *staged*.
3. Then the real lesson: **`git add <file>` scopes what you add; `git commit`
   commits the whole index.** A commit of mine carried four of their files
   purely because they were staged when I ran it. Found by auditing
   `git show --name-only` over every commit on the branch, and fixed by
   rebuilding it from the last clean commit — nothing had been pushed.

The fix that actually works: `git worktree add ../nox-hover lsp-hover`, plus
a **directory junction** for `node_modules` so there is no second install
(`New-Item -ItemType Junction`). The suite runs unchanged in it. Do this the
moment a second session starts, not after the third incident.

Next:

- **The tooltip has never been seen.** Same gap as the picker and the squiggle.
  A tag build and a human.
- Then go-to-definition, which is the same door and needs no new rendering.

Blocked:

- Nothing. Not pushed.

Confidence:

- High on the conversion and the source, both mutation-checked.
- Unverified: the tooltip rendering on a real hover.

---

## 2026-08-18 (later still) — The apt step that hangs

On branch `ci-apt-mirror-stall`, merged to `main` as #34. The
`rust (ubuntu-22.04)` job's dependency install hung five times in one day,
10-26 minutes against ~1.8 minutes healthy, each time needing a human to
cancel and `gh run rerun`.

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

Then confirmed on the real runners, two `workflow_dispatch` runs on the pushed
branch (32184094506 cold, 32184425793 warm), all ten jobs green:

- Cold: `Cache not found`, `Seeded 0`, `Fetched 52.8 MB in 51s`, then
  `Need to get 0 B/52.8 MB` for the install half. Step took 1m52s.
- Warm: `Cache hit`, `Seeded 122 package(s)`, `Need to get 0 B/52.8 MB`.
  **Nothing was fetched from the mirror at all.** Step took 1m09s.
- `--no-install-recommends` is worth more on the runner than in the container:
  137 packages and 55.6 MB become 122 and 52.8 MB. Fewer serial requests is
  the axis that matters, since the stall is per-request.
- **A PR run reads caches from its base branch, not from a sibling.** PR #34's
  own check therefore ran cold; the cache only starts serving PRs once `main`
  has run once and saved it. Confirmed afterwards on PR #35: `Cache hit`,
  `Seeded 122`, `Need to get 0 B/52.8 MB` on someone else's branch.
- The repo was at 9.8 GB of its 10 GB Actions cache limit, 7.71 GB of it stale
  `v0.4.1-*-test` tag caches. Cleared — a 50 MB apt cache was otherwise a
  plausible eviction, which would have quietly undone all of this.
- actionlint clean over both workflows — which, until the tag run below, was
  the only check `release.yml` got.

And `release.yml`, which had never run, exercised by a throwaway tag
`v0.4.1-apt-test1` off `main` (run 32207771888, since deleted along with its
draft and caches). All four platforms built:

- The `extra-packages: patchelf` input reaches the action — `EXTRA_PACKAGES:
  patchelf` — and takes its own cache key, `apt-jammy-patchelf-`, separate
  from CI's `apt-jammy-base-`. Worth keeping separate even though `patchelf`
  turns out to be preinstalled on the runner and downloads nothing.
- **The mirror degraded mid-run and the retry caught it**, unplanned. Two
  120s attempts at `apt-get update` timed out, the third got through at
  `Fetched 257 kB in 38s (6695 B/s)`, and the build went green with nobody
  watching. Cold path cost 6m24s. That is the whole point of the change,
  observed rather than argued.

Two things worth carrying forward:

- **Seed the apt cache after `apt-get update`, never before.** The first
  version seeded first and silently re-downloaded all 124 MB — an
  `APT::Update::Post-Invoke` hook can empty `/var/cache/apt/archives`. Caught
  only because the warm-cache run was actually executed rather than reasoned
  about.
- **`apt-get update` degrades too.** Every one of the five logged incidents
  sat in `apt-get install`, and the entry above says so — but the release run
  stalled in `update` instead, at 6.7 kB/s. The pattern held across five
  samples and still was not the rule. `update` is wrapped in the same retry
  on general principle, and that is the only reason that run passed.

Next:

- Watch whether a stall ever recurs on a *cold* cache. That is the only path
  still exposed, and it is now bounded at three 5-minute attempts rather than
  open-ended.

Blocked:

- `Acquire::ForceIPv4` is a hypothesis, not a measurement. Constant
  size-independent per-request latency is what a failed IPv6 connect followed
  by IPv4 fallback looks like, but the runner logs do not say so outright. It
  is harmless if wrong, and the cache does not depend on it being right.
  The release run degraded straight through it, so whatever it does, it is
  not a cure on its own — the cache and the retry are what carry this.

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

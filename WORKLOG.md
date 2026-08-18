# Work log

State between sessions. Newest entry on top, roughly ten kept.

Durable knowledge — decisions, gotchas, the reasons behind a design — belongs
in `docs/superpowers/specs/` and in commit messages. **This file is state; those
are knowledge.**

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

Debt, deliberate:

- The Windows `.cmd` fallback **compiles** on Windows CI but has never *run*.
  Nothing here can exercise it; only an installed build can.

Confidence:

- High on the protocol layer — it has now met a real server and been
  contradicted by it, which is worth more than the tests that agreed with me.
- Untested: `lsp.rs` supervision end to end, and the UI actually painting.

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

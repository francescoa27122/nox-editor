# Work log

State between sessions. Newest entry on top, roughly ten kept.

Durable knowledge — decisions, gotchas, the reasons behind a design — belongs
in `docs/superpowers/specs/` and in commit messages. **This file is state; those
are knowledge.**

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

- **Run it against a real `typescript-language-server`.** Everything is built
  and nothing has met a real server. That run is worth more than any further
  code, and it is what decides whether the design's assumptions hold — in
  particular full-text sync at 300ms on a large file, and whether tsserver's
  diagnostics carry the `version` the stale-batch check wants.
- Then the next v0.4 item: completion, which is the cheapest one to reach from
  here (`@codemirror/autocomplete` is already a dependency).

Blocked / unverified:

- **`src-tauri/src/lsp.rs` has never been compiled.** There is no cargo
  toolchain on this machine. Its nine framing tests have never run; CI is the
  first thing that will execute them. The framing *algorithm* was verified by
  porting `push` line-for-line to Python and running the same nine cases (9/9),
  which catches off-by-ones and says nothing about whether the Rust compiles.
- **No real language server has ever talked to this.** Every test is against a
  fake process or a Node script. The first run against
  `typescript-language-server` is the one that will find what the spec got
  wrong.
- Nothing is pushed. Three branches sit on top of `main`, unmerged.

Confidence:

- High on the TypeScript: red-green watched on every task, four mutation
  checks, and the full suite green.
- Medium on `lsp.rs`: the algorithm is verified, the Rust is not compiled.
- Low on the end-to-end claim. "Diagnostics appear" is true of the code paths
  and untested against a real server.

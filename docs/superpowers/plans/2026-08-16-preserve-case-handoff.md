# Preserve case — handoff

Written to move this work between machines. The SDD workspace
(`.superpowers/sdd/2026-08-16-preserve-case/`) holds the ledger and every task
report, and it is ignored through `.git/info/exclude` — a *local* file — so
none of it travels. Everything a fresh session needs is therefore here.

Delete this file when the branch merges.

## Where the work stands

Branch `preserve-case`, rebased onto `main` at 5029021 (PR #18, sticky scroll,
merged). Base is green: **844 tests / 35 files**, `npm run check` clean at 383.

| Task | State |
|---|---|
| 1 — the rule (`preserveCase` + option) | **complete**, review clean after 1 fix round |
| 2 — project panel (⌘⇧F) | **complete**, Approved after 2 fix rounds |
| 3 — editor panel (⌘F) | **complete**, review clean after 1 revert + 1 fix round |
| 4 — the walk | **complete** 2026-08-17 — all 17 items pass, nothing to fix |
| 5 — documentation | **complete** 2026-08-17 — CHANGELOG, ROADMAP, ARCHITECTURE; README deliberately untouched |

Commits on the branch, oldest first: the spec, the plan, a baseline
correction, `preserveCase` and its tests, the mutation-gap fixes, the project
panel, the preview and palette fixes, the expansion-order test, the §5
correction, the editor panel, and the read-by-shape fix.

## Task 4 — the walk (done 2026-08-17)

Walked on Windows against `npm run dev` at port 1420, driven through the real
UI — mouse on the toggles and buttons, keyboard in the fields and the editor.
`⌘` below is `Ctrl` on this machine. The document was read back out of
`EditorView.state` after each action rather than eyeballed, so every ✓ is the
actual buffer text.

**All 17 pass. Nothing needed fixing, so this task changed no code.**

| # | Result |
|---|---|
| 1 | ✓ `alpha one/two/three` → only the first `alpha` became `beta` |
| 2 | ✓ Second Replace advanced to 9–14 and wrote nothing twice |
| 3 | ✓ Replacing the last match wrapped the selection back to the first |
| 4 | ✓ Caret at 11 inside `alpha` (9–14) selected *that* match; the next Replace wrote it |
| 5 | ✓ Replace All over 4 matches, one Ctrl+Z restored all four |
| 6 | ✓ `scheduler/Scheduler/SCHEDULER/sChEdUlEr` → `dispatcher/Dispatcher/DISPATCHER/dispatcher` |
| 7 | ✓ `alpha([` shows "Bad pattern", both buttons disable, doc untouched; Enter and Ctrl+Enter in the fields also wrote nothing and threw nothing |
| 8 | ✓ `(\w+)\s+(\w+)` + `$2 $1` → `bar foo` — via Replace All **and** via single Replace. The Critical stays fixed |
| 9 | ✓ Caret at offset 3 in `foo bar`: selection stayed `[3,3]`, doc unchanged |
| 10 | ✓ Field held the literal `x\ny`; the document got a real newline |
| 11 | ✓ `café café` whole-word: 2 counted, both written |
| 12 | ✓ `cat\ndog` across two lines replaced; `mouse` untouched |
| 13 | ✓ Bare advance left `.cm-announced` empty; the replace put `replaced match on line 1.` in it |
| 14 | ~ Measured, not seen — see below |
| 15 | ✓ 13 matches over 5 files: `createScheduler`→`createDispatcher`, `SchedulerOptions`→`DispatcherOptions`, `Scheduler status`→`Dispatcher status`, every lower-case one stayed lower |
| 16 | ✓ Both halves: one Ctrl+Z took all 7 edits back in the open `index.ts` buffer, and the panel's Undo restored the four files that were not open |
| 17 | ✓ Toggling `AB` flipped the preview rows `Scheduler->dispatcher` → `Scheduler->Dispatcher`, and the write matched the preview exactly |

**Item 14, honestly.** The browser pane would not composite in this session,
so no screenshot was possible and nobody has *looked* at the toggle. What is
measured: the `AB` span is 12.8 × 10 px inside a 20 × 20 button — so it fits
with ~3.6 px either side — at `font-size: 10px`, weight 600, in
`rgb(76, 87, 104)`, the same faint colour as its three icon siblings, which are
also 20 × 20. It cannot clip or overflow. Whether it *reads* well at that size
is still an unanswered question for whoever next opens the app.

Below is the list as it stood before the walk, kept because the ⚠ notes explain
why those cases exist.

**⌘F — the editor panel**

1. Replace one match — only the right one changes.
2. Replace again — it advances rather than replacing the same match twice.
3. Replace at the last match — it wraps to the first.
4. Put the cursor on a match, then replace — it replaces *that* one.
5. Replace All — one ⌘Z takes the whole thing back.
6. `AB` on: `scheduler`, `Scheduler` and `SCHEDULER` each come back correctly
   shaped from one replacement string.
7. Invalid regex with regex mode on — it reports and replaces nothing.
8. ⚠ **Regex `(\w+)\s+(\w+)` replacing with `$2 $1` must produce `bar foo`,
   not the literal text `$2 $1`.** This is the Critical that shipped and was
   caught in review: `RegExpCursor`'s constructor returns an unexported
   `MultilineRegExpCursor` for any pattern containing `\s`, `\W`, `\D`, `\n`,
   `\r` or `[^`, so an `instanceof` check silently lost the match object and
   the template was written verbatim into the document.
9. ⚠ **Caret parked *inside* a regex match that spans it** — text `foo bar`,
   pattern `(\w+)\s+(\w+)`, caret at offset 3. Replace must move nothing and
   write nothing. This is what 17 selection mismatches were about.
10. ⚠ **`\n` typed in the replace field still inserts a real newline.**
    `SearchQuery.unquote` is `@internal` and nine characters of it are
    reproduced in `find.ts`.
11. ⚠ **`café café` with whole-word on replaces both.** Unicode word
    boundaries — a plain regex `\b` gets this wrong.
12. ⚠ **Regex `cat\ndog` across two lines replaces.** Multi-line matching is
    the capability the reverted first attempt destroyed.
13. Screen reader, if you can: replace should announce, and a bare advance
    should announce nothing.
14. Cosmetic: is `AB` legible at 10px inside the 20px toggle, beside its three
    icon siblings?

**⌘⇧F — the project panel**

15. Replace across files with `AB` on — each match keeps its own shape.
16. One ⌘Z takes the project replace back.
17. Toggle `AB` and watch the **preview rows** — they must show what replace
    will actually write. A preview that disagrees with the write was a defect
    fixed in Task 2.

`src/editor/find.ts` still has **no** automated tests; this walk was its only
coverage, and it is now spent — a later change to that file gets no warning
from it.

## Task 5 — documentation (done 2026-08-17)

- `CHANGELOG.md` — entry under `## [Unreleased]` → `### Added`, with the three
  shapes, the verbatim fourth case, the first-character-only rule, the
  independence from Match case, and the after-expansion ordering.
- `ROADMAP.md` — **Preserve case on replace** moved out of v0.3's pending table
  into `### ✅ Shipped in v0.3`, written like **Go to symbol** and **Sticky
  scroll**.
- `ARCHITECTURE.md` §4 — new decision *The editor borrows the match and owns
  the text*, placed after *Replace decides which text is authoritative*. It
  records the split the way §5 was **corrected** to describe it — replacement
  text is shared, matching stays on `@codemirror/search` — not the way the
  plan's Step 3 still words it. Also fixed a stale line in *Nox draws its own
  find UI* that claimed we keep CM's `replaceAll`. No §7 row: the last row of
  §7 already covers untested CodeMirror-embedding components.
- `README.md` — deliberately untouched. Its feature sections are whole
  capabilities and its table lists chords; this is a toggle with no chord
  (palette only, `search.togglePreserveCase`), so it would be the odd one out.

**The "nothing is pushed" line at the top of this file is stale, and it matters.**
`origin/main` is at `10a8cc0`, *Merge pull request #19 from
francescoa27122/preserve-case*, which took this branch as far as `3029d62` —
Tasks 1–3 and this handoff — into a **public** repo. So the feature code is
already shipped and the docs for it were not: until the two commits above land,
`main` describes an editor that behaves differently from the one it ships.

What is left is therefore a second, docs-only integration of `bfacff7` and
`5fb4363` — a local merge into `main`, or PR #20. Pushing is publication and is
the operator's call, per `CLAUDE.md`.

## Decisions a fresh session would otherwise re-litigate

- **Pattern precedence is all-lower → Capitalized → ALL UPPER → verbatim.**
  `S` satisfies two patterns because its remainder is empty; Capitalized wins,
  so one capital reads as a capitalised word rather than a shout.
- **The rule applies after regex expansion**, never to the template. Casing
  the template rewrites `$<word>` to `$<WORD>`, which names no group and
  resolves to empty — silent data loss.
- **Matching stays on `@codemirror/search`.** The spec's §5 originally said
  the editor would compute replacements through `core/replace.ts` outright.
  That was built, measured and reverted: `computeReplacements` is line-based,
  so it lost multi-line regex, `\n` unquoting and Unicode word boundaries.
  §5 records the reversal rather than hiding it.
- **`AB` renders as text, not an icon.** The icon set has no suitable entry
  and this repo resists adding them.
- **No `find.togglePreserveCase` command.** The find toggles have no commands
  in `app.ts`; only the search ones do. The project panel *did* get
  `search.togglePreserveCase`, because its four siblings are all commands.

## Known issues, not fixed

- **Enter in either find field hands focus to the editor, so the *next*
  keystroke types into the document.** Found during the walk. `#run` ends with
  `view.focus()` (`src/editor/find.ts:322`), which is right for the button
  paths and wrong for the keyboard ones: press Enter twice in the Find field
  expecting to step through two matches and the second Enter inserts a newline
  into the file. Reproduced deliberately — a stray `\n` landed in the buffer
  mid-walk that way.

  **This is not ours.** `git diff 5029021..HEAD -- src/editor/find.ts` leaves
  `#run` untouched; the behaviour predates the branch and applies equally to
  `next`/`previous`. Left alone rather than fixed inside a preserve-case task.
  The fix is presumably to focus the view only when the caller was not a
  field — which needs a decision about ⌘F's focus model, not a one-liner.
- **A rare flaky test.** Two independent sightings, roughly 1 in 10 or rarer,
  never reproduced across 6 full-suite and 8 isolated runs. Neither sighting
  captured the failing name. Likeliest suspects are
  `tests/symbols.test.ts`'s timing-dependent parse-budget test and
  `tests/folding.test.ts`. **If you see one unexplained red, re-run — and
  capture the test name**, which is what both sightings failed to do.
- **`previewReplacement`'s regex fallback** returns the raw, unexpanded
  template when no match lands at the column, so a preview can show a literal
  `$1` while the write substitutes it. Pre-existing, outside this feature.
- **A latent coupling in `find.ts`**: the reproduced `unquote` equals
  `SearchQuery.unquoted` only because `#build()` never sets `literal`. If a
  literal toggle is ever added to `FindOptions`, the wrap bound silently
  over-shoots.

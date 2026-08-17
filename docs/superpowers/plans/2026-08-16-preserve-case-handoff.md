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
| 4 — the walk | **not started** — needs a human at a real window |
| 5 — documentation | **not started** |

Commits on the branch, oldest first: the spec, the plan, a baseline
correction, `preserveCase` and its tests, the mutation-gap fixes, the project
panel, the preview and palette fixes, the expansion-order test, the §5
correction, the editor panel, and the read-by-shape fix.

## Task 4 — the walk

`npm run dev`, port 1420. Do **not** use `npm run app`.

The plan's list stands, and implementation added five cases to it. The ones
marked ⚠ came out of defects that were found and fixed; they exist because
something real went wrong there.

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

If anything fails, fix it in Task 4 with a test where one is possible and a
note where one is not. `src/editor/find.ts` still has **no** automated tests;
this walk is its only coverage.

## Task 5 — documentation

- `CHANGELOG.md` under `## [Unreleased]` → `### Added`. Worth saying: the
  three shapes it recognises, that irregular casing is left verbatim
  deliberately, that it is off by default, and that it works in both panels.
- `ROADMAP.md` — move **Preserve case on replace** from v0.3's pending table
  into `### ✅ Shipped in v0.3`, matching how **Go to symbol** and **Sticky
  scroll** are written there.
- `ARCHITECTURE.md` §4 — record that the editor's replace now takes its
  *replacement text* from `core/replace.ts` while its *matching* stays on
  `@codemirror/search`, and why that split follows the risk. Do **not** add a
  §7 debt row; the untested-editor-view boundary is already recorded.
- `README.md` only if it lists features at this level of detail.

Then push and open the PR. Nothing is pushed beyond this branch.

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

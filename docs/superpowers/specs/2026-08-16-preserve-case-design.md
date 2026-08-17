# Preserve case on replace — design

Replacing `Scheduler` with `dispatcher` should give you `Dispatcher`, not
`dispatcher`, when the search was case-insensitive.

Status: approved 2026-08-16. Implementation follows in a separate plan.

The first of the four items left in **v0.3 — Navigation at scale**. It is the
smallest of them, and it turned out to carry a decision much larger than the
feature: Nox has *two* replace implementations, and this is the thing that
makes them one.

Everything below was checked against the two replace paths and the installed
`@codemirror/search` rather than remembered.

## 1. Why this, and what it is not

A case-insensitive search finds `scheduler`, `Scheduler` and `SCHEDULER`.
Replacing them all with one literal flattens three distinct spellings into
one, and the user then fixes the capitals by hand — which is the work the
search was supposed to save.

It is not a rename refactor, not identifier-aware, and not a code
transformation. It reads the case of the text it is replacing and applies that
shape to the replacement. Nothing about it knows what a symbol is; v0.4's LSP
rename is the thing that will.

## 2. Scope

In:

- `preserveCase(matched, replacement)` — a pure function, three patterns.
- A `preserveCase` option on both replace paths, off by default.
- An `AB` toggle in the find panel and the search panel.
- **Both replace surfaces sharing one implementation** — §5, and the real
  substance of this design.

Out, and deliberately:

- **Per-segment camel/snake/kebab mapping.** `Scheduler_Service` →
  `Dispatcher_Service` needs a segmentation rule, and a replacement with a
  different number of segments than the match is genuinely ambiguous. §4 says
  why the three-pattern rule covers more than it appears to.
- **Matching VS Code's behaviour exactly.** Its preserve-case is defined by
  its implementation rather than a stated rule; tests written against it would
  pin quirks rather than intent.
- **Preserving case in the search *query*.** This is about the replacement.

## 3. What already exists

Verified, not assumed.

| Seam | Where | What it gives us |
|---|---|---|
| Pure replacement primitives | `src/core/replace.ts:33,61,101` | `expandReplacement`, `computeReplacements`, `applyEdits` — total functions over strings, already the single place that decides *what* the new text is |
| Its test suite | `tests/replace.test.ts` | 43 tests over the project path |
| Project replace | `src/services/search.ts` | The **only** importer of `core/replace.ts` |
| Editor replace | `src/editor/find.ts:4-5` | Imports `replaceNext` and `replaceAll` from `@codemirror/search` — a separate implementation |
| Option shapes | `src/editor/find.ts:24`, `src/services/search.ts:22` | `FindOptions` and `SearchOptions`, both already carrying `caseSensitive`, `wholeWord`, `regexp` |
| Toggle precedent | `src/ui/FindPanel.svelte:89-93` | `class:on`, `aria-pressed`, `onclick={() => find.toggle('caseSensitive')}` |

**And one absence that shapes the whole design:** nothing in `tests/` touches
`src/editor/find.ts`. The editor replace path has no automated coverage at all.

## 4. The rule

Three patterns, read from the **matched text**:

| The match is | The replacement becomes |
|---|---|
| all lower case | lower-cased |
| ALL UPPER CASE | upper-cased |
| Capitalized — first character upper, the rest lower | first character upper, the rest as typed |
| anything else | verbatim |

A match containing no letters at all is "anything else". That case is not
theoretical: `123` is simultaneously equal to its own upper- and lower-cased
form, so a rule written as `matched === matched.toUpperCase()` alone would
upper-case every replacement in a numeric search.

**Capitalized leaves the remainder alone rather than lower-casing it**, so
`Scheduler` → `dispatcherService` gives `DispatcherService` rather than
`Dispatcherservice`.

**Why three patterns cover more than they look like.** You preserve case from
the *match*, and matches are usually single tokens. Searching `scheduler`
case-insensitively finds exactly `scheduler`, `Scheduler` and `SCHEDULER`.
Inside `schedulerService` the match is the all-lower substring `scheduler`, so
the replacement is lower-cased and the identifier survives intact. The
multi-segment case only arises when the whole identifier is the match, which
is the rarer search.

**The feature overrides the replacement's own casing, by design.** With
preserve-case on, a deliberately-typed `Dispatcher` will be lower-cased when
it replaces `scheduler`. That is the contract, not a bug — and it is why the
option is off by default and has a visible toggle.

## 5. One implementation, two surfaces

This is the decision the feature exists to force.

Nox has two replace paths that share no code: `services/search.ts` computes
replacements through `core/replace.ts`, and `editor/find.ts` delegates to
`@codemirror/search`'s `replaceNext`/`replaceAll`. Adding preserve-case to
`core/replace.ts` alone would make the `AB` toggle work in ⌘⇧F and silently do
nothing in ⌘F.

**Both paths will compute their replacement *text* through `core/replace.ts`.
Matching stays where it is.**

**This section originally said something stronger and it was wrong.** It said
both paths would compute their replacements through `core/replace.ts`
outright — that the editor would stop using `@codemirror/search` for replace
entirely. That was built, measured, and reverted. Recorded here rather than
quietly rewritten, because the reasoning that produced it is the kind that
looks strongest right before it fails.

`computeReplacements` is line-based — `text.split('\n')`, one matcher pass per
line. `@codemirror/search` has a `MultilineRegExpCursor` that flattens chunks
across line boundaries, a `SearchQuery.unquote` that turns `\n` and `\t` in
the find and replace fields into real characters, and a Unicode character
categorizer behind `wholeWord` rather than a plain regex `\b`. Routing ⌘F's
replace through the shared function therefore **loses working capability**:
multi-line regex replace, `\n` unquoting, and correct word boundaries outside
ASCII.

Measured on the reverted implementation, with the find panel's counter still
reading from `SearchQuery`: `café café` with whole-word on counted 2 matches
and replaced 0; regex `cat\ndog` counted 1 and replaced 0. So the divergence
this section exists to eliminate did not disappear — it moved *inside* the
find panel, as a silent no-op in a destructive command. Worse than the problem
it was solving.

**The corrected split follows the actual risk.** The danger was never in
computing the replacement text; it is in matching. So `editor/find.ts` keeps
`SearchQuery` and its cursor for finding matches — the same query the counter
and the highlights already use, so those three can never disagree — and uses
`expandReplacement` and `preserveCase` from `core/replace.ts` for each match's
replacement text, dispatched as one transaction.

What that gives up is this section's original claim that the two panels can
never diverge on regex expansion or zero-width handling. They still can. That
is a real cost, and it is smaller than the capabilities the stronger version
destroyed.

The alternative considered and rejected was writing a second preserve-case
implementation against `SearchCursor` for the editor path. That duplicates
replacement semantics into the file with **zero tests**, to sit beside a path
with 43 — precisely the wrong direction.

Sharing also closes a divergence nobody would defend if asked. Today the two
panels agree about regex expansion, zero-width matches and edit ordering only
because two implementations happen to. `core/replace.ts` skips zero-width
matches for a stated reason and expands `$1`/`$&`/`$<name>`/`$$` by its own
rules; `@codemirror/search` has its own. Nothing tests that they agree, and
nothing would tell us if they stopped.

This is the fourth time this repo has moved a decision to where it can be
tested — `symbolListState` out of `CommandPalette`, `answerFreshness` out of
`AnswersPanel`, `stickyRows` out of the sticky panel. The difference here is
that the destination already exists and is already tested.

## 6. What the editor path keeps, and what it gives up

The editor command stops owning *what the new text is* and keeps owning *which
match and where the view goes*:

- **Taken from `core/replace.ts`:** the replacement text for each match —
  `expandReplacement` for `$1`/`$&`/`$<name>`, then `preserveCase`.
- **Kept on `@codemirror/search`:** finding the matches at all. `SearchQuery`
  and its cursor stay, so multi-line regex, `\n` unquoting and Unicode word
  boundaries keep working, and the counter, the highlights and replace all read
  the same query.
- **Kept in `editor/find.ts`:** which match is current, advancing to the next,
  wrapping at the end of the document, scrolling the result into view, and
  leaving the selection where a user expects after a replace.

**This section originally listed regex expansion, zero-width handling and edit
ordering as given up too, and the matching as ours to own.** That was the
version §5 records as reverted. The corrected boundary is narrower and follows
the risk: replacement text is shared, matching is not.

The remaining risk is the third list — the view behaviour we already own and
no headless test reaches, in a file with no tests. Smaller than it was, because
replace now walks the same cursor `selectAllMatches` already walks rather than
a second matcher built from scratch.

**Mitigation is a walk, not a test.** §9 says what the walk must cover.

## 7. Where the rule is applied

After expansion, to the fully-expanded replacement, using the match's own text.

That order is safe under §4's rule, and the reason is worth recording because
the opposite order looks more careful and is not. Applying case to a
`$1`-expanded string cannot mangle the captured text: if the match is ALL
UPPER its captures are upper too, so upper-casing them changes nothing; if all
lower, likewise; Capitalized touches only the first character; and anything
mixed is verbatim. Applying the rule *before* expansion would instead case the
template — turning `$1` into `$1` and the literal parts inconsistently, and
leaving the captured text untouched, which is the mangling the careful-looking
order was trying to avoid.

## 8. The toggle

`AB`, beside the existing case/word/regex toggles in both panels, following
`FindPanel.svelte:89-93`'s shape exactly — `class:on`, `aria-pressed`, and a
`toggle('preserveCase')` call.

**Independent of `caseSensitive`.** With a case-sensitive search every match
already has the query's exact case, so preserve-case simply re-derives that
shape; the result is predictable rather than special. Gating one toggle on
another is a rule to explain, and this feature does not need one.

Off by default. It changes what replace writes, and a destructive default that
surprises people is worse than one more click.

## 9. Testing

- `preserveCase` exhaustively, headless: each of the three patterns, the
  mixed-case fall-through, the no-letters case, an empty replacement, and a
  match that is a single character.
- Through `computeReplacements`: that the option is applied per match, so one
  replace run can produce `dispatcher`, `Dispatcher` and `DISPATCHER` from one
  replacement string.
- Through `computeReplacements` with regex expansion on, pinning §7's order —
  including the ALL-UPPER-with-captures case, which is the one that would
  reveal a wrong order.
- That `preserveCase: false` leaves every existing behaviour byte-identical.
  The 43 existing tests are the real guard here and must not be edited.

**The editor path's view behaviour gets no automated test** — `editor/find.ts`
has none today and this design does not add the harness that would change
that. It is verified by walking: replace one match, replace all, replace at
the end of a document so it wraps, replace with a selection already on a
match, and confirm the view scrolls and the selection lands where it did
before the change.

That walk is the only thing standing between this refactor and a regression in
a destructive path, so it is not optional and it is not a formality.

## 10. Files

New:

- `tests/preserve-case.test.ts`

Changed:

- `src/core/replace.ts` — `preserveCase`, and a `preserveCase` option on `computeReplacements`
- `src/editor/find.ts` — replace commands built on `core/replace.ts`, `preserveCase` on `FindOptions`
- `src/services/search.ts` — `preserveCase` on `SearchOptions`, threaded through
- `src/ui/FindPanel.svelte`, `src/ui/SearchPanel.svelte` — the `AB` toggle
- `README.md`, `CHANGELOG.md`, `ROADMAP.md`, `ARCHITECTURE.md` §4

Not changed:

- `tests/replace.test.ts`. Its 43 tests are the evidence that the shared path
  still behaves as it did. If one needs editing, that is a finding to report,
  not a licence.

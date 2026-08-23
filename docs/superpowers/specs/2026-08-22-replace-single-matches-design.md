# Replace individual matches — design

The search panel can exclude a *file* from a replace. It cannot exclude a
*match*. This closes that, and adds the one-match replace the row's title
promises.

Status: approved 2026-08-22. The last unshipped row of **v0.3 — Navigation at
scale** that is not "nested splits".

Everything below was checked against `src/core/replace.ts`,
`src/core/search-match.ts`, `src/services/search.ts` and
`src/ui/SearchPanel.svelte` rather than remembered.

## 1. Why this

Project replace is the most destructive thing in the app, and today it is
all-or-nothing per file. A search for `needle` across a repository routinely
finds forty places, thirty-eight of which you want and two of which are in a
vendored file, a fixture, or a comment that means something else. Dismissing
the whole *file* throws away the thirty-eight; there is no way to say "not
that one".

The affordance already exists one level up — the `×` on a file row — and the
pure layer already accepts the exclusion. What is missing is the state in
between.

## 2. What already exists

Verified, not assumed.

| Seam | Where | What it gives us |
|---|---|---|
| `skip` on the replacement primitive | `src/core/replace.ts:113` | `computeReplacements(text, matcher, replacement, { skip })` already omits the indices it is handed, is documented as walking "in exactly the order `findMatches` does", and is covered by `tests/replace.test.ts:112` and `tests/preserve-case.test.ts:180`. **No caller passes it.** |
| The identical walk | `src/core/search-match.ts:84` | `findMatches` and `computeReplacements` are the same loop — `text.split('\n')`, `matcher.exec` per line, zero-width skipped, index incremented per kept match. Given one text and one matcher, the *n*th `LineMatch` and the *n*th skip index are the same match by construction. |
| File-level dismissal | `src/services/search.ts:251` | `dismissFile` — the shape and the vocabulary this copies. |
| Row rendering | `src/ui/SearchPanel.svelte:497-524` | A match row already carries `line`, `column`, `length`, `preview`, `previewOffset`, and the file row already carries two `row-action` buttons to copy. |
| Replace plumbing | `src/services/search.ts:432` | `#replacePaths` — one job that reads, computes and returns a plan; the main path applies it. Adding a per-file skip set changes what it computes, not how it applies. |

## 3. Scope

In:

- **`dismissMatch(path, match)`** — take one match out of the results *and*
  out of any replace that follows.
- **`replaceMatch(path, match)`** — replace exactly that one.
- A `×` and a replace button on each match row, mirroring the file row.
- The pending count, the file-row badge and the summary all counting what will
  actually happen.

Out, and deliberately:

- **Persisting dismissals across a re-run.** A new search is a new question;
  `run()` already clears results, collapse state, focus and the replace undo,
  and the dismissed set clears with them.
- **Un-dismissing.** There is no undo for `dismissFile` either. Re-running the
  search is the way back, and the panel's `↻` does it in one click.
- **Dismissing a range of matches.** Shift-click multi-select in the results
  list is its own feature; nothing else in the panel has it.

## 4. The decision that matters: indices are recomputed, never remembered

`#replacePaths` deliberately does **not** trust the stored result rows — it
re-reads the file and recomputes, because a file edited since the search would
otherwise be rewritten from stale coordinates. That is also why the replace
source prefers an open buffer over disk while the *results* came from disk.

So a dismissal cannot be stored as "index 3 of file X". Index 3 of the results
and index 3 of the text being replaced are the same match only while nothing
has moved.

A dismissal is therefore stored as an **identity**: `path`, 1-based `line`, and
the absolute column (`previewOffset + column`, since a long line's `column` is
relative to a windowed preview). At replace time the file's *current* text is
walked with `findMatches` — the same function, so the same order — and each
result is tested against that identity set. The indices handed to `skip` are
the positions in *that* walk.

**When an identity cannot be found, the file is refused, not replaced.** If a
dismissed match is no longer at the line and column it was dismissed at, the
file has moved under the exclusion and Nox does not know which text the user
meant to protect. Replacing the rest would be replacing something they said not
to. It joins `failed`, which the toast already reports, and the file stays in
the results.

That is the same rule rename uses for a file edited during review, and the same
rule `undoLastReplace` uses when a file no longer says what the replace left
there: when the world has moved, refuse rather than guess.

## 5. `replaceMatch` is `skip` inverted

Replacing one match is "skip every index except this one" over the same
recomputed walk. It is the same code path with the complement of the set, which
is why it costs a method rather than a mechanism, and why it inherits the
staleness refusal for free: a one-match replace whose match is no longer where
it was does nothing and reports the file as failed.

## 6. Counting

`pendingReplaceCount` drives the "Replace all (N in M files)" title, and the
file row shows `file.matches.length`. Both read `results`, and `dismissMatch`
removes the match from `results` — so both stay correct with no arithmetic of
their own. The dismissed set exists only to be turned into skip indices; it is
never a second source of truth about what is on screen.

A file whose last match is dismissed leaves the results entirely, exactly as
`dismissFile` would have left it.

## 7. Failure paths

| Case | Behaviour |
|---|---|
| Dismissed match no longer at its line/column (file edited, buffer dirty) | File refused; reported in `failed`; results untouched |
| Every match in a file dismissed | File leaves the results; a later `replaceAll` never names it |
| `replaceMatch` on a match that has moved | Nothing written, file in `failed` |
| Search re-run | Dismissed set cleared with the results |
| Dismissed match in a file that is also dismissed | No interaction; the file is not in `results`, so no path names it |

## 8. What identity matching cannot do

An identity is a line and a column, so an edit that moves a *different* match
onto exactly the line and column the excluded one occupied will exclude that
one instead. Deleting a line above a match, when the match below happens to
share its column, is the realistic case.

This is not fixable by making the key richer — the surrounding text, a hash of
the line — without deciding what "the same match" means across an edit, which
is the identity problem CodeMirror solves with position mapping and which
nothing here has, because the results came from disk and the replace may read
a buffer.

It is bounded, and bounded in the safe direction: the run still replaces
exactly the matches the pattern finds, and the exclusion still lands on *a*
match the user could see. What it can get wrong is *which* one. Anything less
locatable than that — the match simply gone, or moved — is refused outright
(§4). Recorded in the debt table.

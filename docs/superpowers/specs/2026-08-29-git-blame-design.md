# Git blame — design

Who wrote each line, in a gutter beside it, on demand. The last unshipped
row of the v0.5 table, and the fifth git surface after the gutter, the diff
view, stage/commit and the `.git` meta watch.

Status: decided 2026-08-29. Everything named here was read in the file it
names, and every claim about git's behaviour below was run against real git
(2.43) before being written down.

## 1. What it is

`git.toggleBlame` (`Mod+Alt+B`, the palette, the editor's context menu)
switches a column on beside the active buffer. Each line carries the short
hash and the author of the commit it came from; the full identity, the
author-local date and the commit subject are in the marker's `title`. A line
that is in no commit reads **Uncommitted**, dimmed and italic.

**On demand, not always on** is the row's own constraint, and it is
structural rather than a default: nothing in `GitService` ever *starts* a
blame except `toggleBlame`. Opening a file, editing it, saving it and
committing all cost zero `git blame` invocations for a buffer the user has
not asked about.

**Per buffer, not global.** A global switch would spawn a blame for every
file opened afterwards, including the ones only tabbed through.

## 2. The one Rust command

`src-tauri/src/git.rs`, registered in `lib.rs`:

```rust
#[tauri::command(async)]
pub fn nox_git_blame(path: String, contents: String) -> Result<Option<String>>
```

Three decisions, in descending order of how much they matter.

**`--contents -`, so the buffer is blamed rather than the file.** The gutter
draws beside what is *open*; `git blame <path>` describes what is *saved*.
The moment those differ — any unsaved insertion or deletion — blaming the
saved file misaligns every annotation below the first one, and a gutter that
names the wrong person is worse than no gutter. git's `--contents` blames the
text it is handed against the path's history and attributes lines that are in
no commit to the all-zero object name. Verified live:

```
$ printf 'alpha\nINSERTED\nbravo\ncharlie\n' | git blame --porcelain --contents - -- app.ts
611b213a… 1 1 1        # alpha, from the commit
0000000000000000…  2 2 1   # INSERTED — in no commit
611b213a… 2 3 2        # bravo, original line 2, now line 3
```

So alignment is exact by construction and "not committed yet" is a fact git
computed rather than one the renderer inferred.

**`#[tauri::command(async)]`, the only one in the crate.** A sync command
body runs inline on the thread that handles the IPC message, which is the
main thread — verified in `tauri-macros` 2.6.3, where the default
`ExecutionContext::Blocking` emits `let result = $path(…)` straight into the
handler and `(async)` routes it through `respond_async_serialized`, which
spawns. For every other git read here that is a non-issue: `git show :0:` and
`git status` cost one blob and one index scan. Blame is the first git read in
this codebase whose cost follows a file's *history* rather than one blob. The
function stays `pub fn` — there is nothing to await and nothing to cancel, so
the reason the rest of the crate avoids `async fn` does not apply.

**Stdin is written on its own thread.** Measured: git 2.43 consumes the whole
of `--contents -` before emitting anything, so 440 KB completes a sequential
write with nothing draining stdout. The thread stays anyway, because that is
a property of git's buffering rather than of its interface, and the output is
larger than the input — if any git ever streams while still reading, a
sequential write deadlocks. The measurement is recorded in the doc comment so
nobody has to re-derive it to justify the thread.

`None` for everything that is not blame output — no repository, untracked, no
git — the same degraded state `nox_git_file_base` promises, so no failure here
can become a dialog. `from_utf8_lossy`, unlike `nox_git_file_base`'s strict
decode: porcelain interleaves the *file's own content* with the headers, so
one Latin-1 line in an ordinary source file would fail a strict decode and
blank the whole blame; the parser drops every content line, so a replacement
character can only land where nothing reads.

`repo_and_relpath` was factored out of `nox_git_file_base` rather than copied.
The two must agree about what "inside this repository" means, or a file could
have a gutter and no blame for reasons neither states.

## 3. Platform

`gitBlame(path, contents): Promise<string | null>` on the interface, a
four-line adapter in `tauri.ts`, and a real renderer in `memory.ts`.

The fake is the part worth arguing. `seedGitBlame(path, lines)` takes one
commit per line and `gitBlame` renders **real porcelain** from it: the group
count on a group's first line and nowhere else, a commit's metadata block
exactly once however many groups it owns, the blamed text tab-prefixed under
each header. A fake that emitted a convenient shape — one tidy block per line
— would let a parser that mishandles the real thing pass the entire suite.
That is not hypothetical; it is the failure mode this codebase has already
been bitten by, and the reason `seedGitConflict` carries the comment it does.

The fake does not re-derive attribution from `contents`: there is no history
here to diff against, and inventing one would be modelling git rather than
answering a lookup. A test that wants the unsaved-insertion case seeds the
zero-hash entry itself.

## 4. The pure core — `src/core/git-blame.ts`

`parseGitBlame(raw)` → one `BlameLine` per line, each holding a `BlameCommit`.

**One object per commit, shared by every line it owns.** A file with 200,000
lines and 80 commits costs 80 objects and 200,000 references. It is also what
makes the late-metadata case work: git states a commit once, at its first
group, and the lines parsed before that are holding the object rather than a
copy of it.

**`--porcelain`, not `--line-porcelain`.** The line variant repeats a
commit's whole header block for every line it owns, multiplying the payload
by each group's size for no extra fact.

**`uncommitted` is read off the hash, never the author.** git names that
author differently depending on how it was asked — `Not Committed Yet` when
blaming a dirty worktree, `External file (--contents)` when blaming supplied
text, which is how Nox always asks. Keying on the name would have worked in a
fixture and failed in the product.

`blameDate` shifts by `author-tz` and then reads in UTC, so the date is the
author's own — git blame's own default. The alternative, the reader's local
zone, would make one line show two dates on two machines looking at one
repository.

`blameLabel` pads to a fixed width. CSS elision bounds a column's width; it
does not fix it, and a column that follows its widest *visible* marker
changes width as you scroll and shoves the code sideways.

Guarded in `tests/complexity.test.ts`: a full re-scan in place of the commit
map reports 63.6x for 8x the input and fails the 24x budget.

## 5. The service — `src/services/git.ts`

One signal: `blame: Signal<ReadonlyMap<BufferId, readonly BlameLine[]>>`.
**An entry is the switch** — present means the gutter is showing, absent
means it is not, and there is no second flag that could disagree. The array
is empty between the toggle and git's answer, and stays empty when git had
none, so a file outside a repository turns the column on and shows nothing.

Fetch triggers, and deliberately no others: the toggle, `saved`,
`external-change`, and `refreshAll` (which covers the `.git` meta watch, the
palette refresh, and every stage or commit). **Never an edit** — recomputing
means spawning a process, so between fetches the marks map in the editor
instead.

Two races, both closed:

- **The answer describes older text.** git blames what the request carried,
  so a *line* typed while it was working leaves everything below one row out.
  `#refreshBlame` records the revision it asked at and re-asks once, with
  fresh text, when it moved. It cannot loop: no edit triggers a fetch, so a
  second stale answer is simply painted and corrected at the next save.
- **The answer arrives after the user switched it off.** `blameShown` is
  re-checked after the await; without it the entry goes straight back into
  the map and the column reappears on its own.

`MAX_BLAME_BYTES` (2 MB) is a knowing proxy: blame's real cost is history,
which nothing cheap can measure ahead of the walk, but size bounds the two
things certainly proportional to it — the text sent to stdin and the larger
stream that comes back.

## 6. The editor extension — `src/editor/git-blame.ts`

The git gutter's shape: an effect-fed `StateField` of per-line marks and a
`gutter` that paints them. A sibling, not an extension of it — that one
answers "what does git not have yet" from a diff Nox computes, this one
answers "who wrote this" from a walk only git can do.

**Marks are per line, not per group**, and that is the whole of the
correctness argument. Blame arrives run-length encoded and one wide range per
run would be a fraction of the marks — but a range *grows* when text is
inserted inside it, so a line typed in the middle of a run would inherit the
run's commit. A point mark at each line start cannot do that: an inserted
line simply has no mark and shows nothing, which is the truth until the next
fetch.

Markers are cached per commit in a `WeakMap`, keyed on the object the parser
shares, so a 4,000-line file with 60 commits builds 60 markers.

`initialSpacer` holds the column open at its final width from the moment the
gutter is installed; without it the column is zero-wide until the marks
arrive and then jumps, shoving the code sideways — on a large repository,
seconds after the toggle. Every label is the same length, so one spacer is
exactly right.

The field is installed unconditionally in `staticExtensions` and only the
rendering is compartmentalised — removing a `StateField` destroys what it
holds. `blameCompartment` is reconfigured by `EditorPane`, not from
`Settings`: blame is per-buffer runtime state, not a preference, which is why
it has no entry in `SETTING_TO_COMPARTMENTS` and no row in the schema.
`lspCompartment` is the same arrangement for the same reason.

`EditorPane#paintBlame` dispatches the reconfigure and the marks in **one**
transaction: a gutter installed a tick ahead of its marks flashes empty, and
marks dispatched into a state whose gutter has just gone are drawn by
nothing. It is re-applied after `syncToBuffer`'s `setState`, which resets
every compartment.

## 7. What is tested, and how

- `tests/git-blame.test.ts`: the parser, against porcelain captured verbatim
  from real git — including the bare repeat record that decides whether the
  parser remembers commits — plus the timezone, padding and truncation rules.
- `tests/git-service.test.ts` (`the blame gutter´s service half`): that
  nothing is fetched before the toggle, that the *buffer's* text is what is
  sent, the save refetch, the size cap, the root reset, and both races. The
  two race tests carry their mutation checks.
- `tests/git-blame-render.test.ts` (jsdom, real pane): the column appears on
  toggle and goes away again, the labels and `title` are right, marks shift
  and claim nothing for an inserted line, and the gutter survives a tab swap
  in both directions. This is the only coverage of the compartment wiring.
- `tests/complexity.test.ts`: `parseGitBlame` stays linear.
- `src-tauri/src/git.rs` `#[cfg(test)]`: nine tests on all three CI
  platforms. Three earn their place beyond the ordinary cases. The **format
  tripwire** — that git states a commit once and reduces repeats to a bare
  header — defends the parser's foundation, and no TypeScript fixture can,
  because a fixture is written to whatever shape the parser expects. The
  **unsaved-insertion** test pins `--contents` doing what §2 says it does.
  And the **meta-watch** test holds blame to the quiet `nox_git_status`
  already promises, because an event there makes the service re-blame, which
  would feed the watch that triggered it. That last one records what it does
  *not* establish: deleting `GIT_OPTIONAL_LOCKS=0` from the command leaves it
  passing, because `git blame` does not take `index.lock` the way
  `git status` does.

## 8. Not in this

- A commit viewer. Clicking a blame entry does nothing; the hash and subject
  in the `title` are the whole answer, and showing a diff for a commit is the
  diff view's shape, not this one's.
- Blame in the diff view, or following a line through a rename (`-C`, `-M`).
- A status-bar or panel presentation. The gutter is the surface.
- Any setting. The label's shape is a design decision rather than a
  preference, and the switch is per buffer and per session by intent.

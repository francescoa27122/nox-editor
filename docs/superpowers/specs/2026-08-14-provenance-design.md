# Change provenance — design

Make the transaction log's recorded authors visible in the editor: a quiet
gutter mark on lines a change set touched, a tooltip saying who and why, and
two commands to walk between them.

Status: approved 2026-08-14. Implementation follows in a separate plan.

## 1. Why this, and why now

`transactions.ts` already argues for it, in its own words:

> an edit with no recorded author is an edit nobody can review. That an agent
> will later be one of those authors is a consequence, not the reason.

Nox records every programmatic edit as a change set with an author, and then
shows the user none of it. `changeSetAnnotation`'s doc comment names the
missing half — *"read by anything that needs to tell a programmatic edit from
typing — attribution decorations, and the log itself"* — and only the log was
built.

This is an editor feature, not an AI feature. It earns its place on a project
replace, which is the only thing that produces change sets today. That it is
also the substrate that makes agent edits reviewable is, as the file says, a
consequence rather than the reason.

### The governing principle

Context without demand. This is somewhere to look when you are curious, not
something that competes for attention while you work. Every decision below
that could go either way went the quiet direction.

## 2. Scope

**In:**

- A gutter mark on every line a change set touched, in the current session
- A hover tooltip: who, what the change was called, and when
- Two commands to move between marked regions
- A command to clear the marks
- A setting to turn the gutter off

**Out, deliberately:**

- Persistence across restarts (see §3)
- Reverting a single change set — inverting a set whose positions later edits
  have moved needs conflict handling, and CodeMirror's undo already covers
  "take that back right now"
- A log panel listing change sets — the marks plus navigation may make it
  redundant; revisit once this has been used
- Any inline treatment of the text itself (see §6)

## 3. Lifetime: the session, and no longer

Provenance lives in the buffer's `EditorState` and dies with it — on restart,
and when the tab closes.

This follows the reasoning already written into `TransactionLog`:

> Undo history does not survive a restart, so a log that did would list changes
> it could not undo — and a button that lies is worse than one that is absent.

Persisting authorship would decouple it from undoability: you would know who
wrote a line long after you could take it back. That is a defensible feature
and a much stronger differentiator, but it brings a staleness problem this
first cycle should not take on. A `git checkout`, a formatter, or an edit in
another editor invalidates stored ranges, and provenance that is confidently
wrong is worse than provenance that is absent — the same argument, one level
up.

The data model below is shaped so persistence is additive later: the range
values already carry everything a persisted record would need.

### Known limit: open buffers only

Provenance exists where an `EditorState` exists. A project replace across 200
files with 3 of them open marks those 3; the other 197 are written straight to
disk by `search.ts` and never become a change set at all.

This is stated rather than worked around. Extending provenance to unopened
files would mean persisting it, which §3 rules out for this cycle.

## 4. Data model

```ts
/**
 * What a marked range knows about itself.
 *
 * Denormalised on purpose: the editor layer never looks anything up. The log
 * is bounded at 200 entries, so a change set can rotate out of it while its
 * marks are still on screen — a tooltip that went blank when that happened
 * would be its own small lie.
 */
export interface Provenance {
  changeSetId: ChangeSetId;
  /** Drives the mark's appearance; `user` and `agent` read differently. */
  authorKind: Author['kind'];
  /** `authorLabel(author)` — "You", the agent's label, a plugin id. */
  authorLabel: string;
  /** The change set's description: `Replace "foo"`. */
  description: string;
  at: number;
}
```

Held as a `RangeSet<Provenance>` in a `StateField`.

## 5. Where it lives, and why a StateField

`src/editor/provenance.ts`, a `StateField<RangeSet<Provenance>>`.

**Not a `ViewPlugin`.** `search-highlight.ts` uses one because matches are
*derivable*: given the query and the document you can always recompute them.
Provenance is not derivable. Once a change set is applied, nothing in the
document remembers who did it — it has to be recorded as it happens and
carried forward.

A `StateField` gets the carrying-forward for free. CodeMirror maps a
`RangeSet` through every subsequent change, which is exactly the
position-mapping problem that would otherwise dominate this work. It also
means background buffers accumulate provenance correctly, because the
workspace updates `buffer.state` whether or not a view exists.

Rejected: **a position index maintained in the workspace.** It would
reimplement `RangeSet.map` by hand and force the workspace to intercept every
transaction to keep it current. Strictly worse, with no compensating benefit.

### The update rule

On each transaction, in order:

1. Map the existing set through `tr.changes`.
2. If the transaction carries `changeSetAnnotation`, add a range over each
   inserted region, valued with the change set's `Provenance`.
3. Otherwise — a user edit — **subtract every changed range** from the set.

**A change set that only deletes leaves no mark.** There is no inserted region
to cover, and a zero-width mark at the deletion point would render as a bar on
a line whose text nobody authored — the same ghost §5 rules out below. A
replace that swaps text for shorter text still marks what it inserted; a
replace that deletes outright marks nothing, and the deletion is visible in the
document itself. This is a real gap in coverage, accepted rather than papered
over: marking absence would cost more honesty than it buys.

Step 3 is the part most likely to be subtly wrong, and it is not free.
CodeMirror's default mapping *extends* a mark when you type inside it, which
is the opposite of what was chosen: touching a line takes ownership of it. The
marks must decay toward zero as you work through a change, or an empty gutter
stops meaning anything.

A deletion that removes a marked range entirely must leave nothing behind — a
zero-width mark would render as a bar on a line nobody authored.

## 6. Surfaces

### The gutter

A new gutter, to the right of the line numbers, showing a 2px bar on every
line any marked range intersects. No icon, no animation, no hover state of its
own.

Colour from `tokens.css`: `--nox-violet-dim` for every author kind. One colour,
not a palette — the mark's job is *"something other than your typing touched
this line"*, and the tooltip carries the detail. Encoding four author kinds as
four colours would ask a 2px bar to say more than a glance can read, and
would need three new tokens to say it.

`--nox-violet` is the family already used for "not the primary thing" —
selection, the active-pane spine — so the dim variant sits in the design
language without introducing a new idea.

### The tooltip

`hoverTooltip` over the marked text, giving `authorLabel`, `description`, and
a relative time. CodeMirror tooltips are already themed in `theme.ts` for
autocomplete, so this should need little or no new CSS.

Hovering the *text*, not the gutter bar: the bar marks a line, but the range
is often narrower, and hovering the text is what tells you which part.

### No inline treatment

A background tint on authored text was considered and rejected. It is the
overbearing option: it competes with syntax highlighting, it fights the
selection colour, and it is present in your peripheral vision the entire time
you are reading code you did not write. The gutter is a glance you choose to
take.

### Commands

| Command | Title | Behaviour |
|---|---|---|
| `provenance.nextChange` | Go to Next Change | Move the cursor to the next marked region |
| `provenance.previousChange` | Go to Previous Change | The mirror |
| `provenance.clear` | Clear Change Marks | Drop every mark in every buffer |

Navigation **stops at the ends and says so** through a notification, rather
than wrapping. Wrapping silently is how you lose your place in a review.

`nextChange` and `previousChange` are enabled only when the active buffer has
marks; `clear` only when any buffer does.

No keybinding in this cycle. The palette is the right first home, and chords
are scarcer than commands — if navigation proves to be something you do
constantly, it can claim one later.

## 7. Settings

One entry in `SETTINGS_SCHEMA`:

```ts
'workbench.showChangeMarks': bool(true, {
  label: 'Show Change Marks',
  description: 'Mark lines changed by a replace, an agent or a plugin.',
  category: 'Workbench',
}),
```

The notetaker spec argued against adding a setting where the answer was
knowable, and that reasoning still holds — it is why there is no setting for
*what* gets marked or *how long* marks live. But whether a persistent visual
belongs in your peripheral vision is a real taste difference, not a knowable
answer, and it is the honest escape hatch for anyone who finds the gutter
noisy. It has direct precedent in `workbench.showStatusBar` and
`workbench.showExplorer`.

**Only the gutter and the tooltip go in the `Compartment` — never the state
field.** A `Compartment` reconfigured to nothing *removes* its extensions, and
removing a `StateField` destroys the state it holds. Putting the field in the
compartment would mean toggling the setting off silently threw away every mark
recorded so far, and toggling it back on would show an empty gutter.

So the field is installed unconditionally and always records; the setting
governs only whether anything renders it. Turning the gutter off hides it,
turning it back on shows everything that accumulated while it was hidden, and
the two commands keep working either way — a hidden gutter is not a reason for
"Go to Next Change" to stop navigating.

This is the one place where getting the Compartment boundary wrong produces
silent data loss rather than a visual bug, so it gets a named test (§9).

## 8. What gets marked

Every change set, whatever its author — including `{kind: 'user'}`.

The alternative was to mark only non-`user` authors, on the reasoning that a
replace is something you did deliberately and already know about. That would
be the quieter choice, and it was rejected on a fact: project replace is the
**only** live producer of change sets. The agent runtime is the other, and no
model provider ships. Marking only non-`user` authors would ship a feature
that cannot be triggered until an Ollama provider lands — and a feature nobody
can see is worse than one that is occasionally present.

So the gutter's meaning is *"changed this session by something other than your
typing"*. Unmarked means you typed it.

## 9. Testing

The field is pure state and tests without a DOM, which is where this
codebase's test suite is strongest. House style as ever: a fake at the seam,
and each test naming the regression it prevents.

| Test | The failure it prevents |
|---|---|
| A change set marks the inserted range, not the whole line | A gutter that says a line changed when one character did |
| Typing inside a mark clears only the touched part | Marks that never decay, so an empty gutter means nothing |
| Typing adjacent to a mark does not extend it | CodeMirror's default mark-extension behaviour, which is the opposite of what was chosen |
| A mark survives an unrelated edit elsewhere and maps to the right position | The position-mapping bug this whole design exists to avoid hand-writing |
| Deleting marked text leaves no mark | A zero-width ghost rendering as a bar on an unauthored line |
| A second change set over a marked range replaces the attribution | Stale authorship after an agent edits its own earlier work |
| `nextChange` at the last mark stops and reports | Silently wrapping, which loses your place mid-review |
| A change set that has rotated out of the log still has a full tooltip | The bounded log emptying a tooltip that was correct a moment ago |
| Marks accumulate in a background buffer with no view | Provenance that only works in the focused tab |
| Turning the setting off and on again shows the marks recorded meanwhile | Putting the state field in the Compartment, which would destroy every mark on toggle — the one boundary error here that loses data silently rather than looking wrong |
| A change set that only deletes adds no mark | A zero-width ghost bar on a line nobody authored |
| Navigation still works while the gutter is hidden | Tying the commands to the rendering rather than the state |

Then the running app, per the project's standing rule: a project replace
across several open files, walked with the navigation commands, with the
tooltip read on a mark and the setting toggled.

## 10. Files touched

| File | Change |
|---|---|
| `src/editor/provenance.ts` | new — the state field, gutter, tooltip and navigation helpers |
| `src/editor/extensions.ts` | compose it, in its own Compartment |
| `src/services/config/schema.ts` | `workbench.showChangeMarks` |
| `src/app.ts` | three commands |
| `src/editor/theme.ts` | gutter and tooltip styling, if the existing tooltip theme is not enough |
| `tests/provenance.test.ts` | new |
| `ARCHITECTURE.md` | a §4 entry for the StateField-not-ViewPlugin decision |
| `CHANGELOG.md` | the feature |

`src/services/transactions.ts` is **not** in this list. The annotation it
already defines is the entire hook this needs.

## 11. Out of scope, named so they are deferred rather than forgotten

Persistence across restarts; per-change-set revert; a transaction log panel;
provenance for files edited on disk without a buffer; per-author colours;
a keybinding; blame-style "who wrote this line" across sessions; exporting a
session's changes as a patch.

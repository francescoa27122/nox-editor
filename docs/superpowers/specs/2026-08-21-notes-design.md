# Notes — three improvements

Search and pinning, notes anchored to code, and a Markdown round-trip out of
Nox and back. Notes today are a careful **store** behind a thin **surface**:
`src/services/notes.ts` is 459 lines of which almost all is persistence
correctness, and `src/ui/NotesPanel.svelte` is a list and a `<textarea>`.
All three features are surface. None needs the storage model rethought,
which is why they compose instead of fighting.

Status: decided 2026-08-21. Every path, type and function named below was
read in the file it names before being written down.

## 0. The envelope

Read this before adding anything to the phases below.

- **`NotesService` takes a `Platform` and nothing else.** This is stated
  twice — in the class doc and in ARCHITECTURE.md §4 — and it is
  load-bearing, not stylistic: with no workspace in reach, opening a
  different folder cannot change or hide notes, and no later edit can
  accidentally make it so. **§3 and §4 both want the workspace. Neither
  gets it.** Both put the workspace-facing half in `app.ts`, which already
  holds `workspace` and `notes` together and already does exactly this for
  `notes.rename` (`app.ts:1736`).
- **Storage stays split.** A small `notes.json` index plus one
  `note-<n>.txt` per body. One JSON holding everything rewrites every note
  on every keystroke and puts every note behind one torn write. Nothing
  below merges them.
- **Order is decided in exactly one place.** `create()` prepends, and the
  list never re-sorts afterwards. §2 adds pinning as the *only* reordering
  and it is user-driven; sorting by `updatedAt` is rejected in §2.1.
- **Notes always autosave.** No setting gates it, because a preference that
  stops saving your notes is a preference that loses them. Nothing below
  adds one.
- **The body is a `<textarea>`, not a second CodeMirror.** A note is prose;
  bracket matching, autocomplete and a language compartment are code
  affordances. This is why Markdown appears in §4 as a *file format on the
  way out*, and never as an editing mode.
- **A missing part costs its own text and nothing more.** `load()` keeps a
  note whose body file has vanished, because the title is still worth
  having. §3 and §4 inherit that instinct explicitly.

## 1. Phase 0 — collapse `#doPersist`'s revision machinery

**A prerequisite, and the only phase that changes code that already works.**

ARCHITECTURE.md §7 records this debt already, and names its own trigger:

> Clearing after the write forces the whole design to prove "is this still
> what I wrote" […] **Do this before the method is next modified**, not as a
> speculative refactor now.

That trigger has arrived. §2 adds `pin()` and §3 adds `setAnchor()`, and
both are index-only mutations — the exact shape that `#dirtyBodies` and
`#released` cannot see. Each must remember to bump `#indexRevision` or its
change is silently dropped when it lands mid-write. That is two new
dependents on the most subtle code in the file, enforced by nothing but a
comment.

### 1.1 The change

Clear dirty state **before** the await, and let the next mutation re-arm it.

- Take the id out of `#dirtyBodies` *before* writing it, not after.
- A `setBody` landing during the write puts it back by itself. That is the
  whole mechanism — no revision to capture, compare, or shadow.
- On failure, put it back **and** add it to the per-call `failed` fence.

This deletes `#bodyRevision`, `#nextRevision`, `#indexRevision`,
`#savedIndexRevision`, and the comment-only invariant that `create()` must
never bump `#indexRevision`. The index follows the same shape: a single
`#indexDirty` boolean, cleared before its write, re-armed by `rename()`,
`select()` and `remove()`.

### 1.2 What does not go away

`failed`, `failedReleases` and `indexFailed` all stay. They are not part of
the revision machinery — they stop a write that keeps failing from spinning
the loop forever *within one call*, and clearing-before makes that risk
slightly sharper rather than softer: a failed write now re-arms its own
dirty flag, so without the fence the drain loop would pick it straight back
up. Anyone reading §1.1 as "delete the fences too" has misread it.

### 1.3 Gate and rollback

Phase 0 lands **alone**, on its own PR, with **no behaviour change and no
new test**. The existing 761 lines of `tests/notes.test.ts` are the proof:
they were written against the current semantics, and if they pass unchanged
the semantics are unchanged. That is the entire argument for doing this
safely, and it is also the reason not to touch the tests in this phase.

If it proves hairier than the debt entry claims, **abandon it**. Phases 2–4
build fine on the current design; the cost of skipping Phase 0 is that
`pin()` and `setAnchor()` must each bump `#indexRevision` exactly as
`rename()` does, and that the fragile pattern gains two more dependents.
Nothing later in this document assumes Phase 0 happened.

## 2. Find — search, pinning, and a note palette

The one gap that gets worse on its own: the list shows titles only, so a
body is unfindable, and at fifty notes the panel is a wall.

### 2.1 Search is a view concern, and stays one

`load()` reads **every** body into the `notes` signal, so the whole corpus
is already in memory. Filtering is therefore a `$derived` in
`NotesPanel.svelte` over `$list` — **no change to `NotesService` at all**.
This is not laziness; the service's single dependency is the thing being
protected, and a search index inside it would be state that has to be kept
agreeing with the notes for no gain at this size.

Matching is case-insensitive substring over title and body. A hit shows the
first matching body line beneath the title, the way `SearchPanel.svelte`
shows its own. Fuzzy matching is **not** used here — a filter box over a
list wants predictable substring behaviour, and the fuzzy path is §2.3.

Sorting by `updatedAt` is rejected: rows would reorder *while you type into
them*, which is worse than a fixed order at any list size.

### 2.2 Pinning is the only reordering

`pin(id, pinned)` on `NotesService`, and `pinned?: boolean` on `NoteRecord`.
Pinned notes render above unpinned ones; within each group the existing
insertion order is untouched.

`VERSION` stays `1`. The field is optional in both directions: an older
index simply lacks it and reads as `false`, and an older build ignores a
field it does not know. A version bump would mean an older build rejecting
the whole file — the loader's `parsed.version !== VERSION` check discards
everything — which is a far worse failure than an ignored boolean.

`pin()` is an index-only mutation. Post-Phase-0 it sets `#indexDirty`;
without Phase 0 it bumps `#indexRevision`, exactly as `rename()` does.

### 2.3 `notes.open` — a palette over notes

A fifth command beside the four in `app.ts:3144`, reusing `src/core/fuzzy.ts`
and the `CommandPalette.svelte` shape. Fuzzy over titles, selecting a note
and focusing the panel via the existing `ui.focusNotesRequest` counter
(`ui.ts:140`). This is the "I know which note I want" path; §2.1 is the "I
know a word that is in it" path, and they are different enough to deserve
separate affordances.

## 3. Anchor — a note that knows its code

The feature that makes a note in an editor different from a note anywhere
else, and the one that presses hardest on §0.

### 3.1 The shape

`anchor?: { path: string; line: number; snippet: string }` on `NoteRecord`,
set by `setAnchor(id, anchor)`. A new command `notes.newFromSelection`
creates a note pre-filled with the selection as a fenced quote, titled from
the file's basename and line.

**`NotesService` never interprets any of it.** It stores three primitives
and hands them back. Every workspace-facing step — reading the selection,
resolving the path, jumping — lives in `app.ts`, which already holds both
services. Opening: `await this.openPaths([anchor.path])`, then
`this.goToLine(line, 1)` (`app.ts:3424`), which acts on the *active* editor
and so must follow the await. This is the same division `notes.rename`
already uses and it is why §0 survives this feature intact.

### 3.2 Two failure modes, designed for rather than ignored

**Line drift.** Editing a file moves the code out from under a stored line
number. This is why `snippet` is stored beside `line` and not instead of
it: on open, look for the snippet within a bounded window around the
remembered line and jump to it if found, otherwise jump to the raw line. It
cannot be perfect — the code may be gone — but it converts the common case
(edits above the anchor) from wrong to right for the cost of a local scan.

**The wrong workspace.** An anchor into folder A, opened while folder B is
loaded, will not resolve. The chip renders greyed with the stored path as
its title, and **the note itself is never hidden or altered**. This is
§0's last bullet applied: an unresolvable anchor costs the jump and nothing
else. Deleting or rewriting anchors on a folder switch would let opening a
folder mutate notes, which is the precise thing §0 forbids.

### 3.3 Scope

Anchors are one-way: a note knows its code, the code does not know its
notes. A gutter marker or explorer badge means pushing note state into the
editor and the tree, and buys less than it costs until anchors have been
used enough to know whether they are kept up to date.

## 4. Portability — export and import as Markdown

Bodies are `note-7.txt` behind a JSON index in a config directory. Nothing
reads them, nothing exports them, and the filenames are ordinals. That is a
quiet reason not to trust notes with anything that matters, and it is the
reason this phase beats a Markdown *preview* for the third slot: preview
makes notes prettier, this makes them trustworthy.

### 4.1 Export

`notes.export` asks for a directory with `pickFolder()`
(`platform/types.ts:568`) and writes one `.md` per note with
`writeTextFile` (`:429`) — never through the config API, which addresses
files by name inside Nox's own directory and cannot reach a chosen folder.

Each file carries a `---`-delimited front-matter block holding `id`,
`title`, `createdAt`, `updatedAt`, `pinned` and `anchor`, then the body
verbatim. The filename is the title slugified, with the note's ordinal
appended on collision — titles are user-edited and not unique, and two notes
must never write to one path.

**The block is not YAML, and must not be described as YAML.** Nox ships no
YAML parser (`package.json` has none, and nothing in `src/` imports one),
and hand-rolling a subset of a whitespace-significant format is how
importers rot. The format is one `key: value` per line where **the value is
JSON**:

```
---
title: "Why the reader threads changed"
pinned: true
anchor: {"path":"/src/lsp.rs","line":320,"snippet":"for line in"}
---
```

Writing is `JSON.stringify` per value, reading is `JSON.parse` per value.
It is unambiguous in both directions, needs no dependency, round-trips
exactly, and still reads as front matter to a human. Adding a real YAML
dependency to gain compatibility with other note tools is a decision worth
making on its own evidence, not smuggled in through an export format.

### 4.2 Import

`notes.import` picks a directory, lists it with `readDir` (`:430`), reads
each `.md` with `readTextFile` (`:365`), and parses the front matter back.

**Import is additive and never destructive.** A file whose `id` already
exists is imported as a *new* note with a fresh ordinal rather than
overwriting the existing one. Merge semantics need a conflict UI and a
rule for which side wins; "import always adds" needs neither, and a
duplicate note is a nuisance while a silently overwritten note is a loss.

A file with no front matter imports as a note titled from its filename, so
plain Markdown written elsewhere works. **A front-matter block that fails to
parse is treated as body text, not as an error and not as grounds for
skipping the file** — the same instinct as §0's last bullet. A file written
by another tool with real YAML in it therefore imports with its metadata
visible in the body rather than vanishing, which is recoverable by hand;
dropping it is not.

### 4.3 Where it degrades

Both commands require `capabilities.nativeDialogs` (`platform/types.ts:29`).
The browser build has no dialogs and `persistentStorage` false, so both
commands are disabled there via the existing `enabled:` predicate on the
command record rather than being hidden — a greyed command explains itself,
a missing one does not.

## 5. Deliberately not here

- **Tags and folders.** Pinning plus search covers organisation at the scale
  a single-user notes panel reaches. Revisit only if pinning is observed
  filling up.
- **Markdown preview.** §4 makes Markdown the interchange format; rendering
  it inside Nox is a separate question, and would be the first renderer in
  the codebase — `AnswersPanel.svelte:316` records that none exists.
  `@lezer/markdown` is already on disk via `@codemirror/lang-markdown` if it
  is ever wanted, so this stays cheap to reconsider.
- **List continuation and Tab in the body.** Genuinely cheap and genuinely
  useful, and still out: it is unrelated to all three phases, and bundling
  it would mean editing the body textarea in a change that otherwise never
  touches it. A good first follow-up.
- **Note-to-note links.** No evidence they are wanted yet.
- **Per-workspace notes.** Contradicts §0 outright.

## 6. Testing

`tests/notes.test.ts` is 761 lines against `MemoryPlatform` and is the model
for all of it.

- **Phase 0:** no new tests. The existing suite passing unchanged *is* the
  result. See §1.3.
- **§2:** `pin()` reorders and survives a reload; `pinned` absent from an
  older index reads as `false`; a pin landing mid-write is not dropped —
  the index-only lost-edit shape the current suite already covers for
  `rename()`.
- **§3:** an anchor round-trips through save and load; a note whose anchor
  does not resolve still loads, with its body and title intact; the
  snippet re-find lands on moved code and falls back to the stored line
  when the snippet is gone. The last one is a pure function over text and
  a line number, and should be written as one so it needs no platform.
- **§4:** the property that matters is **round-trip** — export then import
  yields notes equal to the originals in title, body and anchor. Plus:
  colliding titles produce two files; a `.md` with no front matter
  imports; import of an existing `id` adds rather than overwrites.

## 7. Order and risk

1. **Phase 0** — alone, abandonable, no behaviour change (§1.3).
2. **§2 Find** — the largest daily gain, and the only phase with no new
   persisted field beyond one optional boolean.
3. **§3 Anchor** — the largest new concept; wants §2's list in place to be
   worth navigating.
4. **§4 Portability** — last, because it must serialise whatever §2 and §3
   added, and doing it earlier means writing the format twice.

The sharpest risk is Phase 0: it edits correct, tested, subtle code whose
failure mode is losing a note. The mitigation is that it ships alone,
changes no behaviour, and is judged solely by an unmodified suite — and
that abandoning it costs nothing later.

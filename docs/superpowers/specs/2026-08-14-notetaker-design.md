# Notetaker — design

A third sidebar section holding the user's own notes: a list, and an editor for
the selected one. Create, rename, edit, delete. Notes persist across restarts
and are unaffected by which folder is open.

Status: approved 2026-08-14. Implementation follows in a separate plan.

## 1. What this is, and what it is not

Nox already edits files. This does not. The editor's whole apparatus —
buffers, transactions, change sets, dirty tracking, the file watcher —
exists because a file on disk has other readers: git, a compiler, an agent
staging a change set. A note has none of those. It is text the user owns,
attached to nothing, and the entire design follows from that difference.

Three rules, and everything below is a consequence of one of them:

1. **Notes are not workspace files.** `NotesService` takes a `Platform` and
   nothing else. It cannot reach the workspace, so opening a different folder
   cannot change or hide notes — that is a structural guarantee, not a
   convention someone has to remember.
2. **Never lose the user's work.** No save button, no save setting, no
   single file whose truncation costs every note.
3. **It stays extensible.** Tags, search, pinning, markdown preview and
   note↔file links must each be an additive change to the record or the
   panel, never a migration of the model.

### The list question

The MVP is a list of many notes, not one scratch note. The codebase does not
push the other way — if anything it pushes toward the list, because
`WorkspaceService` already owns untitled scratch buffers that survive a
restart (`session.ts`, `kind: 'untitled'`). A single-note notetaker would be
a second, worse version of something that already ships.

## 2. Data model

```ts
/**
 * One note. `id` is opaque and stable: the title is a label the user edits,
 * so anything that refers to a note — the selection, a future `[[link]]`, a
 * future file association — must refer to the id instead.
 */
export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}
```

**Title is stored, not derived from the first line.** Deriving it is the
Apple Notes model and it is defensible, but the brief asks for rename as an
operation, and a derived title makes rename mean "edit the first line of the
body" — which is a different, more surprising thing. Stored is also what
makes an empty note nameable.

**Order is the array's order, newest-created first, and does not change when
a note is edited.** Sorting by `updatedAt` is the obvious default and it is
wrong here: with autosave on a 400 ms debounce, the note you are typing into
would jump to the top of the list under your cursor. Explicit order also
gives pinning and sort-by-modified somewhere to go later without a migration.

**Extension points, deliberately left open.** `tags?: string[]`,
`pinned?: boolean`, `linkedPath?: string` are each additive to `Note`; a
reader that does not know a field ignores it. The envelope carries a
`version` so a real migration is possible if one is ever needed — the same
mechanism `session.ts` uses to avoid discarding a session on upgrade.

## 3. Persistence

### Layout: one index, one file per body

| File | Contents |
|---|---|
| `notes.json` | `{ version: 1, selectedId: string \| null, notes: NoteRecord[] }` |
| `note-<n>.txt` | one note's body, verbatim |

```ts
/** A note in the index. The body lives in the file this names. */
interface NoteRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Config-relative file holding the body. */
  body: string;
}
```

Flat filenames — the config API is documented as "keyed by a bare filename"
(`platform/types.ts`), so no subdirectory.

### Why not one JSON holding everything

Two reasons, both already learned in this repo rather than hypothesised.

**The typing path.** Autosave means a write per debounce. With one file, a
keystroke in note A rewrites note B, C and D as well, across the IPC
boundary. `session.ts` version 4 exists specifically to undo this mistake:
version 3 inlined unsaved buffer content and "a keystroke in a 5 MB dirty
file rewrote 5 MB of JSON every time the debounce fired". The fix there was
a small index plus per-item content files, only rewriting the item that
moved. This is the same problem, so it gets the same shape.

**Partial writes.** With one file, a process death mid-write costs every
note. Split, the blast radius is bounded: a torn index costs titles and
ordering while every body survives on disk, and a torn body costs one note.

Rejected alternative — **per-note files with no index**: ordering and
selection have to live somewhere, and reconstructing them from a directory
listing is strictly worse than a 200-byte file that says so.

### Making the write atomic

`nox_write_config` (`src-tauri/src/fs.rs`) currently calls `fs::write`, which
truncates the target and then writes into it — the window where a crash
leaves a half-file. `write_then_rename` already exists in the same file,
about 280 lines above, and is what file saves use: write a sibling temp,
flush, rename over the target. Rename within a directory is atomic on every
filesystem Nox supports.

Pointing `nox_write_config` at it removes the torn-file case rather than
merely bounding it, and settings and session get the same durability for
free. This lands as its own commit with its own Rust test, ahead of the
notes work, so it can be reviewed and reverted independently.

The split layout is still the right design *with* the atomic write: atomicity
fixes torn files, not the write-amplification on the typing path.

### Deletion

The config API has no delete. A deleted note's body file is overwritten with
an empty string, which is how `session.ts` releases a stale backup. The
loader in §3 treats a blank body file the same as a missing one.

### Failure handling

Reads and writes are wrapped, never thrown out of the service — the same
posture as `session.ts`'s "a session we cannot persist is not worth an error
dialog", with one difference: a *write* failure is surfaced, because silently
failing to save notes violates rule 2 above. The service exposes
`error: Signal<string | null>`, exactly as `TerminalService` does, and
`app.ts` is what turns that into a notification. The service itself stays
free of any dependency but `Platform`. A read failure degrades to an empty
list without an error.

| Situation | Behaviour |
|---|---|
| No `notes.json` | Empty list. First launch. |
| `notes.json` is not valid JSON | Empty list. Do not throw; the panel must still render. |
| `version` is unrecognised | Empty list. |
| A record names a body file that is missing or blank | The note loads with an empty body. Losing one body must not cost the other notes. |
| A body file exists that no record names | Ignored on load. Never reclaimed: `#nextOrdinal` only increases, so a filename is never reused. |
| A write fails | One notification. The in-memory note is unchanged, so the next debounce retries. |

## 4. Save semantics

**Always autosave.** Debounced at 400 ms, matching `session.ts`, plus a
forced flush on: switching notes, hiding the panel, and window close (which
`app.ts` already has a listener for).

Notes do **not** follow `files.autoSave`. That setting exists because a file
on disk has other readers, so writing to it is an outward-facing act the user
may reasonably want to control. A note has no external consumer and no
dirty-versus-disk state the user reasons about. There is also no new setting:
a preference that turns off saving your notes is a preference that loses your
notes, which contradicts the project's stated principle.

Nothing is added to `SETTINGS_SCHEMA`. `notes.sortOrder` was considered and
rejected — one order, no preference, until there is a second order worth
having.

**What flushing on a switch does and does not buy.** It is a durability
checkpoint, not protection against losing text. `setBody` updates the note
in memory synchronously, so the pending write already sees the current body
whether or not the selection has moved on; switching cannot lose anything.
What the flush bounds is how long a body exists *only* in memory, where a
crash or a `kill -9` — rather than a clean quit — would take it.

The failure that is real, and gets a named test: persisting only the
**selected** note's body instead of every dirty one. That implementation
passes every single-note test and loses note A's text the moment you switch
to note B.

## 5. Service

`src/services/notes.ts`:

```ts
export class NotesService {
  readonly notes: Signal<Note[]>;
  readonly selectedId: Signal<string | null>;
  /** Why the last write failed, if it did. `app.ts` reports it. */
  readonly error: Signal<string | null>;

  constructor(platform: Platform);

  load(): Promise<void>;
  create(): string;                       // returns the new note's id
  select(id: string | null): void;
  rename(id: string, title: string): void;
  setBody(id: string, body: string): void;
  remove(id: string): void;
  flush(): Promise<void>;                 // write pending changes now
}
```

The constructor signature is the enforcement of rule 1: there is no workspace
to reach, so no future edit can accidentally couple notes to the open folder.

All policy lives here — debouncing, which bodies are dirty, filename
allocation, what happens to the selection when the selected note is deleted,
and what an empty title becomes. Nothing in the panel decides any of it, and
nothing in the platform adapter branches.

Two behaviours worth naming because they are easy to get wrong:

- **Deleting the selected note** moves selection to the next note, or the
  previous one if it was last, or null when the list empties. The selection
  is never left pointing at an id that no longer exists.
- **Rename to empty or whitespace** is refused; the note keeps its previous
  title. A note with no title is unfindable in a list that shows only titles.

Body filenames are allocated per note and reused for that note's lifetime, so
an edit rewrites exactly one file. The service tracks which bodies have
changed since the last write and skips the rest — the same cheapness as
`session.ts`'s `#backups`, without needing a revision counter, because
`setBody` is the only way a body moves.

## 6. Interface

### Panel layout

One panel, split: the note list on top, the selected note's title and body
below. Not a list⇄detail swap — a mode you can enter is a mode you have to
escape, and the split keeps the user seeing which note they are in while they
type. The sidebar defaults to 248px (`workbench.explorerWidth`), which is
narrow for prose but is what "a dedicated third section in the left sidebar"
means.

```
┌──────────────────────────┐
│ ▣ ▤ ▥        ← rail      │
├──────────────────────────┤
│ NOTES            [+] [x]  │  header: title, new, delete
├──────────────────────────┤
│ Reading list             │  list, newest first,
│ Standup notes            │  selected row highlighted
│ Ideas                    │
├──────────────────────────┤
│ [ Standup notes        ] │  title input
│                          │
│ body textarea, fills     │
│ the remaining height     │
│                          │
└──────────────────────────┘
```

Every colour, radius, spacing and duration comes from `tokens.css`. The list
row reuses the explorer's selected-row treatment (`--nox-selected`), the
header matches `ExplorerPanel`'s header and its `icon-button`s, and the
textarea sits on `--nox-bg-inset` with `--nox-font-ui` — it is prose, not
code, so it does not take the mono stack.

### The body editor is a `<textarea>`

A second CodeMirror instance would pull `buildExtensions(settings)` in with
it: bracket matching, autocomplete, line numbers, a language compartment — a
set of code affordances applied to prose, in a 248px column. It also breaks
the design's first rule in spirit, dragging the editor stack into something
that is explicitly not a file.

A textarea gets native spellcheck, which prose wants and code does not, and
native undo. Markdown syntax highlighting is the one thing given up; it can
be added later behind the same `setBody` interface, without touching the data
model or the persistence format.

### Icons

`Icon.svelte` has no note or pencil glyph, and no trash glyph either. Two
entries are added, both on the existing 16×16 grid at the shared 1.5px
optical weight:

- **`note`** — a page with ruled lines, and deliberately **no folded
  corner**, so it does not read as the existing `file` glyph at the rail's
  15px. This is the rail icon.
- **`trash`** — the header's delete affordance. Without it, deleting a note
  would be reachable only through the command palette, which is the wrong
  cost for a routine operation in a notetaker. `close` was considered as a
  stand-in and rejected: it already means "dismiss this" everywhere else in
  the app, and reusing it for "destroy this permanently" is exactly the
  confusion an unrecoverable delete cannot afford.

### UI service

`src/services/ui.ts`:

- `SidebarView` gains `'notes'`
- `FocusZone` gains `'notes'`
- `focusNotesRequest: Signal<number>`, bumped to ask the panel to take focus —
  the pattern `focusSearchRequest` and `focusExplorerRequest` already use
- `focusNotes()` sets the view, the zone, and bumps the request
- `showView()` gains its third branch

That last one is the quirk the file warns about: `showView` used to fall
through to `focusExplorer` for anything that was not search, which set the
view straight back to the explorer. It was invisible with two views and would
be a real bug with three. The comment there says so; the new branch is what
it is asking for.

### Commands and keybinding

Registered in `app.ts`, so each appears in the palette whether or not it has
a chord:

| Command | Title | Behaviour |
|---|---|---|
| `notes.focus` | Notes: Show Notes | Show the panel and focus it |
| `notes.new` | Notes: New Note | Create, select, put the cursor in the title |
| `notes.rename` | Notes: Rename Note | `ui.askForText`, seeded with the current title |
| `notes.delete` | Notes: Delete Note | `ui.askToConfirm` with the `danger` choice, then delete |

`notes.rename` and `notes.delete` are `enabled` only when a note is selected.

One binding: **`Mod+Shift+N` → `notes.focus`**. The rail's other two views are
`Mod+Shift+E` and `Mod+Shift+F`, so a third view without a chord would be the
odd one out, and the symmetry makes it guessable. `Mod+Shift+N` is unbound
today (verified against the table in `app.ts`) and `Mod+N` remains
`file.new`. The other three commands are palette-only: they act on a
selection that only exists while the panel is open, and chords are scarcer
than commands.

Delete goes through a confirm because there is no trash and no undo across
it — the note is gone. This matches how destructive file operations are
already handled.

## 7. Testing

`tests/notes.test.ts`, in the house style of `tests/terminal.test.ts`: a fake
at the platform seam — here an in-memory `Map` behind `readConfigFile` /
`writeConfigFile` that can also be made to fail — and each test carrying a
comment naming the regression it prevents.

| Test | The failure it prevents |
|---|---|
| A fresh service against the same platform sees the same notes | Notes that do not survive a restart |
| `NotesService` is constructible with only a `Platform` | Coupling notes to the workspace, so opening a folder hides them |
| Editing note A, switching to B, then saving persists both bodies | Persisting only the selected note, which loses A on the switch |
| N keystrokes produce one write of that body and zero of the others | The session v3 write-amplification, reintroduced |
| Deleting the selected note selects a neighbour | A selection pointing at a note that no longer exists |
| Deleting blanks the body file | A deleted note's text left in the config directory |
| Malformed `notes.json` loads as an empty list | A corrupt file that makes the panel unrenderable |
| A record naming a missing body file loads that note empty | One lost body taking every other note down with it |
| Rename to whitespace is refused | An untitled row that cannot be found in the list |
| A failed write notifies and leaves the in-memory note intact | Silently failing to save, and losing the text on retry |

Rust: one test in `src-tauri/src/fs.rs` asserting `nox_write_config`
round-trips and leaves no `.tmp` sibling behind, guarding the atomic-write
change.

Tests alone are not the verification. Before this is called done it is
exercised in the running app — create, rename, edit, delete, switch
workspace, restart — per the project's standing rule that evidence precedes
the claim.

## 8. Files touched

| File | Change |
|---|---|
| `src-tauri/src/fs.rs` | `nox_write_config` uses `write_then_rename`; one test |
| `src/services/notes.ts` | new — the service |
| `src/services/ui.ts` | `'notes'` in `SidebarView` and `FocusZone`; `focusNotes`, `focusNotesRequest`; third `showView` branch |
| `src/ui/NotesPanel.svelte` | new — renders only |
| `src/ui/Sidebar.svelte` | one `VIEWS` entry, one `{#if}` branch |
| `src/ui/Icon.svelte` | new `note` and `trash` glyphs |
| `src/app.ts` | construct `NotesService`; four commands; one keybinding |
| `tests/notes.test.ts` | new |
| `ARCHITECTURE.md` | a §4 entry for the persistence decision; §3 entries for the new files |
| `CHANGELOG.md` | the feature |

`src/services/config/schema.ts` is deliberately **not** in this list.

## 9. Out of scope

Named so they are visibly deferred rather than forgotten: tags, search within
notes, pinning and reordering, markdown preview or highlighting, linking a
note to a file, export, per-note word count, and any sync. The data model and
the panel are shaped to accept each of them; none is built now.

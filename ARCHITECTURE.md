# Nox — Architecture

This document explains how Nox is put together and, more importantly, *why*.
If you are about to add a feature, read §2 (Layers) and §5 (How to add a
feature) first — those two sections determine where your code belongs.

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

**Electron** — rejected on weight. An editor whose thesis is speed cannot ship
a private Chromium.

**A fully native, GPU-rendered UI (the Zed model)** — the right answer with a
graphics team and a multi-year runway. For this project it is a ~10× cost
multiplier on every UI change and forfeits the entire web ecosystem for future
markdown preview, diffing and AI-chat surfaces. Revisitable: rendering sits
behind `ui/`, not smeared through the services.

**Monaco instead of CodeMirror** — Monaco's genuine advantage is near-free
TypeScript IntelliSense. That advantage is real but narrow (it is free for
TS/JS and nothing else), and it comes bundled with 20× the code and a DOM that
carries VS Code's visual DNA. Nox chooses a distinct identity and pays for
language intelligence later via LSP over stdio, which is well-understood work.

**React instead of Svelte** — larger ecosystem, but Nox writes every component
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
- Every service is unit-testable against a fake disk with **no mocking library**
  — you construct a different `Platform`. `tests/workspace.test.ts` exercises
  the same code path the browser build uses.

When Tauri's API changes, exactly one file changes: `platform/tauri.ts`.

The updater follows the same rule: its network request, signature
verification and file replacement all happen in the Rust plugin, behind
`checkForUpdate` and `installUpdate` on `Platform`. The renderer sees
`UpdateInfo | null` and nothing else — absence is never an error.

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
│  ├─ config/schema.ts   THE settings schema — types derived from it
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
│  ├─ agent/provider.ts  Vendor-neutral model interface
│  ├─ agent/ollama.ts    A local model: prompt, parser, edit resolution
│  ├─ agent/runtime.ts   Sessions, audit trail, session-level undo
│  ├─ agent/stdio.ts     Agents in another process, over line-delimited JSON
│  ├─ filetree.ts        Explorer model + quick-open index
│  ├─ watcher.ts         Reacts to changes made outside Nox
│  ├─ session.ts         Restore folder, tabs, cursors and unsaved work
│  ├─ notes.ts           The user's own notes. No workspace, by construction.
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
authoritative state for *every* buffer, including background tabs — which is
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
eight wide, holding only facts about the code — indentation, trimming, format
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
only. It never rebuilds the state — a rebuild would discard undo history and
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
read from `keybindings.json`. A rule is *applied over* the defaults — the
default table is never edited — which is what makes resetting a customisation a
deletion rather than a remembered original. `#rebuild()` replays the defaults
minus every `(chord, command)` pair a `remove` rule names, then applies the
additions; additions go last, and `#add` unshifts, so a user binding beats a
default on the same chord with no extra precedence machinery. `when` cannot be
serialised and `arg` usually is not, so both are inherited from the command's
own default — rebinding Escape keeps its guard.

Recording a new chord is a **mode of the service** (`beginCapture` /
`endCapture`), not a listener in the panel: the service already resolves on the
window's capture phase, so a claimed chord would be handled before any
descendant element could see it. While capturing, every key is swallowed and
handed to the recorder, and nothing runs. Design:
`docs/superpowers/specs/2026-08-20-keybinding-editor-design.md`.

### The explorer renders a window, and the model never knew

`FileTreeService` has exposed the tree as a flat ordered list since v0.1, with
a header saying why: flat is what the renderer wants, and it leaves the door
open for windowing. `ExplorerPanel` now walks through that door alone — no
service, no test and no `FlatNode` changed. It renders the slice of `nodes`
the viewport covers plus an overscan, between two `role="presentation"`
spacers that stand in for the rest, so the scrollbar describes the whole tree
and every row keeps its true offset. Spacers rather than a transform: the
container is also the drop target and the keyboard surface, and a transformed
child changes what `contains()` and `getBoundingClientRect()` mean for both.

Two rules make it safe. **The row height has one home** — a TS constant that
the stylesheet reads back through `--nox-tree-row-h`, because windowing by
index breaks silently if the painted height and the arithmetic disagree. And
**what cannot be measured is not windowed**: a viewport height of zero (before
layout, or under jsdom) renders every row, since windowing an unmeasured
viewport would render nothing. Design:
`docs/superpowers/specs/2026-08-20-explorer-virtualisation-design.md`.

### Nox draws its own find UI

CodeMirror's search *engine* is excellent and its panel looks nothing like Nox.
We keep the engine (`SearchQuery`, `findNext`, `findPrevious`) and draw our own
panel. Replace is the exception and is ours — see *The editor borrows the match
and owns the text* below. One consequence worth knowing: CM ties highlighting to the
lifecycle of its panel, which we never open — so
`editor/search-highlight.ts` decorates matches itself, viewport-bounded.

### File watching: policy in one place

Rust runs a single recursive `notify` watcher on the workspace root and
forwards raw events. **All policy lives in `services/watcher.ts`** — the Rust
side only filters noise directories (`.git`, `node_modules`, `target`, …),
because a `cargo build` inside the workspace would otherwise push tens of
thousands of events across the IPC boundary before anyone could ignore them.
Coalescing, debouncing and every user-facing decision sit on the TypeScript
side, where they can be unit-tested against `MemoryPlatform`.

Three rules govern the behaviour:

1. **Never fight the user.** A *clean* buffer reloads silently — that is what
   clean means. A *dirty* buffer is never overwritten; it is marked and the
   conflict is resolved at save time with an explicit
   Overwrite / Discard & Reload / Cancel choice.
2. **Never mistake our own writes for someone else's.** Every open buffer
   records the mtime Nox last read or wrote (`Buffer.diskMtime`). An event
   whose fresh `stat` matches that value is ours and is dropped. This is far
   more reliable than suppressing events in a time window around a save.
3. **Never storm.** Events coalesce over 180 ms; the much more expensive
   quick-open re-index runs on a separate 2 s timer, and a plain content
   modification never triggers a tree refresh at all.

A deleted file keeps its tab, struck through and marked — the content is still
in memory, so nothing has been lost, and saving recreates the file.

**Known limitation:** the mtime comparison is only as fine-grained as the
filesystem. On a volume with one-second mtime resolution, an external write
landing in the same second as a Nox save can be misread as our own.

### Reloads are transactions, not state resets

`reloadFromDisk` replaces the document with a *transaction* rather than a new
`EditorState`. That keeps scroll position, maps the selection through the
change, and leaves the reload on the undo stack — so a surprise reload is
recoverable with ⌘Z.

For that to reach the buffer you are actually looking at, the workspace needs
to push into the live view. `ViewDispatcher` is the mirror image of
`applyTransaction`: `EditorPane` registers one, and it returns false for any
buffer that is not on screen, in which case the workspace applies the change to
the background state itself.

### File operations re-point buffers

A rename that leaves a tab aimed at a dead path *looks* fine right up until you
press save. So `renamePath` moves the file and then walks every open buffer,
re-pointing anything at or beneath the old path — updating its path, name,
detected language (the extension may have changed, which means a different
grammar) and recorded mtime.

Deleting splits on dirty state, for the same reason the watcher does: clean
buffers close, because you asked for the file to be gone; dirty ones stay open
and marked `deleted`, because losing unsaved work to a menu click is not a
trade the user agreed to.

Deletion goes to the **OS trash**, not `unlink`. A text editor should never
make a file unrecoverable with one click. `PlatformCapabilities.recoverableDelete`
advertises whether that is true, and the confirmation dialog changes its wording
accordingly — "Move to Trash" on the desktop, "deleted permanently" in the
browser target where there is nothing to recover from.

### Selection tracks three things, not one

`ExplorerSelection` holds `paths` (what is selected), `lead` (the focused row)
and `anchor` (where a Shift-range started). Conflating `lead` and `anchor` is
the classic multi-select bug: the range then only ever *grows*, because each
Shift+Arrow re-anchors where it just landed. Keeping them separate is what lets
Shift+Down then Shift+Up shrink the range back, which is what every file
manager does and what everyone's fingers expect.

Range operations take the ordered list of visible paths as an argument instead
of reaching into `FileTreeService`, which keeps the model pure and testable —
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
`canMoveInto`, and only a valid target calls `preventDefault` — so an illegal
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
does not offer it. The overlay is `pointer-events: none` — during an OS drag
the pointer belongs to the OS, and intercepting it would swallow the drop.

Routing is the rule people expect without being told: files become tabs, a lone
folder becomes the workspace, and in a mixed drop the files win.

### Project search is the one thing Rust genuinely owns

Everything else in `src-tauri/` is a thin adapter. Search is not: it is a
parallel, gitignore-aware walk over a whole repository (`ignore` — ripgrep's
walker — plus `regex`), and doing it in the webview would either block the main
thread or push the entire tree through IPC file by file.

Results **stream in batches** (`nox://search-batch`, flushed every ~90 ms or 40
files) rather than arriving at the end, so a large repo paints its first hits
immediately. Two consequences worth knowing:

- Batches can arrive *before* `nox_search_start` returns the id they belong to,
  so `platform/tauri.ts` buffers early ones and replays them. Without that, the
  fastest results — the ones from files already in page cache — are the ones
  that get dropped.
- The service tags each run with a generation counter and discards batches from
  a superseded search, because typing another character starts a new one while
  the old walk is still finishing.

`require_git(false)` is set deliberately: `ignore` otherwise only applies
`.gitignore` inside an actual git repository, so opening a plain folder that
has one would silently search everything it lists. A `.gitignore` is the user's
stated intent whether or not `git init` has been run.

The in-memory platform implements search **for real**, not as a stub — the
browser target gets working project search and every service test exercises the
same code path. The pure matching primitives live in `core/search-match.ts` and
deliberately mirror `src-tauri/src/search.rs`; where the two must agree
(preview windowing, whole-word semantics, column units) the same cases are
asserted on both sides. Columns are UTF-16 units so the Rust numbers line up
with JavaScript string indexing — an emoji earlier in the line would otherwise
shift every highlight after it.

### Replace decides which text is authoritative

Project replace is the most destructive thing Nox can do: it rewrites files the
user cannot see. Three rules make that safe.

**An open buffer beats the file on disk.** Search results come from disk, so
replacing disk text under a buffer with unsaved edits would silently throw that
work away. `#sourceTextFor` returns the buffer's text when the file is open,
and the replacement is *recomputed* from it rather than trusting the stored
result rows — which may be stale for a file edited since the search ran.

**Open files change through a transaction**, not a write. `workspace.apply`
routes through the live view where possible, so a project replace lands in the
editor's own undo history and ⌘Z works on it like any other edit. A file that
was clean is saved afterwards so disk and editor agree; a dirty one keeps its
unsaved state and stays the user's to save.

**Everything else gets a journal.** Each replace records `{path, before, after}`
per file. `undoLastReplace` restores a file only if its current contents still
equal what the replace produced — if anything has touched it since, that file
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
replaced *with* now comes from `core/replace.ts` — the same `expandReplacement`
and `preserveCase` the project panel runs through. That is the whole point of
the split: ⌘F and ⌘⇧F can no longer write different text for the same match,
because there is only one function that decides what the text is.

**Matching deliberately did not move.** The first attempt computed the editor's
replacements through `computeReplacements` outright, and it was built, measured
and reverted: that function is line-based, so it lost multi-line regex, the
`\n`/`\t` unquoting of the find field, and the Unicode character categorizer
behind whole-word — `café café` stops matching both halves the moment a plain
`\b` stands in for it. `SearchQuery` carries all three. Because the counter, the
highlights and replace-all now walk one query, they also cannot disagree about
what counts as a match.

**What the editor path still owns** is everything about *which* match: that a
replace only writes when the selection covers a match exactly (otherwise it
advances, which is what makes Replace safe to lean on), that the search wraps at
the end of the document, where the selection lands, and scrolling it into view.
That is `replaceNext`'s contract, rebuilt on the one cursor the public API
exposes — including two bounds that read like details and are not. The wrap
search stops at `from` for a regex query and `from + query.length` for a literal
one, so it can only return a match *behind* the cursor; searching the whole
document instead lets a match straddling the cursor come back and drags the
selection backwards. And the literal path alone rejects a result identical to
the range it started from, so a document with one match does not "advance" to
itself.

One trap is worth naming because it shipped once. **Read the cursor by shape,
never by class.** `RegExpCursor`'s constructor `return`s an unexported
`MultilineRegExpCursor` for any pattern containing `\s`, `\W`, `\D`, `\n`, `\r`
or `[^`, and that class is neither exported nor a subclass — so an `instanceof`
test silently loses the match object for exactly those patterns and writes the
raw `$1` template into the document.

`src/editor/find.ts` has no automated tests; §7 records why anything embedding a
CodeMirror view does not. A manual walk of both panels is its only coverage, and
the plan that introduced this split treats that walk as a required step rather
than a formality.

### Split panes: one buffer, one group

The workspace holds a flat list of **editor groups**, each with its own tab
order and active tab. `activeId` is now *derived* — the active buffer of the
active group — so every command written against "the editor" keeps working
unchanged, and `app.view` is re-pointed at whichever pane has focus.

**A buffer belongs to exactly one group.** This is the load-bearing invariant:
`buffer.state` stays the single source of truth that saving, dirty tracking,
session restore and project replace all depend on. Allowing the same document
in two panes would mean two CodeMirror views over one document, which CM6 does
not support without forwarding transactions between them and reconciling their
selections — and it would break that invariant for every feature already built.
The cost is that you cannot yet view one file in two panes; that is recorded as
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

Groups fold away when emptied — closing the last tab in a pane, or dragging it
out — because a layout with a hole where a pane used to be is worse than one
that heals. Closing a *pane* deliberately keeps its tabs, moving them into the
neighbour: that is a layout change, not a close-all.

One bug worth remembering: tab drag state lives in `UIService`, not in the
`TabBar` component. A tab dragged between panes starts in one component and is
dropped on another, and a receiving strip with component-local state has no
idea a drag is in progress — so it never calls `preventDefault` and the drop
silently does nothing.

### Folding is grammar-driven, and its chords are ours

Fold ranges come from the language grammar via CodeMirror's fold service, so
folding exists only for languages Nox ships a parser for. That is deliberate:
indentation-guessed folds are wrong often enough to be worse than none, and the
gutter simply shows no arrow where there is nothing to fold.

Fold state lives in the `EditorState`, which the workspace owns per buffer — so
folds survive a tab switch for free, exactly like selection and undo history.

CodeMirror ships a `foldKeymap`, and Nox does **not** use it. Its chords are
`Ctrl-Shift-[` / `Ctrl-Shift-]`, which on Windows and Linux are the same chords
Nox already binds to previous/next tab. Since the application keymap resolves on
the capture phase it would win, and folding would silently never fire on those
platforms. Folding is registered as application commands on the `⌥` variants
instead — which also puts every fold action in the palette and the shortcut
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
out as `Foo.render` — fuzzy matching runs over that title, which is what lets
either half of it find the method.

The deciding case is mixed-language files. `@codemirror/lang-html` configures
the HTML grammar to nest the CSS and JavaScript ones, so a single `.html` tree
holds `RuleSet` *and* `FunctionDeclaration` nodes; `.svelte` and `.vue` load
that same grammar in `editor/languages.ts`, so they are the same case. Rules
keyed by the file's language would look up "html", find the rules for a grammar
that deliberately collects nothing, and return an empty list for a file plainly
full of structure — silently, because an empty list is also a legitimate
answer. A shared name table has nothing to get wrong: it matches whatever node
it meets, whichever grammar produced it. It has to be the *language* rather
than the bare grammar, though — `@lezer/html` on its own does not nest, and
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
every private method in a file was dropped without a trace — 26 of `app.ts`'s
own 63 — and the tests agreed, because they were written from the same table.
Rust's `ImplItem` was read the same way, by taking the last direct
`TypeIdentifier` child: that is the target type in `impl Display for Foo`, but
in `impl Foo<T>` a `GenericType` wraps the type so there is no such child at
all, and in `impl<T> Display for Inner<T>` the only one left is the *trait*.
The impl's target is now taken by position — the type before the block —
because position is what the grammar keeps stable across all four shapes.
Guessing produces a list that is wrong rather than empty, which is the more
expensive kind of wrong.

**Markdown headings come out flat and need no exception to.** They nest by
level, not by containment: an ATX or Setext heading node spans only its own
line, so it is a sibling of what follows it and never an ancestor, and the
enclosing stack is empty again before the next heading is entered. A `flat`
flag was written for this on the strength of the opposite prediction, then
deleted — forcing it off against a real parse produced byte-identical output.

**Structure only, and JSON and HTML collect nothing themselves.** A file
exporting thirty constants would bury its own functions, and fuzzy matching
stops discriminating once everything is in the list, so variables, constants
and imports are left out. JSON has no declarations to collect. HTML's only
structural node is `Element`, so its own outline would be every `<div>` in the
file; what it contributes instead is the nesting above.

**A symbol list is only as good as the parse frontier**, and this is the part
that decides whether the feature is honest. `syntaxTree(state)` returns what
CodeMirror has parsed so far, not the document. On one measured run — a fresh
`EditorState` over a 39 KB JavaScript file of 1,000 functions — it stopped at
3,002 characters, and a plain read of it found 80 of the 1,000. Treat that as
an observation and not a constant: it follows from `Work.InitViewport`, a 3,000
in a `const enum` inlined into `@codemirror/language`'s build and exported
nowhere, so a version bump can move it and no test here pins it. What the tests
do pin is the shape of the problem — a fresh state over an ordinary document
is incomplete, a plain read caps well below the true count, and the palette's
budget can be exhausted.

So the palette asks for the whole document with a deadline,
`ensureSyntaxTree(state, doc.length, 100)`, and when that returns null it lists
what was parsed *and says the file is still parsing*. Listing the frontier
quietly was the option to avoid: a short list that looks complete tells you the
symbol is not there, which is worse than telling you nothing. The partial list
does not creep upward as you type, either — `syntaxTree` reads the snapshot
frozen at the last dispatch while `ensureSyntaxTree` mutates the cached
`ParseContext` without dispatching — so it sits at whatever the frontier held
until one call finishes inside the budget, and then it is the whole file at
once.

**"No symbols" is not one answer, so it does not get one sentence.** Four
things produce an empty list and they call for four different responses from
the reader: no parser exists for this language, a parser exists but has not
loaded yet, the budget above ran out before anything was found, or the file
genuinely has no structure. Only the last of those may say so.

The second is the one that bit. `EditorPane` attaches a grammar through a
dynamic import that resolves after the buffer is already on screen, so for a
moment there is a language id and no parser — and the first version of the list
said "No functions or classes in this file" about a file nothing had read yet.
No unit test could reach that window: they hand `fileSymbols` a parser
directly, or build an `EditorState` with the language already attached, and
neither goes near the dynamic import. It was found by opening a file in the
running app and pressing ⌘R before the import landed.

**Which of those four it is gets decided in `core/`, not in the component.**
`symbolListState` takes the four facts they are told apart by — a grammar
exists, it has loaded, the forced parse came back, how many symbols were found
— and names the state, the fifth being an ordinary list of symbols, partial or
not; `symbolRows` maps that to a sentence and does nothing else. The
order is the substance of the function, because a document with no parser
attached also comes back with no symbols: read after the parse facts, every
grammar state shows up as "no functions or classes in this file", which is the
bug above. That is testable and now tested, which it was not while it lived in
a Svelte file this repo had no harness for. It does now — see §7. "No file is
open" is the exception and stays in the component, settled before there is
anything to parse.

### Sticky scroll is a panel, and what pins is a pure function

Sticky scroll reads `core/symbols.ts`'s table too, so it never disagrees with
Go to Symbol about what counts as structure — declarations only, never `if`,
`for` or other control blocks.

**What pins is `stickyRows`, a pure function beside `fileSymbols`, not a
computation done inline in the extension.** It takes the symbol list, the top
visible line, the document and a cap, and returns rows outermost-first — no
`EditorView` in the signature, so it is tested against real parses with no
DOM, the same reason `symbolListState` was pulled out of `CommandPalette`.
Deciding which rows pin costs on the order of the symbol walk itself: about
0.012 ms on `src/app.ts` (2,690 lines, 67 symbols), against the walk's own
~1.378 ms — which is also why the symbol cache is one slot per `EditorView`
rather than one shared slot. Two views open on different files would otherwise
fight over a single cached parse.

**The strip is a CodeMirror panel (`showPanel`, `{ top: true }`), not a
floating overlay inside `.cm-scroller`.** A panel is positioned and sized by
CodeMirror itself, which accounts for it in the editor's own layout — so the
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
pick the focused tab — so the focus always landed on whichever tab was opened
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
code — nothing anywhere called it.

### Programmatic edits go through change sets

`workspace.apply(spec)` is the single entry point for any edit Nox makes on the
user's behalf — today project replace and agents, later plugins. It validates
the *whole* set before dispatching anything: every buffer present, every
declared base revision current, and every buffer's `ChangeSet` successfully
built. That last step is load-bearing and easy to skip — CodeMirror throws on a
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
across edits, undos and redos the workspace never saw — a second history of our
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

### Saves are written to a sibling, then renamed

`fs::write` truncates before it fills, so a crash, a power cut or a full disk
part-way through leaves the file empty and the old contents gone. Every save
goes to a temp file in the *same directory*, is flushed to the device, and is
then renamed over the target — atomic on every filesystem Nox targets, so a
reader sees the whole old file or the whole new one and never a torn one.

Same directory specifically: rename across filesystems is a copy, which would
put the truncation risk straight back. The old file's permissions are carried
across, and a symlink is followed so the link is not replaced by a regular
file. See `nox_write_text_file` in `src-tauri/src/fs.rs`.

### An agent may live in another process

`AgentTransport` has two implementations: `ProviderTransport` runs a
`ModelProvider` in this process, and `StdioTransport` talks to a child process
in line-delimited JSON, supervised by `src-tauri/src/agent.rs`.

The seam that matters is `Platform.spawnAgent`, which returns an
`AgentProcess` — send a line, subscribe to lines, subscribe to exit. The
transport is built from *that*, not from a command line, so it is testable
against a fake process: no fixture binary, and failure modes like a silent
agent or a crash mid-conversation become ordinary tests.

One rule in the contract is load-bearing: **an `AgentProcess` must buffer
output produced before a handler attaches.** A child can write its handshake
before `spawnAgent` returns, and dropping it loses the message every session
starts with.

Spawning is deliberately not reachable from the agent protocol. An agent
cannot start another agent — only the user, through configuration.

### One reader for every piped stream

Three threads read a child process's output: an agent's stdout and stderr in
`agent.rs`, and a language server's stderr in `lsp.rs`. All three go through
`agent::read_lines`, and sharing it is not tidiness — it is the fix for a
defect all three had.

`BufRead::lines()` yields `Err(InvalidData)` for a chunk that is not valid
UTF-8, so **one** stray byte ended a reader thread for good. On an agent's
stdout that cost the exit event too, because the `child.wait()` after the loop
blocks on a process that is still alive: the panel sat on "Working…" until Nox
was restarted. On a language server's stderr it was quieter and worse — stdout
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
false and turns itself off — no prompt redraw, no colour, no line editing —
and `vim` or `less` refuse to run at all. `src-tauri/src/pty.rs` uses
`portable-pty` so the kernel presents a real terminal, which is also why
Windows is not a special case in the renderer: a Windows pty is ConPTY, not a
file descriptor, and the crate hides that.

Two consequences follow, and both are visible in the code:

**Output is chunks, not lines.** A prompt — `$ ` — has no trailing newline, so
the line-buffered reads that are right for an agent would hold the prompt back
until the user typed something: the terminal would look frozen at the exact
moment it was ready. The reader thread emits `nox://pty-data` with whatever
arrives.

**A chunk boundary lands anywhere, including mid-character.** `Utf8Stream`
holds an incomplete trailing sequence back for the next read. Without it, any
non-English output or box-drawing character has a chance of arriving as two
replacement glyphs. It is a pure struct precisely so this is testable — the
case is near impossible to provoke against a real shell and trivial to write
down.

The panel keeps the rest honest. It sits below the editor rather than taking
it over, because watching a build fail beside the code that failed is the
point. It is mounted once and hidden with CSS rather than unmounted, since
disposing the xterm.js instance would throw away the scrollback — closing the
panel to glance at a file must not lose a build log. And `TerminalService`
deliberately does **not** store output: xterm.js already holds the scrollback,
and mirroring it into a signal would double the memory of a large `cat` for
nothing.

### Notes are not files, and are not stored like them

A note has no reader but the user. A file has git, a compiler, and an agent
staging a change set — which is why files get buffers, transactions, dirty
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
note with an empty body rather than dropping it — the title is still worth
keeping.

Finding a note is a **view** concern, and stays one. `load()` reads every body
into the signal, so the whole corpus is already in memory and filtering is a
pure function over it — `core/note-search.ts`, which is where the matching and
the snippet can be tested without a DOM. A search index inside `NotesService`
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
first inverts it — the flag is false for as long as the write is in flight, so
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
it has to be recorded as it happens and carried forward — which makes it a
`StateField` holding a `RangeSet`, mapped through every later change by
CodeMirror rather than by hand.

The alternative was a position index maintained in the workspace. It would
have reimplemented `RangeSet.map` and forced the workspace to intercept every
transaction to keep it current. Putting it in state also means background
buffers accumulate provenance correctly, because the workspace updates their
state whether or not a view exists.

Two costs are real. A user's edit has to *subtract* its own changed ranges,
because CodeMirror's default mapping extends a mark when you type inside it —
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
The webview could not do it anyway — the CSP is `default-src 'self'` with no
`connect-src` — and widening that to reach one port would open the app's
network surface permanently.

Two findings shaped the provider, both measured before it was written rather
than assumed. **There is no `tool_calls` field.** `qwen2.5-coder` advertises
`tools` in `ollama show` and never produces one, so actions arrive as JSON
inside the message content and the provider parses them — including stripping
code fences the model applies inconsistently between turns of one
conversation. Building on native tool calls would have worked with an
unknowable subset of models and failed opaquely for the rest.

**And the model cannot compute character offsets.** Given `proposal.stage`'s
real interface it produced a zero-width insertion of a whole function body:
the intent right, the arithmetic nonsense. That is the dangerous shape —
`proposal.stage` would accept it and the review panel would render a
convincing corrupt diff. So the model quotes text instead, and the provider
converts the quote to offsets against the text the model was shown when it
read the buffer, refusing anything it cannot find there or that matches twice.
The protocol is untouched; everything below the provider still receives real
offsets and never learns a model was involved.

Resolving against what the model read is the only thing the provider *can* do
— text is its whole window on the buffer — and it is not sufficient on its
own, because the user goes on typing while the model thinks. Offsets computed
before a keystroke are arithmetically fine and land in the wrong place: one
space typed at line 1 between a read and a stage turned a rename into
`export function product(a, b) {{`, rendered as a clean one-hunk diff with the
agent's name on it. So freshness is enforced in the runtime, which sees both
halves: it remembers the revision a buffer was at when the session first read
it, and refuses `proposal.stage` for a buffer that has moved since, as a
`stale` error the agent is told about and can clear with a fresh whole read.
`ReviewFile.baseRevision` does not cover this — it is captured at stage time,
which is after the drift.

Two reads establish that baseline, because two hand back a position in the
text: `context.bufferText`, and `context.selection`, which returns each range's
offsets and the text at them — everything "uppercase my selection" needs.

The rest establish nothing. A viewport, a path tree and a change-set list
locate no text at all. `context.openBuffers` is a deliberate trade rather than
a claim that a listing is harmless: filing every open buffer at once, on the
listing most sessions start with, would refuse the honest sequence of listing,
the user typing, reading a range and staging from it — and a false refusal
breaks working agents silently, which is worse than the hole it closes. The
hole is real and worth naming: `BufferSummary.length` *is* the end-of-document
offset, so a session that lists a buffer and appends to it stages against a
position that may have moved, with nothing to refuse it.

Only a read that hands back the whole document may *refresh* the baseline; a
narrower one establishes it without raising it. The asymmetry is the point: a
narrow read proves the agent looked at part of the buffer, not that the offsets
it is about to stage came from the current text, so letting one raise the
baseline would re-bless stale offsets on a revision that had caught up. Whole
is settled by comparing the read's answer to what a plain read returns rather
than by inspecting the parameters — so a range that happens to span the
document counts as whole however the parameters spell it, and does refresh.
Refresh itself trusts the agent to stage from its most recent read: a session
that reads, lets the buffer move, reads again and then stages offsets from the
*first* read is not refused by this guard, because the baseline has caught up
with the buffer. Only the agent knows which read it computed from, which is
what the declaration below is for.
The comparison is used because the reader clamps the range and reads a missing
`lines` as
the whole document — so `lines: null` and a span past the end are whole reads
that a parameter test files as narrow, and only a comparison cannot drift.

Inference stops there. A buffer for which the session called neither of those
two reads — listing it does not count — has offsets from somewhere the runtime
cannot see, and no rule over what it *watched* distinguishes the read an agent
computed from among several. So `proposal.stage` gained an optional
`baseRevisions`: buffer id to revision, the same field `ChangeSetSpec` has
always had, in the plain-JSON shape the wire can carry. Any declared entry the
buffer is no longer at refuses the stage, under the same `stale` code, and that
includes an entry for a buffer no edit names — `workspace.apply` reads the
field that way, and an agent that read a file and concluded it needed no edit
has a conclusion that goes stale when the file moves. A declared entry for a
buffer that is not open at all refuses too, under `not-found` rather than
`stale`, since there is no revision on record to compare against.

It is checked **in addition to** the read tracking, never instead of it: an
agent that declares the current revision while holding offsets from an older
read is describing a check it did not do, and the baseline still refuses it.
A malformed declaration refuses too, rather than being ignored — an agent that
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
both ordinary first-run experiences — the model name has a typo, or nothing is
listening — and a session that reported success for either would be worse than
one that crashed. So the provider throws, naming the configured host or
quoting the server's own words, and the session ends `Failed` with the message
in its audit trail. `http.rs` stays ignorant of what an error body looks like:
it forwards a status and an opaque string, and the knowledge of which field
carries the message lives with the vendor-specific code that already knows the
request shape.

The cost is a parser where a schema would have done, and a vocabulary the
model is told about in prose rather than declared. That is the price of local
models as they are, not as their APIs describe them.

### Selection edits are composition; the scope only ever defaults a checkbox

`agents.runOnSelection` — **Edit Selection with a Model…** — adds no new
machinery. The session, the audit trail, the provenance author, the
permission model, job cancellation and the stale-read guard all come from
`AgentRuntime` unchanged, and the result lands in `ReviewService` exactly as
any other proposal's does. What is new is two things: the selection reaching
the model through `brief()`, and a scope that changes a hunk's default in
`review.stage`.

`SessionOptions` gains `scope?: ReviewScope` — `{ bufferId, fromLine, toLine }`
— captured in `app.ts` before the instruction is even typed, so it describes
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
since moved costs nothing sharper than a checkbox defaulted the wrong way —
confirmed in the walk, where the identical request against the identical
buffer, once through **Edit Selection with a Model…** and once through a
plain `Run Agent…`, staged the same hunk and differed only in which side the
checkbox started on.

The alternative was to refuse a hunk outside the scope outright rather than
merely default it unkept. Rejected: a companion edit is often the correct
one — a new import for a change requested in the middle of a file, the other
half of a rename the model reached for on its own — and refusing it would
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
person would use. No unit test caught this — every scripted provider in the
suite passes ids by construction — which is what the walk was for.

`brief()` is on the record, and it took a second pass to get there. It
originally read straight off `ContextService`, skipping the
`context.reader(principal)` proxy every other read goes through — understandably,
since the brief is assembled before any request exists and `#handle` binds that
proxy per request. The effect was that up to `SELECTION_MAX_CHARS` (8,000)
characters of the user's code opened a session having been recorded nowhere.
Not a security hole — the text leaves the machine only once `net.request` is
granted, and a model could read the same buffer through the recorded API
anyway — but `reads` is meant to be the whole account of what a session saw,
and it was not.

It now takes a principal and reads through the proxy, and a session records a
`brief` action naming the buffer and how much text went with it. That action
is its own `AgentAction` variant rather than a `read`: the trail means *what
the agent did*, and the brief is what Nox handed it unasked. Filing one as the
other would misattribute the thing being made honest. It is recorded only when
a selection was carried — open-file names and line counts were always in the
brief, and a line on every session for those would bury the case the record
exists for.

### A prose answer is a different question, not a different agent

**Ask About Selection…** and **Explain Selection** reuse what the edit path
reuses — the session, the job, cancellation, the audit trail, the permission
model, the brief and the selection inside it — and change exactly one thing:
what Nox asks for back. The one place that could not be composition was the
provider, and the reason is a defect rather than a design.

`OllamaProvider`'s loop is action-mandatory. `parseTurn` splits each reply
into narration and one JSON action, and a reply that is pure prose returns no
action and the error *no JSON object in the reply*. An actionless turn
increments `consecutiveFailures`, pushes `Reply with one JSON object` back at
the model, and **on the second one throws** — which the runtime turns into a
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
well. The cost is that the answer arrives whole rather than progressively —
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
than stopping at the in-process transport — telling a child process the
session is one thing while the runtime treats it as another is a lie that
surfaces later as an unexplained refusal.

Two alternatives cost more. Asking the model to put its answer in a
`session.summary` string needs no interface change at all, and asks a small
local model to fit multi-paragraph prose — newlines, quotes, backticks,
fences — inside a JSON string. That is the surface the provider section
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
bury the reads the trail exists to show — the same distinction the `brief`
variant above draws, made the same way and for the same reason. The panel
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
rather than showing none — which is what an earlier version did, matching a
fence's info string whether or not a block had opened, so an inline fence
tagged `json` ate the word after it. A deliberately bounded renderer may
render prose plainly; it may never swallow it.

### A review narrows the change set; it does not apply hunks

`ReviewService.stage(spec)` computes what each buffer *would* say and diffs it
against what the buffer says now. CodeMirror states are immutable, so working
out the result costs a transaction that is computed and thrown away — no
dispatch, no history entry, nothing on screen.

The panel covers the editor, so it can be put away without deciding: Escape (or
Close) hides it and keeps the staged set, going to any file does the same, and
the status bar offers it back. Apply and Discard remain the only two ways to
resolve it — neither should be reachable by accident, and neither should be the
only way to look at the file you are reviewing.

Accepting a subset does **not** apply those hunks individually. The accepted
hunks are converted back into offsets and handed to `workspace.apply` as one
change set, so the reviewed result lands in a single transaction and one ⌘Z
takes it back. Applying per hunk would reintroduce exactly the partially-applied
state the transaction layer exists to make unrepresentable.

The diff lives in `core/diff.ts` — Myers' O(ND) algorithm over lines, with the
common prefix and suffix trimmed first. `splitLines` keeps each line's
terminator, which makes `lines.join('')` exact and makes a line index equal to a
CodeMirror line number minus one; that is what keeps newline handling out of the
offset arithmetic entirely.

See [AGENT-PLATFORM.md](AGENT-PLATFORM.md) §2.3.

### The context API hands out data, never handles

`ContextService` is the read side of the platform: buffer summaries, text by
line range, selections, live viewports, the workspace tree, recent
transactions. Everything it returns is plain data that survives
`JSON.stringify` — never a `Buffer`, an `EditorState` or a `Signal`.

That is a correctness property, not a style preference. Every mutation is
supposed to go through `workspace.apply` under the permission model, so a
caller holding a live object could edit behind it. `tests/context.test.ts`
asserts the round trip, which a class instance would fail.

Reads are **recorded rather than gated**: context cannot leave the process by
itself, `net.request` is the capability that governs that, and prompting per
read would mean a dialog for every keystroke of an agent's thinking.
`context.reader(principal)` binds the caller once so the log cannot acquire
anonymous entries.

`workspaceTree` is built from the quick-open index rather than a fresh walk, so
it shows what `Mod P` shows and there is only one definition of "the project".

See [AGENT-PLATFORM.md](AGENT-PLATFORM.md) §2.5.

### Permissions are checked in exactly one place

`CommandRegistry.execute` takes a principal and consults a single guard before
running anything that declares a capability. That one check is sufficient
*because* of the rule the registry already enforces — every action in Nox is a
command — so there is no second path for a plugin or an agent to take.

Commands declare `capabilities`, and `resourceFrom` to name what they are about
to act on, which is what lets a grant be scoped to a file rather than to the
whole disk.

**The user never reaches the check.** `execute` called without a principal —
every menu, keybinding and button — skips the guard, and `PermissionService`
short-circuits `{ kind: 'user' }` regardless. This is load-bearing, not an
optimisation: a model that can interrupt a human mid-keystroke is a model they
switch off, and a permission layer nobody runs protects nothing.

Denials **throw** `PermissionError` rather than returning false, because false
is what a disabled command returns and the two must not be confused.

See [AGENT-PLATFORM.md](AGENT-PLATFORM.md) §2.6.

### Jobs compute; the main path applies

`JobRunner` owns anything long-running: the project search walk, project
replace, and whatever comes next. The rule that makes cancellation safe is
structural rather than a matter of care — **a job never mutates a buffer.** It
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

Stage, commit, branch touches git through exactly six Rust commands — status,
branches, stage, unstage, commit, switch — each `git -C <root>` run with a
hand-picked, literal argv (`--literal-pathspecs`, `--` before every pathspec)
and no shell in the middle to reinterpret a `*` in a filename or a branch
name. **There is no generic seam that takes an arbitrary git subcommand or
flag.** A future capability means a new, equally fixed command, on purpose —
so the argv a feature runs is always the one `git.rs` shows, never one
assembled from parts a caller chose. The corollary a future reader would
otherwise undo: **a git failure is shown verbatim, never translated.**
`git_error` returns git's own stderr — or stdout, where git prints "nothing
to commit" there instead — with an `io:` prefix and nothing rewritten, so
what the panel reports is what a terminal would have said.

The six were also chosen defensively, not for convenience. Unstage runs `git
reset -- <pathspec>`, not the more obviously-named `restore --staged`,
because the latter fails on a repository with no commits yet — right after
`git init` — with "could not resolve HEAD", found by running both against a
real repo before picking one rather than by reading a man page; pathspec-
limited `reset` handles that case cleanly and never touches the working
tree either way. Deliberately absent for the same reason the README leads
with "It does not lose your work. Ever.": no push, pull or fetch (nothing
leaves the machine), no rebase, amend or force (history is never rewritten),
no discard, stash or `checkout --` (the working tree is untouchable by
construction of the commands chosen — `switch` refuses over a dirty conflict
rather than forcing through it). Hunk-level staging is deliberately out of
this set too: it is the one place the feature would construct input for git
(`apply --cached`) rather than naming files, and it gets its own envelope
read when it is built.

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
keymap declined because it is **disabled** — and the menu item dispatches
through `CommandRegistry.execute`, which refuses a disabled command anyway. So
the menu can never run something the keyboard would not. Menu items are
nonetheless always drawn enabled; mirroring ~130 enablement predicates across
the IPC boundary on every state change is not worth it, and is recorded as debt.

### The window is remembered in Rust, beside the session

Window size and position persist to `window.json` in the app config directory,
written by `src-tauri/src/window_state.rs` and restored through the same
`apply_geometry` that `--geometry` uses — so there is exactly one clamp
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
*used to be* — and since that is usually the centred default, the remembered
position would creep back to centre one launch at a time.

### Long panels are windowed, and each publishes its own row height

The explorer and the search results both render flat, uniform-height row
arrays that can run to thousands of entries — 5000 matches is `MAX_RESULTS`,
and a directory has no bound at all. Both window: a `viewportHeight > 0` guard
(so jsdom, which has no layout, still renders everything and tests stay
meaningful), a `MIN_ROWS_TO_WINDOW` floor so short lists pay nothing, spacer
divs preserving scrollbar length, and `aria-setsize`/`aria-posinset` on every
row — mandatory rather than decorative, because the DOM no longer holds the
full set for a screen reader to count.

Scroll-into-view is **index arithmetic**, not `scrollIntoView` on a
`.focused` element. The focused row can legitimately be outside the rendered
window, at which point there is no element to scroll to; a reveal built on the
DOM silently stops working exactly when the list is long enough to need it.

Each panel publishes its row height as its **own** custom property —
`--nox-tree-row-h` at 23px, `--nox-search-row-h` at 22px — read back by that
panel's CSS. One shared name was the obvious simplification and is wrong: the
two heights differ, and a single inherited property would silently paint one
list at the other's pitch while the arithmetic used the correct one. The rule
is that the number the arithmetic uses and the number the CSS paints must be
the same token, not that all panels share a token.

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
them; `ignore`'s overrides are last-match-wins, so excludes added before
includes were inert — and the test asserting otherwise encoded the *fake's*
behaviour; `BufRead::lines()` ends a stream on one invalid byte, which the
fake could not represent because it deals in JS strings.

The same reasoning applies to test *helpers*. `search_integration.rs` re-types
the walker configuration rather than importing it, which is why it certified
both search defects as absent — a copy of the logic under test is not a test.

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

## 6. Performance notes

- **Startup:** grammars are dynamic imports, chunked separately by Vite. Opening
  a file never waits on a parser — the text paints first and highlighting
  arrives on the next tick.
- **Large files:** CodeMirror virtualises the viewport and stores the document
  as a rope, so scroll cost is independent of file size. Files over 64 MB are
  refused (`MAX_FILE_BYTES`); binaries are detected by a NUL byte in the first
  8 KB and refused with a clear message.
- **Search:** match counting stops at 10,000 (`MAX_COUNTED_MATCHES`) and the
  count is shown as `10000+`. Highlighting is viewport-bounded, so a query with
  40,000 hits costs the same as one with three.
- **Quick-open index:** capped at 20,000 files and 12 directory levels, built
  off the main path and abandoned if the root changes mid-walk.
- **Fuzzy matching:** an optimal DP rather than a greedy scan. Greedy ranking is
  visibly wrong on paths — typing `path` should not match the scattered
  `p`,`a`,`t`,`h` across `src/core/…`. Inputs are short, so the DP is well
  under a frame across thousands of candidates.
- **Motion budget:** nothing over 190 ms, opacity/transform only, and nothing
  animated on the typing path.

---

## 7. Known debt

Recorded rather than hidden. Each is a deliberate MVP trade.

| Item | Detail |
|---|---|
| Problems and References are not windowed | They share the flat-row shape the explorer and search now window (see §4), but their natural limits are lower. Re-decide on their own merits rather than inheriting the explorer spec's out-of-scope line. |
| Commit is enabled while a merge conflict is unresolved | The panel names conflicts and refuses to stage them, but the Commit button does not know about them. Real git refuses ("committing is not possible because you have unmerged files") and the refusal surfaces through the existing error path, so the outcome is correct and merely late. `MemoryPlatform.gitCommit` does not model the refusal, so nothing tests it. |
| `undoSession` still revokes grants as a side effect | Revocation is its own command now (`permissions.revokeGrants`), so undoing an agent's *work* arguably should leave its *permissions* alone. The two are still welded in `agent/runtime.ts`; the panel's toast says so rather than surprising the user. |
| The explorer does not dim gitignored files | `git.rs` runs `--porcelain=v2 --branch -z` without `--ignored`, so the `!` records never arrive. Real support is a Rust change plus a Platform-boundary change, not a component one. |
| A collapsed folder shows nothing about what is inside it | The tree marks changed and unsaved *files*; a collapsed `src/` hiding forty changes still reads as quiet. Needs an ancestor-prefix set — cheap, and on the same off-typing-path trigger — plus a decision about what a folder's marker looks like. |
| A save can still refresh the whole tree | FSEvents flags are sticky per path, so an in-place rewrite of a file renamed earlier in the session arrives as `Modify(Name(_))` and is classified a rename; Nox's own atomic save adds a `Create` and three renames of its own. The event kind cannot tell a sticky flag from a real rename — only re-reading the tree can — so the fix belongs in `FileTreeService.refresh()` reporting whether anything actually changed. |
| The quick-open index still starves during a sustained write storm | The 1 s coalesce ceiling bounds the *flush*, but each structural flush resets `REINDEX_MS`, so the project re-walk still waits for the storm to end. Deliberate — the full walk is the expensive one — but worth revisiting. |
| `search_integration.rs` re-types the walker configuration | Its `walk()` helper is a hand-copy of `search.rs`'s builder with a truncated exclude list and no include handling, which is why four integration tests passed throughout both search defects. Importing the real `plan_walk` needs `pub mod search` in `lib.rs`. |
| The browser search walks `node_modules` and `.git` | `MemoryPlatform.searchProject` applies no always-exclude list, so the dev target searches machine directories the desktop build prunes. Divergence in the harmless direction, but it is the fake being wrong. |
| Dirty flag on huge files | See §4. Above 2 MB, undo-to-saved leaves the tab dirty. |
| Watch mtime resolution | See §4. A coarse-mtime filesystem can let an external write in the same second as a save be misread as our own. |
| Watch is root-only | Files opened outside the workspace root are not watched. One watcher, one root. |
| Folds are not persisted across sessions | Fold state lives in the buffer's `EditorState`, so it survives tab switches but not a restart. Cursor positions *are* persisted — see §4. |
| Scroll position is not persisted | Scroll is a view concern and not part of `EditorState`. On restore the cursor is scrolled into view instead, which covers the case people actually mean. |
| Only UTF-8 is read and written | With or without a BOM, which is detected and preserved. A file in a legacy encoding does **not** open as mojibake — `nox_read_text_file` refuses it with `not-text: … is not valid UTF-8`, so nothing can be written back corrupted. The cost is that such a file cannot be opened at all. Real support means a decoder in Rust, not a heuristic in TS. |
| Grouped undo is bounded by CodeMirror's history depth | A change set old enough to have fallen out of a buffer's history cannot be undone as a group. The project-replace panel's journal covers that case for replace; nothing else needs it yet. |
| The transaction log does not survive a restart | Deliberate — see §4. Undo history does not either, so a persisted log would list changes it could not undo. |
| Agent processes are not sandboxed | A configured agent runs with Nox's own privileges. The permission model governs what it may ask *Nox* to do, not what its own process can reach — a stdio agent is trusted code you chose to run, like a shell plugin. |
| No model provider ships | Deliberate: a default provider would be a vendor in the core. The Agents panel says so rather than offering an input that cannot work. |
| One file cannot be open in two panes | A buffer belongs to exactly one group — see §4. Viewing one file in two panes needs a second CodeMirror view over the same document with transactions forwarded between them. |
| Splits do not nest | The layout is a flat row or column, not a tree, so you cannot have a column split inside a row. |
| macOS trash has no "Put Back" | Nox trashes via `NSFileManager` rather than Finder/AppleScript, because the AppleScript path blocks for two minutes and then fails when Finder is unavailable. A trashed file restores to the Trash folder, not its original location. Covered by `tests/fileops_integration.rs`. |
| Reloading the window drops in-memory agent state | Sessions and the transaction log do not survive **Reload Window**; unsaved work does, because it is in the session. The reload also kills any running agent, which is the point — a renderer that no longer exists cannot talk to them. |
| Grammar coverage | Parsers ship for TS/JS/JSX/TSX, JSON, HTML, CSS/SCSS, Markdown, Python, Rust. Other languages open and edit correctly but render unhighlighted; the status bar greys the language name to say so. |
| The native menu is macOS-only | Windows draws its menu bar *inside* the window frame and Nox turns decorations off there to draw its own title bar, so a menu would land underneath it. Linux is not blocked by that but the accelerator argument in §4 is WKWebView's, not WebKitGTK's, and has not been checked against it. `nox_set_menu` returns `Ok(())` without setting a menu on both. |
| Menu items are always drawn enabled | Enablement is re-checked when the item is chosen (`CommandRegistry.execute` refuses a disabled command), so nothing runs that should not — but a disabled item looks live and does nothing when clicked. Greying them means pushing every state change in the app across the IPC boundary to keep ~130 items in step. |
| The menu has no Close Window item | `PredefinedMenuItem::close_window` carries ⌘W and Nox binds ⌘W to `file.close`, so both in one menu would be two items claiming one accelerator. Nox has no `window.close` command to offer instead; the traffic light and ⌘Q are the ways out. |
| `--geometry` suppresses geometry persistence for that launch | Deliberate — see §4 — but it means a walk cannot be used to *set* a remembered window, and a malformed `--geometry` falls back to an ordinary launch that does persist. |
| Browser build does not persist edits | Deliberate: it is for developing the UI, not storing work. Settings and session do persist via localStorage. |
| Components embedding CodeMirror are tested for wiring and text, not geometry | `EditorPane` mounts under jsdom (`tests/lsp-rendering.test.ts`, `tests/lsp-paint-target.test.ts`): a diagnostic paints under the text its range names, the picker lists what the server sent, the hover tooltip carries the server's markdown as text. jsdom has no layout, so a tooltip's placement and which symbol was under the pointer are not checkable — `tests/support/jsdom-layout.ts` fills `Range.getClientRects`, the one method CodeMirror needs to *run*, with a single all-zero rectangle whose numbers are jsdom's own and whose existence is the one invented fact, and says what that forbids a test from claiming. The first feature whose claim is geometric (a tooltip that must sit beside the pointer, an inlay hint that must not shift the line) is when vitest browser mode earns its browser download in CI. Of the corrected hover claim, "shows the server's markdown as text" is test-backed; "stays while the pointer is over the span" is read from `@codemirror/view`'s `HoverPlugin` and cannot be driven under zero geometry. |

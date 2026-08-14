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
│  ├─ diff.ts            Myers line diff; hunks for review and, later, Git
│  ├─ replace.ts         Replacement computation and expansion
│  ├─ languages.ts       Language identity (no parsers)
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
│  ├─ keymap.ts          Chord parsing, resolution, display formatting
│  ├─ config/schema.ts   THE settings schema — types derived from it
│  ├─ config/index.ts    ConfigService: load, coerce, persist
│  ├─ workspace.ts       Buffers, tabs, dirty tracking, file operations,
│  │                     change-set application and grouped undo
│  ├─ transactions.ts    ChangeSet, Author, the transaction log
│  ├─ review.ts          Staged change sets; hunk accept/reject
│  ├─ context.ts         Structured read access for programmatic callers
│  ├─ permissions.ts     Capabilities, policy, prompts, decision log
│  ├─ jobs.ts            Long-running work: progress, cancellation
│  ├─ agent/protocol.ts  The agent wire contract and transport seam
│  ├─ agent/provider.ts  Vendor-neutral model interface
│  ├─ agent/runtime.ts   Sessions, audit trail, session-level undo
│  ├─ agent/stdio.ts     Agents in another process, over line-delimited JSON
│  ├─ filetree.ts        Explorer model + quick-open index
│  ├─ watcher.ts         Reacts to changes made outside Nox
│  ├─ session.ts         Restore folder, tabs, cursors and unsaved work
│  ├─ ui.ts              Overlay/focus state; owns "what does Escape close"
│  ├─ notifications.ts   Toasts
│  └─ search.ts          Project search: query, options, streamed results
│
├─ editor/               Everything CodeMirror-shaped
│  ├─ theme.ts           Nox theme + syntax highlight style
│  ├─ extensions.ts      Composes extensions from settings, one Compartment
│  │                     per setting group
│  ├─ languages.ts       Lazy grammar loading
│  ├─ commands.ts        Commands CM6 lacks (add cursor above/below, go to line)
│  ├─ find.ts            Drives CM's search engine from Nox's find panel
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
├─ search.rs             Parallel, gitignore-aware project search
└─ watcher.rs            Recursive notify watcher; filters and forwards events
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

### Nox draws its own find UI

CodeMirror's search *engine* is excellent and its panel looks nothing like Nox.
We keep the engine (`SearchQuery`, `findNext`, `replaceAll`) and draw our own
panel. One consequence worth knowing: CM ties match highlighting to the
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

**Open files change through a transaction**, not a write. `workspace.applyEdits`
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
| Dirty flag on huge files | See §4. Above 2 MB, undo-to-saved leaves the tab dirty. |
| Watch mtime resolution | See §4. A coarse-mtime filesystem can let an external write in the same second as a save be misread as our own. |
| Watch is root-only | Files opened outside the workspace root are not watched. One watcher, one root. |
| Folds are not persisted across sessions | Fold state lives in the buffer's `EditorState`, so it survives tab switches but not a restart. Cursor positions *are* persisted — see §4. |
| Scroll position is not persisted | Scroll is a view concern and not part of `EditorState`. On restore the cursor is scrolled into view instead, which covers the case people actually mean. |
| Only UTF-8 is read and written | With or without a BOM, which is detected and preserved. A file in a legacy encoding opens as mojibake rather than being detected. Real support means a decoder in Rust, not a heuristic in TS. |
| Grouped undo is bounded by CodeMirror's history depth | A change set old enough to have fallen out of a buffer's history cannot be undone as a group. The project-replace panel's journal covers that case for replace; nothing else needs it yet. |
| The transaction log does not survive a restart | Deliberate — see §4. Undo history does not either, so a persisted log would list changes it could not undo. |
| Agent processes are not sandboxed | A configured agent runs with Nox's own privileges. The permission model governs what it may ask *Nox* to do, not what its own process can reach — a stdio agent is trusted code you chose to run, like a shell plugin. |
| No model provider ships | Deliberate: a default provider would be a vendor in the core. The Agents panel says so rather than offering an input that cannot work. |
| One file cannot be open in two panes | A buffer belongs to exactly one group — see §4. Viewing one file in two panes needs a second CodeMirror view over the same document with transactions forwarded between them. |
| Splits do not nest | The layout is a flat row or column, not a tree, so you cannot have a column split inside a row. |
| macOS trash has no "Put Back" | Nox trashes via `NSFileManager` rather than Finder/AppleScript, because the AppleScript path blocks for two minutes and then fails when Finder is unavailable. A trashed file restores to the Trash folder, not its original location. Covered by `tests/fileops_integration.rs`. |
| Reloading the window drops in-memory agent state | Sessions and the transaction log do not survive **Reload Window**; unsaved work does, because it is in the session. The reload also kills any running agent, which is the point — a renderer that no longer exists cannot talk to them. |
| Explorer is not windowed | The tree renders every visible node. Fine to a few thousand; needs virtualisation beyond that. The flat-node model was chosen to make that a contained change. |
| Grammar coverage | Parsers ship for TS/JS/JSX/TSX, JSON, HTML, CSS/SCSS, Markdown, Python, Rust. Other languages open and edit correctly but render unhighlighted; the status bar greys the language name to say so. |
| Keybindings are read-only | The panel lists them; it cannot rebind. Bindings are already data, so this is a UI change. |
| No custom native menu | The default Tauri menu supplies the system items. A Nox menu dispatching command ids is straightforward. |
| Browser build does not persist edits | Deliberate: it is for developing the UI, not storing work. Settings and session do persist via localStorage. |

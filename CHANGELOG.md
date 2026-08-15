# Changelog

All notable changes to Nox are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Local models.** Point Nox at an Ollama server in `agents.json` and an
  agent can read your workspace and propose a change set, reviewed hunk by
  hunk before anything is written.
  - It runs entirely on your machine. No account, no telemetry, and the HTTP
    client refuses anything that is not loopback.
  - The agent can read and propose. It cannot run commands.
  - Edits are quoted, not positional: the model names the text to replace and
    Nox finds it in what the model read, refusing anything ambiguous rather
    than guessing. If you edit the file after the agent read it, the proposal
    is refused rather than applied at offsets that have moved.
  - When the server is unreachable or rejects the request, the session ends
    failed and says which — naming the host, or repeating the server's own
    message. A model you have not pulled says so.

- **A terminal.** A real pty rather than piped stdio, so programs see a
  terminal and behave like it: colour, line editing, job control, and `vim` or
  `less` actually run. <kbd>⌃`</kbd> toggles it, or **Toggle Terminal** in the
  palette.
  - It sits *below* the editor rather than taking it over — watching a build
    fail next to the code that failed is the entire point.
  - Hiding the panel does not kill the shell, and the scrollback survives:
    closing a terminal to glance at a file should not lose a build log.
  - Colours come from the same token file as everything else, so it follows
    Eclipse and Umbra without a second palette to maintain.
  - `terminal.shell`, `terminal.fontSize`, `terminal.scrollback` and
    `terminal.height` are in Settings. Empty shell means your login shell.
  - The browser build says it has no terminal rather than showing a dead one.

- **Notes.** A third sidebar section for your own notes — a list, and an
  editor for the one you pick. <kbd>⌘⇧N</kbd>, or **Show Notes** in the
  palette.
  - They are not workspace files and are stored outside any project, so
    opening a different folder never changes or hides them.
  - Always saved, a moment after you stop typing. There is no save button and
    no setting: a preference that stops saving your notes is a preference that
    loses them.

- **Change marks.** Lines changed by a project replace, an agent or a plugin
  carry a quiet bar in the gutter, and hovering says who changed them and why.
  **Go to Next Change** walks them.
  - Typing in a marked region clears the mark there, so the gutter decays as
    you review rather than accumulating all session.
  - Marks last for the session. Persisting them would mean attribution that a
    `git checkout` could silently make wrong.
  - **Show Change Marks** turns the gutter off for anyone who finds it noisy.

### Fixed

- **A project-wide replace marked whole files as changed, not just the lines
  it touched.** Replace collapsed every match in a file into one edit spanning
  the whole document, so provenance — which marks whatever a change set
  actually inserted — saw one insertion covering the entire file. Replace now
  emits one edit per match, at the positions it already computed, so only the
  matched spans carry a mark.
- The reference-agent test and two documentation links pointed at
  `examples/agents/uppercase.mjs`, which has been
  `examples/uppercase-agent.mjs` since v0.2 was tagged. The test spawned a
  path that did not exist and had been failing since the release commit.
- Config files are written atomically, so a crash part-way through a save can
  no longer truncate your settings, session or notes.

### Changed

- CI builds and tests on every push, and a tag now produces macOS (Apple
  Silicon and Intel) and Linux binaries rather than Apple Silicon alone.
- Linux ships a `.deb` and an `.rpm`, both around 3 MB. The AppImage is gone:
  it bundles its own GTK and WebKit and came to 77 MB, which is not an
  editor that claims to be about 4 MB.
- A tag that disagrees with the version in `tauri.conf.json` is now refused.
  The bundler names assets from the config rather than the tag, so the two
  drifting apart shipped binaries labelled with the wrong release.

## [0.2.0] — 2026-08-13

### Added

- **An agent runtime, and a record of everything it does.** Agents connect over
  a defined protocol and can only change things the way you can: through
  commands, under the permission model, as a change set you review first.
  - The **Agents** panel lists every session with what it read, what it ran,
    what it was refused, and what it proposed — and one button that takes back
    everything a session landed, across every file.
  - A refused action stays in the record. What an agent *tried* is as worth
    seeing as what it managed.
  - Two agents on the same file cannot corrupt it: whichever is working from a
    version that has moved is refused, rather than being locked out or queued.
  - **No model provider ships with Nox.** The interface is vendor-neutral by
    design and the core names no vendor; a provider plugs into it. Until one
    does, the panel says so instead of pretending.

- **Saving can no longer truncate a file.** Writes go to a temp file beside
  the target, are flushed to the disk, and are then renamed into place — so a
  crash, a power cut or a full disk part-way through leaves the previous
  version intact rather than an empty file. Permissions are preserved, and a
  symlink is written *through* rather than replaced.

- **Agents can run as separate programs.** An agent is any executable that
  reads and writes one JSON object per line on stdin and stdout — a shell
  script, a Python file, whatever you like. Nox starts it, supervises it, and
  shows what it did in the Agents panel like any other session.
  - [`examples/uppercase-agent.mjs`](examples/uppercase-agent.mjs) is a
    complete working agent in about eighty lines, meant to be copied.
  - A crash, a hang at startup, or garbage on the wire fails the session with
    the agent's own error message rather than leaving it stuck.
  - An agent cannot start another agent. Only you can.

- **Review changes before they touch your files.** A proposed change set is
  staged rather than applied: the editor area shows it as a diff, file by file
  and hunk by hunk, and you keep or reject each one.
  - Nothing is written until you press Apply, so discarding costs nothing and
    there is never a moment where half a change is in your files.
  - What you keep lands as a **single** change, so one <kbd>⌘Z</kbd> takes the
    whole reviewed result back.
  - If a file changes while you are reviewing, Apply refuses rather than
    overwriting it — and the review stays open, so your decisions are not lost.
  - Everything starts kept. Review is for catching the wrong ones.

- **Two flaky tests.** The folding suite asserted against however far
  CodeMirror's time-budgeted parser had got, and two agent helpers counted
  loop iterations instead of measuring elapsed time — so both failed under CPU
  load and passed on an idle machine. The suite now runs clean repeatedly with
  the machine saturated.

- **An agent could only be run once per window.** The desktop shell kept a
  finished agent registered under its process id forever, so after a window
  reload the next one was refused with *"an agent with id proc-1 is already
  running"*. Ids are now released when the process exits, are unique to each
  load of the window, and any agent still running is stopped when the window
  goes away rather than orphaned.

- **A finished agent session said "Awaiting review" forever.** It now says
  **Applied** once you keep any of its changes, or **Dismissed** if you turn
  the proposal down.

- **Reload Window** (from the palette). The desktop shell wires no reload of
  its own, so there was no way to get a clean slate short of quitting. Unsaved
  work survives it; agent sessions and the transaction log do not, which is
  why it is deliberately not on the keyboard.

- **Typing in a dialog kept only the last character.** Rename, New File, Save
  As and agent instructions all pre-select their text, and the code that did
  the selecting re-ran on every keystroke — so each character replaced
  everything typed before it. Renaming `README.md` to `GUIDEBOOK.md` produced
  `K.md`.

- **A finished agent left its process running.** The child process was only
  shut down when a session was cancelled, so every completed run leaked one for
  as long as the editor stayed open.

- **Agents can actually be run.** **Configure Agents** writes an `agents.json`
  beside your settings; **Run Agent…** asks which one and what you want done,
  and starts it. Everything the runtime, permission model and review flow were
  built for is now reachable without writing code.
  - The Agents panel moved out of the sidebar into the editor area, where an
    audit trail of what a session read, ran and was refused fits on one line
    per entry instead of wrapping to four.
  - A syntax error in `agents.json` is reported rather than looking like
    having configured nothing.

- **Saving no longer rewrites your whole session on every keystroke.** Unsaved
  work is kept in per-buffer backup files rewritten only when that buffer
  changes, so `session.json` stays a few hundred bytes instead of growing to
  the size of the file you are editing. Typing in a large modified file was
  writing megabytes every few hundred milliseconds.

- **A read API for programmatic callers.** Structured access to what is open,
  what is selected, what is on screen, the project tree and what has recently
  changed — the half of the platform an agent reads from, with the permission
  model governing the half that writes.
  - Everything it returns is plain data. Nothing that could be used to change
    a file behind the permission check ever leaves it.
  - Reads are not gated — context cannot go anywhere on its own — but every
    read a non-human makes is recorded alongside its edits, so what it looked
    at is as answerable as what it did.
  - Still nothing using it but its own tests, one of which drives a fake agent
    the whole way: read the file, propose a change, get refused, get allowed,
    get undone in one step.

- **A permission model for anything that is not you.** Every command that
  writes, creates, deletes, shells out or opens a folder now declares what it
  needs. A plugin or an agent asking for one of those is checked against a
  policy; you are not.
  - **You never see a permission prompt.** Pressing <kbd>⌘S</kbd> is not
    something Nox asks you to approve, whatever the policy says.
  - Prompts are per-file, so allowing a write to one file does not quietly
    allow one to another. *Allow for this session* remembers; *Allow once*
    does not.
  - A path outside the open folder is always asked about, even when policy
    would allow it.
  - Refusals are errors, not silence, so a caller cannot mistake "not
    permitted" for "nothing to do".
  - Nothing uses this yet except its own tests. It is built now because a
    permission model added after the thing it governs is a permission model
    with holes in it.

- **Background work is visible and cancellable.** A running search or replace
  shows in the status bar with its progress and what it is currently reading.
  Click it — or run **Cancel Background Task** from the palette — to stop it.
  - **Cancelling a search leaves nothing behind.** The walk stops on the Rust
    side rather than running on with its results discarded, and the panel
    returns to how it looked before the search started, instead of showing
    however far it happened to get.
  - **Cancelling a replace changes nothing at all.** The walk computes what to
    write and writes none of it until it has finished, so there is nothing to
    unwind.
  - **A replace will no longer overwrite something you typed while it ran.**
    Reading a whole project takes long enough to type into a file partway
    through; that is now caught and the replace refuses for that file, rather
    than writing text it computed before the keystroke.

- **A project-wide replace is one undo.** <kbd>⌘Z</kbd> now takes the whole
  replace back across every open file at once, rather than needing one press
  per file, and says what it undid: *Undid Replace "Task" across 2 files*.
  <kbd>⌘⇧Z</kbd> puts it back the same way.
  - A file you have edited since the replace is **left alone** and reported,
    rather than having your work taken back with it.
  - Underneath is a transaction model: every programmatic edit is a *change
    set* with a description and an author, applied to all its buffers or none.
    The whole set is validated before anything is written, so a partly-applied
    change cannot happen — there is no rollback path because there is nothing
    to roll back.
  - Applied change sets are recorded in a transaction log with who made them.

- **Unsaved work survives quitting.** Edits you have not saved — to real files,
  not just scratch buffers — are recorded in the session and restored on next
  launch, still marked unsaved, with <kbd>⌘Z</kbd> reaching the content that is
  on disk.
  - There is deliberately no "save before quitting?" dialog. A dialog can be
    answered wrong; persistence cannot lose work however you dismiss the window.
  - If the file changed while Nox was closed, the tab is flagged as modified
    externally, so saving goes through the existing conflict path instead of
    overwriting whatever arrived.
  - The window now waits for the final session write and settings flush before
    closing. Previously nothing ran on quit at all.

- **Cursor positions are restored.** Every cursor in every tab, not just the
  primary one, clamped to the document in case the file changed while Nox was
  closed. Switching tabs now scrolls the cursor into view rather than jumping
  to the top of the file.

- **Buffer switcher** (<kbd>⌘E</kbd>, or `~` in the palette). Lists what is
  already open, ordered by when you last looked at each file and starting on
  the previous one, so bouncing between two files is two keystrokes. Distinct
  from <kbd>⌘P</kbd>, which searches the whole project.

- **Byte-order marks are preserved.** A file that had one keeps it; a file that
  did not never gains one. The status bar shows `UTF-8` or `UTF-8 BOM`.

- **Code folding.** Fold arrows in the gutter, driven by the language grammar.
  - <kbd>⌘⌥[</kbd> / <kbd>⌘⌥]</kbd> fold and unfold at the cursor;
    <kbd>⌘⌥⇧[</kbd> / <kbd>⌘⌥⇧]</kbd> fold and unfold everything.
  - **Fold Level 1–5** collapses one nesting depth at a time, turning a file
    into an outline.
  - Folds live in the buffer, so they survive switching tabs.
  - Arrows stay hidden until you hover the gutter; a *closed* fold always shows,
    because it marks content you cannot see. Turn the whole thing off with
    `editor.codeFolding`.

- **Split editor panes** (<kbd>⌘\\</kbd>). The editor area now holds several
  panes, each with its own tabs, active file, scroll position and undo history.
  - Side by side or stacked, toggled from the palette or Settings, with
    draggable dividers that keep their proportions when the window resizes.
  - <kbd>⌘⌥←</kbd>/<kbd>⌘⌥→</kbd> move focus between panes,
    <kbd>⌘⌥⇧←</kbd>/<kbd>⌘⌥⇧→</kbd> send the current file to the next one,
    and <kbd>⌘⇧\\</kbd> closes a pane — folding its tabs into the neighbour
    rather than closing them.
  - Tabs drag between panes. A pane emptied by a drag or a close folds away;
    the focused pane is marked so it is never ambiguous where typing will go.
  - Sessions remember the full layout. Version 1 sessions are migrated rather
    than discarded.

- **Replace across files.** The search panel gains a replacement field, a live
  diff preview on every match row, per-file replace, and Replace All.
  - **Nothing is written blind.** Replace All states the scale
    ("Replace 13 occurrences?" across N files) before touching anything.
  - **Open files change through the editor**, so ⌘Z undoes a project replace
    like any other edit, and a file with unsaved work never gets written
    underneath it — the replacement is computed against the buffer instead.
  - **A one-shot undo** restores every file the replace changed. A file edited
    since is left alone and reported, rather than being clobbered.
  - Regex capture groups (`$1`, `$&`, `$<name>`) expand in the replacement;
    a literal search treats `$` verbatim.

- **Project-wide search** (<kbd>⇧⌘F</kbd>). A parallel, gitignore-aware walk in
  Rust, streaming results into a sidebar panel as they are found.
  - Match case, whole word and regular expressions; include/exclude globs
    (`*.ts`, `src/**`) and a toggle for respecting `.gitignore`.
  - Results group by file with line previews and highlighted matches. Clicking
    or pressing <kbd>↵</kbd> opens the file with the cursor **on the match**,
    not merely on the line.
  - Fully keyboard-driven: arrows walk files and matches alike, <kbd>←</kbd>/
    <kbd>→</kbd> collapse and expand groups, <kbd>Esc</kbd> steps back to the
    query field.
  - The sidebar now hosts two views — Explorer and Search — switched by a rail,
    <kbd>⇧⌘E</kbd>, or <kbd>⇧⌘F</kbd>.
  - Search works in the browser target too: the in-memory platform implements
    it for real rather than stubbing it.

- **Drag and drop.**
  - **Within the explorer**, drag entries onto a folder to move them. Dropping
    onto a file targets its containing folder; dropping below the tree targets
    the workspace root. Multi-select drags the whole selection.
  - Moving **carries open tabs with it**, including every buffer beneath a
    moved folder, and leaves the moved entries selected.
  - Illegal drops are refused before they happen: a folder cannot be dropped
    into itself or its own subtree, and an existing file at the destination is
    never overwritten.
  - **From the OS**, drop files onto the window to open them as tabs, or a
    single folder to open it as the workspace. A full-window affordance appears
    while files hover.

- **Multi-select in the explorer.** Cmd/Ctrl-click toggles, Shift-click selects
  a range, Cmd+Shift-click adds a range, <kbd>⌘A</kbd> selects everything
  visible, <kbd>Space</kbd> toggles the focused row, and Shift+Arrow extends
  from a fixed anchor — so the range shrinks as well as grows.
  - Delete, Duplicate, Open and both Copy Path commands act on the whole
    selection; the menu labels count what they will affect
    ("Delete 4 Items…"), and the confirmation names the files rather than
    showing a bare number.
  - Nested selections reduce to their top-level ancestor before deleting, so
    picking a folder *and* a file inside it does not fail halfway through.
  - Collapsing a folder drops the selection inside it — Delete never acts on
    rows you cannot see.
  - Right-clicking inside the selection keeps it; right-clicking outside
    replaces it, matching every file manager.
  - <kbd>Esc</kbd> narrows before it leaves: it collapses a multi-selection
    first, and returns focus to the editor on a second press.

- **Explorer context menu.** Right-click any file or folder — or press the
  Menu key / <kbd>⇧F10</kbd> — for New File, New Folder, Rename, Duplicate,
  Delete, Copy Path, Copy Relative Path and Reveal in File Manager.
  - **Deleting moves to the OS trash**, not `unlink`. The confirmation says
    "Move to Trash" where that is true and "deleted permanently" where it is
    not, driven by a platform capability rather than a guess.
  - **Renaming carries open buffers with it** — including every buffer beneath
    a renamed directory — updating path, tab label, and syntax highlighting
    when the extension changes.
  - Deleting closes clean buffers and *keeps* dirty ones, marked, so unsaved
    work is never lost to a menu click.
  - <kbd>F2</kbd> renames and <kbd>⌫</kbd> deletes while the explorer has
    focus. The menu itself is fully keyboard-operable: arrows, Home/End,
    type-ahead, Enter, Escape, and focus returns to the tree on close.
- Every explorer operation is also a command, so all of it works from the
  palette without touching the mouse.

- **File watching.** Nox now notices changes made outside the editor.
  - A **clean** buffer reloads silently — the file on disk is the truth.
  - A **dirty** buffer is never overwritten. It is marked in the tab and status
    bar, you are told once, and the conflict is resolved when you save with an
    explicit Overwrite / Discard & Reload / Cancel choice.
  - A **deleted** file keeps its tab, struck through; the content is still in
    memory and saving recreates the file.
  - The explorer and quick-open index follow files created, deleted and renamed
    by other programs.
- `File: Reload File from Disk` (formerly `Revert File`), which now confirms
  before discarding unsaved changes.
- `MemoryPlatform.externalWrite` / `externalRemove` / `externalRename`, which
  simulate another program writing to the same disk — real events, real mtimes.

### Changed

- Reloading a file is applied as a transaction rather than a state reset, so
  scroll position, selection and undo history survive it. A surprise reload is
  recoverable with ⌘Z.
- `Platform` gained `watch()` and a `fileWatching` capability; `MemoryPlatform`
  now keeps per-file modification times.

### Fixed

- **In a split, only one pane received programmatic edits.** Every pane
  overwrote a single app-wide dispatcher slot on mount, so a project replace
  aimed at a file open in the other pane changed the buffer but left that
  pane's view showing the old text. Panes now each register their own.

- **A programmatic edit with a bad offset could half-apply.** A change set
  spanning two files where the second had an out-of-range range wrote the
  first, then threw — leaving the files inconsistent and nothing in the log to
  undo it with. Every file's change is now built before any is written, so the
  set applies completely or not at all. Overlapping edits within one file are
  refused too, rather than being merged into text nobody asked for.

- **A review could not be put down.** The diff panel covers the editor, and
  Apply and Discard were the only ways out — so there was no way to look at the
  file you were reviewing. Escape now closes it, going to any file closes it,
  and the status bar shows what is waiting.

- **The sidebar could not show a third view.** Anything that was not Search
  fell through to focusing the explorer, which switched the view straight back.

- **Session restore focused the wrong tab.** It applied the active tab for each
  group, then chose the focused tab from a snapshot taken *before* that — so
  focus always landed on whichever file was opened last rather than the one you
  left active. The existing test could not catch it: its fixture made the
  intended tab and the last-opened tab the same file.

- Saving no longer risks silently destroying another program's changes to the
  same file.
- **Prompt dialogs could not be confirmed with <kbd>Enter</kbd>.** Rename, New
  File and Save As all required a mouse click — a serious flaw in an editor
  that claims to be keyboard-first. Enter is now handled explicitly rather than
  relying on the browser's implicit form submission.
- A destructive confirmation button no longer renders in the safe accent
  colour; Delete is red.
- Deleting on macOS no longer routes through Finder over AppleScript, which
  blocked for two minutes and then failed when Finder was busy or unavailable.
  Nox uses `NSFileManager` directly: the same operation now completes in
  milliseconds. Guarded by an integration test that fails if it ever takes
  longer than five seconds.

## [0.1.0] — 2026-08-12

First milestone. Nox is a usable editor.

### Added

**Architecture**
- Tauri 2 desktop shell (Rust) with a Svelte 5 + CodeMirror 6 renderer
- `Platform` boundary with three implementations: Tauri (disk), memory
  (tests), web (browser dev with an in-memory demo workspace)
- Command registry — every user action is a command, so the palette and the
  shortcut reference are generated rather than maintained
- Two-layer keymap: application chords resolved on capture, editing chords
  owned by CodeMirror
- Schema-driven configuration; `Settings` type, validator and Settings UI all
  derived from one object

**Editor**
- Syntax highlighting for TypeScript, JavaScript, JSX/TSX, JSON, HTML,
  CSS/SCSS, Markdown, Python and Rust — grammars loaded on demand
- Multiple cursors: add above/below, add-to-next-match, Alt+click,
  select-all-occurrences
- Undo/redo per buffer, bracket matching, auto-close brackets, auto-indent,
  configurable tabs/spaces, word wrap, whitespace rendering
- Line numbers with an optional relative mode
- Configurable cursor style (line, block, underline) and blink

**Files**
- Open, save, save as, new, close, revert; folder opening; recent files
- File explorer with lazy loading, keyboard navigation and auto-reveal
- Tabs with dirty indicators, middle-click close and drag reordering
- CRLF detection preserved on save; optional trailing-whitespace trim and
  final-newline insertion
- Binary and oversized files refused with a clear message rather than a hang
- Session restore for the open folder, tabs and unsaved scratch buffers

**Interaction**
- Command palette, quick open and go-to-line in one prefix-switched surface
  (`>` for commands, `:` for lines)
- Optimal fuzzy ranking with filename weighting and match highlighting
- Find and replace with regex, case sensitivity, whole-word and
  select-all-matches; live match counting
- Settings panel generated from the schema, with per-setting reset
- Keyboard shortcut reference covering both keymap layers

**Design**
- Eclipse theme (blue-black night) and Umbra (OLED true-black)
- Complete design token layer; no component hardcodes a visual value
- Crescent identity mark, rendered to app icons by a dependency-free generator

**Quality**
- 132 unit tests across path handling, fuzzy ranking, workspace, config,
  commands, keymap, file tree and session
- Clean `svelte-check`: zero errors, zero warnings

### Known limitations

Recorded in [ARCHITECTURE.md](ARCHITECTURE.md) §7. The notable ones: no file
watching, so external edits go undetected; the dirty flag is approximate above
2 MB; keybindings are read-only; and the explorer has no context menu.

[0.1.0]: https://github.com/

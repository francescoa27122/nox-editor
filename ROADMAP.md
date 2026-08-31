# Nox Roadmap

Ordered by what makes Nox a better editor, not by what is easiest to build.
Anything not listed is not planned.

**The `v0.x` headings below are milestones, not releases**, and the two have
never lined up. A milestone is a theme. A release is whatever was finished when
a tag was cut. The v0.2 milestone's local model went out in release 0.3.0, and
three of the v0.3 milestone's four features went out in release 0.4.0. Each
shipped table says which release its rows landed in.
[CHANGELOG.md](CHANGELOG.md) is the authority on that, and this file is the
record of *why* something was built.

---

## ✅ v0.1 Foundation *(released as 0.1.0)*

The MVP: a real editor you can work in.

- Tauri + Svelte + CodeMirror architecture, `Platform` boundary, command registry
- Eclipse and Umbra themes; complete design token layer
- Explorer, tabs, editor, status bar, title bar with breadcrumb
- Open / save / save as / new / close / revert; folder opening; recent files
- Syntax highlighting for 9 language families, lazily loaded
- Find and replace with regex, case, whole-word, select-all-matches
- Command palette, quick open, go-to-line (one component, prefix-switched)
- Multiple cursors, bracket matching, auto-indent, word wrap
- Settings UI generated from schema; session restore including scratch buffers
- File watching: clean buffers reload silently, dirty buffers are protected and
  resolved at save time, deletions are marked, the tree stays in sync
- Explorer context menu: create, rename, duplicate, delete-to-trash, copy path,
  reveal. Keyboard-operable, and renames carry open buffers with them
- 179 unit tests over the pure and service layers, plus 4 Rust tests

---

## v0.2 Trust

*Things that make you willing to keep the editor open all day.*

| | Why |
|---|---|
| **Drag files out of Nox** | Dragging a tree entry into another app. Requires a native drag source on the Rust side. |
| **Rename several files at once** | Multi-select exists. Renaming many needs a find/replace-style pattern UI, not a single prompt. |
| **Untitled buffer language picker** ✅ | **Change Language Mode** (`lang.setLanguage`), from the status bar, the Code menu or the palette. Wider than this row asked for: the language was inferred from the file name at open and *nothing* could disagree with it, so an unusual extension stayed unhighlighted for good, not just an untitled buffer. The status bar item was the one inert thing in a row of live ones, a control labelled with a language that refused to change it. It falls back to the picker rather than replacing the `lsp.configure` click argued for in `lsp-status.ts`: changing the language is the obvious meaning but the less urgent one, so it takes the states the other does not claim. |
| **Explorer virtualisation** ✅ *(released in 0.5.0)* | The flat-node model anticipated it since v0.1 and the model did not change: the panel renders a window of rows plus two spacers, so the scrollbar still describes the whole tree. Below ~200 rows nothing is windowed, which keeps small folders exactly as they were. Scrolling to the lead row became arithmetic on its index rather than `scrollIntoView` on an element that may no longer exist. Strictly better, since it never needed the row to be drawn. `aria-setsize`/`aria-posinset` arrived with it, not after: rows leaving the DOM makes them mandatory. |

### ✅ Shipped *(M1 to M7 of [AGENT-PLATFORM.md](AGENT-PLATFORM.md), released in 0.2.0, except the local model in 0.3.0)*

| | |
|---|---|
| **A project replace undoes in one step** | ⌘Z takes the whole replace back across every open file, and names what it undid. A file edited since is left alone and reported. |
| **Transactions with an author** | Programmatic edits are change sets: validated whole, applied to all their buffers or none, recorded in a log with who made them. The groundwork the agent runtime needs, useful now because it fixes undo. |
| **Cancellable background work** | Search and replace run as jobs with progress in the status bar. Cancelling a search stops the walk and clears the panel. Cancelling a replace changes nothing, because a job computes and the main path applies. |
| **A permission model** | Commands declare what they need. Programmatic callers are checked against a policy, with per-file grants and a decision log. You are never prompted. Nothing uses it yet but its tests, which is why it is right. |
| **A context API** | Structured, serialisable read access to buffers, selections, viewports, the project tree and recent changes. Nothing live escapes it, and every read by a non-human is recorded. |
| **Crash-safe writes** | Saves go to a temp file and are renamed into place, so a failure mid-save cannot truncate your work. Permissions preserved, symlinks followed. |
| **Out-of-process agents** | An agent is any program that speaks one JSON object per line on stdin and stdout. Nox supervises it. A reference agent ships in `examples/agents/`. |
| **Staged changes and hunk review** | A proposal is shown as a diff and accepted or rejected hunk by hunk before anything is written. What you keep lands as one undoable change. The diff engine is the one v0.5's Git view needs. |
| **The agent runtime** | Protocol, provider interface, session audit trail, one-button session undo. Agents act only through commands under the permission model. The interface is vendor-neutral, and the first provider plugs into it without the runtime learning a vendor's name. |
| **A local model** | Point `agents.json` at an Ollama server and an agent can read your workspace and stage a change set. Entirely on your machine: the HTTP client is loopback-only, enforced in Rust. Edits are quoted rather than positional, because the model can pick the right text and cannot count characters. Read and propose only, no commands. |
| **Nothing unsaved is lost on quit** | Unsaved edits to a file are recorded in the session and restored dirty, with ⌘Z reaching the on-disk content. No quit dialog: it can be answered wrong, and persisting cannot be. |
| **A real quit hook** | The window now waits for the final session write and settings flush. `dispose()` was previously never called by anything. |
| **Cursor positions survive a restart** | Every selection range per tab, clamped to the document on restore and scrolled into view. |
| **Buffer switcher** | ⌘E, or `~` in the palette. Ordered by when you last looked at a file, opening on the previous one. |
| **Byte-order marks are preserved** | A file that had a BOM keeps it. One that did not never gains one. Shown in the status bar. |

---

## v0.3 Navigation at scale

*Working in a project, not a folder.*

| | Why |
|---|---|
| **Replace individual matches** ✅ | Each match row carries its own dismiss and its own replace, and both are commands so the results list is operable from the keyboard rather than only the mouse. An exclusion is stored as an *identity*: path, line, absolute column, never an index, because the replace path recomputes from the file's current text rather than trusting the result rows. A match that is no longer where it was gets its file refused rather than guessed at. `computeReplacements` had accepted a `skip` set since it was written and nothing had ever passed one. |
| **The same file in two panes** ✅ *(released in 0.8.0)* | **Open Copy to the Side**: a second view over one document, with transactions forwarded between the panes. 0.8.1 brought a mirrored pane back across a restart and 0.8.2 gave each pane its own cursor. That forwarding is also what turned the workspace's own broadcast into a *second* delivery. See ARCHITECTURE §6. |
| **Nested splits** | A column inside a row. The layout is a flat list today. |
| **Terminal** *(shipped early, in 0.3.0)* | A real pty, not piped stdio, so `vim`, colour and job control work. Previously ruled out as its own project. It turned out to share process supervision with the agent transport, which is what made it affordable. |

### ✅ Shipped *(Go to symbol released in 0.3.0, the other three in 0.4.0)*

| | |
|---|---|
| **Go to symbol** | ⌘R, or `@` in the palette, lists the functions, classes, methods, rule sets and headings in the file you are on. A method reads as `Class.method`, so either half finds it. It reads the parse folding already keeps, so it is a reader rather than a second source, and a language with no parser says so instead of coming back empty. |
| **Sticky scroll** | Keeps the enclosing declaration pinned above the editor once its header scrolls out of view. Click a pinned row to jump to it. Reads the same rule table Go to symbol does, so it pins declarations only, never `if`/`for` blocks. A panel, not an overlay, so it costs a row of height instead of covering the last line. |
| **Preserve case on replace** | The `AB` toggle in both replace panels. One replacement string comes back shaped to each match, so a case-insensitive search for `scheduler` writes `dispatcher`, `Dispatcher` and `DISPATCHER` where it found the three spellings. Three shapes only: a match that is none of them is written verbatim rather than guessed at. Off by default, and independent of Match case. |
| **Breadcrumb navigation** | The trail in the title bar is clickable. A folder segment opens the explorer and expands it, the file at the end reveals the file. Segments of a file outside the workspace stay inert, because there is nothing to reveal into. |

---

## v0.4 Language intelligence

*The point at which Nox competes on capability rather than feel.*

| | Why |
|---|---|
| **LSP client** ✅ | Process supervision in Rust, JSON-RPC over stdio, a CodeMirror bridge in `editor/`. Unlocks everything below. The framing lives in Rust because `Content-Length` counts bytes and a renderer string counts UTF-16 code units. Everything above it is TypeScript over an injected process, and therefore testable without a server. Servers come from `servers.json`: Nox never discovers or spawns one on its own. |
| **Diagnostics** ✅ | Inline squiggles, gutter marks, and a Problems panel listing every file a server has reported on, including files you never opened, which is where a project's real errors hide. Ranges are clamped to the document, because `publishDiagnostics` carries an optional version and an out-of-range range is a crash rather than a cosmetic error. |
| **Completion** ✅ | Suggestions from the language server, on the server's own trigger characters rather than an assumed `.`. A `textEdit` is honoured over a guessed range, documentation is fetched per highlighted item because tsserver sends none in the list, and an `isIncomplete` list is never cached. Snippets were **not** supported until 2026-08-26: placeholders were stripped to their default text so `${1:arg}` could not land in the buffer. They now expand. See the v0.6 row. |
| **Hover** ✅ | Resting the pointer on a symbol shows its type and documentation, and the tooltip stays while the pointer is anywhere over the span the server names, not only the character it started on. The server's markdown is rendered as **text, never HTML**. A language server is a third-party process and its hover strings come from cloned source, so parsing them into a live DOM would buy typography with an injection surface. Inline `**bold**` therefore shows as written. |
| **Go to definition** ✅ | `F12`. The same door as hover: `LspService.requestFor` for the question, `workspace.open` and `workspace.setSelection` for the answer, which lands whether or not the pane has swapped to the file yet. Several results take the first and list the rest in the References view. |
| **Find references** ✅ | `Shift+F12`. A **References** view in the sidebar: one row per file, one per use with the line it is on, click or Enter to land through the same `revealLocation` go to definition uses. The declaration is included, so the list is complete without a second command. The cursor does not move when the list opens. Twenty places is a choice, and choosing for the user is what "went to the first" was apologising for. The same view lists a definition with several homes. |
| **Rename symbol** ✅ | `F2`. The server's `WorkspaceEdit` is staged as **one change set in the review panel**: every file it touches is opened, every hunk is shown, and nothing is written until you apply. Then it is one transaction, so one ⌘Z takes the whole rename back across every file, and a file you edited during review is refused rather than overwritten. `prepareRename` first where the server offers it, so a keyword gets "nothing to rename here" instead of a prompt that can only fail. Applied buffers are left unsaved, as every reviewed change is. Save All is one command away. A rename that needs a file moved or created is refused whole. |
| **Formatting on save** ✅ *(LSP half)* | **Format Document** (`Shift+Alt+F`) applies the server's `textDocument/formatting` as one undoable change, not through review, because a format is not a proposal. **Format on Save** (`files.formatOnSave`, off by default) runs the same request just before the write, bounded at two seconds: the save always happens, a slow server costs a warning and not a save, a late answer is dropped, a keystroke during the request wins. Skipped under after-delay autosave. The *external command* half, a formatter binary for languages whose server does not format, is its own row, because it wants a process seam and a per-language table and neither belongs inside a save path. |
| **Code actions** ✅ | `⌘.` asks the server what it can do at the caret and lists the answers. **Where one lands is the decision**, and it is not the server's `kind`, because servers disagree about those. It is how far the change reaches: one file is applied directly, because a fix you asked for at your own caret is not a proposal, and more than one is staged in the review panel, which is the shape rename already produces. An action that is a server *command* rather than an edit is listed and disabled with the reason rather than hidden, because a picker that hid it would blame the server for something Nox has not built. |
| **Tree-sitter evaluation** | Compare against Lezer for grammar breadth. Lezer is excellent but has a smaller catalogue, and 2026-08-26 put a number on that: eight of the eleven languages added that day had a Lezer grammar and **shell, TOML and Ruby did not**, so they took stream parsers, which colour without building a tree and therefore have no Go to Symbol, sticky scroll or folding. That is the catalogue gap, in the three places a user meets it. |

---

## v0.5 Version control

*Every row below released in 0.5.0 except Blame, which followed in 0.12.0.*

| | Why |
|---|---|
| **Git gutter** ✅ | Added / modified / removed per line, against the **index**, because the gutter's question is "what have I changed that git doesn't hold yet". Marks map through keystrokes between 300 ms recomputes. The base refetches on save, on external change, on activation and on an explicit palette refresh, because the watcher deliberately ignores `.git` and a commit emits no event. Degrades to absence: no repo, untracked, binary, no git, no marks, never an error. The first one-shot process capture in the Rust layer (`git.rs`). Real `.git` watching arrives with stage/commit, which needs it anyway. |
| **Diff view** ✅ | **Show Changes**: side-by-side and inline over one paired-row model from the line diff that already existed, so the second layout is a regrouping rather than a second differ. Opened from the palette or a click on a git-gutter mark. Follows the active buffer, a lens, unlike review and agents which close on tab switch. Deliberate, and documented. Context folds with click-to-expand. Read-only on purpose: reverting a hunk is stage/commit's, with its confirmation shape. |
| **Stage, commit, branch** ✅ | A focused panel, not a full Git client. Stage and unstage whole files, write a commit message, switch or create a branch, the last two from the palette as a picker with no prefix of its own. Six argv-fixed git commands, never a shell, and a refusal comes back in git's own words. Unstage runs `git reset --`, not the more obvious `restore --staged`, because the latter fails on a repo with no commits yet. `.git`'s `HEAD` and index are now watched directly, closing the blind spot the gutter documented: a commit or stage made in a terminal reaches the panel without being asked. Hunk-level staging is its own later step, deliberately. It is the one place this feature would build git's input rather than name files. |
| **Blame** ✅ *(released in 0.12.0)* | **On demand, not always on**, and structurally so: nothing in `GitService` starts a `git blame` except the toggle, so opening, editing, saving and committing a file the user never asked about cost none. Per buffer rather than global, for the same reason. `Mod+Alt+B` puts a column beside the code with the short hash and author of each line, the full identity, author-local date and subject on hover, and a dimmed **Uncommitted** for a line no commit holds. The decision that makes it correct is `--contents`: git is handed the *buffer's* text, not the file's, so an unsaved insertion shifts the annotations below it instead of misattributing them, and "not committed yet" becomes a fact git computed rather than one Nox inferred. Marks are one point per line, never one range per commit-run, because a range grows when text is inserted inside it and would lend a newly typed line someone else's name. Between fetches they map through edits rather than recompute, since recomputing means spawning a process. The column goes **leftmost**, outside the line numbers, so switching blame on adds a column instead of pushing the git gutter's change bars away from the lines they mark. That and its width were settled by screenshotting it in a real browser rather than by reasoning, and both are recorded in the spec. It is the crate's only `#[tauri::command(async)]`, because blame is its first git read whose cost follows a file's history rather than one blob, and a sync command body runs on the thread that draws the window. See `docs/superpowers/specs/2026-08-29-git-blame-design.md`. |

---

## v0.6 Extensibility

*The keybinding editor and workspace settings released in 0.5.0. Both were 1.0 gates, which is why they came before the rest of this table.*

| | Why |
|---|---|
| **Keybinding editor** ✅ | Bindings were already data. This is the UI. Every command gets a row, bound or not, because adding a key to a command that has none is half of what "change the keys" means. Recording is a mode of the keymap service rather than a listener in the panel, since the service resolves on the window's capture phase and would otherwise handle the chord first. A customisation is a **rule layered over** the defaults in `keybindings.json`, never an edit to them, so reset is a deletion rather than a remembered original. A chord already in use names the command it would displace *before* you accept, and accepting unassigns it rather than silently shadowing it. CodeMirror's own keys stay read-only, and say so. |
| **Custom themes from JSON** ✅ *(released in 0.11.0)* | A `.json` in the `themes` folder gets a theme into Settings, and **Edit Themes** creates the folder with a worked example. A file names a `base`, `eclipse` or `umbra`, and overrides tokens on top of it, which is what lets a real theme be three lines: `data-nox-theme` carries the base so the cascade fills in the rest. **The threat model is the design.** Nobody writes a theme from nothing, they download one, so the file is read as strictly as `plugin.json`. It names *tokens* and Nox writes the `--nox-` prefix, so no theme can reach a property Nox did not choose. Values must be hex or `rgb()`. They are applied with `setProperty` rather than by building a CSS rule out of a stranger's JSON. The 60 settable tokens are the colours only: geometry, stacking, typography and `--nox-dur-*` are excluded, the last because the stylesheet zeroes it under `prefers-reduced-motion` and a theme must not undo that. `workbench.theme` stopped being an enum in the process. It was `'eclipse' | 'umbra'`, and `coerce` would have reset a custom id to the default on every load. |
| **Snippets** ✅ | Two halves, and the hard part is shared. **Your own**, from `snippets.json`: keyed by language with a `*` bucket under it, offered in the same picker as everything else, `Tab` and `Shift+Tab` between the fields. **The server's**: `snippetSupport` is now claimed in the handshake, so tsserver and rust-analyzer send `console.log($1)` rather than flat text, and it expands. The two dialects differ in one place that matters. **CodeMirror reads braced fields only**, so a bare `$0` was literal text in the buffer, and `toCodeMirrorTemplate` is the translation. Choice syntax degrades to its first option, because there is no picker to offer the rest. Variables are left exactly as written rather than resolved or deleted. |
| **Plugin API** ✅ *(released in 0.11.0)* | **Shipped: all four surfaces the row named.** A folder in `<config>/plugins/` with a `plugin.json` gets its commands into the palette, the menus and the keybinding editor, running under the permission model against a `{ kind: 'plugin' }` principal. Two transports, one interface: a `.js` file in a worker, or any language as a child process over stdio. **Status items** are runtime rather than declared, because an item's content is only known to running code, which is why the manifest gained `"activation": "startup"`. **Panels** go the other way: the rail button is declared, so it exists before the plugin does and opening it is what starts one, which is how a plugin with a panel keeps the lazy activation a plugin with only commands has. Their contents are rows, never markup. **Editor decorations** complete the row: a plugin names ranges and a `kind` from a closed vocabulary, Nox draws them, and the marks are mapped forward through edits so they follow the text between passes. Measured at **0.82x for 8x the document** with the full 2,000-mark cap, so the cost is the mapping and it scales with the marks rather than the file. That forced the one event a plugin gets, `document.changed`: debounced, coarse, and only for buffers the plugin already decorated. **The design gate is met structurally rather than promised.** Out of process, there is no seam through which a plugin could run per keystroke. The cost is that a plugin cannot hand Nox a CodeMirror object, so **editor extensions become a declarative surface**: the plugin names ranges, Nox draws them. **Settings followed on 2026-08-28**, which the four-surface pass had deliberately left out. A plugin declares its options in `plugin.json`, they appear in Settings under the plugin's own name, and the values live in `plugin-settings.json` because `SETTINGS_SCHEMA` is closed at compile time and admitting a runtime key would untype every core setting. Nothing a plugin declares is ever workspace-scoped, because a cloned repository must not be able to set a key whose meaning Nox does not know, and that is the one thing the row refuses. See `docs/superpowers/specs/2026-08-27-plugin-api-design.md` and `…2026-08-28-plugin-settings-design.md`. |
| **Workspace settings** ✅ | `.nox/settings.json` layered over user settings. Three layers: defaults under yours under the project's. The scope is an **allowlist on the schema**, eight keys wide, because that file arrives with a cloned repository. Only facts about the code can come from it (indentation, trimming, format on save, what to hide), never a font, a theme or `terminal.shell`. Read-only from the Settings panel on purpose: an overridden row wears a badge and switches its control off, and the footer points at the file, because a second write path is a way to commit a personal preference into a shared repository by accident. Watched, so an edit applies without a reload. |
| **Tasks** ✅ | **argv, never a shell**, which is the decision the rest follows from. A task is a `command` and an `args` array, nothing is handed to `sh -c`, and there is no `cwd` field because a task that could name a directory could name `/`. That is what makes the confirmation below *true*: with a shell string the dialog would be showing text that the shell then reinterprets, and quoting, expansion and substitution all get a say after you have clicked. It costs real expressiveness (`npm test && npm run lint` is two tasks, and a pipeline is the terminal's job) and the trade is deliberate. **Two files, and the difference between them is the feature.** `<config>/tasks.json` is yours and runs on sight, the standing `servers.json` and `agents.json` already have. `<root>/.nox/tasks.json` **arrives with a cloned repository**, which is the exact thing `.nox/settings.json`'s eight-key allowlist exists to refuse (`terminal.shell` is the reason that list exists), so it does not run until Nox has shown you the argv and you have said yes. **The approval is keyed on the argv, not on the task's name**: keying it on the name would let a repository earn a yes for `test` meaning `npm test` and then inherit it for something else behind a pull or a branch switch nobody was watching. Trust is session-scoped, listed in the panel and dropped by **Forget Approved Tasks**, because a grant you cannot see is a grant you cannot withdraw. The gate is the service's rather than `PermissionService`'s, deliberately: that model exempts the user principal on purpose, and the question here is not what an agent may make Nox do but whether the thing about to run is the user's at all. A run is a `Job`, so cancellation kills the process even mid-spawn and asking for a task again supersedes the run already going, both from `jobs.ts` rather than written again. Output is one list in arrival order with stdout and stderr tagged, capped at 5,000 lines dropping the oldest, and coalesced at 50 ms so a loud build cannot repaint per line. No autodetection of `package.json` scripts or `Makefile` targets: every one of those is a program named by the repository, which is this row's problem wearing a friendlier face. See `docs/superpowers/specs/2026-08-30-tasks-design.md`. |

---

## v0.7 Modal editing

| | Why |
|---|---|
| **Vim mode** | Optional, off by default. The two-keymap split in `services/keymap.ts` vs CodeMirror was designed with this in mind: a mode is a third keymap layer, not a rewrite. |
| **Emacs bindings** | Same mechanism. |

---

## Later: AI

Deliberately not in the MVP and deliberately not the product's purpose. The
architecture supports it when the time comes: `Platform` isolates network
access, commands expose actions uniformly, and the workspace can already
enumerate buffers and project files.

- Explain selection *(shipped early, in 0.3.0)*. Both halves are built. **Edit
  Selection with a Model…** returns a diff through the review panel, and
  **Explain Selection** and **Ask About Selection…** return prose to an
  **Answers** sidebar section. That section is the result surface this line
  was waiting on. Neither command remembers a previous question. A thread is
  the chat item below, not this one.
- Workspace-aware chat with an explicit, visible context set
- Remote model support alongside the local one
- Agentic edits, gated behind a diff review, never applied blind

**Principle:** AI is a panel and a set of commands, not a rewrite of the
editor. If a feature would make Nox worse for someone who never turns AI on, it
does not ship.

The groundwork this needs (authored transactions, a permission model, a
context API, staged change sets, a job runner) is specified in
[AGENT-PLATFORM.md](AGENT-PLATFORM.md), along with a milestone plan. Each of
those milestones is an editor improvement in its own right, which is the only
reason to build them before the agent exists.

---

## 1.0: what the number means

*Proposed 2026-08-19, after 0.4.2. Edit the bar. Don't let it drift silently.*

1.0 is not a milestone with features in it. It is the point at which Nox can
be recommended to someone who did not build it, without an apology attached.
That is a claim about trust and finish, so the bar is written in those terms:

| Bar | Where it stands | What it takes |
|---|---|---|
| **Installs like software.** A download opens without a terminal command or a SmartScreen click-through, and the app tells you when a newer one exists. | The updater is built and waits on the operator's key ceremony. Once a signed release is published, updating never repeats the ritual. First installs still need `xattr -dr` on macOS and "Run anyway" on Windows, and that half is the certificates'. | **Apple only, decided 2026-08-22.** The workflow half is built and merged: the six secrets are wired and a guard refuses a half-present configuration, because signing without notarizing still stops at Gatekeeper while the release notes would say otherwise. What is left is the enrolment and the keychain, both operator's hands. See `docs/superpowers/specs/2026-08-22-apple-signing-design.md`. **Windows is deferred**, and not only on price. An OV certificate would not silence SmartScreen immediately, since reputation accrues with downloads, so only an EV one buys anything on day one, and since 2023 the key must sit on hardware, which means a cloud signing service rather than a secret. macOS is the worse failure anyway: *"damaged"* reads as a broken download and the fix is a terminal command, while Windows offers a click-through. |
| **Language intelligence is complete.** Diagnostics, completion, hover and go to definition ship today. An editor that can jump to a definition but not list its uses, or rename it, has stopped halfway. | ✅ **Nine of the ten v0.4 rows are ✅**, which is every one of them except the Tree-sitter evaluation. The three this column named as outstanding all landed: find references and rename symbol on 2026-08-19, formatting on save the same week, and code actions followed on 2026-08-22 without being asked for. This row read "four of the v0.4 rows" until 2026-08-30, which is the drift the heading above warns about. | Nothing. Tree-sitter is an evaluation, not a 1.0 gate, and the row that records it says what the catalogue gap costs: shell, TOML and Ruby colour without a parse tree, so Go to Symbol, sticky scroll and folding stay empty in them. |
| **Version control is present.** Not a Git client. The gutter, a diff, stage-and-commit. The README has said "no Git integration" since 0.2.0. | ✅ The whole v0.5 table, blame included (0.12.0). | Nothing. |
| **A keyboard-first editor lets you change the keys.** ✅ | Both rows landed 2026-08-20: the keybinding editor (rebind, unassign, reset, `keybindings.json`) and workspace settings (`.nox/settings.json`, an eight-key allowlist). | Nothing. Plugins are explicitly *not* a 1.0 gate. A plugin API is a compatibility promise, and 1.0 should not make one it has not lived with. |
| **It holds up at scale.** ✅ | Search and replace are jobs. The explorer renders a window (2026-08-20). | Nothing. |
| **Nothing in the release notes says "unverified".** | Closing steadily, and two of the four named items are now checks rather than intentions. 2026-08-20 drove the keybinding editor, `inert`, the row-height contract and explorer windowing over 609 nodes in Chromium. 2026-08-29 added three walks of the packaged Windows build, including its pixels, plus a browser project that measures real layout. **2026-08-30 put the terminal under WebDriver** (`e2e/specs/terminal.e2e.js`): a real pty, a real bash, a command typed and its output read back, on all three platforms in CI. The **in-window menu bar** has had `e2e/specs/menu-bar.e2e.js` since it shipped. | Two items, and both genuinely need hands: **native dialogs** and the **native macOS menu**, neither of which is inside the WebView for WebDriver to reach. The **git panel against a real repo** is reachable and unbuilt: it needs a repository on disk and a seeded `session.json`, which is the next e2e spec rather than a walk item. One new question for the walk, from building the terminal spec: **type in the terminal and check each character appears once.** Under WebDriver every character reaches xterm twice, and the evidence says that is the driver ignoring `preventDefault` rather than Nox, but a synthetic-input harness is the wrong instrument to close that question. See the spec's own header. |

Everything in the v0.2 to v0.7 tables that is not named above is 1.x. In
particular, out of 1.0 on purpose: the plugin API, Vim and Emacs modes,
Tree-sitter, dragging files out, renaming several files at once, nested
splits. Each is a good idea. None is what keeps someone from recommending the
editor. (*The same file in two panes* was on this list and then shipped anyway,
in 0.8.0. "Out of 1.0" has never meant "not before it".)

Order of work, by what each thing unblocks rather than by size: find
references, rename, format on save, Git gutter and diff, stage/commit,
keybinding editor, workspace settings, explorer virtualisation, the keyboard
pass, tag. **Every code row is done (2026-08-20).** What is left of 1.0 is the
real-keyboard pass and the certificates: a ritual and a purchase. Signing and
the updater run alongside, because one half of them is a purchase and the
other half is a workflow change that nothing else waits on.

---

## Not planned

- A light theme. Nox is a dark editor. That is the product.
- Real-time collaboration before v1. Interesting, enormous, and it would
  distort the document model to chase it early.
- Web/hosted Nox as a product. The browser target exists to make UI
  development fast, not to ship.

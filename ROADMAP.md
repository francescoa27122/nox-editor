# Nox — Roadmap

Ordered by what makes Nox a better editor, not by what is easiest to build.
Anything not listed is not planned.

**The `v0.x` headings below are milestones, not releases**, and the two have
never lined up. A milestone is a theme; a release is whatever was finished when
a tag was cut. The v0.2 milestone's local model went out in release 0.3.0, and
three of the v0.3 milestone's four features went out in release 0.4.0. Each
shipped table says which release its rows landed in;
[CHANGELOG.md](CHANGELOG.md) is the authority on that, and this file is the
record of *why* something was built.

---

## ✅ v0.1 — Foundation *(released as 0.1.0)*

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
  reveal — keyboard-operable, and renames carry open buffers with them
- 179 unit tests over the pure and service layers, plus 4 Rust tests

---

## v0.2 — Trust

*Things that make you willing to keep the editor open all day.*

| | Why |
|---|---|
| **Drag files out of Nox** | Dragging a tree entry into another app. Requires a native drag source on the Rust side. |
| **Rename several files at once** | Multi-select exists; renaming many needs a find/replace-style pattern UI, not a single prompt. |
| **Untitled buffer language picker** | Status bar click to set the language before a first save. |
| **Explorer virtualisation** | The flat-node model already anticipates this; needed past a few thousand entries. |

### ✅ Shipped *(M1–M7 of [AGENT-PLATFORM.md](AGENT-PLATFORM.md) — released in 0.2.0, except the local model in 0.3.0)*

| | |
|---|---|
| **A project replace undoes in one step** | ⌘Z takes the whole replace back across every open file, and names what it undid. A file edited since is left alone and reported. |
| **Transactions with an author** | Programmatic edits are change sets: validated whole, applied to all their buffers or none, recorded in a log with who made them. The groundwork the agent runtime needs, useful now because it fixes undo. |
| **Cancellable background work** | Search and replace run as jobs with progress in the status bar. Cancelling a search stops the walk and clears the panel; cancelling a replace changes nothing, because a job computes and the main path applies. |
| **A permission model** | Commands declare what they need; programmatic callers are checked against a policy, with per-file grants and a decision log. You are never prompted. Nothing uses it yet but its tests — which is why it is right. |
| **A context API** | Structured, serialisable read access to buffers, selections, viewports, the project tree and recent changes. Nothing live escapes it, and every read by a non-human is recorded. |
| **Crash-safe writes** | Saves go to a temp file and are renamed into place, so a failure mid-save cannot truncate your work. Permissions preserved, symlinks followed. |
| **Out-of-process agents** | An agent is any program that speaks one JSON object per line on stdin and stdout. Nox supervises it; a reference agent ships in `examples/agents/`. |
| **Staged changes and hunk review** | A proposal is shown as a diff and accepted or rejected hunk by hunk before anything is written. What you keep lands as one undoable change. The diff engine is the one v0.5's Git view needs. |
| **The agent runtime** | Protocol, provider interface, session audit trail, one-button session undo. Agents act only through commands under the permission model. The interface is vendor-neutral; the first provider plugs into it without the runtime learning a vendor's name. |
| **A local model** | Point `agents.json` at an Ollama server and an agent can read your workspace and stage a change set. Entirely on your machine — the HTTP client is loopback-only, enforced in Rust. Edits are quoted rather than positional, because the model can pick the right text and cannot count characters. Read and propose only; no commands. |
| **Nothing unsaved is lost on quit** | Unsaved edits to a file are recorded in the session and restored dirty, with ⌘Z reaching the on-disk content. No quit dialog: it can be answered wrong, and persisting cannot be. |
| **A real quit hook** | The window now waits for the final session write and settings flush. `dispose()` was previously never called by anything. |
| **Cursor positions survive a restart** | Every selection range per tab, clamped to the document on restore and scrolled into view. |
| **Buffer switcher** | ⌘E, or `~` in the palette. Ordered by when you last looked at a file, opening on the previous one. |
| **Byte-order marks are preserved** | A file that had a BOM keeps it; one that did not never gains one. Shown in the status bar. |

---

## v0.3 — Navigation at scale

*Working in a project, not a folder.*

| | Why |
|---|---|
| **Replace individual matches** | Today replace applies per file or per project; dismissing a file excludes it, but single matches cannot be excluded. |
| **The same file in two panes** | Needs a second CodeMirror view over one document, forwarding transactions between them. The one real limit of the current split model. |
| **Nested splits** | A column inside a row. The layout is a flat list today. |
| **Terminal** *(shipped early, in 0.3.0)* | A real pty, not piped stdio, so `vim`, colour and job control work. Previously ruled out as its own project; it turned out to share process supervision with the agent transport, which is what made it affordable. |

### ✅ Shipped *(Go to symbol released in 0.3.0; the other three in 0.4.0)*

| | |
|---|---|
| **Go to symbol** | ⌘R, or `@` in the palette, lists the functions, classes, methods, rule sets and headings in the file you are on. A method reads as `Class.method`, so either half finds it. It reads the parse folding already keeps, so it is a reader rather than a second source, and a language with no parser says so instead of coming back empty. |
| **Sticky scroll** | Keeps the enclosing declaration pinned above the editor once its header scrolls out of view; click a pinned row to jump to it. Reads the same rule table Go to symbol does, so it pins declarations only, never `if`/`for` blocks. A panel, not an overlay, so it costs a row of height instead of covering the last line. |
| **Preserve case on replace** | The `AB` toggle in both replace panels: one replacement string comes back shaped to each match, so a case-insensitive search for `scheduler` writes `dispatcher`, `Dispatcher` and `DISPATCHER` where it found the three spellings. Three shapes only — a match that is none of them is written verbatim rather than guessed at. Off by default, and independent of Match case. |
| **Breadcrumb navigation** | The trail in the title bar is clickable: a folder segment opens the explorer and expands it, the file at the end reveals the file. Segments of a file outside the workspace stay inert, because there is nothing to reveal into. |

---

## v0.4 — Language intelligence

*The point at which Nox competes on capability rather than feel.*

| | Why |
|---|---|
| **LSP client** ✅ | Process supervision in Rust, JSON-RPC over stdio, a CodeMirror bridge in `editor/`. Unlocks everything below. The framing lives in Rust because `Content-Length` counts bytes and a renderer string counts UTF-16 code units; everything above it is TypeScript over an injected process, and therefore testable without a server. Servers come from `servers.json` — Nox never discovers or spawns one on its own. |
| **Diagnostics** | Inline squiggles and gutter marks are in; the problems panel is not yet. |
| **Completion** | Wire `@codemirror/autocomplete` to LSP; it is already a dependency for bracket closing. |
| **Hover, go to definition, find references** | |
| **Rename symbol** | Project-wide, via LSP. |
| **Formatting on save** | Through LSP or a configured external command. |
| **Tree-sitter evaluation** | Compare against Lezer for grammar breadth. Lezer is excellent but has a smaller catalogue. |

---

## v0.5 — Version control

| | Why |
|---|---|
| **Git gutter** | Added / modified / removed marks per line. |
| **Diff view** | Side-by-side and inline. The line diff and the hunk-review panel already exist (M6); this is Git wiring plus a second layout. |
| **Stage, commit, branch** | A focused panel — not a full Git client. |
| **Blame** | On demand, not always on. |

---

## v0.6 — Extensibility

| | Why |
|---|---|
| **Keybinding editor** | Bindings are already data; this is a UI. |
| **Custom themes from JSON** | Themes are already token overrides; expose them as user files. |
| **Snippets** | |
| **Plugin API** | Commands, panels, status items, editor extensions. Design gate: plugins must not be able to block the typing path. |
| **Workspace settings** | `.nox/settings.json` layered over user settings. |
| **Tasks** | Run project commands, capture output. |

---

## v0.7 — Modal editing

| | Why |
|---|---|
| **Vim mode** | Optional, off by default. The two-keymap split in `services/keymap.ts` vs CodeMirror was designed with this in mind: a mode is a third keymap layer, not a rewrite. |
| **Emacs bindings** | Same mechanism. |

---

## Later — AI

Deliberately not in the MVP and deliberately not the product's purpose. The
architecture supports it when the time comes: `Platform` isolates network
access, commands expose actions uniformly, and the workspace can already
enumerate buffers and project files.

- Explain selection *(shipped early, in 0.3.0)* — both halves are built: **Edit
  Selection with a Model…** returns a diff through the review panel, and
  **Explain Selection** and **Ask About Selection…** return prose to an
  **Answers** sidebar section. That section is the result surface this line
  was waiting on. Neither command remembers a previous question; a thread is
  the chat item below, not this one.
- Workspace-aware chat with an explicit, visible context set
- Remote model support alongside the local one
- Agentic edits — gated behind a diff review, never applied blind

**Principle:** AI is a panel and a set of commands, not a rewrite of the
editor. If a feature would make Nox worse for someone who never turns AI on, it
does not ship.

The groundwork this needs — authored transactions, a permission model, a
context API, staged change sets, a job runner — is specified in
[AGENT-PLATFORM.md](AGENT-PLATFORM.md), along with a milestone plan. Each of
those milestones is an editor improvement in its own right, which is the only
reason to build them before the agent exists.

---

## Not planned

- A light theme. Nox is a dark editor; that is the product.
- Real-time collaboration before v1. Interesting, enormous, and it would
  distort the document model to chase it early.
- Web/hosted Nox as a product. The browser target exists to make UI
  development fast, not to ship.

# Nox — Roadmap

Ordered by what makes Nox a better editor, not by what is easiest to build.
Anything not listed is not planned.

---

## ✅ v0.1.0 — Foundation *(shipped)*

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

### ✅ Shipped in v0.2 *(M1–M7 of [AGENT-PLATFORM.md](AGENT-PLATFORM.md))*

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
| **Preserve case on replace** | `Scheduler` → `Dispatcher` rather than `dispatcher` when the search is case-insensitive. The `AB` toggle other editors have. |
| **Replace individual matches** | Today replace applies per file or per project; dismissing a file excludes it, but single matches cannot be excluded. |
| **The same file in two panes** | Needs a second CodeMirror view over one document, forwarding transactions between them. The one real limit of the current split model. |
| **Nested splits** | A column inside a row. The layout is a flat list today. |
| **Breadcrumb navigation** | The title bar shows the trail; make segments clickable. |
| **Go to symbol** | Lezer syntax tree scan per file — a real outline without a language server. |
| **Sticky scroll** | Keep the enclosing function header pinned. |
| **Terminal** *(shipped early)* | A real pty, not piped stdio, so `vim`, colour and job control work. Previously ruled out as its own project; it turned out to share process supervision with the agent transport, which is what made it affordable. |

---

## v0.4 — Language intelligence

*The point at which Nox competes on capability rather than feel.*

| | Why |
|---|---|
| **LSP client** | Process supervision in Rust, JSON-RPC over stdio, a CodeMirror bridge in `editor/`. Unlocks everything below. |
| **Diagnostics** | Inline squiggles, gutter marks, a problems panel. |
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

- Explain selection *(shipped early)* — both halves are built: **Edit
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

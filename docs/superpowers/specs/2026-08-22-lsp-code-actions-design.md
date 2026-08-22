# Code actions — design

Nox shows you a diagnostic in the editor and in a Problems panel, and offers
no way to apply the fix the server has already computed.

Status: approved 2026-08-22.

Everything below was read out of `src/services/lsp/`, `src/core/lsp-rename.ts`,
`src/app.ts` and `src/ui/CommandPalette.svelte` rather than remembered.

## 1. Why this one

Seven `textDocument/*` features ship: diagnostics, completion, hover,
definition, references, rename, formatting. Code actions are the eighth, and
they are the one the protocol exists for — the others tell you about your code
and this is the one that fixes it. `grep -rn codeAction src/ src-tauri/src/`
returns nothing at all, and the v0.4 roadmap table names the seven and stops,
so it is a gap in the plan and not only in the code.

## 2. What already exists

Verified, not assumed.

| Seam | Where | What it gives us |
|---|---|---|
| A `WorkspaceEdit` reader | `src/core/lsp-rename.ts:41` (`renameEdits`) | `documentChanges` over `changes`, per-URI merge, malformed entries dropped, resource operations reported as unsupported. **Already generic** — nothing about it is rename. |
| Staging one across files | `src/app.ts:4143-4174` | Open every file first (so each buffer holds the text the server saw), convert with `changesOf`, `review.stage` one change set. |
| Applying one in place | `WorkspaceService.applyEdits` | One transaction, one ⌘Z, and `false` rather than a throw on a range the document cannot honour. |
| A staleness guard | `WorkspaceService.revisionOf` | What project replace already uses to refuse a buffer that moved under a computed edit. |
| A dedicated picker | `src/ui/CommandPalette.svelte:62` | `git-branch` and `note-open` are modes that no prefix may switch, because what the user types is a filter and not a command. Rows are `{key, title, positions, icon, accept}` and may be `disabled` with a `badge`. |
| Diagnostics by URI | `src/services/lsp/index.ts:78` | The `context.diagnostics` a server keys its quick fixes off. |

The reader moves to `core/lsp-workspace-edit.ts` as `workspaceEditPlan`. A
`WorkspaceEdit` is not a rename concept, and leaving the one reader two
features share inside `lsp-rename.ts` would mislead whoever arrives next.

## 3. Scope

In:

- `textDocument/codeAction` over the selection — or the cursor as an empty
  range — with the diagnostics that overlap it.
- `lsp.codeAction`, bound to `Mod+.`, opening a picker of what came back.
- Applying an action's `edit`.
- The `codeActionLiteralSupport` capability, so servers answer with
  `CodeAction` objects rather than bare `Command`s.

Out, and each for a reason:

- **Running an action's `command`.** An action may carry a `Command` instead
  of an edit; executing it means `workspace/executeCommand`, and the server
  answers by calling `workspace/applyEdit` *back*. That needs the
  server-request handler — `JsonRpcTransport.onRequest` exists at
  `transport.ts:97` with **zero callers**, so every server request is refused
  today — and a decision about whether a server-named command may write to
  buffers unprompted. That is a capability question and it does not get
  answered in passing. §5 says what the picker does about them meanwhile.
- **`codeAction/resolve`.** Gated behind `resolveSupport`, which Nox will not
  advertise, so a conforming server must send complete actions.
- **A lightbulb.** A gutter affordance is a second entry point to a command
  that already exists; keyboard first, and the palette is where Nox puts
  pickers.
- **`only` filtering / source actions.** "Organize imports" as its own
  command is a separate feature, and it is command-shaped anyway.

## 4. Where an action lands: the cursor rule

The codebase already splits this two ways and both ends are argued for:
rename goes through the review panel because it is a refactor across files
you are not looking at; **Format Document** applies directly, "not through
review, because a format is not a proposal".

A quick fix is the format end of that, so:

> **One file: applied directly, as one undoable transaction. More than one:
> staged in the review panel.**

The line is not "quick fix versus refactor" — the server's `kind` is a hint
and servers disagree about it. It is *how far the change reaches*. A change
inside the file you are looking at, that you asked for at your cursor, is not
a proposal. A change to files you have not opened is exactly what review is
for, and it is the shape rename already produces.

## 5. Actions Nox cannot run are shown, not hidden

An action with no `edit` is listed and **disabled**, with a badge saying so.
Hiding them would make the picker lie about what the server offered: a user
who knows "organize imports" exists would conclude Nox's server is broken
rather than that Nox has not built that half yet.

The same treatment covers `disabled` from the server itself (LSP 3.16), whose
`reason` the row shows.

## 6. Staleness

The edits are computed against the document as the server last saw it, and a
picker is open in between. The overlay has focus, so the user cannot type into
the buffer — but an external change can still land, and a save can reformat.

Both paths already have a guard and neither is new:

- **Direct:** the buffer's revision is captured when the request is sent and
  compared before applying. Moved means refused, with a toast, exactly as
  project replace refuses a file that moved under a computed edit.
- **Review:** the review panel's own revision guard at apply time, which is
  what rename relies on.

## 7. Failure paths

| Case | Behaviour |
|---|---|
| No server, or no `codeActionProvider` | Command disabled — it never appears enabled and then fails |
| Server errors or times out | One toast naming the server's message; nothing staged |
| Empty list | "No code actions here", and no empty picker |
| Every action is command-only | The picker opens with them listed and disabled, so the user sees what exists |
| Action's edit touches a file that cannot be opened | Refused whole, nothing applied — rename's rule, for rename's reason |
| Action asks for a file create/rename/delete | Refused whole; `workspaceEditPlan` already reports those as unsupported |
| Buffer moved since the request | Refused, with a toast |
| Malformed edits | Dropped by `textEditsOf`; an action left with none is refused rather than applied as a no-op |

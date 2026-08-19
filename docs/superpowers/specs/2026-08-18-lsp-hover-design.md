# LSP hover — design

Resting the pointer on a symbol shows its type and documentation.

Status: approved 2026-08-18. Implementation follows in a separate plan.
Superseded in part, 2026-08-19: §3's "the highlight covers the symbol" is
not what CodeMirror does — nothing is drawn for a tooltip's range;
`pos`/`end` decide when it closes. See
2026-08-19-lsp-rendering-verification-design.md §4.

The third feature on the request door completion opened, and the cheapest —
it needs no picker, no keymap and no insertion logic. What it does need is a
decision about rendering someone else's markdown, which is §4 and the only
part of this worth arguing about.

Checked against the installed `@codemirror/view` and against
`typescript-language-server` 5.3.0's advertised capabilities rather than
remembered.

## 1. What already exists

Nothing new is needed below the editor layer:

- `LspService.requestFor(languageId, method, params)` — and since
  2026-08-18 it **flushes pending document edits before asking**, which is
  what stopped completion answering about text the server had never seen.
  Hover inherits that fix rather than rediscovering it.
- `LspService.capabilitiesFor(languageId)` — tsserver advertises
  `hoverProvider: true`.
- `positionAt` / `offsetAt` in `core/lsp-position.ts`.
- `EditorPane` already owns a compartment the LSP extensions live in, keyed
  off the buffer the view is actually showing.

## 2. Scope

In:

- `src/core/lsp-hover.ts` — the three shapes `contents` can take, reduced to
  blocks Nox can render. Pure.
- `src/editor/hover.ts` — the `hoverTooltip` source and its DOM.
- Folding hover into the existing LSP compartment; §6.

Out, and deliberately:

- **Rendering markdown as HTML.** §4.
- **Hover on a selection, or a keyboard-triggered hover.** Pointer only.
  A keyboard equivalent is a command, and commands are a different surface.
- **Go-to-definition on click.** The same request door, its own feature.

## 3. The request

`hoverTooltip(source, { hoverTime: 300 })` — CodeMirror owns the timing, the
lifecycle and the dismissal, so none of that is Nox's to write. The source is:

```ts
(view, pos) => Promise<Tooltip | null>
```

It returns null — no tooltip at all, rather than an empty one — when there is
no server, no `hoverProvider`, no document, when the request rejects, or when
`contents` is empty. An empty box that follows the pointer around is worse
than nothing.

The response's optional `range` becomes the tooltip's `pos`/`end`, so the
highlight covers the symbol the server was talking about rather than the
character under the pointer.

## 4. Rendering: no HTML, and that is the point

`contents` is markdown. The obvious move is to render it — and there is no
markdown renderer in this project, so it would mean taking a dependency and
putting its output into `innerHTML`.

**Not doing that.** A language server is a third-party process, started from
`servers.json`, that Nox runs on the user's machine. Piping its output through
an HTML parser into a live DOM inside a desktop application with filesystem
access is an injection surface bought for typographic polish. The threat is
not hypothetical in shape: a hover string is derived from source code, and
source code arrives from repositories people clone.

Instead, `core/lsp-hover.ts` splits the markdown into an ordered list of
blocks:

```ts
type HoverBlock = { kind: 'code'; text: string } | { kind: 'prose'; text: string };
```

Fenced blocks (```` ``` ````) become `code`; everything else is `prose`. The
editor layer renders `code` into a `<pre>` in the editor's own font and
`prose` into a `<p>`, both via `textContent`. Never `innerHTML`, anywhere.

That yields the whole practical benefit — the signature in monospace, the
documentation beneath it — with no dependency and no parser between a server
and the DOM. Inline markdown (`**bold**`, backticks) survives as its literal
characters, which is a real cosmetic loss and the price being paid on purpose.

## 5. The three shapes of `contents`

The protocol has accumulated three, and a server may send any of them:

| Shape | Example |
|---|---|
| `MarkupContent` | `{ kind: 'markdown', value: '...' }` |
| `MarkedString` | `'plain string'` or `{ language: 'ts', value: '...' }` |
| `MarkedString[]` | a mix of the above |

All three are normalised in the pure module. The object form of
`MarkedString` carries a language and is therefore a code block, even without
a fence — a detail that is easy to miss and renders a type signature as prose
when missed.

## 6. One compartment, not two

`EditorPane` currently reconfigures `completionCompartment` after every state
swap. Hover needs the same treatment for the same reason — the deps close
over the pane's current buffer.

Rather than add a second compartment and a second reconfigure, the existing
one is renamed `lspCompartment` and holds both extensions. One thing for the
pane to remember instead of two, and the next feature on this door adds an
entry to an array rather than another wiring path.

## 7. Failure paths

Each is a test.

| Failure | Behaviour |
|---|---|
| No server for this language | No tooltip. No request made. |
| Server has no `hoverProvider` | No tooltip. No request made. |
| Request rejects or times out | No tooltip. The 10s transport timeout applies. |
| `contents` is empty, `''`, or an empty array | No tooltip, rather than an empty box. |
| `contents` is a bare string | Rendered as prose. |
| `contents` is `{ language, value }` | Rendered as **code**, not prose. |
| No `range` in the response | Tooltip anchors at the hovered position. |
| Document is untitled (no path) | No tooltip; there is no URI to ask about. |

## 8. Testing

**Pure, against no server:** each of the three `contents` shapes; a mixed
array; fenced blocks split from prose in order; a fence with a language tag;
an unterminated fence; empty and whitespace-only content reducing to no
blocks.

**The source, against a fake service:** returns null for each row of §7;
issues exactly one request when it should; uses the response `range` for the
tooltip span and the hovered position when there is none.

**Rendering, in jsdom:** a code block lands in a `<pre>` and prose in a `<p>`;
and — asserted directly — markup in the server's text appears as literal
characters, with no element created from it. That test is the guard on §4,
and it should fail loudly if anyone later reaches for `innerHTML`.

**Against the real server:** extend `tests/lsp-integration.test.ts` — hover
over a `const` in a real TypeScript file and assert the contents mention its
type. That is the test that has twice contradicted an assumption in this
subsystem; the assumption here is that tsserver returns `MarkupContent`
markdown rather than a legacy shape.

**Not testable here:** the tooltip appearing on a real hover. As with the
picker and the squiggle before it, that needs a build and a human.

## 9. Files

New: `src/core/lsp-hover.ts`, `src/editor/hover.ts`, and tests alongside each.

Changed: `src/editor/extensions.ts` (`completionCompartment` becomes
`lspCompartment`), `src/ui/EditorPane.svelte` (both extensions in it),
`tests/lsp-integration.test.ts`, `ROADMAP.md`, `CHANGELOG.md`, `WORKLOG.md`.

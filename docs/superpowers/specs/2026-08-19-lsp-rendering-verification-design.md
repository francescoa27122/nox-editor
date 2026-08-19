# LSP rendering verification — design

Prove, in the suite, that the three v0.4 surfaces the wire tests cover
actually reach the screen: the squiggle, the completion picker, and the hover
tooltip.

Status: decided 2026-08-19. Everything below was measured against this repo
on that date by building throwaway probes under vitest, reading their output,
and deleting them.

## 1. The gap

`WORKLOG.md` says the same sentence three times, once per feature: "has never
been seen. A tag build and a human." The wire behaviour of diagnostics,
completion and hover is proven — mutation-checked, and checked against a real
`typescript-language-server`. The rendering is covered by nothing:

- `tests/lsp-hover-source.test.ts` and `tests/lsp-completion-source.test.ts`
  hand the sources a **fake view** (`{ state } as EditorView`). They prove
  what the source returns, not that CodeMirror puts it in the DOM.
- `tests/lsp-paint-target.test.ts` does mount `EditorPane` and counts
  `.cm-lintRange` — the one partial exception, and it says in its own docblock
  that it does not reproduce the bug it was written for.
- Nothing proves the pane's `lspCompartment` delivers the completion and
  hover sources into a live view. The completion entry in the work log names
  exactly this: "the test proves the compartment exists in a built state, not
  that a keystroke reaches the server."

Meanwhile `CHANGELOG.md` `[Unreleased]` tells users hover works by
"underlining exactly the span the server is talking about". §4 says why that
sentence is wrong, and it is wrong for precisely the reason this design
exists.

## 2. The choice: jsdom, not Playwright

Two candidates. The question that decides between them is not taste, it is
what each can actually drive.

### What jsdom can drive — measured

A probe mounted a real `EditorView` with `buildExtensions(defaultSettings())`
and the real `lspCompartment` reconfigured to
`[lspCompletionExtension(deps), lspHoverExtension(deps)]`, against fake
`CompletionDeps` that answer from fixtures:

| Surface | Drove it with | What appeared in `view.dom` |
|---|---|---|
| Completion | `dispatch({ changes: insert '.', userEvent: 'input.type' })` | `.cm-tooltip-autocomplete` with one `<li role="option">` per item, `.cm-completionLabel` text, kind icon classes |
| Lazy docs | wait on the highlighted item | `.cm-completionInfo` containing `.cm-completionInfo-lsp` with the resolved text |
| Diagnostics | `applyDiagnostics(view, [...])` | `.cm-lintRange-error` whose `textContent` is the range's text, and `.cm-lint-marker-error` in `.cm-gutter-lint` |
| Hover | `mousemove` on the line, wait 300 ms | **Nothing, and an unhandled `TypeError`** |

The hover failure is not the source; the source was never called.
`HoverPlugin.startHover` (`@codemirror/view`) calls `view.coordsAtPos(pos)`
after `posAtCoords`, and `coordsAtPos` reaches
`textRange(...).getClientRects()` — a `Range` method jsdom does not
implement. It throws from a bare `setTimeout`, so vitest reports it as an
unhandled error rather than a failing assertion.

With this in the test file —

```ts
const ZERO = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
Range.prototype.getClientRects = () => [ZERO];
Range.prototype.getBoundingClientRect = () => ZERO;
```

— the same probe rendered `.cm-tooltip-hover` containing
`.cm-tooltip-lsp-hover` with a `<pre>` and a `<p>` whose `textContent` was
the fixture, the source was asked `textDocument/hover` for the pane's URI,
and a `mouseleave` removed the tooltip.

### Is that "faking the measurements"?

The component-harness design (§7, 2026-08-16) rejected stubbing
`getBoundingClientRect` because "every measurement would be a number invented
here". That still holds, and this is different in one specific way: jsdom's
`Element.getBoundingClientRect` already returns all zeros, so the polyfill
supplies a *missing method* with the *same values jsdom gives everywhere
else*. Nothing is invented; a hole in jsdom's `Range` is filled with jsdom's
own geometry. The consequence is that `posAtCoords` resolves to offset 0 for
any pointer position — the tests therefore never claim anything about
*which* symbol was hovered, only that hovering causes a request for the
pane's document and that the answer reaches the DOM as text.

The polyfill lives in one named module, `tests/support/jsdom-layout.ts`,
with this argument in its docblock, so the next person sees the boundary
rather than a mysterious four lines.

### What jsdom cannot drive, and Playwright could

- Placement: every tooltip sits at `top: -10000px` because it was never
  measured. Whether the picker opens below the cursor is CodeMirror's job and
  jsdom cannot check it.
- Pointer→position: that hovering *this* identifier asks about *this*
  identifier. Also CodeMirror's.
- Anything visual: colours, the squiggle actually being wavy, the gutter mark
  being red.

Playwright against `npm run dev` would reach all three. It was not chosen
because:

1. **It needs a production seam.** `WebPlatform` extends `MemoryPlatform`,
   whose `startLanguageServer` throws `unsupported`. Driving hover in a
   browser means the web build running a fake server injected from the test
   — a `window.__nox` hook or a query-string switch in shipped code, plus a
   fake server bundled into the page.
2. **It costs a browser download in CI on every push**, against a repo kept
   deliberately lean. `@playwright/test` plus Chromium is hundreds of
   megabytes; cacheable, but a new job and a new failure mode.
3. **It still does not reach the WebView.** Both rendering bugs that have
   actually shipped were Tauri-side: the console window (Rust `lsp.rs`) and
   the paint race (found on WebView2, in a real build). A Chromium run against
   Vite would have caught the second and not the first. It is a better proxy
   than jsdom for geometry, but "a tag build and a human" is retired by
   neither.
4. **The next four features are wiring and text, not geometry.** Go to
   definition moves the selection and opens a tab; find references fills a
   panel; rename edits buffers; format-on-save rewrites text. jsdom reaches
   every one through the harness this design extends.

**When to revisit:** the first feature whose *claim* is geometric — a
tooltip that must sit beside the pointer, an inlay hint that must not shift
the line — is the point at which Playwright earns its cost. Write it into
`ARCHITECTURE.md` §7 rather than into a plan nobody reads.

## 3. What gets built

Small. Three pieces plus corrections.

1. **A fake server the app can start.** `MemoryPlatform` gains an optional
   `languageServers` factory; when set, `startLanguageServer` returns what it
   makes instead of throwing. Capabilities stay `languageServers: false` — the
   flag describes what the *build* can do for a user, and the browser target
   still cannot start a process. The `FakeServer` currently private to
   `tests/lsp-service.test.ts` moves to `tests/support/fake-lsp-process.ts`
   and grows a `handle(method, fn)` so a test can script hover and completion
   answers. `lsp-service.test.ts` imports it back; one fake, not two.

2. **`tests/lsp-rendering.test.ts`**, jsdom, mounting the real `EditorPane`
   through `mountComponent` with the fake installed, so the whole path is
   under test: `servers.json` → `LspService.start()` → handshake → the pane's
   `lspCompartment` → CodeMirror's DOM. Three surfaces:
   - a published diagnostic paints `.cm-lintRange-error` under exactly the
     text its range names, plus a gutter mark;
   - typing `.` sends `textDocument/completion` for the pane's URI and the
     picker lists the server's labels; highlighting an item resolves and
     shows its documentation;
   - resting the pointer sends `textDocument/hover` for the pane's URI and the
     tooltip carries the code block and prose as text — a `<script>` in the
     server's markdown becomes characters, not an element — and leaves with
     the pointer.

   Each is mutation-checked before it counts: the hover test must fail when
   `lspHoverExtension` is dropped from the pane's `lspExtensions`, the
   completion test when `lspCompletionExtension` is, and the diagnostic test
   when `applyDiagnostics` stops being called.

3. **`tests/support/jsdom-layout.ts`** — the `Range` polyfill, with §2's
   argument attached.

Corrections, because a test that proves what the code does is only useful if
the words match:

- `CHANGELOG.md` `[Unreleased]` hover entry: "underlining exactly the span the
  server is talking about" → what actually happens: the tooltip stays up
  while the pointer is anywhere over the span the server names, and goes when
  it leaves.
- `ROADMAP.md` v0.4 hover row: "highlighting the span the server names rather
  than the character under the pointer" → the same correction.
- `src/editor/hover.ts:81` comment says "the highlight covers the symbol";
  say what `pos`/`end` do instead.
- `ARCHITECTURE.md` §7 row "Components embedding CodeMirror are untested" is
  now false and is replaced by the boundary above: wiring and text reachable,
  geometry not, Playwright when a geometric claim arrives.

## 4. What this found before it was built

CodeMirror's `hoverTooltip` decorates nothing. `pos` and `end` on the returned
tooltip control *dismissal* — the tooltip closes when the pointer leaves that
range — and no mark, underline or class is applied to the text. The probe's
rendered line was `<div class="cm-line">const answer: number = 42;</div>`
with a tooltip open. So the shipped-in-`[Unreleased]` claim that Nox
underlines the span is false; the design's §3 says "the highlight covers the
symbol" and was never checked against a screen. It was found by reading
`@codemirror/view`'s `HoverPlugin` and confirmed by looking at the DOM — the
first thing this design's tests do — and it is exactly the class of drift the
work log warned about three times.

Underlining the span is a small feature (a `StateField` of mark decorations
following the active hover), not a fix, and is not built here. The words are
corrected; whether to build the underline is a product call.

## 5. Cost

| | |
|---|---|
| New dependencies | None |
| Production code | One optional field and one branch in `MemoryPlatform`; one comment in `hover.ts` |
| New jsdom file | One, ~0.5 s of environment on the suite |
| CI | Unchanged |

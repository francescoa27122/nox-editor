import { syntaxTree } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView, showPanel, type Panel, type ViewUpdate } from '@codemirror/view';
import { enclosingSymbols, type StickyRow } from '@core/symbols';

/**
 * Sticky scroll.
 *
 * The enclosing class or function stays pinned above the editor once its own
 * header line has scrolled out of view, the same idea VS Code and JetBrains
 * ship under the same name. This is a `showPanel` consumer rather than a
 * decoration: the pinned lines are not part of the document, so drawing them
 * as editor content would make them selectable, editable and included in a
 * search — none of which they are.
 *
 * Symbols come from whatever `syntaxTree` has already parsed. A scroll frame
 * cannot afford `ensureSyntaxTree`'s parse budget the way a keystroke in the
 * command palette can — see `CommandPalette.svelte` — so an unparsed region
 * simply pins nothing. That is the honest answer, not a bug.
 */

/** Rows beyond this are not worth the vertical space they would take. */
const MAX_ROWS = 5;

/**
 * Each mounted panel's own DOM, keyed by the view that owns it.
 *
 * The panel (`showPanel`) and the scroll hook (`stickyScrollHook`, below) are
 * two separate extensions, each invoked by CodeMirror with whatever view is
 * currently relevant — they do not otherwise share a closure. A `WeakMap`
 * keyed on the view is what lets the scroll hook find *this* view's panel
 * rather than assuming there is only ever one view alive, which does not
 * hold once a pane is split (`EditorArea.svelte`). Entries need no explicit
 * cleanup beyond `Panel.destroy`: a `WeakMap` drops a view's entry on its own
 * once nothing else references the view.
 */
const panelState = new WeakMap<EditorView, { dom: HTMLElement }>();

/**
 * The document line at the very top of the visible scroll area.
 *
 * A layout read — call only from a measure phase (see `scheduleMeasure`).
 *
 * `scrollDOM.scrollTop` is already document-relative, which is what
 * `lineBlockAtHeight` wants; CodeMirror's own equivalent (`scrollAnchorAt`)
 * passes it straight through with no adjustment. An earlier version of this
 * function subtracted `view.documentTop`, reasoning it away as "the
 * document's own offset" — but `documentTop` is a *screen* coordinate
 * (`contentDOM.getBoundingClientRect().top + paddingTop`), not a document
 * one, and subtracting a screen coordinate that goes more negative as you
 * scroll adds the scroll offset a second time rather than removing it. The
 * resulting error is exactly zero at the top of a file, which is exactly
 * where a quick check tends to look, and grows toward double the true depth
 * as you scroll further down — a 100-line file scrolled to line 50 pinned
 * whatever enclosed roughly line 94.
 */
function topVisibleLine(view: EditorView): number {
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
  return view.state.doc.lineAt(block.from).number;
}

/** One pinned row: a button carrying its text, indented by nesting depth. */
function rowDOM(view: EditorView, row: StickyRow): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'nox-sticky-row';
  button.style.paddingLeft = `calc(var(--nox-sp-5) + ${row.depth} * var(--nox-sp-5))`;
  button.textContent = row.text;
  button.title = row.text;

  // A `mousedown` default on a button focuses it; preventing that default is
  // what keeps the caret (and keyboard focus) in the editor. The `click`
  // that follows still fires normally, so the jump itself happens there.
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => {
    view.dispatch({
      selection: { anchor: row.from },
      effects: EditorView.scrollIntoView(row.from, { y: 'start' }),
    });
    view.focus();
  });

  // Left as CodeMirror's own tab order puts it: the button is natively
  // focusable, so Tab from the editor reaches the strip and Enter fires the
  // same `click` handler above. That is a deliberate choice, not an
  // oversight — `folding.ts`'s fold-placeholder sets `tabindex` and handles
  // Enter/Space by hand, which is the alternative this row could have taken.
  // A row is worth reaching by keyboard (it is a jump target, the same as a
  // palette entry), and `click`'s own `view.focus()` already returns the
  // caret to the editor afterward, so there is nothing an explicit handler
  // here would do differently.
  return button;
}

/**
 * Paint `dom` with the rows enclosing `topLine`.
 *
 * A write phase: builds DOM from state already in hand, reads no layout.
 */
function paint(view: EditorView, dom: HTMLElement, topLine: number): void {
  const doc = view.state.doc;
  const pos = doc.line(topLine).from;
  const rows = enclosingSymbols(syntaxTree(view.state), doc, pos, topLine, MAX_ROWS);

  // Emptying rather than swapping the constructor: `showPanel`'s contract
  // closes a panel when its constructor stops being provided, and doing that
  // on ordinary scrolling would reconfigure the editor every frame. Its
  // `:empty` rule in `theme.ts` collapses the border and background along
  // with the height, so a file with nothing enclosing the top line shows no
  // strip at all — not an empty bordered bar.
  dom.replaceChildren(...rows.map((row) => rowDOM(view, row)));
}

/**
 * Schedule a measure-phase read of the top visible line, then a write of its
 * rows.
 *
 * `view.lineBlockAtHeight` — and so `topVisibleLine` — calls into
 * CodeMirror's `readMeasured`, which throws outside a measure phase:
 *
 * ```
 * readMeasured() {
 *     if (this.updateState == 2 / * UpdateState.Updating * /)
 *         throw new Error("Reading the editor layout isn't allowed during an update");
 * ```
 *
 * Both the panel constructor (runs mid-`EditorView` construction) and
 * `Panel.update` (runs mid-`updatePlugins`) execute inside that window, so
 * an earlier version of this file read layout directly from both and threw
 * on every editor open — `PluginInstance` catches the throw, logs
 * "CodeMirror plugin crashed", and deactivates `panelPlugin` entirely, so no
 * panel container is ever built and sticky scroll never appears.
 * `requestMeasure` defers the read to the point CodeMirror considers safe,
 * which is what `read`/`write` below are for.
 *
 * It also runs on its own schedule rather than waiting for the next
 * `ViewUpdate`, which `stickyScrollHook` depends on: `measure()` bails when
 * nothing changed, and CodeMirror tolerates roughly 250px of scroll drift
 * before it recomputes the viewport and sets `viewportMoved` — so an update
 * alone would leave the strip lagging the true top line by up to ~13 lines
 * of ordinary scrolling. A `requestMeasure` request runs regardless of any
 * of that.
 */
function scheduleMeasure(view: EditorView, dom: HTMLElement): void {
  view.requestMeasure({
    // Requests sharing a key collapse to the last one scheduled — `dom`
    // uniquely identifies this panel, so a constructor call, an `update`
    // and a scroll event landing in the same measure cycle run once, not
    // three times.
    key: dom,
    read: topVisibleLine,
    write: (topLine, v) => paint(v, dom, topLine),
  });
}

function stickyPanelConstructor(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = 'nox-sticky-scroll';

  // Per view, not module-level. `EditorArea.svelte` allows several editor
  // groups open side by side, each with its own view, so the scroll hook
  // below needs a way to find *this* view's panel dom rather than assuming
  // there is only ever one view alive.
  //
  // A4-001: this used to also hold a per-view symbol cache, because `paint`
  // walked the whole parsed tree (`fileSymbols`) and the cache was the only
  // thing standing between that and a fresh walk on every scroll. `docChanged`
  // was a guaranteed miss regardless, so typing still paid the full walk:
  // ~1.4 ms at 2,690 lines, and the audit measured it at 8-37 ms on files in
  // the tens of thousands of lines, on the most latency-sensitive path in the
  // editor. `paint` now calls `enclosingSymbols`, which walks upward from the
  // top visible line's own position through `.parent` — a cost bounded by
  // nesting depth, not document size — so there is nothing left worth caching.
  panelState.set(view, { dom });
  scheduleMeasure(view, dom);

  return {
    dom,
    top: true,
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportMoved || update.geometryChanged) {
        scheduleMeasure(update.view, dom);
      }
    },
    destroy() {
      panelState.delete(view);
    },
  };
}

/**
 * Scrolling alone usually produces no `ViewUpdate` at all — see
 * `scheduleMeasure` — so the panel's own `update` cannot track the top
 * visible line at scroll granularity by itself. This hooks the scroller's
 * native `scroll` event directly and schedules the same measure/paint pair,
 * closing that gap regardless of what the update loop decides.
 */
function stickyScrollHook(): Extension {
  return EditorView.domEventHandlers({
    scroll(_event, view) {
      const state = panelState.get(view);
      if (state) scheduleMeasure(view, state.dom);
    },
  });
}

export function stickyScrollExtension(enabled: boolean): Extension {
  if (!enabled) return [];
  return [showPanel.of(stickyPanelConstructor), stickyScrollHook()];
}

import { syntaxTree } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView, showPanel, type Panel, type ViewUpdate } from '@codemirror/view';
import { createSymbolCache, stickyRows, type StickyRow } from '@core/symbols';

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

/** The document line at the very top of the visible scroll area. */
function topVisibleLine(view: EditorView): number {
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop - view.documentTop);
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

  return button;
}

/** Repaint `dom` with the rows enclosing the current top visible line. */
function render(view: EditorView, dom: HTMLElement, symbolsFor: ReturnType<typeof createSymbolCache>): void {
  const symbols = symbolsFor(syntaxTree(view.state), view.state.doc);
  const rows = stickyRows(symbols, topVisibleLine(view), view.state.doc, MAX_ROWS);

  // Emptying rather than swapping the constructor: `showPanel`'s contract
  // closes a panel when its constructor stops being provided, and doing that
  // on ordinary scrolling would reconfigure the editor every frame. Its
  // `:empty` rule in `theme.ts` collapses the border and background along
  // with the height, so a file with nothing enclosing the top line shows no
  // strip at all — not an empty bordered bar.
  dom.replaceChildren(...rows.map((row) => rowDOM(view, row)));
}

function stickyPanelConstructor(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = 'nox-sticky-scroll';

  // Per view, not module-level. `EditorArea.svelte` allows several editor
  // groups open side by side, each with its own view, so a single shared
  // slot thrashes: pane A's scroll evicts pane B's cached parse and vice
  // versa, forcing a full re-walk on essentially every scroll in a split
  // view — the exact case the cache exists to avoid. Measured on
  // `src/app.ts` (2,690 lines, 67 symbols), that walk (`fileSymbols`, what
  // the cache guards) costs ~1.378 ms, against ~0.012 ms for `stickyRows`
  // (the filter over its output) — about 115× more, and entirely avoidable.
  // One cache per view keeps each pane's hits intact regardless of what the
  // other panes are showing, at the cost of one extra closure per view,
  // which is free.
  const symbolsFor = createSymbolCache();
  render(view, dom, symbolsFor);

  return {
    dom,
    top: true,
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportMoved || update.geometryChanged) {
        render(update.view, dom, symbolsFor);
      }
    },
  };
}

export function stickyScrollExtension(enabled: boolean): Extension {
  if (!enabled) return [];
  return showPanel.of(stickyPanelConstructor);
}

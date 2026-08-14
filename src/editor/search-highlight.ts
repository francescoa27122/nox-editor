import { getSearchQuery } from '@codemirror/search';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';

/**
 * Paints search matches in the editor.
 *
 * CodeMirror's own match highlighting is tied to the lifecycle of its search
 * *panel*, which Nox never opens — we draw our own find UI. Rather than
 * opening a hidden panel and hoping focus behaves, we decorate directly from
 * the search query in state.
 *
 * Only the visible ranges are decorated, so a query with 40,000 hits in a
 * large file costs the same as one with three.
 */

const match = Decoration.mark({ class: 'cm-searchMatch' });
const activeMatch = Decoration.mark({ class: 'cm-searchMatch cm-searchMatch-selected' });

function build(view: EditorView): DecorationSet {
  const query = getSearchQuery(view.state);
  if (!query.search || !query.valid) return Decoration.none;

  const selection = view.state.selection.main;
  const builder = new RangeSetBuilder<Decoration>();

  for (const { from, to } of view.visibleRanges) {
    const cursor = query.getCursor(view.state, from, to);
    for (let value = cursor.next(); !value.done; value = cursor.next()) {
      const { from: start, to: end } = value.value;
      if (start === end) continue;
      const isActive = start === selection.from && end === selection.to;
      builder.add(start, end, isActive ? activeMatch : match);
    }
  }

  return builder.finish();
}

export function searchHighlighter(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = build(view);
      }

      update(update: ViewUpdate) {
        // The query lives in a state field, so any transaction may change it;
        // rebuilding is cheap because it is viewport-bounded.
        if (update.docChanged || update.viewportChanged || update.selectionSet || update.transactions.length > 0) {
          this.decorations = build(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

import { getIndentUnit } from '@codemirror/language';
import { RangeSetBuilder, type Extension, type Text } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { guideDepths } from '@core/indent-guides';

/**
 * Indent guides.
 *
 * A line decoration per visible line that has any, carrying its guide count
 * and the indent step as CSS custom properties; `theme.ts` turns those into
 * a repeating gradient on the line's background. Drawing with a background
 * rather than with widgets means nothing is inserted into the text, so the
 * cursor, the selection and search all behave as if the guides were not
 * there, which is what a guide is for.
 *
 * Rule 5 is the design constraint here. The plugin decorates
 * `view.visibleRanges` and nothing else, and recomputes only when the
 * document, the viewport or the geometry changed. A 10 MB file costs what
 * its viewport costs. `tests/browser/typing-path.test.ts` measures exactly
 * this class of extension with a planted whole-document scan, so a
 * regression here fails a test that already exists.
 */

/**
 * How far past a visible range to read when a blank line sits at its edge.
 *
 * A blank line's guides come from its neighbours (see `guideDepths`), and
 * the neighbour of the first visible line is above the fold. Reading a few
 * lines either side answers that without reading the file; a blank run
 * longer than this at the very edge of the viewport falls back to depth
 * zero for a scroll frame, which nobody will see.
 */
const EDGE_CONTEXT = 8;

/**
 * The decorations for `ranges` of `doc`, and only those.
 *
 * Exported for the test, which hands it a range and checks that nothing
 * outside it is decorated; the plugin below is the one caller in the app.
 */
export function buildGuideDecorations(
  doc: Text,
  ranges: readonly { from: number; to: number }[],
  unit: number,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let lastLine = 0;

  for (const range of ranges) {
    const first = Math.max(lastLine + 1, doc.lineAt(range.from).number);
    const last = doc.lineAt(range.to).number;
    if (first > last) continue;
    lastLine = last;

    const readFrom = Math.max(1, first - EDGE_CONTEXT);
    const readTo = Math.min(doc.lines, last + EDGE_CONTEXT);
    const lines: string[] = [];
    for (let n = readFrom; n <= readTo; n++) lines.push(doc.line(n).text);
    const depths = guideDepths(lines, unit);

    for (let n = first; n <= last; n++) {
      const guides = depths[n - readFrom] ?? 0;
      if (guides === 0) continue;
      const line = doc.line(n);
      builder.add(
        line.from,
        line.from,
        Decoration.line({
          class: 'cm-indentGuides',
          attributes: { style: `--guides: ${guides}; --guide-step: ${unit}ch` },
        }),
      );
    }
  }

  return builder.finish();
}

const guidesPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildGuideDecorations(
        view.state.doc,
        view.visibleRanges,
        getIndentUnit(view.state),
      );
    }

    update(update: ViewUpdate) {
      // Geometry too: a font-size change moves the viewport without a
      // scroll, and the indent step is in `ch`, which it also moved.
      if (update.docChanged || update.viewportChanged || update.geometryChanged) {
        this.decorations = buildGuideDecorations(
          update.state.doc,
          update.view.visibleRanges,
          getIndentUnit(update.state),
        );
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** The compartment's content for the `editor.indentGuides` setting. */
export function indentGuidesExtension(enabled: boolean): Extension {
  return enabled ? guidesPlugin : [];
}

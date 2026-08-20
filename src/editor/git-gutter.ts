import { Facet, RangeSet, RangeValue, StateEffect, StateField, type Extension } from '@codemirror/state';
import { gutter, GutterMarker } from '@codemirror/view';
import type { GutterLine, GutterLineKind } from '@core/git-gutter';

/**
 * The git gutter: a bar per line that differs from what git's index holds.
 *
 * The provenance gutter's shape, as a sibling and not an extension of it —
 * that one answers "who edited this in this session", this one answers
 * "what does git not have yet", and the two must be able to disagree.
 *
 * Data arrives by dispatched effect (`setGitGutter`), computed by
 * `GitService` and painted by the pane; between computations the marks map
 * through document changes, so a keystroke shifts them instead of leaving
 * them a debounce-window behind. The field is installed unconditionally
 * (removing a StateField destroys its state — `extensions.ts` says so) and
 * only the rendering is compartmentalised behind `editor.gitGutter`.
 */

class GitLineValue extends RangeValue {
  constructor(readonly kind: GutterLineKind) {
    super();
  }
}

/** Replace every mark in the buffer with `lines`, as `GitService` computed them. */
export const setGitGutter = StateEffect.define<readonly GutterLine[]>();

/**
 * What a mousedown on the gutter should do — the pane provides "open the
 * diff view". A facet rather than a callback parameter, because this
 * extension is built from settings alone and must stay app-free; events on
 * a gutter also never bubble to the content element, so the view-level
 * `domEventHandlers` cannot catch them.
 */
export const onGitGutterClick = Facet.define<() => void>();

export const gitGutterField = StateField.define<RangeSet<GitLineValue>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setGitGutter)) return marksOf(effect.value, tr.state.doc);
    }
    if (!tr.docChanged) return set;
    // Mapped, not recomputed: the service's next debounce tick brings the
    // truth; until then a shifted mark beats one pointing at the wrong line.
    // A mark over deleted text collapses to zero width and is kept — the
    // line it sat on still differs from git.
    return set.map(tr.changes);
  },
});

function marksOf(
  lines: readonly GutterLine[],
  doc: { lines: number; line(n: number): { from: number } },
): RangeSet<GitLineValue> {
  const ranges = [];
  for (const entry of lines) {
    // The service computes against the text it read; the document may have
    // moved a keystroke since. Clamping keeps the transaction from throwing;
    // the next tick corrects the picture.
    if (entry.line < 1 || entry.line > doc.lines) continue;
    const from = doc.line(entry.line).from;
    ranges.push(new GitLineValue(entry.kind).range(from));
  }
  return RangeSet.of(ranges, true);
}

const MARKERS: Record<GutterLineKind, GutterMarker> = {
  added: markerFor('added'),
  modified: markerFor('modified'),
  removed: markerFor('removed'),
};

function markerFor(kind: GutterLineKind): GutterMarker {
  return new (class extends GutterMarker {
    override elementClass = `nox-git-${kind}`;
    override toDOM(): Node {
      const span = document.createElement('span');
      span.className = `nox-git-marker nox-git-marker-${kind}`;
      return span;
    }
  })();
}

/** The rendering half, gated by `editor.gitGutter` in `extensions.ts`. */
export function gitGutter(): Extension {
  return [
    gutter({
      class: 'cm-gitGutter',
      domEventHandlers: {
        mousedown(view) {
          const handlers = view.state.facet(onGitGutterClick);
          for (const handler of handlers) handler();
          return handlers.length > 0;
        },
      },
      lineMarker(view, line) {
        // Collected rather than assigned, because TypeScript does not see a
        // closure assignment as a narrowing event.
        const hits: GutterLineKind[] = [];
        view.state.field(gitGutterField).between(line.from, line.to, (from, _to, value) => {
          // A mark belongs to the line it starts on; a zero-width survivor
          // of a deletion stays with its line the same way.
          if (from >= line.from) {
            hits.push(value.kind);
            return false;
          }
          return undefined;
        });
        return hits.length > 0 ? MARKERS[hits[0]!] : null;
      },
      // Effect-only transactions change no document and would otherwise
      // never repaint — the trap `provenance.ts` documents at its gutter.
      lineMarkerChange: (update) =>
        update.startState.field(gitGutterField) !== update.state.field(gitGutterField),
    }),
  ];
}

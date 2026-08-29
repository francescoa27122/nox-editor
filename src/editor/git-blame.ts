import { RangeSet, RangeValue, StateEffect, StateField, type Extension } from '@codemirror/state';
import { gutter, GutterMarker } from '@codemirror/view';
import {
  blameLabel,
  blameTitle,
  BLAME_LABEL_WIDTH,
  type BlameCommit,
  type BlameLine,
} from '@core/git-blame';

/**
 * The blame gutter: who wrote each line, beside the line.
 *
 * The git gutter's shape: an effect-fed `StateField` of per-line marks and a
 * `gutter` that paints whatever the field holds. A sibling rather than an
 * extension of it. That one answers "what does git not have yet" from a
 * diff Nox computes; this one answers "who wrote this" from a walk only git
 * can do, and the two are switched on by different things.
 *
 * **Marks are per line, not per group, and that is the honest choice.** Blame
 * arrives run-length encoded, since a commit owns a contiguous run, and one
 * wide range per run would be a fraction of the marks. But a range grows when text
 * is inserted inside it, so a line typed in the middle of a run would inherit
 * the run's commit: the gutter would name a person who did not write that
 * line. A point mark at each line start cannot do that. An inserted line
 * simply has no mark and shows nothing, which is the truth until the next
 * fetch.
 *
 * **Between fetches the marks map rather than recompute**, exactly as the git
 * gutter's do. Nothing here is on the typing path beyond that mapping, and
 * nothing may be: recomputing means spawning `git blame`, which is why the
 * service refetches only on save, on a `.git` change and on the toggle
 * itself.
 *
 * The field is installed unconditionally, so its `update` does run on every
 * transaction even for the buffers nobody has asked about. But with blame
 * off the set is `RangeSet.empty` and mapping it is a no-op, which is the
 * same bargain `gitGutterField` already makes. What the compartment saves is
 * the *rendering*: no gutter column, and so no DOM element per visible line,
 * until someone asks for one.
 *
 * See `docs/superpowers/specs/2026-08-29-git-blame-design.md`.
 */

class BlameValue extends RangeValue {
  constructor(readonly commit: BlameCommit) {
    super();
  }

  override eq(other: RangeValue): boolean {
    // Identity, not deep equality: the parser hands every line of one commit
    // the same object, so this is both cheaper and exactly as precise.
    return other instanceof BlameValue && other.commit === this.commit;
  }
}

/** Replace every mark in the buffer with `lines`, as `GitService` parsed them. */
export const setGitBlame = StateEffect.define<readonly BlameLine[]>();

export const gitBlameField = StateField.define<RangeSet<BlameValue>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setGitBlame)) return marksOf(effect.value, tr.state.doc);
    }
    if (!tr.docChanged) return set;
    // Mapped, never recomputed: see the header. A mark over deleted text
    // collapses to zero width and is kept, the same way the git gutter keeps
    // one: the line that is now there still has a last author.
    return set.map(tr.changes);
  },
});

function marksOf(
  lines: readonly BlameLine[],
  doc: { lines: number; line(n: number): { from: number } },
): RangeSet<BlameValue> {
  const ranges = [];
  for (const entry of lines) {
    // git blamed the text the service sent, and the document may have moved
    // a keystroke since. Clamping keeps the transaction from throwing; the
    // next fetch corrects the picture.
    if (entry.line < 1 || entry.line > doc.lines) continue;
    ranges.push(new BlameValue(entry.commit).range(doc.line(entry.line).from));
  }
  return RangeSet.of(ranges, true);
}

/**
 * One marker per commit rather than per line.
 *
 * Keyed on the commit object the parser shares between every line it owns,
 * so a file with 4,000 lines and 60 commits builds 60 markers. Weak, because
 * the commits themselves live only as long as the blame that named them.
 */
const MARKERS = new WeakMap<BlameCommit, GutterMarker>();

function markerFor(commit: BlameCommit): GutterMarker {
  const existing = MARKERS.get(commit);
  if (existing) return existing;
  const marker = new (class extends GutterMarker {
    override eq(other: GutterMarker): boolean {
      return other === marker;
    }
    override toDOM(): Node {
      const span = document.createElement('span');
      span.className = commit.uncommitted
        ? 'nox-blame-entry nox-blame-uncommitted'
        : 'nox-blame-entry';
      span.textContent = blameLabel(commit);
      // Everything the fixed-width label had no room for: the full identity,
      // the date and the subject. A `title` rather than a CodeMirror tooltip
      // because gutter events do not reach the content element, so
      // `hoverTooltip` never fires here.
      span.title = blameTitle(commit);
      return span;
    }
  })();
  MARKERS.set(commit, marker);
  return marker;
}

/**
 * Holds the column open at its full width from the moment the gutter is
 * installed.
 *
 * Without it the gutter is zero-wide until the first marks arrive and then
 * jumps to full width, shoving the code sideways, and on a large repository
 * that is seconds after the toggle. Every label is padded to the same length, so one
 * spacer of that length is exactly the final width.
 */
const SPACER = new (class extends GutterMarker {
  override toDOM(): Node {
    const span = document.createElement('span');
    span.className = 'nox-blame-entry';
    span.textContent = ' '.repeat(BLAME_LABEL_WIDTH);
    return span;
  }
})();

/**
 * The rendering half. Installed by the pane while blame is on for the buffer
 * it is showing, and removed when it is not. Runtime state, not a setting, so
 * it has no entry in `SETTING_TO_COMPARTMENTS`.
 */
export function blameGutter(): Extension {
  return gutter({
    class: 'cm-blameGutter',
    initialSpacer: () => SPACER,
    lineMarker(view, line) {
      // Collected rather than assigned, because TypeScript does not see a
      // closure assignment as a narrowing event.
      const hits: BlameCommit[] = [];
      view.state.field(gitBlameField).between(line.from, line.to, (from, _to, value) => {
        // A mark belongs to the line it starts on; a zero-width survivor of
        // a deletion stays with its line the same way.
        if (from >= line.from) {
          hits.push(value.commit);
          return false;
        }
        return undefined;
      });
      return hits.length > 0 ? markerFor(hits[0]!) : null;
    },
    // Effect-only transactions change no document and would otherwise never
    // repaint: the trap `provenance.ts` documents at its own gutter.
    lineMarkerChange: (update) =>
      update.startState.field(gitBlameField) !== update.state.field(gitBlameField),
  });
}

import {
  RangeSet,
  RangeValue,
  StateField,
  type EditorState,
  type Range,
  type Transaction,
} from '@codemirror/state';
import { changeSetAnnotation, type Provenance } from '@services/transactions';

/**
 * Who changed what, in this session, as ranges in the document.
 *
 * A `StateField` rather than a `ViewPlugin` — the distinction matters. Search
 * highlighting is a `ViewPlugin` because matches are *derivable*: given the
 * query and the document you can always recompute them. Provenance is not.
 * Once a change set is applied nothing in the document remembers who did it,
 * so it has to be recorded as it happens and carried forward. A `RangeSet` in
 * state gets the carrying-forward for free, and it accumulates in background
 * buffers too, because the workspace updates their state whether or not a view
 * exists.
 */

export class ProvenanceValue extends RangeValue {
  constructor(readonly provenance: Provenance) {
    super();
  }

  override eq(other: RangeValue): boolean {
    return (
      other instanceof ProvenanceValue &&
      other.provenance.changeSetId === this.provenance.changeSetId
    );
  }
}

export const provenanceField = StateField.define<RangeSet<ProvenanceValue>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    if (!tr.docChanged) return set;
    const mapped = set.map(tr.changes);
    const provenance = tr.annotation(changeSetAnnotation);
    return provenance ? addMarks(mapped, tr, provenance) : subtractChanged(mapped, tr);
  },
});

/**
 * Mark what this change set inserted.
 *
 * A pure deletion inserts nothing and so marks nothing: a zero-width range
 * would render as a bar on a line whose text nobody authored. The deletion is
 * visible in the document itself, which is the honest place for it.
 */
function addMarks(
  set: RangeSet<ProvenanceValue>,
  tr: Transaction,
  provenance: Provenance,
): RangeSet<ProvenanceValue> {
  const value = new ProvenanceValue(provenance);
  const added: Range<ProvenanceValue>[] = [];

  tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
    if (toB > fromB) added.push(value.range(fromB, toB));
  });

  if (added.length === 0) return set;
  // A second change set over the same text owns it now; leaving the first
  // mark in place would name the wrong author for text it no longer wrote.
  const covered = set.update({
    filter: (from, to) => !added.some((range) => from < range.to && to > range.from),
  });
  return covered.update({ add: added, sort: true });
}

/**
 * Take the ranges this edit touched out of the set.
 *
 * `RangeSet.map` does the opposite of what is wanted here: an insertion inside
 * a range *extends* it, so a mark would swallow your typing and claim an agent
 * wrote it. Subtracting the inserted span splits the mark around what you
 * typed, which is what makes the gutter decay as you review — and an empty
 * gutter is only meaningful if it can be reached.
 *
 * A pure deletion contributes no cut (`toB > fromB` is false), but `map` still
 * collapses any mark that sat over the deleted text into a zero-width range.
 * Those are filtered out below regardless of whether there were any cuts to
 * apply, so a deletion-only edit can't leave a ghost mark behind.
 */
function subtractChanged(
  set: RangeSet<ProvenanceValue>,
  tr: Transaction,
): RangeSet<ProvenanceValue> {
  const cuts: { from: number; to: number }[] = [];
  tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
    if (toB > fromB) cuts.push({ from: fromB, to: toB });
  });

  const kept: Range<ProvenanceValue>[] = [];
  const cursor = set.iter();

  while (cursor.value) {
    let pieces = [{ from: cursor.from, to: cursor.to }];
    for (const cut of cuts) {
      const next: { from: number; to: number }[] = [];
      for (const piece of pieces) {
        if (cut.to <= piece.from || cut.from >= piece.to) {
          next.push(piece);
          continue;
        }
        if (cut.from > piece.from) next.push({ from: piece.from, to: cut.from });
        if (cut.to < piece.to) next.push({ from: cut.to, to: piece.to });
      }
      pieces = next;
    }
    for (const piece of pieces) {
      // Zero-width survivors are dropped unconditionally: a mark with no text
      // is a bar on a line nobody authored, whether it lost its width to a
      // cut above or to `map` collapsing it around a pure deletion.
      if (piece.to > piece.from) kept.push(cursor.value.range(piece.from, piece.to));
    }
    cursor.next();
  }

  return RangeSet.of(kept, true);
}

/** The provenance covering `pos`, or null. Used by the tooltip. */
export function provenanceAt(state: EditorState, pos: number): Provenance | null {
  let found: Provenance | null = null;
  state.field(provenanceField).between(pos, pos, (_from, _to, value) => {
    found = value.provenance;
    return false;
  });
  return found;
}

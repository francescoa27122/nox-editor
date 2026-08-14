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
    // `RangeSet.map` collapses a mark that sat over deleted text into a
    // zero-width range instead of dropping it — CodeMirror only drops an
    // empty mapped range when the value's `startSide > 0`, and
    // `ProvenanceValue` inherits `RangeValue`'s default of 0. Filtered here,
    // before the branch below, so neither an agent's own deletion nor a
    // user's leaves a ghost mark behind.
    const mapped = set.map(tr.changes).update({ filter: (from, to) => to > from });
    const provenance = tr.annotation(changeSetAnnotation);
    return provenance ? addMarks(mapped, tr, provenance) : subtractChanged(mapped, tr);
  },
});

/**
 * Split every range in `set` around `spans`, dropping the covered pieces and
 * keeping whatever flanks survive on either side.
 *
 * `RangeSet.update`'s `filter` can only drop a whole range, not divide one —
 * so it can't express "the middle third of this mark belongs to someone
 * else" without erasing the thirds either side of it too. Walking pieces by
 * hand is what both callers below actually need: a user's own edit carving
 * itself out of a mark, and a later change set overwriting only part of an
 * earlier one.
 */
function subtractSpans(
  set: RangeSet<ProvenanceValue>,
  spans: { from: number; to: number }[],
): Range<ProvenanceValue>[] {
  const kept: Range<ProvenanceValue>[] = [];
  const cursor = set.iter();

  while (cursor.value) {
    let pieces = [{ from: cursor.from, to: cursor.to }];
    for (const span of spans) {
      const next: { from: number; to: number }[] = [];
      for (const piece of pieces) {
        if (span.to <= piece.from || span.from >= piece.to) {
          next.push(piece);
          continue;
        }
        if (span.from > piece.from) next.push({ from: piece.from, to: span.from });
        if (span.to < piece.to) next.push({ from: span.to, to: piece.to });
      }
      pieces = next;
    }
    for (const piece of pieces) {
      // A span that exactly consumes a piece leaves nothing: don't hand back
      // a zero-width bar for text nobody wrote.
      if (piece.to > piece.from) kept.push(cursor.value.range(piece.from, piece.to));
    }
    cursor.next();
  }

  return kept;
}

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
  const spans: { from: number; to: number }[] = [];

  tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
    if (toB > fromB) {
      added.push(value.range(fromB, toB));
      spans.push({ from: fromB, to: toB });
    }
  });

  if (added.length === 0) return set;
  // A second change set owns the text it inserted now; splitting the old
  // marks around it — rather than dropping any mark it merely overlaps —
  // keeps the untouched flanks attributed to whoever actually wrote them.
  const kept = subtractSpans(set, spans);
  return RangeSet.of([...kept, ...added], true);
}

/**
 * Take the ranges this edit touched out of the set.
 *
 * `RangeSet.map` does the opposite of what is wanted here: an insertion inside
 * a range *extends* it, so a mark would swallow your typing and claim an agent
 * wrote it. Subtracting the inserted span splits the mark around what you
 * typed, which is what makes the gutter decay as you review — and an empty
 * gutter is only meaningful if it can be reached.
 */
function subtractChanged(
  set: RangeSet<ProvenanceValue>,
  tr: Transaction,
): RangeSet<ProvenanceValue> {
  const cuts: { from: number; to: number }[] = [];
  tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
    if (toB > fromB) cuts.push({ from: fromB, to: toB });
  });

  return RangeSet.of(subtractSpans(set, cuts), true);
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

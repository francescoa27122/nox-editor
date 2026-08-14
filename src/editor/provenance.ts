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
    return provenance ? addMarks(mapped, tr, provenance) : mapped;
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
  return set.update({ add: added, sort: true });
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

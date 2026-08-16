import {
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Transaction,
} from '@codemirror/state';
import { gutter, GutterMarker, hoverTooltip, showTooltip, type Tooltip } from '@codemirror/view';
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

/** Drop every mark in this buffer. The "Clear Change Marks" command. */
export const clearProvenanceEffect = StateEffect.define<null>();

export const provenanceField = StateField.define<RangeSet<ProvenanceValue>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    if (tr.effects.some((effect) => effect.is(clearProvenanceEffect))) return RangeSet.empty;
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

/** The provenance covering a position, plus the range it covers. */
export interface ProvenanceHit {
  from: number;
  to: number;
  provenance: Provenance;
}

/**
 * The provenance covering `pos`, or null. Used by the tooltip.
 *
 * `between(pos, pos, …)` treats a point as touching any range whose `from` or
 * `to` sits on it, so at a boundary between two abutting marks — routine
 * since Task 2 splits a range wherever a later change set overwrites part of
 * it — it reports both: the one ending at `pos` and the one starting there.
 * Ranges arrive in `from` order, so taking the first hit favours the left
 * (older) mark. That reads backwards for a hover: the character actually
 * under the pointer at `pos` belongs to the mark that *starts* there, not
 * the one that merely stops. Preferring a hit where `to > pos` — an actual
 * character of `pos` is still inside it — over one where `to === pos` fixes
 * that without changing anything away from a boundary, where only one mark
 * ever touches `pos` in the first place.
 *
 * Returns the matched range alongside the `Provenance` so the tooltip can
 * anchor itself to the whole marked span rather than the single point that
 * was hovered — see `provenanceTooltip`.
 */
export function provenanceAt(state: EditorState, pos: number): ProvenanceHit | null {
  let found: ProvenanceHit | null = null;
  state.field(provenanceField).between(pos, pos, (from, to, value) => {
    if (to > pos) {
      // Actually contains `pos` — take it and stop; nothing later in
      // `from` order can contain `pos` too without overlapping this one.
      found = { from, to, provenance: value.provenance };
      return false;
    }
    // Merely ends at `pos`. Keep it only as a fallback, in case no
    // containing mark ever turns up (e.g. `pos` is the end of the document).
    found ??= { from, to, provenance: value.provenance };
  });
  return found;
}

/**
 * The first mark anywhere on a line, or null.
 *
 * The bar is drawn per *line* — `lineMarker` asks only whether the line has any
 * mark at all — so the hover that explains the bar has to ask the same
 * question. `provenanceAt` answers about a single position, and a mark that
 * begins partway along a line does not touch that line's start, which is true
 * of every mark that is not the first thing on its line. A gutter hover driven
 * by `provenanceAt` would be dead on most of the lines the bar is drawn for.
 *
 * Takes the first mark rather than the one nearest the pointer: the bar carries
 * no position within the line, so there is nothing for "nearest" to mean.
 */
export function provenanceOnLine(state: EditorState, from: number, to: number): ProvenanceHit | null {
  let found: ProvenanceHit | null = null;
  state.field(provenanceField).between(from, to, (rangeFrom, rangeTo, value) => {
    found = { from: rangeFrom, to: rangeTo, provenance: value.provenance };
    return false;
  });
  return found;
}

export function hasProvenance(state: EditorState): boolean {
  return state.field(provenanceField).size > 0;
}

/**
 * The first mark starting after `from`, or null.
 *
 * Null rather than wrapping: silently returning to the top is how you lose
 * your place halfway through reviewing a change set.
 */
export function nextProvenance(
  state: EditorState,
  from: number,
): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  state.field(provenanceField).between(from + 1, state.doc.length, (start, end) => {
    if (start > from) {
      found = { from: start, to: end };
      return false;
    }
    return undefined;
  });
  return found;
}

/** The mirror of `nextProvenance`. */
export function previousProvenance(
  state: EditorState,
  from: number,
): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  state.field(provenanceField).between(0, Math.max(0, from - 1), (start, end) => {
    // `end < from` alone: a cursor at or inside a mark must move to the mark
    // before it, not back onto the one it is already sitting in.
    if (end < from) found = { from: start, to: end };
    return undefined;
  });
  return found;
}

/**
 * One bar, shared by every marked line.
 *
 * Deliberately one appearance for all four author kinds. The mark's job is
 * "something other than your typing touched this line" — the tooltip carries
 * who. Four colours in a 2px bar would ask a glance to read more than a glance
 * can.
 */
class ProvenanceMarker extends GutterMarker {
  override toDOM(): Node {
    const span = document.createElement('span');
    span.className = 'nox-provenance-marker';
    return span;
  }
}

const marker = new ProvenanceMarker();

/** Anchor the gutter's tooltip at this line's start, or `null` to put it away. */
const showGutterProvenance = StateEffect.define<number | null>();

/**
 * The tooltip the gutter bar shows, held in state rather than derived.
 *
 * `hoverTooltip` cannot do this job, which is why the bar answered nothing for
 * a whole release: it resolves a *document position* and only fires over
 * `.cm-content`, while the bar lives in a sibling element. Hovering the changed
 * text, which advertises nothing, worked; hovering the mark — the only thing on
 * screen saying there is attribution to read — did not.
 */
const gutterTooltipField = StateField.define<readonly Tooltip[]>({
  create: () => [],
  update(current, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(showGutterProvenance)) continue;
      if (effect.value === null) return [];
      const line = tr.state.doc.lineAt(effect.value);
      const hit = provenanceOnLine(tr.state, line.from, line.to);
      if (!hit) return [];
      return [
        {
          // Anchored at the line's start, beside the bar that raised it, rather
          // than at the mark: the bar names a line, and a tooltip that slid
          // along the line as the mark moved would sit nowhere near the pointer
          // that asked for it.
          pos: line.from,
          above: true,
          create: () => {
            const dom = document.createElement('div');
            dom.className = 'cm-tooltip-provenance';
            dom.textContent = describeProvenance(hit.provenance, Date.now());
            return { dom };
          },
        },
      ];
    }
    // The tooltip is anchored at a position an edit can move or delete.
    // Dropping it is safe: the pointer is still over the gutter, so the next
    // movement puts it back with whatever the line says now.
    return tr.docChanged ? [] : current;
  },
  provide: (field) => showTooltip.computeN([field], (state) => state.field(field)),
});

export function provenanceGutter(): Extension {
  return [
    gutterTooltipField,
    gutter({
      class: 'cm-provenanceGutter',
      // CodeMirror attaches these to the gutter's own element and resolves the
      // line under the pointer itself, snapping to the centre of whichever marker
      // element the event landed on — which is why this takes a `line` and does
      // no coordinate arithmetic of its own.
      domEventHandlers: {
        mousemove(view, line) {
          // Without this check, travelling down the gutter dispatches a
          // transaction per pixel; the tooltip only changes when the line does.
          if (view.state.field(gutterTooltipField)[0]?.pos === line.from) return false;
          view.dispatch({ effects: showGutterProvenance.of(line.from) });
          return false;
        },
        mouseleave(view) {
          if (view.state.field(gutterTooltipField).length > 0) {
            view.dispatch({ effects: showGutterProvenance.of(null) });
          }
          return false;
        },
      },
      lineMarker(view, line) {
        // `between` stops at the first hit: the line either has attribution or
        // it does not, and which change set it came from does not change the bar.
        let hit = false;
        view.state.field(provenanceField).between(line.from, line.to, () => {
          hit = true;
          return false;
        });
        return hit ? marker : null;
      },
      // This gutter never populates a `markers` RangeSet — it derives each
      // line's marker from `lineMarker` alone — so without telling it
      // explicitly when to repaint, `SingleGutterView.update` has nothing to
      // compare and never asks `lineMarker` again. "Clear Change Marks"
      // dispatches a transaction with no document change, so it also fails
      // `GutterView.updateGutters`'s other repaint checks (docChanged,
      // heightChanged, viewportChanged), and the bars would stay on screen
      // until the next edit, scroll or tab switch.
      lineMarkerChange: (update) =>
        update.startState.field(provenanceField) !== update.state.field(provenanceField),
    }),
  ];
}

/** "claude-1 · Rewrite the greeting · 10m ago". */
export function describeProvenance(provenance: Provenance, now: number): string {
  const elapsed = Math.max(0, now - provenance.at);
  const minutes = Math.floor(elapsed / 60_000);
  // "0m ago" reads as a bug rather than as freshness.
  const when = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
  return `${provenance.authorLabel} · ${provenance.description} · ${when}`;
}

export function provenanceTooltip(): Extension {
  return hoverTooltip((view, pos) => {
    const hit = provenanceAt(view.state, pos);
    if (!hit) return null;
    return {
      // CodeMirror places the tooltip from `pos` alone — `end` only extends
      // how long it survives a moving pointer, never where it's drawn — and
      // hides it outright (`dom.style.top = "-10000px"`) when `coordsAtPos(pos)`
      // falls outside the *visible*, scrolled-into-view rect. A mark taller
      // than the viewport can have `hit.from` scrolled off the top while the
      // hovered position is still on screen; anchoring at the unclamped
      // `hit.from` then hides the tooltip for the whole visible lower half of
      // the mark. `view.viewport` is *not* the fix: it is the wider,
      // DOM-rendered line range (with overscan beyond what's actually
      // visible), not the clipped visible rect the placement check uses — for
      // a document that fits in the DOM without virtualization,
      // `view.viewport.from` is 0 regardless of scroll position, so clamping
      // to it is a no-op and the tooltip stays hidden. `lineBlockAtHeight`
      // against the scroller's actual `scrollTop` is CodeMirror's own way of
      // turning "how far scrolled" into a doc position (see its internal
      // `scrollAnchorAt`), so it lands on a position that is genuinely
      // on-screen.
      pos: Math.max(hit.from, view.lineBlockAtHeight(view.scrollDOM.scrollTop).from),
      // Without `end`, `HoverPlugin.mousemove` treats the tooltip as a single
      // point and dismisses the moment the pointer's mapped position differs
      // from it — i.e. as soon as the cursor moves at all, even within the
      // same marked word. Spanning the whole hit keeps the tooltip up for as
      // long as the pointer is anywhere over the text it describes.
      end: hit.to,
      above: true,
      create() {
        const dom = document.createElement('div');
        dom.className = 'cm-tooltip-provenance';
        dom.textContent = describeProvenance(hit.provenance, Date.now());
        return { dom };
      },
    };
  });
}

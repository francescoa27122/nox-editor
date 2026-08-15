import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { buildExtensions, reconfigureEffects } from '../src/editor/extensions';
import {
  clearProvenanceEffect,
  describeProvenance,
  hasProvenance,
  nextProvenance,
  previousProvenance,
  provenanceAt,
  provenanceField,
  type ProvenanceValue,
} from '../src/editor/provenance';
import { MemoryPlatform } from '../src/platform/memory';
import { defaultSettings } from '../src/services/config/schema';
import { changeSetAnnotation, type Provenance } from '../src/services/transactions';
import { WorkspaceService } from '../src/services/workspace';

/**
 * The provenance field against hand-built transactions.
 *
 * No DOM: the field is pure state, and driving it directly is the only way to
 * test recording, decay and mapping in isolation; the one block that needs
 * more than a single buffer's state drives a real `WorkspaceService` against
 * `MemoryPlatform` instead, still with no DOM. Covers: what a change set
 * marks; that a mark carries the author resolved at record time; that a mark
 * survives an edit elsewhere in the document; the decay rule that shrinks or
 * splits a mark under an edit that overlaps it, and its `clearProvenanceEffect`
 * counterpart that drops a buffer's marks outright, including across every
 * buffer in a workspace; `provenanceAt`'s boundary handling; the tooltip's
 * text formatting; the setting's Compartment wiring; and next/previous/has-any
 * navigation. What it does not cover: the gutter and tooltip `Extension`s
 * themselves and the palette's `enabled` gating — both need a mounted view and
 * live in their own suites.
 */

function record(overrides: Partial<Provenance> = {}): Provenance {
  return {
    changeSetId: 'cs-1',
    authorKind: 'agent',
    authorLabel: 'claude-1',
    description: 'Rewrite the greeting',
    at: 1_700_000_000_000,
    ...overrides,
  };
}

function stateWith(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [provenanceField] });
}

/** Every marked range, as [from, to, changeSetId] triples in document order. */
function marks(state: EditorState): [number, number, string][] {
  const out: [number, number, string][] = [];
  const cursor = state.field(provenanceField).iter();
  while (cursor.value) {
    out.push([cursor.from, cursor.to, (cursor.value as ProvenanceValue).provenance.changeSetId]);
    cursor.next();
  }
  return out;
}

type ChangeSpec = { from: number; to?: number; insert?: string };

/** Apply a change set the way `WorkspaceService.apply` does. */
function applySet(state: EditorState, changes: ChangeSpec | ChangeSpec[], provenance = record()): EditorState {
  return state.update({ changes, annotations: changeSetAnnotation.of(provenance) }).state;
}

describe('recording', () => {
  it('marks the inserted range of a change set', () => {
    const state = applySet(stateWith('hello world'), { from: 0, to: 5, insert: 'goodbye' });

    // The failure this prevents: marking the whole line, so a gutter bar
    // claims a line changed when seven characters did.
    expect(marks(state)).toEqual([[0, 7, 'cs-1']]);
  });

  /**
   * The failure this prevents: the annotation being dropped, or the author
   * being resolved at render time instead of record time — either would
   * leave the label wrong (or blank) once the originating change set has
   * rotated out of the bounded log.
   */
  it('carries the author through to the mark', () => {
    const state = applySet(stateWith('x'), { from: 1, insert: 'y' });

    const cursor = state.field(provenanceField).iter();
    expect((cursor.value as ProvenanceValue).provenance.authorLabel).toBe('claude-1');
    expect((cursor.value as ProvenanceValue).provenance.description).toBe('Rewrite the greeting');
  });

  /**
   * The failure this prevents: a zero-width mark at the deletion point, which
   * renders as a gutter bar on a line whose text nobody authored.
   */
  it('adds no mark for a change set that only deletes', () => {
    const state = applySet(stateWith('hello world'), { from: 5, to: 11 });

    expect(marks(state)).toEqual([]);
  });

  /**
   * The failure this prevents: a field that seeds itself from the document
   * on creation, so a freshly opened file would claim someone authored text
   * nobody recorded a change set for.
   */
  it('leaves an untouched document unmarked', () => {
    expect(marks(stateWith('hello'))).toEqual([]);
  });

  /**
   * The failure this prevents: the position-mapping bug this whole design
   * exists to avoid hand-writing. An edit far from a mark must move it, not
   * corrupt it — and mapping is the entire reason this is a StateField rather
   * than a ViewPlugin.
   */
  it('maps a mark past an unrelated edit earlier in the document', () => {
    const marked = applySet(stateWith('aaaa....bbbb'), { from: 8, to: 12, insert: 'bbbb' });
    expect(marks(marked)).toEqual([[8, 12, 'cs-1']]);

    const edited = marked.update({ changes: { from: 0, insert: 'XX' } }).state;

    expect(marks(edited)).toEqual([[10, 14, 'cs-1']]);
  });
});

/** A plain user edit — no change-set annotation. */
function userEdit(state: EditorState, changes: ChangeSpec | ChangeSpec[]): EditorState {
  return state.update({ changes }).state;
}

describe('decaying', () => {
  /**
   * The failure this prevents: marks that never clear, so the gutter fills up
   * over a session and an empty gutter stops meaning anything.
   */
  it('clears the part of a mark you typed into, keeping the rest', () => {
    const marked = applySet(stateWith('aaaabbbbcccc'), { from: 0, to: 12, insert: 'aaaabbbbcccc' });
    expect(marks(marked)).toEqual([[0, 12, 'cs-1']]);

    // Type one character in the middle.
    const edited = userEdit(marked, { from: 6, insert: 'X' });

    // The touched character is unattributed; the two flanks survive.
    expect(marks(edited)).toEqual([
      [0, 6, 'cs-1'],
      [7, 13, 'cs-1'],
    ]);
  });

  /**
   * The failure this prevents: CodeMirror's default range mapping extends a
   * mark when you type at its edge, which is the opposite of "touching a line
   * takes ownership of it".
   */
  it('does not grow a mark when you type at its end', () => {
    const marked = applySet(stateWith('abc'), { from: 0, to: 3, insert: 'abc' });

    const edited = userEdit(marked, { from: 3, insert: 'XYZ' });

    expect(marks(edited)).toEqual([[0, 3, 'cs-1']]);
  });

  /**
   * The failure this prevents: none, currently — an insertion at position 0
   * shifts a following mark forward without ever overlapping it, so this
   * passes even against the unmodified `mapped` set, with no subtraction
   * involved. Kept anyway as a guard on CodeMirror's `assoc`/side semantics
   * for insertion-at-a-boundary: if a future CodeMirror upgrade changed
   * start-of-document mapping to grow the mark instead, this is what would
   * catch it.
   */
  it('does not grow a mark when you type at its start', () => {
    const marked = applySet(stateWith('abc'), { from: 0, to: 3, insert: 'abc' });

    const edited = userEdit(marked, { from: 0, insert: 'XYZ' });

    expect(marks(edited)).toEqual([[3, 6, 'cs-1']]);
  });

  it('removes a mark whose text was deleted entirely', () => {
    const marked = applySet(stateWith('keep____keep'), { from: 4, to: 8, insert: '____' });

    const edited = userEdit(marked, { from: 4, to: 8 });

    // The failure this prevents: a zero-width ghost surviving the deletion and
    // rendering as a bar on the line that closed over it.
    expect(marks(edited)).toEqual([]);
  });

  /**
   * The failure this prevents: stale authorship after an agent edits its own
   * earlier work — the mark would still name the first change set.
   */
  it('re-attributes a range a second change set overwrites', () => {
    const first = applySet(stateWith('abc'), { from: 0, to: 3, insert: 'abc' });
    const second = applySet(first, { from: 0, to: 3, insert: 'xyz' }, record({ changeSetId: 'cs-2' }));

    expect(marks(second)).toEqual([[0, 3, 'cs-2']]);
  });

  /**
   * The failure this prevents: an agent deleting text an earlier change set
   * wrote left a zero-width ghost behind, because `addMarks`'s `added.length
   * === 0` early return handed back the merely-mapped set without ever
   * filtering it. The ghost would render as a gutter bar on a line whose
   * text nobody authored, deleted or not.
   */
  it('removes a mark entirely deleted by a second change set', () => {
    const marked = applySet(stateWith('keep____keep'), { from: 4, to: 8, insert: '____' });

    const deleted = applySet(marked, { from: 4, to: 8 }, record({ changeSetId: 'cs-2' }));

    expect(marks(deleted)).toEqual([]);
  });

  /**
   * The failure this prevents: the same ghost as above, but surviving a
   * transaction that *also* inserts elsewhere — the old `covered` filter only
   * checked overlap against the new insertion's span, and a zero-width range
   * far away from it is never "overlapping", so it passed straight through.
   */
  it('removes a mark deleted by a change set that also inserts elsewhere', () => {
    const marked = applySet(stateWith('keep____keep....'), { from: 4, to: 8, insert: '____' });

    const changed = applySet(
      marked,
      [
        { from: 4, to: 8 },
        { from: 12, to: 16, insert: 'next' },
      ],
      record({ changeSetId: 'cs-2' }),
    );

    expect(marks(changed)).toEqual([[8, 12, 'cs-2']]);
  });

  /**
   * The failure this prevents: a second change set touching only the middle
   * of an earlier mark erased the whole thing, because `RangeSet.update`'s
   * `filter` can drop a range but can't split one — the untouched flanks on
   * either side of the overlap were destroyed along with the middle.
   */
  it('splits a mark a second change set only partially overlaps, keeping the untouched flanks', () => {
    const first = applySet(stateWith('aaaaaaaaaa'), { from: 0, to: 10, insert: 'aaaaaaaaaa' });

    const second = applySet(first, { from: 4, to: 6, insert: 'XY' }, record({ changeSetId: 'cs-2' }));

    expect(marks(second)).toEqual([
      [0, 4, 'cs-1'],
      [4, 6, 'cs-2'],
      [6, 10, 'cs-1'],
    ]);
  });

  /**
   * The failure this prevents: the same whole-mark erasure, triggered by mere
   * adjacency rather than overlap — `map` grows a mark to swallow an
   * insertion at its own end (see "does not grow a mark" above), and the
   * grown range then trips the old overlap check against the new change
   * set's span even though the two never shared a character before mapping.
   */
  it('does not erase an adjacent mark when a second change set inserts at its boundary', () => {
    const first = applySet(stateWith('abc'), { from: 0, to: 3, insert: 'abc' });

    const second = applySet(first, { from: 3, insert: 'XYZ' }, record({ changeSetId: 'cs-2' }));

    expect(marks(second)).toEqual([
      [0, 3, 'cs-1'],
      [3, 6, 'cs-2'],
    ]);
  });

  /**
   * The failure this prevents: `subtractChanged` mis-handling a transaction
   * with more than one cut inside a single mark — e.g. only applying the
   * first cut, or letting the second cut's coordinates (already shifted by
   * the first insertion) desync from the piece list.
   */
  it('splits a mark around multiple edits in the same transaction', () => {
    const marked = applySet(stateWith('aaaaaaaaaa'), { from: 0, to: 10, insert: 'aaaaaaaaaa' });

    const edited = userEdit(marked, [
      { from: 2, insert: 'X' },
      { from: 6, insert: 'Y' },
    ]);

    expect(marks(edited)).toEqual([
      [0, 2, 'cs-1'],
      [3, 7, 'cs-1'],
      [8, 12, 'cs-1'],
    ]);
  });

  /**
   * The failure this prevents: a cut that straddles the boundary between two
   * separate marks trimming only one of them, because the piece-splitting
   * loop was written and tested against a single mark at a time.
   */
  it('trims both marks when one edit spans the boundary between them', () => {
    const first = applySet(stateWith('aaaaabbbbb'), { from: 0, to: 5, insert: 'aaaaa' });
    const marked = applySet(first, { from: 5, to: 10, insert: 'bbbbb' }, record({ changeSetId: 'cs-2' }));
    expect(marks(marked)).toEqual([
      [0, 5, 'cs-1'],
      [5, 10, 'cs-2'],
    ]);

    const edited = userEdit(marked, { from: 3, to: 7, insert: 'XXXX' });

    expect(marks(edited)).toEqual([
      [0, 3, 'cs-1'],
      [7, 10, 'cs-2'],
    ]);
  });
});

describe('provenanceAt at a boundary', () => {
  /**
   * The failure this prevents: hovering the first character of a newer edit
   * reporting the older change set it was carved out of, because `between`
   * touches both the mark ending at `pos` and the mark starting there, and
   * naively taking the first (`from`-ascending) hit picks the one that only
   * grazes `pos` rather than the one whose text actually starts at it.
   */
  it('prefers the mark that contains pos over one that merely ends there', () => {
    const first = applySet(stateWith('aaaabbbbbb'), { from: 0, to: 4, insert: 'aaaa' });
    const second = applySet(first, { from: 4, to: 10, insert: 'bbbbbb' }, record({ changeSetId: 'cs-2' }));
    expect(marks(second)).toEqual([
      [0, 4, 'cs-1'],
      [4, 10, 'cs-2'],
    ]);

    expect(provenanceAt(second, 4)?.provenance.changeSetId).toBe('cs-2');
  });
});

describe('tooltip text', () => {
  const now = 1_700_000_600_000; // ten minutes after the fixture's `at`

  /**
   * The failure this prevents: the format string's field order or separator
   * changing — e.g. swapping author and description, or losing the ` · `
   * between them. Covers the ordinary case: all three fields populated, a
   * plain minute count.
   */
  it('names the author and the change', () => {
    expect(describeProvenance(record(), now)).toBe('claude-1 · Rewrite the greeting · 10m ago');
  });

  /**
   * The failure this prevents: "0m ago" for something that just happened,
   * which reads as a bug rather than as freshness.
   */
  it('says "just now" under a minute', () => {
    expect(describeProvenance(record({ at: now - 20_000 }), now)).toBe(
      'claude-1 · Rewrite the greeting · just now',
    );
  });

  /**
   * The failure this prevents: the `minutes < 60` branch swallowing this
   * case and reporting "120m ago" instead of switching to hours — the only
   * test that exercises the third branch of the elapsed-time ternary at all.
   */
  it('falls back to hours past sixty minutes', () => {
    expect(describeProvenance(record({ at: now - 7_200_000 }), now)).toBe(
      'claude-1 · Rewrite the greeting · 2h ago',
    );
  });

  /**
   * The failure this prevents: a project replace reading as though someone
   * else did it. `authorLabel` renders `{kind:'user'}` as "You".
   */
  it('renders your own change sets as yours', () => {
    expect(describeProvenance(record({ authorKind: 'user', authorLabel: 'You', description: 'Replace "foo"' }), now))
      .toBe('You · Replace "foo" · 10m ago');
  });
});

describe('the setting', () => {
  /**
   * The failure this prevents: putting the state field inside the compartment.
   * Reconfiguring a compartment to nothing removes its extensions, and
   * removing a StateField destroys the state it holds — so toggling the
   * setting off would silently throw away every mark recorded so far, and
   * toggling it back on would show an empty gutter.
   */
  it('keeps marks recorded while the gutter is hidden', () => {
    const off = { ...defaultSettings(), 'workbench.showChangeMarks': false };
    const state = EditorState.create({ doc: 'hello', extensions: buildExtensions(off) });

    const marked = state.update({
      changes: { from: 0, to: 5, insert: 'goodbye' },
      annotations: changeSetAnnotation.of(record()),
    }).state;

    // Recorded even though nothing is rendering it.
    expect(marks(marked)).toEqual([[0, 7, 'cs-1']]);
  });

  /**
   * The failure this prevents: not recording itself — this passes whether or
   * not `provenanceField` sits inside the setting's compartment, since with
   * the setting on a compartmentalised field is present too. What it
   * actually guards is that `buildExtensions` composes the field in at all
   * when the setting is on, i.e. wiring, not the record/decay logic the
   * `recording` and `decaying` blocks above already cover directly.
   */
  it('records marks with the gutter on, too', () => {
    const state = EditorState.create({ doc: 'hello', extensions: buildExtensions(defaultSettings()) });

    const marked = state.update({
      changes: { from: 0, to: 5, insert: 'goodbye' },
      annotations: changeSetAnnotation.of(record()),
    }).state;

    expect(marks(marked)).toEqual([[0, 7, 'cs-1']]);
  });

  /**
   * The failure this prevents: `provenanceField` living inside the
   * `provenance` Compartment instead of the static extension list.
   * Reconfiguring a Compartment to nothing removes its extensions, and
   * removing a StateField discards the state it held — so a field placed
   * inside the compartment would silently lose every mark the moment the
   * setting was switched off, and reconfiguring back on would show an empty
   * gutter over marks that were quietly destroyed rather than merely
   * hidden. Exercises the actual round trip: on, mark recorded, off, back
   * on, mark still there — headless, since `state.update` with
   * `reconfigureEffects` needs no view and the field is a `StateField`.
   */
  it('shows marks recorded while the setting was off once it is turned back on', () => {
    const on = defaultSettings();
    const off = { ...on, 'workbench.showChangeMarks': false };
    const changed = new Set(['workbench.showChangeMarks']);

    let state = EditorState.create({ doc: 'hello', extensions: buildExtensions(on) });
    state = state.update({
      changes: { from: 0, to: 5, insert: 'goodbye' },
      annotations: changeSetAnnotation.of(record()),
    }).state;
    expect(marks(state)).toEqual([[0, 7, 'cs-1']]);

    state = state.update({ effects: reconfigureEffects(off, changed) }).state;
    state = state.update({ effects: reconfigureEffects(on, changed) }).state;

    expect(marks(state)).toEqual([[0, 7, 'cs-1']]);
  });
});

describe('navigation', () => {
  /** Two marks: [0,3) from cs-1 and [6,9) from cs-2. */
  function twoMarks(): EditorState {
    const first = applySet(stateWith('abc...def'), { from: 0, to: 3, insert: 'abc' });
    return applySet(first, { from: 6, to: 9, insert: 'def' }, record({ changeSetId: 'cs-2' }));
  }

  /**
   * The failure this prevents: returning the mark the cursor is already
   * inside instead of skipping it for the one further on. The fixture's
   * first mark `[0,3)` starts exactly at `from = 0`; if the guard read
   * `start >= from` instead of `start > from` it would match and return
   * `{from:0,to:3}` instead of moving on to `{from:6,to:9}`.
   */
  it('finds the next mark after the cursor', () => {
    expect(nextProvenance(twoMarks(), 0)).toEqual({ from: 6, to: 9 });
  });

  /**
   * The failure this prevents: a cursor strictly inside a mark being treated
   * as before it. `between(from + 1, …)` still visits `[6,9)` for a cursor at
   * 7, because the range overlaps the query window even though the mark's
   * own `start` (6) is less than `from`. If the guard checked `end > from`
   * instead of `start > from` it would return the very mark the cursor sits
   * inside as "next".
   */
  it('does not return the mark the cursor is inside as the next one', () => {
    expect(nextProvenance(twoMarks(), 7)).toBeNull();
  });

  /**
   * This is exactly the case the `previousProvenance` correction addresses.
   * The failure this prevents: with the brief's original
   * `end < from || start < from`, the mark `[6,9)` also matches — its
   * `start` (6) is less than `from` (9) — and being visited after `[0,3)` in
   * `from`-order, it overwrites the correct answer. The cursor, sitting at
   * the end of `[6,9)`, would then jump right back onto the mark it is
   * already on instead of moving to the actual previous mark `[0,3)`.
   */
  it('finds the previous mark before the cursor', () => {
    expect(previousProvenance(twoMarks(), 9)).toEqual({ from: 0, to: 3 });
  });

  /**
   * The mirror of the "next" case above, and the interior-cursor case the
   * `previousProvenance` correction was actually about — a cursor at 7 sits
   * inside `[6,9)`, not at its end. The failure this prevents: a guard
   * admitting `[6,9)` because its `start` (6) falls inside the query window
   * `between(0, from - 1)`, the same class of bug the brief's original
   * `|| start < from` clause caused, here triggered by an interior cursor
   * rather than the end-of-mark cursor the test above covers.
   */
  it('finds the mark before the one the cursor is inside', () => {
    expect(previousProvenance(twoMarks(), 7)).toEqual({ from: 0, to: 3 });
  });

  /**
   * The failure this prevents: wrapping silently, which loses your place in
   * the middle of reviewing a change set that touched several files.
   */
  it('returns null at the last mark rather than wrapping', () => {
    expect(nextProvenance(twoMarks(), 6)).toBeNull();
  });

  /**
   * The failure this prevents: wrapping around to return the last mark when
   * there's nothing before the cursor — the silent-wrap failure the
   * null-at-the-ends design exists to avoid.
   */
  it('returns null before the first mark rather than wrapping', () => {
    expect(previousProvenance(twoMarks(), 0)).toBeNull();
  });

  /**
   * The failure this prevents: the palette commands, gated on
   * `#activeHasProvenance()`, staying enabled with nothing to navigate to or
   * disabled on a document that has marks — `hasProvenance` is the only
   * thing gating them, so an inverted or wrong-field check here would leave
   * "Go to Next Change" always clickable or always greyed out.
   */
  it('reports whether a document has any marks at all', () => {
    expect(hasProvenance(twoMarks())).toBe(true);
    expect(hasProvenance(stateWith('nothing here'))).toBe(false);
  });

  it('clears every mark in the buffer', () => {
    const cleared = twoMarks().update({ effects: clearProvenanceEffect.of(null) }).state;

    // The failure this prevents: clearing only the marks the cursor is in,
    // leaving the rest to look like they were missed rather than dismissed.
    expect(marks(cleared)).toEqual([]);
  });
});

describe('clearing every buffer', () => {
  /**
   * The failure this prevents: "Clear Change Marks" reaching only the
   * buffer with a mounted view. The design promises it drops marks in
   * every buffer — exactly what a project-wide replace across several open
   * files needs — and `WorkspaceService.broadcastEffect` is the mechanism
   * the command now runs through instead of dispatching to a single view.
   * A regression here would mean the command clears whichever tab is on
   * screen and silently leaves every other open file marked.
   */
  it('drops marks from every open buffer, not just the active one', () => {
    const workspace = new WorkspaceService(new MemoryPlatform(), () => [provenanceField]);
    const a = workspace.newUntitled({ content: 'aaaa' });
    const b = workspace.newUntitled({ content: 'bbbb' });

    // Mirrors what a project replace does: one change set, edits in two
    // buffers neither of which has a mounted view in this headless test.
    workspace.apply({
      description: 'Replace',
      author: { kind: 'user' },
      edits: [
        { bufferId: a, changes: { from: 0, to: 4, insert: 'AAAA' } },
        { bufferId: b, changes: { from: 0, to: 4, insert: 'BBBB' } },
      ],
    });
    expect(hasProvenance(workspace.stateOf(a)!)).toBe(true);
    expect(hasProvenance(workspace.stateOf(b)!)).toBe(true);

    workspace.broadcastEffect(clearProvenanceEffect.of(null));

    expect(hasProvenance(workspace.stateOf(a)!)).toBe(false);
    expect(hasProvenance(workspace.stateOf(b)!)).toBe(false);
  });
});

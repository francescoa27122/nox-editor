import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { provenanceField, type ProvenanceValue } from '../src/editor/provenance';
import { changeSetAnnotation, type Provenance } from '../src/services/transactions';

/**
 * The provenance field against hand-built transactions.
 *
 * No DOM and no workspace: the field is pure state, and driving it directly
 * is the only way to test the interleavings that matter — a mark mapped
 * through an unrelated edit, a mark half-deleted, a second change set landing
 * on top of a first.
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

/** Apply a change set the way `WorkspaceService.apply` does. */
function applySet(state: EditorState, changes: { from: number; to?: number; insert?: string }, provenance = record()): EditorState {
  return state.update({ changes, annotations: changeSetAnnotation.of(provenance) }).state;
}

describe('recording', () => {
  it('marks the inserted range of a change set', () => {
    const state = applySet(stateWith('hello world'), { from: 0, to: 5, insert: 'goodbye' });

    // The failure this prevents: marking the whole line, so a gutter bar
    // claims a line changed when seven characters did.
    expect(marks(state)).toEqual([[0, 7, 'cs-1']]);
  });

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

  it('leaves an untouched document unmarked', () => {
    expect(marks(stateWith('hello'))).toEqual([]);
  });
});

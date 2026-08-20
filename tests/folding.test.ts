import { javascript } from '@codemirror/lang-javascript';
import { ensureSyntaxTree, foldable } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { foldRangesAtLevel } from '../src/editor/folding';

/**
 * Folding depends on the language grammar, so these run against a real parse
 * rather than a stub — `foldRangesAtLevel` is pure and view-free precisely so
 * it can be tested this way, headless, in milliseconds.
 */

const SOURCE = `function outer() {
  const config = {
    nested: {
      deep: true,
    },
  };

  function inner() {
    return config;
  }

  return inner;
}

class Thing {
  method() {
    if (true) {
      return 1;
    }
  }
}
`;

function stateFor(doc: string) {
  const state = EditorState.create({ doc, extensions: [javascript({ typescript: true })] });
  // The initial parse runs on a 20ms wall-clock budget, so on a loaded machine
  // the tree snapshot taken at state creation can stop short of the end.
  // ensureSyntaxTree finishes the parse, but only in the shared ParseContext —
  // syntaxTree(state), which foldable() reads, keeps returning the stale
  // snapshot until a transaction makes the language field re-snapshot it.
  // Both steps are needed; this suite failed under CPU contention with only
  // the first.
  const tree = ensureSyntaxTree(state, state.doc.length, 10_000);
  if (tree === null) throw new Error('syntax tree did not finish parsing within 10s');
  return state.update({}).state;
}

/** 1-based line numbers where a fold at `level` starts. */
function foldLinesAtLevel(doc: string, level: number): number[] {
  const state = stateFor(doc);
  return foldRangesAtLevel(state, level).map((range) => state.doc.lineAt(range.from).number);
}

describe('foldRangesAtLevel', () => {
  it('finds the outermost foldable blocks at level 1', () => {
    // `function outer` on line 1 and `class Thing` on line 15.
    expect(foldLinesAtLevel(SOURCE, 1)).toEqual([1, 15]);
  });

  it('finds nested blocks at level 2', () => {
    const lines = foldLinesAtLevel(SOURCE, 2);
    // The object literal, the inner function, and the class method.
    expect(lines).toContain(2);
    expect(lines).toContain(8);
    expect(lines).toContain(16);
  });

  it('goes deeper at level 3', () => {
    const lines = foldLinesAtLevel(SOURCE, 3);
    expect(lines).toContain(3); // `nested: {`
    expect(lines).toContain(17); // `if (true) {`
  });

  it('returns nothing past the deepest nesting', () => {
    expect(foldRangesAtLevel(stateFor(SOURCE), 9)).toEqual([]);
  });

  it('returns nothing for a document with no foldable blocks', () => {
    expect(foldRangesAtLevel(stateFor('const a = 1;\nconst b = 2;\n'), 1)).toEqual([]);
  });

  it('returns nothing for an empty document', () => {
    expect(foldRangesAtLevel(stateFor(''), 1)).toEqual([]);
  });

  it('produces ranges that CodeMirror itself agrees are foldable', () => {
    const state = stateFor(SOURCE);
    for (const range of foldRangesAtLevel(state, 1)) {
      const line = state.doc.lineAt(range.from);
      expect(foldable(state, line.from, line.to)).toEqual(range);
    }
  });

  it('never returns a range that ends before it starts', () => {
    const state = stateFor(SOURCE);
    for (let level = 1; level <= 4; level++) {
      for (const range of foldRangesAtLevel(state, level)) {
        expect(range.to).toBeGreaterThan(range.from);
      }
    }
  });

  it('levels are disjoint — a block appears at exactly one depth', () => {
    const state = stateFor(SOURCE);
    const seen = new Map<string, number>();

    for (let level = 1; level <= 5; level++) {
      for (const range of foldRangesAtLevel(state, level)) {
        const key = `${range.from}:${range.to}`;
        expect(seen.has(key)).toBe(false);
        seen.set(key, level);
      }
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  it('is unaffected by a language without a fold service', () => {
    // Plain text has no grammar, so nothing is foldable — the gutter simply
    // shows no arrows rather than guessing from indentation.
    const state = EditorState.create({ doc: SOURCE });
    expect(foldRangesAtLevel(state, 1)).toEqual([]);
  });
});

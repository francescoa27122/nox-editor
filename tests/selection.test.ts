import { beforeEach, describe, expect, it } from 'vitest';
import { ExplorerSelection } from '../src/services/selection';

/**
 * The explorer selection model.
 *
 * The interesting behaviour is all in the interaction between `lead` and
 * `anchor`: keeping them separate is what makes a Shift-range shrink as well
 * as grow. Most of these tests exist to pin that down.
 */

const TREE = [
  '/w/config',
  '/w/src',
  '/w/src/main.ts',
  '/w/src/util.ts',
  '/w/src/deep',
  '/w/src/deep/nested.ts',
  '/w/README.md',
];

describe('single selection', () => {
  let selection: ExplorerSelection;
  beforeEach(() => {
    selection = new ExplorerSelection();
  });

  it('starts empty', () => {
    expect(selection.size).toBe(0);
    expect(selection.isEmpty()).toBe(true);
    expect(selection.lead.get()).toBeNull();
  });

  it('set replaces everything and moves lead and anchor', () => {
    selection.set('/w/src/main.ts');
    selection.set('/w/README.md');

    expect([...selection.paths.get()]).toEqual(['/w/README.md']);
    expect(selection.lead.get()).toBe('/w/README.md');
    expect(selection.anchor.get()).toBe('/w/README.md');
  });

  it('set(null) clears', () => {
    selection.set('/w/src');
    selection.set(null);
    expect(selection.isEmpty()).toBe(true);
  });
});

describe('toggle', () => {
  let selection: ExplorerSelection;
  beforeEach(() => {
    selection = new ExplorerSelection();
  });

  it('adds without removing the rest', () => {
    selection.set('/w/src/main.ts');
    selection.toggle('/w/README.md');

    expect(selection.size).toBe(2);
    expect(selection.has('/w/src/main.ts')).toBe(true);
  });

  it('removes an already-selected path', () => {
    selection.set('/w/src/main.ts');
    selection.toggle('/w/README.md');
    selection.toggle('/w/src/main.ts');

    expect([...selection.paths.get()]).toEqual(['/w/README.md']);
  });

  it('re-anchors so a following range starts from the toggled row', () => {
    selection.set('/w/config');
    selection.toggle('/w/src/util.ts');
    selection.extendTo('/w/src/deep', TREE);

    // Range runs from the toggle, not from the original set().
    expect([...selection.paths.get()]).toEqual(['/w/src/util.ts', '/w/src/deep']);
  });
});

describe('range selection', () => {
  let selection: ExplorerSelection;
  beforeEach(() => {
    selection = new ExplorerSelection();
    selection.set('/w/src');
  });

  it('selects everything between anchor and target', () => {
    selection.extendTo('/w/src/deep', TREE);
    expect([...selection.paths.get()]).toEqual([
      '/w/src',
      '/w/src/main.ts',
      '/w/src/util.ts',
      '/w/src/deep',
    ]);
  });

  it('works upward as well as downward', () => {
    selection.set('/w/src/deep');
    selection.extendTo('/w/config', TREE);

    expect(selection.size).toBe(5);
    expect(selection.has('/w/config')).toBe(true);
    expect(selection.has('/w/README.md')).toBe(false);
  });

  it('shrinks when the range is pulled back toward the anchor', () => {
    selection.extendTo('/w/src/deep/nested.ts', TREE);
    expect(selection.size).toBe(5);

    // This is the behaviour that breaks if lead and anchor are conflated.
    selection.extendTo('/w/src/main.ts', TREE);
    expect([...selection.paths.get()]).toEqual(['/w/src', '/w/src/main.ts']);
  });

  it('leaves the anchor put while the lead moves', () => {
    selection.extendTo('/w/src/util.ts', TREE);
    expect(selection.anchor.get()).toBe('/w/src');
    expect(selection.lead.get()).toBe('/w/src/util.ts');
  });

  it('falls back to a single selection when an endpoint is out of view', () => {
    selection.set('/w/src/deep/nested.ts');
    // Simulate the anchor's row having been collapsed away.
    selection.extendTo('/w/README.md', ['/w/config', '/w/README.md']);

    expect([...selection.paths.get()]).toEqual(['/w/README.md']);
  });

  it('addRangeTo keeps what was already selected', () => {
    selection.set('/w/config');
    selection.toggle('/w/README.md');
    selection.addRangeTo('/w/src/main.ts', TREE);

    expect(selection.has('/w/config')).toBe(true);
    expect(selection.has('/w/README.md')).toBe(true);
    expect(selection.has('/w/src/main.ts')).toBe(true);
  });
});

describe('select all and collapse', () => {
  it('selects every visible row', () => {
    const selection = new ExplorerSelection();
    selection.selectAll(TREE);
    expect(selection.size).toBe(TREE.length);
  });

  it('does nothing on an empty tree', () => {
    const selection = new ExplorerSelection();
    selection.selectAll([]);
    expect(selection.isEmpty()).toBe(true);
  });

  it('collapses back to the focused row', () => {
    const selection = new ExplorerSelection();
    selection.set('/w/src');
    selection.extendTo('/w/src/deep', TREE);
    selection.collapseToLead();

    expect([...selection.paths.get()]).toEqual(['/w/src/deep']);
  });
});

describe('pruning', () => {
  let selection: ExplorerSelection;
  beforeEach(() => {
    selection = new ExplorerSelection();
    selection.selectAll(TREE);
  });

  it('remove drops the paths and anything beneath them', () => {
    selection.remove(['/w/src']);

    expect(selection.has('/w/src')).toBe(false);
    expect(selection.has('/w/src/main.ts')).toBe(false);
    expect(selection.has('/w/src/deep/nested.ts')).toBe(false);
    expect(selection.has('/w/README.md')).toBe(true);
  });

  it('remove clears the lead when it was removed', () => {
    selection.lead.set('/w/src/main.ts');
    selection.remove(['/w/src']);
    expect(selection.lead.get()).toBeNull();
  });

  it('removeUnder drops descendants but keeps the folder itself', () => {
    selection.removeUnder('/w/src');

    expect(selection.has('/w/src')).toBe(true);
    expect(selection.has('/w/src/main.ts')).toBe(false);
    expect(selection.has('/w/README.md')).toBe(true);
  });

  it('removeUnder pulls a lead inside the folder back onto it', () => {
    selection.lead.set('/w/src/deep/nested.ts');
    selection.removeUnder('/w/src');
    expect(selection.lead.get()).toBe('/w/src');
  });

  it('does not confuse a sibling with a shared prefix', () => {
    const selection2 = new ExplorerSelection();
    selection2.selectAll(['/w/src', '/w/srcodes.ts']);
    selection2.removeUnder('/w/src');

    expect(selection2.has('/w/srcodes.ts')).toBe(true);
  });
});

describe('ordering', () => {
  it('returns the selection in tree order, not click order', () => {
    const selection = new ExplorerSelection();
    selection.set('/w/README.md');
    selection.toggle('/w/config');
    selection.toggle('/w/src/main.ts');

    expect(selection.ordered(TREE)).toEqual(['/w/config', '/w/src/main.ts', '/w/README.md']);
  });

  it('still includes paths that are no longer visible', () => {
    const selection = new ExplorerSelection();
    selection.set('/w/src/deep/nested.ts');
    expect(selection.ordered(['/w/config'])).toEqual(['/w/src/deep/nested.ts']);
  });

  it('is empty when nothing is selected', () => {
    expect(new ExplorerSelection().ordered(TREE)).toEqual([]);
  });
});

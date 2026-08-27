import { describe, expect, it } from 'vitest';
import { PluginDecorationStore } from '../src/services/plugin/decorations';

/**
 * Merging what several plugins asked to have drawn.
 *
 * A linter and a spell checker have no reason to know about each other, so the
 * store merges them — and the merge has to come out in document order, because
 * `RangeSet.of` throws on unsorted input and each plugin only sorted its own.
 */

const DOC = 100;
const mark = (from: number, to: number) => [{ from, to, kind: 'warning' }];

describe('merging', () => {
  it('keeps both plugins and orders the result by position', () => {
    const store = new PluginDecorationStore();
    store.set('linter', 'b1', mark(50, 60), DOC);
    store.set('speller', 'b1', mark(10, 20), DOC);

    expect(store.forBuffer('b1').map((d) => d.from)).toEqual([10, 50]);
  });

  it("replaces one plugin's marks without touching the other's", () => {
    const store = new PluginDecorationStore();
    store.set('linter', 'b1', mark(50, 60), DOC);
    store.set('speller', 'b1', mark(10, 20), DOC);

    store.set('linter', 'b1', mark(70, 80), DOC);

    expect(store.forBuffer('b1').map((d) => d.from)).toEqual([10, 70]);
  });

  it('keeps buffers apart', () => {
    const store = new PluginDecorationStore();
    store.set('linter', 'b1', mark(10, 20), DOC);
    store.set('linter', 'b2', mark(30, 40), DOC);

    expect(store.forBuffer('b1')).toHaveLength(1);
    expect(store.forBuffer('b2')[0]?.from).toBe(30);
  });

  it('reports how many it could not use', () => {
    const store = new PluginDecorationStore();
    // Inverted, so unusable — the plugin is told rather than left guessing.
    expect(store.set('linter', 'b1', [{ from: 60, to: 50, kind: 'error' }], DOC)).toBe(1);
  });

  it('treats an empty list as taking its own marks back', () => {
    const store = new PluginDecorationStore();
    store.set('linter', 'b1', mark(10, 20), DOC);

    store.set('linter', 'b1', [], DOC);

    expect(store.forBuffer('b1')).toEqual([]);
  });
});

describe('who is interested in a buffer', () => {
  it('names only plugins that decorated it', () => {
    const store = new PluginDecorationStore();
    store.set('linter', 'b1', mark(10, 20), DOC);
    store.set('speller', 'b2', mark(10, 20), DOC);

    // This is what stops the change notification becoming an ambient event
    // channel: a plugin that never decorated a buffer is not woken by typing
    // in it.
    expect(store.buffersFor('linter')).toEqual(['b1']);
    expect(store.buffersFor('speller')).toEqual(['b2']);
    expect(store.buffersFor('nobody')).toEqual([]);
  });
});

describe('clearing', () => {
  it('takes back everything one plugin drew, everywhere', () => {
    const store = new PluginDecorationStore();
    store.set('linter', 'b1', mark(10, 20), DOC);
    store.set('linter', 'b2', mark(10, 20), DOC);
    store.set('speller', 'b1', mark(30, 40), DOC);

    store.clearFor('linter');

    // A mark asserting something about the code, left behind by a process
    // that is gone, looks exactly like a live one and nothing is coming to
    // correct it.
    expect(store.forBuffer('b1').map((d) => d.from)).toEqual([30]);
    expect(store.forBuffer('b2')).toEqual([]);
  });

  it('empties one buffer when it closes', () => {
    const store = new PluginDecorationStore();
    store.set('linter', 'b1', mark(10, 20), DOC);

    store.clearBuffer('b1');

    expect(store.forBuffer('b1')).toEqual([]);
  });

  it('bumps the revision only when something actually changed', () => {
    const store = new PluginDecorationStore();
    const before = store.revision.get();

    store.clearFor('never-decorated-anything');

    expect(store.revision.get()).toBe(before);
  });
});

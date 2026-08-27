import { describe, expect, it } from 'vitest';
import { PluginStatusStore, MAX_ITEMS_PER_PLUGIN, MAX_TEXT_LENGTH } from '../src/services/plugin/status';

/**
 * What a plugin may put on the status bar.
 *
 * The bar is a shared surface with no scrollbar, so every rule here is about
 * one plugin not being able to take it over: a cap on how many items it may
 * own, a cap on how long each is, and an ordering it can influence but not
 * seize. None of that is hypothetical politeness — a plugin in a loop is the
 * ordinary way this goes wrong, and the bar is the one piece of chrome that
 * cannot scroll its way out of trouble.
 */

describe('setting an item', () => {
  it('namespaces it, so two plugins cannot claim one id', () => {
    const store = new PluginStatusStore();
    store.set('a', { name: 'count', text: 'A' });
    store.set('b', { name: 'count', text: 'B' });

    expect(store.items.get().map((item) => item.id)).toEqual([
      'plugin.a.count',
      'plugin.b.count',
    ]);
  });

  it('replaces rather than duplicates when set again', () => {
    const store = new PluginStatusStore();
    store.set('a', { name: 'count', text: 'one' });
    store.set('a', { name: 'count', text: 'two' });

    expect(store.items.get()).toHaveLength(1);
    expect(store.items.get()[0]?.text).toBe('two');
  });

  it('does not touch the signal when nothing changed', () => {
    // A plugin that polls and reports the same thing should cost nothing. The
    // bar re-renders on every emission, so an unchanged set that emitted would
    // make a well-behaved poller as expensive as a badly-behaved one.
    const store = new PluginStatusStore();
    store.set('a', { name: 'count', text: 'same' });

    let emissions = 0;
    const stop = store.items.subscribe(() => (emissions += 1));
    emissions = 0;

    store.set('a', { name: 'count', text: 'same' });
    expect(emissions).toBe(0);

    store.set('a', { name: 'count', text: 'different' });
    expect(emissions).toBe(1);

    stop();
  });
});

describe('the caps', () => {
  it('truncates text rather than letting one item fill the bar', () => {
    const store = new PluginStatusStore();
    store.set('a', { name: 'x', text: 'y'.repeat(MAX_TEXT_LENGTH + 50) });

    expect(store.items.get()[0]?.text).toHaveLength(MAX_TEXT_LENGTH);
  });

  it('refuses more items than one plugin may own', () => {
    const store = new PluginStatusStore();
    for (let i = 0; i < MAX_ITEMS_PER_PLUGIN + 5; i++) {
      store.set('a', { name: `item${i}`, text: String(i) });
    }

    expect(store.items.get()).toHaveLength(MAX_ITEMS_PER_PLUGIN);
  });

  it('lets a plugin at the cap still update what it already owns', () => {
    // Refusing the *new* one is right; refusing an update to an existing one
    // would freeze a plugin's bar at whatever it happened to say when it hit
    // the limit.
    const store = new PluginStatusStore();
    for (let i = 0; i < MAX_ITEMS_PER_PLUGIN; i++) {
      store.set('a', { name: `item${i}`, text: 'before' });
    }

    store.set('a', { name: 'item0', text: 'after' });

    expect(store.items.get().find((item) => item.id === 'plugin.a.item0')?.text).toBe('after');
  });
});

describe('ordering', () => {
  it('sorts by priority, then by when it first appeared', () => {
    const store = new PluginStatusStore();
    store.set('a', { name: 'first', text: '1' });
    store.set('a', { name: 'second', text: '2' });
    store.set('a', { name: 'urgent', text: '!', priority: 10 });

    expect(store.items.get().map((item) => item.text)).toEqual(['!', '1', '2']);
  });

  it('keeps its place when an item is updated', () => {
    // Otherwise an item that updates often walks along the bar, and the whole
    // row shifts under the pointer every time it does.
    const store = new PluginStatusStore();
    store.set('a', { name: 'first', text: '1' });
    store.set('a', { name: 'second', text: '2' });
    store.set('a', { name: 'first', text: '1 again' });

    expect(store.items.get().map((item) => item.text)).toEqual(['1 again', '2']);
  });
});

describe('clearing', () => {
  it('removes one item', () => {
    const store = new PluginStatusStore();
    store.set('a', { name: 'x', text: '1' });
    store.set('a', { name: 'y', text: '2' });

    store.clear('a', 'x');

    expect(store.items.get().map((item) => item.id)).toEqual(['plugin.a.y']);
  });

  it('takes everything a plugin owns when it stops, and nothing else', () => {
    // The reason this exists: a plugin that crashed leaves its readout on the
    // bar saying something that stopped being true, and there is nothing left
    // running to correct it.
    const store = new PluginStatusStore();
    store.set('a', { name: 'x', text: '1' });
    store.set('b', { name: 'y', text: '2' });

    store.clearFor('a');

    expect(store.items.get().map((item) => item.id)).toEqual(['plugin.b.y']);
  });

  it('is quiet about an item that was never there', () => {
    const store = new PluginStatusStore();
    expect(() => store.clear('a', 'nope')).not.toThrow();
    expect(store.items.get()).toEqual([]);
  });
});

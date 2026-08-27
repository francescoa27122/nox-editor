import { describe, expect, it } from 'vitest';
import {
  MAX_ROWS,
  MAX_ROW_TEXT,
  PluginPanelStore,
  panelViewId,
} from '../src/services/plugin/panels';

/**
 * What a plugin may put in its panel.
 *
 * Rows, not markup — a plugin is in another process and cannot ship a
 * component, and giving it a way to describe arbitrary DOM would hand it the
 * render loop this architecture exists to keep hold of.
 *
 * The caps are looser than the status bar's because a panel scrolls. They are
 * still caps: a plugin that returns a million rows should cost a truncated
 * list that says so, not a frozen window.
 */

const store = () => new PluginPanelStore();
const rowsOf = (s: PluginPanelStore, id: string) => s.contents.get().get(id)?.rows ?? [];

describe('filling a panel', () => {
  it('is addressed by the same namespacing commands use', () => {
    expect(panelViewId('ruff', 'issues')).toBe('plugin.ruff.issues');
  });

  it('keeps the rows a plugin sent', () => {
    const s = store();
    s.set('demo', 'issues', [{ text: 'One', detail: 'a.ts:1' }]);

    expect(rowsOf(s, 'plugin.demo.issues')).toEqual([{ text: 'One', detail: 'a.ts:1' }]);
  });

  it('carries a command and its argument, for a row that goes somewhere', () => {
    const s = store();
    s.set('demo', 'issues', [{ text: 'Go', command: 'file.open', arg: '/w/a.ts' }]);

    expect(rowsOf(s, 'plugin.demo.issues')[0]).toEqual({
      text: 'Go',
      command: 'file.open',
      arg: '/w/a.ts',
    });
  });

  it('replaces the previous contents rather than appending', () => {
    const s = store();
    s.set('demo', 'issues', [{ text: 'stale' }]);
    s.set('demo', 'issues', [{ text: 'fresh' }]);

    expect(rowsOf(s, 'plugin.demo.issues')).toEqual([{ text: 'fresh' }]);
  });
});

describe('rows it cannot use', () => {
  it('skips one row rather than losing the panel', () => {
    // A plugin that gets one row wrong should not lose the other nine hundred.
    const s = store();
    s.set('demo', 'issues', [{ text: 'good' }, { detail: 'no text' }, 'nope', null]);

    expect(rowsOf(s, 'plugin.demo.issues')).toEqual([{ text: 'good' }]);
  });

  it('survives being handed something that is not a list at all', () => {
    const s = store();
    s.set('demo', 'issues', 'rows please');

    expect(rowsOf(s, 'plugin.demo.issues')).toEqual([]);
  });
});

describe('the caps', () => {
  it('truncates a row that is too long', () => {
    const s = store();
    s.set('demo', 'issues', [{ text: 'x'.repeat(MAX_ROW_TEXT + 100) }]);

    expect(rowsOf(s, 'plugin.demo.issues')[0]?.text).toHaveLength(MAX_ROW_TEXT);
  });

  it('stops at the row cap and counts what it dropped', () => {
    const s = store();
    s.set(
      'demo',
      'issues',
      Array.from({ length: MAX_ROWS + 25 }, (_, i) => ({ text: `row ${i}` })),
    );

    const contents = s.contents.get().get('plugin.demo.issues');
    expect(contents?.rows).toHaveLength(MAX_ROWS);
    // Counted rather than silently cut: a truncated list presented as a
    // complete one is the thing project search's `10000+` exists to avoid.
    expect(contents?.dropped).toBe(25);
  });
});

describe('emptying', () => {
  it('clears one panel', () => {
    const s = store();
    s.set('demo', 'a', [{ text: '1' }]);
    s.set('demo', 'b', [{ text: '2' }]);

    s.clear('demo', 'a');

    expect(s.contents.get().has('plugin.demo.a')).toBe(false);
    expect(s.contents.get().has('plugin.demo.b')).toBe(true);
  });

  it('empties everything one plugin owns and nothing else', () => {
    const s = store();
    s.set('demo', 'a', [{ text: '1' }]);
    s.set('other', 'a', [{ text: '2' }]);

    s.clearFor('demo');

    expect([...s.contents.get().keys()]).toEqual(['plugin.other.a']);
  });

  it('does not confuse a plugin with one whose id starts the same way', () => {
    // `plugin.demo.` rather than `plugin.demo` — otherwise clearing `demo`
    // would take `demo-extra`'s panels with it.
    const s = store();
    s.set('demo', 'a', [{ text: '1' }]);
    s.set('demo-extra', 'a', [{ text: '2' }]);

    s.clearFor('demo');

    expect([...s.contents.get().keys()]).toEqual(['plugin.demo-extra.a']);
  });
});

// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import StatusBar from '../src/ui/StatusBar.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * A plugin's status item, on the actual bar.
 *
 * `tests/plugin-status.test.ts` holds the store to its rules; this checks the
 * one thing a store test cannot — that the bar *draws* them, that a clickable
 * one dispatches, and that they sit **after** everything Nox puts there.
 *
 * That last one is the point rather than a detail. The row is shared and has
 * no scrollbar, so if a plugin's item could appear ahead of Save-all, a plugin
 * arriving mid-session would slide a core control out from under the pointer.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function bar() {
  mounted = mountComponent(StatusBar);
  return mounted;
}

/** The left-hand group, which is where transient items live. */
function leftSide(container: HTMLElement): HTMLElement {
  const side = container.querySelector<HTMLElement>('.side:not(.right)');
  if (!side) throw new Error('the status bar rendered no left-hand side');
  return side;
}

describe('a plugin item', () => {
  it('is drawn with the text the plugin set', async () => {
    const { container, app } = bar();

    app.plugins.status.set('demo', { name: 'state', text: 'Ready' });
    await flush();

    expect(leftSide(container).textContent).toContain('Ready');
  });

  it('shows the tooltip rather than the text when it has one', async () => {
    const { container, app } = bar();

    app.plugins.status.set('demo', { name: 'state', text: 'Ready', tooltip: 'Everything is fine' });
    await flush();

    const item = leftSide(container).querySelector<HTMLElement>('.item.plugin');
    expect(item?.title).toBe('Everything is fine');
  });

  it('is a button only when it has a command to run', async () => {
    const { container, app } = bar();

    app.plugins.status.set('demo', { name: 'inert', text: 'Just a readout' });
    await flush();
    expect(leftSide(container).querySelector('button.item.plugin')).toBeNull();

    app.plugins.status.set('demo', { name: 'live', text: 'Click me', command: 'view.toggleWordWrap' });
    await flush();
    expect(leftSide(container).querySelector('button.item.plugin')).not.toBeNull();
  });

  it('runs its command when clicked', async () => {
    const { container, app } = bar();
    const before = app.config.get('editor.wordWrap');

    app.plugins.status.set('demo', {
      name: 'wrap',
      text: 'Wrap',
      command: 'view.toggleWordWrap',
    });
    await flush();
    leftSide(container).querySelector<HTMLButtonElement>('button.item.plugin')?.click();
    await flush();

    expect(app.config.get('editor.wordWrap')).toBe(!before);
  });

  it('disappears when the item is cleared', async () => {
    const { container, app } = bar();
    app.plugins.status.set('demo', { name: 'state', text: 'Ready' });
    await flush();

    app.plugins.status.clearFor('demo');
    await flush();

    expect(leftSide(container).querySelector('.item.plugin')).toBeNull();
  });
});

describe('where plugin items sit', () => {
  it('comes after everything Nox puts on that side', async () => {
    const { container, app, platform } = bar();

    // A dirty buffer, so a core item is on the bar to be displaced.
    platform.mkdirp('/w');
    platform.seedFile('/w/a.txt', 'one\n');
    await app.workspace.openFolder('/w');
    const id = await app.workspace.open('/w/a.txt');
    if (id) app.workspace.applyEdits(id, [{ from: 0, to: 0, insert: 'edited ' }]);

    app.plugins.status.set('demo', { name: 'state', text: 'PluginReadout' });
    await flush();

    const items = [...leftSide(container).querySelectorAll('.item')];
    const plugin = items.findIndex((node) => node.classList.contains('plugin'));
    const core = items.findIndex((node) => !node.classList.contains('plugin'));

    expect(plugin).toBeGreaterThan(-1);
    expect(core).toBeGreaterThan(-1);
    // Nox's own first, always. A plugin appearing mid-session must not move
    // the controls that were already under the pointer.
    expect(plugin).toBeGreaterThan(core);
  });
});

describe('the mark that says whose item it is', () => {
  /**
   * What this guards: the `::before` on `.item.plugin` shipped with a
   * corrupted glyph. The bytes on disk were C2 82 32, which is U+0082 (a C1
   * control character that paints as nothing) followed by an ASCII "2", so
   * every plugin readout rendered as "2 Ready". Nothing caught it because
   * `tests/plugin-status.test.ts` checks the store and the tests above check
   * the text the plugin set, and a pseudo-element's `content` is in neither.
   *
   * Read from the component's source rather than from the mounted DOM: jsdom
   * does not compute pseudo-elements, so `textContent` of the rendered item
   * never carried the mark, corrupted or not, and a DOM assertion here would
   * have passed before the fix. What this does not catch: a mark that is a
   * legitimate character but the wrong one.
   */
  it('is a real glyph, not a control character or a digit', () => {
    const source = readFileSync('src/ui/StatusBar.svelte', 'utf8');
    const rule = /\.item\.plugin::before\s*\{([^}]*)\}/.exec(source);
    expect(rule, 'the plugin mark rule must exist').not.toBeNull();
    const content = /content:\s*'([^']*)'/.exec(rule![1]!)?.[1];
    expect(content, 'the rule must set `content`').toBeDefined();

    // Decode CSS escapes the way the browser will, so `'\2022'` is judged as
    // the bullet it produces, not as the digits it is written with.
    const decoded = content!.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    );
    const codePoints = [...decoded].map((c) => c.codePointAt(0)!);

    expect(codePoints.length).toBeGreaterThan(0);
    // C0 and C1 controls: they paint as nothing, which is how the corruption hid.
    expect(codePoints.filter((cp) => cp < 0x20 || (cp >= 0x7f && cp <= 0x9f))).toEqual([]);
    expect(decoded).not.toMatch(/[0-9]/);
  });
});

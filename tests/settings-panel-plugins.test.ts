// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { PluginSetting } from '../src/core/plugin-manifest';
import SettingsPanel from '../src/ui/SettingsPanel.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * A plugin's own options, in the Settings panel — see
 * `docs/superpowers/specs/2026-08-28-plugin-settings-design.md` §5.
 *
 * The panel is where a declared setting stops being a line of JSON and becomes
 * something a user can change, so what is tested here is the part that would
 * otherwise be assumed: the section appears under the plugin's name, the
 * control writes through the service, reset comes back, and the tab is absent
 * when there is nothing behind it.
 *
 * Mutation checks (each made the named test red, then reverted):
 * - `void $pluginRevision` dropped from `pluginValues` → "the control shows a
 *   value written through the service".
 * - the `anyPluginSettings` guard on the tab list replaced with `true` → "the
 *   Plugins tab is absent when no plugin declares anything".
 * - `nothingMatches` reduced to the core half → "a search matching only a
 *   plugin setting does not claim there are no matches". The first version of
 *   that test searched for "Markers" and the mutation *survived* it: the
 *   search is a fuzzy subsequence match, so an ordinary word matches core
 *   settings too and `grouped` was never empty. Hence the `Zqjx` fixture.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function settle() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
  flush();
}

const DECLARED: PluginSetting[] = [
  {
    key: 'markers',
    kind: 'string',
    default: 'TODO',
    label: 'Markers',
    description: 'Words to look for.',
  },
  { key: 'loud', kind: 'boolean', default: false, label: 'Loud' },
  /**
   * Deliberately unpronounceable. The search is a fuzzy subsequence match, so
   * an ordinary word like "Markers" also matches half a dozen core settings —
   * which makes it useless for proving the empty-state accounts for plugin
   * rows at all. This label matches nothing in the schema.
   */
  { key: 'zqjx', kind: 'boolean', default: false, label: 'Zqjx' },
];

function rowFor(container: HTMLElement, id: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`.setting[data-plugin-setting="${id}"]`);
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

function tabNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.tab')].map((tab) => tab.textContent?.trim() ?? '');
}

async function setup(declared: PluginSetting[] = DECLARED) {
  mounted = mountComponent(SettingsPanel);
  const { app, container } = mounted;

  /**
   * Before loading anything, and this is not politeness.
   *
   * `NoxApp`'s constructor subscribes to `workspace.rootPath`, and
   * `Signal.subscribe` calls its handler immediately — which reaches
   * `#restartLanguageServers(null)`, which calls `plugins.stopAll()`. That
   * promise settles a few microtasks later and clears every loaded plugin. A
   * `load()` before it lands is silently undone, and the panel then renders
   * correctly over nothing at all.
   */
  await settle();

  // Through the host, so the label comes from where the panel actually reads
  // it: a declaration knows its key and not who owns it.
  app.plugins.load([
    {
      manifest: {
        id: 'todos',
        label: 'Todos',
        entry: { kind: 'worker', file: 'main.js' },
        activation: 'command',
        capabilities: [],
        commands: [],
        panels: [],
        settings: declared,
      },
      directory: '/w/.nox/plugins/todos',
    },
  ]);
  app.pluginSettings.describe([{ id: 'todos', settings: declared }]);
  await settle();

  return { app, container };
}

describe('a plugin’s settings in the panel', () => {
  it('are listed in a section named after the plugin', async () => {
    const { container } = await setup();

    const headings = [...container.querySelectorAll('h3')].map((h) => h.textContent?.trim());
    expect(headings).toContain('Todos');
    expect(rowFor(container, 'todos.markers')).toBeTruthy();
  });

  it('shows the plugin’s own default before anything is set', async () => {
    const { container } = await setup();

    const input = rowFor(container, 'todos.markers').querySelector('input');
    expect((input as HTMLInputElement).value).toBe('TODO');
  });

  it('the control shows a value written through the service', async () => {
    const { app, container } = await setup();

    app.pluginSettings.set('todos', 'markers', 'FIXME');
    await settle();

    const input = rowFor(container, 'todos.markers').querySelector('input');
    expect((input as HTMLInputElement).value).toBe('FIXME');
  });

  it('typing in the control writes through to the service', async () => {
    const { app, container } = await setup();

    const input = rowFor(container, 'todos.markers').querySelector('input') as HTMLInputElement;
    input.value = 'XXX';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(app.pluginSettings.valuesFor('todos').markers).toBe('XXX');
  });

  it('offers a reset only once a value is off its default, and it comes back', async () => {
    const { app, container } = await setup();
    expect(rowFor(container, 'todos.markers').querySelector('.reset')).toBeNull();

    app.pluginSettings.set('todos', 'markers', 'FIXME');
    await settle();

    const reset = rowFor(container, 'todos.markers').querySelector('button.reset');
    expect(reset).not.toBeNull();
    (reset as HTMLButtonElement).click();
    await settle();

    expect(app.pluginSettings.valuesFor('todos').markers).toBe('TODO');
  });

  it('draws a switch for a boolean, the same one core settings get', async () => {
    const { container } = await setup();

    expect(rowFor(container, 'todos.loud').querySelector('[role="switch"]')).not.toBeNull();
  });

  /**
   * §0, made visible. A plugin setting has one layer by construction, so there
   * is nothing for a badge to say and no `inert` state to enter — a row that
   * wore one would be claiming a workspace layer exists.
   */
  it('never wears a workspace badge, because there is no workspace layer', async () => {
    const { container } = await setup();

    expect(rowFor(container, 'todos.markers').querySelector('.badge')).toBeNull();
    expect(rowFor(container, 'todos.markers').querySelector('.control')).not.toHaveProperty(
      'inert',
      true,
    );
  });
});

describe('the Plugins tab', () => {
  it('appears when a loaded plugin declares something', async () => {
    const { container } = await setup();

    expect(tabNames(container)).toContain('Plugins');
  });

  it('is absent when no plugin declares anything', async () => {
    const { container } = await setup([]);

    // Every install until someone ships a plugin with options. A tab that is
    // always empty teaches people to ignore it.
    expect(tabNames(container)).not.toContain('Plugins');
  });

  it('shows only plugin sections when it is the active tab', async () => {
    const { container } = await setup();

    const tab = [...container.querySelectorAll('.tab')].find(
      (candidate) => candidate.textContent?.trim() === 'Plugins',
    );
    (tab as HTMLButtonElement).click();
    await settle();

    const headings = [...container.querySelectorAll('h3')].map((h) => h.textContent?.trim());
    expect(headings).toEqual(['Todos']);
  });
});

describe('searching across both', () => {
  it('a search matching only a plugin setting does not claim there are no matches', async () => {
    const { container } = await setup();

    const search = container.querySelector('.search input') as HTMLInputElement;
    search.value = 'zqjx';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();

    // No core section survives this query, so the empty state is reached
    // entirely through the plugin half of `nothingMatches`.
    expect(container.querySelectorAll('h3')).toHaveLength(1);
    expect(container.querySelector('.nox-empty')).toBeNull();
    expect(rowFor(container, 'todos.zqjx')).toBeTruthy();
  });

  it('still says so when a search matches nothing at all', async () => {
    const { container } = await setup();

    const search = container.querySelector('.search input') as HTMLInputElement;
    search.value = 'zzzzzzzz';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();

    expect(container.querySelector('.nox-empty')).not.toBeNull();
  });
});

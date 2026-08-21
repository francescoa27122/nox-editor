// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import SettingsPanel from '../src/ui/SettingsPanel.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * What the Settings panel does about a project that sets its own values —
 * see `docs/superpowers/specs/2026-08-20-workspace-settings-design.md` §4.
 *
 * The panel deliberately cannot *write* the workspace layer. These tests are
 * the other half of that decision: a row the project owns has to say so and
 * stop offering a control, or the omission reads as a bug.
 *
 * Mutation checks (each made the named test red, then reverted):
 * - `#announceScope` never emitting (the derivation then never re-runs) →
 *   "the badge appears once the project file is loaded". Note the first
 *   attempt at this mutation — deleting a `void $settings` read — *survived*,
 *   which is how the reactivity ended up on its own signal: `settings` stays
 *   quiet when a workspace reload moves no effective value, so a row could
 *   become project-owned with nothing to notice it.
 * - `inert={fromWorkspace}` dropped from the control → "an overridden row's
 *   control is inert".
 * - `update()`'s workspace guard removed → "a change that reaches the handler
 *   anyway is refused, not written".
 * - the footer's folder guard inverted → "the footer offers the file only
 *   with a folder open".
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

function rowFor(container: HTMLElement, key: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`.setting[data-setting="${key}"]`);
  if (!row) throw new Error(`no row for ${key}`);
  return row;
}

async function setup(workspaceJson?: string) {
  mounted = mountComponent(SettingsPanel);
  const { app, platform, container } = mounted;
  platform.seedFile('/w/README.md', '# w\n');
  if (workspaceJson !== undefined) platform.seedFile('/w/.nox/settings.json', workspaceJson);
  await app.workspace.openFolder('/w');
  await app.config.loadWorkspace('/w');
  await settle();
  return { app, platform, container };
}

describe('the settings panel over a project that sets its own values', () => {
  it('the badge appears once the project file is loaded', async () => {
    const { container } = await setup(JSON.stringify({ 'editor.tabSize': 8 }));

    expect(rowFor(container, 'editor.tabSize').querySelector('.badge')).not.toBeNull();
  });

  it('the badge appears even when the project sets the value you already had', async () => {
    // The case that has no `settings` change to ride on: ownership moved, the
    // effective value did not.
    const { container, app, platform } = await setup();
    app.config.set('editor.tabSize', 8);
    platform.seedFile('/w/.nox/settings.json', JSON.stringify({ 'editor.tabSize': 8 }));
    await app.config.loadWorkspace('/w');
    await settle();

    expect(rowFor(container, 'editor.tabSize').querySelector('.badge')).not.toBeNull();
    expect(app.config.get('editor.tabSize')).toBe(8);
  });

  it('an ordinary row keeps its control and has no badge', async () => {
    const { container } = await setup(JSON.stringify({ 'editor.tabSize': 8 }));
    const row = rowFor(container, 'editor.fontSize');

    expect(row.querySelector('.badge')).toBeNull();
    expect(row.querySelector('.control')!.hasAttribute('inert')).toBe(false);
  });

  it("an overridden row's control is inert", async () => {
    const { container } = await setup(JSON.stringify({ 'editor.tabSize': 8 }));
    // The *property*, not the attribute: Svelte sets `inert` as an IDL
    // property and jsdom does not implement `inert`, so it never reflects to
    // an attribute here. A real browser reflects it; jsdom is the odd one.
    const control = rowFor(container, 'editor.tabSize').querySelector('.control') as HTMLElement;

    expect(control.inert).toBe(true);
    expect((rowFor(container, 'editor.fontSize').querySelector('.control') as HTMLElement).inert).toBe(
      false,
    );
  });

  it('a change that reaches the handler anyway is refused, not written', async () => {
    const { container, app } = await setup(JSON.stringify({ 'editor.tabSize': 8 }));
    const input = rowFor(container, 'editor.tabSize').querySelector('input') as HTMLInputElement;

    // `inert` blocks this in a browser; jsdom has no such thing, which makes
    // this the exact scenario the handler's own guard exists for.
    input.value = '5';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    flush();

    expect(app.config.get('editor.tabSize')).toBe(8);
    expect(JSON.parse(app.config.serialize())['editor.tabSize']).toBeUndefined();
  });

  it('an overridden row offers no reset — there is nothing here to reset', async () => {
    const { container, app } = await setup(JSON.stringify({ 'editor.tabSize': 8 }));
    app.config.set('editor.tabSize', 4); // a user value exists, and is shadowed
    await settle();

    expect(rowFor(container, 'editor.tabSize').querySelector('.reset')).toBeNull();
  });

  it('the header counts what the project set, and says nothing when it set nothing', async () => {
    const { container } = await setup(JSON.stringify({ 'editor.tabSize': 8 }));
    const note = (container.querySelector('.ws-note')!.textContent ?? '').replace(/\s+/g, ' ');
    expect(note).toContain('1 setting is set by this project');

    mounted!.unmount();
    mounted = null;

    const plain = await setup();
    expect(plain.container.querySelector('.ws-note')).toBeNull();
    expect(plain.container.querySelector('.badge')).toBeNull();
  });

  it('an unscoped key in the file gets no badge — it was never applied', async () => {
    const { container } = await setup(
      JSON.stringify({ 'terminal.shell': '/tmp/not-your-shell', 'editor.tabSize': 8 }),
    );

    expect(rowFor(container, 'terminal.shell').querySelector('.badge')).toBeNull();
    expect(rowFor(container, 'editor.tabSize').querySelector('.badge')).not.toBeNull();
  });

  it('the footer offers the file only with a folder open', async () => {
    const { container, app } = await setup(JSON.stringify({ 'editor.tabSize': 8 }));
    expect(container.querySelector('.workspace-settings')).not.toBeNull();

    app.workspace.closeFolder();
    await settle();

    expect(container.querySelector('.workspace-settings')).toBeNull();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import Sidebar from '../src/ui/Sidebar.svelte';
import { parseManifest } from '../src/core/plugin-manifest';
import { CAPABILITIES } from '../src/services/permissions';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * A plugin's panel, in the actual sidebar.
 *
 * The store tests hold the rows to their rules; this checks the two things
 * only the real component can answer — that a declared panel gets a rail
 * button **before the plugin has run**, and that the panel body renders rows
 * rather than whatever a plugin might have wished to send.
 *
 * That first one is the whole design of panels. If the button needed running
 * code, every plugin with a panel would have to start at launch, and the lazy
 * activation commands enjoy would have been traded away without anyone
 * choosing to.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function manifest(over: Record<string, unknown> = {}) {
  const parsed = parseManifest(
    {
      id: 'demo',
      label: 'Demo',
      worker: 'main.js',
      panels: [{ name: 'issues', title: 'Issues', icon: 'warning' }],
      ...over,
    },
    new Set<string>(CAPABILITIES),
  );
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.manifest;
}

/** A sidebar with one plugin loaded, nothing started. */
function sidebar(over: Record<string, unknown> = {}) {
  mounted = mountComponent(Sidebar);
  mounted.app.plugins.load([{ manifest: manifest(over), directory: '/w/.nox/plugins/demo' }]);
  return mounted;
}

const railLabels = (container: HTMLElement) =>
  [...container.querySelectorAll('.rail-button')].map((node) => node.getAttribute('title') ?? '');

describe('the rail', () => {
  it('grows a button for a declared panel, with nothing running', async () => {
    const { container } = sidebar();
    await flush();

    expect(railLabels(container).some((label) => label.includes('Issues'))).toBe(true);
  });

  it("puts plugin buttons after Nox's own", async () => {
    const { container } = sidebar();
    await flush();

    const labels = railLabels(container);
    const plugin = labels.findIndex((label) => label.includes('Issues'));
    const explorer = labels.findIndex((label) => label.includes('Explorer'));

    // The rail is Nox's chrome first. A plugin appearing mid-session must not
    // move a button someone is already reaching for.
    expect(plugin).toBeGreaterThan(explorer);
  });

  it('does not grow one for a plugin with no panels', async () => {
    const { container } = sidebar({ panels: [] });
    await flush();

    expect(railLabels(container).some((label) => label.includes('Issues'))).toBe(false);
  });
});

describe('the panel body', () => {
  it('says so plainly when the plugin has sent nothing', async () => {
    const { container, app } = sidebar();
    app.ui.showView('plugin.demo.issues');
    await flush();

    // A plugin with nothing to report and one that has not answered yet look
    // identical from here, so the copy claims neither.
    expect(container.textContent).toContain('Nothing to show');
  });

  it('renders the rows the plugin sent', async () => {
    const { container, app } = sidebar();
    app.plugins.panels.set('demo', 'issues', [
      { text: 'Unused import', detail: 'a.ts:3' },
      { text: 'Missing semicolon', detail: 'b.ts:9' },
    ]);
    app.ui.showView('plugin.demo.issues');
    await flush();

    expect(container.textContent).toContain('Unused import');
    expect(container.textContent).toContain('a.ts:3');
    expect(container.querySelectorAll('.row')).toHaveLength(2);
  });

  it("runs a row's command when it is chosen", async () => {
    const { container, app } = sidebar();
    const before = app.config.get('editor.wordWrap');
    app.plugins.panels.set('demo', 'issues', [
      { text: 'Toggle wrap', command: 'view.toggleWordWrap' },
    ]);
    app.ui.showView('plugin.demo.issues');
    await flush();

    container.querySelector<HTMLButtonElement>('button.row')?.click();
    await flush();

    expect(app.config.get('editor.wordWrap')).toBe(!before);
  });

  it('is inert for a row with no command', async () => {
    const { container, app } = sidebar();
    app.plugins.panels.set('demo', 'issues', [{ text: 'Just a note' }]);
    app.ui.showView('plugin.demo.issues');
    await flush();

    expect(container.querySelector('button.row')).toBeNull();
    expect(container.querySelector('.row.static')).not.toBeNull();
  });

  it('falls back to the explorer when the view names a panel that is gone', async () => {
    const { container, app } = sidebar();
    app.ui.showView('plugin.gone.away');
    await flush();

    // A reload can remove a plugin while its view id is still selected.
    // Rendering a header for something that no longer exists would be worse
    // than showing the panel everything else falls back to.
    expect(container.textContent).not.toContain('Nothing to show');
  });
});

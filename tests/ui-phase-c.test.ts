// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import Sidebar from '../src/ui/Sidebar.svelte';
import StatusBar from '../src/ui/StatusBar.svelte';
import Toasts from '../src/ui/Toasts.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * Phase C of the UI audit — my slice: status-bar problems indicator, the
 * EOL toggle (and the savedEol dirty model behind it), toast actions, and
 * the rail's badge + re-click-collapse.
 *
 * Mutation-checked on 2026-08-19: the indicator test fails when the
 * problems button is removed; the dirty test fails when `isDirty` drops
 * the savedEol comparison; the save test fails when `save` stops
 * recording savedEol; the toast test fails when running an action stops
 * dismissing; the rail tests fail when the badge render or the re-click
 * branch is removed.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function withFile(component: typeof StatusBar    ) {
  mounted = mountComponent(component);
  const { app, platform } = mounted;
  platform.seedFile('/w/a.ts', 'one\ntwo\n');
  await app.workspace.openFolder('/w');
  const id = (await app.workspace.open('/w/a.ts'))!;
  app.workspace.setActive(id);
  flush();
  return { app, platform, id };
}

describe('the status bar', () => {
  it('shows the problems indicator only when there is something to show, and it opens Problems', async () => {
    const { app } = await withFile(StatusBar);
    expect(mounted!.container.querySelector('.item.problems')).toBeNull();

    app.lsp.diagnostics.set(
      new Map([
        [
          'file:///w/a.ts',
          [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'e' },
            { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, severity: 2, message: 'w' },
          ],
        ],
      ]),
    );
    // A4-010: the bar reads `diagnosticsTotals`, a running total the service
    // keeps in step with `diagnostics` itself — poking `diagnostics` directly
    // here, bypassing `#publishDiagnostics`, has to poke this too.
    app.lsp.diagnosticsTotals.set({ errors: 1, warnings: 1, files: 1 });
    flush();

    const button = mounted!.container.querySelector<HTMLElement>('.item.problems');
    expect(button?.textContent?.replace(/\s+/g, '')).toBe('11');

    button!.click();
    await Promise.resolve();
    expect(app.ui.sidebarView.get()).toBe('problems');
  });

  it('switches line endings from the bar, and the buffer knows it is unsaved', async () => {
    const { app, platform, id } = await withFile(StatusBar);
    const eolButton = [...mounted!.container.querySelectorAll<HTMLElement>('button.item')].find(
      (b) => b.textContent?.trim() === 'LF',
    )!;
    expect(eolButton).toBeDefined();
    expect(app.workspace.buffers.get().find((b) => b.id === id)?.isDirty).toBe(false);

    eolButton.click();
    flush();

    const buffer = app.workspace.buffers.get().find((b) => b.id === id)!;
    expect(buffer.eol).toBe('\r\n');
    // No document change happened, but what a save writes changed — that is
    // unsaved work, and the model says so.
    expect(buffer.isDirty).toBe(true);

    await app.workspace.save(id);
    expect(await platform.readTextFile('/w/a.ts')).toBe('one\r\ntwo\r\n');
    expect(app.workspace.buffers.get().find((b) => b.id === id)?.isDirty).toBe(false);
  });
});

describe('toast actions', () => {
  it('renders the action, runs it, and dismisses the toast', async () => {
    mounted = mountComponent(Toasts);
    const { app } = mounted;
    let ran = 0;
    app.notifications.notify('warning', 'changed on disk', {
      actions: [{ label: 'Reload from Disk', run: () => ran++ }],
    });
    flush();

    const button = [...mounted.container.querySelectorAll<HTMLElement>('.nox-button')].find(
      (b) => b.textContent?.trim() === 'Reload from Disk',
    )!;
    expect(button).toBeDefined();
    button.click();
    flush();

    expect(ran).toBe(1);
    expect(app.notifications.items.get()).toHaveLength(0);
  });
});

describe('the rail', () => {
  it('badges the Problems button with the error count', async () => {
    const { app } = await withFile(Sidebar);
    expect(mounted!.container.querySelector('.badge')).toBeNull();

    app.lsp.diagnostics.set(
      new Map([
        [
          'file:///w/a.ts',
          [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'e' }],
        ],
      ]),
    );
    // A4-010: see the same note above — `diagnosticsTotals` is a companion
    // signal now, not derived from `diagnostics` on read.
    app.lsp.diagnosticsTotals.set({ errors: 1, warnings: 0, files: 1 });
    flush();
    expect(mounted!.container.querySelector('.badge')?.textContent?.trim()).toBe('1');
  });

  /**
   * This asserted the opposite until 2026-08-23: re-clicking the active view
   * collapsed the sidebar, following the rail convention. The convention
   * assumes a persistent activity bar, and Nox's rail lives *inside* the aside
   * being collapsed — so a walk found the click removing its own affordance
   * and the other six with it, leaving nothing under the cursor to undo it.
   *
   * Collapsing is still ⌘B and the title-bar button, both of which say so.
   */
  it('keeps the sidebar open when the active view is clicked again', async () => {
    const { app } = await withFile(Sidebar);
    const rail = (label: string) =>
      [...mounted!.container.querySelectorAll<HTMLElement>('.rail-button')].find(
        (b) => b.getAttribute('aria-label') === label,
      )!;
    expect(app.config.get('workbench.showExplorer')).toBe(true);
    expect(app.ui.sidebarView.get()).toBe('explorer');

    rail('Explorer').click();
    flush();
    expect(app.config.get('workbench.showExplorer')).toBe(true);
    expect(app.ui.sidebarView.get()).toBe('explorer');
    // The rail is still there to click, which is the whole point.
    expect(mounted!.container.querySelectorAll('.rail-button').length).toBeGreaterThan(1);

    // Clicking a non-active view still switches.
    rail('Search').click();
    flush();
    expect(app.ui.sidebarView.get()).toBe('search');
    expect(app.config.get('workbench.showExplorer')).toBe(true);
  });
});

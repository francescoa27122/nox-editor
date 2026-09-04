// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import CommandPalette from '../src/ui/CommandPalette.svelte';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * File > Open Recent.
 *
 * Guards A1-006: recent files and folders were recorded and persisted, and
 * the only surfaces were quick-open's empty-query ordering (files) and the
 * Welcome screen (five folders, and only while no tab was open). With a
 * folder open and a tab showing, the recent folders were unreachable.
 * `file.openRecent` opens a picker over both, folders first.
 *
 * Does not catch: the persistence of the two lists (`tests/session.test.ts`)
 * or the Welcome screen's shortlist.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function rowLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.row .label')].map((el) => el.textContent?.trim() ?? '');
}

async function appWithHistory() {
  const platform = new MemoryPlatform();
  platform.seedFile('/one/a.txt', 'a');
  platform.seedFile('/two/b.txt', 'b');
  const app = new NoxApp(platform);
  await app.workspace.openFolder('/one');
  await app.workspace.open('/one/a.txt');
  await app.workspace.openFolder('/two');
  await app.workspace.open('/two/b.txt');
  return { app, platform };
}

describe('file.openRecent', () => {
  it('is a File command that opens the recent picker', async () => {
    const { app } = await appWithHistory();
    expect(app.commands.get('file.openRecent')?.category).toBe('File');

    expect(await app.commands.execute('file.openRecent')).toBe(true);
    expect(app.ui.overlay.get()).toBe('recent');
  });

  it('is disabled until something has been opened', () => {
    const app = new NoxApp(new MemoryPlatform());
    expect(app.commands.get('file.openRecent')?.enabled?.()).toBe(false);
  });

  it('lists recent folders before recent files, most recent first', async () => {
    const { app } = await appWithHistory();
    mounted = mountComponent(CommandPalette, { props: { mode: 'recent' as const }, app });
    flush();

    expect(rowLabels(mounted.container)).toEqual(['two', 'one', 'b.txt', 'a.txt']);
  });

  it('opens a chosen folder as the workspace', async () => {
    const { app } = await appWithHistory();
    mounted = mountComponent(CommandPalette, { props: { mode: 'recent' as const }, app });
    flush();

    const rows = mounted.container.querySelectorAll<HTMLElement>('.row');
    // The second row is `/one`, the folder that is no longer open.
    rows[1]!.click();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(app.workspace.rootPath.get()).toBe('/one');
    expect(app.ui.overlay.get()).toBeNull();
  });

  it('opens a chosen file as a tab', async () => {
    const { app } = await appWithHistory();
    app.workspace.closeAll();
    mounted = mountComponent(CommandPalette, { props: { mode: 'recent' as const }, app });
    flush();

    const rows = mounted.container.querySelectorAll<HTMLElement>('.row');
    rows[3]!.click();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(app.workspace.activeSnapshot()?.path).toBe('/one/a.txt');
  });
});

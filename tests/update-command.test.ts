import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';

let app: NoxApp | null = null;

afterEach(() => {
  app?.updates.stop();
  app = null;
});

describe('app.checkForUpdates', () => {
  it('is registered, and disabled until the service starts', () => {
    app = new NoxApp(new MemoryPlatform());
    expect(app.commands.has('app.checkForUpdates')).toBe(true);
    // MemoryPlatform has selfUpdate: false, so the app did not start it —
    // the git pattern: the capability gates the app, tests start directly.
    expect(app.commands.isEnabled('app.checkForUpdates')).toBe(false);
    app.updates.start();
    expect(app.commands.isEnabled('app.checkForUpdates')).toBe(true);
  });

  it('checks, offers, and the one click installs and relaunches', async () => {
    const platform = new MemoryPlatform();
    platform.seedUpdate({ version: '9.9.9', currentVersion: '0.4.3', notes: null });
    app = new NoxApp(platform);
    app.updates.start();

    await app.commands.execute('app.checkForUpdates');
    const toast = app.notifications.items.get().find((n) => n.message === 'Nox 9.9.9 is available');
    expect(toast).toBeDefined();
    expect(toast!.timeout).toBe(0);
    expect(toast!.actions?.[0]?.label).toBe('Install and Restart');

    toast!.actions![0]!.run();
    await vi.waitFor(() => expect(platform.relaunched).toBe(true));
    expect(platform.installedUpdate).toBe('9.9.9');
  });

  it('a manual miss is answered', async () => {
    app = new NoxApp(new MemoryPlatform());
    app.updates.start();
    await app.commands.execute('app.checkForUpdates');
    expect(app.notifications.items.get()[0]?.message).toBe('No update found');
  });
});

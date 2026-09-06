// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';

/**
 * Reload Window and the processes the renderer started.
 *
 * The failure this prevents: `view.reloadWindow` calling `location.reload()`
 * and nothing else, so the language servers the old page started kept
 * running with nobody reading their stdout, one set per reload, until quit.
 * Two comments claimed the reload ran `dispose()`; it did not. `dispose()` is
 * the one teardown that stops the servers and awaits the flushes, so the
 * command has to run it, and let it finish, before the page goes away.
 *
 * What it does not catch: whether the webview honours an IPC call issued from
 * a page that is already unloading. That is why the reload waits for
 * `dispose()` instead of racing it, and this test holds the order.
 */
class RecordingPlatform extends MemoryPlatform {
  readonly calls: string[] = [];

  override async stopAllLanguageServers(): Promise<void> {
    this.calls.push('stopAllLanguageServers');
  }

  override async reloadWindow(): Promise<void> {
    this.calls.push('reloadWindow');
  }
}

describe('view.reloadWindow', () => {
  it('runs dispose(), servers stopped and flushes done, and only then reloads', async () => {
    const platform = new RecordingPlatform();
    const app = new NoxApp(platform);
    const dispose = vi.spyOn(app, 'dispose');

    await app.commands.execute('view.reloadWindow');

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(platform.calls).toEqual(['stopAllLanguageServers', 'reloadWindow']);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import type { DirEntry } from '../src/platform/types';
import { SessionService } from '../src/services/session';
import { WorkspaceService } from '../src/services/workspace';

/**
 * What a launch with a restored folder costs in directory reads.
 *
 * The failure this prevents: boot walking the project twice. Restoring the
 * session sets `rootPath`, whose subscription starts the tree and the index
 * walk; boot then called `files.setRoot` again itself, and `buildIndex`'s
 * only abort check was a root change, which two walks of the same root both
 * pass. On a 14,000-file tree that was two full `readDir` sweeps competing
 * for the same IPC channel while the user waited for the window.
 *
 * What it does not catch: the real `TauriPlatform` and the real IPC cost.
 * It counts calls, which is the thing that doubled.
 */
class CountingPlatform extends MemoryPlatform {
  readonly reads = new Map<string, number>();

  override async readDir(path: string): Promise<DirEntry[]> {
    this.reads.set(path, (this.reads.get(path) ?? 0) + 1);
    return super.readDir(path);
  }
}

let app: NoxApp | null = null;

afterEach(async () => {
  await app?.dispose();
  app = null;
});

describe('boot with a restored folder', () => {
  it('walks the project once', async () => {
    const platform = new CountingPlatform();
    platform.seedFile('/w/src/a.ts', '');
    platform.seedFile('/w/src/deep/b.ts', '');

    // A previous session that left `/w` open, written the way the app does.
    const previous = new WorkspaceService(platform, () => []);
    const session = new SessionService(platform, previous);
    session.markReady();
    await previous.openFolder('/w');
    await session.save();
    platform.reads.clear();

    app = await NoxApp.create(platform);
    await vi.waitFor(() => expect(app!.files.fileIndex.get()).toContain('/w/src/deep/b.ts'));

    // Only the index walk reads below the root, so a subdirectory's count is
    // the number of walks. The root itself is also read once by the tree.
    expect(platform.reads.get('/w/src')).toBe(1);
    expect(platform.reads.get('/w/src/deep')).toBe(1);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import type { FileStat } from '../src/platform/types';
import { MAX_FILE_BYTES, WorkspaceService } from '../src/services/workspace';

/**
 * The two open-time guards the 2026-09 audit found untested (A1-012).
 *
 * The 64 MB refusal: a regression there would hand a 500 MB file to the
 * renderer with nothing failing. The stat is stubbed rather than a real
 * 64 MB string seeded, because the guard reads the size before the bytes and
 * the point is that the bytes are never read.
 *
 * `workbench.restoreSession = false`: the one boot path that skips the
 * session, which no test had walked. Booted through `NoxApp.create` over a
 * platform whose config files hold a session from a previous app, so the
 * restore that must not happen is a real one.
 */

/** Reports one path as larger than the guard allows, without holding it. */
class HugeFilePlatform extends MemoryPlatform {
  constructor(private readonly huge: string) {
    super();
  }

  override async stat(path: string): Promise<FileStat> {
    const real = await super.stat(path);
    return path === this.huge ? { ...real, size: MAX_FILE_BYTES + 1 } : real;
  }
}

describe('the size guard', () => {
  it('refuses a file over the limit, says so, and never reads it', async () => {
    const platform = new HugeFilePlatform('/w/huge.log');
    platform.seedFile('/w/huge.log', 'small on disk, huge by stat');
    const workspace = new WorkspaceService(platform, () => []);
    const errors: string[] = [];
    workspace.events.on('error', (event) => errors.push(event.message));

    const id = await workspace.open('/w/huge.log');

    expect(id).toBeNull();
    expect(workspace.buffers.get()).toHaveLength(0);
    expect(errors).toEqual(['huge.log is too large to open.']);
  });

  it('opens a file exactly at the limit', async () => {
    const platform = new MemoryPlatform();
    platform.seedFile('/w/edge.txt', 'x');
    const at = { ...(await platform.stat('/w/edge.txt')), size: MAX_FILE_BYTES };
    platform.stat = async () => at;
    const workspace = new WorkspaceService(platform, () => []);

    expect(await workspace.open('/w/edge.txt')).not.toBeNull();
  });
});

describe('workbench.restoreSession', () => {
  let app: NoxApp | null = null;

  afterEach(async () => {
    await app?.dispose();
    app = null;
  });

  /** A platform whose config dir holds a session with a folder and a tab. */
  async function platformWithSession(restore: boolean): Promise<MemoryPlatform> {
    const platform = new MemoryPlatform();
    platform.seedFile('/proj/main.rs', 'fn main() {}');
    const previous = await NoxApp.create(platform);
    await previous.workspace.openFolder('/proj');
    await previous.workspace.open('/proj/main.rs');
    await previous.dispose();
    expect(await platform.readConfigFile('session.json')).toContain('/proj');

    await platform.writeConfigFile(
      'settings.json',
      JSON.stringify({ 'workbench.restoreSession': restore }),
    );
    return platform;
  }

  it('false boots into an empty window and leaves the session on disk', async () => {
    const platform = await platformWithSession(false);
    app = await NoxApp.create(platform);

    expect(app.workspace.rootPath.get()).toBeNull();
    expect(app.workspace.buffers.get()).toHaveLength(0);
  });

  it('true, the default, restores the folder and the tab', async () => {
    const platform = await platformWithSession(true);
    app = await NoxApp.create(platform);

    expect(app.workspace.rootPath.get()).toBe('/proj');
    expect(app.workspace.buffers.get().map((b) => b.path)).toEqual(['/proj/main.rs']);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';

/**
 * A path the OS hands to Nox: `nox notes.txt` on the command line, "Open
 * With" from a file manager, a file dropped on the dock icon.
 *
 * Guards A1-001: the platform reported the path and the app did nothing with
 * it, so a launch with a file argument showed the previous session and not
 * the file. The seam is `Platform.onOpenRequested`, and this drives it
 * through the real boot sequence rather than calling the handler directly,
 * because the defect was the missing wiring, not the handler.
 *
 * Does not catch: the Rust side losing the path before the webview boots
 * (the buffer-and-drain contract in `launch.rs` is covered by its own unit
 * tests for the argv filter only), or a platform whose `onOpenRequested`
 * never fires.
 */

let app: NoxApp | null = null;

afterEach(async () => {
  await app?.dispose();
  app = null;
});

describe('paths handed to Nox by the OS', () => {
  it('opens a file as a tab', async () => {
    const platform = new MemoryPlatform();
    platform.seedFile('/w/notes.txt', 'from the command line');
    app = await NoxApp.create(platform);

    platform.requestOpen(['/w/notes.txt']);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const open = app.workspace.buffers.get().map((b) => b.path);
    expect(open).toContain('/w/notes.txt');
    expect(app.workspace.activeSnapshot()?.path).toBe('/w/notes.txt');
  });

  it('opens a lone folder as the workspace', async () => {
    const platform = new MemoryPlatform();
    platform.seedFile('/proj/src/main.rs', 'fn main() {}');
    app = await NoxApp.create(platform);

    platform.requestOpen(['/proj']);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(app.workspace.rootPath.get()).toBe('/proj');
  });

  it('releases the listener on dispose', async () => {
    const platform = new MemoryPlatform();
    platform.seedFile('/w/late.txt', 'too late');
    app = await NoxApp.create(platform);
    await app.dispose();
    const disposed = app;
    app = null;

    platform.requestOpen(['/w/late.txt']);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(disposed.workspace.buffers.get().map((b) => b.path)).not.toContain('/w/late.txt');
  });
});

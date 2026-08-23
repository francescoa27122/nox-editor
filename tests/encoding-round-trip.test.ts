import { describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import { SessionService } from '../src/services/session';
import { WorkspaceService } from '../src/services/workspace';

/**
 * A file that is not UTF-8, across a restart and across a reopen.
 *
 * 0.8.0 made Nox able to open one. These are the two places it could still
 * lose it afterwards: the session did not record which charset the file had
 * been read as, and the command that changes the charset reloaded over
 * unsaved edits without asking.
 */

/** Seed a file the fake will refuse to read without being told its charset. */
async function seedLegacy(platform: MemoryPlatform, path: string, text: string) {
  platform.mkdirp('/w');
  await platform.writeEncodedFile(path, text, 'windows-1252');
}

describe('a non-UTF-8 file across a restart', () => {
  /**
   * The failure this prevents: `TabRecord` carried no charset, so `restore`
   * reopened every tab as UTF-8 — and `readEncodedFile` refuses anything it
   * cannot prove is UTF-8 or BOM-marked. The tab came back as a "Could not
   * open" toast and then vanished, taking its unsaved backup with it: nothing
   * referenced the file any more, and the next save released it.
   */
  it('comes back, in the charset it was opened as', async () => {
    const platform = new MemoryPlatform();
    await seedLegacy(platform, '/w/legacy.txt', 'naïve café\n');

    const workspace = new WorkspaceService(platform, () => []);
    await workspace.openFolder('/w');
    const id = (await workspace.open('/w/legacy.txt', { encoding: 'windows-1252' }))!;
    expect(workspace.buffers.get().find((b) => b.id === id)?.encoding).toBe('windows-1252');

    const session = new SessionService(platform, workspace);
    session.markReady();
    await session.save();

    const restoredWorkspace = new WorkspaceService(platform, () => []);
    const restoredSession = new SessionService(platform, restoredWorkspace);
    restoredSession.markReady();
    await restoredSession.restore();

    const tabs = restoredWorkspace.buffers.get();
    expect(tabs.map((buffer) => buffer.name)).toEqual(['legacy.txt']);
    expect(tabs[0]!.encoding).toBe('windows-1252');
  });

  /** A UTF-8 file writes no charset at all, so the record does not grow. */
  it('does not record a charset for an ordinary file', async () => {
    const platform = new MemoryPlatform();
    platform.mkdirp('/w');
    platform.seedFile('/w/plain.ts', 'const a = 1;\n');

    const workspace = new WorkspaceService(platform, () => []);
    await workspace.openFolder('/w');
    await workspace.open('/w/plain.ts');

    const session = new SessionService(platform, workspace);
    session.markReady();
    await session.save();

    expect(await platform.readConfigFile('session.json')).not.toContain('encoding');
  });
});

describe('reopening with a different encoding', () => {
  async function appWithDirtyFile() {
    const platform = new MemoryPlatform();
    platform.mkdirp('/w');
    platform.seedFile('/w/a.txt', 'on disk\n');

    const app = new NoxApp(platform);
    await app.workspace.openFolder('/w');
    const id = (await app.workspace.open('/w/a.txt'))!;
    app.workspace.applyTransaction(
      id,
      app.workspace.stateOf(id)!.update({ changes: { from: 0, insert: 'unsaved ' } }),
    );
    expect(app.workspace.buffers.get().find((b) => b.id === id)?.isDirty).toBe(true);
    return { app, id };
  }

  /**
   * Answer each dialog as it appears. `askToConfirm` publishes its request on
   * `ui.confirm` and waits for `resolve`, so a subscriber is the whole stub.
   */
  function answer(app: NoxApp, choices: (string | null)[]): () => void {
    let next = 0;
    return app.ui.confirm.subscribe((request) => {
      if (!request) return;
      const choice = choices[next++] ?? null;
      queueMicrotask(() => request.resolve(choice));
    });
  }

  /**
   * The failure this prevents: `file.revert` asks before discarding unsaved
   * work and this did not — while being reachable by *clicking the encoding
   * label in the status bar*, which reads as inspecting a setting. The reload
   * then marked the buffer clean, so the dirty dot went too and the session
   * released its backup: gone at quit, with only ⌘Z in between.
   */
  it('asks before discarding unsaved edits, and cancelling keeps them', async () => {
    const { app, id } = await appWithDirtyFile();
    // The charset picker, then the discard prompt — cancelled.
    const off = answer(app, ['windows-1252', 'cancel']);

    await app.reopenWithEncoding();
    off();

    expect(app.workspace.textOf(id)).toBe('unsaved on disk\n');
    expect(app.workspace.buffers.get().find((b) => b.id === id)?.isDirty).toBe(true);
    expect(app.workspace.buffers.get().find((b) => b.id === id)?.encoding).toBe('utf-8');
  });

  it('goes ahead when the discard is confirmed', async () => {
    const { app, id } = await appWithDirtyFile();
    const off = answer(app, ['windows-1252', 'reopen']);

    await app.reopenWithEncoding();
    off();

    expect(app.workspace.textOf(id)).toBe('on disk\n');
    expect(app.workspace.buffers.get().find((b) => b.id === id)?.encoding).toBe('windows-1252');
  });

  /** A clean buffer has nothing to lose, so it is not interrupted. */
  it('does not ask when there is nothing unsaved', async () => {
    const platform = new MemoryPlatform();
    platform.mkdirp('/w');
    platform.seedFile('/w/a.txt', 'on disk\n');
    const app = new NoxApp(platform);
    await app.workspace.openFolder('/w');
    const id = (await app.workspace.open('/w/a.txt'))!;

    const seen: string[] = [];
    const off = app.ui.confirm.subscribe((request) => {
      if (!request) return;
      seen.push(request.title);
      queueMicrotask(() => request.resolve('windows-1252'));
    });

    await app.reopenWithEncoding();
    off();

    expect(seen).toEqual(['Reopen a.txt']);
    expect(app.workspace.buffers.get().find((b) => b.id === id)?.encoding).toBe('windows-1252');
  });
});

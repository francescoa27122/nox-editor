import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { SessionService } from '../src/services/session';
import { LARGE_FILE_BYTES, WorkspaceService } from '../src/services/workspace';

/**
 * Unsaved work lives beside `session.json`, not inside it.
 *
 * Version 3 inlined the text, which meant a keystroke in a large dirty file
 * rewrote the whole thing every time the debounce fired — across the IPC
 * boundary, on the typing path.
 */

function setup() {
  const platform = new MemoryPlatform();
  platform.mkdirp('/work');
  platform.seedFile('/work/a.ts', 'const a = 1;\n');
  platform.seedFile('/work/b.md', '# b\n');

  const workspace = new WorkspaceService(platform, () => []);
  const session = new SessionService(platform, workspace);
  session.markReady();
  return { platform, workspace, session };
}

const dirty = (workspace: WorkspaceService, id: string, text: string) =>
  workspace.applyTransaction(
    id,
    workspace.stateOf(id)!.update({ changes: { from: 0, insert: text } }),
  );

const sizeOf = async (platform: MemoryPlatform, name: string) =>
  (await platform.readConfigFile(name))?.length;

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Large files (A4-004) get a slower clock, not a missing backup.
 *
 * Switching the backup off above a size would mean the larger the file the
 * less Nox protects what you typed into it, which is the opposite of what
 * this file exists for. The debounce is trailing either way, so the text
 * still lands once typing stops. What these pin is the wait, and what they
 * do not catch is the cost it is there to save: nothing here measures a
 * write.
 */
describe('the save debounce', () => {
  it('waits longer when a dirty buffer is over the large-file threshold', async () => {
    vi.useFakeTimers();
    const { platform, workspace, session } = setup();
    platform.seedFile('/work/huge.ts', 'x\n'.repeat(LARGE_FILE_BYTES / 2 + 1));
    const id = (await workspace.open('/work/huge.ts'))!;
    dirty(workspace, id, '//\n');
    session.schedule();

    await vi.advanceTimersByTimeAsync(400);
    expect(await platform.readConfigFile('session.json')).toBeNull();

    await vi.advanceTimersByTimeAsync(1_600);
    expect(await platform.readConfigFile('session.json')).not.toBeNull();
  });

  /** The regression: an ordinary session is on the clock it always was. */
  it('keeps the 400 ms wait for buffers under the threshold', async () => {
    vi.useFakeTimers();
    const { platform, workspace, session } = setup();
    const id = (await workspace.open('/work/a.ts'))!;
    dirty(workspace, id, '// x\n');
    session.schedule();

    await vi.advanceTimersByTimeAsync(400);
    expect(await platform.readConfigFile('session.json')).not.toBeNull();
  });

  /** A large buffer that is clean carries no text, so it costs nothing. */
  it('keeps the 400 ms wait when the large buffer is not dirty', async () => {
    vi.useFakeTimers();
    const { platform, workspace, session } = setup();
    platform.seedFile('/work/huge.ts', 'x\n'.repeat(LARGE_FILE_BYTES / 2 + 1));
    await workspace.open('/work/huge.ts');
    session.schedule();

    await vi.advanceTimersByTimeAsync(400);
    expect(await platform.readConfigFile('session.json')).not.toBeNull();
  });
});

describe('backups', () => {
  it('keep session.json small however large the buffer is', async () => {
    const { platform, workspace, session } = setup();
    platform.seedFile('/work/big.ts', 'x'.repeat(200_000));
    const id = (await workspace.open('/work/big.ts'))!;
    dirty(workspace, id, '//\n');

    await session.save();

    expect(await sizeOf(platform, 'session.json')).toBeLessThan(2_000);
    expect(await sizeOf(platform, 'unsaved-1.txt')).toBeGreaterThan(200_000);
  });

  it('are not rewritten for a buffer that has not moved', async () => {
    const { platform, workspace, session } = setup();
    const a = (await workspace.open('/work/a.ts'))!;
    const b = (await workspace.open('/work/b.md'))!;
    dirty(workspace, a, '// x\n');
    dirty(workspace, b, '// x\n');
    await session.save();

    const writes: string[] = [];
    const realWrite = platform.writeConfigFile.bind(platform);
    platform.writeConfigFile = async (name: string, contents: string) => {
      writes.push(name);
      return realWrite(name, contents);
    };

    dirty(workspace, a, 'more\n');
    await session.save();

    // Typing in one file must not rewrite another's backup. That is what keeps
    // the save cheap when several large files are open and dirty.
    expect(writes).toContain('session.json');
    expect(writes.filter((name) => name.startsWith('unsaved-'))).toHaveLength(1);
  });

  it('are released once the buffer is saved', async () => {
    const { platform, workspace, session } = setup();
    const id = (await workspace.open('/work/a.ts'))!;
    dirty(workspace, id, '// x\n');
    await session.save();
    expect(await sizeOf(platform, 'unsaved-1.txt')).toBeGreaterThan(0);

    await workspace.save(id);
    await session.save();

    // A stale megabyte sitting in the config directory is its own small bug.
    expect(await sizeOf(platform, 'unsaved-1.txt')).toBe(0);
  });

  it('still restore the unsaved work', async () => {
    const { platform, workspace, session } = setup();
    const id = (await workspace.open('/work/a.ts'))!;
    dirty(workspace, id, 'edited\n');
    await session.save();

    const restored = new WorkspaceService(platform, () => []);
    const restoredSession = new SessionService(platform, restored);
    restoredSession.markReady();
    await restoredSession.restore();

    const buffer = restored.buffers.get()[0]!;
    expect(restored.textOf(buffer.id)).toBe('edited\nconst a = 1;\n');
    expect(buffer.isDirty).toBe(true);
  });

  it('leave the file alone when one has gone missing', async () => {
    const { platform, workspace, session } = setup();
    const id = (await workspace.open('/work/a.ts'))!;
    dirty(workspace, id, 'edited\n');
    await session.save();

    // Someone cleared the config directory, or a write failed silently.
    await platform.writeConfigFile('unsaved-1.txt', '');

    const restored = new WorkspaceService(platform, () => []);
    const restoredSession = new SessionService(platform, restored);
    restoredSession.markReady();
    await restoredSession.restore();

    // Restoring an empty string here would replace the file with nothing,
    // which is the exact opposite of what a backup is for.
    const buffer = restored.buffers.get()[0]!;
    expect(restored.textOf(buffer.id)).toBe('const a = 1;\n');
    expect(buffer.isDirty).toBe(false);
  });

  it('read unsaved work written by an older version', async () => {
    const platform = new MemoryPlatform();
    platform.mkdirp('/work');
    platform.seedFile('/work/a.ts', 'const a = 1;\n');
    // Exactly what version 3 wrote: the text inline.
    await platform.writeConfigFile(
      'session.json',
      JSON.stringify({
        version: 3,
        rootPath: '/work',
        activeGroupIndex: 0,
        recentFiles: [],
        recentFolders: [],
        groups: [
          {
            activeIndex: 0,
            tabs: [
              {
                kind: 'file',
                path: '/work/a.ts',
                unsaved: { content: 'from v3\nconst a = 1;\n', baseMtime: 0 },
              },
              { kind: 'untitled', name: 'Untitled-1', content: 'scratch', languageId: 'plaintext' },
            ],
          },
        ],
      }),
    );

    const workspace = new WorkspaceService(platform, () => []);
    const session = new SessionService(platform, workspace);
    session.markReady();
    expect(await session.restore()).toBe(true);

    // Upgrading must not be the thing that loses someone's unsaved work.
    expect(workspace.textOf(workspace.buffers.get()[0]!.id)).toBe('from v3\nconst a = 1;\n');
    expect(workspace.textOf(workspace.buffers.get()[1]!.id)).toBe('scratch');
  });
});

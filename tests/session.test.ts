import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { SessionService } from '../src/services/session';
import { WorkspaceService } from '../src/services/workspace';

/**
 * The production state factory enables multiple selections; a bare `() => []`
 * silently collapses them to one range, which would make the multi-cursor
 * test pass for the wrong reason.
 */
const multiCursorState = () => EditorState.allowMultipleSelections.of(true);

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

describe('SessionService', () => {
  it('round-trips the folder, tabs and active tab', async () => {
    const first = setup();
    await first.workspace.openFolder('/work');
    await first.workspace.open('/work/a.ts');
    const second = (await first.workspace.open('/work/b.md'))!;
    first.workspace.setActive(second);
    await first.session.save();

    const restored = new WorkspaceService(first.platform, () => []);
    const session = new SessionService(first.platform, restored);
    session.markReady();

    expect(await session.restore()).toBe(true);
    expect(restored.rootPath.get()).toBe('/work');
    expect(restored.buffers.get().map((b) => b.name)).toEqual(['a.ts', 'b.md']);
    expect(restored.activeSnapshot()?.name).toBe('b.md');
  });

  it('restores unsaved scratch buffers with their contents', async () => {
    const { platform, workspace, session } = setup();
    const id = workspace.newUntitled();
    workspace.applyTransaction(
      id,
      workspace.stateOf(id)!.update({ changes: { from: 0, insert: 'scratch work' } }),
    );
    await session.save();

    const restored = new WorkspaceService(platform, () => []);
    const restoredSession = new SessionService(platform, restored);
    restoredSession.markReady();
    await restoredSession.restore();

    expect(restored.buffers.get()).toHaveLength(1);
    expect(restored.textOf(restored.buffers.get()[0]!.id)).toBe('scratch work');
  });

  it('restores the active tab when it is not the last one opened', async () => {
    const first = setup();
    first.platform.seedFile('/work/c.txt', 'c\n');
    await first.workspace.openFolder('/work');
    const a = (await first.workspace.open('/work/a.ts'))!;
    await first.workspace.open('/work/b.md');
    await first.workspace.open('/work/c.txt');
    // The first tab, so restoring it cannot be confused with "whichever tab
    // was opened last" — which is exactly what used to happen.
    first.workspace.setActive(a);
    await first.session.save();

    const restored = new WorkspaceService(first.platform, () => []);
    const session = new SessionService(first.platform, restored);
    session.markReady();
    await session.restore();

    expect(restored.activeSnapshot()?.name).toBe('a.ts');
  });

  it('restores unsaved edits to a file buffer', async () => {
    const { platform, workspace, session } = setup();
    const id = (await workspace.open('/work/a.ts'))!;
    workspace.applyTransaction(
      id,
      workspace.stateOf(id)!.update({ changes: { from: 0, insert: 'const edited = 2;\n' } }),
    );
    expect(workspace.get(id)?.isDirty).toBe(true);
    await session.save();

    const restored = new WorkspaceService(platform, () => []);
    const restoredSession = new SessionService(platform, restored);
    restoredSession.markReady();
    await restoredSession.restore();

    const buffer = restored.buffers.get()[0]!;
    expect(restored.textOf(buffer.id)).toBe('const edited = 2;\nconst a = 1;\n');
    expect(buffer.isDirty).toBe(true);
    // An untouched file must not come back wearing a conflict warning.
    expect(buffer.externalState).toBe('none');
  });

  it('flags a restored dirty buffer when the file moved on disk meanwhile', async () => {
    const { platform, workspace, session } = setup();
    const id = (await workspace.open('/work/a.ts'))!;
    workspace.applyTransaction(
      id,
      workspace.stateOf(id)!.update({ changes: { from: 0, insert: 'mine\n' } }),
    );
    await session.save();

    // Something else rewrote the file while Nox was closed.
    platform.seedFile('/work/a.ts', 'theirs\n');

    const restored = new WorkspaceService(platform, () => []);
    const restoredSession = new SessionService(platform, restored);
    restoredSession.markReady();
    await restoredSession.restore();

    const buffer = restored.buffers.get()[0]!;
    // The buffer comes back exactly as the user left it — restoring is not a
    // merge, and inventing one would be worse than either side.
    expect(restored.textOf(buffer.id)).toBe('mine\nconst a = 1;\n');
    // Saving over the newer file goes through the existing conflict path
    // rather than silently winning.
    expect(buffer.externalState).toBe('modified');
  });

  it('does not record contents for a clean file buffer', async () => {
    const { platform, workspace, session } = setup();
    await workspace.open('/work/a.ts');
    await session.save();

    const raw = (await platform.readConfigFile('session.json'))!;
    expect(raw).not.toContain('const a = 1;');
  });

  it('round-trips the cursor, including multiple cursors', async () => {
    const platform = new MemoryPlatform();
    platform.mkdirp('/work');
    platform.seedFile('/work/a.ts', 'const a = 1;\n');

    const workspace = new WorkspaceService(platform, multiCursorState);
    const session = new SessionService(platform, workspace);
    session.markReady();

    const id = (await workspace.open('/work/a.ts'))!;
    workspace.setSelection(id, { ranges: [[2, 5], [8, 8]], main: 1 });
    await session.save();

    const restored = new WorkspaceService(platform, multiCursorState);
    const restoredSession = new SessionService(platform, restored);
    restoredSession.markReady();
    await restoredSession.restore();

    const selection = restored.selectionOf(restored.buffers.get()[0]!.id);
    expect(selection).toEqual({ ranges: [[2, 5], [8, 8]], main: 1 });
  });

  it('clamps a restored cursor that is past the end of a shortened file', async () => {
    const { platform, workspace, session } = setup();
    const id = (await workspace.open('/work/a.ts'))!;
    workspace.setSelection(id, { ranges: [[11, 11]], main: 0 });
    await session.save();

    platform.seedFile('/work/a.ts', 'x\n');

    const restored = new WorkspaceService(platform, () => []);
    const restoredSession = new SessionService(platform, restored);
    restoredSession.markReady();
    await restoredSession.restore();

    expect(restored.selectionOf(restored.buffers.get()[0]!.id)).toEqual({
      ranges: [[2, 2]],
      main: 0,
    });
  });

  it('migrates a version 2 session instead of discarding it', async () => {
    const platform = new MemoryPlatform();
    platform.mkdirp('/work');
    platform.seedFile('/work/a.ts', 'const a = 1;\n');
    await platform.writeConfigFile(
      'session.json',
      JSON.stringify({
        version: 2,
        rootPath: '/work',
        groups: [{ tabs: [{ kind: 'file', path: '/work/a.ts' }], activeIndex: 0 }],
        activeGroupIndex: 0,
        recentFiles: [],
        recentFolders: [],
      }),
    );

    const workspace = new WorkspaceService(platform, () => []);
    const session = new SessionService(platform, workspace);
    session.markReady();

    expect(await session.restore()).toBe(true);
    expect(workspace.buffers.get().map((b) => b.name)).toEqual(['a.ts']);
  });

  it('drops empty scratch buffers', async () => {
    const { platform, workspace, session } = setup();
    workspace.newUntitled();
    await session.save();

    const restored = new WorkspaceService(platform, () => []);
    const restoredSession = new SessionService(platform, restored);
    restoredSession.markReady();
    await restoredSession.restore();

    expect(restored.buffers.get()).toHaveLength(0);
  });

  it('skips files that no longer exist', async () => {
    const { platform, workspace, session } = setup();
    await workspace.open('/work/a.ts');
    await workspace.open('/work/b.md');
    await session.save();

    // Simulate the file being deleted between runs.
    const thinner = new MemoryPlatform();
    thinner.mkdirp('/work');
    thinner.seedFile('/work/a.ts', 'const a = 1;\n');
    await thinner.writeConfigFile('session.json', (await platform.readConfigFile('session.json'))!);

    const restored = new WorkspaceService(thinner, () => []);
    const restoredSession = new SessionService(thinner, restored);
    restoredSession.markReady();
    await restoredSession.restore();

    expect(restored.buffers.get().map((b) => b.name)).toEqual(['a.ts']);
  });

  it('ignores a corrupt session file', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile('session.json', 'not json at all');

    const workspace = new WorkspaceService(platform, () => []);
    const session = new SessionService(platform, workspace);
    session.markReady();

    expect(await session.restore()).toBe(false);
  });

  it('ignores a session from a future version', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile('session.json', JSON.stringify({ version: 99, tabs: [] }));

    const workspace = new WorkspaceService(platform, () => []);
    const session = new SessionService(platform, workspace);
    session.markReady();

    expect(await session.restore()).toBe(false);
  });

  it('writes nothing before markReady', async () => {
    const platform = new MemoryPlatform();
    const workspace = new WorkspaceService(platform, () => []);
    const session = new SessionService(platform, workspace);

    // This is the boot race: signals notify on subscribe, so a save can be
    // requested with an empty workspace before restore has run.
    await session.save();
    expect(await platform.readConfigFile('session.json')).toBeNull();
  });
});

import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import type { Encoding } from '../src/core/encoding';
import { MemoryPlatform } from '../src/platform/memory';
import type { EncodedText } from '../src/platform/types';
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

  /**
   * A4-007: restore used to open every tab in a group one at a time, so
   * thirty tabs cost thirty serial IPC round trips before the last of them,
   * active or not, was ready. `#restoreTab` now reads the group's own active
   * tab before starting on the rest of the group at all, which this pins by
   * recording the order `readEncodedFile` is *called* in, not the order the
   * results arrive — the platform resolves near-instantly regardless, so
   * only call order tells the fixed behaviour apart from the old one.
   */
  it('reads the active tab before any other tab in its group', async () => {
    class RecordingPlatform extends MemoryPlatform {
      readonly reads: string[] = [];
      override async readEncodedFile(path: string, encoding?: Encoding): Promise<EncodedText> {
        this.reads.push(path);
        return super.readEncodedFile(path, encoding);
      }
    }

    const platform = new RecordingPlatform();
    platform.mkdirp('/work');
    platform.seedFile('/work/a.ts', 'a\n');
    platform.seedFile('/work/b.md', 'b\n');
    platform.seedFile('/work/c.txt', 'c\n');

    const first = new WorkspaceService(platform, () => []);
    const session = new SessionService(platform, first);
    session.markReady();
    await first.openFolder('/work');
    await first.open('/work/a.ts');
    const active = (await first.open('/work/b.md'))!;
    await first.open('/work/c.txt');
    first.setActive(active);
    await session.save();

    platform.reads.length = 0; // only the restore's own reads matter here

    const restored = new WorkspaceService(platform, () => []);
    const restoredSession = new SessionService(platform, restored);
    restoredSession.markReady();
    await restoredSession.restore();

    expect(platform.reads[0]).toBe('/work/b.md');
  });

  /**
   * The other half of A4-007: reading tabs concurrently is only safe because
   * their final *position* is fixed up afterward. `#insert` (workspace.ts)
   * places a new tab right after whichever one is currently active, so
   * without that fix-up the pane's tab order would end up in whatever order
   * each tab's read happened to resolve in. `MemoryPlatform` resolves near-
   * instantly regardless of call order, so this platform delays reads in
   * *reverse* of the order they were saved in — the one shape guaranteed to
   * disagree with insertion order if the position fix-up is missing.
   */
  it('keeps the session tab order even when files load out of order', async () => {
    class OutOfOrderPlatform extends MemoryPlatform {
      #delayMs = new Map<string, number>();
      delayReadOf(path: string, ms: number): void {
        this.#delayMs.set(path, ms);
      }
      override async readEncodedFile(path: string, encoding?: Encoding): Promise<EncodedText> {
        const ms = this.#delayMs.get(path);
        if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
        return super.readEncodedFile(path, encoding);
      }
    }

    const platform = new OutOfOrderPlatform();
    platform.mkdirp('/work');
    platform.seedFile('/work/a.ts', 'a\n');
    platform.seedFile('/work/b.md', 'b\n');
    platform.seedFile('/work/c.txt', 'c\n');

    const first = new WorkspaceService(platform, () => []);
    const session = new SessionService(platform, first);
    session.markReady();
    await first.openFolder('/work');
    await first.open('/work/a.ts');
    await first.open('/work/b.md');
    await first.open('/work/c.txt');
    await session.save();

    // a.ts, opened (and so saved) first, resolves slowest on restore; c.txt,
    // saved last, resolves fastest — the reverse of the saved order.
    platform.delayReadOf('/work/a.ts', 30);
    platform.delayReadOf('/work/b.md', 15);

    const restored = new WorkspaceService(platform, () => []);
    const restoredSession = new SessionService(platform, restored);
    restoredSession.markReady();
    await restoredSession.restore();

    expect(restored.buffers.get().map((b) => b.name)).toEqual(['a.ts', 'b.md', 'c.txt']);
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

  /**
   * Guards A3-004, first half. A dirty tab whose file vanished between
   * sessions used to be skipped as quietly as a clean one, so the unsaved
   * text was gone from the window with no notice. It comes back the way the
   * watcher keeps such a tab while Nox runs: open, dirty, marked deleted.
   * The second assertion is the same finding's other half: the counter used
   * to restart at 1, so the first save after boot wrote b's text over a's
   * backup, and this holds both backups intact across that save.
   */
  it('restores a dirty tab whose file vanished, marked deleted, and keeps its backup', async () => {
    const { platform, workspace, session } = setup();
    const a = (await workspace.open('/work/a.ts'))!;
    const b = (await workspace.open('/work/b.md'))!;
    workspace.applyTransaction(
      a,
      workspace.stateOf(a)!.update({ changes: { from: 0, insert: 'UNSAVED-A ' } }),
    );
    workspace.applyTransaction(
      b,
      workspace.stateOf(b)!.update({ changes: { from: 0, insert: 'UNSAVED-B ' } }),
    );
    await session.save();
    expect(await platform.readConfigFile('unsaved-1.txt')).toBe('UNSAVED-A const a = 1;\n');

    // A branch switch removed the file before the next launch.
    await platform.trash('/work/a.ts');

    const restored = new WorkspaceService(platform, () => []);
    const restoredSession = new SessionService(platform, restored);
    restoredSession.markReady();
    await restoredSession.restore();

    const tabs = restored.buffers.get();
    expect(tabs.map((tab) => tab.name)).toEqual(['a.ts', 'b.md']);
    const restoredA = tabs[0]!;
    expect(restored.textOf(restoredA.id)).toBe('UNSAVED-A const a = 1;\n');
    expect(restoredA.isDirty).toBe(true);
    expect(restoredA.externalState).toBe('deleted');
    expect(restoredA.path).toBe('/work/a.ts');

    // The first save after boot, with no edit: neither backup may change hands.
    await restoredSession.save();
    expect(await platform.readConfigFile('unsaved-1.txt')).toBe('UNSAVED-A const a = 1;\n');
    expect(await platform.readConfigFile('unsaved-2.txt')).toBe('UNSAVED-B # b\n');
  });

  /**
   * The counter half of A3-004 on its own: a tab the restore cannot bring
   * back (file and backup both gone) still leaves its name in the index, and
   * a fresh service must count on from there rather than from 1. Nothing is
   * registered for this tab, so only the seed protects the name.
   */
  it('never reissues a backup name the index already uses', async () => {
    const platform = new MemoryPlatform();
    platform.mkdirp('/work');
    await platform.writeConfigFile(
      'session.json',
      JSON.stringify({
        version: 4,
        rootPath: null,
        groups: [
          {
            tabs: [{ kind: 'file', path: '/work/gone.ts', unsaved: { backup: 'unsaved-7.txt', baseMtime: 0 } }],
            activeIndex: 0,
          },
        ],
        activeGroupIndex: 0,
        recentFiles: [],
        recentFolders: [],
      }),
    );

    const workspace = new WorkspaceService(platform, () => []);
    const session = new SessionService(platform, workspace);
    session.markReady();
    await session.restore();
    expect(workspace.buffers.get()).toHaveLength(0);

    const id = workspace.newUntitled();
    workspace.applyTransaction(
      id,
      workspace.stateOf(id)!.update({ changes: { from: 0, insert: 'scratch' } }),
    );
    await session.save();

    expect(await platform.readConfigFile('unsaved-8.txt')).toBe('scratch');
    expect(await platform.readConfigFile('unsaved-7.txt')).toBeNull();
  });

  /**
   * A restored dirty tab keeps the backup file it had, rather than being
   * issued a new name on the first save after boot. Set up so that reissuing
   * in tab order would *not* land on the old name by luck: `unsaved-1` was
   * released when a.ts was saved, so b.md's backup is `unsaved-2`.
   */
  it('keeps a restored dirty tab on the backup it had', async () => {
    const { platform, workspace, session } = setup();
    const a = (await workspace.open('/work/a.ts'))!;
    workspace.applyTransaction(
      a,
      workspace.stateOf(a)!.update({ changes: { from: 0, insert: 'x' } }),
    );
    await session.save();
    await workspace.save(a);
    const b = (await workspace.open('/work/b.md'))!;
    workspace.applyTransaction(
      b,
      workspace.stateOf(b)!.update({ changes: { from: 0, insert: 'UNSAVED-B ' } }),
    );
    await session.save();
    expect(await platform.readConfigFile('unsaved-1.txt')).toBe('');
    expect(await platform.readConfigFile('unsaved-2.txt')).toBe('UNSAVED-B # b\n');

    const restored = new WorkspaceService(platform, () => []);
    const restoredSession = new SessionService(platform, restored);
    restoredSession.markReady();
    await restoredSession.restore();
    await restoredSession.save();

    expect(await platform.readConfigFile('unsaved-2.txt')).toBe('UNSAVED-B # b\n');
    expect(await platform.readConfigFile('unsaved-1.txt')).toBe('');
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

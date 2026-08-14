import type { TransactionSpec } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { FileTreeService } from '../src/services/filetree';
import { NotificationService } from '../src/services/notifications';
import { FileWatcherService } from '../src/services/watcher';
import { WorkspaceService } from '../src/services/workspace';

/**
 * The watcher is the service most likely to lose someone's work, so these
 * tests are deliberately about the destructive edges: our own writes, dirty
 * buffers, and deletions.
 *
 * `MemoryPlatform.external*` helpers stand in for another program writing to
 * the same disk — they mutate the file *and* emit the watch event, exactly as
 * a real editor would.
 */

async function setup() {
  const platform = new MemoryPlatform();
  platform.seedFile('/w/a.ts', 'const a = 1;\n');
  platform.seedFile('/w/b.ts', 'const b = 2;\n');
  platform.mkdirp('/w/src');

  const workspace = new WorkspaceService(platform, () => []);
  const files = new FileTreeService(platform);
  const notifications = new NotificationService();
  const watcher = new FileWatcherService(platform, workspace, files, notifications);

  await workspace.openFolder('/w');
  await files.setRoot('/w');
  await watcher.start('/w');

  return { platform, workspace, files, notifications, watcher };
}

const edit = (workspace: WorkspaceService, id: string, text: string) => {
  workspace.applyTransaction(
    id,
    workspace.stateOf(id)!.update({ changes: { from: 0, insert: text } }),
  );
};

describe('watch lifecycle', () => {
  it('registers and releases the platform watch', async () => {
    const { platform, watcher } = await setup();
    expect(platform.watcherCount).toBe(1);

    watcher.stop();
    expect(platform.watcherCount).toBe(0);
  });

  it('replaces the watch when the root changes', async () => {
    const { platform, watcher } = await setup();
    platform.mkdirp('/other');
    await watcher.start('/other');

    expect(platform.watcherCount).toBe(1);
    expect(watcher.active.get()).toBe(true);
  });

  it('does nothing when the platform cannot watch', async () => {
    const platform = new MemoryPlatform();
    Object.assign(platform.capabilities, { fileWatching: false });
    platform.seedFile('/w/a.ts', 'x');

    const workspace = new WorkspaceService(platform, () => []);
    const watcher = new FileWatcherService(
      platform,
      workspace,
      new FileTreeService(platform),
      new NotificationService(),
    );
    await watcher.start('/w');

    expect(platform.watcherCount).toBe(0);
    expect(watcher.active.get()).toBe(false);
  });
});

describe('external modification', () => {
  it('silently reloads a clean buffer', async () => {
    const { platform, workspace, watcher } = await setup();
    const id = (await workspace.open('/w/a.ts'))!;

    platform.externalWrite('/w/a.ts', 'const a = 99;\n');
    await watcher.flushNow();

    expect(workspace.textOf(id)).toBe('const a = 99;\n');
    expect(workspace.activeSnapshot()?.isDirty).toBe(false);
    expect(workspace.activeSnapshot()?.externalState).toBe('none');
  });

  it('does not warn the user about a clean reload', async () => {
    const { platform, workspace, notifications, watcher } = await setup();
    await workspace.open('/w/a.ts');

    platform.externalWrite('/w/a.ts', 'const a = 99;\n');
    await watcher.flushNow();

    expect(notifications.items.get()).toHaveLength(0);
  });

  it('never overwrites a dirty buffer', async () => {
    const { platform, workspace, watcher } = await setup();
    const id = (await workspace.open('/w/a.ts'))!;
    edit(workspace, id, 'MY WORK\n');

    platform.externalWrite('/w/a.ts', 'THEIR WORK\n');
    await watcher.flushNow();

    expect(workspace.textOf(id)).toContain('MY WORK');
    expect(workspace.activeSnapshot()?.isDirty).toBe(true);
    expect(workspace.activeSnapshot()?.externalState).toBe('modified');
  });

  it('warns once per buffer, not once per event', async () => {
    const { platform, workspace, notifications, watcher } = await setup();
    const id = (await workspace.open('/w/a.ts'))!;
    edit(workspace, id, 'MY WORK\n');

    platform.externalWrite('/w/a.ts', 'v1\n');
    await watcher.flushNow();
    platform.externalWrite('/w/a.ts', 'v2\n');
    await watcher.flushNow();

    expect(notifications.items.get()).toHaveLength(1);
  });

  it('ignores changes to files that are not open', async () => {
    const { platform, workspace, notifications, watcher } = await setup();
    await workspace.open('/w/a.ts');

    platform.externalWrite('/w/b.ts', 'changed\n');
    await watcher.flushNow();

    expect(notifications.items.get()).toHaveLength(0);
    expect(workspace.buffers.get()).toHaveLength(1);
  });
});

describe('self-inflicted writes', () => {
  it('does not treat a save by Nox as an external change', async () => {
    const { workspace, watcher } = await setup();
    const id = (await workspace.open('/w/a.ts'))!;
    edit(workspace, id, '// mine\n');

    await workspace.save(id);
    await watcher.flushNow();

    expect(workspace.activeSnapshot()?.externalState).toBe('none');
    expect(workspace.activeSnapshot()?.isDirty).toBe(false);
  });

  it('does not warn after saving over a file it had flagged', async () => {
    const { platform, workspace, notifications, watcher } = await setup();
    const id = (await workspace.open('/w/a.ts'))!;
    edit(workspace, id, 'MY WORK\n');

    platform.externalWrite('/w/a.ts', 'THEIR WORK\n');
    await watcher.flushNow();
    expect(notifications.items.get()).toHaveLength(1);

    // Overwriting resolves the conflict; the flag must clear.
    await workspace.save(id);
    await watcher.flushNow();

    expect(workspace.activeSnapshot()?.externalState).toBe('none');
    expect(notifications.items.get()).toHaveLength(1);
  });

  it('treats a save followed by a real external write as external', async () => {
    const { platform, workspace, watcher } = await setup();
    const id = (await workspace.open('/w/a.ts'))!;
    edit(workspace, id, 'mine\n');
    await workspace.save(id);
    await watcher.flushNow();

    edit(workspace, id, 'more\n');
    platform.externalWrite('/w/a.ts', 'theirs\n');
    await watcher.flushNow();

    expect(workspace.activeSnapshot()?.externalState).toBe('modified');
  });
});

describe('external deletion', () => {
  it('marks the buffer and keeps it open', async () => {
    const { platform, workspace, watcher } = await setup();
    const id = (await workspace.open('/w/a.ts'))!;

    platform.externalRemove('/w/a.ts');
    await watcher.flushNow();

    expect(workspace.buffers.get()).toHaveLength(1);
    expect(workspace.activeSnapshot()?.externalState).toBe('deleted');
    // The content is still in memory: nothing has been lost.
    expect(workspace.textOf(id)).toBe('const a = 1;\n');
  });

  it('lets a save recreate the file', async () => {
    const { platform, workspace, watcher } = await setup();
    const id = (await workspace.open('/w/a.ts'))!;

    platform.externalRemove('/w/a.ts');
    await watcher.flushNow();

    expect(await workspace.save(id)).toBe(true);
    expect(await platform.readTextFile('/w/a.ts')).toBe('const a = 1;\n');
    expect(workspace.activeSnapshot()?.externalState).toBe('none');
  });

  it('marks a renamed-away file as deleted', async () => {
    const { platform, workspace, watcher } = await setup();
    await workspace.open('/w/a.ts');

    platform.externalRename('/w/a.ts', '/w/renamed.ts');
    await watcher.flushNow();

    expect(workspace.activeSnapshot()?.externalState).toBe('deleted');
  });
});

describe('tree synchronisation', () => {
  it('picks up a file created outside Nox', async () => {
    const { platform, files, watcher } = await setup();
    expect(files.nodes.get().some((n) => n.name === 'new.ts')).toBe(false);

    platform.externalWrite('/w/new.ts', 'x');
    await watcher.flushNow();

    expect(files.nodes.get().some((n) => n.name === 'new.ts')).toBe(true);
  });

  it('drops a file deleted outside Nox', async () => {
    const { platform, files, watcher } = await setup();
    platform.externalRemove('/w/b.ts');
    await watcher.flushNow();

    expect(files.nodes.get().some((n) => n.name === 'b.ts')).toBe(false);
  });

  it('updates the quick-open index', async () => {
    const { platform, files, watcher } = await setup();
    await files.buildIndex();
    expect(files.fileIndex.get()).not.toContain('/w/late.ts');

    platform.externalWrite('/w/late.ts', 'x');
    await watcher.flushNow();

    expect(files.fileIndex.get()).toContain('/w/late.ts');
  });

  it('does not refresh the tree for a plain modification', async () => {
    const { platform, files, watcher } = await setup();
    platform.seedFile('/w/a.ts', 'seeded');
    const before = files.nodes.get();

    platform.externalWrite('/w/a.ts', 'changed');
    await watcher.flushNow();

    // Same set of names: a content change must not reshape the tree.
    expect(files.nodes.get().map((n) => n.name)).toEqual(before.map((n) => n.name));
  });
});

describe('reload behaviour', () => {
  it('keeps the reload on the undo stack', async () => {
    const { platform, workspace } = await setup();
    const id = (await workspace.open('/w/a.ts'))!;

    platform.externalWrite('/w/a.ts', 'reloaded\n');
    await workspace.reloadFromDisk(id);

    expect(workspace.textOf(id)).toBe('reloaded\n');
    expect(workspace.activeSnapshot()?.isDirty).toBe(false);
  });

  it('is a no-op when the content already matches', async () => {
    const { platform, workspace } = await setup();
    const id = (await workspace.open('/w/a.ts'))!;
    const before = workspace.stateOf(id);

    platform.externalWrite('/w/a.ts', 'const a = 1;\n');
    await workspace.reloadFromDisk(id);

    // Identical content must not push a no-op change onto the undo stack.
    expect(workspace.stateOf(id)).toBe(before);
    expect(workspace.activeSnapshot()?.isDirty).toBe(false);
  });

  it('prefers the live view when one is attached', async () => {
    const { platform, workspace } = await setup();
    const id = (await workspace.open('/w/a.ts'))!;

    const dispatched: string[] = [];
    workspace.addViewDispatcher((bufferId, spec) => {
      if (bufferId !== id) return false;
      dispatched.push(String((spec as TransactionSpec).changes));
      // Simulate the view applying it, as EditorPane does.
      workspace.applyTransaction(id, workspace.stateOf(id)!.update(spec as TransactionSpec));
      return true;
    });

    platform.externalWrite('/w/a.ts', 'via view\n');
    await workspace.reloadFromDisk(id);

    expect(dispatched).toHaveLength(1);
    expect(workspace.textOf(id)).toBe('via view\n');
  });

  it('falls back to the background state for an inactive buffer', async () => {
    const { platform, workspace } = await setup();
    const background = (await workspace.open('/w/a.ts'))!;
    const foreground = (await workspace.open('/w/b.ts'))!;
    workspace.addViewDispatcher((id) => id === foreground);

    platform.externalWrite('/w/a.ts', 'background reload\n');
    await workspace.reloadFromDisk(background);

    expect(workspace.textOf(background)).toBe('background reload\n');
  });
});

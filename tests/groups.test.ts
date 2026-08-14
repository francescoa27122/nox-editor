import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { SessionService } from '../src/services/session';
import { WorkspaceService } from '../src/services/workspace';

/**
 * Editor groups (split panes).
 *
 * The invariant everything rests on: a buffer belongs to exactly one group.
 * That is what keeps `buffer.state` the single source of truth for saving,
 * dirty tracking and replace — so most of these tests are about the layout
 * staying consistent as tabs move, close and take groups with them.
 */

function setup() {
  const platform = new MemoryPlatform();
  platform.seedFile('/w/a.ts', 'a\n');
  platform.seedFile('/w/b.ts', 'b\n');
  platform.seedFile('/w/c.ts', 'c\n');

  const workspace = new WorkspaceService(platform, () => []);
  return { platform, workspace };
}

const layout = (workspace: WorkspaceService) =>
  workspace.groups.get().map((group) => group.tabs.map((tab) => tab.name));

describe('starting state', () => {
  it('has exactly one group', () => {
    const { workspace } = setup();
    expect(workspace.groups.get()).toHaveLength(1);
    expect(workspace.groups.get()[0]!.isActive).toBe(true);
  });

  it('puts newly opened files in the active group', async () => {
    const { workspace } = setup();
    await workspace.open('/w/a.ts');
    await workspace.open('/w/b.ts');

    expect(layout(workspace)).toEqual([['a.ts', 'b.ts']]);
  });
});

describe('splitting', () => {
  it('moves the active tab across when the group has more than one', async () => {
    const { workspace } = setup();
    await workspace.open('/w/a.ts');
    await workspace.open('/w/b.ts');

    workspace.splitEditor();

    expect(layout(workspace)).toEqual([['a.ts'], ['b.ts']]);
    expect(workspace.activeSnapshot()?.name).toBe('b.ts');
  });

  it('creates an empty group when there is only one tab', async () => {
    const { workspace } = setup();
    await workspace.open('/w/a.ts');

    workspace.splitEditor();

    // Moving the only tab would just swap which pane holds it.
    expect(layout(workspace)).toEqual([['a.ts'], []]);
  });

  it('focuses the new group so the next file opens into it', async () => {
    const { workspace } = setup();
    await workspace.open('/w/a.ts');
    workspace.splitEditor();
    await workspace.open('/w/b.ts');

    expect(layout(workspace)).toEqual([['a.ts'], ['b.ts']]);
  });

  it('keeps every buffer reachable through `buffers`', async () => {
    const { workspace } = setup();
    await workspace.open('/w/a.ts');
    await workspace.open('/w/b.ts');
    workspace.splitEditor();

    expect(workspace.buffers.get().map((b) => b.name).sort()).toEqual(['a.ts', 'b.ts']);
  });
});

describe('focus', () => {
  it('cycles between groups and wraps', async () => {
    const { workspace } = setup();
    await workspace.open('/w/a.ts');
    await workspace.open('/w/b.ts');
    workspace.splitEditor();

    const [first, second] = workspace.groups.get().map((group) => group.id);
    expect(workspace.activeGroupId.get()).toBe(second);

    workspace.cycleGroup(1);
    expect(workspace.activeGroupId.get()).toBe(first);
    workspace.cycleGroup(1);
    expect(workspace.activeGroupId.get()).toBe(second);
    workspace.cycleGroup(-1);
    expect(workspace.activeGroupId.get()).toBe(first);
  });

  it('activating a buffer switches to the group holding it', async () => {
    const { workspace } = setup();
    const a = (await workspace.open('/w/a.ts'))!;
    await workspace.open('/w/b.ts');
    workspace.splitEditor();

    const [first] = workspace.groups.get().map((group) => group.id);
    workspace.setActive(a);

    expect(workspace.activeGroupId.get()).toBe(first);
    expect(workspace.activeId.get()).toBe(a);
  });

  it('each group remembers its own active tab', async () => {
    const { workspace } = setup();
    await workspace.open('/w/a.ts');
    await workspace.open('/w/b.ts');
    workspace.splitEditor();
    await workspace.open('/w/c.ts');

    const groups = workspace.groups.get();
    expect(groups[0]!.tabs.map((t) => t.name)).toEqual(['a.ts']);
    expect(groups[1]!.activeId).toBe(groups[1]!.tabs.find((t) => t.name === 'c.ts')?.id);
  });

  it('cycling tabs stays inside the active group', async () => {
    const { workspace } = setup();
    await workspace.open('/w/a.ts');
    await workspace.open('/w/b.ts');
    workspace.splitEditor();
    await workspace.open('/w/c.ts');

    // Second group holds b.ts and c.ts.
    workspace.cycle(1);
    expect(workspace.activeSnapshot()?.name).toBe('b.ts');
    workspace.cycle(1);
    expect(workspace.activeSnapshot()?.name).toBe('c.ts');
  });
});

describe('moving tabs between groups', () => {
  it('moves a tab into another group', async () => {
    const { workspace } = setup();
    const a = (await workspace.open('/w/a.ts'))!;
    await workspace.open('/w/b.ts');
    workspace.splitEditor();

    const [, second] = workspace.groups.get().map((group) => group.id);
    workspace.moveTab(a, 0, second);

    expect(layout(workspace)).toEqual([['a.ts', 'b.ts']]);
  });

  it('folds away a group whose last tab moves out', async () => {
    const { workspace } = setup();
    const a = (await workspace.open('/w/a.ts'))!;
    await workspace.open('/w/b.ts');
    workspace.splitEditor();

    const [, second] = workspace.groups.get().map((group) => group.id);
    workspace.moveTab(a, 0, second);

    expect(workspace.groups.get()).toHaveLength(1);
  });

  it('reorders within a group when no target is given', async () => {
    const { workspace } = setup();
    const a = (await workspace.open('/w/a.ts'))!;
    await workspace.open('/w/b.ts');

    workspace.moveTab(a, 1);
    expect(layout(workspace)).toEqual([['b.ts', 'a.ts']]);
  });

  it('sends the active tab to the next group', async () => {
    const { workspace } = setup();
    await workspace.open('/w/a.ts');
    await workspace.open('/w/b.ts');
    workspace.splitEditor();
    await workspace.open('/w/c.ts');

    workspace.moveActiveToGroup(-1);
    expect(layout(workspace)).toEqual([['a.ts', 'c.ts'], ['b.ts']]);
  });
});

describe('closing', () => {
  it('removes a group when its last tab closes', async () => {
    const { workspace } = setup();
    const a = (await workspace.open('/w/a.ts'))!;
    await workspace.open('/w/b.ts');
    workspace.splitEditor();

    workspace.close(a, { force: true });
    expect(workspace.groups.get()).toHaveLength(1);
    expect(layout(workspace)).toEqual([['b.ts']]);
  });

  it('keeps the last group even when it empties', async () => {
    const { workspace } = setup();
    const a = (await workspace.open('/w/a.ts'))!;
    workspace.close(a, { force: true });

    expect(workspace.groups.get()).toHaveLength(1);
    expect(workspace.groups.get()[0]!.tabs).toHaveLength(0);
  });

  it('closing a group keeps its tabs by folding them into the neighbour', async () => {
    const { workspace } = setup();
    await workspace.open('/w/a.ts');
    await workspace.open('/w/b.ts');
    workspace.splitEditor();

    const second = workspace.groups.get()[1]!.id;
    workspace.closeGroup(second);

    // Nothing is lost — closing a pane is a layout change, not a close-all.
    expect(layout(workspace)).toEqual([['a.ts', 'b.ts']]);
  });

  it('refuses to close the only group', async () => {
    const { workspace } = setup();
    await workspace.open('/w/a.ts');
    expect(workspace.closeGroup(workspace.activeGroupId.get())).toBe(false);
  });

  it('closeAll spans every group', async () => {
    const { workspace } = setup();
    await workspace.open('/w/a.ts');
    await workspace.open('/w/b.ts');
    workspace.splitEditor();

    workspace.closeAll({ force: true });
    expect(workspace.buffers.get()).toHaveLength(0);
    expect(workspace.groups.get()).toHaveLength(1);
  });

  it('closeOthers only affects the group it was asked about', async () => {
    const { workspace } = setup();
    await workspace.open('/w/a.ts');
    await workspace.open('/w/b.ts');
    workspace.splitEditor();
    const c = (await workspace.open('/w/c.ts'))!;

    workspace.closeOthers(c);
    expect(layout(workspace)).toEqual([['a.ts'], ['c.ts']]);
  });
});

describe('session persistence', () => {
  async function persist(workspace: WorkspaceService, platform: MemoryPlatform) {
    const session = new SessionService(platform, workspace);
    session.markReady();
    await session.save();
  }

  it('round-trips a split layout', async () => {
    const { platform, workspace } = setup();
    await workspace.openFolder('/w');
    await workspace.open('/w/a.ts');
    await workspace.open('/w/b.ts');
    workspace.splitEditor();
    await workspace.open('/w/c.ts');
    await persist(workspace, platform);

    const restored = new WorkspaceService(platform, () => []);
    const session = new SessionService(platform, restored);
    session.markReady();
    await session.restore();

    expect(layout(restored)).toEqual([['a.ts'], ['b.ts', 'c.ts']]);
  });

  it('restores which pane was focused', async () => {
    const { platform, workspace } = setup();
    await workspace.openFolder('/w');
    await workspace.open('/w/a.ts');
    await workspace.open('/w/b.ts');
    workspace.splitEditor();
    workspace.cycleGroup(1); // focus the first group
    await persist(workspace, platform);

    const restored = new WorkspaceService(platform, () => []);
    const session = new SessionService(platform, restored);
    session.markReady();
    await session.restore();

    expect(restored.activeSnapshot()?.name).toBe('a.ts');
  });

  it('migrates a version 1 session into a single group', async () => {
    const platform = new MemoryPlatform();
    platform.seedFile('/w/a.ts', 'a\n');
    await platform.writeConfigFile(
      'session.json',
      JSON.stringify({
        version: 1,
        rootPath: '/w',
        tabs: [{ kind: 'file', path: '/w/a.ts' }],
        activeIndex: 0,
        recentFiles: [],
        recentFolders: [],
      }),
    );

    const workspace = new WorkspaceService(platform, () => []);
    const session = new SessionService(platform, workspace);
    session.markReady();

    // Losing your tabs on upgrade is a bad first impression of a new version.
    expect(await session.restore()).toBe(true);
    expect(layout(workspace)).toEqual([['a.ts']]);
  });
});

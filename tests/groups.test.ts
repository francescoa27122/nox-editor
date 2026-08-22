import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { SessionService } from '../src/services/session';
import { WorkspaceService } from '../src/services/workspace';

/**
 * Editor groups (split panes).
 *
 * The invariant everything rests on: **one document, however many tabs show
 * it.** `buffer.state` is the single source of truth for saving, dirty
 * tracking and replace, and a file open in two panes is still one entry in
 * `buffers`, one dirty flag, one undo history.
 *
 * It used to be stronger — a buffer belonged to exactly one group — and the
 * last describe below is what changed, along with the four places that had
 * quietly assumed it.
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

describe('one file in two groups', () => {
  /**
   * The invariant at the top of this file — a buffer belongs to exactly one
   * group — is what these change. Everything below is the machinery that
   * assumed it, found by reading each caller rather than by waiting for a
   * bug report.
   *
   * `buffer.state` stays the single source of truth. Two *tabs* point at one
   * buffer; there is still only one document, one dirty flag and one undo
   * history, which is what keeps saving and replace untouched.
   */

  it('shows the same buffer in both groups', async () => {
    const { workspace } = setup();
    const id = (await workspace.open('/w/a.ts'))!;
    workspace.splitEditor();

    workspace.mirrorInto(workspace.groups.get()[1]!.id, id);

    expect(layout(workspace)).toEqual([['a.ts'], ['a.ts']]);
  });

  /**
   * The failure this prevents: `buffers` is built by flattening every group's
   * tabs, so a mirrored file appeared twice in the app-wide buffer list —
   * once per pane. Anything counting open files, or iterating them to save,
   * would have seen it double.
   */
  it('is still one entry in the app-wide buffer list', async () => {
    const { workspace } = setup();
    const id = (await workspace.open('/w/a.ts'))!;
    workspace.splitEditor();
    workspace.mirrorInto(workspace.groups.get()[1]!.id, id);

    expect(workspace.buffers.get().filter((b) => b.id === id)).toHaveLength(1);
  });

  /**
   * The failure this prevents, and the worst one available here: `close`
   * deleted the buffer from `#map` outright, so closing one of two tabs threw
   * the document away and left the other pane pointing at nothing.
   */
  it('keeps the document when one of the two tabs is closed', async () => {
    const { workspace } = setup();
    const id = (await workspace.open('/w/a.ts'))!;
    workspace.splitEditor();
    const second = workspace.groups.get()[1]!.id;
    workspace.mirrorInto(second, id);

    workspace.close(id, { group: second });

    expect(layout(workspace)).toEqual([['a.ts']]);
    expect(workspace.get(id), 'the document survived').toBeTruthy();
    expect(workspace.stateOf(id)?.doc.toString()).toBe('a\n');
  });

  it('closes the document for good once the last tab goes', async () => {
    const { workspace } = setup();
    const id = (await workspace.open('/w/a.ts'))!;
    workspace.splitEditor();
    const second = workspace.groups.get()[1]!.id;
    workspace.mirrorInto(second, id);

    workspace.close(id, { group: second });
    workspace.close(id, { group: workspace.groups.get()[0]!.id });

    expect(workspace.get(id)).toBeUndefined();
    expect(workspace.buffers.get()).toHaveLength(0);
  });

  /**
   * The failure this prevents: `#groupOf` is `find(...)` — first match wins —
   * so every caller addressed whichever pane happened to come first. Closing
   * the tab in the second pane would have closed the one in the first.
   */
  it('closes the tab in the group it was told, not the first one found', async () => {
    const { workspace } = setup();
    await workspace.open('/w/b.ts');
    const id = (await workspace.open('/w/a.ts'))!;
    // `splitEditor` *moves* the active tab, so a.ts lands in the second group
    // and b.ts stays in the first. Mirroring it back into the first is what
    // puts one file in both.
    workspace.splitEditor();
    const [first, second] = workspace.groups.get();
    workspace.mirrorInto(first!.id, id);

    workspace.close(id, { group: second!.id });

    expect(layout(workspace)).toEqual([['b.ts', 'a.ts']]);
  });

  /** One document means one dirty flag, however many panes show it. */
  it('has one dirty flag for both tabs', async () => {
    const { workspace } = setup();
    const id = (await workspace.open('/w/a.ts'))!;
    workspace.splitEditor();
    workspace.mirrorInto(workspace.groups.get()[1]!.id, id);

    workspace.applyTransaction(id, workspace.stateOf(id)!.update({ changes: { from: 0, insert: 'X' } }));

    const shown = workspace.groups.get().flatMap((g) => g.tabs).filter((t) => t.id === id);
    expect(shown).toHaveLength(2);
    expect(shown.every((t) => t.isDirty)).toBe(true);
  });

  /**
   * The failure this prevents: `#dispatchToView` stopped at the first view
   * that accepted a change. With one file in two panes that updates one and
   * leaves the other showing text that no longer exists — and every reload,
   * grouped undo and agent change set goes through that path, so the stale
   * pane would then compute its next edit against the wrong document.
   *
   * Driven through `reloadFromDisk`, which is the cheapest public route to
   * it. Two fake views stand in for two `EditorPane`s; no DOM is involved.
   */
  it('hands a change to every pane showing the file, not just the first', async () => {
    const { platform, workspace } = setup();
    const id = (await workspace.open('/w/a.ts'))!;
    workspace.splitEditor();
    workspace.mirrorInto(workspace.groups.get()[0]!.id, id);

    const reached: string[] = [];
    workspace.addViewDispatcher((target) => {
      if (target !== id) return false;
      reached.push('pane-one');
      return true;
    });
    workspace.addViewDispatcher((target) => {
      if (target !== id) return false;
      reached.push('pane-two');
      return true;
    });

    platform.seedFile('/w/a.ts', 'changed on disk\n');
    await workspace.reloadFromDisk(id);

    expect(reached).toEqual(['pane-one', 'pane-two']);
  });

  it('refuses to mirror a buffer into the group it is already in', async () => {
    const { workspace } = setup();
    const id = (await workspace.open('/w/a.ts'))!;

    workspace.mirrorInto(workspace.groups.get()[0]!.id, id);

    expect(layout(workspace)).toEqual([['a.ts']]);
  });
});

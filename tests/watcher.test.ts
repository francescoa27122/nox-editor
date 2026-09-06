import { describe, expect, it, vi } from 'vitest';
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

  /**
   * Reads narrower than its name suggests, and deliberately so after
   * measurement: it covers `#onEvent`'s handling of a `modify` event, **not**
   * "a save does not refresh the tree".
   *
   * On the desktop build it frequently does. `MemoryPlatform` emits exactly
   * one event per operation; real `notify` emits several, and on macOS the
   * FSEvents flags are sticky per path — probing this machine, an ordinary
   * in-place rewrite of a file that had been renamed earlier in the session
   * arrived as `Modify(Name(Any))` (classified `rename`) followed by the two
   * `modify` events. `#onEvent` sets `#structureChanged` for any non-`modify`
   * kind, so that save refreshes the tree and reschedules the re-index.
   *
   * That is a real cost worth removing, but the kind alone cannot distinguish
   * a sticky flag from a genuine rename — only re-reading the tree can — so
   * the fix belongs with `FileTreeService`, not here. Left as a handoff rather
   * than half-done; this comment exists so the assertion below is not read as
   * evidence the behaviour is already correct.
   */
  it('does not refresh the tree for an event classified as a modification', async () => {
    const { platform, files, watcher } = await setup();
    platform.seedFile('/w/a.ts', 'seeded');
    const before = files.nodes.get();

    platform.externalWrite('/w/a.ts', 'changed');
    await watcher.flushNow();

    // Same set of names: a content change must not reshape the tree.
    expect(files.nodes.get().map((n) => n.name)).toEqual(before.map((n) => n.name));
  });
});

/**
 * The only tests in this file that drive the timers rather than `flushNow()`.
 * That matters: `flushNow()` bypasses both coalescing timers outright, so
 * before these existed neither `COALESCE_MS` nor the ceiling was exercised by
 * anything, and a debounce that never fired would have passed the whole suite.
 *
 * Fake timers are started *after* `setup()` so the fixture's own async work
 * runs on the real clock.
 */
describe('coalescing', () => {
  /** Counts flushes; `onPathsChanged` fires exactly once per non-empty flush. */
  const counter = (watcher: FileWatcherService) => {
    const count = { flushes: 0 };
    watcher.onPathsChanged(() => {
      count.flushes += 1;
    });
    return count;
  };

  it('flushes on its own once the coalesce window goes quiet', async () => {
    const { platform, watcher } = await setup();
    const count = counter(watcher);

    vi.useFakeTimers();
    try {
      platform.externalWrite('/w/a.ts', 'changed\n');
      // Past COALESCE_MS (180) but far short of the 1000 ms ceiling, so this
      // can only have come from the short timer.
      await vi.advanceTimersByTimeAsync(300);

      expect(count.flushes).toBe(1);
    } finally {
      vi.useRealTimers();
      watcher.stop();
    }
  });

  it('coalesces a burst into a single flush', async () => {
    const { platform, watcher } = await setup();
    const count = counter(watcher);

    vi.useFakeTimers();
    try {
      // The measured shape of an 80-file `git checkout`: 526 events inside a
      // 19 ms span. Bursts were never the problem and must not become one —
      // this is what stops the ceiling from degenerating into "flush often".
      for (let i = 0; i < 526; i += 1) platform.externalWrite(`/w/burst-${i}.ts`, 'x');
      await vi.advanceTimersByTimeAsync(300);

      expect(count.flushes).toBe(1);
    } finally {
      vi.useRealTimers();
      watcher.stop();
    }
  });

  /**
   * Guards the starvation defect. `#onEvent` used to clear and reschedule the
   * coalesce timer on every event with no upper bound, so a stream arriving
   * faster than 180 ms apart deferred the flush for as long as it ran: a
   * measured 6 s codegen storm produced zero flushes. Without a ceiling this
   * reads 0, not "a bit late".
   */
  it('keeps flushing during a sustained write stream', async () => {
    const { platform, watcher } = await setup();
    const count = counter(watcher);

    vi.useFakeTimers();
    try {
      // 6 s of writes 50 ms apart — every gap is inside COALESCE_MS, so the
      // sliding window never gets the idle moment it was waiting for.
      for (let i = 0; i < 120; i += 1) {
        platform.externalWrite(`/w/gen-${i}.ts`, `v${i}`);
        await vi.advanceTimersByTimeAsync(50);
      }

      // One flush per 1000 ms ceiling over 6 s. The upper bound is as
      // load-bearing as the lower one: it is what fails if the ceiling is
      // mistaken for "flush on a 1 s interval regardless of the short timer".
      expect(count.flushes).toBeGreaterThanOrEqual(5);
      expect(count.flushes).toBeLessThanOrEqual(7);
    } finally {
      vi.useRealTimers();
      watcher.stop();
    }
  });

  /**
   * The user-visible reason the ceiling exists. `app.ts`'s save-overwrite
   * dialog is gated on `externalState === 'modified'`, and only a flush ever
   * sets it — so while the flush was starved, ⌘S during a storm overwrote
   * someone else's work with no prompt at all.
   */
  it('marks a buffer changed on disk while a storm is still running', async () => {
    const { platform, workspace, watcher } = await setup();
    const id = (await workspace.open('/w/a.ts'))!;
    edit(workspace, id, 'MY WORK\n');

    vi.useFakeTimers();
    let midStorm: string | null = null;
    try {
      for (let i = 0; i < 60; i += 1) {
        // Someone else edits the open file early on, then the storm buries it.
        if (i === 10) platform.externalWrite('/w/a.ts', 'THEIR WORK\n');
        platform.externalWrite(`/w/gen-${i}.ts`, 'x');
        await vi.advanceTimersByTimeAsync(50);
        // Two seconds in, with 2 s of storm still to come.
        if (i === 40) midStorm = workspace.activeSnapshot()?.externalState ?? null;
      }
    } finally {
      vi.useRealTimers();
      watcher.stop();
    }

    expect(midStorm).toBe('modified');
    expect(workspace.textOf(id)).toContain('MY WORK');
  });

  it('drops both coalescing timers when the watch stops', async () => {
    const { platform, watcher } = await setup();
    const count = counter(watcher);

    vi.useFakeTimers();
    try {
      platform.externalWrite('/w/a.ts', 'changed\n');
      // The short window and the ceiling, both now armed.
      expect(vi.getTimerCount()).toBe(2);

      watcher.stop();

      // Counting flushes is not enough to catch a leak here: `stop()` empties
      // the pending set too, so a timer that survives fires into an empty
      // batch and stays invisible. Asserting nothing is left armed is what
      // actually pins `#clearTimers` down.
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(count.flushes).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

    let dispatched = 0;
    workspace.addViewDispatcher((bufferId, spec) => {
      if (bufferId !== id) return false;
      dispatched += 1;
      // Simulate the view applying it, as EditorPane does.
      workspace.applyTransaction(id, workspace.stateOf(id)!.update(spec));
      return true;
    });

    platform.externalWrite('/w/a.ts', 'via view\n');
    await workspace.reloadFromDisk(id);

    expect(dispatched).toBe(1);
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

describe('overlapping starts', () => {
  /**
   * The failure this prevents: two `start` calls inside one platform round
   * trip registering two watches. The guard at the top of `start` only sees
   * a start that has finished, so the second call ran the whole body again;
   * the first disposer was overwritten and its watch leaked for the life of
   * the window. Boot's `rootPath` subscription is where two can land close
   * together.
   */
  it('registers one watch when two starts overlap', async () => {
    const platform = new MemoryPlatform();
    platform.seedFile('/w/a.ts', 'x');
    const workspace = new WorkspaceService(platform, () => []);
    const watcher = new FileWatcherService(
      platform,
      workspace,
      new FileTreeService(platform),
      new NotificationService(),
    );

    await Promise.all([watcher.start('/w'), watcher.start('/w')]);

    expect(platform.watcherCount).toBe(1);
    expect(watcher.active.get()).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { ConfigService, workspaceConfigPath } from '../src/services/config';
import { FileTreeService } from '../src/services/filetree';
import { NotificationService } from '../src/services/notifications';
import { FileWatcherService } from '../src/services/watcher';
import { WorkspaceService } from '../src/services/workspace';
import { SETTINGS_SCHEMA, WORKSPACE_SETTING_KEYS } from '../src/services/config/schema';

/**
 * `.nox/settings.json` layered over the user's own — see
 * `docs/superpowers/specs/2026-08-20-workspace-settings-design.md`.
 *
 * The load-bearing test in here is the one that names `terminal.shell`: the
 * scope is an allowlist precisely because a workspace file arrives with a
 * cloned repository, and a repository that could name the program your
 * terminal runs would be running code you never chose. If that test ever
 * needs changing, read §0 before changing it.
 *
 * Mutation checks (each made the named test red, then reverted):
 * - `coerceWorkspace` falling back to `coerceAll` (i.e. dropping the scope
 *   filter) → "an unscoped key in the workspace file is ignored".
 * - `#recompute` layering user over workspace instead of the reverse →
 *   "a scoped key in the workspace file beats the user's value".
 * - `loadWorkspace(null)` returning early instead of clearing →
 *   "closing the folder drops the layer".
 * - `#recompute` emitting every key rather than the moved ones →
 *   "changed carries exactly the keys whose effective value moved".
 */

const WS = '/w/.nox/settings.json';

function setup() {
  const platform = new MemoryPlatform();
  const config = new ConfigService(platform);
  return { platform, config };
}

function seedWorkspace(platform: MemoryPlatform, value: unknown): void {
  platform.seedFile(WS, typeof value === 'string' ? value : JSON.stringify(value));
}

describe('the workspace layer', () => {
  it('a scoped key in the workspace file beats the default', async () => {
    const { platform, config } = setup();
    seedWorkspace(platform, { 'editor.tabSize': 8 });
    await config.loadWorkspace('/w');

    expect(config.get('editor.tabSize')).toBe(8);
    expect(config.scopeOf('editor.tabSize')).toBe('workspace');
  });

  it("a scoped key in the workspace file beats the user's value", async () => {
    const { platform, config } = setup();
    config.set('editor.tabSize', 4);
    seedWorkspace(platform, { 'editor.tabSize': 8 });
    await config.loadWorkspace('/w');

    expect(config.get('editor.tabSize')).toBe(8);
  });

  it('an unscoped key in the workspace file is ignored — terminal.shell by name', async () => {
    const { platform, config } = setup();
    const own = config.get('terminal.shell');
    seedWorkspace(platform, { 'terminal.shell': '/tmp/not-your-shell', 'editor.tabSize': 8 });
    await config.loadWorkspace('/w');

    expect(config.get('terminal.shell')).toBe(own);
    expect(config.scopeOf('terminal.shell')).not.toBe('workspace');
    // The scoped key in the same file still applies: one bad entry is dropped,
    // not the file.
    expect(config.get('editor.tabSize')).toBe(8);
  });

  it('the scope list holds only project facts, never a program or a path', () => {
    // A guard on the list itself: adding one of these is the mistake §0 exists
    // to prevent, and it should fail here rather than in a cloned repository.
    for (const key of ['terminal.shell', 'workbench.theme', 'editor.fontFamily'] as const) {
      expect(WORKSPACE_SETTING_KEYS).not.toContain(key);
    }
    expect(WORKSPACE_SETTING_KEYS).toContain('editor.tabSize');
  });

  it('a key that is not in the schema at all is ignored', async () => {
    const { platform, config } = setup();
    seedWorkspace(platform, { 'not.a.setting': true, 'editor.tabSize': 8 });
    await config.loadWorkspace('/w');

    expect(config.get('editor.tabSize')).toBe(8);
    expect(config.workspaceKeys()).toEqual(['editor.tabSize']);
  });

  it('a bad type is coerced, not escaped', async () => {
    const { platform, config } = setup();
    seedWorkspace(platform, { 'editor.tabSize': 'eight' });
    await config.loadWorkspace('/w');

    expect(config.get('editor.tabSize')).toBe(SETTINGS_SCHEMA['editor.tabSize'].default);
  });

  it('a number out of range is clamped', async () => {
    const { platform, config } = setup();
    seedWorkspace(platform, { 'editor.tabSize': 9999 });
    await config.loadWorkspace('/w');

    expect(config.get('editor.tabSize')).toBe(SETTINGS_SCHEMA['editor.tabSize'].max);
  });

  it('a corrupt file leaves the user layer standing', async () => {
    const { platform, config } = setup();
    config.set('editor.tabSize', 4);
    seedWorkspace(platform, '{ not json');
    await config.loadWorkspace('/w');

    expect(config.get('editor.tabSize')).toBe(4);
    expect(config.workspaceKeys()).toEqual([]);
  });

  it('a missing file is not an error', async () => {
    const { config } = setup();
    await config.loadWorkspace('/nowhere');

    expect(config.workspaceKeys()).toEqual([]);
    expect(config.get('editor.tabSize')).toBe(SETTINGS_SCHEMA['editor.tabSize'].default);
  });

  it('closing the folder drops the layer', async () => {
    const { platform, config } = setup();
    config.set('editor.tabSize', 4);
    seedWorkspace(platform, { 'editor.tabSize': 8 });
    await config.loadWorkspace('/w');
    expect(config.get('editor.tabSize')).toBe(8);

    await config.loadWorkspace(null);

    expect(config.get('editor.tabSize')).toBe(4);
    expect(config.scopeOf('editor.tabSize')).toBe('user');
  });

  it('reloading picks the file up again after it changes on disk', async () => {
    const { platform, config } = setup();
    seedWorkspace(platform, { 'editor.tabSize': 8 });
    await config.loadWorkspace('/w');

    seedWorkspace(platform, { 'editor.tabSize': 2 });
    await config.loadWorkspace('/w');

    expect(config.get('editor.tabSize')).toBe(2);
  });

  it('scopeOf reports each of the three layers', async () => {
    const { platform, config } = setup();
    config.set('editor.fontSize', 15);
    seedWorkspace(platform, { 'editor.tabSize': 8 });
    await config.loadWorkspace('/w');

    expect(config.scopeOf('editor.tabSize')).toBe('workspace');
    expect(config.scopeOf('editor.fontSize')).toBe('user');
    expect(config.scopeOf('editor.lineHeight')).toBe('default');
  });
});

describe('writing while a workspace overrides', () => {
  it('set() writes the user layer and the workspace value stands', async () => {
    const { platform, config } = setup();
    seedWorkspace(platform, { 'editor.tabSize': 8 });
    await config.loadWorkspace('/w');

    config.set('editor.tabSize', 3);

    expect(config.get('editor.tabSize')).toBe(8);
    expect(JSON.parse(config.serialize())['editor.tabSize']).toBe(3);
  });

  it('the user value appears once the folder closes', async () => {
    const { platform, config } = setup();
    seedWorkspace(platform, { 'editor.tabSize': 8 });
    await config.loadWorkspace('/w');
    config.set('editor.tabSize', 3);

    await config.loadWorkspace(null);

    expect(config.get('editor.tabSize')).toBe(3);
  });

  it('serialize() writes the user layer, never the workspace one', async () => {
    const { platform, config } = setup();
    seedWorkspace(platform, { 'editor.tabSize': 8, 'files.insertFinalNewline': false });
    await config.loadWorkspace('/w');

    expect(JSON.parse(config.serialize())).toEqual({});
  });

  it('reset() clears the user value without touching the workspace one', async () => {
    const { platform, config } = setup();
    config.set('editor.tabSize', 3);
    seedWorkspace(platform, { 'editor.tabSize': 8 });
    await config.loadWorkspace('/w');

    config.reset('editor.tabSize');

    expect(config.get('editor.tabSize')).toBe(8);
    expect(JSON.parse(config.serialize())['editor.tabSize']).toBeUndefined();
  });

  it('changed carries exactly the keys whose effective value moved', async () => {
    const { platform, config } = setup();
    config.set('editor.tabSize', 3);
    seedWorkspace(platform, { 'editor.tabSize': 8 });
    await config.loadWorkspace('/w');

    const seen: string[][] = [];
    config.changed.subscribe((keys) => seen.push([...keys]));
    seen.length = 0; // the subscribe() call itself replays the current value

    // Effective value is the workspace's 8 either way: nothing moved.
    config.set('editor.tabSize', 5);
    expect(seen).toEqual([]);

    // This one moves.
    config.set('editor.fontSize', 15);
    expect(seen).toEqual([['editor.fontSize']]);
  });
});

describe('the watch, over the real service graph', () => {
  it('an external edit to .nox/settings.json reaches the config', async () => {
    const platform = new MemoryPlatform();
    platform.seedFile('/w/README.md', '# w\n');
    platform.seedFile(WS, JSON.stringify({ 'editor.tabSize': 8 }));

    const workspace = new WorkspaceService(platform, () => []);
    const files = new FileTreeService(platform);
    const config = new ConfigService(platform);
    const watcher = new FileWatcherService(
      platform,
      workspace,
      files,
      new NotificationService(),
    );
    // The one line `app.ts` wires; asserted here rather than trusted there.
    watcher.onPathsChanged((paths) => {
      if (paths.has(workspaceConfigPath('/w'))) void config.loadWorkspace('/w');
    });

    await workspace.openFolder('/w');
    await files.setRoot('/w');
    await watcher.start('/w');
    await config.loadWorkspace('/w');
    expect(config.get('editor.tabSize')).toBe(8);

    platform.externalWrite(WS, JSON.stringify({ 'editor.tabSize': 3 }));
    await watcher.flushNow();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(config.get('editor.tabSize')).toBe(3);
  });

  it('the listener fires with no buffer open — the early return does not swallow it', async () => {
    const platform = new MemoryPlatform();
    platform.seedFile('/w/README.md', '# w\n');
    const workspace = new WorkspaceService(platform, () => []);
    const files = new FileTreeService(platform);
    const watcher = new FileWatcherService(
      platform,
      workspace,
      files,
      new NotificationService(),
    );

    const seen: string[][] = [];
    watcher.onPathsChanged((paths) => seen.push([...paths]));

    await files.setRoot('/w');
    await watcher.start('/w');
    platform.externalWrite('/w/README.md', '# changed\n');
    await watcher.flushNow();

    expect(workspace.fileBuffers()).toHaveLength(0);
    expect(seen.flat()).toContain('/w/README.md');
  });
});

describe('the user layer on its own', () => {
  it('still round-trips through settings.json with no workspace open', async () => {
    const { platform, config } = setup();
    config.set('editor.fontSize', 15);
    await config.flush();

    const reborn = new ConfigService(platform);
    await reborn.load();

    expect(reborn.get('editor.fontSize')).toBe(15);
    expect(reborn.scopeOf('editor.fontSize')).toBe('user');
  });
});

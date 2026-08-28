import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginSetting } from '../src/core/plugin-manifest';
import { MemoryPlatform } from '../src/platform/memory';
import {
  PLUGIN_SETTINGS_FILE,
  PluginSettingsService,
} from '../src/services/plugin/settings';

/**
 * A plugin's own options.
 *
 * Two properties carry the weight here and the rest is plumbing:
 *
 * **A namespace belonging to no loaded plugin survives a write.**
 * `ConfigService` drops unknown keys because its schema is complete, so an
 * unknown key there is a stale one. Here "known" means "discovery found it
 * this launch" — so a plugin that failed to parse its manifest this morning,
 * or a folder being renamed during an upgrade, would have its configuration
 * erased by the next unrelated write. That would make a transient failure
 * destructive.
 *
 * **Nothing is workspace-scoped.** Not tested here because there is no code
 * path to test — the service has one layer by construction. See
 * `docs/superpowers/specs/2026-08-28-plugin-settings-design.md` §0.
 *
 * Mutation checks (each made the named test red, then reverted):
 * - the `#unknown` merge dropped from `serialize` → "keeps the values of a
 *   plugin that is not loaded right now".
 * - `set`'s undeclared-key guard replaced with an invented string descriptor →
 *   "refuses a key the plugin never declared". This took three attempts and
 *   both failures are the point: asserting on `valuesFor` cannot catch it (it
 *   reads the declarations, so an undeclared key is invisible either way), and
 *   neither can writing `true`, because the invented descriptor coerces a
 *   boolean back to its own default and stores nothing. Only a *string* value
 *   asserted against `serialize` tells the two implementations apart.
 */

const DECLARED: PluginSetting[] = [
  { key: 'markers', kind: 'string', default: 'TODO', label: 'Markers' },
  { key: 'limit', kind: 'number', default: 50, min: 1, max: 500, label: 'Limit' },
  { key: 'loud', kind: 'boolean', default: false, label: 'Loud' },
  { key: 'level', kind: 'enum', default: 'warn', options: ['off', 'warn'], label: 'Level' },
];

function serviceWith(platform: MemoryPlatform): PluginSettingsService {
  const service = new PluginSettingsService(platform);
  service.describe([{ id: 'todos', settings: DECLARED }]);
  return service;
}

describe('resolving a plugin’s values', () => {
  let platform: MemoryPlatform;

  beforeEach(() => {
    platform = new MemoryPlatform();
  });

  it('fills in every default, so a plugin never handles a missing key', async () => {
    const service = serviceWith(platform);
    await service.load();

    expect(service.valuesFor('todos')).toEqual({
      markers: 'TODO',
      limit: 50,
      loud: false,
      level: 'warn',
    });
  });

  it('returns an empty object for a plugin that declares nothing', async () => {
    const service = serviceWith(platform);
    await service.load();

    expect(service.valuesFor('nobody')).toEqual({});
  });

  it('lets a stored value win over the default', async () => {
    await platform.writeConfigFile(
      PLUGIN_SETTINGS_FILE,
      JSON.stringify({ todos: { markers: 'FIXME' } }),
    );

    const service = serviceWith(platform);
    await service.load();

    expect(service.valuesFor('todos').markers).toBe('FIXME');
    expect(service.valuesFor('todos').limit).toBe(50);
  });

  it('falls back to the default when the stored value is the wrong type', async () => {
    await platform.writeConfigFile(
      PLUGIN_SETTINGS_FILE,
      JSON.stringify({ todos: { limit: 'lots', loud: 'yes' } }),
    );

    const service = serviceWith(platform);
    await service.load();

    expect(service.valuesFor('todos').limit).toBe(50);
    expect(service.valuesFor('todos').loud).toBe(false);
  });

  it('clamps a stored number into the bounds the plugin declared', async () => {
    await platform.writeConfigFile(
      PLUGIN_SETTINGS_FILE,
      JSON.stringify({ todos: { limit: 99999 } }),
    );

    const service = serviceWith(platform);
    await service.load();

    expect(service.valuesFor('todos').limit).toBe(500);
  });

  /**
   * The order boot actually uses. `app.ts` reads the file before discovery
   * runs, so at load time nothing is declared and every namespace is parked as
   * unknown — `describe` has to adopt them back or a plugin's stored values
   * would be preserved in the file and invisible to the plugin.
   *
   * Every other test in this file describes first, which is the order that
   * cannot catch this.
   */
  it('adopts a parked namespace when its plugin is described afterwards', async () => {
    await platform.writeConfigFile(
      PLUGIN_SETTINGS_FILE,
      JSON.stringify({ todos: { markers: 'FIXME' } }),
    );

    const service = new PluginSettingsService(platform);
    await service.load();
    expect(service.valuesFor('todos')).toEqual({});

    service.describe([{ id: 'todos', settings: DECLARED }]);

    expect(service.valuesFor('todos').markers).toBe('FIXME');
    expect(service.isDefault('todos', 'markers')).toBe(false);
  });

  it('ignores a stored key the plugin no longer declares', async () => {
    await platform.writeConfigFile(
      PLUGIN_SETTINGS_FILE,
      JSON.stringify({ todos: { markers: 'X', removedLastVersion: 1 } }),
    );

    const service = serviceWith(platform);
    await service.load();

    expect(service.valuesFor('todos')).not.toHaveProperty('removedLastVersion');
  });
});

describe('writing a value', () => {
  let platform: MemoryPlatform;

  beforeEach(() => {
    platform = new MemoryPlatform();
    vi.useFakeTimers();
  });

  it('coerces on the way in, so a bad write cannot poison the file', async () => {
    const service = serviceWith(platform);
    await service.load();

    service.set('todos', 'limit', 10_000);

    expect(service.valuesFor('todos').limit).toBe(500);
    vi.useRealTimers();
  });

  it('refuses a key the plugin never declared', async () => {
    const service = serviceWith(platform);
    await service.load();

    service.set('todos', 'invented', 'hello');

    // Asserted on the file rather than on `valuesFor`, which reads the
    // declarations and so could never show an undeclared key whether or not
    // one was stored. `serialize` is where a bogus write would actually land.
    // A string, not `true`: an implementation that invented a descriptor for
    // the unknown key would coerce a boolean straight back to that
    // descriptor's default and store nothing, so a boolean here cannot tell
    // the two implementations apart.
    expect(JSON.parse(service.serialize())).toEqual({});
    expect(service.valuesFor('todos')).not.toHaveProperty('invented');
    vi.useRealTimers();
  });

  it('announces which plugin moved, so only that one is told', async () => {
    const service = serviceWith(platform);
    await service.load();

    const seen: string[] = [];
    service.changed.on('changed', (pluginId) => seen.push(pluginId));

    service.set('todos', 'markers', 'FIXME');

    expect(seen).toEqual(['todos']);
    vi.useRealTimers();
  });

  it('says nothing when the value did not actually move', async () => {
    const service = serviceWith(platform);
    await service.load();

    const seen: string[] = [];
    service.changed.on('changed', (pluginId) => seen.push(pluginId));

    service.set('todos', 'markers', 'TODO');

    expect(seen).toEqual([]);
    vi.useRealTimers();
  });

  it('resets a key back to the plugin’s own default', async () => {
    const service = serviceWith(platform);
    await service.load();

    service.set('todos', 'markers', 'FIXME');
    expect(service.isDefault('todos', 'markers')).toBe(false);

    service.reset('todos', 'markers');

    expect(service.valuesFor('todos').markers).toBe('TODO');
    expect(service.isDefault('todos', 'markers')).toBe(true);
    vi.useRealTimers();
  });
});

describe('what reaches the file', () => {
  let platform: MemoryPlatform;

  beforeEach(() => {
    platform = new MemoryPlatform();
  });

  it('writes only what differs from the default', async () => {
    const service = serviceWith(platform);
    await service.load();

    service.set('todos', 'markers', 'FIXME');
    service.set('todos', 'limit', 50);

    expect(JSON.parse(service.serialize())).toEqual({ todos: { markers: 'FIXME' } });
  });

  it('drops a namespace once every one of its values is back to default', async () => {
    const service = serviceWith(platform);
    await service.load();

    service.set('todos', 'markers', 'FIXME');
    service.reset('todos', 'markers');

    expect(JSON.parse(service.serialize())).toEqual({});
  });

  /**
   * The property this file exists to protect. Removing the `#unknown` merge in
   * `serialize` turns this red and leaves every other test in the file green,
   * which is exactly why it is written down.
   */
  it('keeps the values of a plugin that is not loaded right now', async () => {
    await platform.writeConfigFile(
      PLUGIN_SETTINGS_FILE,
      JSON.stringify({ todos: { markers: 'X' }, ruff: { lineLength: 100 } }),
    );

    const service = serviceWith(platform);
    await service.load();

    service.set('todos', 'markers', 'FIXME');

    expect(JSON.parse(service.serialize())).toEqual({
      todos: { markers: 'FIXME' },
      ruff: { lineLength: 100 },
    });
  });

  it('keeps them across a describe that never mentions the plugin again', async () => {
    await platform.writeConfigFile(
      PLUGIN_SETTINGS_FILE,
      JSON.stringify({ ruff: { lineLength: 100 } }),
    );

    const service = serviceWith(platform);
    await service.load();
    // A reload in which `ruff` failed to parse its manifest.
    service.describe([{ id: 'todos', settings: DECLARED }]);

    expect(JSON.parse(service.serialize()).ruff).toEqual({ lineLength: 100 });
  });
});

describe('a file that cannot be read', () => {
  let platform: MemoryPlatform;

  beforeEach(() => {
    platform = new MemoryPlatform();
  });

  it('is not a problem when it is simply absent', async () => {
    const service = serviceWith(platform);
    await service.load();

    expect(service.error.get()).toBeNull();
    expect(service.valuesFor('todos').markers).toBe('TODO');
  });

  it('says so out loud rather than looking like an empty file', async () => {
    await platform.writeConfigFile(PLUGIN_SETTINGS_FILE, '{ "todos": ');

    const service = serviceWith(platform);
    await service.load();

    expect(service.error.get()).not.toBeNull();
  });

  /**
   * The parse failed, so `#unknown` is empty, so the next write produces a
   * file with every other plugin's settings gone. That is the same
   * destructive-transient-failure shape the unknown-namespace rule exists to
   * prevent, arriving by a different door — and the answer is the one
   * `ConfigService` already gives: keep a copy, then let the write land, so
   * changing a setting is never silently discarded.
   */
  it('keeps a copy of a file it could not parse before writing over it', async () => {
    await platform.writeConfigFile(PLUGIN_SETTINGS_FILE, '{ "todos": ');

    const service = serviceWith(platform);
    await service.load();

    const damaged = service.damaged.get();
    expect(damaged?.file).toBe(PLUGIN_SETTINGS_FILE);
    expect(damaged?.copy).toBe('plugin-settings.damaged.json');
    expect(await platform.readConfigFile('plugin-settings.damaged.json')).toBe('{ "todos": ');

    service.set('todos', 'markers', 'FIXME');
    await service.flush();

    expect(JSON.parse((await platform.readConfigFile(PLUGIN_SETTINGS_FILE)) ?? '')).toEqual({
      todos: { markers: 'FIXME' },
    });
  });

  it('treats a file that is not an object as no settings, not as damage', async () => {
    await platform.writeConfigFile(PLUGIN_SETTINGS_FILE, '[]');

    const service = serviceWith(platform);
    await service.load();

    expect(service.valuesFor('todos').markers).toBe('TODO');
  });
});

/**
 * Re-reading after someone else edited the file.
 *
 * The config watcher makes this reachable, and it is the one consumer where a
 * naive reload is unsafe: **Nox writes this file itself**, on a 250 ms
 * debounce, so a reload that could not tell its own write from a stranger's
 * would be at best wasted work and at worst a loop — reload, recompute, save,
 * event, reload.
 *
 * The guard is a **content comparison, not a time window**. A window is a race
 * written down as a constant, and it fails in exactly the case that matters: a
 * real external edit landing inside it is silently dropped. Comparing bytes is
 * deterministic and stays correct under that edit, because such an edit changes
 * the bytes. See `docs/superpowers/specs/2026-08-28-config-watcher-design.md`
 * §2.
 *
 * Mutation checks, one of which corrected the claim rather than the code:
 * - `load` no longer clearing `#values` first → "forgets a namespace deleted
 *   from the file" goes red.
 * - removing the *value* comparison in `reload` → "tells the host which plugin
 *   moved" and "says nothing when a reformatted file holds the same values".
 * - removing the `raw === this.serialize()` byte guard **survived**, and that
 *   is worth knowing: it is a fast path, not the correctness. Reloading Nox's
 *   own file re-derives the same values, so the comparison above catches it
 *   anyway. The byte check earns its place by skipping a parse and a re-adopt
 *   on every 250 ms save while a control is being dragged — not by being the
 *   thing that stops the loop.
 */
describe('reloading after an outside edit', () => {
  let platform: MemoryPlatform;

  beforeEach(() => {
    platform = new MemoryPlatform();
  });

  it('picks up a value someone else wrote', async () => {
    const service = serviceWith(platform);
    await service.load();

    await platform.writeConfigFile(
      PLUGIN_SETTINGS_FILE,
      JSON.stringify({ todos: { markers: 'FIXME' } }),
    );
    await service.reload();

    expect(service.valuesFor('todos').markers).toBe('FIXME');
  });

  it('tells the host which plugin moved, so only that one is woken', async () => {
    const service = serviceWith(platform);
    service.describe([
      { id: 'todos', settings: DECLARED },
      { id: 'other', settings: DECLARED },
    ]);
    await service.load();

    const seen: string[] = [];
    service.changed.on('changed', (pluginId) => seen.push(pluginId));

    await platform.writeConfigFile(
      PLUGIN_SETTINGS_FILE,
      JSON.stringify({ todos: { markers: 'FIXME' } }),
    );
    await service.reload();

    expect(seen).toEqual(['todos']);
  });

  it('says nothing when the file is what Nox itself just wrote', async () => {
    const service = serviceWith(platform);
    await service.load();
    service.set('todos', 'markers', 'FIXME');
    await service.flush();

    const seen: string[] = [];
    service.changed.on('changed', (pluginId) => seen.push(pluginId));
    await service.reload();

    // The event a save of Nox's own making produces. Nothing moved, so nothing
    // is announced and no plugin is woken.
    expect(seen).toEqual([]);
  });

  it('says nothing when a reformatted file holds the same values', async () => {
    // Byte comparison is the cheap first pass, not the only one: someone can
    // reformat the file without changing what it means.
    const service = serviceWith(platform);
    await service.load();
    service.set('todos', 'markers', 'FIXME');
    await service.flush();

    const seen: string[] = [];
    service.changed.on('changed', (pluginId) => seen.push(pluginId));

    await platform.writeConfigFile(
      PLUGIN_SETTINGS_FILE,
      '{"todos":{"markers":"FIXME"}}',
    );
    await service.reload();

    expect(seen).toEqual([]);
    expect(service.valuesFor('todos').markers).toBe('FIXME');
  });

  it('forgets a namespace deleted from the file', async () => {
    const service = serviceWith(platform);
    await service.load();
    service.set('todos', 'markers', 'FIXME');
    await service.flush();

    await platform.writeConfigFile(PLUGIN_SETTINGS_FILE, '{}');
    await service.reload();

    expect(service.valuesFor('todos').markers).toBe('TODO');
    expect(service.isDefault('todos', 'markers')).toBe(true);
  });

  it('still keeps a namespace whose plugin is not loaded', async () => {
    await platform.writeConfigFile(
      PLUGIN_SETTINGS_FILE,
      JSON.stringify({ ruff: { lineLength: 100 } }),
    );
    const service = serviceWith(platform);
    await service.load();

    await platform.writeConfigFile(
      PLUGIN_SETTINGS_FILE,
      JSON.stringify({ ruff: { lineLength: 120 }, todos: { markers: 'X' } }),
    );
    await service.reload();

    expect(JSON.parse(service.serialize()).ruff).toEqual({ lineLength: 120 });
  });

  it('leaves the values alone when the file becomes unreadable', async () => {
    const service = serviceWith(platform);
    await service.load();
    service.set('todos', 'markers', 'FIXME');
    await service.flush();

    await platform.writeConfigFile(PLUGIN_SETTINGS_FILE, '{ "todos": ');
    await service.reload();

    // A half-written file is the ordinary state while someone is typing in
    // another editor. Dropping the working set over it would be the worst
    // moment to do so.
    expect(service.valuesFor('todos').markers).toBe('FIXME');
  });
});

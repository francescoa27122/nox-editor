import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { classifyConfigChange, ConfigWatcherService } from '../src/services/config-watcher';

/**
 * Watching Nox's own configuration folder.
 *
 * Three debt rows said the same thing — `snippets.json`,
 * `plugin-settings.json` and a theme file all needed a Reload command after a
 * hand edit — and all three named one cause: `FileWatcherService` has a single
 * root and it is the workspace.
 *
 * **The rows' implied fix was wrong**, which is why this is a separate service
 * over a separate Platform method rather than a second `watch` call.
 * `nox_watch` holds one watcher and replaces it, so reusing it would have
 * stopped watching the workspace — trading three small gaps for the loss of
 * external-change detection and the save-overwrite dialog. See
 * `docs/superpowers/specs/2026-08-28-config-watcher-design.md` §0.
 *
 * What this service does is deliberately small: watch, coalesce, hand out the
 * set of changed paths. Every decision about what a change *means* stays with
 * the service that owns the file.
 *
 * Mutation checks, and two of them corrected a claim rather than the code:
 * - the coalescing timer replaced with an immediate call → "coalesces a burst
 *   into one notification" goes red.
 * - `stop()` not clearing `#pending` **survived** at first: `stop` also clears
 *   the timer, so the stale batch never flushes anyway. What the clear
 *   actually protects is the *next* watch, and "a batch after a restart holds
 *   only what changed since" is the test that now says so.
 * - `start` not returning early on an unchanged root also **survived**, and so
 *   did removing its `this.stop()`. The two guard the same property
 *   independently, so no single mutation can show it; removing *both* turns
 *   "starting on the same root twice does not open a second watch" red. Worth
 *   writing down rather than quietly claiming a check that never landed.
 */

const CONFIG = '/config';

class ConfigPlatform extends MemoryPlatform {
  override async configDir(): Promise<string | null> {
    return CONFIG;
  }
}

let platform: ConfigPlatform;
let watcher: ConfigWatcherService;

beforeEach(() => {
  vi.useFakeTimers();
  platform = new ConfigPlatform();
  platform.mkdirp(CONFIG);
  watcher = new ConfigWatcherService(platform);
});

afterEach(() => {
  watcher.stop();
  vi.useRealTimers();
});

/** Everything the subscriber saw, as arrays of sorted paths. */
function record(): string[][] {
  const seen: string[][] = [];
  watcher.onChanged((paths) => seen.push([...paths].sort()));
  return seen;
}

describe('starting and stopping', () => {
  it('watches the config directory', async () => {
    await watcher.start();

    expect(platform.watcherCount).toBe(1);
    expect(watcher.active.get()).toBe(true);
  });

  it('starting on the same root twice does not open a second watch', async () => {
    await watcher.start();
    await watcher.start();

    expect(platform.watcherCount).toBe(1);
  });

  it('does nothing at all when the platform has no config directory', async () => {
    // The browser build. Not an error — there is simply nothing to watch.
    const bare = new ConfigWatcherService(new MemoryPlatform());
    await bare.start();

    expect(bare.active.get()).toBe(false);
  });

  it('does nothing when the platform cannot watch files', async () => {
    const unwatchable = new ConfigPlatform();
    Object.defineProperty(unwatchable, 'capabilities', {
      value: { ...unwatchable.capabilities, fileWatching: false },
    });
    const service = new ConfigWatcherService(unwatchable);

    await service.start();

    expect(service.active.get()).toBe(false);
    expect(unwatchable.watcherCount).toBe(0);
  });

  it('releases the watch on stop', async () => {
    await watcher.start();
    watcher.stop();

    expect(platform.watcherCount).toBe(0);
    expect(watcher.active.get()).toBe(false);
  });

  it('survives a platform that refuses to watch', async () => {
    const failing = new ConfigPlatform();
    failing.watchConfig = async () => {
      throw new Error('too many open files');
    };
    const service = new ConfigWatcherService(failing);

    await expect(service.start()).resolves.toBeUndefined();
    expect(service.active.get()).toBe(false);
  });
});

describe('what subscribers are told', () => {
  it('reports the path that changed', async () => {
    await watcher.start();
    const seen = record();

    await platform.externalWrite(`${CONFIG}/snippets.json`, '{}');
    await vi.advanceTimersByTimeAsync(300);

    expect(seen).toEqual([[`${CONFIG}/snippets.json`]]);
  });

  it('reports a file nested under the folder, because themes live there', async () => {
    await watcher.start();
    const seen = record();

    await platform.externalWrite(`${CONFIG}/themes/solar.json`, '{}');
    await vi.advanceTimersByTimeAsync(300);

    expect(seen).toEqual([[`${CONFIG}/themes/solar.json`]]);
  });

  it('coalesces a burst into one notification', async () => {
    await watcher.start();
    const seen = record();

    // An editor saving three files, or one save arriving as several events.
    await platform.externalWrite(`${CONFIG}/snippets.json`, '{}');
    await platform.externalWrite(`${CONFIG}/themes/a.json`, '{}');
    await platform.externalWrite(`${CONFIG}/themes/b.json`, '{}');
    await vi.advanceTimersByTimeAsync(300);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([
      `${CONFIG}/snippets.json`,
      `${CONFIG}/themes/a.json`,
      `${CONFIG}/themes/b.json`,
    ]);
  });

  it('starts a fresh batch after one is delivered', async () => {
    await watcher.start();
    const seen = record();

    await platform.externalWrite(`${CONFIG}/snippets.json`, '{}');
    await vi.advanceTimersByTimeAsync(300);
    await platform.externalWrite(`${CONFIG}/themes/a.json`, '{}');
    await vi.advanceTimersByTimeAsync(300);

    expect(seen).toEqual([[`${CONFIG}/snippets.json`], [`${CONFIG}/themes/a.json`]]);
  });

  it('a stop mid-burst drops the pending batch rather than delivering it late', async () => {
    await watcher.start();
    const seen = record();

    await platform.externalWrite(`${CONFIG}/snippets.json`, '{}');
    watcher.stop();
    await vi.advanceTimersByTimeAsync(1000);

    expect(seen).toEqual([]);
  });

  /**
   * What clearing `#pending` on `stop` is really for. The stale batch can
   * never flush on its own — `stop` kills the timer too — so the only way it
   * becomes visible is by riding along with the *next* watch's first batch.
   */
  it('a batch after a restart holds only what changed since', async () => {
    await watcher.start();
    const seen = record();

    await platform.externalWrite(`${CONFIG}/snippets.json`, '{}');
    watcher.stop();
    await watcher.start();
    await platform.externalWrite(`${CONFIG}/themes/a.json`, '{}');
    await vi.advanceTimersByTimeAsync(300);

    expect(seen).toEqual([[`${CONFIG}/themes/a.json`]]);
  });

  it('lets a subscriber unsubscribe', async () => {
    await watcher.start();
    const seen: string[][] = [];
    const off = watcher.onChanged((paths) => seen.push([...paths]));

    off();
    await platform.externalWrite(`${CONFIG}/snippets.json`, '{}');
    await vi.advanceTimersByTimeAsync(300);

    expect(seen).toEqual([]);
  });

  /**
   * One subscriber throwing must not cost the others their notification. They
   * are independent services — snippets, themes, plugin settings — and a
   * malformed theme taking the snippets down with it would be a poor trade.
   */
  it('delivers to every subscriber even if one throws', async () => {
    await watcher.start();
    const seen: string[] = [];
    watcher.onChanged(() => {
      throw new Error('a subscriber exploded');
    });
    watcher.onChanged(() => seen.push('second'));

    await platform.externalWrite(`${CONFIG}/snippets.json`, '{}');
    await vi.advanceTimersByTimeAsync(300);

    expect(seen).toEqual(['second']);
  });
});

describe('routing a batch of changed paths', () => {
  const of = (...paths: string[]) => classifyConfigChange(paths);

  it('routes the three files it knows by name', () => {
    expect(of(`${CONFIG}/snippets.json`)).toMatchObject({ snippets: true, themes: false });
    expect(of(`${CONFIG}/plugin-settings.json`)).toMatchObject({ pluginSettings: true });
    expect(of(`${CONFIG}/tasks.json`)).toMatchObject({ tasks: true, snippets: false });
  });

  it('routes any file in the themes folder, whatever it is called', () => {
    // The id is the file's stem, so the folder is the whole rule — including
    // for a file being created or deleted.
    expect(of(`${CONFIG}/themes/solar.json`).themes).toBe(true);
    expect(of(`${CONFIG}/themes/anything-at-all`).themes).toBe(true);
  });

  it('reads a Windows path, which is what the desktop watcher emits', () => {
    // The event carries an OS path while `join` builds forward slashes, so
    // comparing whole paths would quietly never fire on Windows.
    expect(of(String.raw`C:\Users\a\AppData\Roaming\nox\snippets.json`).snippets).toBe(true);
    expect(of(String.raw`C:\Users\a\AppData\Roaming\nox\themes\solar.json`).themes).toBe(true);
  });

  it('routes several at once', () => {
    expect(of(`${CONFIG}/snippets.json`, `${CONFIG}/themes/a.json`)).toEqual({
      snippets: true,
      themes: true,
      pluginSettings: false,
      tasks: false,
    });
  });

  /**
   * The deliberate omissions, and the reason this is a test rather than a
   * comment: adding a file to the folder must not silently start reloading it.
   * `servers.json` and `agents.json` restart processes; `settings.json` and
   * `keybindings.json` are written by Nox constantly.
   *
   * `tasks.json` is *not* in this list and the distinction is the point:
   * re-reading it starts nothing, it only changes which commands are listed,
   * and running one is still a separate act that a project task has to be
   * approved for by argv. See `classifyConfigChange`.
   */
  it('routes nothing for the files that must not live-reload', () => {
    const nothing = { snippets: false, themes: false, pluginSettings: false, tasks: false };
    expect(of(`${CONFIG}/settings.json`)).toEqual(nothing);
    expect(of(`${CONFIG}/keybindings.json`)).toEqual(nothing);
    expect(of(`${CONFIG}/servers.json`)).toEqual(nothing);
    expect(of(`${CONFIG}/agents.json`)).toEqual(nothing);
    expect(of(`${CONFIG}/plugins/todos/main.js`)).toEqual(nothing);
  });
});

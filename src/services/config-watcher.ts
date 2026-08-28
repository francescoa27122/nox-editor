import { basename, dirname } from '@core/path';
import { Signal } from '@core/signal';
import type { Platform, Unwatch } from '@platform/types';

/**
 * Reacts to changes made to Nox's own configuration folder.
 *
 * Three Known-debt rows said the same thing — `snippets.json`,
 * `plugin-settings.json` and a theme file each needed a Reload command after a
 * hand edit — and all three named the same cause: `FileWatcherService` has one
 * root and it is the workspace.
 *
 * **A separate service rather than a second root on that one.** Its whole body
 * is workspace policy: reload clean buffers, protect dirty ones, refresh the
 * tree, re-index for quick-open, warn once per buffer. None of that applies to
 * a config file, and threading a second root through it would mean a
 * conditional at every step of a path where being wrong costs unsaved work.
 *
 * What this does is small enough to state completely: watch, coalesce into a
 * set of changed paths, hand that set to subscribers. **Every decision about
 * what a change means stays with the service that owns the file** — which is
 * also where the self-write check lives, because that is a content comparison
 * only the owner can make. See
 * `docs/superpowers/specs/2026-08-28-config-watcher-design.md`.
 */

/**
 * Long enough that an editor writing a file in several steps is one
 * notification, short enough that a theme edit feels immediate.
 *
 * Shorter than the workspace watcher's `MAX_COALESCE_MS` ceiling and with no
 * ceiling of its own, deliberately: that ceiling exists because a project root
 * can be under a `tsc --watch` or an rsync producing events indefinitely. This
 * folder is Nox's own and nothing in it streams, so the sliding window cannot
 * be held open — and if it somehow were, the cost is a late reload of a
 * settings file rather than a save that skipped its overwrite prompt.
 */
const COALESCE_MS = 150;

/** What a batch of changed paths asks Nox to re-read. */
export interface ConfigChange {
  snippets: boolean;
  themes: boolean;
  pluginSettings: boolean;
}

/**
 * Sort a batch of changed paths into the things that care about them.
 *
 * Pure and exported so the routing is testable, rather than an `if` chain in
 * `app.ts` that only a running app could exercise. It is the config folder's
 * *layout* — which this module owns — and not what a change means, which stays
 * with the service that owns each file.
 *
 * Matched on the final segments rather than by comparing whole paths: the
 * desktop watcher emits OS paths, so a Windows event arrives with backslashes
 * while `join` builds forward slashes, and an equality check would quietly
 * never fire. `basename` already reads both separators.
 *
 * Only three files are routed. `settings.json`, `keybindings.json`,
 * `servers.json` and `agents.json` are deliberately absent — the first two
 * because Nox writes them constantly and live-reloading the layer that owns
 * every preference wants its own envelope read, the last two because
 * reloading them *restarts processes*, which is a decision a user makes with
 * **Reload Language Servers**.
 */
export function classifyConfigChange(paths: Iterable<string>): ConfigChange {
  const change: ConfigChange = { snippets: false, themes: false, pluginSettings: false };

  for (const path of paths) {
    const name = basename(path);
    if (name === 'snippets.json') change.snippets = true;
    else if (name === 'plugin-settings.json') change.pluginSettings = true;
    // A theme is any file in the themes folder, including one being created or
    // deleted — the id is the file's stem, so the folder is the whole rule.
    else if (basename(dirname(path)) === 'themes') change.themes = true;
  }

  return change;
}

export class ConfigWatcherService {
  /** True while the config directory is being watched. */
  readonly active = new Signal(false);

  #platform: Platform;
  #unwatch: Unwatch | null = null;
  #root: string | null = null;

  #listeners = new Set<(paths: ReadonlySet<string>) => void>();
  #pending = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(platform: Platform) {
    this.#platform = platform;
  }

  /**
   * Begin watching. Safe to call more than once.
   *
   * A platform with no config directory — the browser build — is not an error
   * and not a warning: there is genuinely nothing to watch, and saying so on
   * every launch would be noise about a folder that build does not have.
   */
  async start(): Promise<void> {
    if (!this.#platform.capabilities.fileWatching) return;

    const root = await this.#platform.configDir().catch(() => null);
    if (root === null) return;
    if (root === this.#root && this.#unwatch) return;

    this.stop();
    this.#root = root;

    try {
      this.#unwatch = await this.#platform.watchConfig(root, (event) => {
        for (const path of event.paths) this.#pending.add(path);

        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = setTimeout(() => this.#flush(), COALESCE_MS);
      });
      this.active.set(true);
    } catch {
      // A config folder that cannot be watched is degraded, not broken: every
      // Reload command still works, which is exactly where this feature
      // started. Not surfaced, for the same reason — there is nothing the user
      // can usefully do, and the fallback is the behaviour they already had.
      this.#root = null;
    }
  }

  stop(): void {
    this.#unwatch?.();
    this.#unwatch = null;
    this.#root = null;
    this.active.set(false);
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    // Cleared, not flushed. A batch delivered after a stop would reload files
    // on behalf of a watch that no longer exists.
    this.#pending.clear();
  }

  /**
   * Be told which config paths changed, after coalescing.
   *
   * Paths rather than names, because `themes/solar.json` is not a bare
   * filename and a subscriber has to be able to tell one theme from another.
   * Returns an unsubscribe.
   */
  onChanged(listener: (paths: ReadonlySet<string>) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #flush(): void {
    this.#timer = null;
    if (this.#pending.size === 0) return;

    const paths = this.#pending;
    this.#pending = new Set();

    for (const listener of [...this.#listeners]) {
      try {
        listener(paths);
      } catch {
        // One subscriber's failure must not cost the others their
        // notification: these are independent services, and a malformed theme
        // taking the snippets down with it would be a poor trade.
      }
    }
  }
}

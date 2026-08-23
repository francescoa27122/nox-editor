import type { DamagedFile } from '@core/damaged-config';
import { join } from '@core/path';
import { Signal } from '@core/signal';
import type { Platform } from '@platform/types';
import { preserveDamaged } from '../damaged-config';
import {
  coerce,
  coerceAll,
  coerceWorkspace,
  defaultSettings,
  SETTINGS_SCHEMA,
  SETTING_KEYS,
  type SettingKey,
  type Settings,
} from './schema';

export * from './schema';

const CONFIG_FILE = 'settings.json';
/** Relative to the workspace root. See the design doc `loadWorkspace` names. */
const WORKSPACE_CONFIG_PATH = '.nox/settings.json';

/** Which layer supplied the value a `get()` returns. */
export type SettingScope = 'default' | 'user' | 'workspace';

/**
 * Centralised configuration.
 *
 * Holds one immutable `Settings` object behind a Signal. Consumers either read
 * `config.get('editor.fontSize')` for a one-off, or subscribe to `changes` to
 * react. Only values that differ from the default are persisted, so upgrading
 * Nox picks up new defaults instead of freezing whatever shipped first.
 *
 * **Three layers**, lowest first: the schema's defaults, the user's
 * `settings.json`, and the workspace's `.nox/settings.json` — the last
 * restricted to keys the schema marks `workspace: true`, because that file
 * arrives with a cloned repository. Every write goes to the *user* layer,
 * which is the only layer this class has ever written; `settings` and `get()`
 * are the effective result. See
 * `docs/superpowers/specs/2026-08-20-workspace-settings-design.md`.
 */
export class ConfigService {
  readonly settings: Signal<Settings>;
  /** Emits the set of keys that changed, after `settings` has updated. */
  readonly changed: Signal<ReadonlySet<SettingKey>>;
  /**
   * The keys the open project currently supplies.
   *
   * Its own signal rather than something derivable from `settings`, because
   * `#recompute` deliberately stays quiet when nothing *moved* — and a
   * workspace that sets a key to the value the user already had moves
   * nothing while still owning the key. The Settings panel reads this to
   * decide which rows it may not offer a control for, and that question is
   * about ownership, not about the value.
   */
  readonly workspaceScope: Signal<ReadonlySet<SettingKey>>;
  /**
   * Why the last write to `settings.json` failed, or null.
   *
   * A settings file that cannot be written must not break the session — that
   * part was always right. But "must not break the session" is not "must not
   * be mentioned": every preference the user changes from here on is lost at
   * quit, and only they can do anything about a full disk or a bad
   * permission. Published the way `NotesService` publishes its own write
   * failures, and toasted in `NoxApp.#wireServices`.
   */
  readonly error = new Signal<string | null>(null);
  /**
   * The settings file Nox could not read at boot, and where it kept a copy.
   *
   * Its own signal rather than a second use of `error`, which means "the last
   * *write* failed" and is cleared by `#save` on the next write that lands —
   * about 250 ms after the first preference the user changes. A damage notice
   * that a save can erase is a damage notice nobody sees.
   */
  readonly damaged = new Signal<DamagedFile | null>(null);

  #platform: Platform;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** The user's own values — the only layer any write touches. */
  #user: Partial<Settings> = {};
  /** The open project's values, already filtered to workspace-scoped keys. */
  #workspace: Partial<Settings> = {};

  constructor(platform: Platform) {
    this.#platform = platform;
    this.settings = new Signal<Settings>(defaultSettings());
    this.changed = new Signal<ReadonlySet<SettingKey>>(new Set());
    this.workspaceScope = new Signal<ReadonlySet<SettingKey>>(new Set());
  }

  get<K extends SettingKey>(key: K): Settings[K] {
    return this.settings.get()[key];
  }

  set<K extends SettingKey>(key: K, value: Settings[K]): void {
    const coerced = coerce(key, value) as Settings[K];
    // Compared against the *user* layer, not the effective value: setting a
    // key the workspace overrides must still be recorded, or the value would
    // vanish the moment the folder closed.
    if (this.#userValue(key) === coerced) return;
    this.#user[key] = coerced;
    this.#recompute();
    this.#scheduleSave();
  }

  /** Apply several settings as one change — one save, one notification. */
  patch(values: Partial<Settings>): void {
    let touched = false;

    for (const [key, value] of Object.entries(values)) {
      if (!(key in SETTINGS_SCHEMA)) continue;
      const k = key as SettingKey;
      const coerced = coerce(k, value);
      if (this.#userValue(k) === coerced) continue;
      (this.#user as Record<string, unknown>)[k] = coerced;
      touched = true;
    }

    if (!touched) return;
    this.#recompute();
    this.#scheduleSave();
  }

  reset(key: SettingKey): void {
    if (!(key in this.#user)) return;
    delete this.#user[key];
    this.#recompute();
    this.#scheduleSave();
  }

  resetAll(): void {
    if (Object.keys(this.#user).length === 0) return;
    this.#user = {};
    this.#recompute();
    this.#scheduleSave();
  }

  isDefault(key: SettingKey): boolean {
    return this.settings.get()[key] === SETTINGS_SCHEMA[key].default;
  }

  /** Which layer the effective value came from. */
  scopeOf(key: SettingKey): SettingScope {
    if (key in this.#workspace) return 'workspace';
    if (key in this.#user) return 'user';
    return 'default';
  }

  /** The keys the open project currently sets. Empty with no folder open. */
  workspaceKeys(): readonly SettingKey[] {
    return Object.keys(this.#workspace) as SettingKey[];
  }

  /**
   * Read `<root>/.nox/settings.json` into the workspace layer.
   *
   * A null root clears it — closing a folder must not leave its indentation
   * behind. Missing, unreadable, unparseable or not-an-object all mean "no
   * workspace settings", silently: this file is frequently written by someone
   * who is not the person reading it, and a toast they cannot act on is worse
   * than nothing.
   */
  async loadWorkspace(root: string | null): Promise<void> {
    if (!root) {
      if (Object.keys(this.#workspace).length === 0) return;
      this.#workspace = {};
      this.#announceScope();
      this.#recompute();
      return;
    }

    let raw: string | null = null;
    try {
      raw = await this.#platform.readTextFile(workspaceConfigPath(root));
    } catch {
      raw = null;
    }

    let parsed: unknown = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }

    this.#workspace = coerceWorkspace(parsed);
    this.#announceScope();
    this.#recompute();
  }

  #announceScope(): void {
    const next = new Set(this.workspaceKeys());
    const current = this.workspaceScope.get();
    if (next.size === current.size && [...next].every((key) => current.has(key))) return;
    this.workspaceScope.set(next);
  }

  #userValue(key: SettingKey): unknown {
    return key in this.#user ? this.#user[key] : SETTINGS_SCHEMA[key].default;
  }

  /**
   * Fold the layers and announce only what actually moved.
   *
   * The diff matters now that a write can land in a layer the workspace
   * shadows: `set()` on such a key changes the file and nothing else, and a
   * `changed` event for it would send every subscriber re-applying a value
   * that did not change.
   */
  #recompute(): void {
    const current = this.settings.get();
    const next = { ...defaultSettings(), ...this.#user, ...this.#workspace };

    const moved = new Set<SettingKey>();
    for (const key of SETTING_KEYS) {
      if (current[key] !== next[key]) moved.add(key);
    }
    if (moved.size === 0) return;

    this.settings.set(next);
    this.changed.set(moved);
  }

  /** Read settings from disk. Invalid files are ignored, never fatal. */
  async load(): Promise<void> {
    let raw: string | null = null;
    try {
      raw = await this.#platform.readConfigFile(CONFIG_FILE);
    } catch {
      return;
    }
    if (!raw) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // The defaults still stand — booting is never refused over this. What
      // changed is that the file is no longer treated as absent: the next
      // `set()` serializes an empty diff and `#save` replaces the file with
      // it, so without a copy every customisation in it is gone, silently.
      this.damaged.set(await preserveDamaged(this.#platform, CONFIG_FILE, raw));
      return;
    }

    this.#user = coerceAll(parsed);
    this.#recompute();
  }

  /** Write immediately, bypassing the debounce. Used on quit. */
  async flush(): Promise<void> {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    await this.#save();
  }

  /**
   * The JSON that would be written — the **user** layer's non-default values.
   *
   * Never the effective settings: a project's `.nox/settings.json` must not
   * bleed into the reader's own file the first time they change anything.
   */
  serialize(): string {
    const diff: Record<string, unknown> = {};
    for (const key of SETTING_KEYS) {
      if (!(key in this.#user)) continue;
      if (this.#user[key] === SETTINGS_SCHEMA[key].default) continue;
      diff[key] = this.#user[key];
    }
    return `${JSON.stringify(diff, null, 2)}\n`;
  }

  #scheduleSave(): void {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      void this.#save();
    }, 250);
  }

  async #save(): Promise<void> {
    try {
      await this.#platform.writeConfigFile(CONFIG_FILE, this.serialize());
      // Cleared only on a write that lands, so a transient failure followed by
      // a successful one stops nagging on its own.
      if (this.error.get() !== null) this.error.set(null);
    } catch (error) {
      // Reported, never thrown: the settings are already correct in memory and
      // the session carries on with them.
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }
}

/**
 * Where a workspace keeps its settings. Exported for the command that opens it.
 *
 * Through `join`, not a template with a hardcoded `/`. The literal separator
 * produced `C:\proj/.nox/settings.json` on Windows, which is a real path to
 * the OS and a different *string* from the `C:\proj\.nox\settings.json` the
 * watcher reports and `join` builds everywhere else. Two consequences, both
 * silent: the reload check in `NoxApp` is a `Set.has` on that string, so
 * editing the file never applied it until the folder was reopened; and
 * `findByPath` is an exact compare, so opening it from the palette while it
 * was already open from the explorer made a *second* buffer for one file —
 * two undo histories, two dirty flags, last save wins.
 */
export function workspaceConfigPath(root: string): string {
  return join(root, ...WORKSPACE_CONFIG_PATH.split('/'));
}

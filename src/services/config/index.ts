import { Signal } from '@core/signal';
import type { Platform } from '@platform/types';
import {
  coerce,
  coerceAll,
  defaultSettings,
  SETTINGS_SCHEMA,
  SETTING_KEYS,
  type SettingKey,
  type Settings,
} from './schema';

export * from './schema';

const CONFIG_FILE = 'settings.json';

/**
 * Centralised configuration.
 *
 * Holds one immutable `Settings` object behind a Signal. Consumers either read
 * `config.get('editor.fontSize')` for a one-off, or subscribe to `changes` to
 * react. Only values that differ from the default are persisted, so upgrading
 * Nox picks up new defaults instead of freezing whatever shipped first.
 */
export class ConfigService {
  readonly settings: Signal<Settings>;
  /** Emits the set of keys that changed, after `settings` has updated. */
  readonly changed: Signal<ReadonlySet<SettingKey>>;

  #platform: Platform;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(platform: Platform) {
    this.#platform = platform;
    this.settings = new Signal<Settings>(defaultSettings());
    this.changed = new Signal<ReadonlySet<SettingKey>>(new Set());
  }

  get<K extends SettingKey>(key: K): Settings[K] {
    return this.settings.get()[key];
  }

  set<K extends SettingKey>(key: K, value: Settings[K]): void {
    const current = this.settings.get();
    const coerced = coerce(key, value) as Settings[K];
    if (current[key] === coerced) return;
    this.settings.set({ ...current, [key]: coerced });
    this.changed.set(new Set([key]));
    this.#scheduleSave();
  }

  /** Apply several settings as one change — one save, one notification. */
  patch(values: Partial<Settings>): void {
    const current = this.settings.get();
    const next = { ...current };
    const touched = new Set<SettingKey>();

    for (const [key, value] of Object.entries(values)) {
      if (!(key in SETTINGS_SCHEMA)) continue;
      const k = key as SettingKey;
      const coerced = coerce(k, value);
      if (current[k] === coerced) continue;
      (next as Record<string, unknown>)[k] = coerced;
      touched.add(k);
    }

    if (touched.size === 0) return;
    this.settings.set(next);
    this.changed.set(touched);
    this.#scheduleSave();
  }

  reset(key: SettingKey): void {
    this.set(key, SETTINGS_SCHEMA[key].default as never);
  }

  resetAll(): void {
    this.settings.set(defaultSettings());
    this.changed.set(new Set(SETTING_KEYS));
    this.#scheduleSave();
  }

  isDefault(key: SettingKey): boolean {
    return this.settings.get()[key] === SETTINGS_SCHEMA[key].default;
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
      return; // Corrupt file: fall back to defaults rather than refusing to start.
    }

    const valid = coerceAll(parsed);
    const next = { ...defaultSettings(), ...valid };
    this.settings.set(next);
    this.changed.set(new Set(SETTING_KEYS));
  }

  /** Write immediately, bypassing the debounce. Used on quit. */
  async flush(): Promise<void> {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    await this.#save();
  }

  /** The JSON that would be written — non-default values only. */
  serialize(): string {
    const current = this.settings.get();
    const diff: Record<string, unknown> = {};
    for (const key of SETTING_KEYS) {
      if (current[key] !== SETTINGS_SCHEMA[key].default) diff[key] = current[key];
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
    } catch {
      /* Settings that cannot be written should not break the session. */
    }
  }
}

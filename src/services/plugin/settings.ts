import type { DamagedFile } from '@core/damaged-config';
import { Emitter } from '@core/emitter';
import type { PluginSetting } from '@core/plugin-manifest';
import { Signal } from '@core/signal';
import type { Platform } from '@platform/types';
import { coerceTo } from '../config/schema';
import { preserveDamaged } from '../damaged-config';

/**
 * What plugins have been configured to do.
 *
 * A separate file from `settings.json`, and the reason is not tidiness.
 * `SETTINGS_SCHEMA` is closed at compile time — `SettingKey` is `keyof typeof`
 * it and `Settings` is derived from that, which is the whole basis of
 * `config.get('editor.fontSize')` being typed. A plugin's keys are discovered
 * at runtime, so admitting them would widen `Settings` to
 * `Record<string, unknown>` and take every core setting's type down with it.
 *
 * **One layer, always the user's.** There is no workspace layer here and no
 * way to add one by accident, because this class has nowhere to put it.
 * `.nox/settings.json` arrives with a cloned repository, and the schema's
 * `workspace: true` allowlist works because Nox knows what each of its eight
 * keys means. It cannot know what a plugin's keys mean — `formatter.path` and
 * `margin.width` are both a string with a label — so a repository can never
 * set one. See `docs/superpowers/specs/2026-08-28-plugin-settings-design.md`
 * §0.
 *
 * Shaped after `SnippetService`, which is the nearest thing: a small service
 * owning one config file, tolerant of it being absent, loud when it is
 * broken.
 */

export const PLUGIN_SETTINGS_FILE = 'plugin-settings.json';

/** What Nox writes when asked to create the file. Must parse — a test says so. */
export const PLUGIN_SETTINGS_TEMPLATE = `{
  "//": "Settings for your plugins, keyed by plugin id. Only values that differ from a plugin's own default need to be here; the Settings panel writes this file for you.",

  "example-plugin": {
    "someOption": true
  }
}
`;

/** A resolved value. The four kinds a plugin may declare, and nothing else. */
export type PluginSettingValue = boolean | number | string;

export interface PluginSettingsEvents {
  /** The id of a plugin whose effective values just moved. */
  changed: string;
}

/** Just the declaration half, so a caller need not carry a whole manifest. */
export interface PluginDeclaration {
  id: string;
  settings: readonly PluginSetting[];
}

export class PluginSettingsService {
  /**
   * Fires with the plugin id whose values moved.
   *
   * An `Emitter` rather than a `Signal`, because two consecutive changes to
   * the same plugin are two events and a signal holding the id would no-op on
   * the second — `Signal.set` compares. The payload is the id so the host can
   * tell exactly one plugin, rather than waking every running one over a
   * setting that is not theirs.
   */
  readonly changed = new Emitter<PluginSettingsEvents>();

  /**
   * Bumped whenever any value changes, so the Settings panel can re-read.
   *
   * Alongside `changed` rather than instead of it: the emitter's payload is
   * what lets the host tell exactly one plugin, and a component needs
   * something it can bind with `$`. Neither substitutes for the other.
   */
  readonly revision = new Signal(0);

  /** Set when the file exists but could not be parsed. Defaults stay live. */
  readonly error = new Signal<string | null>(null);

  /** The file Nox could not read at boot, and where it kept a copy. */
  readonly damaged = new Signal<DamagedFile | null>(null);

  #platform: Platform;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** What each loaded plugin declares, by plugin id. */
  #declared = new Map<string, readonly PluginSetting[]>();

  /** The user's stored values, by plugin id then key. Non-defaults only. */
  #values = new Map<string, Map<string, PluginSettingValue>>();

  /**
   * Namespaces in the file belonging to no plugin loaded right now.
   *
   * Carried verbatim and written back untouched. `ConfigService` drops an
   * unknown key and is right to — its schema is complete, so unknown means
   * stale. Here "known" is whatever discovery found *this launch*, so a
   * plugin whose manifest failed to parse this morning, or a folder renamed
   * mid-upgrade, would have its configuration erased by the next unrelated
   * write. Dropping would make a transient failure destructive.
   */
  #unknown = new Map<string, unknown>();

  constructor(platform: Platform) {
    this.#platform = platform;
  }

  /**
   * Record what the loaded plugins declare.
   *
   * Called after discovery, and again on every reload. A plugin that is no
   * longer named does not lose its stored values — they move back to
   * `#unknown`, which is the same treatment a namespace gets when the file is
   * first read and its plugin is missing.
   */
  describe(plugins: readonly PluginDeclaration[]): void {
    const previouslyDeclared = [...this.#declared.keys()];
    this.#declared = new Map(plugins.map((plugin) => [plugin.id, plugin.settings]));

    for (const id of previouslyDeclared) {
      if (this.#declared.has(id)) continue;
      const stored = this.#values.get(id);
      if (!stored || stored.size === 0) continue;
      this.#unknown.set(id, Object.fromEntries(stored));
      this.#values.delete(id);
    }

    // A namespace that was unknown and whose plugin has now appeared is read
    // back through the declaration, so its values become live rather than
    // merely preserved.
    for (const plugin of plugins) {
      const parked = this.#unknown.get(plugin.id);
      if (parked === undefined) continue;
      this.#unknown.delete(plugin.id);
      this.#adopt(plugin.id, parked);
    }
  }

  /** What one plugin declares. Empty for a plugin with no settings. */
  declarationsFor(pluginId: string): readonly PluginSetting[] {
    return this.#declared.get(pluginId) ?? [];
  }

  /**
   * One plugin's effective values, every default filled in.
   *
   * Complete rather than sparse, so a plugin reading its settings never has to
   * handle a missing key or restate a default Nox already knows.
   */
  valuesFor(pluginId: string): Record<string, PluginSettingValue> {
    const declared = this.#declared.get(pluginId);
    if (!declared) return {};

    const stored = this.#values.get(pluginId);
    const out: Record<string, PluginSettingValue> = {};
    for (const setting of declared) {
      const value = stored?.get(setting.key);
      out[setting.key] = value === undefined ? setting.default : value;
    }
    return out;
  }

  /** Whether a key is still on the plugin's own default. */
  isDefault(pluginId: string, key: string): boolean {
    return this.#values.get(pluginId)?.has(key) !== true;
  }

  /**
   * Set one value, coerced against the plugin's own declaration.
   *
   * A key the plugin does not declare is refused rather than stored: the
   * declaration is what the panel draws and what `valuesFor` reads, so a value
   * with nothing to describe it could never be seen, changed or reset again.
   */
  set(pluginId: string, key: string, value: unknown): void {
    const setting = this.#declared.get(pluginId)?.find((entry) => entry.key === key);
    if (!setting) return;

    const coerced = coerceTo(setting, value);
    const current = this.#values.get(pluginId)?.get(key) ?? setting.default;
    if (current === coerced) return;

    if (coerced === setting.default) {
      // Stored values are non-defaults only, so writing the default back is a
      // reset. Without this the file would accumulate rows that say nothing.
      this.#values.get(pluginId)?.delete(key);
    } else {
      const bucket = this.#values.get(pluginId) ?? new Map<string, PluginSettingValue>();
      bucket.set(key, coerced);
      this.#values.set(pluginId, bucket);
    }

    this.#announce(pluginId);
  }

  /** Put one key back on the plugin's default. */
  reset(pluginId: string, key: string): void {
    if (this.#values.get(pluginId)?.delete(key) !== true) return;
    this.#announce(pluginId);
  }

  #announce(pluginId: string): void {
    this.revision.update((n) => n + 1);
    this.changed.emit('changed', pluginId);
    this.#scheduleSave();
  }

  /** Read the file. A missing one is the state everyone starts in. */
  async load(): Promise<void> {
    let raw: string | null;
    try {
      raw = await this.#platform.readConfigFile(PLUGIN_SETTINGS_FILE);
    } catch {
      return;
    }
    if (!raw || raw.trim().length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Copied before anything else can overwrite it. The next `set` writes a
      // file built from an empty `#unknown`, which would otherwise delete
      // every plugin's configuration to fix Nox's inability to read one line.
      this.error.set(error instanceof Error ? error.message : 'plugin-settings.json is not valid JSON');
      this.damaged.set(await preserveDamaged(this.#platform, PLUGIN_SETTINGS_FILE, raw));
      return;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      // Not damage — a file saying nothing. Nothing to salvage and nothing to
      // report, the same way an empty `settings.json` is not an error.
      return;
    }

    for (const [pluginId, body] of Object.entries(parsed as Record<string, unknown>)) {
      // The comment key the template ships with, and anything shaped like it.
      if (typeof body !== 'object' || body === null || Array.isArray(body)) continue;
      if (this.#declared.has(pluginId)) this.#adopt(pluginId, body);
      else this.#unknown.set(pluginId, body);
    }
  }

  /** Take a stored namespace into the live values, coercing as it goes. */
  #adopt(pluginId: string, body: unknown): void {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return;
    const declared = this.#declared.get(pluginId) ?? [];
    const source = body as Record<string, unknown>;
    const bucket = new Map<string, PluginSettingValue>();

    for (const setting of declared) {
      if (!Object.hasOwn(source, setting.key)) continue;
      const coerced = coerceTo(setting, source[setting.key]);
      // A stored value equal to the default is dropped rather than kept, so
      // `isDefault` and the panel's reset affordance agree with the file.
      if (coerced === setting.default) continue;
      bucket.set(setting.key, coerced);
    }

    if (bucket.size > 0) this.#values.set(pluginId, bucket);
    else this.#values.delete(pluginId);
  }

  /**
   * The JSON that would be written: every non-default value, plus every
   * namespace whose plugin is not loaded, verbatim.
   */
  serialize(): string {
    const out: Record<string, unknown> = {};
    for (const [pluginId, body] of this.#unknown) out[pluginId] = body;
    for (const [pluginId, bucket] of this.#values) {
      if (bucket.size === 0) continue;
      out[pluginId] = Object.fromEntries(bucket);
    }
    return `${JSON.stringify(out, null, 2)}\n`;
  }

  /** Create the file with a commented example if it does not exist yet. */
  async ensureFile(): Promise<void> {
    const existing = await this.#platform.readConfigFile(PLUGIN_SETTINGS_FILE).catch(() => null);
    if (existing !== null && existing.trim().length > 0) return;
    await this.#platform.writeConfigFile(PLUGIN_SETTINGS_FILE, PLUGIN_SETTINGS_TEMPLATE);
  }

  /** Write immediately, bypassing the debounce. Used on quit. */
  async flush(): Promise<void> {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    await this.#save();
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
      await this.#platform.writeConfigFile(PLUGIN_SETTINGS_FILE, this.serialize());
      if (this.error.get() !== null) this.error.set(null);
    } catch (error) {
      // Reported, never thrown: the values are already correct in memory and
      // the session carries on with them.
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }
}

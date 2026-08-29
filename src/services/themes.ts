import { join } from '@core/path';
import { Signal } from '@core/signal';
import {
  BUILT_IN_THEMES,
  parseTheme,
  type BuiltInTheme,
  type Theme,
} from '@core/theme';
import type { Platform } from '@platform/types';

/**
 * The themes a user can choose between: the two Nox ships, plus their own.
 *
 * **Discovery mirrors `discoverPlugins`, not `SnippetService`.** A theme is a
 * unit of *sharing* — people post them and download them — and a file is that
 * unit, where a fragment to paste into a map is not. It also means a broken
 * theme costs one theme rather than all of them, which is the leniency
 * argument the plugin loader already makes.
 *
 * The id is the file's stem. A theme does not name its own id, because two
 * files could then claim one and it would need a collision rule; a directory
 * already makes stems unique.
 *
 * See `docs/superpowers/specs/2026-08-28-custom-themes-design.md`.
 */

/** The folder inside the config directory that themes live in. */
export const THEMES_DIRECTORY = 'themes';

/** What `#applyTheme` needs: an attribute value, and properties to set. */
export interface ResolvedTheme {
  base: BuiltInTheme;
  tokens: Record<string, string>;
}

/** One row in the Settings picker. */
export interface ThemeChoice {
  id: string;
  name: string;
}

/** The example written into a new themes folder. Must parse — a test says so. */
export const EXAMPLE_THEME = `{
  "name": "Example",
  "base": "eclipse",

  "//": "Every key below is a token from Nox's design system, without the --nox- prefix. Anything you leave out comes from the base theme, so a theme can be three lines. Values must be hex or rgb().",

  "tokens": {
    "accent": "#e0a458",
    "accent-dim": "#a8763a",
    "syn-keyword": "#e0a458",
    "syn-string": "#98c379"
  }
}
`;

const EXAMPLE_FILE = 'example.json';

export class ThemeService {
  /** Bumped on every load, so the Settings picker re-reads the list. */
  readonly revision = new Signal(0);

  #platform: Platform;
  #custom = new Map<string, Theme>();
  #problems: string[] = [];

  constructor(platform: Platform) {
    this.#platform = platform;
  }

  /**
   * Re-read the themes folder.
   *
   * Replaces the set wholesale rather than merging into it, so a theme whose
   * file has gone stops being offered. That is the opposite of the rule
   * `PluginSettingsService` follows for values — and the difference is what is
   * being kept: a *value* the user chose is theirs and survives its plugin
   * being absent, while a *theme* is entirely the file, and offering one whose
   * file is gone would be offering nothing.
   */
  async load(): Promise<void> {
    const problems: string[] = [];
    const found = new Map<string, Theme>();

    const directory = await this.#directory();
    const entries = directory === null ? null : await this.#platform.readDir(directory).catch(() => null);

    for (const entry of entries ?? []) {
      // A folder of themes is also where people keep notes and half-finished
      // copies. Only `.json` is a claim to be a theme; anything else is
      // skipped in silence rather than reported, so the messages that do
      // appear are worth reading.
      if (entry.isDirectory || !entry.name.toLowerCase().endsWith('.json')) continue;

      const id = entry.name.slice(0, -'.json'.length);
      const raw = await this.#platform.readTextFile(entry.path).catch(() => null);
      if (raw === null) continue;

      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch (error) {
        problems.push(
          `${entry.name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      const parsed = parseTheme(id, value);
      if (!parsed.ok) {
        problems.push(parsed.reason);
        continue;
      }

      problems.push(...parsed.problems.map((problem) => `${id}: ${problem}`));
      found.set(id, parsed.theme);
    }

    this.#custom = found;
    this.#problems = problems;
    this.revision.update((n) => n + 1);
  }

  /** One sentence per theme, or token, that could not be loaded. */
  problems(): readonly string[] {
    return this.#problems;
  }

  /**
   * Everything choosable: the built-ins, then the user's own by name.
   *
   * Both halves of that order are deliberate. The two themes that always work
   * head the list, so a picker full of someone's experiments still opens on
   * something known — and the rest are **sorted** rather than left in the
   * order `readDir` happened to return, which is not specified and differs
   * between platforms. A picker whose rows move between launches is a picker
   * you cannot learn, and **Switch Theme** cycles this list, so an unstable
   * order would make that command unpredictable too.
   */
  list(): ThemeChoice[] {
    const custom = [...this.#custom.values()]
      .map((theme) => ({ id: theme.id, name: theme.name }))
      // By id after name, so two themes sharing a name still have a fixed
      // order rather than one that depends on which file was read first.
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    return [
      ...BUILT_IN_THEMES.map((id) => ({ id, name: id === 'umbra' ? 'Umbra (OLED)' : 'Eclipse' })),
      ...custom,
    ];
  }

  has(id: string): boolean {
    return (BUILT_IN_THEMES as readonly string[]).includes(id) || this.#custom.has(id);
  }

  /**
   * What the DOM needs for an id: a base to put on `data-nox-theme`, and the
   * properties to set over it.
   *
   * **An unknown id resolves rather than throwing**, and it deliberately does
   * not rewrite the setting. A theme id outlives its file whenever someone
   * deletes it or opens their settings on another machine; falling back to the
   * default base means reinstalling the file brings the choice back, where
   * resetting the setting would make them choose again.
   */
  resolve(id: string): ResolvedTheme {
    if ((BUILT_IN_THEMES as readonly string[]).includes(id)) {
      return { base: id as BuiltInTheme, tokens: {} };
    }

    const theme = this.#custom.get(id);
    if (!theme) return { base: BUILT_IN_THEMES[0], tokens: {} };
    return { base: theme.base, tokens: theme.tokens };
  }

  /**
   * Create the themes folder with an example, and return its path.
   *
   * The example is written only when it is absent, so an author who edited it
   * into their own theme does not get it back on the next **Edit Themes**.
   */
  async ensureFolder(): Promise<string | null> {
    const directory = await this.#directory();
    if (directory === null) return null;

    const file = join(directory, EXAMPLE_FILE);
    const existing = await this.#platform.readTextFile(file).catch(() => null);
    if (existing === null) {
      await this.#platform.createDir(directory).catch(() => {});
      await this.#platform.writeTextFile(file, EXAMPLE_THEME);
    }
    return directory;
  }

  async #directory(): Promise<string | null> {
    const config = await this.#platform.configDir().catch(() => null);
    return config === null ? null : join(config, THEMES_DIRECTORY);
  }
}

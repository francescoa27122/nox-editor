/**
 * `plugin.json`, as data.
 *
 * Pure, and the strictest reader in the codebase. Every other config Nox
 * parses is the user describing their own preferences; this one arrives
 * alongside **code someone else wrote**, and each field is that author's claim
 * about what their code may do.
 *
 * That changes the rule. Elsewhere — `core/snippets.ts`, `servers.json` — a bad
 * entry is dropped and named so one typo cannot empty a working file. Here the
 * two halves are deliberately different:
 *
 * - **Capabilities are all-or-nothing.** One word this parser does not
 *   recognise refuses the whole manifest. Trimming would leave a plugin whose
 *   declaration the user read and whose behaviour does not match it, and the
 *   thing being mismatched is permission.
 * - **Commands are lenient.** A malformed command grants nothing, so losing
 *   one is a smaller harm than refusing a plugin whose others are fine.
 *
 * The capability vocabulary is **passed in, not imported**: `core/` does not
 * import from `services/`, and the list of capabilities belongs to the
 * permission model. See `CAPABILITIES` in `services/permissions.ts`.
 */

/** What Nox runs, and how. Exactly one of the two, never both. */
export type PluginEntry =
  | { kind: 'worker'; file: string }
  | { kind: 'process'; command: string; args?: string[] };

/** One command a plugin offers. `name` is namespaced before registration. */
export interface ContributedCommand {
  name: string;
  title: string;
}

/**
 * One sidebar panel a plugin offers.
 *
 * Declared rather than created at runtime, and that is what lets a panel keep
 * the lazy activation commands have: the rail button exists before the plugin
 * does, and clicking it is what starts it. A panel that had to be registered
 * by running code would mean every plugin with one starts at launch — which is
 * the trade status items had to make and this does not.
 *
 * `icon` names one of Nox's own; a plugin cannot ship artwork. Anything
 * unrecognised falls back rather than failing, because an icon is decoration
 * and a panel that refused to load over one would be a poor trade.
 */
export interface ContributedPanel {
  name: string;
  title: string;
  icon?: string;
}

/**
 * When a plugin should be started.
 *
 * `command` is the default and the one to want: the plugin stays unstarted
 * until one of its commands is first invoked, so a plugin nobody uses costs a
 * directory read and nothing else.
 *
 * `startup` exists because some contributions cannot be declared. A status
 * item's *content* is only known to running code, so a plugin that puts one on
 * the bar has to be running to have put anything there. Written down in the
 * manifest rather than inferred, so the cost is visible to whoever installs it
 * rather than a consequence of a feature they did not notice being used.
 */
export type Activation = 'command' | 'startup';

/**
 * One option a plugin lets the user set.
 *
 * **Declared rather than registered at runtime**, for the reason panels are:
 * a setting has to be listable before the plugin runs, or seeing what a plugin
 * can be configured to do would mean starting it — and every plugin would
 * start at launch to fill a panel nobody opened.
 *
 * The four kinds are `SettingDescriptor`'s own, minus its `category` (a
 * plugin's category is the plugin) and minus `workspace`. That last omission
 * is the security decision: `.nox/settings.json` arrives with a cloned
 * repository, and Nox cannot tell a plugin's "margin width" from its "program
 * to run", so no plugin setting is ever workspace-scoped. See
 * `docs/superpowers/specs/2026-08-28-plugin-settings-design.md` §0.
 */
export type PluginSetting =
  | { key: string; kind: 'boolean'; default: boolean; label: string; description?: string }
  | {
      key: string;
      kind: 'number';
      default: number;
      min: number;
      max: number;
      label: string;
      description?: string;
    }
  | {
      key: string;
      kind: 'string';
      default: string;
      label: string;
      description?: string;
      placeholder?: string;
    }
  | {
      key: string;
      kind: 'enum';
      default: string;
      options: string[];
      label: string;
      description?: string;
    };

export interface PluginManifest {
  id: string;
  label: string;
  entry: PluginEntry;
  activation: Activation;
  /** Every capability its commands may use. Validated whole; see above. */
  capabilities: string[];
  commands: ContributedCommand[];
  panels: ContributedPanel[];
  settings: PluginSetting[];
}

export type ParsedManifest =
  | { ok: true; manifest: PluginManifest; problems: string[] }
  | { ok: false; reason: string };

/**
 * The first segment of every contributed command id.
 *
 * A constant rather than a literal in two places, because the palette, the
 * keybinding editor and the policy key all have to agree on it.
 */
export const PLUGIN_COMMAND_PREFIX = 'plugin';

/**
 * A plain lowercase name: letters, digits, hyphens.
 *
 * Deliberately narrower than "a valid folder name". The id becomes a *segment*
 * of a command id and a policy key, so a dot would split the namespace, and it
 * is also read back as a folder name, so a slash or `..` would aim the entry
 * file somewhere other than the plugin's own directory.
 */
const NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A settings key: a plain identifier, camelCase allowed.
 *
 * Wider than `NAME` because this one never becomes a command id — it is a key
 * inside the plugin's own object in `plugin-settings.json`, so uppercase costs
 * nothing and `lineLength` is how everyone writes these.
 *
 * Still restricted rather than "any string", and the reason is that the values
 * are assembled into an object by key: `__proto__` and `constructor` reaching
 * `out[key] = …` is prototype pollution from a third-party manifest. Requiring
 * a leading letter and forbidding punctuation rules both out by construction
 * rather than by a deny-list someone has to keep current.
 */
const SETTING_KEY = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * The command id a contribution is registered under.
 *
 * Three segments with a fixed first one, and `parseManifest` refuses a dot in
 * either of the other two — so a contributed id can never equal a core command
 * id, and two plugins can never collide. This is why the palette needs no
 * conflict resolution and why a plugin cannot shadow `file.save`.
 */
export function contributedCommandId(pluginId: string, name: string): string {
  return `${PLUGIN_COMMAND_PREFIX}.${pluginId}.${name}`;
}

/** A relative path that stays inside the plugin's own folder. */
function isContainedPath(value: string): boolean {
  if (value.length === 0) return false;
  // Absolute in either spelling, and a Windows drive letter, all escape the
  // folder just as surely as `..` does.
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  return !value.split(/[/\\]/).includes('..');
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The entry, or a sentence saying why there isn't one. */
function entryOf(record: Record<string, unknown>): PluginEntry | string {
  const worker = stringField(record, 'worker');
  const command = stringField(record, 'command');

  if (worker !== null && command !== null) {
    // Not resolved by preferring one: an author mid-way through replacing a
    // process with a worker would silently keep running the old one.
    return 'names both a worker and a command; it must name exactly one';
  }

  if (worker !== null) {
    if (!isContainedPath(worker)) return `worker "${worker}" is not inside the plugin folder`;
    return { kind: 'worker', file: worker };
  }

  if (command !== null) {
    const raw = record.args;
    const args = Array.isArray(raw)
      ? raw.filter((arg): arg is string => typeof arg === 'string')
      : undefined;
    return args === undefined ? { kind: 'process', command } : { kind: 'process', command, args };
  }

  return 'names no worker and no command';
}

/** The declared capabilities, or a sentence saying why they were refused. */
function capabilitiesOf(record: Record<string, unknown>, known: ReadonlySet<string>): string[] | string {
  const raw = record.capabilities;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return 'capabilities is not a list';

  const declared: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') return 'capabilities contains something that is not a name';
    if (!known.has(entry)) return `declares an unknown capability "${entry}"`;
    declared.push(entry);
  }
  return declared;
}

/**
 * The usable contributed panels, appending a sentence for each dropped one.
 *
 * `taken` is every command name the plugin already claimed. A panel's focus
 * command is registered under the same `plugin.<id>.<name>` id a contributed
 * command gets, and `CommandRegistry.register` **throws** on a duplicate — so
 * a plugin with a panel and a command of one name would not merely be
 * confusing, it would take the window down at load. Dropped rather than
 * refused whole, for the reason commands are: one lost panel beats a plugin
 * that will not load.
 */
function panelsOf(
  record: Record<string, unknown>,
  taken: ReadonlySet<string>,
  problems: string[],
): ContributedPanel[] {
  const raw = record.panels;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push('panels is not a list');
    return [];
  }

  const panels: ContributedPanel[] = [];
  const claimed = new Set(taken);

  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(`panel ${index} is not an object`);
      continue;
    }

    const panel = entry as Record<string, unknown>;
    const name = stringField(panel, 'name');
    const title = stringField(panel, 'title');

    if (name === null || !NAME.test(name)) {
      problems.push(`panel ${index} has no usable name`);
      continue;
    }
    if (title === null) {
      problems.push(`panel "${name}" has no title`);
      continue;
    }
    if (claimed.has(name)) {
      problems.push(`panel "${name}" collides with a command of the same name`);
      continue;
    }

    claimed.add(name);
    const icon = stringField(panel, 'icon');
    panels.push({ name, title, ...(icon === null ? {} : { icon }) });
  }
  return panels;
}

/**
 * The usable declared settings, appending a sentence for each dropped one.
 *
 * Lenient like commands and panels, and for the same reason: a setting is not
 * a permission, so the worst a malformed one does is fail to appear. Refusing
 * the manifest over it would cost the user every other thing the plugin does.
 *
 * **Every drop is about the default.** A default that is not of the declared
 * kind, outside its own bounds, or absent from its own options is not a
 * cosmetic error — it is the value every user who never touches the row gets,
 * so the setting is wrong for everyone rather than for whoever mistyped it.
 */
function settingsOf(record: Record<string, unknown>, problems: string[]): PluginSetting[] {
  const raw = record.settings;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push('settings is not a list');
    return [];
  }

  const settings: PluginSetting[] = [];
  const claimed = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(`setting ${index} is not an object`);
      continue;
    }

    const setting = entry as Record<string, unknown>;
    const key = stringField(setting, 'key');
    if (key === null || !SETTING_KEY.test(key)) {
      problems.push(`setting ${index} has no usable key`);
      continue;
    }
    if (claimed.has(key)) {
      // First wins, rather than last. A later duplicate silently shadowing an
      // earlier one would make the panel disagree with the file it writes.
      problems.push(`setting "${key}" is declared twice`);
      continue;
    }
    // Claimed as soon as the key is well-formed, not on a successful push, so
    // "declared twice" means the same thing whether or not the first one was
    // usable. A manifest with two of a key is a mistake either way.
    claimed.add(key);

    // The label is what the panel shows, and a plugin author who left it out
    // meant the key — which is a usable label and better than an empty row.
    const label = stringField(setting, 'label') ?? key;
    const description = stringField(setting, 'description');
    const common = { key, label, ...(description === null ? {} : { description }) };
    const fallback = setting.default;

    switch (setting.kind) {
      case 'boolean': {
        if (typeof fallback !== 'boolean') {
          problems.push(`setting "${key}" has a default that is not a boolean`);
          continue;
        }
        settings.push({ ...common, kind: 'boolean', default: fallback });
        break;
      }

      case 'number': {
        const min = setting.min;
        const max = setting.max;
        if (typeof fallback !== 'number' || !Number.isFinite(fallback)) {
          problems.push(`setting "${key}" has a default that is not a number`);
          continue;
        }
        if (typeof min !== 'number' || typeof max !== 'number' || !(min <= max)) {
          // Required rather than defaulted to an open range: the panel draws a
          // number input with bounds, and a plugin that has not thought about
          // its range is the one most likely to be handed a hostile value.
          problems.push(`setting "${key}" has no usable min and max`);
          continue;
        }
        if (fallback < min || fallback > max) {
          problems.push(`setting "${key}" has a default outside its own bounds`);
          continue;
        }
        settings.push({ ...common, kind: 'number', default: fallback, min, max });
        break;
      }

      case 'string': {
        if (typeof fallback !== 'string') {
          problems.push(`setting "${key}" has a default that is not a string`);
          continue;
        }
        const placeholder = stringField(setting, 'placeholder');
        settings.push({
          ...common,
          kind: 'string',
          default: fallback,
          ...(placeholder === null ? {} : { placeholder }),
        });
        break;
      }

      case 'enum': {
        const declared = setting.options;
        const options = Array.isArray(declared)
          ? declared.filter((option): option is string => typeof option === 'string')
          : [];
        if (options.length === 0) {
          problems.push(`setting "${key}" is an enum with no options`);
          continue;
        }
        if (typeof fallback !== 'string' || !options.includes(fallback)) {
          problems.push(`setting "${key}" has a default that is not one of its options`);
          continue;
        }
        settings.push({ ...common, kind: 'enum', default: fallback, options });
        break;
      }

      default: {
        // Named back, so an author who wrote `"color"` learns that Nox draws
        // four kinds rather than that their setting vanished.
        const named = typeof setting.kind === 'string' ? `"${setting.kind}"` : 'no kind';
        problems.push(`setting "${key}" has ${named}, which is not one of boolean, number, string, enum`);
        continue;
      }
    }
  }

  return settings;
}

/** The usable contributed commands, appending a sentence for each dropped one. */
function commandsOf(record: Record<string, unknown>, problems: string[]): ContributedCommand[] {
  const raw = record.commands;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push('commands is not a list');
    return [];
  }

  const commands: ContributedCommand[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(`command ${index} is not an object`);
      continue;
    }

    const command = entry as Record<string, unknown>;
    const name = stringField(command, 'name');
    const title = stringField(command, 'title');

    if (name === null) {
      problems.push(`command ${index} has no name`);
      continue;
    }
    if (!NAME.test(name)) {
      // A dot here would produce a four-segment id the keybinding editor and
      // the policy key would disagree about how to split.
      problems.push(`command name "${name}" is not a plain lowercase name`);
      continue;
    }
    if (title === null) {
      problems.push(`command "${name}" has no title`);
      continue;
    }

    commands.push({ name, title });
  }
  return commands;
}

/**
 * Read a parsed `plugin.json` body.
 *
 * Takes the already-`JSON.parse`d value rather than the text, for the reason
 * `parseSnippetFile` does: the host owns reading the file and reporting that
 * it is not JSON at all, and this owns everything after that.
 */
export function parseManifest(value: unknown, knownCapabilities: ReadonlySet<string>): ParsedManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'plugin.json is not an object' };
  }

  const record = value as Record<string, unknown>;

  const id = stringField(record, 'id');
  if (id === null) return { ok: false, reason: 'plugin.json has no id' };
  if (!NAME.test(id)) {
    return { ok: false, reason: `plugin id "${id}" is not a plain lowercase name` };
  }

  const label = stringField(record, 'label');
  if (label === null) return { ok: false, reason: `plugin "${id}" has no label` };

  const entry = entryOf(record);
  if (typeof entry === 'string') return { ok: false, reason: `plugin "${id}" ${entry}` };

  const declaredActivation = record.activation;
  if (declaredActivation !== undefined && declaredActivation !== 'command' && declaredActivation !== 'startup') {
    // Named back only when it is a word. An object stringifies to
    // `[object Object]`, which tells the author nothing they did not know.
    const named = typeof declaredActivation === 'string' ? ` "${declaredActivation}"` : '';
    return { ok: false, reason: `plugin "${id}" has an unknown activation${named}` };
  }
  const activation: Activation = declaredActivation ?? 'command';

  const capabilities = capabilitiesOf(record, knownCapabilities);
  if (typeof capabilities === 'string') {
    return { ok: false, reason: `plugin "${id}" ${capabilities}` };
  }

  const problems: string[] = [];
  const commands = commandsOf(record, problems);
  const panels = panelsOf(record, new Set(commands.map((command) => command.name)), problems);
  // Not passed the claimed names: a setting key lives in the plugin's own
  // settings object, never in the `plugin.<id>.<name>` command space, so there
  // is nothing for it to collide with.
  const settings = settingsOf(record, problems);

  return {
    ok: true,
    manifest: { id, label, entry, activation, capabilities, commands, panels, settings },
    problems,
  };
}

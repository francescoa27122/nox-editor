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

export interface PluginManifest {
  id: string;
  label: string;
  entry: PluginEntry;
  activation: Activation;
  /** Every capability its commands may use. Validated whole; see above. */
  capabilities: string[];
  commands: ContributedCommand[];
  panels: ContributedPanel[];
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

  return {
    ok: true,
    manifest: { id, label, entry, activation, capabilities, commands, panels },
    problems,
  };
}

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

export interface PluginManifest {
  id: string;
  label: string;
  entry: PluginEntry;
  /** Every capability its commands may use. Validated whole; see above. */
  capabilities: string[];
  commands: ContributedCommand[];
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

  const capabilities = capabilitiesOf(record, knownCapabilities);
  if (typeof capabilities === 'string') {
    return { ok: false, reason: `plugin "${id}" ${capabilities}` };
  }

  const problems: string[] = [];
  const commands = commandsOf(record, problems);

  return { ok: true, manifest: { id, label, entry, capabilities, commands }, problems };
}

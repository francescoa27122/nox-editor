import { Signal } from '@core/signal';
import type { Platform } from '@platform/types';

/**
 * Which language servers the user has told Nox about.
 *
 * A separate `servers.json` rather than an entry in the settings schema, for
 * the reason `agents.json` gives: these are a *list of records*, and the
 * settings UI is generated from a schema of scalars.
 *
 * **Nothing here discovers a server and nothing here starts one.** Starting a
 * process is the most powerful thing Nox does on someone's behalf, so it stays
 * behind something the user wrote down. A built-in registry that spawned
 * whatever it found on PATH would work with no configuration at all, and would
 * quietly revise that stance; if it is ever revised it should be deliberate.
 */

export const SERVERS_FILE = 'servers.json';

export interface ServerConfig {
  /** Language ids this server handles, as `BufferSnapshot.languageId` spells them. */
  languages: string[];
  command: string;
  args?: string[];
  /** Passed through verbatim in `initialize`. */
  initializationOptions?: unknown;
}

interface ServersFile {
  servers?: unknown[];
}

/**
 * What Nox writes when asked to create the file.
 *
 * Deliberately a working entry rather than an empty skeleton: enabling a
 * server should be an edit, not research into what the command is called and
 * which flag makes it speak stdio. Valid JSON, because the user is meant to
 * edit this file rather than debug it — JSON.parse rejects comments, so the
 * explanation lives in the docs and in the command that creates this.
 */
export const SERVERS_TEMPLATE = `{
  "servers": [
    {
      "languages": ["typescript", "javascript"],
      "command": "typescript-language-server",
      "args": ["--stdio"]
    }
  ]
}
`;

function normalise(entry: unknown): ServerConfig | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const record = entry as Record<string, unknown>;

  const command = typeof record.command === 'string' ? record.command.trim() : '';
  if (command.length === 0) return null;

  const languages = Array.isArray(record.languages)
    ? record.languages.filter((language): language is string => typeof language === 'string')
    : [];
  // An entry claiming no language could never be chosen for anything, so it is
  // a mistake rather than a server that is merely idle.
  if (languages.length === 0) return null;

  const args = Array.isArray(record.args)
    ? record.args.filter((arg): arg is string => typeof arg === 'string')
    : undefined;

  return {
    languages,
    command,
    ...(args ? { args } : {}),
    ...(record.initializationOptions !== undefined
      ? { initializationOptions: record.initializationOptions }
      : {}),
  };
}

export class ServerRegistry {
  readonly servers = new Signal<ServerConfig[]>([]);
  /** Set when the file exists but could not be understood. */
  readonly error = new Signal<string | null>(null);

  #platform: Platform;

  constructor(platform: Platform) {
    this.#platform = platform;
  }

  async load(): Promise<void> {
    let raw: string | null;
    try {
      raw = await this.#platform.readConfigFile(SERVERS_FILE);
    } catch {
      this.servers.set([]);
      return;
    }

    if (!raw || raw.trim().length === 0) {
      this.servers.set([]);
      this.error.set(null);
      return;
    }

    let parsed: ServersFile;
    try {
      parsed = JSON.parse(raw) as ServersFile;
    } catch (error) {
      // Said out loud rather than silently ignored: a typo here looks exactly
      // like having configured nothing, which is the state the user was
      // trying to leave.
      this.error.set(error instanceof Error ? error.message : 'servers.json is not valid JSON');
      this.servers.set([]);
      return;
    }

    const list = Array.isArray(parsed.servers) ? parsed.servers : [];
    const valid = list.map(normalise).filter((server): server is ServerConfig => server !== null);

    this.error.set(
      valid.length < list.length
        ? 'An entry in servers.json has no command, or claims no languages'
        : null,
    );
    this.servers.set(valid);
  }

  /** The server configured for a language, or null. First match wins. */
  forLanguage(languageId: string): ServerConfig | null {
    return (
      this.servers.get().find((server) => server.languages.includes(languageId)) ?? null
    );
  }

  /** Create the file with a working example if it does not exist yet. */
  async ensureFile(): Promise<void> {
    const existing = await this.#platform.readConfigFile(SERVERS_FILE).catch(() => null);
    if (existing !== null && existing.trim().length > 0) return;
    await this.#platform.writeConfigFile(SERVERS_FILE, SERVERS_TEMPLATE);
  }
}

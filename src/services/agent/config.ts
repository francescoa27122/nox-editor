import { Signal } from '@core/signal';
import type { Platform } from '@platform/types';

/**
 * Which agents the user has told Nox about.
 *
 * A separate `agents.json` rather than an entry in the settings schema,
 * because these are a *list of records*, and the settings UI is generated from
 * a schema of scalars — bending it to hold an array of command lines would
 * make every other preference worse.
 *
 * Nothing here starts anything. Spawning a process is the most powerful thing
 * Nox does on someone's behalf, so it stays behind an explicit command the
 * user runs, and is deliberately unreachable from the agent protocol: an agent
 * cannot configure or spawn another agent.
 */

export const AGENTS_FILE = 'agents.json';

interface AgentBase {
  /** Stable key, used for the session label and for policy lookup. */
  id: string;
  /** Shown in the palette and the panel. */
  label: string;
}

/** An agent Nox starts as a child process, speaking the protocol over stdio. */
export interface ProcessAgentConfig extends AgentBase {
  /**
   * Absent means `process`. Records written before local models existed have
   * no `kind`, and an upgrade that stopped loading them would be a poor
   * trade for a tidier type.
   */
  kind?: 'process';
  command: string;
  args?: string[];
  /** Defaults to the workspace root. */
  cwd?: string;
}

/** A local model served over loopback HTTP. */
export interface OllamaAgentConfig extends AgentBase {
  kind: 'ollama';
  host: string;
  model: string;
  /**
   * How many times the model may act before the session ends itself. A small
   * model will re-read the same buffer indefinitely given the chance.
   */
  maxTurns?: number;
}

export type AgentConfig = ProcessAgentConfig | OllamaAgentConfig;

/**
 * Narrows to the subprocess variant. Checks `kind !== 'ollama'` rather than
 * `kind === 'process'`, because absent `kind` must still pass — that is the
 * whole compatibility guarantee this union exists to keep.
 */
export function isProcessAgent(agent: AgentConfig): agent is ProcessAgentConfig {
  return agent.kind !== 'ollama';
}

interface AgentsFile {
  agents?: unknown;
}

/** What a fresh `agents.json` says, so the format is self-explaining. */
export const AGENTS_TEMPLATE = `{
  "agents": [
    {
      "id": "local",
      "label": "Local model",
      "kind": "ollama",
      "host": "http://127.0.0.1:11434",
      "model": "qwen2.5-coder:7b"
    },
    {
      "id": "example",
      "label": "Example agent",
      "command": "node",
      "args": ["./my-agent.js"]
    }
  ]
}
`;

export class AgentConfigService {
  readonly agents = new Signal<AgentConfig[]>([]);
  /** Set when the file exists but could not be understood. */
  readonly error = new Signal<string | null>(null);

  #platform: Platform;

  constructor(platform: Platform) {
    this.#platform = platform;
  }

  async load(): Promise<void> {
    let raw: string | null;
    try {
      raw = await this.#platform.readConfigFile(AGENTS_FILE);
    } catch {
      this.agents.set([]);
      return;
    }

    if (!raw || raw.trim().length === 0) {
      this.agents.set([]);
      this.error.set(null);
      return;
    }

    let parsed: AgentsFile;
    try {
      parsed = JSON.parse(raw) as AgentsFile;
    } catch (error) {
      // Said out loud rather than silently ignored: a typo in this file would
      // otherwise look exactly like having configured nothing.
      this.error.set(error instanceof Error ? error.message : 'agents.json is not valid JSON');
      this.agents.set([]);
      return;
    }

    const list = Array.isArray(parsed.agents) ? parsed.agents : [];
    const valid: AgentConfig[] = [];
    const seen = new Set<string>();

    for (const entry of list) {
      const agent = normalise(entry);
      // A duplicate id would make two agents share policy and session labels.
      if (!agent || seen.has(agent.id)) continue;
      seen.add(agent.id);
      valid.push(agent);
    }

    this.error.set(
      valid.length === 0 && list.length > 0
        ? 'No entry in agents.json has both an id and a command'
        : null,
    );
    this.agents.set(valid);
  }

  get(id: string): AgentConfig | undefined {
    return this.agents.get().find((agent) => agent.id === id);
  }

  /** Create the file with a commented example if it does not exist yet. */
  async ensureFile(): Promise<void> {
    const existing = await this.#platform.readConfigFile(AGENTS_FILE).catch(() => null);
    if (existing !== null && existing.trim().length > 0) return;
    await this.#platform.writeConfigFile(AGENTS_FILE, AGENTS_TEMPLATE);
  }
}

/** Accept a record only if it has the fields its `kind` cannot default. */
function normalise(entry: unknown): AgentConfig | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const record = entry as Record<string, unknown>;

  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return null;
  const label = typeof record.label === 'string' && record.label.trim() ? record.label.trim() : id;

  if (record.kind === 'ollama') {
    const host = typeof record.host === 'string' ? record.host.trim() : '';
    const model = typeof record.model === 'string' ? record.model.trim() : '';
    if (!host || !model) return null;

    const agent: OllamaAgentConfig = { id, label, kind: 'ollama', host, model };
    if (typeof record.maxTurns === 'number') agent.maxTurns = record.maxTurns;
    return agent;
  }

  const command = typeof record.command === 'string' ? record.command.trim() : '';
  if (!command) return null;

  const args = Array.isArray(record.args)
    ? record.args.filter((arg): arg is string => typeof arg === 'string')
    : undefined;

  const agent: ProcessAgentConfig = { id, label, command };
  if (args && args.length > 0) agent.args = args;
  if (typeof record.cwd === 'string' && record.cwd.trim()) agent.cwd = record.cwd.trim();
  return agent;
}

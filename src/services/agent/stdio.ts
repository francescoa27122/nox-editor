import type { AgentProcess, AgentProcessSpec, Platform } from '@platform/types';
import {
  parseInbound,
  PROTOCOL_VERSION,
  type AgentRequest,
  type AgentRun,
  type AgentTransport,
  type CoreResponse,
  type Handshake,
  type Outbound,
} from './protocol';

/**
 * An agent running in another process, speaking the protocol as one JSON
 * object per line over stdin and stdout.
 *
 * The second implementation of `AgentTransport`, and the one that makes the
 * first honest: everything above this point already treated an agent as
 * something at the end of a pipe, so this is a codec and a lifecycle rather
 * than a change to the runtime.
 *
 * It takes an `AgentProcess`, not a command line, which is what lets the whole
 * thing be tested against a fake process instead of a real one — no fixture
 * binary, no timing, no cleanup.
 *
 * See AGENT-PLATFORM.md §3.
 */

/** How long to wait for an agent to introduce itself before giving up. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface StdioOptions {
  /** Shown in errors, and as the agent's name until it says otherwise. */
  label?: string;
  handshakeTimeoutMs?: number;
}

export class StdioTransport implements AgentTransport {
  readonly id: string;

  #open: () => Promise<AgentProcess>;
  #options: StdioOptions;
  #process: AgentProcess | null = null;
  /** Lines that arrived before anything was waiting for them. */
  #pending: string[] = [];
  #onLine: ((line: string) => void) | null = null;
  #stderr: string[] = [];
  #exited: { code: number | null } | null = null;
  #onExit: (() => void) | null = null;

  constructor(open: () => Promise<AgentProcess>, id: string, options: StdioOptions = {}) {
    this.#open = open;
    this.id = id;
    this.#options = options;
  }

  /** Start a process through the platform. The normal way to build one. */
  static spawnedBy(platform: Platform, spec: AgentProcessSpec, options: StdioOptions = {}) {
    return new StdioTransport(() => platform.spawnAgent(spec), spec.command, options);
  }

  async connect(): Promise<Handshake> {
    const process = await this.#open();
    this.#process = process;

    process.onLine((line) => {
      if (this.#onLine) this.#onLine(line);
      else this.#pending.push(line);
    });
    // Kept rather than logged: when an agent dies during a handshake, its last
    // words on stderr are the only explanation anyone will get.
    process.onStderr((line) => {
      this.#stderr = [...this.#stderr.slice(-19), line];
    });
    process.onExit((code) => {
      this.#exited = { code };
      this.#onExit?.();
    });

    const first = await this.#nextLine(this.#options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    if (first === null) throw this.#died('never introduced itself');

    const parsed = parseInbound(first);
    if (!parsed.ok) throw this.#died(`sent something unusable: ${parsed.reason}`);
    if (parsed.message.type !== 'hello') {
      throw this.#died(`sent "${parsed.message.type}" before saying hello`);
    }

    return { version: parsed.message.version, label: parsed.message.label ?? this.id };
  }

  async run(
    run: AgentRun,
    send: (request: AgentRequest) => Promise<CoreResponse>,
  ): Promise<void> {
    const process = this.#process;
    if (!process) throw new Error(`${this.id} was not connected`);

    const stop = () => void this.#write({ type: 'cancel' });
    run.signal.addEventListener('abort', stop);

    try {
      await this.#write({
        type: 'run',
        instruction: run.instruction,
        context: run.context,
        ...(run.expects ? { expects: run.expects } : {}),
      });

      while (!run.signal.aborted) {
        const line = await this.#nextLine();
        // The process ending is a legitimate way to finish; a well-behaved
        // agent says `done` first, and one that crashes should not hang us.
        if (line === null) return;

        const parsed = parseInbound(line);
        if (!parsed.ok) throw this.#died(`sent something unusable: ${parsed.reason}`);
        if (parsed.message.type === 'done') return;
        if (parsed.message.type === 'hello') continue;

        const response = await send(parsed.message.request);
        await this.#write({ type: 'response', response });
      }
    } finally {
      run.signal.removeEventListener('abort', stop);
    }
  }

  dispose(): void {
    const process = this.#process;
    this.#process = null;
    this.#onLine = null;
    this.#onExit = null;
    void process?.kill().catch(() => undefined);
  }

  /**
   * The next line, or null once the process has ended and drained.
   *
   * Buffering matters here: an agent that writes its handshake and its first
   * request in one breath would otherwise lose the second, because nothing was
   * listening between the two awaits.
   */
  #nextLine(timeoutMs?: number): Promise<string | null> {
    const buffered = this.#pending.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.#exited) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        this.#onLine = null;
        this.#onExit = null;
        if (timer !== undefined) clearTimeout(timer);
        resolve(value);
      };

      const timer =
        timeoutMs === undefined ? undefined : setTimeout(() => finish(null), timeoutMs);

      this.#onLine = (line) => finish(line);
      this.#onExit = () => finish(this.#pending.shift() ?? null);
    });
  }

  async #write(message: Outbound): Promise<void> {
    await this.#process?.send(JSON.stringify(message));
  }

  /** An error that carries whatever the agent said on its way out. */
  #died(what: string): Error {
    const detail = this.#stderr.length > 0 ? `\n${this.#stderr.join('\n')}` : '';
    const exit = this.#exited ? ` (exited with ${this.#exited.code ?? 'no code'})` : '';
    return new Error(`${this.id} ${what}${exit}${detail}`);
  }
}

/** The version this build speaks, for an agent to check against. */
export { PROTOCOL_VERSION };

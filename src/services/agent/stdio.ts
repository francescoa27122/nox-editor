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

/**
 * How long a run may go without the agent writing anything.
 *
 * Far longer than the handshake's ten seconds, and deliberately so: a run is
 * usually a model call, and minutes of silence while one thinks is ordinary.
 * This is not a budget for the work — it is the point past which an agent has
 * plainly stopped rather than is thinking. The alternative is what shipped:
 * no deadline of any kind, and any agent that stopped writing without closing
 * its stdout left the session saying "Working…" for the life of the app.
 */
const RUN_IDLE_TIMEOUT_MS = 300_000;

export interface StdioOptions {
  /** Shown in errors, and as the agent's name until it says otherwise. */
  label?: string;
  handshakeTimeoutMs?: number;
  /** Silence allowed between lines during a run; see `RUN_IDLE_TIMEOUT_MS`. */
  idleTimeoutMs?: number;
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
  /**
   * Settles a `#nextLine` that is still waiting, for the two cases neither
   * `#onLine` nor `#onExit` can ever cover: a cancelled agent and a disposed
   * transport. An agent that is alive and silent produces neither event.
   */
  #abandon: (() => void) | null = null;

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

    const idleTimeoutMs = this.#options.idleTimeoutMs ?? RUN_IDLE_TIMEOUT_MS;

    const stop = () => {
      // Caught rather than left as a bare `void`: `nox_agent_send` answers
      // `not-found` once Rust has dropped the id from its registry, which it
      // does *before* emitting the exit — so cancelling an agent that has
      // just crashed rejects here, and an uncaught rejection reaches the
      // `unhandledrejection` backstop and shows "Something went wrong" about
      // a process that is already gone. There is nothing to tell the user.
      void this.#write({ type: 'cancel' }).catch(() => undefined);
      // Nothing else can end the wait below: a cancelled agent may write
      // nothing more and may never exit.
      this.#abandon?.();
    };
    run.signal.addEventListener('abort', stop);

    try {
      await this.#write({
        type: 'run',
        instruction: run.instruction,
        context: run.context,
        ...(run.expects ? { expects: run.expects } : {}),
      });

      while (!run.signal.aborted) {
        const line = await this.#nextLine(idleTimeoutMs);
        if (line === null) {
          // Four things arrive as `null` and only one of them is a failure.
          // The process ending is a legitimate way to finish — a well-behaved
          // agent says `done` first, and one that crashes should not hang us —
          // and cancelling and disposing both settle this wait on purpose.
          // What is left is an agent that is still there and has gone quiet,
          // and that has to be loud: returning would report a run as finished
          // when it produced nothing at all.
          if (this.#exited || this.#process === null || run.signal.aborted) return;
          throw this.#died(`stopped responding after ${idleTimeoutMs}ms`);
        }

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
    // Before the hooks are cleared, not after: clearing them was all `dispose`
    // used to do, which orphaned a run waiting on `#nextLine` for good — the
    // job stayed alive with nothing left that could ever settle it.
    this.#abandon?.();
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
    // A disposed transport has nothing left to wait for, and — having
    // released the process — nothing left that could settle a promise either.
    // Checked before `#abandon` can help, because `dispose` is very often
    // called while a run is between two awaits rather than inside this one.
    if (this.#process === null) return Promise.resolve(null);

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
        this.#abandon = null;
        if (timer !== undefined) clearTimeout(timer);
        resolve(value);
      };

      const timer =
        timeoutMs === undefined ? undefined : setTimeout(() => finish(null), timeoutMs);

      this.#onLine = (line) => finish(line);
      this.#onExit = () => finish(this.#pending.shift() ?? null);
      this.#abandon = () => finish(null);
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

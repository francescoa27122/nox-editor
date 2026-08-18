import { Signal } from '@core/signal';
import type { LanguageServerProcess, LanguageServerSpec, Platform } from '@platform/types';
import { JsonRpcTransport } from './transport';

/**
 * One language server, from spawn to exit.
 *
 * Takes a process factory rather than a command line — the same choice
 * `StdioTransport` makes, for the same payoff: the whole lifecycle is
 * testable against a fake process, including the cases that matter most and
 * are hardest to stage against a real server.
 *
 * The state machine is enforced rather than assumed, because two of its edges
 * are correctness rather than tidiness: nothing may be written before the
 * `initialize` reply arrives, and nothing may be written after the process is
 * gone.
 */

export type SessionStatus = 'idle' | 'initializing' | 'running' | 'failed' | 'stopped';

/** Whatever the server said it can do. Read, never assumed. */
export type ServerCapabilities = Record<string, unknown>;

/** What the server calls itself. Shown in the status bar. */
export interface ServerInfo {
  name: string;
  version?: string;
}

export interface SessionOptions {
  /** Shown in the status bar and in errors. */
  name: string;
  rootUri: string;
  timeoutMs?: number;
  /**
   * Passed to the server verbatim in `initialize`.
   *
   * Server-specific by definition, so Nox does not interpret it — but it is
   * the difference between a server that can be pointed at what it needs and
   * one that must be reinstalled. `typescript-language-server` takes
   * `tsserver.path` here.
   */
  initializationOptions?: unknown;
}

/** How many stderr lines to keep. Enough to explain a failed start. */
const STDERR_LINES = 20;

export class LspSession {
  readonly status = new Signal<SessionStatus>('idle');
  readonly capabilities = new Signal<ServerCapabilities | null>(null);
  readonly serverInfo = new Signal<ServerInfo | null>(null);

  /** Why it failed, when it did. */
  error: string | null = null;

  #open: () => Promise<LanguageServerProcess>;
  #options: SessionOptions;
  #process: LanguageServerProcess | null = null;
  #transport: JsonRpcTransport | null = null;
  /** Sends held until the handshake completes. */
  #queue: (() => void)[] = [];
  #stderr: string[] = [];
  #notificationHandlers = new Map<string, ((params: unknown) => void)[]>();
  #exitHandlers: ((code: number | null) => void)[] = [];
  #stopping = false;

  constructor(open: () => Promise<LanguageServerProcess>, options: SessionOptions) {
    this.#open = open;
    this.#options = options;
  }

  /** Start one through the platform. The normal way to build one. */
  static spawnedBy(
    platform: Platform,
    spec: LanguageServerSpec,
    options: SessionOptions,
  ): LspSession {
    return new LspSession(() => platform.startLanguageServer(spec), options);
  }

  get name(): string {
    return this.#options.name;
  }

  /** The last words of a server that died. Often the only explanation. */
  get stderr(): readonly string[] {
    return this.#stderr;
  }

  onExit(handler: (code: number | null) => void): void {
    this.#exitHandlers.push(handler);
  }

  /**
   * Subscribe to something the server says on its own initiative.
   *
   * Registered against the session rather than the transport so a caller can
   * subscribe before `start()` has built one — diagnostics arrive unasked, and
   * a subscriber that had to wait for the handshake would miss the first
   * batch of them.
   */
  onNotification(method: string, handler: (params: unknown) => void): void {
    const handlers = this.#notificationHandlers.get(method) ?? [];
    handlers.push(handler);
    this.#notificationHandlers.set(method, handlers);
    this.#transport?.onNotification(method, handler);
  }

  /**
   * Start the server and complete the handshake.
   *
   * Resolves either way — a server that cannot start is a state to render, not
   * an exception for every caller to handle.
   */
  async start(): Promise<void> {
    this.status.set('initializing');

    let server: LanguageServerProcess;
    try {
      server = await this.#open();
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : String(error));
      return;
    }

    this.#process = server;
    const transport = new JsonRpcTransport(
      (message) => server.send(message),
      { timeoutMs: this.#options.timeoutMs },
    );
    this.#transport = transport;

    // Subscribed before anything is sent. The process contract buffers what
    // arrived first, so this cannot miss the handshake.
    // Replayed onto the new transport, so anything subscribed before the
    // start is still subscribed after it.
    for (const [method, handlers] of this.#notificationHandlers) {
      for (const handler of handlers) transport.onNotification(method, handler);
    }

    server.onMessage((message) => transport.receive(message));
    server.onStderr((line) => {
      this.#stderr = [...this.#stderr.slice(-(STDERR_LINES - 1)), line];
    });
    server.onExit((code) => this.#exited(code));

    try {
      const result = await transport.request<{
        capabilities?: ServerCapabilities;
        serverInfo?: ServerInfo;
      }>('initialize', {
        processId: null,
        rootUri: this.#options.rootUri,
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          textDocument: {
            synchronization: { dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: false },
          },
        },
        // Nox advertises what it implements and nothing else. Claiming a
        // capability invites the server to use it.
        workspaceFolders: null,
        // Omitted rather than sent as null when unset: a server is entitled to
        // read a present-but-null field differently from an absent one.
        ...(this.#options.initializationOptions === undefined
          ? {}
          : { initializationOptions: this.#options.initializationOptions }),
      });

      this.capabilities.set(result.capabilities ?? {});
      this.serverInfo.set(result.serverInfo ?? null);
      await transport.notify('initialized', {});
      this.status.set('running');
      this.#flush();
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Ask, tell, then kill.
   *
   * The full sequence rather than a kill, because a server killed outright can
   * leave its own child running — `tsserver` does.
   */
  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;

    const transport = this.#transport;
    const server = this.#process;

    if (transport && this.status.get() === 'running') {
      // A server too broken to answer must not hold the window open, so a
      // failed or timed-out shutdown falls through to the kill below.
      try {
        await transport.request('shutdown');
      } catch {
        /* Answered or not, it is being stopped. */
      }
      try {
        await transport.notify('exit');
      } catch {
        /* Same. */
      }
    }

    transport?.dispose('the server was stopped');
    await server?.kill();
    this.status.set('stopped');
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    const transport = this.#transport;
    if (!transport || this.status.get() === 'failed' || this.status.get() === 'stopped') {
      throw new Error(`lsp: ${this.#options.name} is not running`);
    }

    if (this.status.get() === 'running') return transport.request<T>(method, params);

    // Held until the handshake completes rather than sent early: a server is
    // entitled to reject anything before initialize.
    return new Promise<T>((resolve, reject) => {
      this.#queue.push(() => {
        transport.request<T>(method, params).then(resolve, reject);
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const transport = this.#transport;
    if (!transport || this.status.get() === 'failed' || this.status.get() === 'stopped') return;

    if (this.status.get() === 'running') {
      await transport.notify(method, params);
      return;
    }

    this.#queue.push(() => void transport.notify(method, params));
  }

  #flush(): void {
    for (const send of this.#queue.splice(0)) send();
  }

  #fail(message: string): void {
    this.error = message;
    this.#transport?.dispose(message);
    this.status.set('failed');
    this.#queue.length = 0;
  }

  #exited(code: number | null): void {
    if (this.#stopping || this.status.get() === 'stopped') return;

    this.#fail(
      `${this.#options.name} exited${code === null ? '' : ` with code ${code}`}`,
    );
    for (const handler of this.#exitHandlers) handler(code);
  }
}

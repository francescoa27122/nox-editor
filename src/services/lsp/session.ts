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
  #requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();
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
   * Answer something the server *asks*, rather than tells.
   *
   * Against the session rather than the transport, for the reason
   * `onNotification` gives and then one more: a server may ask during the
   * handshake. `workspace/configuration` is the case that matters — pyright,
   * gopls and rust-analyzer all ask as they start, and one of them asks before
   * `initialized` has even been sent. A handler registered after `start()`
   * would arrive to find the question already answered `MethodNotFound` by
   * `JsonRpcTransport.#answer`, which is correct behaviour and a silently
   * unconfigured server.
   *
   * **Registering here is also what advertises the capability.** `start()`
   * derives the `initialize` reply's client capabilities from what is in this
   * map, so "Nox advertises what it implements and nothing else" is enforced
   * by construction rather than by remembering to edit two places.
   *
   * One handler per method, matching the transport: a second registration for
   * the same method replaces the first, because two answers to one question is
   * not a thing the protocol has.
   */
  onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.#requestHandlers.set(method, handler);
    this.#transport?.onRequest(method, handler);
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
    // Before `initialize` is written, not merely before the reply: a server is
    // entitled to ask its first question the moment it has been asked one.
    for (const [method, handler] of this.#requestHandlers) {
      transport.onRequest(method, handler);
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
          ...this.#clientCapabilities(),
          textDocument: {
            synchronization: { dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: false },
            // Rename Symbol asks `prepareRename` first when the server offers
            // it; tsserver offers it only to a client that says it will ask.
            rename: { prepareSupport: true },
            // Say that a `CodeAction` object is understood, or a server is
            // entitled to answer with the pre-3.8 bare `Command` shape — which
            // is the half Nox cannot run. The `valueSet` is deliberately empty:
            // the specification has it mean "no kinds are known to the client",
            // and Nox does not filter by kind, so claiming a list would be
            // claiming a behaviour it does not have.
            //
            // `resolveSupport` and `dataSupport` are **not** here, so a server
            // must send complete actions rather than stubs to resolve later.
            codeAction: {
              codeActionLiteralSupport: { codeActionKind: { valueSet: [] } },
              disabledSupport: true,
            },
          },
        },
        // Nox advertises what it implements and nothing else. Claiming a
        // capability invites the server to use it — which is why the workspace
        // block above is derived from the registered handlers rather than
        // written out here. Adding one without the other is the bug it
        // prevents, in both directions: a claim with no handler stalls or
        // degrades the server, and a handler with no claim is never asked.
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

  /**
   * The client capabilities that follow from what is actually handled.
   *
   * Each entry here is a promise the server will hold Nox to, so each is gated
   * on the handler that keeps it. `workspace.configuration` tells a server it
   * may ask for settings; a server told that and then answered
   * `MethodNotFound` is worse off than one never told, because it stops
   * looking for the settings anywhere else.
   */
  #clientCapabilities(): Record<string, unknown> {
    const workspace: Record<string, unknown> = {};
    if (this.#requestHandlers.has('workspace/configuration')) workspace.configuration = true;
    return Object.keys(workspace).length > 0 ? { workspace } : {};
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

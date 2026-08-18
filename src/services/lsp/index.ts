import type { LspPosition } from '@core/lsp-position';
import { Signal } from '@core/signal';
import { pathToUri, uriToPath } from '@core/uri';
import type { LanguageServerProcess, Platform } from '@platform/types';
import type { WorkspaceService } from '@services/workspace';
import { DocumentSync } from './documents';
import type { ServerConfig, ServerRegistry } from './registry';
import { LspSession, type SessionStatus } from './session';

export * from './registry';
export { LspSession, type SessionStatus } from './session';

/**
 * The language-server subsystem, as one object the app wires in.
 *
 * Owns a session per configured server, keeps their documents in step, and
 * holds the diagnostics they publish. Everything below it is testable on its
 * own; this is the part that decides how the pieces answer to each other.
 */

export interface LspDiagnostic {
  range: { start: LspPosition; end: LspPosition };
  /** 1 error, 2 warning, 3 information, 4 hint. */
  severity?: 1 | 2 | 3 | 4;
  message: string;
  source?: string;
  code?: string | number;
}

export interface SessionStatusRow {
  name: string;
  status: SessionStatus;
  /** Why it failed, when it did. */
  error: string | null;
  stderr: readonly string[];
}

export interface LspServiceOptions {
  /**
   * The workspace root, as a path. Becomes the LSP root URI.
   *
   * A getter rather than a value: the root is null until a folder opens, and
   * servers start when one does — capturing it at construction would give
   * every server a root of nowhere.
   */
  rootPath: () => string;
  open: (config: ServerConfig) => Promise<LanguageServerProcess>;
  /** Waits between restart attempts. Doubling, and capped by its own length. */
  backoffMs?: readonly number[];
}

/** 1s, 2s, 4s, then stop. Three attempts is enough to ride out a flap. */
const BACKOFF_MS = [1000, 2000, 4000] as const;

interface Running {
  config: ServerConfig;
  session: LspSession;
  sync: DocumentSync;
  /** URIs this server has published anything for. */
  published: Set<string>;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class LspService {
  readonly diagnostics = new Signal<ReadonlyMap<string, LspDiagnostic[]>>(new Map());
  readonly sessions = new Signal<SessionStatusRow[]>([]);

  #workspace: WorkspaceService;
  #registry: ServerRegistry;
  #options: LspServiceOptions;
  #running: Running[] = [];
  #stopping = false;

  constructor(
    workspace: WorkspaceService,
    registry: ServerRegistry,
    options: LspServiceOptions,
  ) {
    this.#workspace = workspace;
    this.#registry = registry;
    this.#options = options;
  }

  /** Build one backed by the platform. The normal way. */
  static spawnedBy(
    platform: Platform,
    workspace: WorkspaceService,
    registry: ServerRegistry,
    rootPath: () => string,
  ): LspService {
    return new LspService(workspace, registry, {
      rootPath,
      open: (config) =>
        platform.startLanguageServer({
          command: config.command,
          args: config.args,
          cwd: rootPath(),
        }),
    });
  }

  diagnosticsFor(uri: string): LspDiagnostic[] {
    return this.diagnostics.get().get(uri) ?? [];
  }

  /** Start a session for every configured server. */
  async start(): Promise<void> {
    this.#stopping = false;
    await Promise.all(this.#registry.servers.get().map((config) => this.#startOne(config, 0)));
    this.#publishStatus();
  }

  /** Stop everything and forget every diagnostic. */
  async stop(): Promise<void> {
    this.#stopping = true;

    const running = this.#running.splice(0);
    for (const entry of running) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.sync.dispose();
    }
    await Promise.all(running.map((entry) => entry.session.stop()));

    this.diagnostics.set(new Map());
    this.sessions.set([]);
  }

  async #startOne(config: ServerConfig, attempts: number): Promise<void> {
    const session = new LspSession(() => this.#options.open(config), {
      name: config.command,
      rootUri: pathToUri(this.#options.rootPath()),
      initializationOptions: config.initializationOptions,
    });

    const entry: Running = {
      config,
      session,
      sync: new DocumentSync(this.#workspace),
      published: new Set(),
      attempts,
      timer: null,
    };
    this.#running.push(entry);

    // Subscribed before the start, because diagnostics arrive unasked and a
    // server can publish its first batch during the handshake.
    session.onNotification('textDocument/publishDiagnostics', (params) => {
      this.#publishDiagnostics(entry, params);
    });
    session.onExit(() => this.#died(entry));

    await session.start();

    if (session.status.get() === 'running') {
      entry.sync.attach(session, config.languages);
    }
    this.#publishStatus();
  }

  #publishDiagnostics(entry: Running, params: unknown): void {
    const payload = params as
      | { uri?: string; version?: number; diagnostics?: LspDiagnostic[] }
      | undefined;
    if (!payload?.uri) return;

    const { uri, diagnostics = [] } = payload;

    // A batch computed for a revision the buffer has already left describes
    // text nobody is looking at any more. The version field is *optional*,
    // though, so its absence cannot mean "stale" — a server that omits it
    // would otherwise never produce a single visible diagnostic.
    if (payload.version !== undefined) {
      const current = this.#revisionOf(uri);
      if (current !== null && payload.version < current) return;
    }

    const next = new Map(this.diagnostics.get());
    if (diagnostics.length === 0) {
      next.delete(uri);
      entry.published.delete(uri);
    } else {
      next.set(uri, diagnostics);
      entry.published.add(uri);
    }
    this.diagnostics.set(next);
  }

  /** The revision of the buffer this URI names, or null when none is open. */
  #revisionOf(uri: string): number | null {
    let path: string;
    try {
      path = uriToPath(uri);
    } catch {
      return null;
    }

    const buffer = this.#workspace.buffers.get().find((candidate) => candidate.path === path);
    return buffer ? buffer.revision : null;
  }

  #died(entry: Running): void {
    // Cleared first. A squiggle that outlives the server that produced it is a
    // claim about the code that nothing is standing behind any more.
    this.#clearPublished(entry);
    this.#publishStatus();

    if (this.#stopping) return;

    const backoff = this.#options.backoffMs ?? BACKOFF_MS;
    if (entry.attempts >= backoff.length) {
      // Stays down, and says so. A silent respawn loop burns a core and never
      // explains itself.
      return;
    }

    const wait = backoff[entry.attempts]!;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.sync.dispose();
      this.#running = this.#running.filter((candidate) => candidate !== entry);
      void this.#startOne(entry.config, entry.attempts + 1);
    }, wait);
  }

  #clearPublished(entry: Running): void {
    if (entry.published.size === 0) return;

    const next = new Map(this.diagnostics.get());
    for (const uri of entry.published) next.delete(uri);
    entry.published.clear();
    this.diagnostics.set(next);
  }

  #publishStatus(): void {
    this.sessions.set(
      this.#running.map((entry) => ({
        name: entry.session.name,
        status: entry.session.status.get(),
        error: entry.session.error,
        stderr: entry.session.stderr,
      })),
    );
  }
}

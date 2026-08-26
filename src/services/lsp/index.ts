import type { LspPosition } from '@core/lsp-position';
import { Signal } from '@core/signal';
import { configurationReply } from '@core/lsp-configuration';
import { applyProgress, progressEvent, type WorkDone } from '@core/lsp-progress';
import { pathToUri, uriToPath } from '@core/uri';
import type { LanguageServerProcess, Platform } from '@platform/types';
import type { WorkspaceService } from '@services/workspace';
import { DocumentSync } from './documents';
import type { ServerConfig, ServerRegistry } from './registry';
import { LspSession, type ServerCapabilities, type SessionStatus } from './session';

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
  /**
   * The language ids this server answers for, as `BufferSnapshot.languageId`
   * spells them.
   *
   * Carried on the row rather than looked up from the registry by whoever is
   * rendering, because a row describes a *running* session and the registry
   * describes the file on disk: `lsp.reload` can leave the two disagreeing
   * for as long as it takes the old sessions to die. Without this the status
   * bar had no way to tell whether the server it was naming had anything to
   * do with the file in front of the user, and named it anyway.
   */
  languages: readonly string[];
  /** Why it failed, when it did. */
  error: string | null;
  stderr: readonly string[];
  /**
   * What the server is busy with, oldest first.
   *
   * Empty for a server that is idle or one that never reports progress, which
   * is most of them — tsserver says nothing here. It is rust-analyzer and
   * gopls that spend thirty seconds indexing before they can answer anything,
   * and this is the difference between that looking like work and looking
   * like a hang.
   */
  progress: readonly WorkDone[];
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
  /**
   * Apply a `WorkspaceEdit` the server asked for, and say whether it landed.
   *
   * An option rather than something this service does itself, and the split is
   * the one the whole codebase runs on: the protocol is here, the **policy**
   * is not. Whether a server-named command may write to a file you have not
   * opened is a decision about the user's work, and it belongs where the other
   * such decisions live — beside the code-action rule it has to match.
   *
   * Absent means the capability is not advertised at all, so a server never
   * asks. That is the honest default: a client that claimed `applyEdit` and
   * then always answered `applied: false` would be worse than one that never
   * claimed it, because the server would have already thrown away whatever it
   * was going to do instead.
   */
  applyWorkspaceEdit?: (edit: unknown, serverName: string) => Promise<boolean>;
}

/** 1s, 2s, 4s, then stop. Three attempts is enough to ride out a flap. */
const BACKOFF_MS = [1000, 2000, 4000] as const;

interface Running {
  config: ServerConfig;
  session: LspSession;
  sync: DocumentSync;
  /** URIs this server has published anything for. */
  published: Set<string>;
  /** Work-done progress in flight, keyed by token. Replaced, never mutated. */
  progress: ReadonlyMap<string, WorkDone>;
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
    applyWorkspaceEdit?: (edit: unknown, serverName: string) => Promise<boolean>,
  ): LspService {
    return new LspService(workspace, registry, {
      rootPath,
      open: (config) =>
        platform.startLanguageServer({
          command: config.command,
          args: config.args,
          cwd: rootPath(),
        }),
      // Optional so a caller that has no policy for it — a test, or anything
      // that only wants diagnostics — does not advertise a capability it
      // cannot honour.
      ...(applyWorkspaceEdit ? { applyWorkspaceEdit } : {}),
    });
  }

  diagnosticsFor(uri: string): LspDiagnostic[] {
    return this.diagnostics.get().get(uri) ?? [];
  }

  /**
   * The running session serving this language, if there is one.
   *
   * Only `running` counts. A session that is still initializing would queue
   * the request behind a cold start, and one that has failed would never
   * answer at all — both arrive long after the keystroke that asked.
   */
  #sessionFor(languageId: string): LspSession | null {
    const entry = this.#running.find(
      (candidate) =>
        candidate.config.languages.includes(languageId) &&
        candidate.session.status.get() === 'running',
    );
    return entry?.session ?? null;
  }

  /** What the server serving this language can do, or null when none is. */
  capabilitiesFor(languageId: string): ServerCapabilities | null {
    return this.#sessionFor(languageId)?.capabilities.get() ?? null;
  }

  /**
   * Ask the server serving `languageId`.
   *
   * Rejects rather than resolving empty when nothing is running: a caller
   * that cannot tell "nothing configured" from "nothing to suggest" shows the
   * user an empty picker for both, and only one of those is worth fixing.
   */
  async requestFor<T>(languageId: string, method: string, params: unknown): Promise<T> {
    const entry = this.#running.find(
      (candidate) =>
        candidate.config.languages.includes(languageId) &&
        candidate.session.status.get() === 'running',
    );
    if (!entry) throw new Error(`lsp: no language server for ${languageId}`);

    // Before asking, never after. Document changes are debounced so a server's
    // copy stays roughly current while someone types — but every request here
    // is *about* the document, and completion fires on the keystroke, well
    // inside that window. A server that has not been sent the change answers
    // about the text it still holds: `console.` returned 2010 globals rather
    // than 20 members, measured against a real tsserver. Hover, definition
    // and rename would each have found this separately.
    entry.sync.flush();

    return entry.session.request<T>(method, params);
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
      progress: new Map(),
      attempts,
      timer: null,
    };
    this.#running.push(entry);

    // Subscribed before the start, because diagnostics arrive unasked and a
    // server can publish its first batch during the handshake.
    session.onNotification('textDocument/publishDiagnostics', (params) => {
      this.#publishDiagnostics(entry, params);
    });

    /**
     * Registered before the start for a stronger reason than diagnostics:
     * pyright, gopls and rust-analyzer all ask this *during* the handshake,
     * and one of them asks before `initialized` goes out. It is also what
     * makes `LspSession` advertise `workspace.configuration` at all — see
     * `#clientCapabilities` there.
     *
     * Answering from the config rather than from Nox's own settings is the
     * whole design: these are a particular server's options, spelled the way
     * that server spells them, and Nox has no business having an opinion about
     * `python.analysis.typeCheckingMode`. A server with no `settings` block
     * gets `null` for everything, which is exactly what it saw before this
     * existed — so adding the handler cannot change what a working
     * configuration does.
     */
    session.onRequest('workspace/configuration', (params) =>
      Promise.resolve(configurationReply(params, config.settings)),
    );

    /**
     * Reserving a progress token. The reply is the whole handler — there is
     * nothing to set up, because `$/progress` carries the token again and
     * `applyProgress` keys on it.
     *
     * It exists to be *refusable*: a client that cannot render progress should
     * say so here, and a server that is refused does not then flood the
     * connection with notifications nobody reads. Answering it is also what
     * makes `LspSession` advertise `window.workDoneProgress`.
     */
    session.onRequest('window/workDoneProgress/create', () => Promise.resolve(null));

    /**
     * The other half of running a server command. Nox sends
     * `workspace/executeCommand`; the server does its work and asks *back*
     * with the edit it wants applied, and the reply says whether it landed.
     *
     * `applied: false` matters to a server — several will report a failure to
     * the user or roll back their own state — so a refusal has to be honest
     * rather than a swallowed exception.
     */
    const apply = this.#options.applyWorkspaceEdit;
    if (apply) {
      session.onRequest('workspace/applyEdit', async (params) => {
        const edit = (params as { edit?: unknown } | null)?.edit;
        const applied = await apply(edit, config.command);
        return { applied };
      });
    }

    session.onNotification('$/progress', (params) => {
      const event = progressEvent(params);
      if (!event) return;
      const next = applyProgress(entry.progress, event);
      // Republishing on every `report` is what makes a percentage move, and
      // those arrive a few times a second at most — this is not a typing path.
      entry.progress = next;
      this.#publishStatus();
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
        languages: entry.config.languages,
        error: entry.session.error,
        stderr: entry.session.stderr,
        progress: [...entry.progress.values()],
      })),
    );
  }
}

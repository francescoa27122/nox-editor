import { contributedCommandId, type PluginManifest } from '@core/plugin-manifest';
import { Signal } from '@core/signal';
import type { CommandRegistry } from '../commands';
import type { Capability, Principal } from '../permissions';
import type { Edit } from '../transactions';
import type { BufferId } from '../workspace';
import { PluginStatusStore } from './status';
import {
  failure,
  isResponse,
  parseInbound,
  PLUGIN_PROTOCOL_VERSION,
  type PluginRequest,
  type Response,
} from './protocol';

/**
 * The plugin host: what a plugin is allowed to be, and what happens when it
 * is not.
 *
 * Structurally this is `services/agent/stdio.ts`'s lesson applied a second
 * time — it takes a `connect` function, never a command line — and the payoff
 * is the same: a plugin that never answers, one speaking the wrong protocol
 * version, one that dies mid-command, are all *written down* in
 * `tests/plugin-host.test.ts` rather than staged with a real process.
 *
 * Three rules shape everything here.
 *
 * **Contributions come from the manifest, not from a handshake.** So a
 * plugin's commands exist in the palette before it has run, and it starts on
 * the first invoke. Nothing a user never uses costs them a process at launch.
 *
 * **The only route to a side effect is `command.execute`.** There is no verb
 * for "write this file". Every write a plugin can reach is a command, and a
 * command is checked in the dispatcher against a `{ kind: 'plugin' }`
 * principal — which is the whole reason `permissions.ts` had that principal
 * before any plugin existed.
 *
 * **Nothing here touches the typing path.** Every call is async and
 * demand-driven, and there is no seam through which a plugin could run per
 * keystroke. That is the roadmap's design gate held structurally rather than
 * requested.
 */

/**
 * A plugin, as lines.
 *
 * Structurally `AgentProcess` — deliberately, because that interface already
 * has no protocol knowledge (*"this moves lines"*), so a child process
 * satisfies it as-is and a worker satisfies it with an adapter. Restated here
 * rather than imported so the host does not depend on the agent platform for
 * a shape that is really just a pipe.
 */
export interface PluginConnection {
  send(line: string): Promise<void>;
  onLine(handler: (line: string) => void): void;
  onStderr(handler: (line: string) => void): void;
  onExit(handler: (code: number | null) => void): void;
  kill(): Promise<void>;
}

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  /** Absolute path to the plugin's own folder; a worker entry resolves inside it. */
  directory: string;
}

export type PluginState =
  /** Known and registered, nothing running. The state most plugins are in. */
  | 'idle'
  | 'starting'
  | 'running'
  /** The last attempt failed. Still invokable — one crash is an accident. */
  | 'failed'
  /** Repeatedly failed. Commands withdrawn; only a reload brings it back. */
  | 'disabled';

/** Just enough of `ContextService` to answer a read. */
export interface PluginContext {
  reader(principal: Principal): {
    openBuffers(): unknown;
    bufferText(id: BufferId, options?: { lines?: { from: number; to: number } }): string | null;
    selection(id: BufferId): unknown;
  };
}

export interface PluginHostDeps {
  commands: CommandRegistry;
  context: PluginContext;
  /** Offer a change set for review. Returns whether it was staged. */
  stage(spec: {
    description: string;
    author: Principal;
    edits: Edit[];
    baseRevisions?: ReadonlyMap<BufferId, number>;
  }): boolean;
  notify(title: string, detail?: string): void;
  connect(plugin: DiscoveredPlugin): Promise<PluginConnection>;
  handshakeTimeoutMs?: number;
  invokeTimeoutMs?: number;
}

const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * How long an invoked command may go without the plugin answering.
 *
 * Shorter than the agent runtime's five minutes, and for a concrete reason: an
 * agent's silence is usually a model thinking, while a plugin command is
 * ordinary code. A minute of nothing is a plugin that has stopped.
 */
const INVOKE_TIMEOUT_MS = 60_000;

/**
 * Consecutive failures before a plugin is put away.
 *
 * The same shape as the agent runner's `max_failures`: retry a couple of
 * times, because a crash can be a transient, then stop — a command certain to
 * fail is a row in the palette that lies about what the editor can do.
 */
const MAX_FAILURES = 3;

interface Loaded {
  plugin: DiscoveredPlugin;
  principal: Principal;
  /** Withdraws every command this plugin contributed. */
  dispose: () => void;
  state: PluginState;
  connection: PluginConnection | null;
  failures: number;
  nextId: number;
  pending: Map<number, { resolve: (r: Response) => void; timer: ReturnType<typeof setTimeout> }>;
  /** Set only while a handshake is outstanding. */
  helloWaiter?: (version: number) => void;
  /**
   * The version a greeting carried, if one has arrived.
   *
   * Recorded rather than only delivered, because the greeting routinely lands
   * *before* anyone is waiting for it: a plugin writes it in the tick it
   * starts, the connection replays its buffer the moment a handler attaches,
   * and that is one statement earlier than the handshake's own promise. The
   * same shape as `AgentProcess.onLine`'s buffering rule, one layer up.
   */
  helloVersion?: number;
}

export class PluginHost {
  /** Bumped whenever a plugin's state changes, so a panel could watch it. */
  readonly revision = new Signal(0);

  /**
   * What plugins have put on the status bar.
   *
   * Owned here rather than passed in, because its lifetime is exactly a
   * plugin's: every path that stops one has to take its items back, and a
   * store held somewhere else would be a second place to remember that.
   */
  readonly status = new PluginStatusStore();

  #deps: PluginHostDeps;
  #loaded = new Map<string, Loaded>();

  constructor(deps: PluginHostDeps) {
    this.#deps = deps;
  }

  /**
   * Register what discovery found.
   *
   * Registration is the whole of loading. Nothing starts, nothing is asked —
   * the manifest already said what the commands are.
   */
  load(discovered: readonly DiscoveredPlugin[]): void {
    for (const entry of discovered) {
      if (this.#loaded.has(entry.manifest.id)) continue;

      const principal: Principal = { kind: 'plugin', pluginId: entry.manifest.id };
      const capabilities = entry.manifest.capabilities as readonly Capability[];

      const dispose = this.#deps.commands.registerAll(
        entry.manifest.commands.map((command) => ({
          id: contributedCommandId(entry.manifest.id, command.name),
          title: command.title,
          category: entry.manifest.label,
          // The manifest's declaration, verbatim. This is what the dispatcher
          // enforces and what the user read before allowing the plugin, and
          // the two being the same list is the point.
          ...(capabilities.length > 0 ? { capabilities } : {}),
          run: async () => {
            await this.invoke(entry.manifest.id, command.name);
          },
        })),
      );

      this.#loaded.set(entry.manifest.id, {
        plugin: entry,
        principal,
        dispose,
        state: 'idle',
        connection: null,
        failures: 0,
        nextId: 1,
        pending: new Map(),
      });
    }
    this.revision.update((n) => n + 1);

    // Eager plugins start now. Deliberately after every registration above, so
    // one that starts and immediately invokes a sibling's command finds it —
    // and deliberately not awaited, because loading must not wait on a plugin
    // that is slow to greet.
    for (const entry of this.#loaded.values()) {
      if (entry.plugin.manifest.activation !== 'startup' || entry.state !== 'idle') continue;
      void this.#ensureRunning(entry);
    }
  }

  stateOf(pluginId: string): PluginState | null {
    return this.#loaded.get(pluginId)?.state ?? null;
  }

  /** Every plugin and what it is doing, for a panel or a diagnostic. */
  list(): { id: string; label: string; state: PluginState }[] {
    return [...this.#loaded.values()].map((entry) => ({
      id: entry.plugin.manifest.id,
      label: entry.plugin.manifest.label,
      state: entry.state,
    }));
  }

  /** Run one contributed command, starting the plugin if it is not up. */
  async invoke(pluginId: string, name: string, arg?: unknown): Promise<void> {
    const entry = this.#loaded.get(pluginId);
    if (!entry || entry.state === 'disabled') return;

    const connection = await this.#ensureRunning(entry);
    if (!connection) return;

    const response = await this.#request(entry, connection, {
      method: 'command.invoke',
      params: arg === undefined ? { name } : { name, arg },
    });

    if (!response.ok) {
      this.#fail(entry, `${entry.plugin.manifest.label} could not run that`, response.error.message);
      return;
    }
    // A command that answered is a plugin that works, whatever went before.
    entry.failures = 0;
  }

  /** Stop everything and take every contributed command back. */
  async stopAll(): Promise<void> {
    const running = [...this.#loaded.values()];
    this.#loaded.clear();
    this.revision.update((n) => n + 1);

    await Promise.all(
      running.map(async (entry) => {
        entry.dispose();
        this.status.clearFor(entry.plugin.manifest.id);
        this.#settleAll(entry, 'internal', 'Nox is shutting the plugin down');
        await entry.connection?.kill().catch(() => {});
      }),
    );
  }

  /** Start a plugin and complete its handshake, or report why not. */
  async #ensureRunning(entry: Loaded): Promise<PluginConnection | null> {
    if (entry.state === 'running' && entry.connection) return entry.connection;

    entry.state = 'starting';
    // A previous connection's greeting says nothing about this one's.
    entry.helloVersion = undefined;
    this.revision.update((n) => n + 1);

    let connection: PluginConnection;
    try {
      connection = await this.#deps.connect(entry.plugin);
    } catch (error) {
      this.#fail(
        entry,
        `${entry.plugin.manifest.label} could not be started`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }

    entry.connection = connection;
    connection.onLine((line) => this.#receive(entry, line));
    connection.onStderr(() => {
      // Diagnostics, never protocol — the same split `AgentProcess` documents.
      // Deliberately not surfaced: a plugin logging to stderr is normal, and a
      // toast per line would make a chatty plugin unusable.
    });
    connection.onExit(() => {
      entry.connection = null;
      // Its readouts stopped being true the moment it stopped. Nothing is left
      // running to correct them, so they go with it.
      this.status.clearFor(entry.plugin.manifest.id);
      // Every question still outstanding dies with it. Without this an invoke
      // waits out its whole timeout on a process that is already gone.
      this.#settleAll(entry, 'internal', 'the plugin stopped');
      if (entry.state !== 'disabled') {
        entry.state = 'failed';
        this.revision.update((n) => n + 1);
      }
    });

    const hello = await this.#awaitHello(entry);
    if (hello !== null) {
      this.#fail(entry, `${entry.plugin.manifest.label} was not started`, hello);
      await connection.kill().catch(() => {});
      entry.connection = null;
      return null;
    }

    entry.state = 'running';
    this.revision.update((n) => n + 1);
    return connection;
  }

  /** Null when the greeting was good; otherwise the reason it was not. */
  #awaitHello(entry: Loaded): Promise<string | null> {
    return new Promise((resolve) => {
      // Already greeted, before this promise existed. See `helloVersion`.
      if (entry.helloVersion !== undefined) {
        resolve(this.#versionVerdict(entry.helloVersion));
        return;
      }

      const timer = setTimeout(() => {
        entry.helloWaiter = undefined;
        resolve('it did not introduce itself in time');
      }, this.#deps.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);

      entry.helloWaiter = (version: number) => {
        clearTimeout(timer);
        entry.helloWaiter = undefined;
        resolve(this.#versionVerdict(version));
      };
    });
  }

  /** Null when the version is one Nox speaks; otherwise why it is not. */
  #versionVerdict(version: number): string | null {
    return version === PLUGIN_PROTOCOL_VERSION
      ? null
      : `it speaks plugin protocol ${version}; this Nox speaks ${PLUGIN_PROTOCOL_VERSION}`;
  }

  /** Send a request and wait for its answer, or for the deadline. */
  #request(
    entry: Loaded,
    connection: PluginConnection,
    body: { method: string; params?: unknown },
  ): Promise<Response> {
    const id = entry.nextId++;
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        entry.pending.delete(id);
        resolve(failure(id, 'timeout', 'the plugin did not answer'));
      }, this.#deps.invokeTimeoutMs ?? INVOKE_TIMEOUT_MS);

      entry.pending.set(id, { resolve, timer });
      void connection.send(`${JSON.stringify({ id, ...body })}\n`).catch(() => {
        const waiter = entry.pending.get(id);
        if (!waiter) return;
        entry.pending.delete(id);
        clearTimeout(waiter.timer);
        resolve(failure(id, 'internal', 'the plugin could not be written to'));
      });
    });
  }

  /** One line from a plugin: an answer to us, or a question for us. */
  #receive(entry: Loaded, line: string): void {
    const message = parseInbound(line);
    // A stray `console.log` costs its line and nothing else. This is the most
    // likely thing to go wrong when writing a plugin, and it must not look
    // like a protocol failure.
    if (message === null) return;

    if (isResponse(message)) {
      const waiter = entry.pending.get(message.id);
      if (!waiter) return;
      entry.pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }

    if (message.method === 'hello') {
      const version = (message.params as { version?: unknown } | undefined)?.version;
      entry.helloVersion = typeof version === 'number' ? version : -1;
      entry.helloWaiter?.(entry.helloVersion);
      void this.#reply(entry, { id: message.id, ok: true });
      return;
    }

    void this.#serve(entry, message);
  }

  /** Answer a plugin's question. */
  async #serve(entry: Loaded, request: PluginRequest): Promise<void> {
    const reader = this.#deps.context.reader(entry.principal);

    try {
      switch (request.method) {
        case 'context.openBuffers':
          return await this.#reply(entry, { id: request.id, ok: true, result: reader.openBuffers() });

        case 'context.bufferText': {
          const text = reader.bufferText(
            request.params.bufferId,
            request.params.lines ? { lines: request.params.lines } : undefined,
          );
          return await this.#reply(
            entry,
            text === null
              ? failure(request.id, 'not-found', 'no such buffer')
              : { id: request.id, ok: true, result: text },
          );
        }

        case 'context.selection':
          return await this.#reply(entry, {
            id: request.id,
            ok: true,
            result: reader.selection(request.params.bufferId),
          });

        case 'command.execute': {
          // The one door to a side effect, and it is the *same* door the
          // palette uses — so the permission check cannot be bypassed by
          // finding another route, because there is not one.
          const ran = await this.#deps.commands.execute(
            request.params.commandId,
            request.params.arg,
            { principal: entry.principal },
          );
          return await this.#reply(
            entry,
            ran
              ? { id: request.id, ok: true }
              : failure(request.id, 'not-found', `no command "${request.params.commandId}"`),
          );
        }

        case 'proposal.stage': {
          const staged = this.#deps.stage({
            description: request.params.description,
            author: entry.principal,
            edits: request.params.edits,
            ...(request.params.baseRevisions
              ? {
                  // A plain object on the wire, a `Map` in `ChangeSetSpec` —
                  // converted here, at the boundary, for the reason the agent
                  // protocol gives: a `Map` serialises to `{}`.
                  baseRevisions: new Map(Object.entries(request.params.baseRevisions)),
                }
              : {}),
          });
          return await this.#reply(
            entry,
            staged
              ? { id: request.id, ok: true }
              : failure(request.id, 'stale', 'the edits did not apply to the buffers as they are'),
          );
        }

        case 'status.set':
          this.status.set(entry.plugin.manifest.id, request.params);
          return await this.#reply(entry, { id: request.id, ok: true });

        case 'status.clear':
          this.status.clear(entry.plugin.manifest.id, request.params.name);
          return await this.#reply(entry, { id: request.id, ok: true });

        case 'hello':
          // Answered in `#receive`. A second one is a plugin restating itself.
          return;

        default: {
          // Exhaustiveness: adding a method without handling it fails to
          // compile. An unknown one from the wire lands here too, and is told
          // so rather than ignored — a plugin that learns what it got wrong
          // can be fixed.
          const unknown: never = request;
          void unknown;
          return await this.#reply(
            entry,
            failure(
              (request as { id: number }).id,
              'unknown-method',
              `no such method "${(request as { method: string }).method}"`,
            ),
          );
        }
      }
    } catch (error) {
      await this.#reply(
        entry,
        failure(
          request.id,
          error instanceof Error && /denied/i.test(error.message) ? 'permission-denied' : 'internal',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  async #reply(entry: Loaded, response: Response): Promise<void> {
    await entry.connection?.send(`${JSON.stringify(response)}\n`).catch(() => {
      // The plugin went away between asking and being answered. Nothing to do
      // and nothing worth saying: its exit handler already reported it.
    });
  }

  /** Record a failure, and put the plugin away if it keeps happening. */
  #fail(entry: Loaded, title: string, detail: string): void {
    entry.failures += 1;

    if (entry.failures >= MAX_FAILURES) {
      entry.state = 'disabled';
      entry.dispose();
      this.status.clearFor(entry.plugin.manifest.id);
      void entry.connection?.kill().catch(() => {});
      entry.connection = null;
      this.#deps.notify(
        `${entry.plugin.manifest.label} disabled after ${entry.failures} failures`,
        `${detail}. Fix it and run Reload Plugins.`,
      );
    } else {
      entry.state = 'failed';
      this.#deps.notify(title, detail);
    }
    this.revision.update((n) => n + 1);
  }

  /** Settle every outstanding request, so nothing waits on a dead plugin. */
  #settleAll(entry: Loaded, code: 'internal', message: string): void {
    for (const [id, waiter] of entry.pending) {
      clearTimeout(waiter.timer);
      waiter.resolve(failure(id, code, message));
    }
    entry.pending.clear();
  }
}

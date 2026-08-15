import { Signal } from '@core/signal';
import type { CommandRegistry } from '../commands';
import type { ContextService } from '../context';
import type { JobRunner } from '../jobs';
import { PermissionError, type PermissionService, type Principal } from '../permissions';
import type { ReviewService, StagedChangeSet } from '../review';
import type { ChangeSetId } from '../transactions';
import type { BufferId, WorkspaceService } from '../workspace';
import type { ModelProvider } from './provider';
import {
  failure,
  success,
  type AgentRequest,
  type AgentRun,
  type AgentTransport,
  type CoreResponse,
  type Handshake,
  PROTOCOL_VERSION,
} from './protocol';

/**
 * The agent runtime.
 *
 * Almost all of this is wiring, and that is the point: an agent reads through
 * `ContextService`, acts through `CommandRegistry` under `PermissionService`,
 * proposes through `ReviewService`, applies through `workspace.apply`, runs
 * under `JobRunner`, and is undone by `undoChangeSet`. Every one of those
 * existed and was tested before this file did. If the runtime needed a
 * privileged path of its own, that would be the sign the platform underneath
 * it was wrong.
 *
 * See AGENT-PLATFORM.md §3.
 */

export type SessionStatus =
  | 'running'
  /** Finished, and its proposal is waiting for a human to decide. */
  | 'awaiting-review'
  /** The user kept some or all of it. */
  | 'applied'
  /** The user turned the proposal down. */
  | 'dismissed'
  /** Finished without proposing anything. */
  | 'done'
  | 'cancelled'
  | 'failed';

/** One thing that happened, in order. The audit trail. */
export type AgentAction =
  | { kind: 'instruction'; at: number; text: string }
  | { kind: 'note'; at: number; text: string }
  | { kind: 'read'; at: number; method: string; target?: string }
  | {
      kind: 'command';
      at: number;
      commandId: string;
      granted: boolean;
      detail?: string;
    }
  | {
      kind: 'proposal';
      at: number;
      description: string;
      files: number;
      hunks: number;
    }
  | { kind: 'summary'; at: number; text: string }
  | { kind: 'error'; at: number; message: string };

/**
 * An action minus its timestamp, which the recorder stamps.
 *
 * `Omit` over a union collapses to the keys every member shares, which for
 * `AgentAction` is just `kind` — so this distributes over the union first.
 */
type NewAction = AgentAction extends infer T
  ? T extends AgentAction
    ? Omit<T, 'at'>
    : never
  : never;

export interface AgentSession {
  readonly id: string;
  readonly label: string;
  readonly instruction: string;
  readonly principal: Principal;
  readonly status: Signal<SessionStatus>;
  readonly actions: Signal<AgentAction[]>;
  readonly summary: Signal<string | null>;
  cancel(): void;
}

/**
 * A session as the UI sees it: plain data, republished whenever anything
 * about the session changes.
 *
 * The session object keeps `Signal`s for programmatic callers, but a component
 * cannot subscribe to a store it finds inside an `{#each}` — and publishing
 * snapshots is how every other service here feeds the interface anyway.
 */
export interface AgentSessionSnapshot {
  id: string;
  label: string;
  instruction: string;
  status: SessionStatus;
  actions: AgentAction[];
  summary: string | null;
  /** How many change sets this session has landed. */
  changes: number;
}

export interface SessionOptions {
  /** Shown as the agent's name. Defaults to the transport's handshake. */
  label?: string;
}

export class AgentRuntime {
  readonly sessions = new Signal<AgentSessionSnapshot[]>([]);
  /**
   * Model providers available to start a session with.
   *
   * Empty until something registers one. Nox ships no provider: shipping a
   * default would mean shipping a vendor, and the whole point of the interface
   * is that the core does not name one.
   */
  readonly providers = new Signal<ModelProvider[]>([]);

  #workspace: WorkspaceService;
  #context: ContextService;
  #commands: CommandRegistry;
  #permissions: PermissionService;
  #review: ReviewService;
  #jobs: JobRunner;
  #live: AgentSession[] = [];
  #nextSession = 1;

  constructor(services: {
    workspace: WorkspaceService;
    context: ContextService;
    commands: CommandRegistry;
    permissions: PermissionService;
    review: ReviewService;
    jobs: JobRunner;
  }) {
    this.#workspace = services.workspace;
    this.#context = services.context;
    this.#commands = services.commands;
    this.#permissions = services.permissions;
    this.#review = services.review;
    this.#jobs = services.jobs;

    // A session's change count moves when the *user* applies its proposal,
    // which is not a session event — without this the panel would never offer
    // to undo the thing it had just helped land.
    this.#workspace.log.entries.subscribe(() => {
      // Deciding is the end of the session's story. Leaving it on "awaiting
      // review" after the user has already applied it describes a state that
      // stopped being true the moment they clicked.
      for (const session of this.#live) {
        if (session.status.get() === 'awaiting-review' && this.changesBy(session.id).length > 0) {
          session.status.set('applied');
        }
      }
      this.#publish();
    });

    // The other way a proposal can end: turned down. `staged` going to null
    // with nothing recorded in the log means nothing was kept.
    let previouslyStaged: StagedChangeSet | null = null;
    this.#review.staged.subscribe((staged) => {
      const gone = previouslyStaged;
      previouslyStaged = staged;
      if (staged !== null || gone === null) return;
      // Held in a local: narrowing a property does not survive into the
      // closure below, because TypeScript cannot know it stayed an agent.
      const author = gone.author;
      if (author.kind !== 'agent') return;

      const session = this.#live.find((entry) => entry.id === author.sessionId);
      if (!session || session.status.get() !== 'awaiting-review') return;
      // Applying records a change set *before* clearing `staged`, so anything
      // still without one here was rejected rather than kept.
      if (this.changesBy(session.id).length === 0) session.status.set('dismissed');
      this.#publish();
    });
  }

  /**
   * Start a session. Returns as soon as it is running.
   *
   * Concurrent sessions are allowed and deliberately not serialised. Two
   * agents editing the same buffer is resolved where it is actually
   * decidable, in two places: `proposal.stage` below rejects an edit against
   * a buffer that moved since this session read its text or its selection,
   * and whatever gets past that still has to clear `workspace.apply`, which
   * rejects whichever one is working from a revision that has moved. Locking
   * would block the user's own typing, and queueing would hide the staleness
   * until after the edit landed.
   */
  start(
    transport: AgentTransport,
    instruction: string,
    options: SessionOptions = {},
  ): AgentSession {
    const id = `agent-${this.#nextSession++}`;
    const actions = new Signal<AgentAction[]>([]);
    const status = new Signal<SessionStatus>('running');
    const summary = new Signal<string | null>(null);

    const record = (action: NewAction) => {
      actions.update((current) => [...current, { ...action, at: Date.now() } as AgentAction]);
      this.#publish();
    };

    record({ kind: 'instruction', text: instruction });

    /**
     * The revision each buffer was at when this session last had a trustworthy
     * view of where its text sits: refreshed by a read that hands back the
     * whole document, and otherwise established by the first read that hands
     * back any position in it.
     *
     * An agent that reads a buffer and then proposes an edit against it is
     * working from a snapshot, and between the two the *user* is still typing.
     * Nothing else catches that: the offsets are arithmetically valid, the
     * quote that produced them was unique in the text the agent was shown, and
     * `ReviewFile.baseRevision` is captured at stage time — after the drift, so
     * it certifies the corrupt result rather than refusing it. Measured on this
     * branch: one space typed at line 1 between a read and a stage turned a
     * rename into `export function product(a, b) {{`, offered as a clean
     * one-hunk diff with the agent's name on it.
     *
     * So the revision is remembered here, where both the read and the stage
     * pass through, and `proposal.stage` refuses a buffer whose revision has
     * moved. A provider cannot enforce this alone — it only ever sees text.
     */
    const readAt = new Map<BufferId, number>();

    const session: AgentSession & { principal: Principal } = {
      id,
      label: options.label ?? transport.id,
      instruction,
      principal: {
        kind: 'agent',
        sessionId: id,
        label: options.label ?? transport.id,
      },
      status,
      actions,
      summary,
      cancel: () => job.cancel(),
    };

    const job = this.#jobs.run({ title: `${session.label}: ${instruction}` }, async (context) => {
      context.onCancel(() => transport.dispose?.());

      // Disposed however the run ends, not only when cancelled. An agent is a
      // *process*: without this, every completed session left one running for
      // the lifetime of the editor, which a long day of use turns into dozens.
      // `dispose` is idempotent, so the cancel path calling it too is fine.
      try {
        const handshake = await transport.connect();
        if (handshake.version !== PROTOCOL_VERSION) {
          throw new Error(
            `Agent speaks protocol ${handshake.version}; Nox speaks ${PROTOCOL_VERSION}`,
          );
        }

        const run: AgentRun = {
          instruction,
          context: this.brief(),
          signal: context.signal,
        };

        let staged = false;
        await transport.run(run, async (request) => {
          if (context.cancelled) return failure(request.id, 'cancelled', 'Session cancelled');
          const response = await this.#handle(session.principal, request, record, readAt);
          if (request.method === 'proposal.stage' && response.ok) staged = true;
          if (request.method === 'session.summary') {
            summary.set(request.params.text);
            this.#publish();
          }
          return response;
        });

        return staged;
      } finally {
        transport.dispose?.();
      }
    });

    void job.result.then((outcome) => {
      if (outcome.status === 'cancelled') {
        status.set('cancelled');
        record({ kind: 'error', message: 'Cancelled' });
        return;
      }
      if (outcome.status === 'failed') {
        status.set('failed');
        record({
          kind: 'error',
          message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        });
        return;
      }
      // A session that staged something is not finished; it is waiting for a
      // human. Calling that "done" would imply the change had landed.
      status.set(outcome.value ? 'awaiting-review' : 'done');
      this.#publish();
    });

    this.#live = [session, ...this.#live];
    this.#publish();
    return session;
  }

  /** Republish the snapshot list. Called whenever any session changes. */
  #publish(): void {
    this.sessions.set(
      this.#live.map((session) => ({
        id: session.id,
        label: session.label,
        instruction: session.instruction,
        status: session.status.get(),
        actions: session.actions.get(),
        summary: session.summary.get(),
        changes: this.changesBy(session.id).length,
      })),
    );
  }

  /** The live session object, for cancelling. */
  session(id: string): AgentSession | undefined {
    return this.#live.find((session) => session.id === id);
  }

  registerProvider(provider: ModelProvider): () => void {
    this.providers.update((current) => [...current, provider]);
    return () => this.providers.update((current) => current.filter((entry) => entry !== provider));
  }

  /** Change sets this session produced, newest first. */
  changesBy(sessionId: string): ChangeSetId[] {
    return this.#workspace.log.bySession(sessionId).map((entry) => entry.id);
  }

  /**
   * Undo everything a session did, in one step.
   *
   * Newest first, because a set applied later may sit on top of an earlier one
   * in the same buffer's history and would refuse to be taken back out of
   * order — which `undoChangeSet` reports rather than forcing.
   */
  undoSession(sessionId: string): { undone: BufferId[]; skipped: BufferId[] } {
    const undone: BufferId[] = [];
    const skipped: BufferId[] = [];

    for (const changeSetId of this.changesBy(sessionId)) {
      const outcome = this.#workspace.undoChangeSet(changeSetId);
      undone.push(...outcome.undone);
      skipped.push(...outcome.skipped);
    }

    this.#permissions.forgetSession({
      kind: 'agent',
      sessionId,
      label: sessionId,
    });
    this.#publish();
    return { undone, skipped };
  }

  /** A short description of where the user is, to open a session with. */
  brief(): string {
    const buffers = this.#context.openBuffers();
    const active = buffers.find((buffer) => buffer.isActive);
    const lines = [`Open files: ${buffers.map((buffer) => buffer.name).join(', ') || 'none'}`];
    if (active) {
      lines.push(`Active file: ${active.name} (${active.languageName}, ${active.lineCount} lines)`);
      const viewport = this.#context.viewport(active.id);
      if (viewport) lines.push(`On screen: lines ${viewport.from}–${viewport.to}`);
    }
    return lines.join('\n');
  }

  // --- The protocol handler ------------------------------------------------

  async #handle(
    principal: Principal,
    request: AgentRequest,
    record: (action: NewAction) => void,
    readAt: Map<BufferId, number>,
  ): Promise<CoreResponse> {
    const reader = this.#context.reader(principal);

    try {
      switch (request.method) {
        // `openBuffers`, `viewport`, `workspaceTree` and `recentTransactions`
        // establish no baseline. A scroll position, a path tree and a
        // change-set list locate no text at all.
        //
        // `openBuffers` is a trade, not a claim that a listing is harmless.
        // `BufferSummary.length` IS the end-of-document offset, so a session
        // that lists a buffer and appends to it can stage against a position
        // that has moved — measured, and not refused. Filing every listed
        // buffer would close that and cost more than it saves: it would file
        // them all at once on the listing most sessions open with, and since a
        // narrow read may not raise a baseline, the honest sequence of
        // listing, the user typing, reading a range and staging from it would
        // be refused. A false refusal breaks working agents silently.
        case 'context.openBuffers':
          record({ kind: 'read', method: request.method });
          return success(request.id, reader.openBuffers());

        case 'context.bufferText': {
          record({
            kind: 'read',
            method: request.method,
            target: request.params.bufferId,
          });
          const { bufferId, ...options } = request.params;
          const text = reader.bufferText(bufferId, options);
          if (text === null) return failure(request.id, 'not-found', `No buffer ${bufferId}`);
          // A plain whole-document read is the only one that may *refresh* the
          // baseline, because it is the only read whose text a later edit can
          // be resolved against in full. Letting a range or numbered read
          // raise an existing entry would re-bless offsets computed from
          // older text on a revision that had since caught up.
          //
          // Any read still *establishes* one where there is none: an agent
          // that looked at a range and then edited is no less exposed to the
          // user typing underneath it, and a baseline can only ever add a
          // refusal — an absent entry is not checked at all.
          //
          // Which read that was is settled by asking the reader what a plain
          // read returns, rather than re-deriving it from `options`. The reader
          // resolves the range with `?.from ?? 1` / `?.to ?? doc.lines` and
          // clamps it, so `lines: null`, `lines: {}` and any span past the end
          // all hand back the whole document while `options.lines === undefined`
          // called them narrow — and `parseInbound` validates only `id` and
          // `method`, so an out-of-process agent can send any of them. A
          // numbered read cannot match on any document with a line in it,
          // because the gutter is not in the buffer's text; on an empty one
          // both sides are `''` and it matches, which costs nothing since
          // there are no offsets to be stale about. The cost is materialising
          // a document that was just
          // materialised for the answer; the gain is that the two definitions
          // cannot drift apart, which is the only condition under which this
          // guard is worth anything. `ContextService` and not the reader,
          // because this is the runtime's own bookkeeping rather than a read
          // the audit trail should show.
          const revision = this.#workspace.revisionOf(bufferId);
          const whole = text === this.#context.bufferText(bufferId);
          if (whole || !readAt.has(bufferId)) readAt.set(bufferId, revision);
          return success(request.id, text);
        }

        case 'context.selection': {
          record({
            kind: 'read',
            method: request.method,
            target: request.params.bufferId,
          });
          const { bufferId } = request.params;
          const selection = reader.selection(bufferId);
          // A selection read hands back real document offsets and the text at
          // them — everything needed to compute an edit — so it is exposed to
          // the user typing underneath it exactly as a range read is. It may
          // only establish a baseline, never raise one: it says where the
          // cursor is, not that the offsets about to be staged came from the
          // current text. Only established on an answer, because a `null` came
          // from a buffer that is not open and there is nothing to be stale
          // against.
          if (selection !== null && !readAt.has(bufferId)) {
            readAt.set(bufferId, this.#workspace.revisionOf(bufferId));
          }
          return success(request.id, selection);
        }

        case 'context.viewport':
          record({
            kind: 'read',
            method: request.method,
            target: request.params.bufferId,
          });
          return success(request.id, reader.viewport(request.params.bufferId));

        case 'context.workspaceTree':
          record({ kind: 'read', method: request.method });
          return success(request.id, reader.workspaceTree(request.params));

        case 'context.recentTransactions':
          record({ kind: 'read', method: request.method });
          return success(request.id, reader.recentTransactions(request.params?.limit));

        case 'command.execute': {
          const { commandId, arg } = request.params;
          if (!this.#commands.has(commandId)) {
            record({
              kind: 'command',
              commandId,
              granted: false,
              detail: 'unknown command',
            });
            return failure(request.id, 'not-found', `No command ${commandId}`);
          }
          try {
            const ran = await this.#commands.execute(commandId, arg, {
              principal,
            });
            record({
              kind: 'command',
              commandId,
              granted: true,
              ...(ran ? {} : { detail: 'disabled' }),
            });
            return success(request.id, ran);
          } catch (error) {
            if (error instanceof PermissionError) {
              record({
                kind: 'command',
                commandId,
                granted: false,
                detail: error.message,
              });
              return failure(request.id, 'permission-denied', error.message);
            }
            throw error;
          }
        }

        case 'proposal.stage': {
          // Refused, not narrowed to a smaller window: these offsets were
          // computed against text that is no longer what the buffer says, and
          // applying them writes somewhere other than where the agent looked.
          //
          // What is left alone is a buffer for which this session called
          // neither `context.bufferText` nor `context.selection` — the two
          // reads that hand back a position in the text. Listing it through
          // `context.openBuffers` or asking for its viewport does not count.
          // Those offsets came from somewhere the runtime cannot see, and
          // guessing about them is not better than the agent's own guard.
          // Closing that case needs the agent to declare what it computed
          // against, which `proposal.stage` has no field for.
          const stale = request.params.edits.find((edit) => {
            const at = readAt.get(edit.bufferId);
            return at !== undefined && at !== this.#workspace.revisionOf(edit.bufferId);
          });
          if (stale) {
            const name =
              this.#workspace.buffers.get().find((buffer) => buffer.id === stale.bufferId)?.name ??
              stale.bufferId;
            // Names the read that actually clears it. "Read it again" was
            // advice a range- or numbered-reading agent could follow forever
            // without progress: only a read that hands back the whole document
            // refreshes the baseline, so re-reading the same narrow way is
            // refused again on the next stage.
            const message =
              `${name} changed after you read it — call context.bufferText for it, with no ` +
              `other params, before staging an edit against it. A line range or a numbered ` +
              `read will not clear this.`;
            record({ kind: 'error', message });
            return failure(request.id, 'stale', message);
          }

          const staged = this.#review.stage({
            description: request.params.description,
            author: principal,
            edits: request.params.edits,
          });
          if (!staged) {
            record({ kind: 'error', message: 'Proposal would change nothing' });
            return failure(request.id, 'invalid-request', 'That would change nothing');
          }
          const hunks = staged.files.reduce((sum, file) => sum + file.hunks.length, 0);
          record({
            kind: 'proposal',
            description: staged.description,
            files: staged.files.length,
            hunks,
          });
          return success(request.id, { files: staged.files.length, hunks });
        }

        case 'session.note':
          record({ kind: 'note', text: request.params.text });
          return success(request.id, null);

        case 'session.summary':
          record({ kind: 'summary', text: request.params.text });
          return success(request.id, null);

        default: {
          // Exhaustiveness: adding a method without handling it fails to compile.
          const unreachable: never = request;
          return failure(
            (unreachable as { id: number }).id,
            'unknown-method',
            'Unsupported method',
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record({ kind: 'error', message });
      return failure(request.id, 'internal', message);
    }
  }
}

/**
 * Runs an agent in this process, driven by a `ModelProvider`.
 *
 * The other implementation of `AgentTransport` is a supervised child process
 * speaking the same messages as JSON over stdio, in `stdio.ts`. It exists
 * because everything above this line already treats the agent as remote, so
 * building it was a codec and a process supervisor rather than a change to
 * the runtime.
 */
export class ProviderTransport implements AgentTransport {
  readonly id: string;

  #provider: ModelProvider;

  constructor(provider: ModelProvider) {
    this.#provider = provider;
    this.id = provider.id;
  }

  async connect(): Promise<Handshake> {
    return { version: PROTOCOL_VERSION, label: this.#provider.label };
  }

  async run(run: AgentRun, send: (request: AgentRequest) => Promise<CoreResponse>): Promise<void> {
    let nextId = 1;
    const stream = this.#provider.complete({
      instruction: run.instruction,
      context: run.context,
      signal: run.signal,
    });

    // Each response is fed back into the generator, so an agent can read a
    // file and then decide what to do about it. A one-way stream would make
    // the context API useless to the thing it exists for.
    let response: CoreResponse | undefined;
    while (true) {
      const step = await stream.next(response);
      if (step.done || run.signal.aborted) return;

      const chunk = step.value;
      const request =
        chunk.type === 'text'
          ? {
              id: nextId++,
              method: 'session.note' as const,
              params: { text: chunk.text },
            }
          : ({ ...chunk.request, id: nextId++ } as AgentRequest);

      response = await send(request);
    }
  }
}

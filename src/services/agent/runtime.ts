import { Signal } from '@core/signal';
import type { CommandRegistry } from '../commands';
import type { ContextService, SelectionInfo } from '../context';
import type { JobRunner } from '../jobs';
import { PermissionError, type PermissionService, type Principal } from '../permissions';
import type { ReviewScope, ReviewService, StagedChangeSet } from '../review';
import type { ChangeSetId } from '../transactions';
import type { BufferId, WorkspaceService } from '../workspace';
import type { AnswerExpectation, ModelProvider } from './provider';
import {
  failure,
  parseBaseRevisions,
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

/**
 * How much selected text the brief will carry.
 *
 * Past this a "selection" is a file, and sending it spends context window and
 * local inference time on text nobody asked about. Not a setting: a
 * preference whose wrong value silently degrades model output is a preference
 * that should not exist.
 */
const SELECTION_MAX_LINES = 200;
const SELECTION_MAX_CHARS = 8_000;

/**
 * How many actions a session's trail keeps.
 *
 * Before this there was no cap, and every append copied the whole array and
 * republished it, so a chatty agent made each note cost more than the last:
 * measured, 32,000 notes took 2.7 s of main-thread time and the panel renders
 * every one. The oldest are dropped behind one marker that counts them, so
 * the trail still says that something was lost and how much. Newest kept
 * rather than oldest, because the newest is what explains the state the
 * session is in now.
 */
export const TRAIL_LIMIT = 2_000;

/**
 * How many protocol requests one session may make before it is stopped.
 *
 * The stdio transport's only deadline is silence, which an agent in a loop
 * never falls into, and `maxTurns` bounds only the Ollama provider. This is
 * the bound that covers every transport, and it is generous on purpose: a
 * real session is tens of requests, so the number is not tuning but a ceiling
 * a looping agent hits and a working one never sees. A runtime constant, not
 * an `agents.json` key: a per-agent override is the config schema's business.
 */
export const REQUEST_BUDGET = 5_000;

/**
 * The instruction **Explain Selection** sends.
 *
 * Here rather than in `app.ts` so a test can assert the string that actually
 * ships without importing the whole application, and so the wording lives in
 * one place rather than inside a command literal.
 */
export const EXPLAIN_INSTRUCTION =
  'Explain what this code does, and anything surprising about how it does it.';

/**
 * Clip selected text to the cap, saying so when it clips.
 *
 * The marker is not decoration. A model handed a fragment with no sign that
 * it is a fragment answers as though it had the whole thing.
 */
function clipSelection(text: string): string {
  const lines = text.split('\n');
  let out = text;
  let truncated = false;

  if (lines.length > SELECTION_MAX_LINES) {
    out = lines.slice(0, SELECTION_MAX_LINES).join('\n');
    truncated = true;
  }
  if (out.length > SELECTION_MAX_CHARS) {
    out = out.slice(0, SELECTION_MAX_CHARS);
    truncated = true;
  }
  return truncated ? `${out}\n…truncated: this is only the start of the selection.` : out;
}

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
  | {
      kind: 'read';
      at: number;
      method: string;
      target?: string;
      /** The read was refused: the buffer is outside the workspace root. */
      refused?: true;
    }
  /** What the opening brief handed the model before it asked for anything. */
  | { kind: 'brief'; at: number; detail: string }
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
  | { kind: 'error'; at: number; message: string }
  /** Stands in for the oldest actions once the trail passed `TRAIL_LIMIT`. */
  | { kind: 'elided'; at: number; count: number };

/**
 * Keep the newest `limit` entries of a trail, the oldest behind a marker.
 *
 * The marker is the first entry and carries the running total, so capping a
 * trail that was already capped adds to the count rather than restarting it.
 * Its timestamp is that of the newest action it replaced, which is when the
 * dropping happened. Pure and exported so the arithmetic is testable without
 * running a session of two thousand notes.
 */
export function capTrail(actions: AgentAction[], limit = TRAIL_LIMIT): AgentAction[] {
  if (actions.length <= limit) return actions;
  const first = actions[0];
  const already = first?.kind === 'elided' ? first.count : 0;
  const kept = actions.slice(actions.length - limit);
  const dropped = actions.length - kept.length - (first?.kind === 'elided' ? 1 : 0);
  const at = actions[actions.length - kept.length - 1]?.at ?? Date.now();
  return [{ kind: 'elided', at, count: already + dropped }, ...kept];
}

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
  readonly expects: AnswerExpectation | undefined;
  readonly answer: Signal<string | null>;
  readonly about: Signal<AnswerTarget | null>;
  cancel(): void;
}

/**
 * What an answer was about.
 *
 * `revision` is the buffer's revision at the moment the brief was built —
 * the text the model was actually shown. Comparing it against the buffer's
 * revision now is the whole of staleness; it is a label, never a refusal.
 */
export interface AnswerTarget {
  bufferId: BufferId;
  fromLine: number;
  toLine: number;
  revision: number;
}

/**
 * Whether an answer still describes the code it was about.
 *
 * Pure and here rather than in the panel, so the three cases are testable
 * without a component — and because `-1` (the buffer is closed) is *also*
 * "not equal", and collapsing it into "changed" would report a file you
 * closed as one you edited.
 */
export function answerFreshness(
  about: AnswerTarget,
  currentRevision: number,
): 'current' | 'changed' | 'gone' {
  if (currentRevision === -1) return 'gone';
  return currentRevision === about.revision ? 'current' : 'changed';
}

/** A run of an answer: prose, or the inside of a fenced block. */
export interface AnswerPart {
  code: boolean;
  text: string;
}

/**
 * Split an answer into prose and fenced code.
 *
 * The whole of the markdown handled, on purpose. A renderer is a dependency
 * and a sanitisation surface for model output; the panel renders every part
 * as text, never as markup.
 *
 * Pure and here rather than in the panel for the same reason as
 * `answerFreshness`: it is the one piece of this feature that can lose the
 * user's content, so it has to be reachable from a test.
 *
 * The newline after the info string is required, not optional. Making it
 * optional let `[a-zA-Z0-9-]*` run whether or not a fence opened a block, so
 * an inline ```` ```json```` ate the word after it and rendered nothing at
 * all. Every other limitation of this splitter shows content in the wrong
 * style; that one showed no content, which a deliberately bounded renderer
 * must never do.
 */
export function answerParts(text: string): AnswerPart[] {
  return text
    .split(/```(?:[a-zA-Z0-9-]*\n)?/)
    .map((piece, index) => ({ code: index % 2 === 1, text: piece }))
    .filter((piece) => piece.text.trim().length > 0);
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
  expects: AnswerExpectation | undefined;
  /** The prose a prose session produced. Null for every other session. */
  answer: string | null;
  /** The buffer and lines the question was about, and their revision then. */
  about: AnswerTarget | null;
  /** How many change sets this session has landed. */
  changes: number;
}

/**
 * The scope a selection implies, or null when there is no selection.
 *
 * `context.selection` reports 1-based line numbers because it is also read by
 * humans; `Hunk.fromLine` is a 0-based index into the before-document.
 * Converting once, here, is the difference between an off-by-one that is
 * obvious and one that is spread across every comparison.
 */
export function scopeFromSelection(
  bufferId: BufferId,
  selection: SelectionInfo | null,
): ReviewScope | null {
  if (!selection || selection.isEmpty) return null;
  const range = selection.ranges[selection.main] ?? selection.ranges[0];
  if (!range) return null;
  return { bufferId, fromLine: range.fromLine - 1, toLine: range.toLine - 1 };
}

/**
 * What to tell the user when an undo left the agent's text on disk.
 *
 * One sentence shared by the panel's button and the palette command, so the
 * two cannot describe the same outcome differently. Null when there is
 * nothing to say, which is the common case. The failure this exists for: a
 * user who applied, saved, pressed Undo, read "Took back everything", closed
 * Nox and shipped the agent's edit, because the toast never mentioned the
 * disk and the tab's dirty marker was the only hint.
 */
export function stillOnDisk(count: number): string | null {
  if (count === 0) return null;
  if (count === 1) {
    return (
      'One of them had been saved since, so its file on disk still holds the ' +
      "agent's version until you save it again."
    );
  }
  return (
    `${count} of them had been saved since, so their files on disk still hold the ` +
    "agent's version until you save them again."
  );
}

export interface SessionOptions {
  /** Shown as the agent's name. Defaults to the transport's handshake. */
  label?: string;
  /**
   * The range the user asked about, when the session was started from one.
   * Only ever defaults a hunk; never refuses an edit.
   */
  scope?: ReviewScope;
  /**
   * What this session wants back. Absent means actions.
   *
   * A prose session refuses every request but `session.note` and
   * `session.summary`, so "explain this" cannot edit anything.
   */
  expects?: AnswerExpectation;
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
    const answer = new Signal<string | null>(null);
    const about = new Signal<AnswerTarget | null>(null);

    const record = (action: NewAction) => {
      // Capped on every append. With the cap in place the copy below is
      // bounded, and so is what `#publish` hands the panel: a snapshot
      // carries the array by reference, so republishing is the cost of the
      // session list, not of the trail.
      actions.update((current) => capTrail([...current, { ...action, at: Date.now() }]));
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

    const scope = options.scope;
    const expects = options.expects;

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
      expects,
      answer,
      about,
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

        const briefed = this.#brief(session.principal);
        // Only when it carried the user's text. Names and line counts were
        // always in the brief and are not what this record exists for.
        if (briefed.carried) record({ kind: 'brief', detail: briefed.carried });

        // Captured here, not at stage time: this is the revision of the text
        // the brief actually carried. Later is the wrong moment — the user
        // goes on typing while the model thinks.
        //
        // Gated on `expects === 'prose'`: an ordinary action session can
        // carry a scope too — "Edit Selection with a Model…" always does —
        // and it never asked a question. Capturing `about` for it regardless
        // of `expects` would describe a question that was never asked.
        if (expects === 'prose' && scope) {
          about.set({ ...scope, revision: this.#workspace.revisionOf(scope.bufferId) });
        }

        const run: AgentRun = {
          instruction,
          context: briefed.text,
          signal: context.signal,
          ...(expects ? { expects } : {}),
        };

        let staged = false;
        let requests = 0;
        await transport.run(run, async (request) => {
          if (context.cancelled) return failure(request.id, 'cancelled', 'Session cancelled');
          // Thrown rather than answered with a failure: an agent that has
          // made this many requests is looping, and a refusal it can read is
          // one more thing for the loop to react to. The throw ends the run,
          // the session fails with this message on its trail, and `finally`
          // below disposes the transport, which kills a stdio agent.
          if (++requests > REQUEST_BUDGET) {
            throw new Error(
              `Stopped after ${REQUEST_BUDGET} requests, the budget for one session. ` +
                `An agent that needs more than this is looping.`,
            );
          }
          // The answer is what the agent *said*, not something it did to the
          // workspace, so it is published rather than filed as an action.
          // An essay in the trail would bury the reads the trail is for —
          // the same distinction `brief` already makes.
          // `typeof` rather than a truthiness check, and the malformed case
          // falls through rather than being answered here. `parseInbound`
          // validates only `id` and `method`, so `params.text` can be missing
          // or any type at all from another process — reading it here, outside
          // `#handle`'s try/catch, threw a TypeError all the way out through
          // `StdioTransport.run` and killed the session. The identical message
          // in a non-prose session gets a clean refusal and the agent carries
          // on; one mistake should not have two behaviours.
          if (
            expects === 'prose' &&
            request.method === 'session.note' &&
            typeof request.params?.text === 'string'
          ) {
            const text = request.params.text;
            answer.update((current) => (current === null ? text : `${current}${text}`));
            this.#publish();
            return success(request.id, null);
          }
          const response = await this.#handle(session.principal, request, record, readAt, scope, expects);
          if (request.method === 'proposal.stage' && response.ok) staged = true;
          // Guarded for the same reason the note interception above is, and
          // it is the same bug: this block runs *after* `#handle` has already
          // answered, but on the method name alone, so it re-read
          // `params.text` outside any try/catch. `#handle` turns a malformed
          // summary into a clean `internal` failure; this line then threw the
          // TypeError anyway, out through `StdioTransport.run`, which has no
          // catch, and killed the run that had just been handled.
          //
          // `response.ok` is what stops the throw: a malformed request never
          // gets one. The `typeof` is the narrower point — `#handle` records
          // whatever it is handed, so without it a numeric summary would
          // answer `ok`, land in a `Signal<string | null>`, and reach the
          // panel as something that is not a summary.
          if (
            request.method === 'session.summary' &&
            response.ok &&
            typeof request.params?.text === 'string'
          ) {
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
        expects: session.expects,
        answer: session.answer.get(),
        about: session.about.get(),
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
   * Everything recorded about a session, as JSON a person can file.
   *
   * The trail is the session's own record; the reads and the permission
   * decisions are the two other logs the runtime feeds, kept by the services
   * that own them and joined here on the session's principal. Gathered into
   * one document because the question this answers ("what did the agent do
   * yesterday") is asked of the session, not of three panels. Null for a
   * session this runtime never ran.
   */
  exportTrail(sessionId: string): string | null {
    const session = this.sessions.get().find((entry) => entry.id === sessionId);
    if (!session) return null;
    const ofSession = (principal: Principal) =>
      principal.kind === 'agent' && principal.sessionId === sessionId;
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        session,
        changes: this.changesBy(sessionId),
        reads: this.#context.reads.get().filter((read) => ofSession(read.principal)),
        decisions: this.#permissions.decisions.get().filter((decision) => ofSession(decision.principal)),
      },
      null,
      2,
    );
  }

  /**
   * Undo everything a session did, in one step.
   *
   * Newest first, because a set applied later may sit on top of an earlier one
   * in the same buffer's history and would refuse to be taken back out of
   * order — which `undoChangeSet` reports rather than forcing.
   *
   * `onDisk` names the undone buffers whose file still holds the agent's
   * text: a save adds no history event, so after Save the set is still on
   * top and the undo succeeds in the buffer while the disk keeps what was
   * saved. A buffer that was clean going into the undo is exactly that case.
   * Reported rather than saved over, because writing a file is not what a
   * button marked Undo does; the toast says so instead.
   */
  undoSession(sessionId: string): { undone: BufferId[]; skipped: BufferId[]; onDisk: BufferId[] } {
    const undone: BufferId[] = [];
    const skipped: BufferId[] = [];
    const onDisk: BufferId[] = [];

    for (const changeSetId of this.changesBy(sessionId)) {
      const clean = new Set(
        (this.#workspace.log.get(changeSetId)?.bufferIds ?? []).filter(
          (bufferId) => this.#workspace.get(bufferId)?.isDirty === false,
        ),
      );
      const outcome = this.#workspace.undoChangeSet(changeSetId);
      undone.push(...outcome.undone);
      skipped.push(...outcome.skipped);
      for (const bufferId of outcome.undone) {
        if (clean.has(bufferId) && !onDisk.includes(bufferId)) onDisk.push(bufferId);
      }
    }

    this.#permissions.forgetSession({
      kind: 'agent',
      sessionId,
      label: sessionId,
    });
    this.#publish();
    return { undone, skipped, onDisk };
  }

  /**
   * A short description of where the user is, to open a session with.
   *
   * Every `context.*` method addresses a buffer by `bufferId`, never by name,
   * so each file this names also carries `[id]` — the token a model can
   * actually call back with. Measured against `qwen2.5-coder:7b`: shown only
   * "shapes.js", it called `context.bufferText` with the file name as the id,
   * got "not found", and retried that name eleven times until the turn cap.
   * Square brackets are reserved for ids alone, never reused for the
   * descriptive parens beside them, so the id is never one of several tokens
   * a model has to guess between.
   */
  brief(principal: Principal): string {
    return this.#brief(principal).text;
  }

  /**
   * The brief, plus a description of the selection it carried.
   *
   * Split from `brief` so `start` can record what was handed over without
   * re-deriving which buffer and how much — two answers to one question drift.
   * Reads go through `reader(principal)` rather than the service directly:
   * the brief hands the model up to `SELECTION_MAX_CHARS` of the user's code
   * before it asks for anything, and a read that escapes the log is exactly
   * what the log exists to prevent.
   */
  #brief(principal: Principal): { text: string; carried: string | null } {
    const reader = this.#context.reader(principal);
    const buffers = reader.openBuffers();
    const active = buffers.find((buffer) => buffer.isActive);
    let carried: string | null = null;
    const lines = [
      `Open files: ${buffers.map((buffer) => `${buffer.name} [${buffer.id}]`).join(', ') || 'none'}`,
    ];
    if (active) {
      lines.push(
        `Active file: ${active.name} [${active.id}] (${active.languageName}, ${active.lineCount} lines)`,
      );
      const viewport = reader.viewport(active.id);
      if (viewport) lines.push(`On screen: lines ${viewport.from}–${viewport.to}`);

      const selection = reader.selection(active.id);
      const range = selection && !selection.isEmpty ? selection.ranges[selection.main] : undefined;
      if (range) {
        // Clipped once and measured from the result: reporting the raw
        // selection would tell the audit the model saw text the cap kept back.
        const embedded = clipSelection(range.text);
        lines.push(
          `Selected in ${active.name} [${active.id}], lines ${range.fromLine}–${range.toLine}:`,
          embedded,
        );
        carried = `selection from ${active.name} [${active.id}], ${embedded.length} characters`;
      }
    }
    return { text: lines.join('\n'), carried };
  }

  // --- The protocol handler ------------------------------------------------

  /**
   * What to call a buffer in a message to the agent, falling back to its id.
   *
   * A refusal that named only `buf-3` would be unreadable to the human the
   * audit trail is for, and a declaration can name a buffer no edit does.
   */
  #nameOf(bufferId: BufferId): string {
    return this.#workspace.buffers.get().find((buffer) => buffer.id === bufferId)?.name ?? bufferId;
  }

  async #handle(
    principal: Principal,
    request: AgentRequest,
    record: (action: NewAction) => void,
    readAt: Map<BufferId, number>,
    scope: ReviewScope | undefined,
    expects: AnswerExpectation | undefined,
  ): Promise<CoreResponse> {
    // A prose session has one job and no side effects. Refused here rather
    // than left to the prompt, because an out-of-process agent that ignores
    // `expects` reaches this line too — which is what makes "explain this
    // cannot edit anything" a property rather than an intention.
    if (
      expects === 'prose' &&
      request.method !== 'session.note' &&
      request.method !== 'session.summary'
    ) {
      const message =
        'This session asked for an explanation. Reply in prose; it cannot read, run or propose.';
      // Recorded as well as refused, like every other refusal in this method.
      // Without it a session that ignored `expects` ended holding nothing at
      // all, so the one thing that could explain the empty answer — that its
      // requests were turned down, and why — was the one thing not written
      // down anywhere.
      record({ kind: 'error', message });
      return failure(request.id, 'invalid-request', message);
    }

    const reader = this.#context.reader(principal);

    // A read of a buffer outside the workspace root. `ContextReader` is what
    // actually withholds the text; this exists so the agent gets a code it can
    // act on rather than the `null` the reader returns, which it would read as
    // an empty file, and so the refusal reaches the trail the panel renders.
    // Both sides ask `ContextService.inScope`, which is the one rule.
    //
    // Named by id and never by filename: an agent that guessed an id it was
    // never handed would otherwise learn the name of a file this boundary
    // exists to keep from it.
    const refuseOutside = (bufferId: BufferId): CoreResponse => {
      record({ kind: 'read', method: request.method, target: bufferId, refused: true });
      return failure(
        request.id,
        'permission-denied',
        `Buffer ${bufferId} is outside the workspace folder`,
      );
    };

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
          const { bufferId, ...options } = request.params;
          if (!this.#context.inScope(bufferId)) return refuseOutside(bufferId);
          record({
            kind: 'read',
            method: request.method,
            target: bufferId,
          });
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
          const { bufferId } = request.params;
          if (!this.#context.inScope(bufferId)) return refuseOutside(bufferId);
          record({
            kind: 'read',
            method: request.method,
            target: bufferId,
          });
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

        case 'context.viewport': {
          const { bufferId } = request.params;
          if (!this.#context.inScope(bufferId)) return refuseOutside(bufferId);
          record({
            kind: 'read',
            method: request.method,
            target: bufferId,
          });
          return success(request.id, reader.viewport(bufferId));
        }

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
          // Two checks, and both must pass. This one is the agent's own
          // declaration of what it computed against; the one below is what the
          // runtime watched it read. Neither subsumes the other: a declaration
          // reaches a buffer the session only listed and offsets carried
          // across a re-read, which the runtime cannot see, and the read
          // tracking catches an agent that declares the current revision while
          // holding offsets from an older read — a check it did not do.
          //
          // Checked here rather than left to `workspace.apply`, which does
          // check `baseRevisions` and is where a staged set eventually lands:
          // that happens when the *user* clicks Apply, long after the agent
          // has stopped listening, and what rides along by then is
          // `ReviewFile.baseRevision`, captured at stage time. Staging is the
          // last moment the agent can be told anything.
          const declaration = parseBaseRevisions(request.params.baseRevisions);
          if (!declaration.ok) {
            record({ kind: 'error', message: declaration.reason });
            return failure(request.id, 'invalid-request', declaration.reason);
          }

          // Every declared entry is checked, including one for a buffer no
          // edit names. `workspace.apply` already reads the identically named,
          // identically shaped field that way — its stale filter runs over the
          // whole map regardless of the edits — and a second meaning one layer
          // up would mean the agent and the runtime disagreed about what a key
          // means. It is also the only reading that keeps a promise worth
          // making: an agent that read a file and concluded from it that the
          // file needs no edit has a conclusion that is stale once it moves.
          // A declaration can therefore only ever add a refusal, which is why
          // the field can be optional without being a trap.
          //
          // Checked before the revision comparison below, and under a
          // different code: `workspace.revisionOf` answers `-1` for a buffer
          // it does not have, and comparing that sentinel against a declared
          // revision the ordinary way would let `{ 'no-such-buffer': -1 }`
          // through as if `-1` were a real revision, while every other
          // declared revision for the same buffer was correctly refused.
          // `workspace.apply` already calls this case `missing`
          // (`workspace.ts:958-961`) rather than folding it into `stale`; this
          // does the same under `not-found`, the code this runtime already
          // uses for "no such buffer" (`context.bufferText`'s unknown-buffer
          // case) — `ErrorCode` has no `missing` of its own to borrow.
          // `.find` is undefined when nothing matches, but truthy or falsy
          // for a *found* element depending on what the element is — and the
          // element here is the buffer id itself. Every id but one reads as
          // truthy, so testing the result directly is indistinguishable from
          // testing "found" for all of them except `''`, the one buffer id
          // that is falsy. Comparing to `undefined` is exact regardless of
          // which id matched.
          const declaredMissing = [...declaration.declared.keys()].find(
            (bufferId) => this.#workspace.revisionOf(bufferId) === -1,
          );
          if (declaredMissing !== undefined) {
            const message = `No buffer ${this.#nameOf(declaredMissing)} — a revision was declared for it, but it is not open.`;
            record({ kind: 'error', message });
            return failure(request.id, 'not-found', message);
          }

          const declaredStale = [...declaration.declared].find(
            ([bufferId, revision]) => this.#workspace.revisionOf(bufferId) !== revision,
          );
          if (declaredStale) {
            const [bufferId, revision] = declaredStale;
            const name = this.#nameOf(bufferId);
            // "Read it again" reads as "look up the fresher number" — which
            // is exactly what stages the corruption back in: list again,
            // declare the fresh revision, keep the offsets computed against
            // the old text. Naming the read that actually recomputes offsets
            // is what the sibling read-guard message below does; this says
            // the same thing, plainly, about what a declaration is for.
            const message =
              `${name} is at revision ${this.#workspace.revisionOf(bufferId)}, ` +
              `not the revision ${revision} you declared. The offsets you staged were computed ` +
              `against older text — recompute them against ${name}'s current text (a fresh ` +
              `context.bufferText read), then declare the revision that read returns.`;
            record({ kind: 'error', message });
            return failure(request.id, 'stale', message);
          }

          // Refused, not narrowed to a smaller window: these offsets were
          // computed against text that is no longer what the buffer says, and
          // applying them writes somewhere other than where the agent looked.
          //
          // What is left alone is a buffer for which this session called
          // neither `context.bufferText` nor `context.selection` — the two
          // reads that hand back a position in the text — and which the agent
          // did not declare either. Listing it through `context.openBuffers`
          // or asking for its viewport does not count. Those offsets came from
          // somewhere the runtime cannot see, and guessing about them is not
          // better than the agent's own guard.
          const stale = request.params.edits.find((edit) => {
            const at = readAt.get(edit.bufferId);
            return at !== undefined && at !== this.#workspace.revisionOf(edit.bufferId);
          });
          if (stale) {
            const name = this.#nameOf(stale.bufferId);
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

          const staged = this.#review.stage(
            {
              description: request.params.description,
              author: principal,
              edits: request.params.edits,
            },
            scope,
          );
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
      ...(run.expects ? { expects: run.expects } : {}),
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
          : { ...chunk.request, id: nextId++ };

      response = await send(request);
    }
  }
}

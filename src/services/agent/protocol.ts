import type { Edit } from '../transactions';
import type { BufferId } from '../workspace';
import type { AnswerExpectation } from './provider';

/**
 * The wire contract between Nox and an agent.
 *
 * Written as data, not as method calls on an object, because an agent is
 * expected to be a *separate process* eventually. Everything here survives
 * `JSON.stringify`, and nothing in it is a live handle — the same discipline
 * the context API keeps, for the same reason.
 *
 * The only way an agent changes anything is `command.execute`, which lands in
 * the command dispatcher under the permission model. There is no second verb
 * for "just write this file".
 *
 * See AGENT-PLATFORM.md §3.
 */

/** Bumped when a message shape changes incompatibly. */
export const PROTOCOL_VERSION = 1;

export interface Handshake {
  version: number;
  /** Shown to the user as the agent's name. */
  label: string;
}

export type AgentRequest =
  | { id: number; method: 'context.openBuffers' }
  | {
      id: number;
      method: 'context.bufferText';
      params: { bufferId: BufferId; lines?: { from: number; to: number }; withLineNumbers?: boolean };
    }
  | { id: number; method: 'context.selection'; params: { bufferId: BufferId } }
  | { id: number; method: 'context.viewport'; params: { bufferId: BufferId } }
  | { id: number; method: 'context.workspaceTree'; params?: { depth?: number } }
  | { id: number; method: 'context.recentTransactions'; params?: { limit?: number } }
  /** The only route to a side effect. Checked against the session's policy. */
  | { id: number; method: 'command.execute'; params: { commandId: string; arg?: unknown } }
  /**
   * Offer a change set for the user to review. Writes nothing: staging is
   * deliberately *not* a command, because a command is the thing that has an
   * effect and this has none. The moment it becomes a write is Apply, which is
   * the user's own action, taken in their own UI.
   */
  | {
      id: number;
      method: 'proposal.stage';
      params: {
        description: string;
        edits: Edit[];
        /**
         * The revision each buffer was at when these offsets were computed.
         *
         * A plain object rather than a `Map` because the wire is
         * line-delimited JSON and a `Map` serialises to `{}`. The runtime
         * converts it at the boundary, where it meets
         * `ChangeSetSpec.baseRevisions` in the shape that already exists.
         * Keyed by buffer rather than per edit, because several edits to one
         * buffer share one revision and `ChangeSetSpec` is already keyed that
         * way.
         *
         * Optional, and the guarantee it buys is therefore opt-in: requiring
         * it would break every agent already written, including the reference
         * one. An agent that omits it gets the runtime's read tracking and
         * nothing more — which does not cover a buffer the session only
         * listed, or offsets kept across a re-read.
         *
         * `BufferSummary.revision` from `context.openBuffers` is where the
         * number comes from. Declare the revision the offsets were actually
         * computed against, not the freshest one available: a declaration is
         * checked *in addition to* the read tracking, never instead of it, so
         * naming a revision the agent has not re-derived its offsets from buys
         * nothing and describes a check it did not do.
         */
        baseRevisions?: Record<BufferId, number>;
      };
    }
  /** Narration for the user, shown alongside the reads that justify it. */
  | { id: number; method: 'session.note'; params: { text: string } }
  /** End the session with a sentence about what was done. */
  | { id: number; method: 'session.summary'; params: { text: string } };

/**
 * A request without its correlation id — what a provider yields, before the
 * transport numbers it.
 *
 * Distributes over the union first: a plain `Omit` on a union keeps only the
 * keys every member shares, which here would throw away `params` entirely.
 */
export type RequestBody = AgentRequest extends infer T
  ? T extends AgentRequest
    ? Omit<T, 'id'>
    : never
  : never;

export type ErrorCode =
  | 'permission-denied'
  | 'not-found'
  | 'invalid-request'
  | 'unknown-method'
  | 'stale'
  | 'cancelled'
  | 'internal';

export type CoreResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: ErrorCode; message: string } };

/**
 * How messages get to an agent.
 *
 * The seam that keeps "in-process plugin" and "child process over stdio" from
 * being two different runtimes. Only the in-process implementation exists
 * today; a stdio transport is the same interface with a JSON codec and a Rust
 * supervisor behind it.
 */
export interface AgentRun {
  instruction: string;
  /**
   * A short brief of where the user is, so the agent has something to reason
   * about before its first round trip. Anything more it asks for through
   * `context.*`, which is what gets recorded.
   */
  context: string;
  signal: AbortSignal;
  /** What Nox wants back. Absent means actions. */
  expects?: AnswerExpectation;
}

export interface AgentTransport {
  readonly id: string;
  /** Start the agent and let it introduce itself. */
  connect(): Promise<Handshake>;
  /**
   * Run one instruction. The agent calls `send` for each request it wants
   * answered, and resolves when it has nothing left to ask.
   */
  run(run: AgentRun, send: (request: AgentRequest) => Promise<CoreResponse>): Promise<void>;
  /** Stop, for good. Called when the session is cancelled or the agent is removed. */
  dispose?(): void;
}

/**
 * The wire format, for an agent in another process.
 *
 * One JSON object per line, in both directions. Line-delimited rather than
 * length-prefixed like LSP: an agent is very often a script someone wrote in
 * an afternoon, and `print(json.dumps(...))` in a loop should be enough to
 * speak it. The cost is that a message may not contain a raw newline, which
 * `JSON.stringify` guarantees anyway.
 */

/** Nox → agent. */
export type Outbound =
  | { type: 'run'; instruction: string; context: string; expects?: AnswerExpectation }
  | { type: 'response'; response: CoreResponse }
  | { type: 'cancel' };

/** Agent → Nox. */
export type Inbound =
  | { type: 'hello'; version: number; label: string }
  | { type: 'request'; request: AgentRequest }
  | { type: 'done' };

/** Parse one line from an agent, or explain why it is not usable. */
export function parseInbound(line: string): { ok: true; message: Inbound } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, reason: `not JSON: ${line.slice(0, 120)}` };
  }

  if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) {
    return { ok: false, reason: 'message has no "type"' };
  }

  const message = parsed as Inbound;
  switch (message.type) {
    case 'hello':
      return typeof message.version === 'number'
        ? { ok: true, message }
        : { ok: false, reason: 'hello has no version' };
    case 'request':
      // The id is what makes a response findable; a request without one could
      // only ever be answered into the void.
      return typeof message.request?.id === 'number' && typeof message.request?.method === 'string'
        ? { ok: true, message }
        : { ok: false, reason: 'request needs a numeric id and a method' };
    case 'done':
      return { ok: true, message };
    default:
      return { ok: false, reason: `unknown message type "${(message as { type: string }).type}"` };
  }
}

/**
 * Read `proposal.stage`'s `baseRevisions` as a map, or say why it is not one.
 *
 * Lives here beside `parseInbound` because the shape of a message is the
 * protocol's business, and is called from the runtime rather than from
 * `parseInbound` itself because the two failures are not the same failure.
 * `parseInbound` answers "is this line usable at all", and its only caller
 * treats a `false` as fatal — `StdioTransport.run` throws and the session
 * dies. A malformed declaration is a well-formed request carrying a bad
 * argument: the agent should be *told*, in a response it can read, and it
 * should be told whether it arrived over a pipe or from an in-process
 * provider, which never passes through `parseInbound` at all. One mistake,
 * one behaviour.
 *
 * A malformed declaration refuses the stage rather than being ignored. That is
 * the whole decision: an agent that sent one believes it is protected, and
 * staging anyway hands it a guarantee it does not have — worse than never
 * having offered the field. `parseInbound` validates only `id` and `method`,
 * so every shape below can and will arrive from another process.
 */
export function parseBaseRevisions(
  value: unknown,
): { ok: true; declared: ReadonlyMap<BufferId, number> } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, declared: new Map() };
  // `null` is refused rather than read as "no declaration", unlike
  // `context.bufferText`'s `lines`. A null `lines` degrades to a whole read,
  // which costs nothing; a null declaration read as absent silently drops the
  // entire promise the agent asked for.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      reason:
        `baseRevisions must be an object mapping buffer ids to revision numbers, ` +
        `not ${shown(value)}`,
    };
  }

  const declared = new Map<BufferId, number>();
  for (const [bufferId, revision] of Object.entries(value)) {
    // A non-negative safe integer, because that is the only shape a real
    // revision can ever take: a buffer's revision starts at 0 and climbs one
    // whole step at a time. `NaN` and `Infinity` were already refused on this
    // reasoning — accepting them would turn a declaration into a permanent,
    // unexplained refusal at the next step — and it applies just as much to
    // `-7`, `3.5`, `1e308` and `2**53`: none of them can ever equal a
    // monotonic integer revision either, so letting them through the door
    // only delays the same unfollowable refusal to the next step. `-0` is not
    // one of these: `-0 === 0`, so a declaration of `-0` is not claiming
    // anything false, and `Number.isSafeInteger(-0)` is `true`.
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
      return {
        ok: false,
        reason: `baseRevisions["${bufferId}"] must be a non-negative safe integer revision number, not ${shown(revision)}`,
      };
    }
    declared.set(bufferId, revision);
  }
  return { ok: true, declared };
}

/**
 * What arrived, for a message an agent author can act on.
 *
 * `undefined` and `object` are named directly rather than falling through to
 * `a ${typeof value}`, which read as "not a undefined" and "not a object" —
 * a wire-visible audit string with the wrong article for exactly those two
 * types. Every other fallback (`a boolean`, `a function`, `a bigint`, `a
 * symbol`) already reads correctly with "a", so only these two are
 * special-cased.
 */
function shown(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  // Named rather than typed: `JSON.stringify(NaN)` is `"null"`, which would
  // describe the one case as the other.
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

/** Convenience for building a failure response without repeating the shape. */
export function failure(id: number, code: ErrorCode, message: string): CoreResponse {
  return { id, ok: false, error: { code, message } };
}

export function success(id: number, result: unknown): CoreResponse {
  return { id, ok: true, result };
}

import type { Edit } from '../transactions';
import type { BufferId } from '../workspace';

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
  | { id: number; method: 'proposal.stage'; params: { description: string; edits: Edit[] } }
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
  | { type: 'run'; instruction: string; context: string }
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

/** Convenience for building a failure response without repeating the shape. */
export function failure(id: number, code: ErrorCode, message: string): CoreResponse {
  return { id, ok: false, error: { code, message } };
}

export function success(id: number, result: unknown): CoreResponse {
  return { id, ok: true, result };
}

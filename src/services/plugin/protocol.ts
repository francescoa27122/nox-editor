import type { Edit } from '../transactions';
import type { BufferId } from '../workspace';

/**
 * The wire contract between Nox and a plugin.
 *
 * Written as data, like the agent protocol and for the same reason: a plugin
 * is a *separate process or worker*, everything here survives
 * `JSON.stringify`, and nothing in it is a live handle.
 *
 * **Where it differs from the agent protocol is direction.** An agent is only
 * ever driven — Nox says "run this instruction" and the agent asks questions
 * back. A plugin is driven *and* drives: Nox invokes a command the plugin
 * contributed, and the plugin asks questions back while handling it. So this
 * is symmetric, JSON-RPC-shaped, and a message is told apart by its keys:
 * `method` present means a request, `ok` present means a response. That is the
 * same framing `services/lsp/transport.ts` already speaks.
 *
 * **Contributions are not here.** They are declared in `plugin.json` and read
 * before anything runs, which is what allows a plugin to stay unstarted until
 * one of its commands is first invoked. Putting them in a handshake would mean
 * starting every plugin at boot to find out what they offer — on an editor
 * whose whole thesis is starting fast.
 */

/** Bumped when a message shape changes incompatibly. */
export const PLUGIN_PROTOCOL_VERSION = 1;

export type PluginErrorCode =
  | 'permission-denied'
  | 'not-found'
  | 'invalid-request'
  | 'unknown-method'
  | 'stale'
  | 'timeout'
  | 'internal';

/**
 * Nox → plugin.
 *
 * One method for now. `command.invoke` carries the **bare** contributed name,
 * not the namespaced id: the plugin declared `run`, and telling it
 * `plugin.ruff.run` would make every plugin strip a prefix it already knows.
 */
export type HostRequest =
  | { id: number; method: 'command.invoke'; params: { name: string; arg?: unknown } }
  /**
   * A panel of the plugin's became visible.
   *
   * The one push Nox makes, and it is demand-driven rather than ambient: it is
   * sent when someone opens the panel, not when anything in the editor
   * changes. That is what keeps it on the right side of the design gate while
   * still letting a panel be filled lazily, so a plugin with a panel keeps the
   * lazy activation a plugin with only commands has.
   */
  | { id: number; method: 'panel.show'; params: { name: string } }
  /**
   * A buffer this plugin has decorated has changed, and has been quiet
   * since.
   *
   * **Debounced, coarse, and only about buffers the plugin already
   * decorated.** Nox does not say what changed and will not send this per
   * keystroke: a plugin woken on every character is the thing being out of
   * process exists to prevent, and a channel that could do it would hand
   * that back. What it buys is the difference between decorations that
   * follow the code and decorations that were true once.
   */
  | { id: number; method: 'document.changed'; params: { bufferId: string } };

/**
 * plugin → Nox.
 *
 * `hello` must be first. It is the version check, and it is a request rather
 * than a bare greeting so a plugin speaking a future protocol learns it was
 * refused instead of hanging.
 *
 * The rest deliberately mirror `AgentRequest`'s shapes rather than inventing
 * parallel ones — the same reads, answered by the same `ContextService`
 * reader, recorded against the same principal.
 */
export type PluginRequest =
  | { id: number; method: 'hello'; params: { version: number; label?: string } }
  | { id: number; method: 'context.openBuffers' }
  | {
      id: number;
      method: 'context.bufferText';
      params: { bufferId: BufferId; lines?: { from: number; to: number } };
    }
  | { id: number; method: 'context.selection'; params: { bufferId: BufferId } }
  /**
   * Put something on the status bar, or change what is there.
   *
   * Runtime rather than declared, because an item's *content* is only known to
   * running code — which is exactly why a plugin that uses this declares
   * `"activation": "startup"` and gets started at launch. `command` names a
   * command to run when it is clicked, and that goes through the dispatcher
   * under this plugin's principal like everything else it can reach.
   */
  | {
      id: number;
      method: 'status.set';
      params: {
        name: string;
        text: string;
        tooltip?: string;
        command?: string;
        priority?: number;
      };
    }
  | { id: number; method: 'status.clear'; params: { name: string } }
  /**
   * Fill a panel the manifest declared.
   *
   * Rows, not markup: a plugin is in another process and cannot ship a
   * component, and a way to describe arbitrary DOM would be a way to reach the
   * render loop. A row may carry a command and an argument, which is what
   * makes a list of findings a list of places to go.
   */
  | {
      id: number;
      method: 'panel.set';
      params: { name: string; rows: unknown };
    }
  | { id: number; method: 'panel.clear'; params: { name: string } }
  /**
   * Draw marks in a buffer.
   *
   * A `kind` from a closed vocabulary rather than a class or a colour: the
   * plugin names what it *means* and Nox decides how that is drawn, which
   * is the same split that makes panels rows rather than markup.
   *
   * Sending an empty list is how a plugin takes its own marks back.
   */
  | {
      id: number;
      method: 'editor.decorate';
      params: { bufferId: string; ranges: unknown };
    }
  /**
   * The only route to a side effect, exactly as it is for agents. There is no
   * second verb for "just write this file" — every write a plugin can reach is
   * a command, and a command is checked in the dispatcher.
   */
  | { id: number; method: 'command.execute'; params: { commandId: string; arg?: unknown } }
  /**
   * Offer a change set for the user to review. Writes nothing.
   *
   * Staging is deliberately not a command, because a command is the thing that
   * has an effect and this has none. The moment it becomes a write is Apply,
   * which is the user's own action in their own UI.
   */
  | {
      id: number;
      method: 'proposal.stage';
      params: {
        description: string;
        edits: Edit[];
        /** Revision per buffer the offsets were computed against. */
        baseRevisions?: Record<BufferId, number>;
      };
    };

export type Response =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: { code: PluginErrorCode; message: string } };

/** Anything a plugin may write on its side of the pipe. */
export type Inbound = PluginRequest | Response;

export function isResponse(message: Inbound): message is Response {
  return 'ok' in message;
}

export function failure(id: number, code: PluginErrorCode, message: string): Response {
  return { id, ok: false, error: { code, message } };
}

/**
 * One line from a plugin, or null.
 *
 * Null rather than a throw for anything malformed, because this reads bytes
 * from a third party: a plugin that writes a stray `console.log` to stdout
 * should cost that line, not the session. The host counts these and says so
 * rather than failing silently — a plugin printing debug output to the wrong
 * stream is the single most likely thing to go wrong when writing one.
 */
export function parseInbound(line: string): Inbound | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'number') return null;

  if ('ok' in record) {
    if (record.ok === true) return { id: record.id, ok: true, result: record.result };
    if (record.ok !== false) return null;
    const error = record.error;
    const message =
      typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : 'the plugin reported an error with no message';
    return failure(record.id, 'internal', message);
  }

  if (typeof record.method !== 'string') return null;
  // The method is not checked against the union here. An unknown one reaches
  // the dispatcher, which answers `unknown-method` — a plugin told what it got
  // wrong can be fixed, and one whose line vanished cannot.
  return record as unknown as PluginRequest;
}

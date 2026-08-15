import type { RequestBody } from './protocol';

/**
 * A local model, over Ollama's HTTP API.
 *
 * The shape of this file is dictated by what a 7B model actually does rather
 * than what the API documents. Three findings, all measured against Ollama
 * 0.32.13 with qwen2.5-coder:7b before any of it was written:
 *
 * - There is no `tool_calls` field. The model advertises `tools` in
 *   `ollama show` and never produces one, so actions arrive as JSON inside
 *   `message.content` and this file parses them.
 * - Code fencing is inconsistent between turns of a single conversation,
 *   having been told not to fence at all.
 * - The model cannot compute character offsets. Given an offset interface it
 *   produced a zero-width insertion of a whole function body; given quoted
 *   search/replace it produced a correct edit first time. See `resolveEdit`.
 */

/** The methods a model may call. `command.execute` is deliberately absent. */
const VOCABULARY = new Set([
  'context.openBuffers',
  'context.bufferText',
  'context.selection',
  'context.viewport',
  'context.workspaceTree',
  'context.recentTransactions',
  'session.note',
  'session.summary',
  'proposal.stage',
]);

export interface ParsedTurn {
  /** Narration the model emitted before its action. */
  text: string;
  action: RequestBody | null;
  /** Why nothing could be parsed. Fed back to the model as its next input. */
  error: string | null;
}

/** Strip one surrounding code fence, if there is one. */
function unfence(content: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(content);
  return fenced ? fenced[1]! : content;
}

/**
 * The first complete JSON object in `content`, and whatever preceded it.
 *
 * Scans for balanced braces rather than using a regex: a `find` string in a
 * staged edit can contain braces, and a lazy regex stops at the first `}`
 * inside one.
 */
function firstObject(content: string): { before: string; json: string } | null {
  const start = content.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < content.length; index++) {
    const char = content[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) {
        return { before: content.slice(0, start), json: content.slice(start, index + 1) };
      }
    }
  }
  return null;
}

export function parseTurn(content: string): ParsedTurn {
  const body = unfence(content);
  const found = firstObject(body);
  if (!found) {
    return { text: body.trim(), action: null, error: 'no JSON object in the reply' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(found.json);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { text: found.before.trim(), action: null, error: `malformed JSON: ${message}` };
  }

  const record = parsed as { method?: unknown; params?: unknown };
  if (typeof record.method !== 'string') {
    return { text: found.before.trim(), action: null, error: 'object has no "method" string' };
  }
  if (!VOCABULARY.has(record.method)) {
    return {
      text: found.before.trim(),
      action: null,
      error: `${record.method} is not a method you may call`,
    };
  }

  const action = (
    record.params === undefined
      ? { method: record.method }
      : { method: record.method, params: record.params }
  ) as RequestBody;

  return { text: found.before.trim(), action, error: null };
}

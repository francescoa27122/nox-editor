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

/**
 * Whether a vocabulary method's `params` is required, optional, or absent
 * from its wire shape — taken from `AgentRequest` in `./protocol`.
 *
 * `record.params` is `unknown` straight out of `JSON.parse`; without this,
 * the cast to `RequestBody` below would assert a shape — in particular, that
 * `params` exists and is an object wherever the protocol requires one — that
 * nothing here had actually checked.
 */
const PARAMS_SHAPE: Record<string, 'required' | 'optional' | 'none'> = {
  'context.openBuffers': 'none',
  'context.bufferText': 'required',
  'context.selection': 'required',
  'context.viewport': 'required',
  'context.workspaceTree': 'optional',
  'context.recentTransactions': 'optional',
  'session.note': 'required',
  'session.summary': 'required',
  'proposal.stage': 'required',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ParsedTurn {
  /** Narration the model emitted before its action. */
  text: string;
  action: RequestBody | null;
  /** Why nothing could be parsed. Fed back to the model as its next input. */
  error: string | null;
}

/**
 * Strip one surrounding code fence, if there is one.
 *
 * Deliberately not a single backtracking regex: an opening fence followed by
 * a long run of whitespace and no closing fence — a reply truncated
 * mid-emission, or a model stuck repeating blank lines, both ordinary
 * small-model failure modes — made the previous `\s*` + `[\s\S]*?` regex
 * cubic. 8KB of trailing whitespace with no closing fence took over three
 * minutes; this is a bounded, single pass over the string with `indexOf` and
 * `lastIndexOf` instead.
 */
function unfence(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('```')) return content;

  const headerEnd = trimmed.indexOf('\n');
  if (headerEnd < 0) return content;

  const header = trimmed.slice(3, headerEnd).trim();
  if (header !== '' && header !== 'json') return content;

  const closeStart = trimmed.lastIndexOf('```');
  if (closeStart <= headerEnd) return content; // no closing fence distinct from the opening one

  const trailing = trimmed.slice(closeStart + 3).trim();
  if (trailing !== '') return content; // trailing content after the closing fence — not a clean wrap

  return trimmed.slice(headerEnd + 1, closeStart).trimEnd();
}

/**
 * A single balanced-brace scan starting at `content[start]`, an opening `{`.
 *
 * Tracks whether it is inside a JSON string and whether the next character is
 * escaped, so that braces and escaped quotes *inside* a string value don't
 * perturb the depth count or end the string early. This is what a `find`
 * string in a staged edit needs: it routinely contains `{` and `}`, and a
 * scanner that doesn't know it's looking at a string will miscount or close
 * too early — see the "survives braces in strings" tests, which fail against
 * a plain brace counter even though every test in this file passed against
 * one until those were added.
 *
 * Returns null if depth never returns to zero before the string ends.
 */
function scanBalanced(content: string, start: number): { end: number; json: string } | null {
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
        return { end: index, json: content.slice(start, index + 1) };
      }
    }
  }
  return null;
}

export function parseTurn(content: string): ParsedTurn {
  const body = unfence(content);

  // A brace anywhere in narration ("the { to a (") used to be committed to
  // irrevocably: the first `{` that failed to parse or validate ended the
  // turn, even when a perfectly good action followed it. Retry at the next
  // `{` on any failure instead, and keep only the *first* failure's message
  // as a fallback in case nothing downstream succeeds — this changes which
  // object is treated as the action, not how many are taken once one is
  // found (the existing "ignores anything after" behaviour is untouched: a
  // valid first object still returns immediately, before any retry happens).
  let searchFrom = 0;
  let fallback: ParsedTurn | null = null;

  while (true) {
    const start = body.indexOf('{', searchFrom);
    if (start < 0) {
      return fallback ?? { text: body.trim(), action: null, error: 'no JSON object in the reply' };
    }

    const scanned = scanBalanced(body, start);
    if (!scanned) {
      searchFrom = start + 1;
      continue;
    }

    const before = body.slice(0, start).trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(scanned.json);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      fallback ??= { text: before, action: null, error: `malformed JSON: ${message}` };
      searchFrom = start + 1;
      continue;
    }

    const record = parsed as { method?: unknown; params?: unknown };
    if (typeof record.method !== 'string') {
      fallback ??= { text: before, action: null, error: 'object has no "method" string' };
      searchFrom = start + 1;
      continue;
    }
    if (!VOCABULARY.has(record.method)) {
      fallback ??= {
        text: before,
        action: null,
        error: `${record.method} is not a method you may call`,
      };
      searchFrom = start + 1;
      continue;
    }

    const shape = PARAMS_SHAPE[record.method]!;
    if (shape === 'required' && !isPlainObject(record.params)) {
      fallback ??= {
        text: before,
        action: null,
        error: `${record.method} requires a "params" object`,
      };
      searchFrom = start + 1;
      continue;
    }
    if (shape === 'optional' && record.params !== undefined && !isPlainObject(record.params)) {
      fallback ??= {
        text: before,
        action: null,
        error: `${record.method} "params" must be an object`,
      };
      searchFrom = start + 1;
      continue;
    }
    if (shape === 'none' && record.params !== undefined) {
      fallback ??= {
        text: before,
        action: null,
        error: `${record.method} does not take "params"`,
      };
      searchFrom = start + 1;
      continue;
    }

    const action = (
      record.params === undefined
        ? { method: record.method }
        : { method: record.method, params: record.params }
    ) as RequestBody;

    return { text: before, action, error: null };
  }
}

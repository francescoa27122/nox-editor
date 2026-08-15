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

interface Candidate {
  start: number;
  json: string;
}

/**
 * Every balanced-brace, string/escape-aware object span in `content`, found
 * in a single left-to-right pass with a stack rather than by re-scanning from
 * each candidate `{` in turn.
 *
 * Re-scanning was the previous approach: on a failed candidate, retry at
 * `start + 1` and run a fresh scan to end-of-string looking for the next
 * balance point. That is quadratic — a model stuck repeating a character, or
 * a reply truncated mid-emission, produces long runs of non-balancing `{`,
 * and cost is (number of those) × (remaining length). 256K of bare `{`
 * measured at 75s; the same input here is sub-millisecond.
 *
 * A stack fixes it in one pass: push each structural `{` (one not inside a
 * string), and on a structural `}` pop the most recent unmatched `{` and
 * record the pair. Nested objects are recorded alongside their enclosing one
 * — that's what lets a later step promote an inner object when an outer one
 * is syntactically valid JSON but semantically wrong, e.g. the
 * `command.execute` test: its outer object parses fine, it's just not a
 * method this parser accepts, and its nested `params` object remains
 * available to try next. Braces and escaped quotes inside a string value
 * never push or pop — same string/escape awareness the per-candidate scanner
 * had, just computed once instead of once per candidate.
 */
function balancedObjects(content: string): Candidate[] {
  const candidates: Candidate[] = [];
  const opens: number[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index++) {
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
    if (char === '{') {
      opens.push(index);
    } else if (char === '}') {
      const start = opens.pop();
      if (start !== undefined) {
        candidates.push({ start, json: content.slice(start, index + 1) });
      }
    }
  }

  // Closing order nests innermost-first (LIFO); candidates are tried in the
  // order a left-to-right reader meets their opening brace, so outer objects
  // are attempted before the inner objects nested inside them.
  candidates.sort((a, b) => a.start - b.start);
  return candidates;
}

export function parseTurn(content: string): ParsedTurn {
  const body = unfence(content);
  const candidates = balancedObjects(body);

  if (candidates.length === 0) {
    return { text: body.trim(), action: null, error: 'no JSON object in the reply' };
  }

  // Narration is whatever came before the *first* brace in the reply, not
  // before whichever candidate ends up winning: a model that wraps its call
  // (`{"tool_call": {...}}`) and fails on the outer object promotes the
  // inner one, but the text a user sees should still be the prose that
  // preceded the reply's JSON, not a fragment like `{"tool_call":` left over
  // from the rejected outer attempt.
  const firstBrace = body.indexOf('{');
  const before = body.slice(0, firstBrace).trim();

  let fallback: ParsedTurn | null = null;

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.json);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      fallback ??= { text: before, action: null, error: `malformed JSON: ${message}` };
      continue;
    }

    const record = parsed as { method?: unknown; params?: unknown };
    if (typeof record.method !== 'string') {
      fallback ??= { text: before, action: null, error: 'object has no "method" string' };
      continue;
    }
    if (!VOCABULARY.has(record.method)) {
      fallback ??= {
        text: before,
        action: null,
        error: `${record.method} is not a method you may call`,
      };
      continue;
    }

    const shape = PARAMS_SHAPE[record.method]!;
    if (shape === 'required' && !isPlainObject(record.params)) {
      fallback ??= {
        text: before,
        action: null,
        error: `${record.method} requires a "params" object`,
      };
      continue;
    }
    if (shape === 'optional' && record.params !== undefined && !isPlainObject(record.params)) {
      fallback ??= {
        text: before,
        action: null,
        error: `${record.method} "params" must be an object`,
      };
      continue;
    }
    if (shape === 'none' && record.params !== undefined) {
      fallback ??= {
        text: before,
        action: null,
        error: `${record.method} does not take "params"`,
      };
      continue;
    }

    const action = (
      record.params === undefined
        ? { method: record.method }
        : { method: record.method, params: record.params }
    ) as RequestBody;

    return { text: before, action, error: null };
  }

  return fallback!;
}

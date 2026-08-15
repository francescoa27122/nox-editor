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

interface Scan {
  candidates: Candidate[];
  /** `{`'s start → the nearest enclosing open brace's start at push time, or -1 for top-level. */
  parentOf: Map<number, number>;
  /** Starts that were actually closed — the only braces that count as real JSON structure. */
  closedStarts: Set<number>;
}

/**
 * Every balanced-brace object span in `content`, found in a single
 * left-to-right pass with a stack rather than by re-scanning from each
 * candidate `{` in turn.
 *
 * Re-scanning was the previous approach: on a failed candidate, retry at
 * `start + 1` and run a fresh scan to end-of-string looking for the next
 * balance point. That is quadratic — a model stuck repeating a character, or
 * a reply truncated mid-emission, produces long runs of non-balancing `{`,
 * and cost is (number of those) × (remaining length). 256K of bare `{`
 * measured at 75s; the same input here is sub-millisecond.
 *
 * String/escape tracking only runs while at least one candidate is open
 * (`opens.length > 0`). Walking it continuously from index 0 was the next
 * bug: prose has unbalanced quotes constantly ("a 6\" ruler", "the \"use
 * strict\" pragma", a Windows path), and an odd quote count or a trailing
 * backslash in narration flipped the scanner into "in string" for the rest
 * of the reply, silently dropping every action after it — fuzzed over 30,000
 * replies, that direction was one-way: 1,060 turns (3.5%) lost an action the
 * pre-stack scanner recovered, zero were gained. Outside any candidate, a
 * `"` or `\` is just prose and means nothing structurally.
 *
 * Nested objects are recorded alongside their enclosing one and tagged with
 * their raw stack parent, so a later step can promote an inner object when
 * an outer one is syntactically valid JSON but semantically wrong (the
 * `command.execute` test: its outer object parses fine, it's just not a
 * method this parser accepts). That parent link is *raw* stack adjacency,
 * not "genuinely enclosing JSON" — an unmatched `{` left dangling in
 * narration is still on the stack when a real object opens after it, so the
 * real object's raw parent can be prose that never closes. `closedStarts`
 * is what lets a later step tell the difference.
 */
function balancedObjects(content: string): Scan {
  const candidates: Candidate[] = [];
  const opens: number[] = [];
  const parentOf = new Map<number, number>();
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index++) {
    const char = content[index]!;

    if (opens.length === 0) {
      if (char === '{') {
        parentOf.set(index, -1);
        opens.push(index);
      }
      continue;
    }

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
      parentOf.set(index, opens[opens.length - 1]!);
      opens.push(index);
    } else if (char === '}') {
      const start = opens.pop()!;
      candidates.push({ start, json: content.slice(start, index + 1) });
    }
  }

  // Closing order nests innermost-first (LIFO); candidates are tried in the
  // order a left-to-right reader meets their opening brace, so outer objects
  // are attempted before the inner objects nested inside them.
  candidates.sort((a, b) => a.start - b.start);
  const closedStarts = new Set(candidates.map((c) => c.start));
  return { candidates, parentOf, closedStarts };
}

/**
 * The start of the outermost *genuine* JSON ancestor of the object at
 * `start` — climbing through raw stack parents only while each one was
 * itself properly closed, and stopping at the first one that wasn't.
 *
 * This is why narration reads right in both directions: a stray `{` in
 * prose ("the { to a (") is never closed, so the real object "inside" it
 * (in raw stack terms) is its own outermost — narration isn't truncated at
 * the stray brace. A genuine wrapper (`{"tool_call": {...}}`) *is* closed,
 * so an inner object promoted out of it still reports the wrapper's start —
 * narration isn't truncated at the wrapper's own contents either. Slicing to
 * "the first brace in the body" (this file's previous approach) could only
 * get one of those two cases right at a time; this gets both.
 *
 * Path-compressed so repeated calls during one `parseTurn` stay linear
 * regardless of how deep any one candidate is nested.
 */
function outermostStart(start: number, scan: Scan, memo: Map<number, number>): number {
  const path: number[] = [];
  let current = start;
  while (!memo.has(current)) {
    const parent = scan.parentOf.get(current)!;
    if (parent === -1 || !scan.closedStarts.has(parent)) {
      memo.set(current, current);
      break;
    }
    path.push(current);
    current = parent;
  }
  const result = memo.get(current)!;
  for (const node of path) memo.set(node, result);
  return result;
}

export function parseTurn(content: string): ParsedTurn {
  const body = unfence(content);
  const scan = balancedObjects(body);

  if (scan.candidates.length === 0) {
    return { text: body.trim(), action: null, error: 'no JSON object in the reply' };
  }

  const outermostMemo = new Map<number, number>();
  const textBefore = (start: number) => body.slice(0, outermostStart(start, scan, outermostMemo)).trim();

  let fallback: ParsedTurn | null = null;

  for (const candidate of scan.candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.json);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      fallback ??= { text: textBefore(candidate.start), action: null, error: `malformed JSON: ${message}` };
      continue;
    }

    const record = parsed as { method?: unknown; params?: unknown };
    if (typeof record.method !== 'string') {
      fallback ??= { text: textBefore(candidate.start), action: null, error: 'object has no "method" string' };
      continue;
    }
    if (!VOCABULARY.has(record.method)) {
      fallback ??= {
        text: textBefore(candidate.start),
        action: null,
        error: `${record.method} is not a method you may call`,
      };
      continue;
    }

    const shape = PARAMS_SHAPE[record.method]!;
    if (shape === 'required' && !isPlainObject(record.params)) {
      fallback ??= {
        text: textBefore(candidate.start),
        action: null,
        error: `${record.method} requires a "params" object`,
      };
      continue;
    }
    if (shape === 'optional' && record.params !== undefined && !isPlainObject(record.params)) {
      fallback ??= {
        text: textBefore(candidate.start),
        action: null,
        error: `${record.method} "params" must be an object`,
      };
      continue;
    }
    if (shape === 'none' && record.params !== undefined) {
      fallback ??= {
        text: textBefore(candidate.start),
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

    return { text: textBefore(candidate.start), action, error: null };
  }

  return fallback!;
}

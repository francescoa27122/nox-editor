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

/** A balanced-brace span: `[start, end)`, `start` on `{` and `end` past `}`. */
interface Candidate {
  start: number;
  end: number;
}

/**
 * Every `{`-to-matching-`}` span in `content`, in the order a left-to-right
 * reader meets their opening brace.
 *
 * The semantics this has to deliver are the obvious ones: for *every* `{` in
 * the reply, the object a correct string-aware scan started at that `{` would
 * find. Correct because a `find` string in a staged edit can hold a `{`, a
 * `}` or a `\"` and none of those are structure; for *every* `{` because
 * prose is not JSON and the model puts braces in it — "change the { to a (",
 * a quoted `{ return; }`, an irrelevant `{"a":1}` — and the real action comes
 * after.
 *
 * Doing that literally (rescan from each `{`) is quadratic, and a reply that
 * is a long run of `{` is exactly what a looping or truncated 7B model emits:
 * 256K braces measured at 75s. Every attempt to get it in one stack pass
 * instead traded one input class for another, because a single pass has one
 * string state and has to guess which text it belongs to:
 *
 * - tracking `inString` continuously from index 0 let an odd `"` or a `\` in
 *   narration flip the scanner into "in string" for the rest of the reply,
 *   losing 3.5% of actions in a fuzz;
 * - scoping the tracking to "inside a candidate" moved the loss rather than
 *   removing it, because a `{` inside a quoted span in prose (`He said "the {
 *   brace" out loud.`) opens a candidate and re-arms exactly the same trap —
 *   3.8% lost.
 *
 * There is no third scoping rule to find, because the premise is wrong: the
 * scan does not have to guess. Whether a scan started at `{` at position `s`
 * considers position `p` to be inside a string depends only on the *parity*
 * of the unescaped `"` between them. So across a whole document there are
 * only ever **two** string interpretations, indexed by the parity of the
 * running quote count at a scan's own start — not one per candidate. Track
 * both, with a brace stack each. A brace at a position whose running parity
 * is `k` is structure for interpretation `k` and string content for the
 * other, so exactly one stack acts on it: still a single pass, still linear,
 * and every `{` lands in the interpretation that is correct *for it*.
 *
 * A prose `{` and a JSON `{` separated by an odd number of prose quotes
 * simply end up in different stacks and stop interfering. Braces inside a
 * JSON string sit at the opposite parity from the object containing them, so
 * they cannot perturb its span either. The four shapes that broke earlier
 * rounds — brace in a JSON string, brace in prose, unbalanced quote in prose,
 * and both together — are all this same fact seen from different sides.
 *
 * Nested spans are reported alongside their enclosing one, so a later step
 * can promote an inner object when an outer one is valid JSON but
 * semantically wrong (`{"tool_call": {...}}`, or the `command.execute` test).
 */
function objectSpans(content: string): Candidate[] {
  /** Matched opens, keyed by start. A `{` that never closes is simply absent. */
  const endOf = new Map<number, number>();
  /** Open braces per interpretation: index 0 for even quote parity, 1 for odd. */
  const stacks: [number[], number[]] = [[], []];
  let quotesOdd = false;
  /** Whether the run of `\` immediately behind us has odd length. */
  let pendingEscape = false;

  for (let index = 0; index < content.length; index++) {
    const char = content[index]!;

    // A backslash only ever suppresses a following quote. It must not swallow
    // a following brace: `Careful with this: \` immediately before a real
    // action is prose, and consuming the `{` after it lost the whole turn.
    if (char === '\\') {
      pendingEscape = !pendingEscape;
      continue;
    }
    if (char === '"') {
      if (!pendingEscape) quotesOdd = !quotesOdd;
      pendingEscape = false;
      continue;
    }
    pendingEscape = false;
    if (char !== '{' && char !== '}') continue;

    const stack = stacks[quotesOdd ? 1 : 0]!;
    if (char === '{') stack.push(index);
    else if (stack.length > 0) endOf.set(stack.pop()!, index + 1);
  }

  if (endOf.size === 0) return [];

  // A second walk rather than sorting what the first produced: closes arrive
  // innermost-first and interleaved between the two stacks, and the reply
  // must be read left to right. Walking the string again is linear and
  // allocates nothing for the degenerate inputs (a long run of bare `{`)
  // that motivated all of this.
  const spans: Candidate[] = [];
  for (let index = 0; index < content.length; index++) {
    if (content[index] !== '{') continue;
    const end = endOf.get(index);
    if (end !== undefined) spans.push({ start: index, end });
  }
  return spans;
}

/** Why this object cannot be an action, or `null` if it can. */
function rejectionOf(parsed: unknown): string | null {
  const record = parsed as { method?: unknown; params?: unknown };
  if (typeof record.method !== 'string') return 'object has no "method" string';
  if (!VOCABULARY.has(record.method)) return `${record.method} is not a method you may call`;

  const shape = PARAMS_SHAPE[record.method]!;
  if (shape === 'required' && !isPlainObject(record.params)) {
    return `${record.method} requires a "params" object`;
  }
  if (shape === 'optional' && record.params !== undefined && !isPlainObject(record.params)) {
    return `${record.method} "params" must be an object`;
  }
  if (shape === 'none' && record.params !== undefined) {
    return `${record.method} does not take "params"`;
  }
  return null;
}

export function parseTurn(content: string): ParsedTurn {
  const body = unfence(content);
  const candidates = objectSpans(body);

  if (candidates.length === 0) {
    return { text: body.trim(), action: null, error: 'no JSON object in the reply' };
  }

  /**
   * Spans already tried and rejected that were nonetheless *parseable* JSON.
   * Only those count as real structure around a later winner; a brace pair
   * in prose (`` `{ return; }` ``) is not an object that a promoted inner
   * object was nested in, and neither is a span a mis-parity scan happened
   * to balance across narration.
   */
  const rejectedButParseable: Candidate[] = [];

  /**
   * Narration is the prose before any JSON — not before whichever candidate
   * won. When an outer object is valid JSON but not a valid action and an
   * inner one is promoted (`Explanation.\n{"tool_call": {...}}`), the text
   * must stop at the wrapper, or a broken `{"tool_call":` fragment is
   * surfaced to the user as if the model had said it. When the earlier braces
   * are prose instead, they belong to the narration and must survive in it.
   * Called at most twice per turn — once for the winner, once for the first
   * failure — so the scan over rejects stays linear overall.
   */
  const textBefore = (candidate: Candidate): string => {
    let outermost = candidate.start;
    for (const earlier of rejectedButParseable) {
      if (earlier.start < outermost && earlier.end >= candidate.end) outermost = earlier.start;
    }
    return body.slice(0, outermost).trim();
  };

  let fallback: ParsedTurn | null = null;

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.slice(candidate.start, candidate.end));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      fallback ??= { text: textBefore(candidate), action: null, error: `malformed JSON: ${message}` };
      continue;
    }

    const rejection = rejectionOf(parsed);
    if (rejection !== null) {
      fallback ??= { text: textBefore(candidate), action: null, error: rejection };
      rejectedButParseable.push(candidate);
      continue;
    }

    const record = parsed as { method: string; params?: unknown };
    const action = (
      record.params === undefined
        ? { method: record.method }
        : { method: record.method, params: record.params }
    ) as RequestBody;

    return { text: textBefore(candidate), action, error: null };
  }

  return fallback!;
}

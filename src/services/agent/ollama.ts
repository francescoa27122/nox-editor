import type { JsonLinesStream, Platform } from '@platform/types';
import type { Edit } from '../transactions';
import type { BufferId } from '../workspace';
import type { OllamaAgentConfig } from './config';
import type { CoreResponse, RequestBody } from './protocol';
import type { ModelProvider, ModelRequest, ModelStream } from './provider';

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

/**
 * Locate `find` in `text` and express the replacement as real offsets.
 *
 * The model quotes text rather than computing positions because it cannot
 * compute positions — measured, not assumed. This is the conversion, and it
 * is also the only place a bad quote can be caught: `proposal.stage` takes
 * offsets and will faithfully stage nonsense if given nonsense.
 *
 * Ambiguity is refused rather than resolved by taking the first match.
 * Editing the wrong one of three identical lines produces a diff plausible
 * enough to accept, which is the failure worth preventing.
 */
export function resolveEdit(
  text: string,
  find: string,
  replace: string,
): { from: number; to: number; insert: string } | { error: string } {
  if (find.length === 0) {
    return { error: 'the text to find is empty' };
  }

  const first = text.indexOf(find);
  if (first < 0) {
    return { error: `text not found in the buffer: ${JSON.stringify(find.slice(0, 60))}` };
  }

  let count = 0;
  for (let at = first; at >= 0; at = text.indexOf(find, at + 1)) count++;
  if (count > 1) {
    return {
      error: `text is ambiguous, ${count} matches — quote more of the surrounding lines`,
    };
  }

  return { from: first, to: first + find.length, insert: replace };
}

/** How many times the model may act before the session ends itself. */
const DEFAULT_MAX_TURNS = 12;

/**
 * What the model is told it may do.
 *
 * Written as the protocol's own vocabulary rather than as tool schemas: the
 * model has no tool-calling path, so this prompt *is* the interface. `find`
 * is quoted rather than positional for the reason `resolveEdit` documents.
 */
function systemPrompt(): string {
  return [
    'You are a coding agent inside the Nox editor.',
    'Reply with ONE JSON object and nothing else. Do not use code fences.',
    '',
    'Methods:',
    '{"method":"context.openBuffers"}',
    '{"method":"context.bufferText","params":{"bufferId":"<id>"}}',
    '{"method":"context.selection","params":{"bufferId":"<id>"}}',
    '{"method":"context.viewport","params":{"bufferId":"<id>"}}',
    '{"method":"context.workspaceTree"}',
    '{"method":"context.recentTransactions"}',
    '{"method":"session.note","params":{"text":"<what you are doing>"}}',
    '{"method":"proposal.stage","params":{"description":"<what>","edits":[{"bufferId":"<id>","find":"<exact existing text>","replace":"<new text>"}]}}',
    '{"method":"session.summary","params":{"text":"<what you did>"}}',
    '',
    'For proposal.stage, "find" MUST be copied exactly from the buffer and must',
    'appear exactly once in it. Quote whole lines including indentation. Never',
    'use character offsets. Read a buffer with context.bufferText, plainly and',
    'in full, before staging any edit against it.',
    '',
    'You receive each result as the next user message. Finish with session.summary.',
  ].join('\n');
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * The text of each buffer the model has read, as it read it.
 *
 * Lives inside one `complete` call rather than on the provider. Two sessions
 * against the same agent must not read each other's buffers, and text left
 * over from a previous instruction is older than anything the current one can
 * reason about — the model quotes from what it was shown *this* session, so
 * that is the only text a quote may be resolved against.
 *
 * An entry can nonetheless go stale while the session is still running, and
 * nothing here can tell: the user types, and the provider's only window on the
 * buffer is the text it was handed at read time. That is why freshness is
 * enforced where both the read and the stage pass through — `AgentRuntime`
 * remembers the revision each read was taken at and refuses a `proposal.stage`
 * whose buffer has moved since, with a `stale` error this loop feeds back.
 */
type BufferTexts = Map<string, string>;

/**
 * Keep the text of a buffer the model just read.
 *
 * Only a plain whole-document read is worth keeping. Offsets are measured from
 * position 0 of the buffer, so text taken from a line range starts in the
 * wrong place, and text with a line-number gutter is not the buffer's text at
 * all — resolving a quote against either produces offsets that land somewhere
 * else entirely, which is the one failure `resolveEdit` exists to prevent.
 *
 * Both fields are tested exactly as the reader tests them (`ContextService`'s
 * `bufferText`), because this guard is only worth anything while the two agree
 * about what a plain read is. `parseTurn` checks that `params` is an object
 * and nothing about its fields, so `withLineNumbers: "true"` — a small model
 * inventing a parameter as a stringified boolean, which is ordinary — is
 * numbered text to the reader. A `=== true` here would file it as plain and
 * hand back offsets measured through a gutter.
 */
function rememberRead(
  request: RequestBody,
  response: CoreResponse | undefined,
  texts: BufferTexts,
): void {
  if (request.method !== 'context.bufferText') return;
  const { bufferId, lines, withLineNumbers } = request.params;
  if (lines !== undefined || withLineNumbers) return;
  if (!response?.ok || typeof response.result !== 'string') return;
  texts.set(bufferId, response.result);
}

/**
 * Rewrite a staged edit's quoted text into the offsets `proposal.stage` takes.
 *
 * The conversion has to happen here because this is the only place that holds
 * both the quote and the text it was quoted from: below is the protocol, which
 * takes offsets and asks no questions, and above is the model, which cannot
 * count. That asymmetry is also why every doubt is refused rather than
 * guessed. `proposal.stage` will faithfully stage a change set built from
 * nonsense, and the result is not an error the user sees — it is a diff that
 * looks deliberate, with the agent's name on it, offered for one keystroke of
 * approval.
 */
function withOffsets(
  params: unknown,
  texts: BufferTexts,
): { method: 'proposal.stage'; params: { description: string; edits: Edit[] } } | { error: string } {
  const record = params as { description?: unknown; edits?: unknown };
  if (!Array.isArray(record.edits) || record.edits.length === 0) {
    return { error: 'proposal.stage needs a non-empty "edits" array' };
  }

  const edits: Edit[] = [];
  for (const entry of record.edits as unknown[]) {
    const edit = entry as { bufferId?: unknown; find?: unknown; replace?: unknown };
    if (
      typeof edit.bufferId !== 'string' ||
      typeof edit.find !== 'string' ||
      typeof edit.replace !== 'string'
    ) {
      return { error: 'every edit needs string "bufferId", "find" and "replace" fields' };
    }

    const text = texts.get(edit.bufferId);
    if (text === undefined) {
      return {
        error: `you have not read ${edit.bufferId} this session — call context.bufferText for it, with no other params, before staging an edit against it`,
      };
    }

    const resolved = resolveEdit(text, edit.find, edit.replace);
    if ('error' in resolved) return { error: resolved.error };
    edits.push({ bufferId: edit.bufferId as BufferId, changes: resolved });
  }

  const description = typeof record.description === 'string' ? record.description : 'Agent proposal';
  return { method: 'proposal.stage', params: { description, edits } };
}

/**
 * The last word of a session that ended for a reason of its own.
 *
 * `session.summary` rather than `session.note`: a note is narration, rendered
 * beside whatever the model chose to say, and an ending recorded as one is
 * indistinguishable from the model musing and stopping. A summary is the
 * session's own account of itself, and the panel shows it as such.
 */
function summaryOf(text: string): RequestBody {
  return { method: 'session.summary', params: { text } };
}

export class OllamaProvider implements ModelProvider {
  readonly id: string;
  readonly label: string;

  #platform: Platform;
  #config: OllamaAgentConfig;

  constructor(platform: Platform, config: OllamaAgentConfig) {
    this.#platform = platform;
    this.#config = config;
    this.id = config.id;
    this.label = config.label;
  }

  async *complete(request: ModelRequest): ModelStream {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt() },
      {
        role: 'user',
        content: `Instruction: ${request.instruction}\n\n${request.context}\n\nBegin.`,
      },
    ];

    // `maxTurns` comes from a hand-edited file and the loader keeps any number
    // it finds. Zero is the one that matters: the loop body never runs, so the
    // session reports done having done nothing, which reads as a broken agent
    // rather than as a number set wrong. Nonsense falls back to the default
    // instead, since a cap of one is a guess at what was meant.
    const configured = this.#config.maxTurns;
    const maxTurns = Number.isFinite(configured)
      ? Math.max(1, Math.floor(configured!))
      : DEFAULT_MAX_TURNS;
    const texts: BufferTexts = new Map();
    let consecutiveFailures = 0;
    /** Whether a proposal of this session's is waiting for the user. */
    let staged = false;

    for (let turn = 0; turn < maxTurns; turn++) {
      if (request.signal?.aborted) return;

      const content = await this.#ask(messages, request.signal);
      if (content === null) return;

      messages.push({ role: 'assistant', content });
      const parsed = parseTurn(content);

      if (parsed.text.length > 0) yield { type: 'text', text: parsed.text };

      let action = parsed.action;
      let refusal = action ? null : `${parsed.error}. Reply with one JSON object.`;

      // The only action that cannot be passed on as it arrives: what the model
      // emits is quoted text and what the protocol takes is offsets.
      if (action?.method === 'proposal.stage') {
        const resolved = withOffsets(action.params, texts);
        if ('error' in resolved) {
          action = null;
          refusal = resolved.error;
        } else {
          action = resolved;
        }
      }

      if (action === null) {
        consecutiveFailures++;
        // Twice is enough to know it is not a slip. A model that cannot emit
        // the format will not manage it on the third attempt, and the session
        // is more useful ended than looping. A refused stage counts the same:
        // it is equally a turn that produced nothing Nox can act on, and a
        // model misquoting the same buffer twice is not about to get it right.
        if (consecutiveFailures >= 2) {
          /**
           * Giving up used to be a bare `return`, which the runtime reads as
           * "nothing staged" and reports as `Done` — the same word a session
           * that did the job shows. Measured at session level: two refused
           * stages left `status=done summary=null` and a trail of
           * `[instruction, read]`, with no sign an edit had ever been
           * attempted. It is the common case, not an edge one: qwen2.5-coder
           * quotes `find` with literal `\n` in it often enough that a rename
           * ends here on the first try.
           *
           * So it fails, the way an unreachable server already does — the
           * runtime turns a throw into a `failed` session with the message in
           * the trail, and the reason names the last refusal so the user can
           * see what the model tried. Unless a proposal is already waiting:
           * `Failed` beside a change set the user could still keep would read
           * as "nothing to see here", so that ends with a summary instead.
           */
          const message = `Gave up after two turns Nox could not use. The last: ${refusal}`;
          if (staged) {
            yield { type: 'action', request: summaryOf(message) };
            return;
          }
          throw new Error(message);
        }
        messages.push({ role: 'user', content: `Error: ${refusal}` });
        continue;
      }

      consecutiveFailures = 0;
      const response = yield { type: 'action', request: action };
      if (action.method === 'session.summary') return;
      if (action.method === 'proposal.stage' && response?.ok) staged = true;
      rememberRead(action, response, texts);
      messages.push({ role: 'user', content: `Result: ${describeResponse(response)}` });
    }

    // The turn cap. Falling out of the loop is also a `return`, and a session
    // that read one buffer fifteen times and stopped reported `Done` with no
    // summary at all — observed in the running app, twice, on an instruction
    // this model happens to loop on. Running out of turns and finishing are
    // different outcomes and the panel had one word for both, so this says
    // which, and names the number the user can change.
    yield {
      type: 'action',
      request: summaryOf(
        `Stopped after ${maxTurns} turns without finishing. Ask again more specifically, or raise "maxTurns" for this agent in agents.json.`,
      ),
    };
  }

  /**
   * One round trip. Returns the assembled `message.content`, or null when the
   * run was cancelled — the one case where there is nothing to parse and
   * nothing wrong.
   *
   * Anything else that stopped the stream **throws**. It used to return null
   * there too, and the session that produced no output because its server was
   * not running reported `Done` with an audit trail holding only the echoed
   * instruction — measured in the running app, against a refused port and
   * against a model that was not pulled. Throwing is what reaches the user:
   * the runtime already turns a thrown error into a `failed` session and
   * records the message in the trail, which is how `Cancelled` gets there too.
   */
  async #ask(messages: ChatMessage[], signal: AbortSignal | undefined): Promise<string | null> {
    const url = `${this.#config.host.replace(/\/+$/, '')}/api/chat`;
    let content = '';
    let failure: string | null = null;
    /** An error the server sent as a frame rather than as an HTTP status. */
    let reported: string | null = null;

    await new Promise<void>((resolve) => {
      let settled = false;
      let onAbort: (() => void) | null = null;
      const finish = () => {
        if (onAbort) {
          signal?.removeEventListener('abort', onAbort);
          onAbort = null;
        }
        if (settled) return;
        settled = true;
        resolve();
      };

      /**
       * Cancel, and settle either way. `close` drops the listeners, so `onEnd`
       * cannot arrive after it — if closing rejected and nothing else called
       * `finish`, this promise would never settle and a cancelled session would
       * sit at "running" for the life of the app.
       */
      const cancel = (stream: JsonLinesStream) => void stream.close().then(finish, finish);

      void this.#platform
        .streamJsonLines(
          {
            url,
            body: {
              model: this.#config.model,
              stream: true,
              // A structured-output task, not a creative one. Determinism also
              // makes a bad turn reproducible instead of a ghost.
              options: { temperature: 0 },
              messages,
            },
          },
          (line) => {
            try {
              const frame = JSON.parse(line) as {
                error?: unknown;
                message?: { content?: string };
              };
              // A failure the server decided on after it had already answered
              // 200 arrives here, as a frame, and not as a transport error at
              // all — so a check on the HTTP status cannot see it and a reader
              // that only looks at `message.content` files it as an empty turn.
              if (typeof frame.error === 'string' && frame.error !== '') {
                reported = frame.error;
                return;
              }
              content += frame.message?.content ?? '';
            } catch {
              // A frame that is not JSON is not fatal: the reply so far still
              // stands, and the parse of the whole turn is what decides.
            }
          },
          (error) => {
            failure = error;
            finish();
          },
        )
        .then((stream) => {
          // A fast server ends the request before this resolves, and then
          // there is nothing left to cancel — registering anyway would leave a
          // listener on the session's signal for every turn of the
          // conversation. Cancelling mid-generation is what this is for.
          if (!signal || settled) return;
          if (signal.aborted) {
            cancel(stream);
            return;
          }
          onAbort = () => cancel(stream);
          signal.addEventListener('abort', onAbort, { once: true });
        })
        .catch((error: unknown) => {
          failure = error instanceof Error ? error.message : String(error);
          finish();
        });
    });

    // Cancellation is checked first and reported as nothing at all. A closed
    // connection can also surface as a transport error, and a user who
    // cancelled is owed "Cancelled" rather than a failure they caused on
    // purpose.
    if (signal?.aborted) return null;

    if (failure !== null) {
      const message = reportedError(failure);
      // Naming the host in both: a refused connection is nearly always the
      // wrong one, and `agents.json` is not on screen for the user to check.
      throw new Error(
        message === null
          ? `Could not reach the model server at ${this.#config.host}: ${failure}`
          : `The model server at ${this.#config.host} refused the request: ${message}`,
      );
    }

    if (reported !== null) {
      throw new Error(`The model server at ${this.#config.host} reported: ${reported}`);
    }

    return content;
  }
}

/**
 * Ollama's own message inside `text`, or null if there is none.
 *
 * Recorded against 0.32.13, not guessed at. The server says what went wrong in
 * a JSON object with one `error` string, and that object reaches this file two
 * ways:
 *
 * - as the body of an HTTP failure, which the platform seam hands over as
 *   `404 Not Found: {"error":"model 'llama3.3:70b' not found"}` — status and
 *   body, since nothing down there knows which half means anything;
 * - as a line in an otherwise successful stream — status 200, ordinary frames,
 *   then `{"error":"pull model manifest: file does not exist"}`.
 *
 * Scanning from the first `{` rather than parsing the whole string is what
 * covers both without the seam having to label them.
 */
function reportedError(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(start)) as { error?: unknown };
    return typeof parsed.error === 'string' && parsed.error !== '' ? parsed.error : null;
  } catch {
    return null;
  }
}

/** What the model is told came back. */
function describeResponse(response: CoreResponse | undefined): string {
  if (!response) return 'ok';
  if (response.ok) return JSON.stringify(response.result);
  return `error ${response.error.code}: ${response.error.message}`;
}

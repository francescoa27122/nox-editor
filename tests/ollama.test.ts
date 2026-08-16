import { history } from '@codemirror/commands';
import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import type { Platform } from '../src/platform/types';
import { OllamaProvider, parseTurn, resolveEdit } from '../src/services/agent/ollama';
import type { OllamaAgentConfig } from '../src/services/agent/config';
import type { CoreResponse, RequestBody } from '../src/services/agent/protocol';
import type { AnswerExpectation, ModelChunk } from '../src/services/agent/provider';
import { AgentRuntime, ProviderTransport, type AgentSession } from '../src/services/agent/runtime';
import { CommandRegistry } from '../src/services/commands';
import { ContextService } from '../src/services/context';
import { FileTreeService } from '../src/services/filetree';
import { JobRunner } from '../src/services/jobs';
import { PermissionService } from '../src/services/permissions';
import { ReviewService } from '../src/services/review';
import { WorkspaceService, type BufferId } from '../src/services/workspace';

/**
 * The Ollama provider and the platform seam beneath it.
 *
 * Everything here drives a fake `streamJsonLines`, replaying frames recorded
 * from a real Ollama 0.32.13 running qwen2.5-coder:7b. Invented fixtures are
 * how an integration passes its tests and fails on contact — these are what
 * the server actually sent.
 */

describe('the platform seam', () => {
  /**
   * The failure this prevents: the browser target silently pretending it can
   * reach a model server, so the agent panel offers a session that can never
   * start.
   */
  it('reports no local models on the memory platform', () => {
    expect(new MemoryPlatform().capabilities.localModels).toBe(false);
  });

  /**
   * The failure this prevents: an unsupported platform returning a dead
   * stream rather than saying so, which would surface as a session that
   * hangs instead of an error naming the cause.
   */
  it('refuses to stream on a platform with no local models', async () => {
    const platform = new MemoryPlatform();
    await expect(
      platform.streamJsonLines({ url: 'http://127.0.0.1:11434/api/chat', body: {} }, () => {}, () => {}),
    ).rejects.toThrow();
  });
});

describe('parsing a turn', () => {
  it('reads a bare object', () => {
    const parsed = parseTurn('{"method":"context.openBuffers"}');
    expect(parsed.action).toEqual({ method: 'context.openBuffers' });
    expect(parsed.error).toBeNull();
  });

  /**
   * The failure this prevents: requiring the model to obey "no code fences".
   * Recorded from a real session, qwen2.5-coder fenced one turn and not the
   * next, having been told not to fence at all. Tolerance is available;
   * consistency is not.
   */
  it('reads an object wrapped in a code fence', () => {
    const parsed = parseTurn('```json\n{"method":"context.openBuffers"}\n```');
    expect(parsed.action).toEqual({ method: 'context.openBuffers' });
  });

  it('reads an object in an unlabelled fence', () => {
    const parsed = parseTurn('```\n{"method":"context.openBuffers"}\n```');
    expect(parsed.action).toEqual({ method: 'context.openBuffers' });
  });

  it('keeps params', () => {
    const parsed = parseTurn('{"method":"context.bufferText","params":{"bufferId":"b1"}}');
    expect(parsed.action).toEqual({
      method: 'context.bufferText',
      params: { bufferId: 'b1' },
    });
  });

  /**
   * The failure this prevents: narration being swallowed. A model that says
   * what it is about to do and then does it is using the interface as
   * designed — text and action share one stream on purpose.
   */
  it('returns prose before an object as text', () => {
    const parsed = parseTurn('Let me look at the file.\n{"method":"context.openBuffers"}');
    expect(parsed.text).toBe('Let me look at the file.');
    expect(parsed.action).toEqual({ method: 'context.openBuffers' });
  });

  /**
   * The failure this prevents: guessing at what a model meant by a second
   * object. One action per turn is the contract; the rest is noise.
   */
  it('ignores anything after the first object', () => {
    const parsed = parseTurn('{"method":"context.openBuffers"}\n{"method":"session.summary","params":{"text":"done"}}');
    expect(parsed.action).toEqual({ method: 'context.openBuffers' });
  });

  /**
   * The failure this prevents: a malformed turn ending the session. The model
   * gets the error back and another attempt.
   */
  it('reports unparseable output rather than throwing', () => {
    const parsed = parseTurn('I think the answer is 42.');
    expect(parsed.action).toBeNull();
    expect(parsed.error).toMatch(/no JSON/i);
  });

  it('reports an object with no method', () => {
    const parsed = parseTurn('{"foo":"bar"}');
    expect(parsed.action).toBeNull();
    expect(parsed.error).toMatch(/method/i);
  });

  /**
   * The failure this prevents: accepting a method outside the vocabulary —
   * including `command.execute`, which is deliberately not offered this
   * cycle. An agent must have no route to a side effect.
   */
  it('rejects a method outside the vocabulary', () => {
    const parsed = parseTurn('{"method":"command.execute","params":{"commandId":"file.save"}}');
    expect(parsed.action).toBeNull();
    expect(parsed.error).toMatch(/command\.execute/);
  });

  /**
   * The failure this prevents: a brace anywhere in narration about code
   * ending the turn. The first `{` used to be committed to irrevocably — an
   * unmatched brace in prose ran the scan to the end of the string without
   * ever returning to depth zero, so a perfectly good action after it was
   * never reached. Also asserts `text`: an earlier fix computed narration as
   * everything before the first raw `{` character, which truncated it at
   * the stray brace in "the {" — this must recover the *full* sentence,
   * because the stray brace never closes and so isn't a real JSON ancestor
   * of the action that follows it.
   */
  it('recovers a good action after an unbalanced brace in narration', () => {
    const parsed = parseTurn('I will change the { to a ( first.\n{"method":"context.openBuffers"}');
    expect(parsed.action).toEqual({ method: 'context.openBuffers' });
    expect(parsed.error).toBeNull();
    expect(parsed.text).toBe('I will change the { to a ( first.');
  });

  /**
   * The failure this prevents: prose that happens to contain a *balanced*
   * brace pair — a code snippet quoted in narration — being handed to
   * `JSON.parse` as if it were the action, instead of the action that
   * actually follows it. Also asserts `text`: the rejected `{ return; }`
   * candidate is its own top-level object, not an ancestor of the real one,
   * so it must not truncate the narration either.
   */
  it('recovers a good action after a balanced but non-JSON brace pair in narration', () => {
    const parsed = parseTurn('The block is `{ return; }` today.\n{"method":"context.openBuffers"}');
    expect(parsed.action).toEqual({ method: 'context.openBuffers' });
    expect(parsed.error).toBeNull();
    expect(parsed.text).toBe('The block is `{ return; }` today.');
  });

  /**
   * The failure this prevents: prose containing valid-but-irrelevant JSON
   * (no recognizable "method") short-circuiting the search, so the model's
   * real action later in the same reply is never considered. Also asserts
   * `text`: the rejected `{"a":1}` is a sibling of the real object, not its
   * ancestor, so the full narration — including that irrelevant object —
   * must be preserved rather than truncated at it.
   */
  it('recovers a good action after a valid object with no method in narration', () => {
    const parsed = parseTurn('Here is the shape: {"a":1}\n{"method":"context.openBuffers"}');
    expect(parsed.action).toEqual({ method: 'context.openBuffers' });
    expect(parsed.error).toBeNull();
    expect(parsed.text).toBe('Here is the shape: {"a":1}');
  });

  /**
   * The failure this prevents: when nothing in the reply ever parses, the
   * single-candidate failure message (e.g. "no method") must still surface —
   * retrying at later braces should not paper over the one real complaint
   * with a generic "no JSON object" once every candidate is exhausted.
   */
  it('reports the first failure when no candidate succeeds', () => {
    const parsed = parseTurn('{"a":1} and also {"b":2}');
    expect(parsed.action).toBeNull();
    expect(parsed.error).toMatch(/method/i);
  });

  /**
   * The failure this prevents: `as RequestBody` asserting a shape that was
   * never checked. `session.note` requires a `params.text`; without
   * validation this silently returns an action whose `params` is undefined,
   * and a consumer typed against `RequestBody` doing `action.params.text`
   * gets a runtime TypeError on a value the type system promised was safe.
   */
  it('rejects a method whose required params are missing', () => {
    const parsed = parseTurn('{"method":"session.note"}');
    expect(parsed.action).toBeNull();
    expect(parsed.error).toMatch(/params/i);
  });

  /**
   * The failure this prevents: `params` passed through unchecked when it is
   * present but the wrong type — `proposal.stage` requires an object with
   * `description`/`edits`, and a bare number would reach a consumer as if it
   * were that object.
   */
  it('rejects a method whose params are the wrong type', () => {
    const parsed = parseTurn('{"method":"proposal.stage","params":42}');
    expect(parsed.action).toBeNull();
    expect(parsed.error).toMatch(/params/i);
  });

  /**
   * The failure this prevents: a method that takes no params silently
   * accepting one anyway, so the built action's shape no longer matches what
   * `RequestBody` promises for `context.openBuffers`.
   */
  it('rejects context.openBuffers when given params it does not take', () => {
    const parsed = parseTurn('{"method":"context.openBuffers","params":{}}');
    expect(parsed.action).toBeNull();
    expect(parsed.error).toMatch(/params/i);
  });

  /**
   * The failure this prevents: a scanner that counts every `{`/`}` character
   * regardless of whether it's inside a string. A `find` string quoting an
   * unbalanced brace — an ordinary substring of real code — pushes such a
   * scanner's depth counter past what the real JSON structure ever closes,
   * so it never returns to zero and the whole action is lost. All nine tests
   * above passed against a scanner with this bug ablated in; this is the
   * test that catches it.
   */
  it('parses an action whose params contain an unbalanced brace inside a string', () => {
    const parsed = parseTurn(
      '{"method":"proposal.stage","params":{"description":"d","edits":[{"find":"if (x) {","replace":"y"}]}}',
    );
    expect(parsed.action).toEqual({
      method: 'proposal.stage',
      params: { description: 'd', edits: [{ find: 'if (x) {', replace: 'y' }] },
    });
    expect(parsed.error).toBeNull();
  });

  /**
   * The failure this prevents: a scanner that tracks strings by toggling on
   * every `"` without understanding `\"` as an escaped quote inside one. That
   * exits the string early, so a later structural brace inside what is still
   * really string content gets miscounted as real JSON structure.
   */
  it('parses an action whose params contain an escaped quote inside a string', () => {
    const parsed = parseTurn('{"method":"session.note","params":{"text":"quote \\" then } brace"}}');
    expect(parsed.action).toEqual({
      method: 'session.note',
      params: { text: 'quote " then } brace' },
    });
    expect(parsed.error).toBeNull();
  });

  /**
   * The failure this prevents: a lazy non-greedy regex (`/\{[\s\S]*?\}/`)
   * stopping at the first `}` anywhere in the content — including one inside
   * a string value — and handing `JSON.parse` a truncated, invalid fragment
   * instead of the whole object.
   */
  it('parses an action whose params contain a closing brace inside a string', () => {
    const parsed = parseTurn('{"method":"session.note","params":{"text":"done: x}"}}');
    expect(parsed.action).toEqual({
      method: 'session.note',
      params: { text: 'done: x}' },
    });
    expect(parsed.error).toBeNull();
  });

  /**
   * The failure this prevents: when an outer object is valid JSON but fails
   * validation (no recognizable "method") and an inner object is promoted
   * instead, `text` reverting to the slice before *that* candidate rather
   * than before the reply's first brace. That would surface a broken JSON
   * fragment (`{"tool_call":`) as if it were the model's narration.
   */
  it('reports narration from before the first brace even when an inner object wins', () => {
    const parsed = parseTurn('Explanation.\n{"tool_call": {"method":"context.openBuffers"}}');
    expect(parsed.action).toEqual({ method: 'context.openBuffers' });
    expect(parsed.text).toBe('Explanation.');
  });

  /**
   * The failure this prevents: the retry loop re-scanning from scratch at
   * every failed `{`, making cost (failing candidates) × (remaining length).
   * A model stuck repeating a character, or a reply truncated mid-emission,
   * produces exactly this input shape. A quadratic parser is a smaller
   * version of the same bug the fence regex had — this bounds it the same
   * way the fence fix did, at a size too small to make a slow CI run even if
   * the regression comes back, but far past where the old approach's curve
   * would already show.
   */
  it('resolves a long run of unbalanced braces without quadratic blowup', () => {
    const input = '{'.repeat(30_000);
    const start = performance.now();
    const parsed = parseTurn(input);
    const elapsed = performance.now() - start;
    expect(parsed.action).toBeNull();
    expect(elapsed).toBeLessThan(300);
  });

  /**
   * The failure this prevents: prose deciding what the scanner believes about
   * strings. An agent narrating about code produces unbalanced quotes
   * constantly — a measurement, a partial quotation, a path — and braces just
   * as often, and every previous attempt to scope one string state to the
   * "right" region traded one of these shapes for another:
   *
   * - tracking from index 0 lost the first three (an odd `"` in narration
   *   flipped the scanner into "in string" for the rest of the reply): 3.5%
   *   of actions in a 30,000-reply fuzz;
   * - scoping the tracking to "inside an open candidate" recovered those and
   *   lost the last two instead, because a `{` inside a quoted span in prose
   *   opens a candidate and re-arms the identical trap: 3.8%.
   *
   * The last two are the discriminating pair — they fail on both of those
   * earlier heads, and the fourth is the one whose absence from round 3's own
   * fuzz corpus let the regression through. Each asserts `text` as well, so a
   * scanner that finds the action by truncating the narration at a prose
   * brace cannot pass.
   */
  it.each([
    ['an odd quote before a measurement', 'A 6" ruler.'],
    ['an unterminated quote', 'The "use strict pragma.'],
    ['two quotes and a third left open', 'He said "hi" and "bye.'],
    ['a brace inside a quoted span', 'He said "the { brace" out loud.'],
    ['a brace and an unbalanced quote after it', 'I will change the { to a ( and a 6" gap.'],
  ])('recovers a good action after narration with %s', (_label, narration) => {
    const parsed = parseTurn(`${narration}\n{"method":"context.openBuffers"}`);
    expect(parsed.action).toEqual({ method: 'context.openBuffers' });
    expect(parsed.error).toBeNull();
    expect(parsed.text).toBe(narration);
  });

  /**
   * The failure this prevents: a `\` being treated as escaping the character
   * after it everywhere rather than only suppressing a following quote. The
   * backslash has to sit immediately before the `{` with nothing between —
   * the earlier version of this test put a newline there, so the newline was
   * consumed as the escaped character and the brace was reached intact, which
   * meant the test passed against the very bug it was written to catch.
   */
  it('recovers a good action after narration ending in a backslash', () => {
    const parsed = parseTurn('Careful with this: \\{"method":"context.openBuffers"}');
    expect(parsed.action).toEqual({ method: 'context.openBuffers' });
    expect(parsed.error).toBeNull();
    expect(parsed.text).toBe('Careful with this: \\');
  });

  /**
   * The failure this prevents: fixing braces-in-prose and braces-in-JSON-
   * strings with two scanners that each cover the other's blind spot, which
   * works until one reply contains both. A string-unaware scan miscounts the
   * `{` inside the `find` string; a string-aware scan that inherits its quote
   * state from the narration never sees the action's own braces. This reply
   * needs one scanner that is right about both at once.
   */
  it('recovers a staged edit with braces in its strings after a brace inside a quoted span', () => {
    const parsed = parseTurn(
      'He said "the { brace" out loud.\n' +
        '{"method":"proposal.stage","params":{"description":"d","edits":[{"find":"if (x) {","replace":"y"}]}}',
    );
    expect(parsed.action).toEqual({
      method: 'proposal.stage',
      params: { description: 'd', edits: [{ find: 'if (x) {', replace: 'y' }] },
    });
    expect(parsed.error).toBeNull();
    expect(parsed.text).toBe('He said "the { brace" out loud.');
  });
});

describe('resolving an edit', () => {
  const doc = 'export function add(a: number, b: number) {\n  return a + b;\n}\n';

  it('turns quoted text into offsets', () => {
    const resolved = resolveEdit(doc, 'function add(', 'function sum(');
    expect(resolved).toEqual({ from: 7, to: 20, insert: 'function sum(' });
  });

  /**
   * The failure this prevents: a silent no-op. A model that quotes text which
   * is not in the buffer has misread it, and staging nothing while reporting
   * success is the worst available answer.
   */
  it('refuses text that is not present', () => {
    const resolved = resolveEdit(doc, 'function subtract(', 'function sum(');
    expect(resolved).toEqual({ error: expect.stringMatching(/not found/i) });
  });

  /**
   * The failure this prevents: editing the wrong one of several identical
   * lines. Taking the first match silently corrupts a file in a way the diff
   * looks plausible enough to accept.
   */
  it('refuses ambiguous text and says how many matches', () => {
    const repeated = 'const x = 1;\nconst x = 1;\n';
    const resolved = resolveEdit(repeated, 'const x = 1;', 'const y = 2;');
    expect(resolved).toEqual({ error: expect.stringMatching(/2 matches/) });
  });

  /**
   * The failure this prevents: an empty find matching at position 0, which
   * would insert at the top of the file — never what was meant.
   */
  it('refuses an empty find', () => {
    const resolved = resolveEdit(doc, '', 'anything');
    expect(resolved).toEqual({ error: expect.stringMatching(/empty/i) });
  });

  it('allows a replacement that deletes', () => {
    const resolved = resolveEdit(doc, '  return a + b;\n', '');
    expect(resolved).toEqual({ from: 44, to: 60, insert: '' });
  });
});

const CONFIG: OllamaAgentConfig = {
  id: 'local', label: 'Qwen', kind: 'ollama',
  host: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:7b',
};

/** Split a reply the way Ollama does: a few characters per frame. */
function framesFor(content: string): string[] {
  const frames = [...content].map((char) =>
    JSON.stringify({ model: 'qwen2.5-coder:7b', message: { role: 'assistant', content: char }, done: false }),
  );
  frames.push(JSON.stringify({ model: 'qwen2.5-coder:7b', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }));
  return frames;
}

/**
 * A platform whose stream replays one scripted reply per request.
 *
 * `before` runs at the top of each request, which is the only moment a test
 * can act *between* the model's last result and its next reply — the window a
 * user's keystroke lands in.
 */
function fakePlatform(replies: string[], before?: (turn: number) => void) {
  const bodies: unknown[] = [];
  let turn = 0;
  const platform = {
    capabilities: { localModels: true },
    async streamJsonLines(spec: { body: unknown }, onLine: (line: string) => void, onEnd: (e: string | null) => void) {
      before?.(turn);
      // Snapshotted, not aliased: `complete` appends to one `messages` array
      // for the whole conversation, so keeping the reference would make every
      // recorded body the *final* transcript. Assertions meant as "this was
      // sent on request N" would then pass for anything said at any point.
      bodies.push(structuredClone(spec.body));
      const reply = replies[turn++] ?? '{"method":"session.summary","params":{"text":"done"}}';
      for (const frame of framesFor(reply)) onLine(frame);
      onEnd(null);
      return { async close() {} };
    },
  } as unknown as Platform;
  return { platform, bodies };
}

/** Drive a stream to completion, feeding a fixed response back each time. */
async function drain(provider: OllamaProvider, instruction = 'do a thing') {
  const chunks = [];
  const stream = provider.complete({ instruction, context: '' });
  let response: never | undefined = undefined;
  for (;;) {
    const step = await stream.next(response as never);
    if (step.done) break;
    chunks.push(step.value);
  }
  return chunks;
}

/**
 * Drive a stream, answering each action with whatever `respond` says.
 *
 * The plain `drain` above answers everything with `undefined`, which is enough
 * for a loop test but not for anything that turns on what came back — a read
 * the provider has to remember, above all.
 */
async function driveWith(
  provider: OllamaProvider,
  respond: (request: RequestBody) => CoreResponse | undefined,
) {
  const chunks: ModelChunk[] = [];
  const stream = provider.complete({ instruction: 'do a thing', context: '' });
  let response: CoreResponse | undefined = undefined;
  for (;;) {
    const step = await stream.next(response);
    if (step.done) break;
    chunks.push(step.value);
    response = step.value.type === 'action' ? respond(step.value.request) : undefined;
  }
  return chunks;
}

/** The one action of a given method the provider yielded, if it yielded one. */
function actionFor(chunks: ModelChunk[], method: string): RequestBody | undefined {
  const chunk = chunks.find((c) => c.type === 'action' && c.request.method === method);
  return chunk?.type === 'action' ? chunk.request : undefined;
}

/** The transcript the provider sent on request `index`, as one string. */
function sentOn(bodies: unknown[], index: number): string {
  return JSON.stringify((bodies[index] as { messages: unknown }).messages);
}

/** The host in `agents.json` during step 7 of the walk. Nothing listens there. */
const UNREACHABLE: OllamaAgentConfig = { ...CONFIG, host: 'http://127.0.0.1:11499' };

/**
 * What the transport reports for a refused connection.
 *
 * Recorded, not written: reqwest 0.12.28 — the version `src-tauri` builds
 * against — returns exactly this for a POST to `http://127.0.0.1:11499`, and
 * `run_stream` hands `error.to_string()` straight to `onEnd`.
 */
const REFUSED = 'error sending request for url (http://127.0.0.1:11499/api/chat)';

/**
 * What the transport reports for a model that is not pulled.
 *
 * Recorded against Ollama 0.32.13: `POST /api/chat` with `llama3.3:70b` — the
 * model set in `agents.json` during step 8 of the walk — answers
 * `404 Not Found` with `{"error":"model 'llama3.3:70b' not found"}` as the
 * whole body, which `run_stream` formats as `{status}: {detail}`.
 */
const MODEL_MISSING = `404 Not Found: {"error":"model 'llama3.3:70b' not found"}`;

/**
 * A failure that arrives *inside* a successful stream.
 *
 * Recorded against the same 0.32.13 server: status 200, ordinary frames, then
 * a bare `{"error":"..."}` line. The frames are from `/api/pull`, which is the
 * endpoint that could be made to fail after its headers were flushed — every
 * `/api/chat` failure provoked on this server (bad model, unsupported
 * multimodal input, bad `format`, `think` on a model without it) answered with
 * a non-2xx status instead. The frame shape is the server's one shape for
 * saying so mid-stream, and it is the case a status check cannot see.
 */
const ERROR_FRAME = [
  '{"status":"pulling manifest"}',
  '{"error":"pull model manifest: file does not exist"}',
];

/** A platform whose single request replays a recorded failure. */
function failingPlatform(lines: string[], endError: string | null) {
  let requests = 0;
  const platform = {
    capabilities: { localModels: true },
    async streamJsonLines(
      _spec: unknown,
      onLine: (line: string) => void,
      onEnd: (e: string | null) => void,
    ) {
      requests++;
      for (const line of lines) onLine(line);
      onEnd(endError);
      return { async close() {} };
    },
  } as unknown as Platform;
  return { platform, requests: () => requests };
}

/**
 * A platform that delivers frames a macrotask apart, and counts closes.
 *
 * The other fake replies inside the call that started it, which leaves no
 * moment at which a request is in flight. Cancelling *during* generation is
 * the case worth testing, and it needs a stream that is still running when the
 * test gets control back.
 */
function slowPlatform(reply: string, options: { closeRejects?: boolean } = {}) {
  let closes = 0;
  let firstFrameSent = () => {};
  const streaming = new Promise<void>((resolve) => {
    firstFrameSent = resolve;
  });

  const platform = {
    capabilities: { localModels: true },
    async streamJsonLines(_spec: unknown, onLine: (line: string) => void, onEnd: (e: string | null) => void) {
      let alive = true;
      void (async () => {
        for (const frame of framesFor(reply)) {
          await new Promise((tick) => setTimeout(tick, 0));
          // A closed stream is a dropped connection: nothing more arrives, and
          // `onEnd` never comes either. That is what makes a missing `close()`
          // a hang rather than a slow success.
          if (!alive) return;
          onLine(frame);
          firstFrameSent();
        }
        if (alive) onEnd(null);
      })();

      return {
        async close() {
          closes++;
          alive = false;
          if (options.closeRejects) throw new Error('the connection was already gone');
        },
      };
    },
  } as unknown as Platform;

  return { platform, streaming, closes: () => closes };
}

describe('the provider', () => {
  it('yields the action a model emitted', async () => {
    const { platform } = fakePlatform(['{"method":"context.openBuffers"}']);
    const chunks = await drain(new OllamaProvider(platform, CONFIG));

    expect(chunks[0]).toEqual({ type: 'action', request: { method: 'context.openBuffers' } });
  });

  /**
   * The failure this prevents: a parser that assumes one frame is one
   * message. Ollama streams content a few characters at a time, so no single
   * frame holds a parseable object.
   */
  it('accumulates an object split across frames', async () => {
    const { platform } = fakePlatform(['{"method":"session.note","params":{"text":"hello"}}']);
    const chunks = await drain(new OllamaProvider(platform, CONFIG));

    expect(chunks[0]).toMatchObject({ type: 'action', request: { method: 'session.note' } });
  });

  /**
   * The failure this prevents: a malformed turn ending the session, where the
   * model would have recovered given the error back.
   */
  it('feeds a parse error back and continues', async () => {
    const { platform, bodies } = fakePlatform([
      'I think the answer is 42.',
      '{"method":"session.summary","params":{"text":"done"}}',
    ]);
    await drain(new OllamaProvider(platform, CONFIG));

    const second = bodies[1] as { messages: { role: string; content: string }[] };
    expect(JSON.stringify(second.messages)).toMatch(/no JSON object/);
  });

  /**
   * The failure this prevents: an infinite retry loop against a model that
   * cannot produce the format at all.
   *
   * It throws rather than returning, because returning is what the runtime
   * reads as a finished session — see "a session that ended for a reason of
   * its own" below for what the user is shown. The reason is carried in the
   * message: "gave up" without saying at what is not much better than `Done`.
   */
  it('gives up after two unparseable turns in a row', async () => {
    const { platform, bodies } = fakePlatform(['nonsense one', 'nonsense two', 'nonsense three']);

    await expect(drain(new OllamaProvider(platform, CONFIG))).rejects.toThrow(/no JSON object/);

    expect(bodies.length).toBeLessThanOrEqual(2);
  });

  /**
   * The failure this prevents: a small model re-reading the same buffer
   * forever, which it will do given the chance.
   */
  it('stops at the turn cap', async () => {
    const { platform, bodies } = fakePlatform(new Array(50).fill('{"method":"context.openBuffers"}'));
    await drain(new OllamaProvider(platform, { ...CONFIG, maxTurns: 3 }));

    expect(bodies).toHaveLength(3);
  });

  /**
   * The failure this prevents: an unreachable server being retried until the
   * turn cap. `#ask` gets an end event carrying an error and no content, and a
   * loop that treated that as an empty turn would ask a server that is not
   * there twelve more times before giving up.
   *
   * What the *session* is told about it is the subject of "a failure the user
   * must see" below; this is only the loop.
   */
  it('does not retry a stream that reported a failure', async () => {
    const { platform, requests } = failingPlatform([], REFUSED);

    await expect(drain(new OllamaProvider(platform, UNREACHABLE))).rejects.toThrow();

    expect(requests()).toBe(1);
  });

  it('stops when the model emits a summary', async () => {
    const { platform, bodies } = fakePlatform(['{"method":"session.summary","params":{"text":"all done"}}']);
    const chunks = await drain(new OllamaProvider(platform, CONFIG));

    expect(bodies).toHaveLength(1);
    expect(chunks.at(-1)).toMatchObject({ request: { method: 'session.summary' } });
  });

  /**
   * The failure this prevents: a cancelled session carrying on to its next
   * round trip. Nothing is in flight between turns, so this is the loop's
   * abort check and nothing else — see the mid-generation test below for the
   * request that is actually open when a user cancels.
   */
  it('stops when the signal aborts', async () => {
    const controller = new AbortController();
    const { platform } = fakePlatform(new Array(20).fill('{"method":"context.openBuffers"}'));
    const provider = new OllamaProvider(platform, CONFIG);

    const stream = provider.complete({ instruction: 'x', context: '', signal: controller.signal });
    await stream.next();
    controller.abort();
    const after = await stream.next(undefined as never);

    expect(after.done).toBe(true);
  });

  /**
   * The failure this prevents: a cancelled session leaving the request open
   * and the model still generating — burning a local GPU on a reply nobody
   * will read, for as long as it takes to finish.
   *
   * A user cancels while tokens are arriving, which is the only moment there
   * is anything to cancel. `close()` is the assertion that matters: the loop's
   * own abort check ends the generator either way, so a test that only looked
   * at `done` would pass with no cancellation happening at all.
   */
  it('closes the request when the signal aborts mid-generation', async () => {
    const controller = new AbortController();
    const { platform, streaming, closes } = slowPlatform('{"method":"context.openBuffers"}');
    const provider = new OllamaProvider(platform, CONFIG);

    const stream = provider.complete({ instruction: 'x', context: '', signal: controller.signal });
    const first = stream.next();
    await streaming;
    controller.abort();

    expect(await first).toMatchObject({ done: true });
    expect(closes()).toBe(1);
  });

  /**
   * The failure this prevents: a session stuck at "running" for the life of
   * the app. `close()` drops the listeners, so a rejection there means `onEnd`
   * can no longer arrive — nothing else would ever settle the round trip.
   */
  it('ends the session even when closing the request fails', async () => {
    const controller = new AbortController();
    const { platform, streaming } = slowPlatform('{"method":"context.openBuffers"}', {
      closeRejects: true,
    });
    const provider = new OllamaProvider(platform, CONFIG);

    const stream = provider.complete({ instruction: 'x', context: '', signal: controller.signal });
    const first = stream.next();
    await streaming;
    controller.abort();

    expect(await first).toMatchObject({ done: true });
  });

  /**
   * The failure this prevents: a session that does nothing and reports
   * success. `maxTurns` is hand-edited and the loader keeps whatever number it
   * finds, so a zero reaches the loop and its body never runs — which looks
   * like a broken agent, not a mis-set number.
   */
  it('runs a turn however the cap is misconfigured', async () => {
    for (const maxTurns of [0, -3, Number.NaN]) {
      const { platform, bodies } = fakePlatform(['{"method":"session.summary","params":{"text":"done"}}']);
      const chunks = await drain(new OllamaProvider(platform, { ...CONFIG, maxTurns }));

      expect(bodies.length).toBeGreaterThanOrEqual(1);
      expect(chunks.at(-1)).toMatchObject({ request: { method: 'session.summary' } });
    }
  });
});

describe('staging an edit the model quoted', () => {
  const DOC = 'const a = 1;\nconst b = 2;\n';

  /** A stage of `find`/`replace`, as the model actually emits one. */
  function stageReply(bufferId: string, find: string, replace = 'const b = 3;'): string {
    return JSON.stringify({
      method: 'proposal.stage',
      params: { description: 'bump b', edits: [{ bufferId, find, replace }] },
    });
  }

  /** Answer a whole-buffer read with `DOC`, and everything else with `null`. */
  const answerReads = (request: RequestBody): CoreResponse =>
    request.method === 'context.bufferText'
      ? { id: 1, ok: true, result: DOC }
      : { id: 1, ok: true, result: null };

  /**
   * The failure this prevents: `find`/`replace` reaching `proposal.stage`,
   * which takes `{from,to,insert}` and has no idea what a quote is. It would
   * stage a change set built from `undefined` offsets — a diff the user is
   * invited to apply.
   */
  it('rewrites quoted text into offsets against the buffer the model read', async () => {
    const { platform } = fakePlatform([
      '{"method":"context.bufferText","params":{"bufferId":"b1"}}',
      stageReply('b1', 'const b = 2;'),
      '{"method":"session.summary","params":{"text":"done"}}',
    ]);

    const chunks = await driveWith(new OllamaProvider(platform, CONFIG), answerReads);

    expect(actionFor(chunks, 'proposal.stage')).toEqual({
      method: 'proposal.stage',
      params: {
        description: 'bump b',
        edits: [{ bufferId: 'b1', changes: { from: 13, to: 25, insert: 'const b = 3;' } }],
      },
    });
  });

  /**
   * The failure this prevents: an edit staged against text the provider never
   * saw. There is nothing to resolve the quote against, so the only honest
   * options are refusing it or inventing offsets — and inventing them puts a
   * corrupting diff in front of the user with the agent's name on it.
   */
  it('refuses a stage against a buffer the model never read', async () => {
    const { platform, bodies } = fakePlatform([
      stageReply('b1', 'const b = 2;'),
      '{"method":"session.summary","params":{"text":"done"}}',
    ]);

    const chunks = await driveWith(new OllamaProvider(platform, CONFIG), answerReads);

    expect(actionFor(chunks, 'proposal.stage')).toBeUndefined();
    // Matched on the refusal's own words. `context.bufferText` would match the
    // system prompt, which is in every request ever sent.
    expect(sentOn(bodies, 1)).toMatch(/have not read b1/);
    // Sent on the second request and not the first: `complete` mutates one
    // `messages` array, so a fixture recording it by reference would show the
    // whole conversation on every request and this pair could not disagree.
    expect(sentOn(bodies, 0)).not.toMatch(/have not read b1/);
    // The session continues: the model is told what to do and does it.
    expect(actionFor(chunks, 'session.summary')).toBeDefined();
  });

  /**
   * The failure this prevents: a bad quote ending the turn silently. The model
   * can requote given `resolveEdit`'s reason — it cannot given "that failed".
   */
  it('refuses an unresolvable quote and hands back the reason', async () => {
    const repeated = 'x = 1;\nx = 1;\n';
    const { platform, bodies } = fakePlatform([
      '{"method":"context.bufferText","params":{"bufferId":"b1"}}',
      stageReply('b1', 'x = 1;', 'x = 2;'),
      '{"method":"session.summary","params":{"text":"done"}}',
    ]);

    const chunks = await driveWith(new OllamaProvider(platform, CONFIG), (request) =>
      request.method === 'context.bufferText'
        ? { id: 1, ok: true, result: repeated }
        : { id: 1, ok: true, result: null },
    );

    expect(actionFor(chunks, 'proposal.stage')).toBeUndefined();
    expect(sentOn(bodies, 2)).toMatch(/2 matches/);
  });

  /**
   * The failure this prevents: caching a partial read as if it were the
   * document. `find` offsets are measured from position 0, so text taken from
   * a line range starts in the wrong place and text with a number gutter is
   * not the document at all — either one resolves to offsets that land
   * somewhere else entirely in the real buffer.
   *
   * The stringified boolean is not padding. `parseTurn` checks that `params`
   * is an object and nothing about its fields, and the reader takes any truthy
   * `withLineNumbers` — so this reply is numbered text coming back, and a
   * guard testing `=== true` would file it as the plain document. Quoting
   * `const b = 2;` against `'1\tconst a = 1;\n2\tconst b = 2;'` resolves
   * cleanly to offset 17, which in the real buffer is the middle of the word
   * `const`: `const a = 1;\nconsconst b = 3;`. Inventing a parameter as a
   * string is ordinary behaviour for a small model.
   */
  it.each([
    { how: 'line numbers', params: { withLineNumbers: true }, text: '1\tconst a = 1;\n2\tconst b = 2;' },
    { how: 'line numbers asked for as a string', params: { withLineNumbers: 'true' }, text: '1\tconst a = 1;\n2\tconst b = 2;' },
    { how: 'a line range', params: { lines: { from: 2, to: 2 } }, text: 'const b = 2;' },
  ])('does not resolve against a read with $how', async ({ params, text }) => {
    const { platform, bodies } = fakePlatform([
      JSON.stringify({ method: 'context.bufferText', params: { bufferId: 'b1', ...params } }),
      stageReply('b1', 'const b = 2;'),
      '{"method":"session.summary","params":{"text":"done"}}',
    ]);

    const chunks = await driveWith(new OllamaProvider(platform, CONFIG), (request) =>
      request.method === 'context.bufferText'
        ? { id: 1, ok: true, result: text }
        : { id: 1, ok: true, result: null },
    );

    expect(actionFor(chunks, 'proposal.stage')).toBeUndefined();
    expect(sentOn(bodies, 2)).toMatch(/have not read b1/);
  });

  /**
   * The failure this prevents: a model that cannot quote correctly staging
   * forever. A refusal is a turn that produced nothing usable, exactly like an
   * unparseable one, and it ends the session on the same terms.
   */
  it('ends the session after two refused stages in a row', async () => {
    const { platform, bodies } = fakePlatform([
      stageReply('b1', 'const b = 2;'),
      stageReply('b2', 'const b = 2;'),
      stageReply('b3', 'const b = 2;'),
    ]);

    // Thrown, not returned: a returned give-up is a `Done` session with no
    // record that an edit was ever attempted. The refusal itself travels in
    // the message so the user sees what the model got wrong.
    await expect(
      driveWith(new OllamaProvider(platform, CONFIG), answerReads),
    ).rejects.toThrow(/have not read b2/);

    expect(bodies.length).toBeLessThanOrEqual(2);
  });

  /**
   * The failure this prevents: a give-up throwing away a proposal the user
   * could still keep. A model that stages successfully and then falls apart is
   * ordinary for a 7B, and `Failed` beside a change set waiting in the review
   * panel reads as "nothing to see here" — so this one exit ends with a
   * summary and leaves the session awaiting review.
   */
  it('keeps a session awaiting review when it gives up after staging', async () => {
    const { platform } = fakePlatform([
      '{"method":"context.bufferText","params":{"bufferId":"b1"}}',
      stageReply('b1', 'const b = 2;'),
      'nonsense one',
      'nonsense two',
    ]);

    const chunks = await driveWith(new OllamaProvider(platform, CONFIG), answerReads);

    expect(actionFor(chunks, 'proposal.stage')).toBeDefined();
    expect(actionFor(chunks, 'session.summary')).toMatchObject({
      params: { text: expect.stringMatching(/Gave up after two turns/) },
    });
  });
});

/**
 * The real services a session runs against, with `files` opened as buffers.
 *
 * Handed back so a test can do to the workspace what the user does to it —
 * type in a buffer the agent is halfway through reasoning about — and read the
 * review panel afterwards.
 */
async function sessionWorld(files: Record<string, string> = {}) {
  const memory = new MemoryPlatform();
  const workspace = new WorkspaceService(memory, () => history());
  const tree = new FileTreeService(memory);
  const review = new ReviewService(workspace);
  const runtime = new AgentRuntime({
    workspace,
    context: new ContextService(workspace, tree),
    commands: new CommandRegistry(),
    permissions: new PermissionService(() => workspace.rootPath.get()),
    review,
    jobs: new JobRunner(),
  });

  const opened: Record<string, BufferId> = {};
  const names = Object.keys(files);
  if (names.length > 0) {
    memory.mkdirp('/w');
    for (const name of names) memory.seedFile(`/w/${name}`, files[name]!);
    await workspace.openFolder('/w');
    await tree.setRoot('/w');
    for (const name of names) opened[name] = (await workspace.open(`/w/${name}`))!;
  }

  return { workspace, review, runtime, opened };
}

/**
 * Start a real session against `platform` and wait for it to finish.
 *
 * Nothing below the provider is substituted. The defect these tests exist for
 * was measured at session level — status `Done`, audit trail holding nothing
 * but the echoed instruction — and a provider-level assertion could not have
 * seen it, because the provider returning quietly is precisely the bug.
 */
async function runSession(
  platform: Platform,
  config: OllamaAgentConfig,
  world?: Awaited<ReturnType<typeof sessionWorld>>,
  options?: { instruction?: string; expects?: AnswerExpectation },
) {
  const { runtime } = world ?? (await sessionWorld());

  const session = runtime.start(
    new ProviderTransport(new OllamaProvider(platform, config)),
    options?.instruction ?? 'say hello',
    { label: config.label, ...(options?.expects ? { expects: options.expects } : {}) },
  );

  // A deadline rather than a fixed number of ticks, for the reason
  // `tests/agent.test.ts` gives: a loaded machine gets a different budget.
  const deadline = Date.now() + 10_000;
  while (session.status.get() === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return session;
}

/** Everything the session recorded as an error, as one string. */
function errorsOf(session: AgentSession): string {
  return session.actions
    .get()
    .flatMap((action) => (action.kind === 'error' ? [action.message] : []))
    .join('\n');
}

describe('a failure the user must see', () => {
  /**
   * The failure this prevents: the one measured in the running app at 532baf6.
   * With `agents.json` pointing at a port nothing listens on, the session
   * reported `Local model Done` and its audit trail held exactly one entry —
   * the echoed instruction. A user whose Ollama is not running is told the
   * agent succeeded.
   *
   * The host is named because a refused connection is almost always the wrong
   * host, and the message is the only place the user can see which one was
   * tried — `agents.json` is not on screen.
   */
  it('fails the session and names the host when the connection is refused', async () => {
    const { platform } = failingPlatform([], REFUSED);

    const session = await runSession(platform, UNREACHABLE);

    expect(session.status.get()).toBe('failed');
    expect(errorsOf(session)).toMatch(/http:\/\/127\.0\.0\.1:11499/);
  });

  /**
   * The failure this prevents: the other half of the same measurement. With
   * the host reachable and the model set to one that is not pulled, the
   * session again reported `Done` with only the instruction in its trail,
   * while the server itself was answering `model 'llama3.3:70b' not found`.
   *
   * Ollama's own words are surfaced rather than a status line: the message
   * names the model, which is the thing the user has to change.
   */
  it("surfaces Ollama's message when the model is not pulled", async () => {
    const { platform } = failingPlatform([], MODEL_MISSING);

    const session = await runSession(platform, CONFIG);

    expect(session.status.get()).toBe('failed');
    expect(errorsOf(session)).toMatch(/model 'llama3\.3:70b' not found/);
    // The message, not the envelope. `404 Not Found: {"error":"…"}` is what
    // the transport hands over, and showing that raw puts JSON in front of the
    // user and buries the one sentence that tells them what to do.
    expect(errorsOf(session)).not.toMatch(/\{"error"/);
  });

  /**
   * The failure this prevents: an error that arrives as a frame rather than as
   * an HTTP status being read as content and discarded. The stream is a
   * success by every transport-level measure — 200, frames, a clean end — so
   * anything that only inspects the status, or only looks for
   * `message.content`, sees a turn that produced no output and carries on.
   */
  it('fails the session when a frame in a successful stream carries an error', async () => {
    const { platform } = failingPlatform(ERROR_FRAME, null);

    const session = await runSession(platform, CONFIG);

    expect(session.status.get()).toBe('failed');
    expect(errorsOf(session)).toMatch(/pull model manifest: file does not exist/);
  });
});

describe('an edit staged against a buffer that moved', () => {
  /**
   * Two functions, so a rename on the second line resolves to an offset the
   * first line's length is part of. One character typed at the top is then
   * enough to make those offsets land a character early.
   */
  const MATH = '// math helpers\nexport function multiply(a, b) {\n  return a * b;\n}\n';

  const readReply = (bufferId: BufferId) =>
    JSON.stringify({ method: 'context.bufferText', params: { bufferId } });

  const renameReply = (bufferId: BufferId) =>
    JSON.stringify({
      method: 'proposal.stage',
      params: {
        description: 'Rename multiply to product',
        edits: [
          {
            bufferId,
            find: 'export function multiply(a, b) {',
            replace: 'export function product(a, b) {',
          },
        ],
      },
    });

  /**
   * The failure this prevents, measured at session level against the real
   * workspace, review service and runtime: the user types one space at line 1
   * between the model's read and its `proposal.stage`, and the offsets
   * resolved against the text the model was shown land one character early.
   * The staged hunk was
   * `- ["\n","export function multiply(a, b) {\n"]` /
   * `+ ["export function product(a, b) {{\n"]` — a doubled brace, broken
   * JavaScript, rendered as a clean one-hunk rename attributed to the model
   * and one keystroke from applied.
   *
   * `resolveEdit` cannot catch it: the quote *was* unique in the text the
   * model read. Nor can `ReviewFile.baseRevision`, which is captured at stage
   * time — after the drift.
   */
  it('refuses it, rather than staging a diff computed before the user typed', async () => {
    const world = await sessionWorld({ 'math.js': MATH });
    const bufferId = world.opened['math.js']!;
    const { platform, bodies } = fakePlatform(
      [
        readReply(bufferId),
        renameReply(bufferId),
        '{"method":"session.summary","params":{"text":"done"}}',
      ],
      (turn) => {
        // The user types, in the window between the read coming back and the
        // model deciding what to stage. One space is enough.
        if (turn === 1) world.workspace.applyEdits(bufferId, [{ from: 0, to: 0, insert: ' ' }]);
      },
    );

    const session = await runSession(platform, CONFIG, world);

    expect(world.review.staged.get()).toBeNull();
    expect(session.actions.get().some((action) => action.kind === 'proposal')).toBe(false);
    expect(session.status.get()).not.toBe('awaiting-review');
    // Named for the user, in the trail, rather than dropped.
    expect(errorsOf(session)).toMatch(/math\.js changed after you read it/);
    // And handed back to the model as its next input, so it can re-read
    // instead of staging the same stale offsets again.
    expect(sentOn(bodies, 2)).toMatch(/changed after you read it/);
  });

  /**
   * The other half, without which the guard above could be a blanket refusal
   * of every staged edit and nothing here would notice. Same script, same
   * buffer, nobody typing.
   */
  it('stages it when the buffer is still what the model read', async () => {
    const world = await sessionWorld({ 'math.js': MATH });
    const bufferId = world.opened['math.js']!;
    const { platform } = fakePlatform([
      readReply(bufferId),
      renameReply(bufferId),
      '{"method":"session.summary","params":{"text":"done"}}',
    ]);

    const session = await runSession(platform, CONFIG, world);

    expect(session.status.get()).toBe('awaiting-review');
    expect(world.review.staged.get()?.files[0]?.hunks).toHaveLength(1);
    expect(errorsOf(session)).toBe('');
  });
});

describe('a session that ended for a reason of its own', () => {
  /**
   * The failure this prevents: the turn cap reporting the same word as a
   * finished session. Measured in the running app — asked to rename
   * `multiply`, the model issued `context.bufferText` fifteen-plus times in a
   * row, staged nothing, and the panel said `Local model Done` with an empty
   * summary. Running out of turns and finishing are different outcomes.
   */
  it('says so when the turn cap is reached', async () => {
    const { platform } = fakePlatform(new Array(10).fill('{"method":"context.openBuffers"}'));

    const session = await runSession(platform, { ...CONFIG, maxTurns: 3 });

    expect(session.status.get()).toBe('done');
    // `summary=null` is the measured defect, so say so before matching on it.
    expect(session.summary.get()).not.toBeNull();
    expect(session.summary.get()).toMatch(/Stopped after 3 turns/);
    // The number is in the message because `maxTurns` is the thing the user
    // can change, and `agents.json` is not on screen.
    expect(session.summary.get()).toMatch(/maxTurns/);
  });

  /**
   * The failure this prevents: two unparseable turns reported as `Done` with
   * `summary=null` and a trail of `[instruction, note, note]` — the model's
   * own confused prose recorded as narration, so the session reads as though
   * the agent said something sensible and stopped.
   */
  it('fails the session when the model cannot produce the format twice', async () => {
    const { platform } = fakePlatform(['I think the answer is 42.', 'Still 42.']);

    const session = await runSession(platform, CONFIG);

    expect(session.status.get()).toBe('failed');
    expect(errorsOf(session)).toMatch(/Gave up after two turns/);
    expect(errorsOf(session)).toMatch(/no JSON object/);
  });

  /**
   * The failure this prevents, and the worst of the three: a session that
   * tried twice to stage an edit and was refused both times showed the user
   * `status=done summary=null trail=[instruction, read]`. No record that an
   * edit was ever attempted — the refusal went into the model's next user
   * message and nowhere else.
   *
   * The reply is recorded, not invented. Driving Ollama 0.32.13 /
   * qwen2.5-coder:7b with this branch's own system prompt and the walk's own
   * instruction and fixture, the model quoted `find` with **literal
   * backslash-n** where the buffer has newlines, which `resolveEdit` refuses
   * with "text not found in the buffer". That is the common case, not an edge
   * one.
   */
  it('fails the session when two staged edits in a row are refused', async () => {
    const world = await sessionWorld({
      'math.js':
        '// math helpers\n\nexport function add(a, b) {\n  return a + b;\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n',
    });
    const bufferId = world.opened['math.js']!;
    // Verbatim, including the fence and the spacing, apart from the buffer id.
    const recorded = (id: BufferId) =>
      '```json\n{"method":"proposal.stage","params":{"description":"Rename the function \'add\' to \'sum\'", "edits":[{"bufferId":"' +
      id +
      '","find":"export function add(a, b) {\\\\n  return a + b;\\\\n}","replace":"export function sum(a, b) {\\\\n  return a + b;\\\\n}"}]}}\n```';

    const { platform } = fakePlatform([
      `\`\`\`json\n{\n  "method": "context.bufferText",\n  "params": {\n    "bufferId": "${bufferId}"\n  }\n}\n\`\`\``,
      recorded(bufferId),
      recorded(bufferId),
    ]);

    const session = await runSession(platform, CONFIG, world);

    expect(session.status.get()).toBe('failed');
    expect(errorsOf(session)).toMatch(/text not found in the buffer/);
    // The quote itself, so the user can see the literal `\n` the model wrote.
    expect(errorsOf(session)).toMatch(/export function add/);
  });
});

describe('answering in prose', () => {
  /** Drive a prose stream to completion. */
  async function drainProse(provider: OllamaProvider, instruction: string) {
    const chunks: ModelChunk[] = [];
    const stream = provider.complete({ instruction, context: '', expects: 'prose' });
    for (let step = await stream.next(); !step.done; step = await stream.next(undefined)) {
      chunks.push(step.value);
    }
    return chunks;
  }

  /**
   * The failure this prevents — and the reason this feature exists. On main,
   * a prose reply is swallowed into the action loop: the turn is spent parsing
   * it, it fails as a non-action, the narration is kept but the real answer is
   * discarded, and a spurious session.summary gets generated instead. This path
   * bypasses all that, taking the prose as the answer on the first turn. See
   * `tests/ollama.test.ts:1202` for the test that covers the two-turn throw when
   * the model genuinely cannot produce the format.
   */
  it('takes a prose reply as the answer rather than as a failed turn', async () => {
    const { platform, bodies } = fakePlatform(['It adds two numbers and returns the sum.']);
    const provider = new OllamaProvider(platform, CONFIG);

    const chunks = await drainProse(provider, 'what does this do?');

    expect(chunks).toEqual([{ type: 'text', text: 'It adds two numbers and returns the sum.' }]);
    expect(bodies).toHaveLength(1);
  });

  /**
   * The failure this prevents: a prose answer being parsed for actions,
   * which would let an explanation that happens to contain a JSON example
   * turn into a request Nox acts on.
   */
  it('never yields an action, even when the prose contains one', async () => {
    const prose = 'You could call it like this:\n{"method":"context.openBuffers"}\nand that lists the buffers.';
    const { platform } = fakePlatform([prose]);
    const provider = new OllamaProvider(platform, CONFIG);

    const chunks = await drainProse(provider, 'how do I list buffers?');

    expect(chunks).toEqual([{ type: 'text', text: prose }]);
  });

  /**
   * The failure this prevents: a fenced code block being stripped out of an
   * explanation by machinery that exists to find JSON actions. An
   * explanation of code is the prose most likely to contain a fence.
   */
  it('leaves fenced code in the answer untouched', async () => {
    const answer = 'Like so:\n```js\nconst x = 1;\n```\nThat is all.';
    const { platform } = fakePlatform([answer]);
    const provider = new OllamaProvider(platform, CONFIG);

    const chunks = await drainProse(provider, 'show me');

    expect(chunks).toEqual([{ type: 'text', text: answer }]);
  });

  /**
   * The failure this prevents: an empty reply becoming an empty answer card
   * that looks like a rendering bug rather than a model that said nothing.
   */
  it('yields nothing at all when the model returns only whitespace', async () => {
    const { platform } = fakePlatform(['   \n  ']);
    const provider = new OllamaProvider(platform, CONFIG);

    expect(await drainProse(provider, 'say nothing')).toEqual([]);
  });

  /**
   * The regression test this whole feature exists for, at the level the defect
   * was measured — a real `OllamaProvider` driving a real `AgentRuntime`,
   * nothing below the platform substituted.
   *
   * On main this ends `failed`: the action loop spends the turn parsing the
   * prose for JSON, counts it as a non-action, and the second attempt throws,
   * so the answer is discarded as narration and the user is told the agent
   * broke. Every other prose test here stops at the provider or starts at a
   * `ScriptedProvider`; the two halves meet inside `ProviderTransport`, and a
   * seam neither side covers is exactly where this bug lived.
   */
  it('ends done with the answer, not failed, when the model replies in prose', async () => {
    const answer = 'It adds the two arguments and returns the total.';
    const { platform } = fakePlatform([answer]);

    const session = await runSession(platform, CONFIG, undefined, {
      instruction: 'what does this do?',
      expects: 'prose',
    });

    expect(session.status.get()).toBe('done');
    expect(session.answer.get()).toBe(answer);
    // Asserted rather than assumed: "done with an answer" would still be a
    // failure of this feature if the trail were full of refusals explaining
    // that the prose could not be parsed.
    expect(errorsOf(session)).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import type { Platform } from '../src/platform/types';
import { OllamaProvider, parseTurn, resolveEdit } from '../src/services/agent/ollama';
import type { OllamaAgentConfig } from '../src/services/agent/config';
import type { CoreResponse, RequestBody } from '../src/services/agent/protocol';
import type { ModelChunk } from '../src/services/agent/provider';

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

/** A platform whose stream replays one scripted reply per request. */
function fakePlatform(replies: string[]) {
  const bodies: unknown[] = [];
  let turn = 0;
  const platform = {
    capabilities: { localModels: true },
    async streamJsonLines(spec: { body: unknown }, onLine: (line: string) => void, onEnd: (e: string | null) => void) {
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
   */
  it('gives up after two unparseable turns in a row', async () => {
    const { platform, bodies } = fakePlatform(['nonsense one', 'nonsense two', 'nonsense three']);
    await drain(new OllamaProvider(platform, CONFIG));

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
   * The failure this prevents: an unreachable server hanging the session.
   * `#ask` gets an end event carrying an error and no content, and a loop that
   * treated that as an empty turn would retry against a server that is not
   * there until it hit the turn cap.
   */
  it('ends the session when the stream reports a failure', async () => {
    const platform = {
      capabilities: { localModels: true },
      async streamJsonLines(_spec: unknown, _onLine: unknown, onEnd: (e: string | null) => void) {
        onEnd('error sending request for url (http://127.0.0.1:11434/api/chat)');
        return { async close() {} };
      },
    } as unknown as Platform;

    const chunks = await drain(new OllamaProvider(platform, CONFIG));

    expect(chunks).toEqual([]);
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

    await driveWith(new OllamaProvider(platform, CONFIG), answerReads);

    expect(bodies.length).toBeLessThanOrEqual(2);
  });
});

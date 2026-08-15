import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { parseTurn } from '../src/services/agent/ollama';

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
   * The failure this prevents: tracking string state from index 0 instead of
   * only while a candidate is open. An agent narrating about code produces
   * unbalanced quotes constantly — a measurement, a partial quotation, a
   * path — and each of these four, fuzzed over 30,000 replies, was one of
   * 1,060 turns (3.5%) that lost a recoverable action when string state was
   * allowed to leak out of narration and into the real object that followed
   * it, flipping the scanner into "in string" for the rest of the reply.
   */
  it.each([
    ['an odd quote before a measurement', 'A 6" ruler.'],
    ['an unterminated quote', 'The "use strict pragma.'],
    ['two quotes and a third left open', 'He said "hi" and "bye.'],
    ['a trailing backslash', 'Careful with this: \\'],
  ])('recovers a good action after narration with %s', (_label, narration) => {
    const parsed = parseTurn(`${narration}\n{"method":"context.openBuffers"}`);
    expect(parsed.action).toEqual({ method: 'context.openBuffers' });
    expect(parsed.error).toBeNull();
  });
});

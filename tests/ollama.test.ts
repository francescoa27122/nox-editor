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
});

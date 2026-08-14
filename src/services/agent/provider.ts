import type { CoreResponse, RequestBody } from './protocol';

/**
 * The model behind an agent.
 *
 * Nothing in Nox names a vendor. This interface is the whole of what the
 * runtime knows about where an agent's decisions come from, so a local model
 * and a hosted one are the same shape to everything above it — and swapping
 * either is a constructor argument, not a refactor.
 */

export interface ModelRequest {
  instruction: string;
  /** Whatever the session chose to show the model, already rendered. */
  context: string;
  /** Aborts mid-stream. Wired to the session's job. */
  signal?: AbortSignal;
}

/**
 * One piece of a response.
 *
 * `text` is narration for the user; `action` is something the agent wants Nox
 * to do, in the protocol's own vocabulary. Keeping them in one stream means a
 * provider can interleave "I am looking at the scheduler" with the reads that
 * justify it.
 */
export type ModelChunk =
  | { type: 'text'; text: string }
  | { type: 'action'; request: RequestBody };

/**
 * What a provider yields, and what it gets back.
 *
 * An **async generator**, not a plain iterable: each `yield` returns the
 * `CoreResponse` Nox produced for that chunk. Without that the provider emits
 * every action blind — it could ask to read a file but never see the contents,
 * which makes the whole context API pointless to it. `text` chunks resolve to
 * the acknowledgement and carry nothing useful.
 */
export type ModelStream = AsyncGenerator<ModelChunk, void, CoreResponse | undefined>;

export interface ModelProvider {
  readonly id: string;
  readonly label: string;
  /**
   * Streaming-first, with no request/response variant.
   *
   * Every provider worth using streams, and offering both would create a
   * second code path exercised only by the slow ones.
   */
  complete(request: ModelRequest): ModelStream;
}

/**
 * A provider that replays a fixed script.
 *
 * Not a mock: it is the reference implementation of the interface, it is what
 * the tests drive the whole runtime with, and it is how someone adding a real
 * provider can see the shape they have to satisfy without a network call.
 */
export type Script = (request: ModelRequest) => ModelStream | Iterable<ModelChunk>;

export class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted';
  readonly label: string;

  #script: Script;

  constructor(script: Script, label = 'Scripted agent') {
    this.#script = script;
    this.label = label;
  }

  async *complete(request: ModelRequest): ModelStream {
    const source = this.#script(request);
    // A plain array is the common case for a fixed script and cannot make use
    // of the responses; a generator gets them fed back one at a time.
    if (Symbol.asyncIterator in source) {
      const stream = source as ModelStream;
      let response: CoreResponse | undefined;
      while (true) {
        const step = await stream.next(response);
        if (step.done || request.signal?.aborted) return;
        response = yield step.value;
      }
    }

    for (const chunk of source as Iterable<ModelChunk>) {
      if (request.signal?.aborted) return;
      yield chunk;
    }
  }
}

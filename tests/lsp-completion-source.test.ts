// @vitest-environment jsdom
import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createLspCompletionSource, type CompletionDeps } from '../src/editor/completion';
import type { LspCompletionItem } from '../src/core/lsp-completion';

/**
 * Asking the server for completions.
 *
 * No service and no process: the source takes the two methods it needs, so
 * every case below — a rejecting server, no server at all, a result that
 * outlives its keystroke — is written directly rather than staged.
 */

const DOC = 'console.\n';
const DOT = 8; // Just after the '.'.

interface Asked {
  method: string;
  params: unknown;
}

function deps(
  options: {
    capabilities?: Record<string, unknown> | null;
    respond?: (method: string, params: unknown) => Promise<unknown>;
  } = {},
): { deps: CompletionDeps; asked: Asked[] } {
  const asked: Asked[] = [];
  const capabilities =
    options.capabilities === undefined
      ? { completionProvider: { triggerCharacters: ['.'], resolveProvider: false } }
      : options.capabilities;

  return {
    asked,
    deps: {
      lsp: {
        capabilitiesFor: () => capabilities,
        requestFor: async <T,>(_language: string, method: string, params: unknown): Promise<T> => {
          asked.push({ method, params });
          if (!options.respond) return { items: [] } as T;
          return (await options.respond(method, params)) as T;
        },
      },
      documentOf: () => ({ uri: 'file:///w/main.ts', languageId: 'typescript' }),
    },
  };
}

function contextAt(doc: string, pos: number, explicit = false): CompletionContext {
  return new CompletionContext(EditorState.create({ doc }), pos, explicit);
}

const LOG: LspCompletionItem = { label: 'log', kind: 2, detail: '(method) log' };

describe('when it asks', () => {
  it('asks after one of the server own trigger characters', async () => {
    const { deps: d, asked } = deps({ respond: async () => ({ items: [LOG] }) });

    const result = await createLspCompletionSource(d)(contextAt(DOC, DOT));

    expect(asked.map((a) => a.method)).toEqual(['textDocument/completion']);
    expect(result?.options.map((o) => o.label)).toEqual(['log']);
  });

  it('asks on an explicit request even with nothing before the cursor', async () => {
    const { deps: d, asked } = deps({ respond: async () => ({ items: [LOG] }) });

    await createLspCompletionSource(d)(contextAt('\n', 0, true));

    expect(asked).toHaveLength(1);
  });

  it('asks while a word is being typed', async () => {
    const { deps: d, asked } = deps({ respond: async () => ({ items: [LOG] }) });

    await createLspCompletionSource(d)(contextAt('console.lo\n', 10));

    expect(asked).toHaveLength(1);
  });

  it('stays silent on an idle keystroke', async () => {
    // Neither a word character nor a trigger character before the cursor.
    // Without this every space bar press is a round trip.
    const { deps: d, asked } = deps();

    const result = await createLspCompletionSource(d)(contextAt('const a = 1; \n', 13));

    expect(result).toBeNull();
    expect(asked).toEqual([]);
  });

  it('uses the server trigger characters rather than assuming a dot', async () => {
    const { deps: d, asked } = deps({
      capabilities: { completionProvider: { triggerCharacters: ['@'] } },
    });

    await createLspCompletionSource(d)(contextAt('x@\n', 2));
    expect(asked).toHaveLength(1);

    asked.length = 0;
    await createLspCompletionSource(d)(contextAt('x.\n', 2));
    expect(asked).toEqual([]);
  });
});

describe('when there is nothing to ask', () => {
  it('returns null when no server serves the language, without asking', async () => {
    const { deps: d, asked } = deps({ capabilities: null });

    expect(await createLspCompletionSource(d)(contextAt(DOC, DOT))).toBeNull();
    expect(asked).toEqual([]);
  });

  it('returns null when the server has no completion provider', async () => {
    const { deps: d, asked } = deps({ capabilities: { hoverProvider: true } });

    expect(await createLspCompletionSource(d)(contextAt(DOC, DOT))).toBeNull();
    expect(asked).toEqual([]);
  });

  it('returns null when there is no document', async () => {
    const { deps: d } = deps();
    const source = createLspCompletionSource({ ...d, documentOf: () => null });

    expect(await source(contextAt(DOC, DOT))).toBeNull();
  });

  it('returns null when the request rejects', async () => {
    // A server error must not become an exception inside the picker.
    const { deps: d } = deps({
      respond: async () => {
        throw new Error('server said no');
      },
    });

    expect(await createLspCompletionSource(d)(contextAt(DOC, DOT))).toBeNull();
  });
});

describe('results that arrived too late', () => {
  it('drops a result whose keystroke has been abandoned', async () => {
    // CodeMirror cancels stale queries as the user keeps typing. A result
    // that outlives its keystroke describes text that is no longer there.
    const { deps: d } = deps({ respond: async () => ({ items: [LOG] }) });
    const context = contextAt(DOC, DOT);
    Object.defineProperty(context, 'aborted', { get: () => true });

    expect(await createLspCompletionSource(d)(context)).toBeNull();
  });
});

describe('the shape of the answer', () => {
  it('accepts a bare array of items', async () => {
    const { deps: d } = deps({ respond: async () => [LOG] });

    const result = await createLspCompletionSource(d)(contextAt(DOC, DOT));

    expect(result?.options.map((o) => o.label)).toEqual(['log']);
  });

  it('accepts a completion list', async () => {
    const { deps: d } = deps({ respond: async () => ({ isIncomplete: false, items: [LOG] }) });

    const result = await createLspCompletionSource(d)(contextAt(DOC, DOT));

    expect(result?.options.map((o) => o.label)).toEqual(['log']);
  });

  it('caches a complete list against further typing', async () => {
    const { deps: d } = deps({ respond: async () => ({ isIncomplete: false, items: [LOG] }) });

    const result = await createLspCompletionSource(d)(contextAt(DOC, DOT));

    expect(result?.validFor).toBeDefined();
  });

  it('refuses to cache an incomplete list', async () => {
    // `isIncomplete` is the server saying "ask again on the next character".
    // Caching it shows suggestions for a prefix the user has already left.
    const { deps: d } = deps({ respond: async () => ({ isIncomplete: true, items: [LOG] }) });

    const result = await createLspCompletionSource(d)(contextAt(DOC, DOT));

    expect(result?.validFor).toBeUndefined();
  });

  it('replaces from the start of the word being typed', async () => {
    const { deps: d } = deps({ respond: async () => ({ items: [LOG] }) });

    const result = await createLspCompletionSource(d)(contextAt('console.lo\n', 10));

    expect(result?.from).toBe(8);
  });

  it('sends the position the cursor is actually at', async () => {
    const { deps: d, asked } = deps({ respond: async () => ({ items: [LOG] }) });

    await createLspCompletionSource(d)(contextAt('a\nconsole.\n', 10));

    expect((asked[0]?.params as { position: unknown }).position).toEqual({
      line: 1,
      character: 8,
    });
  });
});

describe('lazy documentation', () => {
  it('fetches documentation for one item, only when it is shown', async () => {
    const { deps: d, asked } = deps({
      capabilities: { completionProvider: { triggerCharacters: ['.'], resolveProvider: true } },
      respond: async (method) =>
        method === 'completionItem/resolve'
          ? { ...LOG, documentation: 'Logs a message' }
          : { items: [LOG] },
    });

    const result = await createLspCompletionSource(d)(contextAt(DOC, DOT));
    const option = result!.options[0]!;

    expect(typeof option.info).toBe('function');
    expect(asked.map((a) => a.method)).toEqual(['textDocument/completion']);

    const info = await (option.info as (c: unknown) => Promise<Node | null>)(option);

    expect(asked.map((a) => a.method)).toEqual([
      'textDocument/completion',
      'completionItem/resolve',
    ]);
    expect((info as HTMLElement).textContent).toBe('Logs a message');
  });

  it('shows the item without documentation when resolving fails', async () => {
    const { deps: d } = deps({
      capabilities: { completionProvider: { triggerCharacters: ['.'], resolveProvider: true } },
      respond: async (method) => {
        if (method === 'completionItem/resolve') throw new Error('no');
        return { items: [LOG] };
      },
    });

    const result = await createLspCompletionSource(d)(contextAt(DOC, DOT));
    const option = result!.options[0]!;

    await expect(
      (option.info as (c: unknown) => Promise<Node | null>)(option),
    ).resolves.toBeNull();
  });

  it('does not offer a resolver when the server cannot resolve', async () => {
    const { deps: d } = deps({ respond: async () => ({ items: [LOG] }) });

    const result = await createLspCompletionSource(d)(contextAt(DOC, DOT));

    expect(result!.options[0]!.info).toBeUndefined();
  });
});

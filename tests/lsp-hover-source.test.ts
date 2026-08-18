// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { createLspHoverSource, renderHover } from '../src/editor/hover';
import type { CompletionDeps } from '../src/editor/completion';

/**
 * Asking the server what a symbol is, and putting the answer on screen.
 *
 * The rendering tests are the important half. The design refuses to parse a
 * language server's markdown into HTML — a server is a third-party process
 * running on the user's machine, and hover text is derived from source code
 * that arrives from repositories people clone. `never renders markup as
 * elements` is the guard on that, and it should fail loudly if anyone later
 * reaches for `innerHTML`.
 */

const DOC = 'const answer: number = 42;\n';

interface Asked {
  method: string;
  params: unknown;
}

function deps(
  options: {
    capabilities?: Record<string, unknown> | null;
    respond?: () => Promise<unknown>;
    document?: { uri: string; languageId: string } | null;
  } = {},
): { deps: CompletionDeps; asked: Asked[] } {
  const asked: Asked[] = [];
  const capabilities =
    options.capabilities === undefined ? { hoverProvider: true } : options.capabilities;

  return {
    asked,
    deps: {
      lsp: {
        capabilitiesFor: () => capabilities,
        requestFor: async <T,>(_language: string, method: string, params: unknown): Promise<T> => {
          asked.push({ method, params });
          if (!options.respond) return null as T;
          return (await options.respond()) as T;
        },
      },
      documentOf: () =>
        options.document === undefined
          ? { uri: 'file:///w/main.ts', languageId: 'typescript' }
          : options.document,
    },
  };
}

/** The source reads only `state`, so a real view is not needed. */
function viewWith(doc: string): EditorView {
  return { state: EditorState.create({ doc }) } as unknown as EditorView;
}

describe('when there is nothing to ask', () => {
  it('shows nothing when no server serves the language, without asking', async () => {
    const { deps: d, asked } = deps({ capabilities: null });

    expect(await createLspHoverSource(d)(viewWith(DOC), 6)).toBeNull();
    expect(asked).toEqual([]);
  });

  it('shows nothing when the server cannot hover, without asking', async () => {
    const { deps: d, asked } = deps({ capabilities: { completionProvider: {} } });

    expect(await createLspHoverSource(d)(viewWith(DOC), 6)).toBeNull();
    expect(asked).toEqual([]);
  });

  it('shows nothing for a buffer with no path', async () => {
    const { deps: d, asked } = deps({ document: null });

    expect(await createLspHoverSource(d)(viewWith(DOC), 6)).toBeNull();
    expect(asked).toEqual([]);
  });

  it('shows nothing when the request rejects', async () => {
    const { deps: d } = deps({
      respond: async () => {
        throw new Error('server said no');
      },
    });

    expect(await createLspHoverSource(d)(viewWith(DOC), 6)).toBeNull();
  });

  it('shows nothing rather than an empty box when the server has nothing to say', async () => {
    // An empty tooltip following the pointer around is worse than none.
    const { deps: d } = deps({ respond: async () => ({ contents: { kind: 'markdown', value: '' } }) });

    expect(await createLspHoverSource(d)(viewWith(DOC), 6)).toBeNull();
  });

  it('shows nothing when the response itself is null', async () => {
    const { deps: d } = deps({ respond: async () => null });

    expect(await createLspHoverSource(d)(viewWith(DOC), 6)).toBeNull();
  });
});

describe('what it asks and where it points', () => {
  it('asks about the hovered position', async () => {
    const { deps: d, asked } = deps({
      respond: async () => ({ contents: { kind: 'markdown', value: 'A number.' } }),
    });

    await createLspHoverSource(d)(viewWith('a\nconst answer = 42;\n'), 8);

    expect(asked[0]?.method).toBe('textDocument/hover');
    expect((asked[0]?.params as { position: unknown }).position).toEqual({ line: 1, character: 6 });
  });

  it('covers the range the server named, not the character under the pointer', async () => {
    const { deps: d } = deps({
      respond: async () => ({
        contents: { kind: 'markdown', value: 'A number.' },
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 12 },
        },
      }),
    });

    const tooltip = await createLspHoverSource(d)(viewWith(DOC), 8);

    expect(tooltip).toMatchObject({ pos: 6, end: 12 });
  });

  it('anchors at the hovered position when the server names no range', async () => {
    const { deps: d } = deps({
      respond: async () => ({ contents: { kind: 'markdown', value: 'A number.' } }),
    });

    const tooltip = await createLspHoverSource(d)(viewWith(DOC), 8);

    expect(tooltip?.pos).toBe(8);
    expect(tooltip?.end).toBeUndefined();
  });
});

describe('rendering', () => {
  it('puts code in a pre and prose in a p, in order', () => {
    const dom = renderHover([
      { kind: 'code', text: 'const answer: number' },
      { kind: 'prose', text: 'Holds the answer.' },
    ]);

    expect(dom.querySelector('pre')?.textContent).toBe('const answer: number');
    expect(dom.querySelector('p')?.textContent).toBe('Holds the answer.');
    expect([...dom.children].map((c) => c.tagName)).toEqual(['PRE', 'P']);
  });

  it('never renders markup as elements', () => {
    // The guard on the design's §4. A language server is a third-party
    // process and its text is derived from cloned source; it reaches the DOM
    // through textContent and nothing else.
    const hostile = '<img src=x onerror="alert(1)"> **bold** `code`';
    const dom = renderHover([{ kind: 'prose', text: hostile }]);

    expect(dom.querySelector('img')).toBeNull();
    expect(dom.querySelectorAll('*')).toHaveLength(1); // The <p> only.
    // The markup survives as the characters it is, which is the cost paid.
    expect(dom.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(dom.textContent).toContain('**bold**');
  });

  it('does not render markup inside a code block either', () => {
    const dom = renderHover([{ kind: 'code', text: '<script>alert(1)</script>' }]);

    expect(dom.querySelector('script')).toBeNull();
    expect(dom.querySelector('pre')?.textContent).toBe('<script>alert(1)</script>');
  });
});

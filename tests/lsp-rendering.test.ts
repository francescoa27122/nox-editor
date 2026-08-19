// @vitest-environment jsdom
import { completionStatus } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EditorPane from '../src/ui/EditorPane.svelte';
import { pathToUri } from '../src/core/uri';
import { SERVERS_FILE } from '../src/services/lsp/registry';
import { flush, mountComponent, type Mounted } from './support/component';
import { FakeLanguageServer } from './support/fake-lsp-process';
import { installRangeRects } from './support/jsdom-layout';

/**
 * What the language server says, on the screen.
 *
 * The wire tests for diagnostics, completion and hover prove what each
 * source returns; `tests/lsp-integration.test.ts` proves a real tsserver
 * says what the fixtures say. Neither proves CodeMirror puts any of it in
 * the DOM, or that the pane's `lspCompartment` delivers the sources into a
 * live view at all — and the work log said so three times. This suite
 * closes that: a real `NoxApp` over a `MemoryPlatform`, its real
 * `LspService` running against an in-memory server, the real `EditorPane`,
 * and assertions on what CodeMirror rendered.
 *
 * What it does not reach — placement, and which symbol was under the
 * pointer — is geometry, and `tests/support/jsdom-layout.ts` says why.
 *
 * Mutation-checked on 2026-08-19, each by breaking `EditorPane.svelte` and
 * watching the test go red before restoring it:
 * - hover: dropping `lspHoverExtension(lspDeps)` from `lspExtensions`;
 * - completion: dropping `lspCompletionExtension(lspDeps)`;
 * - diagnostics: replacing the `applyDiagnostics(view, …)` call with a
 *   no-op.
 */

installRangeRects();

const FILE = '/w/main.ts';
const URI = pathToUri(FILE);
const DOC = 'const answer: number = 42;\nanswer';

/** CodeMirror's hover delay, as `src/editor/hover.ts` names it; waits below allow a few multiples. */
const HOVER_TIME_MS = 300;

let mounted: Mounted | null = null;

afterEach(async () => {
  await mounted?.app.lsp.stop();
  mounted?.unmount();
  mounted = null;
});

/**
 * A pane over `main.ts`, with a server that advertises `capabilities`
 * running behind it. Returns the server so a test can script it, and the
 * live view so a test can drive it.
 */
async function paneWithServer(capabilities: Record<string, unknown>) {
  mounted = mountComponent(EditorPane, { props: { groupId: 'group-1' } });
  const { app, platform, container } = mounted;

  const server = new FakeLanguageServer({ capabilities });
  platform.languageServers = () => server;
  await platform.writeConfigFile(
    SERVERS_FILE,
    JSON.stringify({ servers: [{ languages: ['typescript'], command: 'fake' }] }),
  );
  await app.serverRegistry.load();

  platform.seedFile(FILE, DOC);
  await app.workspace.openFolder('/w');
  await app.lsp.start();
  expect(app.lsp.capabilitiesFor('typescript')).toEqual(capabilities);

  const id = (await app.workspace.open(FILE))!;
  app.workspace.setActive(id);
  flush();

  const view = EditorView.findFromDOM(container)!;
  expect(view).not.toBeNull();
  return { app, server, view, container };
}

function requestsFor(server: FakeLanguageServer, method: string) {
  return server.written.filter((m) => m.method === method);
}

describe('a diagnostic the server publishes', () => {
  it('is drawn under exactly the text its range names, with a gutter mark', async () => {
    const { server, view } = await paneWithServer({});

    // `answer` on the first line: characters 6-12.
    server.publish(URI, [
      {
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
        severity: 1,
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ]);
    flush();

    const squiggles = view.dom.querySelectorAll('.cm-lintRange-error');
    expect(squiggles).toHaveLength(1);
    expect(squiggles[0]!.textContent).toBe('answer');
    expect(view.dom.querySelectorAll('.cm-gutter-lint .cm-lint-marker-error')).toHaveLength(1);
  });

  it('is taken down when the server publishes an empty batch', async () => {
    const { server, view } = await paneWithServer({});
    const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } };

    server.publish(URI, [{ range, severity: 1, message: 'no' }]);
    flush();
    expect(view.dom.querySelectorAll('.cm-lintRange-error')).toHaveLength(1);

    server.publish(URI, []);
    flush();
    expect(view.dom.querySelectorAll('.cm-lintRange-error')).toHaveLength(0);
  });
});

describe('completion', () => {
  const PROVIDER = { completionProvider: { triggerCharacters: ['.'], resolveProvider: true } };

  it("opens the picker with the server's items when a trigger character is typed", async () => {
    const { server, view } = await paneWithServer(PROVIDER);
    server.handle('textDocument/completion', () => ({
      isIncomplete: false,
      items: [
        { label: 'length', kind: 10 },
        { label: 'toUpperCase', kind: 2 },
      ],
    }));

    // Type `.` after the trailing `answer`, the way a keystroke does.
    const end = view.state.doc.length;
    view.dispatch({ selection: { anchor: end } });
    view.dispatch({
      changes: { from: end, insert: '.' },
      selection: { anchor: end + 1 },
      userEvent: 'input.type',
    });

    await vi.waitFor(() => expect(completionStatus(view.state)).toBe('active'));
    await vi.waitFor(() =>
      expect(
        Array.from(view.dom.querySelectorAll('.cm-tooltip-autocomplete .cm-completionLabel')).map(
          (label) => label.textContent,
        ),
      ).toEqual(['length', 'toUpperCase']),
    );

    // Asked about this document, at the position after the dot.
    const asked = requestsFor(server, 'textDocument/completion');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.params).toEqual({
      textDocument: { uri: URI },
      position: { line: 1, character: 7 },
    });
  });

  it('fetches and shows documentation for the highlighted item', async () => {
    const { server, view } = await paneWithServer(PROVIDER);
    server.handle('textDocument/completion', () => ({
      isIncomplete: false,
      items: [{ label: 'length', kind: 10 }],
    }));
    server.handle('completionItem/resolve', (item) => ({
      ...(item as object),
      documentation: 'Returns the length of a String object.',
    }));

    const end = view.state.doc.length;
    view.dispatch({ selection: { anchor: end } });
    view.dispatch({
      changes: { from: end, insert: '.' },
      selection: { anchor: end + 1 },
      userEvent: 'input.type',
    });

    await vi.waitFor(() =>
      expect(view.dom.querySelector('.cm-completionInfo .cm-completionInfo-lsp')?.textContent).toBe(
        'Returns the length of a String object.',
      ),
    );
    expect(requestsFor(server, 'completionItem/resolve')).toHaveLength(1);
  });
});

describe('hover', () => {
  const HOVER = { hoverProvider: true };
  const MARKDOWN =
    '```typescript\nconst answer: number\n```\nThe **answer**. <script>alert(1)</script>';

  function rest(view: EditorView): void {
    const line = view.contentDOM.querySelector('.cm-line')!;
    line.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 0, bubbles: true }));
  }

  it('asks the server about this document and shows the answer as text', async () => {
    const { server, view } = await paneWithServer(HOVER);
    server.handle('textDocument/hover', () => ({
      contents: { kind: 'markdown', value: MARKDOWN },
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
    }));

    rest(view);

    await vi.waitFor(
      () => expect(view.dom.querySelector('.cm-tooltip-hover .cm-tooltip-lsp-hover')).not.toBeNull(),
      { timeout: HOVER_TIME_MS * 4 },
    );

    const tooltip = view.dom.querySelector('.cm-tooltip-hover .cm-tooltip-lsp-hover')!;
    expect(tooltip.querySelector('pre')?.textContent).toBe('const answer: number');
    expect(tooltip.querySelector('p')?.textContent).toBe(
      'The **answer**. <script>alert(1)</script>',
    );
    // Text, never markup: the design's whole point, checked on the real DOM.
    expect(tooltip.querySelector('script')).toBeNull();
    expect(tooltip.querySelector('strong')).toBeNull();

    const asked = requestsFor(server, 'textDocument/hover');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.params).toMatchObject({ textDocument: { uri: URI } });
  });

  it('shows nothing when the server has nothing to say', async () => {
    const { server, view } = await paneWithServer(HOVER);
    server.handle('textDocument/hover', () => null);

    rest(view);
    await vi.waitFor(() => expect(requestsFor(server, 'textDocument/hover')).toHaveLength(1), {
      timeout: HOVER_TIME_MS * 4,
    });
    // Give the (absent) tooltip every chance to appear.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(view.dom.querySelector('.cm-tooltip-hover')).toBeNull();
  });

  it('goes away when the pointer leaves the editor', async () => {
    const { server, view } = await paneWithServer(HOVER);
    server.handle('textDocument/hover', () => ({ contents: 'a string, the oldest shape' }));

    rest(view);
    await vi.waitFor(() => expect(view.dom.querySelector('.cm-tooltip-hover')).not.toBeNull(), {
      timeout: HOVER_TIME_MS * 4,
    });

    view.dom.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: document.body }));
    await vi.waitFor(() => expect(view.dom.querySelector('.cm-tooltip-hover')).toBeNull());
  });
});

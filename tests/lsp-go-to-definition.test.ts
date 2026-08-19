// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import EditorPane from '../src/ui/EditorPane.svelte';
import { pathToUri } from '../src/core/uri';
import { SERVERS_FILE } from '../src/services/lsp/registry';
import { flush, mountComponent, type Mounted } from './support/component';
import { FakeLanguageServer } from './support/fake-lsp-process';

/**
 * Go to Definition, through the real pane and the real service.
 *
 * The same harness `tests/lsp-rendering.test.ts` uses: a real `NoxApp` over a
 * `MemoryPlatform`, an in-memory language server, the real `EditorPane`. The
 * cursor is real, the request is real, and the landing is read off the view.
 *
 * Mutation-checked on 2026-08-19 against `src/app.ts`: the cross-file test
 * fails when `revealLocation` stops calling `workspace.open`; the same-file
 * test fails when `workspace.setSelection` is removed; the "no definition"
 * test fails when the notification is removed; the failed-request test fails
 * when the catch's notification is removed.
 */

const MAIN = '/w/main.ts';
const LIB = '/w/lib.ts';
const MAIN_DOC = 'import { total } from "./lib";\nconsole.log(total);\n';
const LIB_DOC = 'export const total = 42;\n';

let mounted: Mounted | null = null;

afterEach(async () => {
  try {
    await mounted?.app.lsp.stop();
  } finally {
    mounted?.unmount();
    mounted = null;
  }
});

async function paneWithServer(capabilities: Record<string, unknown> = { definitionProvider: true }) {
  mounted = mountComponent(EditorPane, { props: { groupId: 'group-1' } });
  const { app, platform, container } = mounted;

  const server = new FakeLanguageServer({ capabilities });
  platform.languageServerFactory = () => server;
  await platform.writeConfigFile(
    SERVERS_FILE,
    JSON.stringify({ servers: [{ languages: ['typescript'], command: 'fake' }] }),
  );
  await app.serverRegistry.load();

  platform.seedFile(MAIN, MAIN_DOC);
  platform.seedFile(LIB, LIB_DOC);
  await app.workspace.openFolder('/w');
  await app.lsp.start();

  const id = (await app.workspace.open(MAIN))!;
  app.workspace.setActive(id);
  flush();

  const view = EditorView.findFromDOM(container)!;
  // On `total` in `console.log(total)`: line 1, character 12.
  const cursor = MAIN_DOC.indexOf('total', MAIN_DOC.indexOf('\n'));
  view.dispatch({ selection: { anchor: cursor } });
  return { app, server, view, id };
}

function messages(app: Mounted['app']): string[] {
  return app.notifications.items.get().map((n) => n.message);
}

describe('the command', () => {
  it('is disabled when no server for the language offers definitions', async () => {
    const { app } = await paneWithServer({});
    expect(app.commands.isEnabled('lsp.goToDefinition')).toBe(false);
  });

  it('is enabled when the server offers definitions', async () => {
    const { app } = await paneWithServer();
    expect(app.commands.isEnabled('lsp.goToDefinition')).toBe(true);
  });

  it('asks about the symbol under the cursor', async () => {
    const { app, server } = await paneWithServer();
    server.handle('textDocument/definition', () => null);

    await app.commands.execute('lsp.goToDefinition');

    const asked = server.written.filter((m) => m.method === 'textDocument/definition');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.params).toEqual({
      textDocument: { uri: pathToUri(MAIN) },
      position: { line: 1, character: 12 },
    });
  });
});

describe('the jump', () => {
  it('opens the other file and selects the definition', async () => {
    const { app, server, view } = await paneWithServer();
    server.handle('textDocument/definition', () => [
      {
        uri: pathToUri(LIB),
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } },
      },
    ]);

    await app.commands.execute('lsp.goToDefinition');
    flush();

    expect(app.workspace.activeSnapshot()?.path).toBe(LIB);
    const { from, to } = view.state.selection.main;
    expect(view.state.doc.sliceString(from, to)).toBe('total');
    expect(from).toBe(LIB_DOC.indexOf('total'));
  });

  it('moves within the same file', async () => {
    const { app, server, view, id } = await paneWithServer();
    // Pretend the import binding is the definition.
    server.handle('textDocument/definition', () => ({
      uri: pathToUri(MAIN),
      range: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } },
    }));

    await app.commands.execute('lsp.goToDefinition');
    flush();

    expect(app.workspace.activeId.get()).toBe(id);
    const { from, to } = view.state.selection.main;
    expect(from).toBe(9);
    expect(view.state.doc.sliceString(from, to)).toBe('total');
  });

  it('says so and stays put when there is nothing to go to', async () => {
    const { app, server, view } = await paneWithServer();
    server.handle('textDocument/definition', () => null);
    const before = view.state.selection.main.head;

    await app.commands.execute('lsp.goToDefinition');

    expect(messages(app)).toContain('No definition found');
    expect(view.state.selection.main.head).toBe(before);
    expect(app.workspace.activeSnapshot()?.path).toBe(MAIN);
  });

  it('takes the first of many and says how many there were', async () => {
    const { app, server } = await paneWithServer();
    server.handle('textDocument/definition', () => [
      { uri: pathToUri(LIB), range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } } },
      { uri: pathToUri(MAIN), range: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } } },
    ]);

    await app.commands.execute('lsp.goToDefinition');
    flush();

    expect(app.workspace.activeSnapshot()?.path).toBe(LIB);
    expect(messages(app)).toContain('2 definitions — went to the first');
  });

  it('reports a definition it cannot open rather than throwing', async () => {
    const { app, server } = await paneWithServer();
    server.handle('textDocument/definition', () => ({
      uri: 'untitled:scratch',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    }));

    await app.commands.execute('lsp.goToDefinition');

    expect(messages(app)).toContain('Definition is not in a file Nox can open');
    expect(app.workspace.activeSnapshot()?.path).toBe(MAIN);
  });

  it('reports a server error rather than throwing', async () => {
    const { app, server } = await paneWithServer();
    server.handle('textDocument/definition', () => {
      throw new Error('boom');
    });

    // The command owns the failure: a rejection here would reach the keymap.
    await expect(app.commands.execute('lsp.goToDefinition')).resolves.toBe(true);

    expect(messages(app)).toContain('Go to definition failed');
    expect(app.workspace.activeSnapshot()?.path).toBe(MAIN);
  });

  it('says nothing about a count it could not honour', async () => {
    const { app, server } = await paneWithServer();
    server.handle('textDocument/definition', () => [
      { uri: 'untitled:scratch', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      { uri: pathToUri(LIB), range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } } },
    ]);

    await app.commands.execute('lsp.goToDefinition');
    flush();

    expect(messages(app)).toContain('Definition is not in a file Nox can open');
    expect(messages(app).some((m) => /definitions — went to the first/.test(m))).toBe(false);
    expect(app.workspace.activeSnapshot()?.path).toBe(MAIN);
  });
});

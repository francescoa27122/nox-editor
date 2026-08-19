// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import EditorPane from '../src/ui/EditorPane.svelte';
import { NoxApp } from '../src/app';
import { pathToUri } from '../src/core/uri';
import { SERVERS_FILE } from '../src/services/lsp/registry';
import { flush, mountComponent, type Mounted } from './support/component';
import { FakeLanguageServer } from './support/fake-lsp-process';
import { installRangeRects } from './support/jsdom-layout';

// `workspace.apply` dispatches with scrollIntoView, and CodeMirror measures
// for it; jsdom has no geometry. See `tests/support/jsdom-layout.ts`.
installRangeRects();

/**
 * Format Document, and format on save, through the real pane, the real
 * service, the real save path and an in-memory disk.
 *
 * The harness of `tests/lsp-find-references.test.ts`. The fake server now
 * awaits a handler that returns a promise, which is how "never answers" and
 * "answers late" are staged below.
 *
 * Mutation-checked on 2026-08-19 against `src/app.ts`: the options test
 * fails when `tabSize`/`insertSpaces` are not read from the config; the
 * undo test fails when the edit is applied through `view.dispatch` instead
 * of `workspace.apply`; the on-save test fails when `#formatBeforeSave` is
 * not awaited before `workspace.save`; the off test fails when the setting
 * is not checked; the autosave test fails when `afterDelay` is not checked;
 * the timeout test fails when the race is removed (the save then waits on
 * the server's own timeout) and it is what caught the first version, which
 * raced the whole call and checked a flag *after* the edit had landed; the
 * stale test fails when `baseRevisions` is dropped from the apply.
 */

const MAIN = '/w/main.ts';
const UGLY = 'const  x=1\nlet   y = 2\n';
const PRETTY = 'const x = 1;\nlet y = 2;\n';

let mounted: Mounted | null = null;

afterEach(async () => {
  try {
    await mounted?.app.lsp.stop();
  } finally {
    mounted?.unmount();
    mounted = null;
  }
});

async function setup(capabilities: Record<string, unknown> = { documentFormattingProvider: true }) {
  mounted = mountComponent(EditorPane, { props: { groupId: 'group-1' } });
  const { app, platform, container } = mounted;

  const server = new FakeLanguageServer({ capabilities });
  platform.languageServerFactory = () => server;
  await platform.writeConfigFile(
    SERVERS_FILE,
    JSON.stringify({ servers: [{ languages: ['typescript'], command: 'fake' }] }),
  );
  await app.serverRegistry.load();

  platform.seedFile(MAIN, UGLY);
  await app.workspace.openFolder('/w');
  await app.lsp.start();

  const id = (await app.workspace.open(MAIN))!;
  app.workspace.setActive(id);
  flush();

  const view = EditorView.findFromDOM(container)!;
  return { app, server, view, id, platform };
}

/** Edits that turn UGLY into PRETTY, as a formatter would send them. */
const EDITS = [
  { range: { start: { line: 0, character: 5 }, end: { line: 0, character: 7 } }, newText: ' ' },
  { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 8 } }, newText: ' ' },
  { range: { start: { line: 0, character: 9 }, end: { line: 0, character: 9 } }, newText: ' ' },
  { range: { start: { line: 0, character: 10 }, end: { line: 0, character: 10 } }, newText: ';' },
  { range: { start: { line: 1, character: 3 }, end: { line: 1, character: 6 } }, newText: ' ' },
  { range: { start: { line: 1, character: 11 }, end: { line: 1, character: 11 } }, newText: ';' },
];

function messages(app: Mounted['app']): string[] {
  return app.notifications.items.get().map((n) => n.message);
}

function asked(server: FakeLanguageServer) {
  return server.written.filter((m) => m.method === 'textDocument/formatting');
}

describe('Format Document', () => {
  it('is disabled when no server for the language offers formatting', async () => {
    const { app } = await setup({});
    expect(app.commands.isEnabled('lsp.formatDocument')).toBe(false);
  });

  it("asks with the editor's own indentation settings", async () => {
    const { app, server } = await setup();
    app.config.set('editor.tabSize', 4);
    app.config.set('editor.insertSpaces', false);
    server.handle('textDocument/formatting', () => null);

    await app.commands.execute('lsp.formatDocument');

    expect(asked(server)).toHaveLength(1);
    expect(asked(server)[0]!.params).toEqual({
      textDocument: { uri: pathToUri(MAIN) },
      options: { tabSize: 4, insertSpaces: false },
    });
  });

  it('applies the edits as one change that one undo takes back', async () => {
    const { app, server, id } = await setup();
    server.handle('textDocument/formatting', () => EDITS);

    await app.commands.execute('lsp.formatDocument');
    expect(app.workspace.textOf(id)).toBe(PRETTY);

    await app.commands.execute('edit.undo');
    expect(app.workspace.textOf(id)).toBe(UGLY);
  });

  it('changes nothing, and says nothing, when the server has no edits', async () => {
    const { app, server, id } = await setup();
    server.handle('textDocument/formatting', () => null);
    await app.commands.execute('lsp.formatDocument');
    expect(app.workspace.textOf(id)).toBe(UGLY);
    expect(messages(app)).toEqual([]);
  });

  it('reports a server error rather than throwing', async () => {
    const { app, server, id } = await setup();
    server.handle('textDocument/formatting', () => {
      throw new Error('no formatter for this file');
    });
    await app.commands.execute('lsp.formatDocument');
    expect(messages(app)).toContain('Format failed');
    expect(app.workspace.textOf(id)).toBe(UGLY);
  });
});

describe('format on save', () => {
  it('formats before the write, so the disk holds the formatted text', async () => {
    const { app, server, id, platform, view } = await setup();
    app.config.set('files.formatOnSave', true);
    server.handle('textDocument/formatting', () => EDITS);
    view.dispatch({ changes: { from: 0, insert: '' } });

    expect(await app.save(id)).toBe(true);

    expect(asked(server)).toHaveLength(1);
    expect(app.workspace.textOf(id)).toBe(PRETTY);
    expect(await platform.readTextFile(MAIN)).toBe(PRETTY);
    expect(app.workspace.buffers.get().find((b) => b.id === id)?.isDirty).toBe(false);
  });

  it('does not ask when the setting is off', async () => {
    const { app, server, id, platform } = await setup();
    server.handle('textDocument/formatting', () => EDITS);
    expect(await app.save(id)).toBe(true);
    expect(asked(server)).toHaveLength(0);
    expect(await platform.readTextFile(MAIN)).toBe(UGLY);
  });

  it('does not ask under after-delay autosave, which would reformat under the cursor', async () => {
    const { app, server, id } = await setup();
    app.config.set('files.formatOnSave', true);
    app.config.set('files.autoSave', 'afterDelay');
    server.handle('textDocument/formatting', () => EDITS);
    expect(await app.save(id)).toBe(true);
    expect(asked(server)).toHaveLength(0);
  });

  it('saves unformatted, and says so, when the server does not answer in time — and ignores a late answer', async () => {
    const { app, server, id, platform } = await setup();
    app.config.set('files.formatOnSave', true);
    let answer: (edits: unknown) => void = () => {};
    server.handle('textDocument/formatting', () => new Promise((resolve) => (answer = resolve)));

    const started = Date.now();
    expect(await app.save(id)).toBe(true);
    const waited = Date.now() - started;

    expect(waited).toBeGreaterThanOrEqual(NoxApp.FORMAT_ON_SAVE_TIMEOUT_MS - 50);
    expect(waited).toBeLessThan(NoxApp.FORMAT_ON_SAVE_TIMEOUT_MS + 1500);
    expect(await platform.readTextFile(MAIN)).toBe(UGLY);
    expect(messages(app)).toContain('Saved main.ts without formatting');

    // The server finally answers. Nothing moves: the save is done.
    answer(EDITS);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(app.workspace.textOf(id)).toBe(UGLY);
    expect(app.workspace.buffers.get().find((b) => b.id === id)?.isDirty).toBe(false);
  }, 10_000);

  it('saves what was typed, unformatted, when a keystroke lands while the server thinks', async () => {
    const { app, server, id, platform, view } = await setup();
    app.config.set('files.formatOnSave', true);
    server.handle('textDocument/formatting', () => {
      // A keystroke between the request and the answer.
      view.dispatch({ changes: { from: 0, insert: '// typed\n' } });
      return EDITS;
    });

    expect(await app.save(id)).toBe(true);

    expect(await platform.readTextFile(MAIN)).toBe('// typed\n' + UGLY);
    expect(messages(app).some((m) => m.includes('without formatting'))).toBe(false);
  });

  it('saves anyway when the server fails, and says why', async () => {
    const { app, server, id, platform } = await setup();
    app.config.set('files.formatOnSave', true);
    server.handle('textDocument/formatting', () => {
      throw new Error('boom');
    });
    expect(await app.save(id)).toBe(true);
    expect(await platform.readTextFile(MAIN)).toBe(UGLY);
    expect(messages(app)).toContain('Saved main.ts without formatting');
  });
});

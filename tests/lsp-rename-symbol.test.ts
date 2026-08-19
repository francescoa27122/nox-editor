// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import EditorPane from '../src/ui/EditorPane.svelte';
import { pathToUri } from '../src/core/uri';
import { SERVERS_FILE } from '../src/services/lsp/registry';
import { flush, mountComponent, type Mounted } from './support/component';
import { FakeLanguageServer } from './support/fake-lsp-process';

/**
 * Rename Symbol, through the real pane, the real service, the real prompt
 * signal and the real review service.
 *
 * The harness of `tests/lsp-find-references.test.ts`. The prompt is answered
 * by resolving `ui.prompt` the way `PromptDialog` would; the review is read
 * from `review.staged` and applied through `applyReview`, the same path the
 * panel's button takes.
 *
 * Mutation-checked on 2026-08-19 against `src/app.ts`: the seed test fails
 * when `prepareRename` is skipped; the stage test fails when `workspace.open`
 * is not awaited for the closed file; the resource-operation test fails
 * when the `unsupported` check is removed; the cancel test fails when the
 * rename is sent regardless of the prompt's answer; the active-file
 * assertion fails when `setActive` is not restored after opening. The stale
 * test is the review service's own guard — `stage` records each buffer's
 * revision and `apply` refuses a moved one — which is why the command passes
 * no `baseRevisions` of its own: a first version did, and a mutation that
 * removed it changed nothing.
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

async function setup(capabilities: Record<string, unknown> = { renameProvider: true }) {
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
  view.dispatch({ selection: { anchor: MAIN_DOC.indexOf('total', MAIN_DOC.indexOf('\n')) } });
  return { app, server, view, id, container };
}

const range = (line: number, from: number, to: number) => ({
  start: { line, character: from },
  end: { line, character: to },
});

/** The server's answer: every `total`, in both files, becomes the new name. */
const EDIT = {
  changes: {
    [pathToUri(MAIN)]: [
      { range: range(0, 9, 14), newText: 'sum' },
      { range: range(1, 12, 17), newText: 'sum' },
    ],
    [pathToUri(LIB)]: [{ range: range(0, 13, 18), newText: 'sum' }],
  },
};

function messages(app: Mounted['app']): string[] {
  return app.notifications.items.get().map((n) => n.message);
}

/** Run the command and, once the prompt is up, answer it. */
async function rename(app: Mounted['app'], answer: string | null): Promise<string> {
  const done = app.commands.execute('lsp.renameSymbol');
  // Let the (optional) prepare round trip and the prompt appear.
  for (let i = 0; i < 10 && !app.ui.prompt.get(); i++) await Promise.resolve();
  const prompt = app.ui.prompt.get();
  if (!prompt) {
    await done;
    return '';
  }
  const seed = prompt.initialValue;
  prompt.resolve(answer);
  await done;
  return seed;
}

describe('the command', () => {
  it('is disabled when no server for the language offers rename', async () => {
    const { app } = await setup({});
    expect(app.commands.isEnabled('lsp.renameSymbol')).toBe(false);
  });

  it('is enabled for a boolean provider and for an object one', async () => {
    const one = await setup({ renameProvider: true });
    expect(one.app.commands.isEnabled('lsp.renameSymbol')).toBe(true);
    await one.app.lsp.stop();
    mounted!.unmount();
    const two = await setup({ renameProvider: { prepareProvider: true } });
    expect(two.app.commands.isEnabled('lsp.renameSymbol')).toBe(true);
  });

  it('seeds the prompt with the word under the cursor when the server has no prepare', async () => {
    const { app, server } = await setup();
    server.handle('textDocument/rename', () => null);
    const seed = await rename(app, null);
    expect(seed).toBe('total');
    expect(server.written.some((m) => m.method === 'textDocument/prepareRename')).toBe(false);
  });

  it("seeds the prompt with the server's placeholder when it offers prepare", async () => {
    const { app, server } = await setup({ renameProvider: { prepareProvider: true } });
    server.handle('textDocument/prepareRename', () => ({ range: range(1, 12, 17), placeholder: 'totalValue' }));
    const seed = await rename(app, null);
    expect(seed).toBe('totalValue');
    const asked = server.written.find((m) => m.method === 'textDocument/prepareRename')!;
    expect(asked.params).toEqual({ textDocument: { uri: pathToUri(MAIN) }, position: { line: 1, character: 12 } });
  });

  it('stops before the prompt when prepare says there is nothing here', async () => {
    const { app, server } = await setup({ renameProvider: { prepareProvider: true } });
    server.handle('textDocument/prepareRename', () => null);
    await app.commands.execute('lsp.renameSymbol');
    expect(app.ui.prompt.get()).toBeNull();
    expect(messages(app)).toContain('Nothing to rename here');
    expect(server.written.some((m) => m.method === 'textDocument/rename')).toBe(false);
  });

  it('sends nothing when the prompt is cancelled', async () => {
    const { app, server } = await setup();
    server.handle('textDocument/rename', () => EDIT);
    await rename(app, null);
    expect(server.written.some((m) => m.method === 'textDocument/rename')).toBe(false);
    expect(app.review.staged.get()).toBeNull();
  });

  it('asks the server with the new name at the cursor', async () => {
    const { app, server } = await setup();
    server.handle('textDocument/rename', () => null);
    await rename(app, 'sum');
    const asked = server.written.filter((m) => m.method === 'textDocument/rename');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.params).toEqual({
      textDocument: { uri: pathToUri(MAIN) },
      position: { line: 1, character: 12 },
      newName: 'sum',
    });
  });

  it('stages one change set over every file, opening the ones that were closed', async () => {
    const { app, server } = await setup();
    server.handle('textDocument/rename', () => EDIT);
    expect(app.workspace.findByPath(LIB)).toBeUndefined();

    await rename(app, 'sum');

    const staged = app.review.staged.get()!;
    expect(staged.description).toBe('Rename total → sum');
    expect(staged.author).toEqual({ kind: 'user' });
    expect(staged.files.map((f) => f.path).sort()).toEqual([LIB, MAIN]);
    expect(app.workspace.findByPath(LIB)).toBeDefined();
    // Every hunk carries the new name, and nothing has been written yet.
    for (const file of staged.files) {
      expect(file.hunks.every((h) => h.added.join('').includes('sum'))).toBe(true);
    }
    expect(app.workspace.textOf(app.workspace.findByPath(MAIN)!.id)).toBe(MAIN_DOC);
    expect(app.workspace.textOf(app.workspace.findByPath(LIB)!.id)).toBe(LIB_DOC);
    expect(app.ui.reviewOpen.get()).toBe(true);
    // Opening lib.ts must not leave the user there.
    expect(app.workspace.activeSnapshot()?.path).toBe(MAIN);
  });

  it('applies as one change set that one undo takes back in both files', async () => {
    const { app, server } = await setup();
    server.handle('textDocument/rename', () => EDIT);
    await rename(app, 'sum');

    expect(app.applyReview()).toBe(true);
    const main = app.workspace.findByPath(MAIN)!.id;
    const lib = app.workspace.findByPath(LIB)!.id;
    expect(app.workspace.textOf(main)).toBe('import { sum } from "./lib";\nconsole.log(sum);\n');
    expect(app.workspace.textOf(lib)).toBe('export const sum = 42;\n');
    expect(app.review.staged.get()).toBeNull();

    await app.commands.execute('edit.undo');
    expect(app.workspace.textOf(main)).toBe(MAIN_DOC);
    expect(app.workspace.textOf(lib)).toBe(LIB_DOC);
  });

  it('refuses to apply over a buffer edited during review', async () => {
    const { app, server, view } = await setup();
    server.handle('textDocument/rename', () => EDIT);
    await rename(app, 'sum');

    view.dispatch({ changes: { from: 0, insert: '// hi\n' } });
    expect(app.applyReview()).toBe(false);
    expect(messages(app)).toContain('Those files changed while you were reviewing');
    expect(app.workspace.textOf(app.workspace.findByPath(LIB)!.id)).toBe(LIB_DOC);
  });

  it('refuses a rename that needs a file operation, changing nothing', async () => {
    const { app, server } = await setup();
    server.handle('textDocument/rename', () => ({
      documentChanges: [
        { kind: 'rename', oldUri: pathToUri(LIB), newUri: pathToUri('/w/sum.ts') },
        { textDocument: { uri: pathToUri(MAIN) }, edits: EDIT.changes[pathToUri(MAIN)] },
      ],
    }));
    await rename(app, 'sum');
    expect(messages(app)).toContain('Rename needs file operations Nox does not perform');
    expect(app.review.staged.get()).toBeNull();
  });

  it('stops, staging nothing, when one of the files cannot be opened', async () => {
    const { app, server } = await setup();
    server.handle('textDocument/rename', () => ({
      changes: {
        ...EDIT.changes,
        [pathToUri('/w/missing.ts')]: [{ range: range(0, 0, 1), newText: 'sum' }],
      },
    }));
    await rename(app, 'sum');
    expect(messages(app)).toContain('Rename stopped');
    expect(app.review.staged.get()).toBeNull();
  });

  it('says so when the server returns nothing', async () => {
    const { app, server } = await setup();
    server.handle('textDocument/rename', () => null);
    await rename(app, 'sum');
    expect(messages(app)).toContain('Nothing to rename');
    expect(app.review.staged.get()).toBeNull();
  });

  it('reports a server error rather than throwing', async () => {
    const { app, server } = await setup();
    server.handle('textDocument/rename', () => {
      throw new Error('Invalid identifier');
    });
    await rename(app, 'sum');
    expect(messages(app)).toContain('Rename failed');
    expect(app.review.staged.get()).toBeNull();
  });
});

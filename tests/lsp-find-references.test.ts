// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import EditorPane from '../src/ui/EditorPane.svelte';
import ReferencesPanel from '../src/ui/ReferencesPanel.svelte';
import { pathToUri } from '../src/core/uri';
import { SERVERS_FILE } from '../src/services/lsp/registry';
import { flush, mountComponent, type Mounted } from './support/component';
import { FakeLanguageServer } from './support/fake-lsp-process';

/**
 * Find References, through the real pane, the real service and the real
 * panel.
 *
 * The harness of `tests/lsp-go-to-definition.test.ts`, plus a real
 * `ReferencesPanel` mounted over the same app, so the rows a click lands
 * from are the rows the user would see.
 *
 * Mutation-checked on 2026-08-19 against `src/app.ts` and the panel: the
 * request test fails when `includeDeclaration` is dropped; the list test
 * fails when `showLocations` stops calling `ui.showView`; the landing test
 * fails when the panel's `open` stops calling `revealLocation`; the no-result
 * test fails when the notification is removed; the unopened-file test fails
 * when `showLocations` stops reading from the platform.
 */

const MAIN = '/w/main.ts';
const LIB = '/w/lib.ts';
const OTHER = '/w/other.ts';
const MAIN_DOC = 'import { total } from "./lib";\nconsole.log(total);\n';
const LIB_DOC = 'export const total = 42;\n';
const OTHER_DOC = '// nothing\n  const twice = total * 2;\n';

let pane: Mounted | null = null;
let panel: Mounted | null = null;

afterEach(async () => {
  try {
    await pane?.app.lsp.stop();
  } finally {
    panel?.unmount();
    pane?.unmount();
    panel = pane = null;
  }
});

async function setup(capabilities: Record<string, unknown> = { referencesProvider: true }) {
  pane = mountComponent(EditorPane, { props: { groupId: 'group-1' } });
  const { app, platform, container } = pane;
  panel = mountComponent(ReferencesPanel, { app });

  const server = new FakeLanguageServer({ capabilities });
  platform.languageServerFactory = () => server;
  await platform.writeConfigFile(
    SERVERS_FILE,
    JSON.stringify({ servers: [{ languages: ['typescript'], command: 'fake' }] }),
  );
  await app.serverRegistry.load();

  platform.seedFile(MAIN, MAIN_DOC);
  platform.seedFile(LIB, LIB_DOC);
  platform.seedFile(OTHER, OTHER_DOC);
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

const loc = (path: string, line: number, from: number, to: number) => ({
  uri: pathToUri(path),
  range: { start: { line, character: from }, end: { line, character: to } },
});

/** Every reference to `total` across the three files, as a server would send them. */
const ALL = [
  loc(MAIN, 1, 12, 17),
  loc(LIB, 0, 13, 18),
  loc(OTHER, 1, 16, 21),
  loc(MAIN, 0, 9, 14),
];

function messages(app: Mounted['app']): string[] {
  return app.notifications.items.get().map((n) => n.message);
}

function rowsShown(): { file: boolean; text: string }[] {
  return [...panel!.container.querySelectorAll<HTMLElement>('.row')].map((row) => ({
    file: row.classList.contains('file'),
    text: row.textContent!.replace(/\s+/g, ' ').trim(),
  }));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  flush();
}

describe('the command', () => {
  it('is disabled when no server for the language offers references', async () => {
    const { app } = await setup({});
    expect(app.commands.isEnabled('lsp.findReferences')).toBe(false);
  });

  it('is enabled when the server offers references', async () => {
    const { app } = await setup();
    expect(app.commands.isEnabled('lsp.findReferences')).toBe(true);
  });

  it("asks for the cursor's position in the active file, declaration included", async () => {
    const { app, server } = await setup();
    server.handle('textDocument/references', () => null);

    await app.commands.execute('lsp.findReferences');

    const asked = server.written.filter((m) => m.method === 'textDocument/references');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.params).toEqual({
      textDocument: { uri: pathToUri(MAIN) },
      position: { line: 1, character: 12 },
      context: { includeDeclaration: true },
    });
  });

  it('fills the References view and shows it, leaving the cursor where it was', async () => {
    const { app, server, view } = await setup();
    server.handle('textDocument/references', () => ALL);
    const before = view.state.selection.main.head;

    await app.commands.execute('lsp.findReferences');
    flush();

    const list = app.locations.get()!;
    expect(list.title).toBe('References');
    expect(list.subject).toBe('total');
    expect(list.total).toBe(4);
    expect(list.files).toBe(3);
    expect(app.ui.sidebarView.get()).toBe('references');
    expect(view.state.selection.main.head).toBe(before);
    expect(app.workspace.activeSnapshot()?.path).toBe(MAIN);
  });

  it('reads the line for a file that is not open, as well as one that is', async () => {
    const { app, server } = await setup();
    server.handle('textDocument/references', () => ALL);

    await app.commands.execute('lsp.findReferences');
    flush();

    expect(rowsShown()).toEqual([
      { file: true, text: 'lib.ts 1' },
      { file: false, text: '1 export const total = 42;' },
      { file: true, text: 'main.ts 2' },
      { file: false, text: '1 import { total } from "./lib";' },
      { file: false, text: '2 console.log(total);' },
      { file: true, text: 'other.ts 1' },
      { file: false, text: '2 const twice = total * 2;' },
    ]);
  });

  it('says so when there are none, and leaves an earlier list alone', async () => {
    const { app, server } = await setup();
    server.handle('textDocument/references', () => ALL);
    await app.commands.execute('lsp.findReferences');
    const earlier = app.locations.get();

    server.handle('textDocument/references', () => []);
    await app.commands.execute('lsp.findReferences');

    expect(messages(app)).toContain('No references found');
    expect(app.locations.get()).toBe(earlier);
  });

  it('reports a server error rather than throwing', async () => {
    const { app, server } = await setup();
    server.handle('textDocument/references', () => {
      throw new Error('no project');
    });

    await app.commands.execute('lsp.findReferences');

    expect(messages(app)).toContain('Find references failed');
    expect(app.locations.get()).toBeNull();
  });
});

describe('the panel', () => {
  it('shows how to fill it when nothing has been asked', async () => {
    await setup();
    expect(panel!.container.textContent).toContain('Find References');
    expect(rowsShown()).toEqual([]);
  });

  it('lands the cursor in the file a clicked row names, selecting the symbol', async () => {
    const { app, server, container } = await setup();
    server.handle('textDocument/references', () => ALL);
    await app.commands.execute('lsp.findReferences');
    flush();

    // The row for other.ts line 2 — the last one.
    const rows = panel!.container.querySelectorAll<HTMLElement>('.row');
    rows[rows.length - 1]!.click();
    await settle();

    expect(app.workspace.activeSnapshot()?.path).toBe(OTHER);
    const view = EditorView.findFromDOM(container)!;
    const { from, to } = view.state.selection.main;
    expect(view.state.doc.sliceString(from, to)).toBe('total');
    expect(from).toBe(OTHER_DOC.indexOf('total'));
  });

  it('opens the file when a file row is clicked', async () => {
    const { app, server } = await setup();
    server.handle('textDocument/references', () => ALL);
    await app.commands.execute('lsp.findReferences');
    flush();

    panel!.container.querySelector<HTMLElement>('.row.file')!.click();
    await settle();

    expect(app.workspace.activeSnapshot()?.path).toBe(LIB);
  });

  it('moves with the arrow keys and lands on Enter', async () => {
    const { app, server } = await setup();
    server.handle('textDocument/references', () => ALL);
    await app.commands.execute('lsp.findReferences');
    flush();

    const list = panel!.container.querySelector<HTMLElement>('.list')!;
    const key = (k: string) =>
      list.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('ArrowDown');
    key('ArrowDown');
    flush();
    expect(panel!.container.querySelector('.row.focused')!.textContent).toContain(
      'export const total',
    );
    key('Enter');
    await settle();

    expect(app.workspace.activeSnapshot()?.path).toBe(LIB);
  });
});

// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import EditorPane from '../src/ui/EditorPane.svelte';
import ProblemsPanel from '../src/ui/ProblemsPanel.svelte';
import { pathToUri } from '../src/core/uri';
import { SERVERS_FILE } from '../src/services/lsp/registry';
import { flush, mountComponent, type Mounted } from './support/component';
import { FakeLanguageServer } from './support/fake-lsp-process';

/**
 * Opening a problem lands the cursor in the file the problem names.
 *
 * `ProblemsPanel.open()` does `await workspace.open(path)` and then
 * `app.goToLine(...)` on whatever view the app considers current. The
 * question that was left open on 2026-08-19 (WORKLOG, "Go to definition")
 * was whether the pane's swap to the newly opened buffer can ever run
 * *after* that continuation — in which case the cursor would move in the
 * previous buffer instead. This is the seam, measured rather than argued:
 * a real `ProblemsPanel` over the same app as a real `EditorPane`, a
 * diagnostic in a file nobody has opened, a click on the row.
 *
 * Why it holds: `workspace.open` calls `setActive` before it resolves, the
 * pane's `$effect` is queued as a microtask at that moment, and the
 * `await` continuation is queued after it. Both the fresh-open and the
 * already-open branches of `open` are covered, since they resolve on
 * different paths.
 */

const MAIN = '/w/main.ts';
const LIB = '/w/lib.ts';
const MAIN_DOC = 'line1\nline2\nline3\n';
const LIB_DOC = 'a\nb\nc\nd\ne\n';

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

async function setup() {
  pane = mountComponent(EditorPane, { props: { groupId: 'group-1' } });
  const { app, platform, container } = pane;
  panel = mountComponent(ProblemsPanel, { app });

  const server = new FakeLanguageServer({ capabilities: {} });
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

  const main = (await app.workspace.open(MAIN))!;
  app.workspace.setActive(main);
  flush();
  expect(EditorView.findFromDOM(container)!.state.doc.toString()).toBe(MAIN_DOC);

  // One error in lib.ts, line 4 (0-based 3), column 1.
  server.publish(pathToUri(LIB), [
    { range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } }, severity: 1, message: 'd' },
  ]);
  flush();

  return { app, container, main };
}

function problemRow(): HTMLElement {
  const rows = [...panel!.container.querySelectorAll<HTMLElement>('.row')];
  const row = rows.find((r) => !r.classList.contains('file'));
  expect(row, 'a problem row').toBeDefined();
  return row!;
}

/** Line 4, column 1 of LIB_DOC. */
const LANDING = LIB_DOC.indexOf('d');

async function settle(): Promise<void> {
  // `open()` is fire-and-forget from the click; let its awaits run.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  flush();
}

describe('focusing the panel', () => {
  it('puts the keyboard in the list when the command runs — the audit found it never did', async () => {
    await setup();
    await pane!.app.commands.execute('problems.focus');
    flush();
    const list = panel!.container.querySelector('.list');
    expect(list).not.toBeNull();
    expect(document.activeElement).toBe(list);
  });
});

describe('opening a problem', () => {
  it('moves the cursor in the file the problem names, not the one that was showing', async () => {
    const { container } = await setup();

    problemRow().click();
    await settle();

    const view = EditorView.findFromDOM(container)!;
    expect(view.state.doc.toString()).toBe(LIB_DOC);
    expect(view.state.selection.main.head).toBe(LANDING);
  });

  it('does the same when the file is already open behind the current one', async () => {
    const { app, container, main } = await setup();
    await app.workspace.open(LIB);
    app.workspace.setActive(main);
    flush();
    expect(EditorView.findFromDOM(container)!.state.doc.toString()).toBe(MAIN_DOC);

    problemRow().click();
    await settle();

    const view = EditorView.findFromDOM(container)!;
    expect(view.state.doc.toString()).toBe(LIB_DOC);
    expect(view.state.selection.main.head).toBe(LANDING);
  });

  it('leaves the showing buffer alone', async () => {
    const { app, main } = await setup();
    const before = app.workspace.textOf(main);
    const cursorBefore = app.workspace.get(main)?.state.selection.main.head;

    problemRow().click();
    await settle();

    expect(app.workspace.textOf(main)).toBe(before);
    expect(app.workspace.get(main)?.state.selection.main.head).toBe(cursorBefore);
  });
});

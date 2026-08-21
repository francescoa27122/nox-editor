// @vitest-environment jsdom
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import EditorPane from '../src/ui/EditorPane.svelte';
import { flush, mountComponent, type Mounted } from './support/component';
import { installRangeRects } from './support/jsdom-layout';

/**
 * The editor's own context menu.
 *
 * What this guards: right-clicking the code surface used to fall through to
 * the webview's menu — Reload, Services, Look Up — because nothing in
 * `EditorPane` listened for `contextmenu` and nothing suppressed the default.
 * That is not merely ugly on a desktop app; it is where Go to Definition,
 * Find References, Rename Symbol and Format Document are *only* otherwise
 * reachable by F12 / ⇧F12 / F2 / ⇧⌥F, which on a default-configured Mac
 * laptop all sit behind `fn`. The menu exists to teach those chords, so the
 * chord assertions below matter as much as the menu's existence.
 *
 * What it does not reach is placement: jsdom has no layout engine, and
 * `tests/support/jsdom-layout.ts` says why inventing one would be dishonest.
 * The same zero geometry makes `posAtCoords` answer with the end of the
 * document for every pointer, which is why the two selection tests below are
 * written around `DOC.length` — they exercise the inside/outside branch, not
 * CodeMirror's arithmetic, which needs a browser.
 *
 * Mutation-checked on 2026-08-21, each by breaking `EditorPane.svelte` and
 * watching the named test go red before restoring it:
 * - dropping `event.preventDefault()` from `openMenu` — the suppression test;
 * - collapsing the caret unconditionally — "keeps a selection";
 * - never collapsing it — "moves the caret";
 * - filtering disabled commands out of `menuItems` instead of marking them
 *   disabled — the item-list, chord and greying tests together.
 */

installRangeRects();

const FILE = '/w/main.ts';
const DOC = 'const total = 42;\nconst answer = total;\n';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function pane() {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w');
  platform.seedFile(FILE, DOC);

  const app = new NoxApp(platform);
  await app.workspace.openFolder('/w');

  mounted = mountComponent(EditorPane, { props: { groupId: 'group-1' }, app });
  const id = (await app.workspace.open(FILE))!;
  app.workspace.setActive(id);
  flush();

  const view = EditorView.findFromDOM(mounted.container)!;
  expect(view).not.toBeNull();
  return { app, view, container: mounted.container };
}

/** Right-click the code surface, as a user does. Returns the event dispatched. */
function rightClick(view: EditorView, coords = { x: 12, y: 34 }): MouseEvent {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: coords.x,
    clientY: coords.y,
  });
  view.contentDOM.dispatchEvent(event);
  flush();
  return event;
}

const menuOf = (container: HTMLElement) => container.querySelector('[role="menu"]');

function itemsOf(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map((button) => ({
    label: button.querySelector('.label')?.textContent ?? '',
    hint: button.querySelector('kbd')?.textContent ?? null,
    disabled: button.disabled,
  }));
}

const find = (container: HTMLElement, label: string) =>
  itemsOf(container).find((item) => item.label === label);

describe('right-clicking the editor', () => {
  it("opens Nox's menu and suppresses the webview's own", async () => {
    const { view, container } = await pane();
    expect(menuOf(container)).toBeNull();

    const event = rightClick(view);

    expect(menuOf(container)).not.toBeNull();
    expect(event.defaultPrevented).toBe(true);
  });

  it('offers the four LSP actions, the two edit actions and the diff, in groups', async () => {
    const { view, container } = await pane();
    rightClick(view);

    expect(itemsOf(container).map((item) => item.label)).toEqual([
      'Go to Definition',
      'Find References',
      'Rename Symbol',
      'Format Document',
      'Toggle Line Comment',
      'Select All Occurrences',
      'Show Changes',
    ]);
    // Two separators: LSP | edit | git.
    expect(container.querySelectorAll('[role="separator"]').length).toBe(2);
  });

  it('teaches the chord of every item that has one, and invents none', async () => {
    const { app, view, container } = await pane();
    rightClick(view);

    // The two the defect report names: identical on every platform, because
    // neither carries a modifier.
    expect(find(container, 'Go to Definition')?.hint).toBe('F12');
    expect(find(container, 'Rename Symbol')?.hint).toBe('F2');

    // The rest come from the keymap rather than from a literal here, so a
    // rebound key or a different platform's symbols cannot make this lie.
    expect(find(container, 'Find References')?.hint).toBe(
      app.keymap.displayFor('lsp.findReferences'),
    );
    expect(find(container, 'Format Document')?.hint).toBe(
      app.keymap.displayFor('lsp.formatDocument'),
    );
    expect(find(container, 'Select All Occurrences')?.hint).toBe(
      app.keymap.displayFor('edit.selectAllMatches'),
    );

    // CodeMirror owns this one, so it has no application binding at all and
    // only `Command.keyHint` knows about it.
    expect(app.keymap.displayFor('edit.toggleComment')).toBeUndefined();
    expect(find(container, 'Toggle Line Comment')?.hint).toBeTruthy();

    // Unbound and un-hinted: no `kbd` element rather than an empty one.
    expect(app.keymap.displayFor('git.showDiff')).toBeUndefined();
    expect(find(container, 'Show Changes')?.hint).toBeNull();
  });

  it('greys the commands that cannot run rather than hiding them', async () => {
    const { app, view, container } = await pane();
    rightClick(view);

    // No language server is running and Git never started, so these five are
    // disabled — and still listed, which is the whole point of the menu.
    for (const label of [
      'Go to Definition',
      'Find References',
      'Rename Symbol',
      'Format Document',
      'Show Changes',
    ]) {
      expect(app.commands.isEnabled(labelToId(label))).toBe(false);
      expect(find(container, label)?.disabled).toBe(true);
    }

    // And the two that can run are not, or the assertion above would pass
    // for a menu that simply disables everything.
    expect(find(container, 'Toggle Line Comment')?.disabled).toBe(false);
    expect(find(container, 'Select All Occurrences')?.disabled).toBe(false);
  });

  it('keeps a selection the pointer landed inside', async () => {
    const { view, container } = await pane();
    view.dispatch({ selection: EditorSelection.range(DOC.length - 5, DOC.length) });

    // Zero geometry resolves every pointer to the end of the document, which
    // is inside this range — the branch under test.
    rightClick(view);

    expect(menuOf(container)).not.toBeNull();
    expect(view.state.selection.main.from).toBe(DOC.length - 5);
    expect(view.state.selection.main.to).toBe(DOC.length);
  });

  it('moves the caret when the pointer landed outside the selection', async () => {
    const { view } = await pane();
    view.dispatch({ selection: EditorSelection.range(0, 5) });

    rightClick(view);

    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.selection.main.head).toBe(DOC.length);
  });
});

describe('the editor context menu from the keyboard', () => {
  it('opens on the ContextMenu key', async () => {
    const { view, container } = await pane();
    press(view, { key: 'ContextMenu' });
    expect(menuOf(container)).not.toBeNull();
  });

  it('opens on Shift+F10', async () => {
    const { view, container } = await pane();
    press(view, { key: 'F10', shiftKey: true });
    expect(menuOf(container)).not.toBeNull();
  });

  it('leaves an unmodified F10 alone', async () => {
    const { view, container } = await pane();
    press(view, { key: 'F10' });
    expect(menuOf(container)).toBeNull();
  });
});

function press(view: EditorView, init: KeyboardEventInit): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
  );
  flush();
}

/** The menu labels are the registry's own titles, so this maps back. */
function labelToId(label: string): string {
  const ids: Record<string, string> = {
    'Go to Definition': 'lsp.goToDefinition',
    'Find References': 'lsp.findReferences',
    'Rename Symbol': 'lsp.renameSymbol',
    'Format Document': 'lsp.formatDocument',
    'Show Changes': 'git.showDiff',
  };
  return ids[label]!;
}

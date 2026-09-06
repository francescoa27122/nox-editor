// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EditorPane from '../src/ui/EditorPane.svelte';
import { flush, mountComponent, type Mounted } from './support/component';
import { installRangeRects } from './support/jsdom-layout';

// `workspace.apply` dispatches with scrollIntoView, and CodeMirror measures
// for it; jsdom has no geometry. See `tests/support/jsdom-layout.ts`.
installRangeRects();

/**
 * The commands behind the menu items macOS gets from the system.
 *
 * Guards A1-003: on Windows and Linux the drawn menu filtered every
 * predefined item out and put nothing in its place, so Edit had no Cut, Copy
 * or Paste, the Nox menu had no About or Exit, and View had no Full Screen.
 * `tests/menu.test.ts` holds the menu to listing these; this holds each one
 * to doing what its title says.
 *
 * Does not catch: what the real webview's clipboard does with `execCommand`
 * (jsdom has no clipboard, so the command is observed rather than its
 * effect), or the native Quit and Full Screen items on macOS.
 */

const FILE = '/w/notes.txt';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.restoreAllMocks();
});

async function setup(text = 'alpha beta') {
  mounted = mountComponent(EditorPane, { props: { groupId: 'group-1' } });
  const { app, platform, container } = mounted;
  platform.seedFile(FILE, text);
  await app.workspace.openFolder('/w');
  const id = (await app.workspace.open(FILE))!;
  app.workspace.setActive(id);
  flush();
  const view = EditorView.findFromDOM(container)!;
  return { app, platform, view, id };
}

describe('the clipboard commands', () => {
  it.each(['cut', 'copy'] as const)('%s runs the browser command with the editor focused', async (kind) => {
    const { app, view } = await setup();
    const execCommand = vi.fn(() => document.activeElement === view.contentDOM);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });

    expect(await app.commands.execute(`edit.${kind}`)).toBe(true);
    expect(execCommand).toHaveBeenCalledWith(kind);
    // The return value is the spy's focus check: false would mean the command
    // ran against whatever the menu left focused rather than the document.
    expect(execCommand).toHaveReturnedWith(true);
  });

  it('paste reads the clipboard and inserts it as a paste', async () => {
    const { app, view, id } = await setup('alpha ');
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: async () => 'pasted' },
      configurable: true,
    });
    view.dispatch({ selection: { anchor: view.state.doc.length } });

    expect(await app.commands.execute('edit.paste')).toBe(true);
    expect(app.workspace.textOf(id)).toBe('alpha pasted');
  });

  it('paste says so when the clipboard cannot be read, and leaves the document alone', async () => {
    const { app, id } = await setup('alpha');
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        readText: async () => {
          throw new Error('denied');
        },
      },
      configurable: true,
    });

    await app.commands.execute('edit.paste');
    expect(app.workspace.textOf(id)).toBe('alpha');
    expect(app.notifications.items.get().map((n) => n.message)).toContain(
      'Could not read the clipboard.',
    );
  });
});

describe('the application commands', () => {
  it('exit closes through the close request so the session is written', async () => {
    const { app, platform } = await setup();
    const closeWindow = vi.spyOn(platform, 'closeWindow');

    await app.commands.execute('app.quit');
    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it('about names the version', async () => {
    const { app } = await setup();

    await app.commands.execute('app.about');
    const messages = app.notifications.items.get().map((n) => n.message);
    expect(messages.some((message) => /^Nox \d+\.\d+\.\d+/.test(message))).toBe(true);
  });

  it('full screen toggles the window', async () => {
    const { app, platform } = await setup();

    await app.commands.execute('view.toggleFullscreen');
    expect(platform.fullscreen).toBe(true);
    await app.commands.execute('view.toggleFullscreen');
    expect(platform.fullscreen).toBe(false);
  });
});

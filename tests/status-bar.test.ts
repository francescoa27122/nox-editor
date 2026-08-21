// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import StatusBar from '../src/ui/StatusBar.svelte';
import { flush, mountComponent } from './support/component';

/**
 * The status bar as a set of controls rather than a readout.
 *
 * Three things this pins, all of them defects the bar shipped with: chrome
 * that reached past the command registry into `config.set` and
 * `workspace.setEol` — actions the palette therefore could not find, bind or
 * rank; a tooltip that spelled a macOS chord as literal glyphs on an app that
 * ships Windows and Linux builds; and the terminal having no visible way back
 * in, despite the panel shipping a Hide button.
 */

/** MemoryPlatform, but with a shell — what the desktop target looks like. */
class TerminalPlatform extends MemoryPlatform {
  constructor() {
    super();
    this.capabilities.terminals = true;
  }
}

let teardown: (() => void) | null = null;

afterEach(() => {
  teardown?.();
  teardown = null;
});

async function mountBar(platform: MemoryPlatform = new MemoryPlatform()) {
  platform.mkdirp('/w');
  platform.seedFile('/w/a.ts', 'const a = 1;\n');
  const app = new NoxApp(platform);
  await app.workspace.openFolder('/w');
  await app.workspace.open('/w/a.ts');

  const mounted = mountComponent(StatusBar, { app });
  teardown = mounted.unmount;
  flush();
  return { app, container: mounted.container };
}

/** The bar's button whose visible text starts with `text`. */
function item(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((button) =>
    (button.textContent ?? '').trim().startsWith(text),
  );
  expect(found, `no status-bar item starting with "${text}"`).toBeDefined();
  return found as HTMLButtonElement;
}

const click = (element: HTMLElement) =>
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));

describe('the status bar', () => {
  it('changes the indent type through the command, not through config', async () => {
    const { app, container } = await mountBar();
    const before = app.config.get('editor.insertSpaces');

    click(item(container, 'Spaces:'));
    flush();

    expect(app.config.get('editor.insertSpaces')).toBe(!before);
    // The point of the fix: the click is a command dispatch, so the palette,
    // the keybinding editor and the recency ranking all see it.
    expect(app.commands.lastExecuted.get()).toBe('view.toggleIndentType');
  });

  it('changes the line endings through the command, not through the workspace', async () => {
    const { app, container } = await mountBar();
    expect(app.workspace.activeSnapshot()?.eol).toBe('\n');

    click(item(container, 'LF'));
    flush();

    expect(app.workspace.activeSnapshot()?.eol).toBe('\r\n');
    expect(app.commands.lastExecuted.get()).toBe('file.toggleLineEnding');
  });

  it('says what the unsaved count does when clicked', async () => {
    const { app, container } = await mountBar();
    const id = app.workspace.activeId.get()!;
    app.workspace.replaceContents(id, 'const a = 2;\n');
    flush();

    const unsaved = item(container, '1 unsaved');
    // It looks like the readouts beside it and writes every dirty buffer to
    // disk, so the label has to say so before the click rather than after.
    expect(unsaved.getAttribute('aria-label')).toBe('Save all 1 unsaved file');
    expect(unsaved.title).toContain('Save all');
  });

  it('spells the Problems chord the way this platform spells it', async () => {
    const { app, container } = await mountBar();
    app.lsp.diagnostics.set(
      new Map([
        [
          'file:///w/a.ts',
          [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1 as const, message: 'bad' }],
        ],
      ]),
    );
    flush();

    const problems = [...container.querySelectorAll('button')].find((button) =>
      button.title.startsWith('Show Problems'),
    );
    expect(problems).toBeDefined();
    // Whatever `formatChord` renders here — ⌘⇧M on macOS, Ctrl+Shift+M
    // elsewhere — the bar must not have spelled it itself.
    expect(problems!.title).toBe(`Show Problems (${app.keymap.displayFor('problems.focus')})`);
  });

  it('offers no terminal on a platform without one', async () => {
    const { container } = await mountBar();
    const terminal = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Terminal',
    );
    expect(terminal).toBeUndefined();
  });

  /**
   * The failure this guards: `TerminalPanel` ships a Hide button and nothing
   * anywhere reopens it — `grep -rn "terminal.toggle" src/ui/` found nothing
   * at all — so closing the terminal made it unreachable without the palette.
   */
  it('toggles the terminal where there is one, and shows its state', async () => {
    const { app, container } = await mountBar(new TerminalPlatform());
    const terminal = item(container, 'Terminal');
    expect(terminal.getAttribute('aria-pressed')).toBe('false');

    click(terminal);
    flush();
    expect(app.ui.terminalOpen.get()).toBe(true);
    expect(item(container, 'Terminal').getAttribute('aria-pressed')).toBe('true');
    // Colour is not the only signal; `.on` carries the ground as well.
    expect(item(container, 'Terminal').classList.contains('on')).toBe(true);

    click(item(container, 'Terminal'));
    flush();
    expect(app.ui.terminalOpen.get()).toBe(false);
  });
});

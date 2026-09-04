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

async function mountBar(platform: MemoryPlatform = new MemoryPlatform(), open = '/w/a.ts') {
  platform.mkdirp('/w');
  platform.seedFile('/w/a.ts', 'const a = 1;\n');
  platform.seedFile('/w/main.py', 'x = 1\n');
  const app = new NoxApp(platform);
  await app.workspace.openFolder('/w');
  await app.workspace.open(open);

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
    // A4-010: the bar reads `diagnosticsTotals`, a running total the service
    // keeps in step with `diagnostics` itself — poking `diagnostics` directly
    // here, bypassing `#publishDiagnostics`, has to poke this too.
    app.lsp.diagnosticsTotals.set({ errors: 1, warnings: 0, files: 1 });
    flush();

    const problems = [...container.querySelectorAll('button')].find((button) =>
      button.title.startsWith('Show Problems'),
    );
    expect(problems).toBeDefined();
    // Whatever `formatChord` renders here — ⌘⇧M on macOS, Ctrl+Shift+M
    // elsewhere — the bar must not have spelled it itself.
    expect(problems!.title).toBe(`Show Problems (${app.keymap.displayFor('problems.focus')})`);
  });

  /**
   * The defect this guards: the bar's LSP readout was a global aggregate with
   * a per-file label, so `typescript-language-server` sat on screen beside an
   * open `main.py` while nothing anywhere said Python had no server, that Go
   * to Definition would do nothing here, or what to install.
   */
  it('names no server for a file no server serves, and says so where the user looks', async () => {
    const { app, container } = await mountBar(new MemoryPlatform(), '/w/main.py');
    app.lsp.sessions.set([
      {
        name: 'typescript-language-server',
        status: 'running',
        languages: ['typescript', 'javascript'],
        error: null,
        stderr: [],
        progress: [],
      },
    ]);
    flush();

    const named = [...container.querySelectorAll('button, span')].find((element) =>
      (element.textContent ?? '').includes('typescript-language-server'),
    );
    expect(named, 'the bar named a server that has nothing to do with this file').toBeUndefined();

    // Said out loud in the control that already carried "no grammar
    // installed", rather than left to the Language commands greying out —
    // which reads as "not applicable" rather than "not configured".
    const language = item(container, 'Python');
    expect(language.title).toBe('Python — no language server configured');

    click(language);
    flush();
    expect(app.commands.lastExecuted.get()).toBe('lsp.configure');
  });

  it('still names the server when it really is the one serving this file', async () => {
    const { app, container } = await mountBar();
    app.lsp.sessions.set([
      {
        name: 'typescript-language-server',
        status: 'running',
        languages: ['typescript', 'javascript'],
        error: null,
        stderr: [],
        progress: [],
      },
    ]);
    flush();

    expect(item(container, 'typescript-language-server')).toBeDefined();

    // The language item keeps saying which server is serving this file — and
    // is now a *button* rather than the readout it used to be in this state.
    // It was the one dead item in a row of live ones, labelled with a
    // language and refusing to let you change it; changing the language is
    // what it does wherever `lsp.configure` has nothing to offer.
    const language = [...container.querySelectorAll('button')].find(
      (element) => element.textContent?.trim() === 'TypeScript',
    );
    expect(language).toBeDefined();
    expect(language?.getAttribute('title')).toBe('TypeScript — typescript-language-server');
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

  /**
   * The failure this prevents, found in a UI walk on 2026-08-23: with a split
   * pane focused and nothing open in it, the whole bar rendered as the single
   * word "Wrap" in the far corner. Every other item is inside `{#if active}`;
   * this one sat outside it, so it survived alone and the bar read as broken
   * rather than as empty.
   *
   * Word wrap is a property of the buffer on screen, so with no buffer there
   * is nothing for it to be about.
   */
  it('shows nothing buffer-shaped, Wrap included, when no file is open', async () => {
    const { app, container } = await mountBar();
    // With a file open, the buffer items are all there.
    expect(item(container, 'Wrap')).toBeDefined();
    expect(item(container, 'Ln')).toBeDefined();

    app.workspace.closeAll({ force: true });
    flush();

    const labels = [...container.querySelectorAll('button')].map((b) =>
      (b.textContent ?? '').trim(),
    );
    expect(labels).not.toContain('Wrap');
    expect(labels.some((l) => l.startsWith('Ln '))).toBe(false);
  });
});

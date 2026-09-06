// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import { platformIsMac } from '../src/services/keymap';
import App from '../src/ui/App.svelte';
import BottomPanel from '../src/ui/BottomPanel.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * The bottom panel: Terminal and Tasks below the editor, one at a time.
 *
 * Tasks used to take over the editor area, so the code you were building
 * disappeared while it built. See
 * `docs/superpowers/specs/2026-09-05-bottom-panel-design.md`.
 */

/** MemoryPlatform, but with a shell, which is what the desktop target has. */
class TerminalPlatform extends MemoryPlatform {
  constructor() {
    super();
    this.capabilities.terminals = true;
  }
}

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const click = (element: Element | null | undefined) => {
  expect(element, 'expected a control to click').toBeTruthy();
  element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};

const tab = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (b) => (b.textContent ?? '').trim() === name,
  );

describe('one view at a time', () => {
  it('lets the terminal and tasks take turns, and remembers the last one', () => {
    const app = new NoxApp(new TerminalPlatform());
    app.ui.showTasks();
    expect(app.ui.tasksOpen.get()).toBe(true);
    expect(app.ui.bottomView.get()).toBe('tasks');

    app.ui.focusTerminal();
    expect(app.ui.terminalOpen.get()).toBe(true);
    expect(app.ui.tasksOpen.get()).toBe(false);
    expect(app.ui.bottomView.get()).toBe('terminal');

    app.ui.showTasks();
    expect(app.ui.terminalOpen.get()).toBe(false);
    expect(app.ui.tasksOpen.get()).toBe(true);
  });

  /**
   * The failure this guards: tasks was the fifth panel in the editor slot,
   * and showing it cleared agents, diff and review by name. Below the
   * editor it shares nothing with them.
   */
  it('leaves the editor-slot panels alone', () => {
    const app = new NoxApp(new MemoryPlatform());
    app.ui.showAgents();
    app.ui.showTasks();
    expect(app.ui.agentsOpen.get()).toBe(true);
    expect(app.ui.tasksOpen.get()).toBe(true);
  });
});

describe('the toggle', () => {
  it('falls back to tasks where there is no terminal, and closes what it opened', async () => {
    const app = new NoxApp(new MemoryPlatform());
    expect(await app.commands.execute('view.toggleBottomPanel')).toBe(true);
    expect(app.ui.tasksOpen.get()).toBe(true);

    await app.commands.execute('view.toggleBottomPanel');
    expect(app.ui.tasksOpen.get()).toBe(false);
    expect(app.ui.terminalOpen.get()).toBe(false);
  });

  it('reopens the view that was showing last', async () => {
    const app = new NoxApp(new TerminalPlatform());
    app.ui.showTasks();
    await app.commands.execute('view.toggleBottomPanel');
    expect(app.ui.tasksOpen.get()).toBe(false);

    await app.commands.execute('view.toggleBottomPanel');
    expect(app.ui.tasksOpen.get()).toBe(true);
    expect(app.ui.terminalOpen.get()).toBe(false);
  });

  it('answers Mod+J', () => {
    const app = new NoxApp(new MemoryPlatform());
    const event = {
      code: 'KeyJ',
      key: '',
      ctrlKey: !platformIsMac,
      metaKey: platformIsMac,
      altKey: false,
      shiftKey: false,
      repeat: false,
      isComposing: false,
      preventDefault: () => {},
      stopPropagation: () => {},
    } as KeyboardEvent;
    expect(app.keymap.resolve(event)).toBe('view.toggleBottomPanel');
  });
});

describe('the strip', () => {
  it('offers a Terminal tab only where there is a shell', async () => {
    const without = new NoxApp(new MemoryPlatform());
    mounted = mountComponent(BottomPanel, { app: without });
    await without.commands.execute('tasks.show');
    flush();
    expect(tab(mounted.container, 'Terminal')).toBeUndefined();
    expect(tab(mounted.container, 'Tasks')?.getAttribute('aria-selected')).toBe('true');
    mounted.unmount();

    const withShell = new NoxApp(new TerminalPlatform());
    mounted = mountComponent(BottomPanel, { app: withShell });
    await withShell.commands.execute('tasks.show');
    flush();
    expect(tab(mounted.container, 'Terminal')?.getAttribute('aria-selected')).toBe('false');
  });

  it('switches views through the commands, and Hide closes the one showing', async () => {
    const app = new NoxApp(new TerminalPlatform());
    mounted = mountComponent(BottomPanel, { app });
    await app.commands.execute('tasks.show');
    flush();

    click(tab(mounted.container, 'Terminal'));
    await Promise.resolve();
    flush();
    expect(app.ui.terminalOpen.get()).toBe(true);
    expect(app.ui.tasksOpen.get()).toBe(false);

    const hide = [...mounted.container.querySelectorAll('button')].find(
      (b) => (b.textContent ?? '').trim() === 'Hide',
    );
    click(hide);
    await Promise.resolve();
    flush();
    expect(app.ui.terminalOpen.get()).toBe(false);
    expect(app.ui.tasksOpen.get()).toBe(false);
  });
});

describe('in the shell', () => {
  /**
   * The point of the whole change: with a file open, showing tasks keeps the
   * editor on screen. Before, the tasks panel replaced it.
   */
  it('shows tasks beside the editor rather than instead of it', async () => {
    const app = new NoxApp(new MemoryPlatform());
    mounted = mountComponent(App, { app, props: { app } });
    mounted.platform.seedFile('/w/a.ts', 'const a = 1;');
    await app.workspace.openFolder('/w');
    const id = (await app.workspace.open('/w/a.ts'))!;
    app.workspace.setActive(id);
    await app.commands.execute('tasks.show');
    await Promise.resolve();
    flush();

    expect(mounted.container.querySelector('section[aria-label="Tasks"]')).not.toBeNull();
    expect(mounted.container.querySelector('[role="textbox"]')).not.toBeNull();
  });
});

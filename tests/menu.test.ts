import { describe, expect, it, vi } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import type { MenuNode, PlatformCapabilities } from '../src/platform/types';
import { COVERED_BY_SYSTEM_ITEMS, buildMenu, toAccelerator } from '../src/services/menu';

/**
 * The application menu.
 *
 * Nox shipped without one, which made the command palette the only index of
 * what the app can do — so a command with no keybinding and no button was
 * invisible unless you already knew its name, and 51 of them were.
 *
 * The property that matters, and the one these tests defend, is *coverage*:
 * the menu is derived from the command table rather than written out beside
 * it, so a command added later cannot quietly fail to appear.
 */

/** A platform that claims a menu bar, so the service actually installs one. */
class MenuBarPlatform extends MemoryPlatform {
  override readonly capabilities: PlatformCapabilities = {
    ...new MemoryPlatform().capabilities,
    applicationMenu: true,
  };
}

function walk(nodes: readonly MenuNode[], visit: (node: MenuNode) => void): void {
  for (const node of nodes) {
    visit(node);
    if (node.kind === 'submenu') walk(node.items, visit);
  }
}

function commandIds(nodes: readonly MenuNode[]): string[] {
  const ids: string[] = [];
  walk(nodes, (node) => {
    if (node.kind === 'command') ids.push(node.commandId);
  });
  return ids;
}

describe('what the menu contains', () => {
  /**
   * The failure this whole feature exists to prevent, stated as a test: a
   * command that no menu lists. It fails for a command given a brand-new
   * category as loudly as for one left out by hand, because an unclaimed
   * category gets its own trailing menu rather than being dropped.
   */
  it('lists every palette-visible command exactly once', () => {
    const app = new NoxApp(new MemoryPlatform());
    const menu = app.menu.describe();
    const listed = commandIds(menu);

    expect(new Set(listed).size).toBe(listed.length);

    const expected = app.commands
      .palette()
      .map((command) => command.id)
      .filter((id) => !COVERED_BY_SYSTEM_ITEMS.includes(id));
    expect([...listed].sort()).toEqual([...expected].sort());
  });

  /**
   * The failure this prevents: putting Undo, Redo and Select All in the menu
   * as Nox commands. Those dispatch against the editor, while the predefined
   * items go through the responder chain — so a Nox-command Undo bound to ⌘Z
   * would undo the *document* while the cursor sat in a search field.
   */
  it('leaves the responder-chain items to the system', () => {
    const app = new NoxApp(new MemoryPlatform());
    const menu = app.menu.describe();

    for (const id of COVERED_BY_SYSTEM_ITEMS) {
      expect(app.commands.has(id)).toBe(true);
      expect(commandIds(menu)).not.toContain(id);
    }

    const predefined: string[] = [];
    walk(menu, (node) => {
      if (node.kind === 'predefined') predefined.push(node.item);
    });
    expect(predefined).toEqual(
      expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'quit', 'about']),
    );
  });

  /** Hidden commands are hidden from the palette; a menu is no different. */
  it('omits hidden commands', () => {
    const app = new NoxApp(new MemoryPlatform());
    const listed = commandIds(app.menu.describe());
    expect(listed).not.toContain('view.dismiss');
    expect(listed).not.toContain('nav.goToTab');
  });

  /**
   * The failure this prevents: a command whose category nobody thought to add
   * to the layout silently disappearing — which is the exact class of bug the
   * menu is being built to fix.
   */
  it('gives a category no menu claims a menu of its own', () => {
    const menu = buildMenu(
      [
        { id: 'made.up', title: 'Made Up', category: 'Telemetry', run: () => {} },
        { id: 'file.save', title: 'Save', category: 'File', run: () => {} },
      ],
      () => undefined,
    );
    const stray = menu.find((node) => node.kind === 'submenu' && node.label === 'Telemetry');
    expect(stray).toBeDefined();
    expect(commandIds(menu)).toContain('made.up');
  });
});

describe('accelerators', () => {
  /**
   * The rule that makes double dispatch impossible: an accelerator is only
   * attached where Nox's own window-capture keymap claims the chord and calls
   * `preventDefault`, so the page always consumes the key first and the menu
   * item is never reached by a keypress. A chord owned by CodeMirror
   * (`keyHint`) is only prevented while the editor has focus, so it gets no
   * accelerator — otherwise ⌘⇧K would delete an editor line from inside the
   * search field.
   */
  it('are attached only to commands the application keymap claims', () => {
    const app = new NoxApp(new MemoryPlatform());
    const menu = app.menu.describe();

    const withAccelerator = new Map<string, string>();
    walk(menu, (node) => {
      if (node.kind === 'command' && node.accelerator) {
        withAccelerator.set(node.commandId, node.accelerator);
      }
    });

    expect(withAccelerator.get('file.save')).toBeDefined();
    for (const commandId of withAccelerator.keys()) {
      expect(app.keymap.chordFor(commandId)).toBeDefined();
    }

    // `edit.deleteLine` has a `keyHint` of Mod+Shift+K and no application
    // binding — exactly the case that must not get one.
    expect(app.keymap.chordFor('edit.deleteLine')).toBeUndefined();
    expect(withAccelerator.has('edit.deleteLine')).toBe(false);
  });

  /**
   * The chords Nox actually binds, in the form muda parses. Modifiers come out
   * in macOS's own ⌃⌥⇧⌘ order — muda accepts any order, but the order the
   * platform reads in is the one to emit.
   */
  it('translate the chord forms Nox uses', () => {
    expect(toAccelerator('meta+s')).toBe('Cmd+S');
    expect(toAccelerator('meta+shift+p')).toBe('Shift+Cmd+P');
    expect(toAccelerator('ctrl+alt+shift+meta+right')).toBe('Ctrl+Alt+Shift+Cmd+Right');
    expect(toAccelerator('meta+alt+[')).toBe('Alt+Cmd+[');
    expect(toAccelerator('ctrl+`')).toBe('Ctrl+`');
    expect(toAccelerator('meta+1')).toBe('Cmd+1');
    expect(toAccelerator('shift+f12')).toBe('Shift+F12');
    expect(toAccelerator('meta+,')).toBe('Cmd+,');
    // F12 and F2 are Nox's only unmodified bindings; both are menu-worthy.
    expect(toAccelerator('f12')).toBe('F12');
  });

  /**
   * The failure this prevents: showing a chord that does not work. An
   * unrecognised key would otherwise be dropped and leave a *weaker*
   * accelerator behind — `Cmd+` with no key, or a modifier-only chord that
   * claims a bare letter out of every text field in the window.
   */
  it('refuse anything they cannot translate faithfully', () => {
    expect(toAccelerator('meta+numpad5')).toBeUndefined();
    expect(toAccelerator('hyper+k')).toBeUndefined();
    // Unmodified, and typable — claiming these would eat them out of every
    // input in the window.
    expect(toAccelerator('escape')).toBeUndefined();
    expect(toAccelerator('k')).toBeUndefined();
    expect(toAccelerator('1')).toBeUndefined();
    expect(toAccelerator('meta+')).toBeUndefined();
  });

  /**
   * The failure this prevents: a menu that keeps announcing the factory chord
   * after the user has rebound it in the Keybindings panel.
   */
  it('follow a rebinding', async () => {
    const platform = new MenuBarPlatform();
    const app = new NoxApp(platform);
    await app.menu.start();

    const acceleratorFor = (id: string) => {
      let found: string | undefined;
      walk(platform.installedMenu ?? [], (node) => {
        if (node.kind === 'command' && node.commandId === id) found = node.accelerator;
      });
      return found;
    };

    expect(acceleratorFor('file.save')).toBe('Cmd+S');

    app.keymap.assign('file.save', 'Mod+Alt+S', { from: 'Mod+S' });
    await Promise.resolve();
    expect(acceleratorFor('file.save')).toBe('Alt+Cmd+S');

    app.menu.dispose();
  });
});

describe('choosing a menu item', () => {
  /**
   * The rule the menu rests on: an item is not a second implementation of
   * anything, it is the same dispatch the palette and the keymap use. Wiring
   * one straight to a service method is what this prevents.
   */
  it('dispatches through the command registry', async () => {
    const platform = new MenuBarPlatform();
    const app = new NoxApp(platform);
    await app.menu.start();

    const executed = vi.fn();
    app.commands.lastExecuted.subscribe((id) => {
      if (id) executed(id);
    });

    platform.chooseMenuItem('view.toggleExplorer');
    await Promise.resolve();

    expect(executed).toHaveBeenCalledWith('view.toggleExplorer');
    app.menu.dispose();
  });

  /**
   * The failure this prevents is the one the accelerator analysis leaves open:
   * a keypress the in-page keymap declined *because the command is disabled*
   * falls through to the menu item, which must then refuse it too. It does,
   * because it goes through `execute`, which checks enablement — so the menu
   * cannot run something the keyboard would not.
   */
  it('refuses a disabled command, exactly as a keypress would', async () => {
    const platform = new MenuBarPlatform();
    const app = new NoxApp(platform);
    await app.menu.start();

    // No folder is open, so `file.closeFolder` is disabled.
    expect(app.commands.isEnabled('file.closeFolder')).toBe(false);
    expect(await app.commands.execute('file.closeFolder')).toBe(false);

    const executed = vi.fn();
    app.commands.lastExecuted.subscribe((id) => {
      if (id) executed(id);
    });

    platform.chooseMenuItem('file.closeFolder');
    await Promise.resolve();

    expect(executed).not.toHaveBeenCalled();
    app.menu.dispose();
  });

  /** A listener that outlives the app would keep dispatching into a dead one. */
  it('stops listening when the app is disposed', async () => {
    const platform = new MenuBarPlatform();
    const app = new NoxApp(platform);
    await app.menu.start();
    app.menu.dispose();

    const executed = vi.fn();
    app.commands.lastExecuted.subscribe((id) => {
      if (id) executed(id);
    });

    platform.chooseMenuItem('view.toggleExplorer');
    await Promise.resolve();

    expect(executed).not.toHaveBeenCalled();
  });
});

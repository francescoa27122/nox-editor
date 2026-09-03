import { describe, expect, it, vi } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import { platformIsMac } from '../src/services/keymap';
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

/**
 * `MemoryPlatform` reports `applicationMenu: false`, and since `describe()`
 * became platform-dependent that means "the tree Nox draws itself". Tests
 * about the *macOS* tree — the one that defers to the responder chain — have
 * to ask for a platform that claims it.
 */
class SystemMenuPlatform extends MemoryPlatform {
  constructor() {
    super();
    (this.capabilities as { applicationMenu: boolean }).applicationMenu = true;
  }
}

describe('what the menu contains', () => {
  /**
   * The failure this whole feature exists to prevent, stated as a test: a
   * command that no menu lists. It fails for a command given a brand-new
   * category as loudly as for one left out by hand, because an unclaimed
   * category gets its own trailing menu rather than being dropped.
   */
  it('lists every palette-visible command exactly once', () => {
    const app = new NoxApp(new SystemMenuPlatform());
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
   * The failure this prevents, found in a UI walk on 2026-08-23: eleven
   * explorer commands — Rename…, Delete…, Duplicate, Copy Path among them —
   * sat at the bottom of the **View** menu, because the explorer is a view.
   * That is a fact about the widget, not about what the commands do, and View
   * is not where anyone looks to rename a file.
   *
   * Stated as menus rather than as categories so it keeps holding if the
   * categories are reorganised again.
   */
  it('files explorer operations under File, and only tree operations under View', () => {
    const app = new NoxApp(new SystemMenuPlatform());
    const menuFor = (label: string) => {
      const node = app.menu
        .describe()
        .find((n): n is Extract<MenuNode, { kind: 'submenu' }> =>
          n.kind === 'submenu' && n.label === label,
        );
      if (!node) throw new Error(`no ${label} menu`);
      return commandIds(node.items);
    };

    const file = menuFor('File');
    for (const id of [
      'explorer.rename',
      'explorer.delete',
      'explorer.duplicate',
      'explorer.copyPath',
      'explorer.copyRelativePath',
    ]) {
      expect(file).toContain(id);
    }

    // The three that genuinely act on the tree rather than on a file.
    const view = menuFor('View');
    expect(view).toContain('explorer.refresh');
    expect(view).toContain('explorer.collapseAll');
    expect(view).toContain('explorer.selectAll');
    expect(view).not.toContain('explorer.delete');
    expect(view).not.toContain('explorer.rename');
  });

  /**
   * The failure this prevents, from the 2026-09 audit (A1-008): two New
   * File / New Folder pairs in the File menu, resolving their folder by
   * different rules that neither title stated. The explorer pair is the
   * context menu's, dispatched by id with the clicked path, and stays a
   * command; the menu lists the File pair only.
   */
  it('lists one New File and one New Folder, not the explorer pair as well', () => {
    const app = new NoxApp(new SystemMenuPlatform());
    const listed = commandIds(app.menu.describe());

    expect(listed).toContain('file.newInFolder');
    expect(listed).toContain('file.newFolder');
    expect(listed).not.toContain('explorer.newFile');
    expect(listed).not.toContain('explorer.newFolder');
    // Still registered and still dispatchable: the explorer's context menu
    // depends on both.
    expect(app.commands.has('explorer.newFile')).toBe(true);
    expect(app.commands.has('explorer.newFolder')).toBe(true);
  });

  /**
   * The failure this prevents: putting Undo, Redo and Select All in the menu
   * as Nox commands. Those dispatch against the editor, while the predefined
   * items go through the responder chain — so a Nox-command Undo bound to ⌘Z
   * would undo the *document* while the cursor sat in a search field.
   */
  it('leaves the responder-chain items to the system', () => {
    const app = new NoxApp(new SystemMenuPlatform());
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

  /**
   * The same tree, for a platform with no responder chain to defer to.
   *
   * `COVERED_BY_SYSTEM_ITEMS` is not a list of commands a menu should never
   * show — it is a list of commands *macOS already shows for us*. Windows and
   * Linux have no such items, so leaving them out there would mean Undo and
   * Select All appearing in no menu at all.
   */
  it('claims the responder-chain items itself where there is no responder chain', () => {
    const app = new NoxApp(new MemoryPlatform());
    const menu = buildMenu(app.commands.all(), () => undefined, { systemItems: false });

    for (const id of COVERED_BY_SYSTEM_ITEMS) {
      expect(commandIds(menu), id).toContain(id);
    }
  });

  /**
   * The failure this prevents: a hand-drawn menu rendering a node it cannot
   * act on. A `predefined` item names something only the OS can perform, so
   * on a platform drawing its own menu it would be a row that does nothing.
   */
  it('emits nothing predefined where there is no system to hand it to', () => {
    const app = new NoxApp(new MemoryPlatform());
    const menu = buildMenu(app.commands.all(), () => undefined, { systemItems: false });

    const predefined: string[] = [];
    walk(menu, (node) => {
      if (node.kind === 'predefined') predefined.push(node.item);
    });
    expect(predefined).toEqual([]);
  });

  /** Still exactly once each — the guarantee does not weaken off macOS. */
  it('lists every palette-visible command exactly once without system items', () => {
    const app = new NoxApp(new MemoryPlatform());
    const listed = commandIds(buildMenu(app.commands.all(), () => undefined, { systemItems: false }));

    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...app.commands.palette().map((c) => c.id)].sort());
  });

  /**
   * The failure this prevents: rules left behind by the items they framed.
   * `LAYOUT` writes `leading: [predefined('about'), separator]` and
   * `trailing: [separator, predefined('fullscreen')]`, so dropping the
   * predefined nodes without collapsing the separators leaves a menu opening
   * or closing on a horizontal rule — and two adjacent rules wherever one sat
   * between two dropped items.
   */
  it('leaves no rule stranded when the system items go', () => {
    const app = new NoxApp(new MemoryPlatform());
    const menu = buildMenu(app.commands.all(), () => undefined, { systemItems: false });

    walk(menu, (node) => {
      if (node.kind !== 'submenu') return;
      const items = node.items;
      expect(items.length, `${node.label} is empty`).toBeGreaterThan(0);
      expect(items[0]!.kind, `${node.label} opens on a rule`).not.toBe('separator');
      expect(items[items.length - 1]!.kind, `${node.label} ends on a rule`).not.toBe('separator');
      for (let i = 1; i < items.length; i++) {
        const doubled = items[i]!.kind === 'separator' && items[i - 1]!.kind === 'separator';
        expect(doubled, `${node.label} has two rules in a row`).toBe(false);
      }
    });
  });

  /**
   * The failure this prevents, found by the 2026-09 audit (A1-003): the
   * drawn menu dropped every predefined item and put nothing in its place,
   * so a Windows or Linux user had no Cut, Copy or Paste under Edit, no About
   * or Exit under Nox, and no Full Screen under View. Those are Nox commands
   * now, and off macOS the menu has to list them where the system items
   * would have been.
   */
  it('lists the commands behind the system items where there is no system', () => {
    const app = new NoxApp(new MemoryPlatform());
    const menuFor = (label: string) => {
      const node = app.menu
        .describe()
        .find((n): n is Extract<MenuNode, { kind: 'submenu' }> =>
          n.kind === 'submenu' && n.label === label,
        );
      if (!node) throw new Error(`no ${label} menu`);
      return commandIds(node.items);
    };

    expect(menuFor('Edit')).toEqual(expect.arrayContaining(['edit.cut', 'edit.copy', 'edit.paste']));
    expect(menuFor('Nox')).toEqual(expect.arrayContaining(['app.about', 'app.quit']));
    expect(menuFor('View')).toContain('view.toggleFullscreen');
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

    // `Mod` is the one chord token whose meaning depends on the host — it
    // resolves to meta on macOS and ctrl everywhere else — and `file.save`'s
    // default really is `Mod+S`, so these two expectations cannot be one
    // literal. Hardcoding the macOS resolution is what turned this test red on
    // every non-macOS CI runner while passing locally: this file runs under
    // the node environment, where Node reports the *real* host in
    // `navigator.platform`, so on a Mac it read `Cmd+S` and agreed with itself.
    //
    // Note the two are not a prefix swap: `toAccelerator` orders modifiers
    // ctrl, alt, shift, meta, so meta lands after alt and ctrl lands before it.
    expect(acceleratorFor('file.save')).toBe(platformIsMac ? 'Cmd+S' : 'Ctrl+S');

    app.keymap.assign('file.save', 'Mod+Alt+S', { from: 'Mod+S' });
    await Promise.resolve();
    expect(acceleratorFor('file.save')).toBe(platformIsMac ? 'Alt+Cmd+S' : 'Ctrl+Alt+S');

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

import { describe, expect, it } from 'vitest';
import { CommandRegistry } from '../src/services/commands';
import { KeymapService, normalizeChord } from '../src/services/keymap';
import { MemoryPlatform } from '../src/platform/memory';

/**
 * The user layer over the default keymap — see
 * `docs/superpowers/specs/2026-08-20-keybinding-editor-design.md` §1-§3.
 *
 * Everything here drives the service directly; the panel that writes these
 * rules has its own suite. `resolve()` is the assertion of record wherever
 * one is available, because "the map contains a binding" and "the key runs
 * the command" are different claims and only the second one matters.
 *
 * Mutation checks (each made the named test red, then reverted):
 * - `#rebuild` replaying every default instead of skipping removed pairs →
 *   "a remove rule unbinds the default".
 * - additions applied before defaults rather than after →
 *   "an addition wins over a default on the same chord".
 * - `#rebuild`'s inherited-`arg` lookup returning `undefined` instead of the
 *   command's first default → "an addition inherits arg from the command's
 *   first default".
 * - `beginCapture` leaving `resolve()` in the handler's path →
 *   "no command runs while capturing".
 */

/** Minimal stand-in for a KeyboardEvent; only the fields the keymap reads. */
function keyEvent(init: {
  code: string;
  key?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}): KeyboardEvent {
  return {
    code: init.code,
    key: init.key ?? '',
    ctrlKey: init.ctrl ?? false,
    altKey: init.alt ?? false,
    shiftKey: init.shift ?? false,
    metaKey: init.meta ?? false,
    repeat: false,
    isComposing: false,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as KeyboardEvent;
}

function setup() {
  const platform = new MemoryPlatform();
  const commands = new CommandRegistry();
  const keymap = new KeymapService(commands, platform);
  commands.register({ id: 'file.save', title: 'Save File', category: 'File', run: () => {} });
  commands.register({ id: 'file.open', title: 'Open File…', category: 'File', run: () => {} });
  commands.register({ id: 'nav.goToTab', title: 'Go to Tab', hidden: true, run: () => {} });
  keymap.bind('Ctrl+S', 'file.save');
  keymap.bind('Ctrl+O', 'file.open');
  for (let i = 0; i < 3; i++) keymap.bind(`Ctrl+${i + 1}`, 'nav.goToTab', { arg: i });
  return { platform, commands, keymap };
}

describe('user keybinding rules', () => {
  it('an addition binds a new chord to the command', () => {
    const { keymap } = setup();
    keymap.setUserRules([{ chord: 'ctrl+alt+s', command: 'file.save' }]);

    expect(keymap.resolve(keyEvent({ code: 'KeyS', ctrl: true, alt: true }))).toBe('file.save');
  });

  it('a remove rule unbinds the default, and the key falls through', () => {
    const { keymap } = setup();
    keymap.setUserRules([{ chord: 'ctrl+s', command: 'file.save', remove: true }]);

    expect(keymap.resolve(keyEvent({ code: 'KeyS', ctrl: true }))).toBeNull();
  });

  it('a rebind is a remove plus an addition, and the old chord goes quiet', () => {
    const { keymap } = setup();
    keymap.setUserRules([
      { chord: 'ctrl+s', command: 'file.save', remove: true },
      { chord: 'ctrl+alt+s', command: 'file.save' },
    ]);

    expect(keymap.resolve(keyEvent({ code: 'KeyS', ctrl: true }))).toBeNull();
    expect(keymap.resolve(keyEvent({ code: 'KeyS', ctrl: true, alt: true }))).toBe('file.save');
  });

  it('an addition wins over a default on the same chord', () => {
    const { keymap } = setup();
    keymap.setUserRules([{ chord: 'ctrl+s', command: 'file.open' }]);

    expect(keymap.resolve(keyEvent({ code: 'KeyS', ctrl: true }))).toBe('file.open');
  });

  it("an addition inherits arg from the command's first default", () => {
    const { keymap } = setup();
    keymap.setUserRules([{ chord: 'ctrl+alt+1', command: 'nav.goToTab' }]);

    const binding = keymap
      .lookup('ctrl+alt+1')
      .find((b) => b.commandId === 'nav.goToTab');
    expect(binding?.arg).toBe(0);
  });

  it('a rule may carry its own arg, which beats the inherited one', () => {
    const { keymap } = setup();
    keymap.setUserRules([{ chord: 'ctrl+alt+1', command: 'nav.goToTab', arg: 2 }]);

    expect(keymap.lookup('ctrl+alt+1')[0]?.arg).toBe(2);
  });

  it("an addition inherits the default's guard, so a false guard still falls through", () => {
    const platform = new MemoryPlatform();
    const commands = new CommandRegistry();
    const keymap = new KeymapService(commands, platform);
    commands.register({ id: 'view.dismiss', title: 'Dismiss', run: () => {} });
    keymap.bind('Escape', 'view.dismiss', { when: () => false });

    keymap.setUserRules([{ chord: 'ctrl+alt+d', command: 'view.dismiss' }]);

    expect(keymap.resolve(keyEvent({ code: 'KeyD', ctrl: true, alt: true }))).toBeNull();
  });

  it('normalises a hand-written chord, so Cmd+Shift+P and meta+shift+p are one rule', () => {
    const { keymap } = setup();
    keymap.setUserRules([{ chord: 'Control+Alt+S', command: 'file.save' }]);

    expect(keymap.userRules()[0]!.chord).toBe(normalizeChord('ctrl+alt+s'));
    expect(keymap.resolve(keyEvent({ code: 'KeyS', ctrl: true, alt: true }))).toBe('file.save');
  });

  it('resetting the rules restores every default', () => {
    const { keymap } = setup();
    keymap.setUserRules([
      { chord: 'ctrl+s', command: 'file.save', remove: true },
      { chord: 'ctrl+alt+s', command: 'file.save' },
    ]);
    keymap.setUserRules([]);

    expect(keymap.resolve(keyEvent({ code: 'KeyS', ctrl: true }))).toBe('file.save');
    expect(keymap.resolve(keyEvent({ code: 'KeyS', ctrl: true, alt: true }))).toBeNull();
  });

  it('bumps its version once per rebuild, not once per replayed default', () => {
    const { keymap } = setup();
    const before = keymap.version.get();
    keymap.setUserRules([{ chord: 'ctrl+alt+s', command: 'file.save' }]);

    expect(keymap.version.get()).toBe(before + 1);
  });
});

describe('the panel-facing helpers', () => {
  it('assign() rebinds: the old chord is removed and the new one added', () => {
    const { keymap } = setup();
    keymap.assign('file.save', 'ctrl+alt+s', { from: 'ctrl+s' });

    expect(keymap.resolve(keyEvent({ code: 'KeyS', ctrl: true }))).toBeNull();
    expect(keymap.resolve(keyEvent({ code: 'KeyS', ctrl: true, alt: true }))).toBe('file.save');
    expect(keymap.isCustomized('file.save')).toBe(true);
  });

  it('assign() with no `from` adds a second chord and keeps the first', () => {
    const { keymap } = setup();
    keymap.assign('file.save', 'ctrl+alt+s');

    expect(keymap.resolve(keyEvent({ code: 'KeyS', ctrl: true }))).toBe('file.save');
    expect(keymap.resolve(keyEvent({ code: 'KeyS', ctrl: true, alt: true }))).toBe('file.save');
  });

  it("unassign() clears a binding without touching the command's others", () => {
    const { keymap } = setup();
    keymap.assign('file.save', 'ctrl+alt+s');
    keymap.unassign('file.save', 'ctrl+s');

    expect(keymap.resolve(keyEvent({ code: 'KeyS', ctrl: true }))).toBeNull();
    expect(keymap.resolve(keyEvent({ code: 'KeyS', ctrl: true, alt: true }))).toBe('file.save');
  });

  it('re-assigning the same command twice leaves one addition, not two', () => {
    const { keymap } = setup();
    keymap.assign('file.save', 'ctrl+alt+s', { from: 'ctrl+s' });
    keymap.assign('file.save', 'ctrl+alt+w', { from: 'ctrl+alt+s' });

    expect(keymap.userRules().filter((r) => !r.remove)).toHaveLength(1);
    expect(keymap.resolve(keyEvent({ code: 'KeyW', ctrl: true, alt: true }))).toBe('file.save');
    expect(keymap.resolve(keyEvent({ code: 'KeyS', ctrl: true, alt: true }))).toBeNull();
  });

  it('resetCommand() drops every rule naming that command and no others', () => {
    const { keymap } = setup();
    keymap.assign('file.save', 'ctrl+alt+s', { from: 'ctrl+s' });
    keymap.assign('file.open', 'ctrl+alt+o', { from: 'ctrl+o' });
    keymap.resetCommand('file.save');

    expect(keymap.isCustomized('file.save')).toBe(false);
    expect(keymap.isCustomized('file.open')).toBe(true);
    expect(keymap.resolve(keyEvent({ code: 'KeyS', ctrl: true }))).toBe('file.save');
    expect(keymap.resolve(keyEvent({ code: 'KeyO', ctrl: true, alt: true }))).toBe('file.open');
  });

  it('conflictsFor() names the binding a chord would displace, and ignores the same command', () => {
    const { keymap } = setup();

    expect(keymap.conflictsFor('ctrl+o', 'file.save').map((b) => b.commandId)).toEqual([
      'file.open',
    ]);
    expect(keymap.conflictsFor('ctrl+s', 'file.save')).toEqual([]);
    expect(keymap.conflictsFor('ctrl+alt+z', 'file.save')).toEqual([]);
  });
});

describe('persistence', () => {
  it('round-trips through the config file', async () => {
    const { keymap, platform } = setup();
    keymap.assign('file.save', 'ctrl+alt+s', { from: 'ctrl+s' });
    await keymap.flush();

    const reborn = new KeymapService(new CommandRegistry(), platform);
    reborn.bind('Ctrl+S', 'file.save');
    await reborn.loadUserRules();

    expect(reborn.userRules()).toEqual(keymap.userRules());
  });

  it('writes nothing but an empty file once the rules are reset', async () => {
    const { keymap, platform } = setup();
    keymap.assign('file.save', 'ctrl+alt+s', { from: 'ctrl+s' });
    await keymap.flush();
    keymap.resetAll();
    await keymap.flush();

    expect(await platform.readConfigFile('keybindings.json')).toBe('');
  });

  it('a corrupt file leaves the defaults standing', async () => {
    const { keymap, platform } = setup();
    await platform.writeConfigFile('keybindings.json', '{ not json');
    await keymap.loadUserRules();

    expect(keymap.userRules()).toEqual([]);
    expect(keymap.resolve(keyEvent({ code: 'KeyS', ctrl: true }))).toBe('file.save');
  });

  it('drops rules that are not shaped like rules, and keeps the ones that are', async () => {
    const { keymap, platform } = setup();
    await platform.writeConfigFile(
      'keybindings.json',
      JSON.stringify([{ chord: 'ctrl+alt+s', command: 'file.save' }, 7, { chord: 'ctrl+q' }, null]),
    );
    await keymap.loadUserRules();

    expect(keymap.userRules()).toEqual([{ chord: 'ctrl+alt+s', command: 'file.save' }]);
    expect(keymap.resolve(keyEvent({ code: 'KeyS', ctrl: true, alt: true }))).toBe('file.save');
  });
});

describe('capture', () => {
  it('hands every chord to the handler while capturing', () => {
    const { keymap } = setup();
    const seen: string[] = [];
    keymap.beginCapture((chord) => seen.push(chord));

    keymap.handleKey(keyEvent({ code: 'KeyS', ctrl: true }));
    keymap.handleKey(keyEvent({ code: 'F5' }));

    expect(seen).toEqual(['ctrl+s', 'f5']);
  });

  it('no command runs while capturing', async () => {
    const { commands, keymap } = setup();
    let ran = 0;
    commands.register({ id: 'test.counter', title: 'Counter', run: () => void ran++ });
    keymap.bind('Ctrl+S', 'test.counter');
    keymap.beginCapture(() => {});

    keymap.handleKey(keyEvent({ code: 'KeyS', ctrl: true }));
    await Promise.resolve();

    expect(ran).toBe(0);
  });

  it('ignores a bare modifier, so holding shift first records nothing', () => {
    const { keymap } = setup();
    const seen: string[] = [];
    keymap.beginCapture((chord) => seen.push(chord));

    keymap.handleKey(keyEvent({ code: 'ShiftLeft', key: 'Shift', shift: true }));
    keymap.handleKey(keyEvent({ code: 'MetaLeft', key: 'Meta', meta: true }));
    keymap.handleKey(keyEvent({ code: 'KeyS', ctrl: true, shift: true }));

    expect(seen).toEqual(['ctrl+shift+s']);
  });

  it('endCapture() gives the keys back', async () => {
    const { commands, keymap } = setup();
    let ran = 0;
    commands.register({ id: 'test.counter', title: 'Counter', run: () => void ran++ });
    keymap.bind('Ctrl+S', 'test.counter');
    keymap.beginCapture(() => {});
    keymap.endCapture();

    keymap.handleKey(keyEvent({ code: 'KeyS', ctrl: true }));
    await Promise.resolve();

    expect(ran).toBe(1);
  });
});

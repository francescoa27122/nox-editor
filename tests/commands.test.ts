import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry } from '../src/services/commands';
import { KeymapService, chordFromEvent, formatChord, normalizeChord } from '../src/services/keymap';

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

describe('CommandRegistry', () => {
  it('registers and executes', async () => {
    const registry = new CommandRegistry();
    const run = vi.fn();
    registry.register({ id: 'test.run', title: 'Run', run });

    expect(await registry.execute('test.run')).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('passes the argument through', async () => {
    const registry = new CommandRegistry();
    const run = vi.fn();
    registry.register({ id: 'test.arg', title: 'Arg', run });

    await registry.execute('test.arg', 42);
    expect(run).toHaveBeenCalledWith(42);
  });

  it('returns false for an unknown command', async () => {
    const registry = new CommandRegistry();
    expect(await registry.execute('nope')).toBe(false);
  });

  it('will not execute a disabled command', async () => {
    const registry = new CommandRegistry();
    const run = vi.fn();
    registry.register({ id: 'test.off', title: 'Off', enabled: () => false, run });

    expect(await registry.execute('test.off')).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects a duplicate id', () => {
    const registry = new CommandRegistry();
    registry.register({ id: 'dup', title: 'A', run: () => {} });
    expect(() => registry.register({ id: 'dup', title: 'B', run: () => {} })).toThrow();
  });

  it('unregisters via the returned disposer', () => {
    const registry = new CommandRegistry();
    const dispose = registry.register({ id: 'temp', title: 'Temp', run: () => {} });
    expect(registry.has('temp')).toBe(true);
    dispose();
    expect(registry.has('temp')).toBe(false);
  });

  it('excludes hidden commands from the palette', () => {
    const registry = new CommandRegistry();
    registry.register({ id: 'shown', title: 'Shown', run: () => {} });
    registry.register({ id: 'hidden', title: 'Hidden', hidden: true, run: () => {} });

    expect(registry.palette().map((c) => c.id)).toEqual(['shown']);
  });

  it('bumps the version when the set changes', () => {
    const registry = new CommandRegistry();
    const before = registry.version.get();
    registry.register({ id: 'x', title: 'X', run: () => {} });
    expect(registry.version.get()).toBeGreaterThan(before);
  });
});

describe('chord parsing', () => {
  it('orders modifiers canonically', () => {
    expect(normalizeChord('Shift+Ctrl+P')).toBe('ctrl+shift+p');
  });

  it('accepts aliases', () => {
    expect(normalizeChord('Cmd+Esc')).toBe('meta+escape');
    expect(normalizeChord('Option+ArrowUp')).toBe('alt+up');
  });

  it('lowercases the key', () => {
    expect(normalizeChord('Ctrl+G')).toBe('ctrl+g');
  });

  it('resolves mod to one concrete modifier', () => {
    const chord = normalizeChord('Mod+S');
    expect(chord === 'meta+s' || chord === 'ctrl+s').toBe(true);
  });
});

describe('chordFromEvent', () => {
  it('reads letters from the physical code', () => {
    expect(chordFromEvent(keyEvent({ code: 'KeyP', meta: true, shift: true }))).toBe(
      'shift+meta+p',
    );
  });

  it('reads digits from the physical code', () => {
    expect(chordFromEvent(keyEvent({ code: 'Digit1', meta: true }))).toBe('meta+1');
  });

  it('names special keys', () => {
    expect(chordFromEvent(keyEvent({ code: 'Escape' }))).toBe('escape');
    expect(chordFromEvent(keyEvent({ code: 'ArrowDown', alt: true }))).toBe('alt+down');
  });

  it('maps punctuation codes to their characters', () => {
    expect(chordFromEvent(keyEvent({ code: 'Comma', meta: true }))).toBe('meta+,');
  });
});

describe('formatChord', () => {
  it('produces a readable label', () => {
    const label = formatChord('meta+shift+p');
    expect(label.endsWith('P')).toBe(true);
    expect(label.length).toBeGreaterThan(1);
  });

  it('symbolises named keys', () => {
    expect(formatChord('escape')).toBe('Esc');
  });
});

describe('KeymapService', () => {
  function setup() {
    const commands = new CommandRegistry();
    const keymap = new KeymapService(commands);
    return { commands, keymap };
  }

  it('resolves a bound chord to its command', () => {
    const { commands, keymap } = setup();
    commands.register({ id: 'app.save', title: 'Save', run: () => {} });
    keymap.bind('Ctrl+S', 'app.save');

    expect(keymap.resolve(keyEvent({ code: 'KeyS', ctrl: true }))).toBe('app.save');
  });

  it('returns null for an unbound chord', () => {
    const { keymap } = setup();
    expect(keymap.resolve(keyEvent({ code: 'KeyQ' }))).toBeNull();
  });

  it('skips a binding whose command is disabled', () => {
    const { commands, keymap } = setup();
    commands.register({ id: 'app.off', title: 'Off', enabled: () => false, run: () => {} });
    keymap.bind('Ctrl+S', 'app.off');

    expect(keymap.resolve(keyEvent({ code: 'KeyS', ctrl: true }))).toBeNull();
  });

  it('skips a binding whose guard is false', () => {
    const { commands, keymap } = setup();
    commands.register({ id: 'app.guarded', title: 'Guarded', run: () => {} });
    keymap.bind('Escape', 'app.guarded', { when: () => false });

    expect(keymap.resolve(keyEvent({ code: 'Escape' }))).toBeNull();
  });

  it('prefers the most recent binding for a chord', () => {
    const { commands, keymap } = setup();
    commands.register({ id: 'first', title: 'First', run: () => {} });
    commands.register({ id: 'second', title: 'Second', run: () => {} });
    keymap.bind('Ctrl+K', 'first');
    keymap.bind('Ctrl+K', 'second');

    expect(keymap.resolve(keyEvent({ code: 'KeyK', ctrl: true }))).toBe('second');
  });

  it('falls back to an earlier binding when the newest is guarded off', () => {
    const { commands, keymap } = setup();
    commands.register({ id: 'fallback', title: 'Fallback', run: () => {} });
    commands.register({ id: 'primary', title: 'Primary', run: () => {} });
    keymap.bind('Escape', 'fallback');
    keymap.bind('Escape', 'primary', { when: () => false });

    expect(keymap.resolve(keyEvent({ code: 'Escape' }))).toBe('fallback');
  });

  it('reports a display string for the primary binding', () => {
    const { commands, keymap } = setup();
    commands.register({ id: 'app.find', title: 'Find', run: () => {} });
    keymap.bind('Mod+F', 'app.find');

    expect(keymap.displayFor('app.find')).toBeTruthy();
    expect(keymap.displayFor('app.missing')).toBeUndefined();
  });

  it('unbinds', () => {
    const { commands, keymap } = setup();
    commands.register({ id: 'app.x', title: 'X', run: () => {} });
    keymap.bind('Ctrl+X', 'app.x');
    keymap.unbind('Ctrl+X');

    expect(keymap.resolve(keyEvent({ code: 'KeyX', ctrl: true }))).toBeNull();
    expect(keymap.displayFor('app.x')).toBeUndefined();
  });
});

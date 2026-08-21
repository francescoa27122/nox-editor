import { describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import { platformIsMac } from '../src/services/keymap';

/**
 * The default chords, asserted against the real table rather than a synthetic
 * one.
 *
 * Worth its own suite because of how the defaults are written: an object
 * literal, where a chord typed twice is **silently collapsed by JavaScript**
 * before anything can complain. Binding a new command to a chord that is
 * already taken does not fail, or warn — it just quietly removes whatever was
 * there. `resolve()` is the assertion of record here, matching
 * `keymap-user-bindings.test.ts`: "the map holds a binding" and "the key runs
 * the command" are different claims, and only the second matters.
 */

/** Only the fields the keymap reads. Letters come from `code`, never `key`. */
function keyEvent(init: { code: string; alt?: boolean; shift?: boolean }): KeyboardEvent {
  return {
    code: init.code,
    key: '',
    // `mod` is ⌘ on macOS and Ctrl elsewhere, so the test has to pick the
    // same one the table did.
    ctrlKey: !platformIsMac,
    metaKey: platformIsMac,
    altKey: init.alt ?? false,
    shiftKey: init.shift ?? false,
    repeat: false,
    isComposing: false,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as KeyboardEvent;
}

/**
 * `resolve()` skips a command whose `enabled` says no, so a chord's behaviour
 * depends on the state around it. `notes.open` wants at least one note.
 */
function keymapWith(noteCount: number) {
  const app = new NoxApp(new MemoryPlatform());
  for (let i = 0; i < noteCount; i++) app.notes.create();
  return app.keymap;
}

describe('the notes chords', () => {
  it('opens the note picker on Mod+Alt+N', () => {
    expect(keymapWith(1).resolve(keyEvent({ code: 'KeyN', alt: true }))).toBe('notes.open');
  });

  /**
   * A picker over nothing is worse than no picker — it opens an empty box
   * over the file you were reading. The chord is inert until there is a note
   * to pick, which falls out of the command's own `enabled` rather than
   * needing anything here.
   */
  it('is inert until there is a note to pick', () => {
    expect(keymapWith(0).resolve(keyEvent({ code: 'KeyN', alt: true }))).toBeNull();
  });

  /**
   * The failure this prevents: the picker's chord being written as
   * `Mod+Shift+N`, which is already the panel's. In an object literal that is
   * not an error — the second entry wins and the panel simply stops having a
   * chord, with nothing anywhere to say so.
   */
  it('still shows the notes panel on Mod+Shift+N', () => {
    expect(keymapWith(1).resolve(keyEvent({ code: 'KeyN', shift: true }))).toBe('notes.focus');
  });

  /**
   * `Mod+Alt+N` is reachable on a Mac even though ⌥N is a dead key there
   * (it begins a tilde). The keymap reads `event.code`, never `event.key`,
   * precisely so a chord under Alt does not depend on the layout.
   */
  it('matches on the physical key, not the character Alt would produce', () => {
    const deadKey = keyEvent({ code: 'KeyN', alt: true });
    // What a Mac actually reports for ⌥N: the code is KeyN, the key is not.
    (deadKey as { key: string }).key = 'Dead';

    expect(keymapWith(1).resolve(deadKey)).toBe('notes.open');
  });
});

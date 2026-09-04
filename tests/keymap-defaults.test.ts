import type { EditorView } from '@codemirror/view';
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

/** A key event with the modifiers written out, rather than through `Mod`. */
function rawKey(init: {
  code: string;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
}): KeyboardEvent {
  return {
    code: init.code,
    key: '',
    ctrlKey: init.ctrl ?? false,
    metaKey: init.meta ?? false,
    altKey: init.alt ?? false,
    shiftKey: init.shift ?? false,
    repeat: false,
    isComposing: false,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as KeyboardEvent;
}

/**
 * `resolve()` skips a command whose `enabled` says no, and every chord in the
 * Go to Line group is an editor command: `#hasEditor` asks only whether a view
 * has been registered. Nothing below looks at the view, so a stub is enough
 * and this suite stays in Node. `setView` also hands the view to the find
 * controller, which dispatches the empty query into it, so `dispatch` has to
 * exist even though nothing reads what goes through it.
 */
function keymapWithEditor() {
  const app = new NoxApp(new MemoryPlatform());
  app.setView({ dispatch: () => {} } as unknown as EditorView);
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

/**
 * A1-007: Go to Line is `Ctrl+G`, and it is the same chord on every platform.
 *
 * Off macOS it used to be `Alt+G`, which is Nox's own invention and appears in
 * no other editor. The reason was that `Mod+G` had already taken `Ctrl+G`
 * there for Find Next, which is the macOS `⌘G` convention carried across by
 * the `Mod` prefix rather than anything Windows or Linux does.
 *
 * These are written with explicit modifiers rather than through `Mod`,
 * because the whole point is that the two platforms now differ: `Mod` would
 * hide exactly the difference under test.
 */
describe('the Go to Line chord', () => {
  it('runs Go to Line on Ctrl+G, on every platform', () => {
    expect(keymapWithEditor().resolve(rawKey({ code: 'KeyG', ctrl: true }))).toBe('nav.goToLine');
  });

  /**
   * Find Next is not left unbound anywhere. `F3` was already beside `Mod+G`
   * in the table and is the Windows and Linux chord for it, with `Shift+F3`
   * the Find Previous half; on macOS `⌘G` keeps it as well.
   */
  it('leaves Find Next on F3 everywhere, and on Cmd+G on macOS', () => {
    const keymap = keymapWithEditor();

    expect(keymap.resolve(rawKey({ code: 'F3' }))).toBe('edit.findNext');
    expect(keymap.resolve(rawKey({ code: 'F3', shift: true }))).toBe('edit.findPrevious');
    expect(keymap.resolve(rawKey({ code: 'KeyG', meta: true }))).toBe(
      platformIsMac ? 'edit.findNext' : null,
    );
  });

  /**
   * The macOS half of the swap is that there is no swap: ⌃G was already Go to
   * Line and ⌘G was already Find Next, and they are separate chords there.
   * Asserted rather than assumed, because the change is one `platformIsMac`
   * away from moving a Mac binding by accident.
   */
  it('changes nothing on macOS', () => {
    if (!platformIsMac) return;
    const keymap = keymapWithEditor();

    expect(keymap.resolve(rawKey({ code: 'KeyG', ctrl: true }))).toBe('nav.goToLine');
    expect(keymap.resolve(rawKey({ code: 'KeyG', meta: true }))).toBe('edit.findNext');
  });

  /** And ⌥G is given back off macOS rather than left as a second route in. */
  it('no longer answers Alt+G off macOS', () => {
    if (platformIsMac) return;
    expect(keymapWithEditor().resolve(rawKey({ code: 'KeyG', alt: true }))).toBeNull();
  });
});

/**
 * No chord in the default table runs two different commands.
 *
 * The suite header says why an object literal cannot be trusted here: a chord
 * typed twice is silently collapsed. `bind()` is the other half of that, and
 * it does not collapse, it *stacks*: two defaults on one chord both stay in
 * the table and `resolve()` returns whichever passes its `enabled` check
 * first, which is a race decided by registration order and by what happens to
 * be open. Neither is a thing anyone would have chosen.
 *
 * Several chords deliberately share a command (`Mod+K` and `Mod+Shift+P` are
 * both the palette; `F3` and, on macOS, `⌘G` are both Find Next). That is
 * fine and is not what this looks at: it is one chord, two commands.
 *
 * Verified: putting `edit.findNext` back on `Mod+G` unconditionally, which is
 * exactly what A1-007 removed, fails this off macOS.
 */
describe('the default table', () => {
  it('never gives one chord to two commands', () => {
    const app = new NoxApp(new MemoryPlatform());
    const byChord = new Map<string, Set<string>>();
    for (const binding of app.keymap.defaults()) {
      const claimed = byChord.get(binding.chord) ?? new Set<string>();
      claimed.add(binding.commandId);
      byChord.set(binding.chord, claimed);
    }

    const contested = [...byChord]
      .filter(([, ids]) => ids.size > 1)
      .map(([chord, ids]) => `${chord}: ${[...ids].join(', ')}`);

    expect(contested, 'chords claimed by more than one command').toEqual([]);
  });
});

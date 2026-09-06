// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import MenuBar from '../src/ui/MenuBar.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * Alt and the drawn menu bar.
 *
 * A5-003: on Windows and Linux a bare Alt puts the keyboard on the menu bar
 * and Alt plus a letter opens that menu. Nox's bar answered only F10, which
 * nobody reaches for. The behaviour is the platform's, so the tests describe
 * the platform: a tap, a chord, and the two things that must *not* count as
 * either.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const key = (type: 'keydown' | 'keyup', init: KeyboardEventInit) =>
  window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));

const tapAlt = () => {
  key('keydown', { key: 'Alt', code: 'AltLeft', altKey: true });
  key('keyup', { key: 'Alt', code: 'AltLeft', altKey: false });
};

const titleButtons = (m: Mounted) => [...m.container.querySelectorAll<HTMLButtonElement>('.menu-title')];

const expanded = (m: Mounted) => titleButtons(m).find((b) => b.getAttribute('aria-expanded') === 'true');

describe('a bare Alt', () => {
  it('puts the keyboard on the bar', () => {
    mounted = mountComponent(MenuBar);
    flush();

    tapAlt();
    flush();

    expect(titleButtons(mounted)).toContain(document.activeElement);
    // Focus, not a menu: the platform opens nothing until a second key.
    expect(expanded(mounted)).toBeUndefined();
  });

  it('gives the keyboard back when the bar already has it', () => {
    mounted = mountComponent(MenuBar);
    flush();
    const before = mounted.app.ui.focusEditorRequest.get();

    tapAlt();
    flush();
    tapAlt();
    flush();

    expect(mounted.app.ui.focusEditorRequest.get()).toBe(before + 1);
  });

  /**
   * Alt held for a chord is the *other* thing Alt is for. Alt+ArrowUp moves
   * a line in the editor; if the release afterwards focused the bar, every
   * such chord would end with the keyboard somewhere else.
   */
  it('does not count when another key was pressed while it was held', () => {
    mounted = mountComponent(MenuBar);
    flush();

    key('keydown', { key: 'Alt', code: 'AltLeft', altKey: true });
    key('keydown', { key: 'ArrowUp', code: 'ArrowUp', altKey: true });
    key('keyup', { key: 'ArrowUp', code: 'ArrowUp', altKey: true });
    key('keyup', { key: 'Alt', code: 'AltLeft', altKey: false });
    flush();

    expect(titleButtons(mounted)).not.toContain(document.activeElement);
  });
});

describe('Alt with a letter', () => {
  it('opens that menu', () => {
    mounted = mountComponent(MenuBar);
    flush();

    key('keydown', { key: 'Alt', code: 'AltLeft', altKey: true });
    key('keydown', { key: 'f', code: 'KeyF', altKey: true });
    flush();

    expect(expanded(mounted)?.textContent?.trim()).toBe('File');
  });

  it('leaves a chord the keymap already claimed alone', () => {
    mounted = mountComponent(MenuBar);
    flush();

    // `Alt+Z` is Toggle Word Wrap. The keymap runs first and prevents the
    // default; the bar must read that as "taken" rather than open a menu
    // that happens to share the letter.
    const event = new KeyboardEvent('keydown', {
      key: 'z',
      code: 'KeyZ',
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    key('keydown', { key: 'Alt', code: 'AltLeft', altKey: true });
    window.dispatchEvent(event);
    flush();

    expect(expanded(mounted)).toBeUndefined();
  });
});

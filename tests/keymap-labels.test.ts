// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import ExplorerPanel from '../src/ui/ExplorerPanel.svelte';
import { formatChord, platformIsMac } from '../src/services/keymap';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * How a key is spelled, per platform.
 *
 * What this guards: `formatChord` symbolised Backspace, Delete, Enter and Tab
 * as ⌫ ⌦ ↵ ⇥ before it looked at the platform, so a Windows chord rendered
 * as `Ctrl+⌫` beside menus that spell everything else `Ctrl+Shift+P`. The
 * explorer's context menu did not even ask: its Delete hint was a literal
 * `⌫`, which means nothing to a Windows user, who presses Delete.
 *
 * Both platforms are asserted through `formatChord`'s explicit second
 * argument rather than by faking `navigator`, because `isMac` is read once
 * at module scope and the two test environments already disagree about it
 * (see the comment above it in `keymap.ts`). What this does not catch: a
 * caller that formats a chord with the wrong platform.
 */

describe('formatChord', () => {
  it('keeps the macOS glyphs on macOS', () => {
    expect(formatChord('backspace', true)).toBe('⌫');
    expect(formatChord('delete', true)).toBe('⌦');
    expect(formatChord('enter', true)).toBe('↵');
    expect(formatChord('tab', true)).toBe('⇥');
    expect(formatChord('meta+backspace', true)).toBe('⌘⌫');
  });

  it('spells the four out elsewhere', () => {
    expect(formatChord('backspace', false)).toBe('Backspace');
    expect(formatChord('delete', false)).toBe('Delete');
    expect(formatChord('enter', false)).toBe('Enter');
    expect(formatChord('tab', false)).toBe('Tab');
    expect(formatChord('ctrl+backspace', false)).toBe('Ctrl+Backspace');
  });

  /**
   * Arrows are not a macOS idiom: every platform draws them, and `↑↓` is
   * shorter than `Up/Down` in a menu column. Only the four change.
   */
  it('keeps the arrows and Esc everywhere', () => {
    for (const mac of [true, false]) {
      expect(formatChord('up', mac)).toBe('↑');
      expect(formatChord('escape', mac)).toBe('Esc');
      expect(formatChord('pgup', mac)).toBe('PgUp');
    }
  });

  it('defaults to the host it is running on', () => {
    expect(formatChord('backspace')).toBe(formatChord('backspace', platformIsMac));
  });
});

describe('the explorer Delete hint', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
  });

  async function settle() {
    for (let i = 0; i < 6; i++) await Promise.resolve();
    flush();
  }

  /**
   * Under jsdom `platformIsMac` is false, so this is the Windows and Linux
   * spelling; the macOS one is covered by `formatChord` above. The hint is
   * read out of the open menu rather than the source, so the assertion is
   * about what the user sees.
   */
  it('is spelled the way the keymap spells it', async () => {
    mounted = mountComponent(ExplorerPanel);
    const { app, platform, container } = mounted;
    platform.seedFile('/w/a.ts', 'const a = 1;\n');
    await app.workspace.openFolder('/w');
    await app.files.setRoot('/w');
    await settle();

    const row = container.querySelector<HTMLElement>('.row');
    expect(row).not.toBeNull();
    row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await settle();

    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Delete'),
    );
    expect(item, 'the menu must offer Delete').toBeDefined();
    expect(item!.querySelector('kbd')?.textContent?.trim()).toBe(
      formatChord(platformIsMac ? 'backspace' : 'delete'),
    );
  });
});

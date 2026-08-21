// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import MenuBar from '../src/ui/MenuBar.svelte';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import { LAYOUT } from '../src/services/menu';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * The menu bar Nox draws where the OS will not.
 *
 * `MemoryPlatform` reports `applicationMenu: false`, which is exactly the
 * platform this component exists for, so it mounts without any faking.
 *
 * **What jsdom forbids claiming here:** anything geometric. There is no
 * layout, and `tests/support/jsdom-layout.ts` fills `getClientRects` with a
 * single all-zero rectangle. So no test below may claim a menu opens *under*
 * its button, flips at the viewport edge, clears the window controls, or fits
 * the title bar's width. Those belong to a desktop walk.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const titles = (m: Mounted) =>
  [...m.container.querySelectorAll('.menu-title')].map((b) => b.textContent?.trim());

const openItems = () =>
  [...document.querySelectorAll('[role="menuitem"]')]
    .filter((el) => !el.classList.contains('menu-title'))
    .map((el) => el.textContent?.replace(/\s+/g, ' ').trim());

describe('the bar', () => {
  it('shows one button per menu the builder produced', () => {
    mounted = mountComponent(MenuBar);
    flush();

    const shown = titles(mounted);
    expect(shown.length).toBeGreaterThan(0);
    // Every button is a group the shared LAYOUT names — no second table.
    for (const label of shown) {
      expect(LAYOUT.map((g) => g.label)).toContain(label);
    }
  });

  /**
   * The failure this prevents: the bar being one tab stop per menu. The
   * WAI-ARIA menubar pattern is a single stop with a roving tabindex —
   * otherwise tabbing out of the title bar takes eight presses.
   */
  it('is a single tab stop', () => {
    mounted = mountComponent(MenuBar);
    flush();

    const buttons = [...mounted.container.querySelectorAll('.menu-title')];
    const tabbable = buttons.filter((b) => b.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
    expect(buttons.length).toBeGreaterThan(1);
  });

  it('marks itself up as a menubar', () => {
    mounted = mountComponent(MenuBar);
    flush();

    const bar = mounted.container.querySelector('[role="menubar"]');
    expect(bar?.getAttribute('aria-orientation')).toBe('horizontal');
    expect(mounted.container.querySelector('.menu-title')?.getAttribute('aria-haspopup')).toBe(
      'menu',
    );
  });
});

describe('opening a menu', () => {
  it('lists that menu\u2019s commands, and says it is expanded', async () => {
    mounted = mountComponent(MenuBar);
    flush();

    const first = mounted.container.querySelector<HTMLButtonElement>('.menu-title')!;
    first.click();
    await flush();

    expect(first.getAttribute('aria-expanded')).toBe('true');
    expect(openItems().length).toBeGreaterThan(0);
  });

  /**
   * The whole reason this bar is worth building rather than living with no
   * menu: the native menu draws every item enabled, because greying them
   * would mean pushing ~130 command states across the IPC boundary. The
   * predicates are already in this process, so here they simply work.
   */
  it('greys a command whose own predicate says no', async () => {
    const app = new NoxApp(new MemoryPlatform());
    // Nothing is open, so anything gated on a buffer must be disabled.
    expect(app.commands.isEnabled('file.save')).toBe(false);

    mounted = mountComponent(MenuBar, { app });
    flush();

    const fileButton = [...mounted.container.querySelectorAll<HTMLButtonElement>('.menu-title')].find(
      (b) => b.textContent?.trim() === 'File',
    )!;
    fileButton.click();
    await flush();

    const save = [...document.querySelectorAll('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Save'),
    );
    expect(save, 'File menu should list a Save item').toBeTruthy();
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it('closes when the same button is pressed again', async () => {
    mounted = mountComponent(MenuBar);
    flush();

    const first = mounted.container.querySelector<HTMLButtonElement>('.menu-title')!;
    first.click();
    await flush();
    first.click();
    await flush();

    expect(first.getAttribute('aria-expanded')).toBe('false');
  });

  /**
   * `UIService` owns the answer to "what does Escape close", and a menu drawn
   * over everything else has to be in that list or Escape reaches past it to
   * the panel underneath.
   */
  it('tells UIService a menu is showing', async () => {
    const app = new NoxApp(new MemoryPlatform());
    mounted = mountComponent(MenuBar, { app });
    flush();

    expect(app.ui.menuBarOpen.get()).toBe(false);
    mounted.container.querySelector<HTMLButtonElement>('.menu-title')!.click();
    await flush();

    expect(app.ui.menuBarOpen.get()).toBe(true);
    expect(app.ui.hasDismissible()).toBe(true);
  });
});

describe('dismissal from outside', () => {
  /**
   * The failure this prevents, found by walking the app rather than by any
   * test here: Escape left the menu on screen. The global Escape runs
   * `UIService.dismissTop`, which clears the `menuBarOpen` signal — but the
   * component renders from its own `open` state, so the two disagreed and the
   * popup stayed up with `aria-expanded="true"` while the app believed it had
   * closed.
   *
   * The signal is the authority for "is a menu showing"; the component
   * follows it.
   */
  it('closes when UIService dismisses it', async () => {
    const app = new NoxApp(new MemoryPlatform());
    mounted = mountComponent(MenuBar, { app });
    flush();

    const first = mounted.container.querySelector<HTMLButtonElement>('.menu-title')!;
    first.click();
    await flush();
    expect(first.getAttribute('aria-expanded')).toBe('true');

    expect(app.ui.dismissTop()).toBe(true);
    await flush();

    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelectorAll('[role="menuitem"]:not(.menu-title)')).toHaveLength(0);
  });
});

describe('keyboard', () => {
  const press = (el: Element, key: string) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

  it('moves along the bar with the arrow keys', async () => {
    mounted = mountComponent(MenuBar);
    flush();

    const bar = mounted.container.querySelector('[role="menubar"]')!;
    const buttons = [...mounted.container.querySelectorAll('.menu-title')];

    press(bar, 'ArrowRight');
    await flush();
    expect(buttons[1]!.getAttribute('tabindex')).toBe('0');
    expect(buttons[0]!.getAttribute('tabindex')).toBe('-1');
  });

  it('wraps around rather than stopping at the end', async () => {
    mounted = mountComponent(MenuBar);
    flush();

    const bar = mounted.container.querySelector('[role="menubar"]')!;
    const buttons = [...mounted.container.querySelectorAll('.menu-title')];

    press(bar, 'ArrowLeft');
    await flush();
    expect(buttons[buttons.length - 1]!.getAttribute('tabindex')).toBe('0');
  });

  it('opens the focused menu with ArrowDown', async () => {
    mounted = mountComponent(MenuBar);
    flush();

    const bar = mounted.container.querySelector('[role="menubar"]')!;
    press(bar, 'ArrowDown');
    await flush();

    expect(mounted.container.querySelector('.menu-title')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
  });
});

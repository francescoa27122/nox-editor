// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import TabBar from '../src/ui/TabBar.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * The tab strip's context menu — walk item **C1**, and the reason it is here
 * rather than in `e2e/`.
 *
 * The 2026-08-20 desktop walk marked it UNSEEN: *"scope cut by controller
 * (both attempts aborted by user-input interrupts)"*, and C2 below it was
 * blocked because it depended on this menu. The obvious home for it was the
 * WebDriver suite, which drives the packaged app on all three platforms.
 *
 * **It cannot go there.** Tried on 2026-08-25, two ways, three engines:
 * `element.click({ button: 'right' })` and the explicit W3C pointer sequence
 * (`.down({ button: 2 }).up({ button: 2 })`). Both reported success and
 * neither produced a `contextmenu` event — the menu never opened on WebKitGTK,
 * on WebView2, or on macOS, while the other ten specs in that suite passed on
 * all three. A synthesized right-click is not a right-click as far as these
 * webviews are concerned.
 *
 * That is the same shape as the finding the walk itself produced about *its*
 * harness — Escape was eaten at the OS level and never reached the app — and
 * it gets the same treatment: name the limit, and put the assertion where it
 * can actually be made. jsdom dispatches `contextmenu` and the component
 * handles it, so everything about this menu except the gesture is checkable
 * here. What stays unverified in CI is that a real right-click on a real tab
 * opens it; `EditorPane`'s menu is in the same position and says so too.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function strip() {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w');
  platform.seedFile('/w/main.ts', 'const a = 1;\n');
  platform.seedFile('/w/other.ts', 'const b = 2;\n');

  const app = new NoxApp(platform);
  await app.workspace.openFolder('/w');

  mounted = mountComponent(TabBar, { props: { groupId: 'group-1' }, app });
  const id = (await app.workspace.open('/w/main.ts'))!;
  app.workspace.setActive(id);
  flush();

  return { app, container: mounted.container, id };
}

/** Right-click the first tab, as a user does. Returns the event dispatched. */
function rightClickTab(container: HTMLElement): MouseEvent {
  const tab = container.querySelector('.tab');
  expect(tab).not.toBeNull();
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: 20,
    clientY: 10,
  });
  tab!.dispatchEvent(event);
  flush();
  return event;
}

function itemsOf(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map((button) => ({
    label: button.querySelector('.label')?.textContent?.trim() ?? '',
    hint: button.querySelector('kbd')?.textContent?.trim() ?? null,
  }));
}

describe('right-clicking a tab', () => {
  /**
   * The walk item asked for a seven-item menu. Named rather than counted: a
   * count of seven passes just as happily when the wrong seven are there.
   */
  it('opens the menu the walk went looking for', async () => {
    const { container } = await strip();
    expect(container.querySelector('[role="menu"]')).toBeNull();

    rightClickTab(container);

    const labels = itemsOf(container).map((item) => item.label);
    expect(labels).toEqual([
      'Close',
      'Close Others',
      'Close to the Right',
      'Close Saved',
      'Copy Path',
      'Reveal in Explorer',
      'Split Editor',
    ]);
  });

  /**
   * Suppressing the webview's own menu is the half that is invisible when it
   * works. Without it a desktop right-click falls through to Reload, Services
   * and Look Up — `EditorPane`'s menu had exactly this bug.
   */
  it("suppresses the webview's own menu", async () => {
    const { container } = await strip();
    const event = rightClickTab(container);
    expect(event.defaultPrevented).toBe(true);
  });

  /**
   * The hints are the other half of the walk item, and they are not
   * decoration: `keybindings.json` supports `remove` rules, so every default
   * binding is reachably unbound and a hardcoded hint would eventually name a
   * key that does nothing. Reading them from the keymap is what makes them
   * true, and asserting one appears is asserting that path ran.
   */
  it('spells its shortcuts from the keymap', async () => {
    const { app, container } = await strip();
    rightClickTab(container);

    const close = itemsOf(container).find((item) => item.label === 'Close');
    expect(close?.hint).toBe(app.keymap.displayFor('file.close'));
    expect(close?.hint).toBeTruthy();
  });

  /**
   * The failure this prevents: a hint hardcoded as `Ctrl+W` while the user has
   * rebound or removed it. Rebinding here must move the menu with it.
   */
  it('follows a rebound shortcut rather than spelling one', async () => {
    const { app, container } = await strip();
    app.keymap.assign('file.close', 'Mod+Alt+K', { from: 'Mod+W' });
    flush();

    rightClickTab(container);

    const close = itemsOf(container).find((item) => item.label === 'Close');
    expect(close?.hint).toBe(app.keymap.displayFor('file.close'));
    expect(close?.hint).not.toBe('Ctrl+W');
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import type { PlatformCapabilities } from '../src/platform/types';
import TitleBar from '../src/ui/TitleBar.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * The title bar's window controls, which exist only where the shell has hidden
 * the OS chrome.
 *
 * These cover the half of the Windows title-bar fix that is testable without a
 * window: whether the buttons are drawn, what they call, and whether the
 * maximise button tracks state. The half that is not testable here is whether
 * `decorations: false` actually takes effect — that is `lib.rs`, a real
 * Windows build, and a human looking at it.
 */

/** A platform that claims the shell hid its decorations, with spies attached. */
class UndecoratedPlatform extends MemoryPlatform {
  override readonly capabilities: PlatformCapabilities = {
    ...new MemoryPlatform().capabilities,
    customWindowControls: true,
  };

  readonly minimized = vi.fn();
  readonly toggled = vi.fn();
  readonly closed = vi.fn();
  /** Set by `onMaximizeChange`, so a test can drive the state the OS would. */
  notify: ((maximized: boolean) => void) | null = null;

  override async minimizeWindow(): Promise<void> {
    this.minimized();
  }

  override async toggleMaximizeWindow(): Promise<boolean> {
    this.toggled();
    return true;
  }

  override async closeWindow(): Promise<void> {
    this.closed();
  }

  override async onMaximizeChange(handler: (maximized: boolean) => void): Promise<() => void> {
    this.notify = handler;
    handler(false);
    return () => {
      this.notify = null;
    };
  }
}

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function mountWith(platform: MemoryPlatform) {
  const app = new NoxApp(platform);
  await app.workspace.openFolder('/w');
  mounted = mountComponent(TitleBar, { app });
  flush();
  return mounted.container;
}

const controls = (container: HTMLElement) =>
  [...container.querySelectorAll('.window-control')].map((b) => b.getAttribute('aria-label'));

const control = (container: HTMLElement, label: string) => {
  const button = container.querySelector<HTMLButtonElement>(`.window-control[aria-label="${label}"]`);
  if (!button) throw new Error(`no window control labelled ${label}`);
  return button;
};

describe('who draws the window controls', () => {
  /**
   * The failure this prevents: drawing our own minimise/maximise/close beside
   * the OS's. On macOS the traffic lights are still there — an overlay title
   * bar hides the bar, not the buttons — so a second set is duplicate chrome,
   * and in the browser target there is no window to control at all.
   */
  it('draws none of them when the platform keeps its own chrome', async () => {
    const container = await mountWith(new MemoryPlatform());
    expect(controls(container)).toEqual([]);
  });

  /**
   * The failure this prevents: the bug this whole change exists for, in
   * reverse. With decorations off and no buttons drawn, the window cannot be
   * minimised, maximised or closed from the app at all.
   */
  it('draws all three when the shell has hidden the OS chrome', async () => {
    const container = await mountWith(new UndecoratedPlatform());
    expect(controls(container)).toEqual(['Minimise', 'Maximise', 'Close window']);
  });
});

describe('what the window controls do', () => {
  /**
   * The failure this prevents: a button wired to the wrong call — the kind of
   * mistake that is invisible in review and obvious the first time someone
   * means to minimise and the window disappears.
   */
  it('each button calls its own platform method', async () => {
    const platform = new UndecoratedPlatform();
    const container = await mountWith(platform);

    control(container, 'Minimise').click();
    control(container, 'Maximise').click();
    control(container, 'Close window').click();
    await Promise.resolve();

    expect(platform.minimized).toHaveBeenCalledTimes(1);
    expect(platform.toggled).toHaveBeenCalledTimes(1);
    expect(platform.closed).toHaveBeenCalledTimes(1);
  });

  /**
   * The failure this prevents: a maximise button that reads the state once
   * and then lies. The user has other ways to maximise — the OS shortcut, a
   * double-click on the drag region, Windows' snap layouts — so the button
   * has to follow the window rather than its own last click.
   */
  it('follows the window when something else maximises it', async () => {
    const platform = new UndecoratedPlatform();
    const container = await mountWith(platform);

    expect(control(container, 'Maximise').title).toBe('Maximise');

    platform.notify?.(true);
    flush();
    expect(control(container, 'Restore').title).toBe('Restore');

    platform.notify?.(false);
    flush();
    expect(control(container, 'Maximise').title).toBe('Maximise');
  });

  /**
   * The failure this prevents: a listener that outlives the component. The
   * subscription is async, so a teardown can land before it resolves, and
   * without a cancelled flag the late `unlisten` is dropped on the floor and
   * the handler keeps writing to state nobody is rendering.
   */
  it('unsubscribes when the bar goes away', async () => {
    const platform = new UndecoratedPlatform();
    await mountWith(platform);
    expect(platform.notify).not.toBeNull();

    mounted?.unmount();
    mounted = null;
    await Promise.resolve();

    expect(platform.notify).toBeNull();
  });
});

describe('the window commands', () => {
  /**
   * The failure this prevents: the three controls reaching the platform
   * directly, which left minimise, maximise and close as the only user
   * actions with no `Command`, so no `keybindings.json` rule and no plugin
   * could reach them. The buttons must dispatch a command id like every
   * other button in the app.
   */
  it('are what the buttons dispatch', async () => {
    const container = await mountWith(new UndecoratedPlatform());
    const execute = vi.spyOn(mounted!.app.commands, 'execute');

    control(container, 'Minimise').click();
    control(container, 'Maximise').click();
    control(container, 'Close window').click();
    await Promise.resolve();

    expect(execute.mock.calls.map(([id]) => id)).toEqual([
      'window.minimize',
      'window.toggleMaximize',
      'window.close',
    ]);
  });

  /**
   * And the commands do the thing, with no bar mounted at all: that is what
   * makes them bindable.
   */
  it('reach the platform on their own', async () => {
    const platform = new UndecoratedPlatform();
    const app = new NoxApp(platform);

    await app.commands.execute('window.minimize');
    await app.commands.execute('window.toggleMaximize');
    await app.commands.execute('window.close');

    expect(platform.minimized).toHaveBeenCalledTimes(1);
    expect(platform.toggled).toHaveBeenCalledTimes(1);
    expect(platform.closed).toHaveBeenCalledTimes(1);
  });
});

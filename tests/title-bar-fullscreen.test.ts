// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import type { PlatformCapabilities } from '../src/platform/types';
import TitleBar from '../src/ui/TitleBar.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * The traffic-light inset, and its one moving part: fullscreen.
 *
 * On macOS the window uses an overlay title bar, so the OS buttons sit on top
 * of this element and it pads its leading edge by 78px to clear them. In
 * fullscreen the buttons slide away and that padding becomes a dead gap with
 * nothing in it — which is exactly what shipped, because the inset was a
 * `const` computed once at component init and nothing in the app observed
 * fullscreen at all.
 *
 * The reserve is read off `capabilities.overlayWindowControls` rather than
 * `platform.id === 'tauri' && isMac` for the reason these tests exist:
 * `MemoryPlatform.id` is `readonly 'web'`, so the old condition could not be
 * made true from a test or a browser session, and the whole branch had no
 * coverage.
 */

/** A platform that claims the OS draws its buttons over the title bar. */
class OverlayChromePlatform extends MemoryPlatform {
  override readonly capabilities: PlatformCapabilities = {
    ...new MemoryPlatform().capabilities,
    overlayWindowControls: true,
  };

  /** Set by `onFullscreenChange`, so a test can drive what only the OS can. */
  notify: ((fullscreen: boolean) => void) | null = null;

  override async onFullscreenChange(
    handler: (fullscreen: boolean) => void,
  ): Promise<() => void> {
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

const bar = (container: HTMLElement) => {
  const header = container.querySelector<HTMLElement>('.nox-titlebar');
  if (!header) throw new Error('no title bar rendered');
  return header;
};

describe('reserving room for the OS window buttons', () => {
  /**
   * The failure this prevents: padding the bar on a platform that draws no
   * buttons over it, which pushes the wordmark 78px right for nothing.
   */
  it('reserves nothing when the OS draws no buttons over the bar', async () => {
    const container = await mountWith(new MemoryPlatform());
    expect(bar(container).classList.contains('reserve')).toBe(false);
  });

  /**
   * The failure this prevents, in reverse: no inset on macOS puts the crescent
   * underneath the traffic lights.
   */
  it('reserves the inset when the OS draws its buttons over the bar', async () => {
    const container = await mountWith(new OverlayChromePlatform());
    expect(bar(container).classList.contains('reserve')).toBe(true);
  });

  /**
   * The bug this file exists for. Confirmed on screen in the packaged app:
   * windowed, the crescent sat at x≈75 with the traffic lights to its left;
   * fullscreen, the lights were gone and the crescent was still at x≈77 with
   * nothing to its left for the whole session.
   */
  it('gives the inset back when the window goes fullscreen', async () => {
    const platform = new OverlayChromePlatform();
    const container = await mountWith(platform);
    expect(bar(container).classList.contains('reserve')).toBe(true);

    platform.notify?.(true);
    flush();
    expect(bar(container).classList.contains('reserve')).toBe(false);

    platform.notify?.(false);
    flush();
    expect(bar(container).classList.contains('reserve')).toBe(true);
  });

  /**
   * The failure this prevents: hanging the subscription off the same guard as
   * the Windows window controls. `drawWindowControls` is false on macOS —
   * which is the only platform that has this inset at all — so a listener
   * behind that guard is a listener that never runs where it is needed.
   */
  it('subscribes on the platform that has the inset, not the one with buttons', async () => {
    const platform = new OverlayChromePlatform();
    await mountWith(platform);
    expect(platform.capabilities.customWindowControls).toBe(false);
    expect(platform.notify).not.toBeNull();
  });

  /**
   * The failure this prevents: a listener that outlives the component. The
   * subscription is async, so a teardown can land before it resolves — the
   * same trap `onMaximizeChange` already has a cancelled flag for.
   */
  it('unsubscribes when the bar goes away', async () => {
    const platform = new OverlayChromePlatform();
    await mountWith(platform);
    expect(platform.notify).not.toBeNull();

    mounted?.unmount();
    mounted = null;
    await Promise.resolve();

    expect(platform.notify).toBeNull();
  });
});

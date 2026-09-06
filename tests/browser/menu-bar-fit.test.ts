import { page } from 'vitest/browser';
import { afterEach, describe, expect, it } from 'vitest';
import TitleBar from '../../src/ui/TitleBar.svelte';
import { NoxApp } from '../../src/app';
import { MemoryPlatform } from '../../src/platform/memory';
import { flush, mountComponent, type Mounted } from '../support/component';
import '../../src/styles/tokens.css';
import '../../src/styles/base.css';

/**
 * Whether the menu bar's last title is on screen at the smallest window.
 *
 * `MenuBar.svelte` yields width with `min-width: 0; overflow-x: auto` and
 * hides the scrollbar, because a 23px strip cannot host one. That trade is
 * right, and it has a cost the comment records: when the bar is narrower
 * than its titles, the last one is clipped with nothing on screen to say so.
 * At the 640px `minWidth` the desktop app allows, the audit measured a
 * `scrollWidth` of 281 against a `clientWidth` of 261 and a screenshot that
 * ended in "To".
 *
 * A browser with layout is the only place this can be asserted, for the
 * reason `tests/support/jsdom-layout.ts` gives: jsdom measures every element
 * as zero, so a jsdom test would pass at any width. What this does not
 * catch: a font whose metrics differ from the one the headless Chromium
 * here falls back to.
 */

const MIN_WIDTH = 640;
const MIN_HEIGHT = 420;

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

/** A title bar over a workspace, the way the audit walked it. */
async function titleBar(options: { windowControls: boolean }) {
  const platform = new MemoryPlatform();
  // Windows draws its own three controls at the right of the bar, which is
  // the narrowest case the bar has to survive.
  platform.capabilities.customWindowControls = options.windowControls;
  platform.mkdirp('/aurora');
  platform.seedFile('/aurora/README.md', '# Aurora\n');

  const app = new NoxApp(platform);
  await app.workspace.openFolder('/aurora');
  const id = await app.workspace.open('/aurora/README.md');
  if (id) app.workspace.setActive(id);

  mounted = mountComponent(TitleBar, { app });
  flush();
  // Two frames: one for the mount to paint, one for the fonts to settle.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const bar = mounted.container.querySelector<HTMLElement>('.menu-bar');
  if (!bar) throw new Error('the title bar drew no menu bar');
  return bar;
}

describe.each([
  { windowControls: false, where: 'the browser build' },
  { windowControls: true, where: 'Windows, with the drawn window controls' },
])('at the minimum window size on $where', ({ windowControls }) => {
  it('shows every menu title', async () => {
    await page.viewport(MIN_WIDTH, MIN_HEIGHT);
    const bar = await titleBar({ windowControls });

    const titles = [...bar.querySelectorAll<HTMLElement>('.menu-title')];
    expect(titles.length).toBeGreaterThan(1);

    // The number the audit reported, so a failure here says how far off it is.
    expect(`scrollWidth ${bar.scrollWidth} within clientWidth ${bar.clientWidth}`).toBe(
      `scrollWidth ${Math.min(bar.scrollWidth, bar.clientWidth)} within clientWidth ${bar.clientWidth}`,
    );

    // And the last title's right edge is inside the bar, which is what the
    // user actually sees.
    const last = titles[titles.length - 1]!.getBoundingClientRect();
    expect(last.right).toBeLessThanOrEqual(bar.getBoundingClientRect().right + 0.5);
  });
});

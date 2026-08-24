// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import ExplorerPanel from '../src/ui/ExplorerPanel.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * The explorer renders the rows you can see — see
 * `docs/superpowers/specs/2026-08-20-explorer-virtualisation-design.md`.
 *
 * jsdom has no layout, so `clientHeight` is 0 and the panel deliberately
 * renders everything. That is the behaviour under test in the first case and
 * the thing every *other* explorer test relies on; the windowed cases stub
 * `clientHeight` on the container and dispatch a real `scroll` event, which
 * is the same door the component's own listeners use.
 *
 * Mutation checks (each made the named test red, then reverted):
 * - `windowed` dropping its `viewportHeight > 0` guard → "an unmeasured
 *   viewport renders every row" (it rendered a window of nothing).
 * - `firstIndex` losing its `- OVERSCAN` → "scrolling renders the rows at
 *   that offset".
 * - the slice starting at 0 instead of `firstIndex` → the same test. (At
 *   scroll offset 0 those two are identical, which is why the assertion that
 *   catches it is the scrolled one, not the initial-render one.)
 * - `padTop` fixed at 0 → "the spacers place the window at the right offset".
 * - `aria-posinset` counting within the window rather than the tree →
 *   "every rendered row knows its place in the whole tree".
 * - `revealLead`'s scroll-*down* branch removed → "arrowing past the bottom
 *   edge scrolls, and the lead row is rendered".
 * - `revealLead`'s scroll-*up* branch disabled → "arrowing above the top edge
 *   scrolls back up". Two mutations rather than one because the first attempt
 *   killed the up branch and the only test at the time went down: a survivor
 *   that meant the suite had one direction, not that the code had one.
 */

const ROW_HEIGHT = 23;
const VIEWPORT = 460; // 20 rows

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function settle() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  flush();
}

/** A flat folder of `count` files, opened. */
async function setup(count: number) {
  mounted = mountComponent(ExplorerPanel);
  const { app, platform, container } = mounted;
  for (let i = 0; i < count; i++) {
    platform.seedFile(`/w/f${String(i).padStart(4, '0')}.ts`, '\n');
  }
  await app.workspace.openFolder('/w');
  await app.files.setRoot('/w');
  await settle();
  return { app, platform, container, tree: container.querySelector('.tree') as HTMLElement };
}

/** jsdom reports 0 for every measurement; give the container a real one. */
function giveHeight(tree: HTMLElement, height = VIEWPORT) {
  Object.defineProperty(tree, 'clientHeight', { value: height, configurable: true });
}

function scrollTo(tree: HTMLElement, top: number) {
  tree.scrollTop = top;
  tree.dispatchEvent(new Event('scroll'));
  flush();
}

const names = (tree: HTMLElement) =>
  [...tree.querySelectorAll('.row .name')].map((n) => n.textContent);

// Twenty seconds, for the reason spelled out at the same place in
// `search-virtualisation.test.ts`. These cases are cheaper — 0.2-1.0s idle
// rather than 1.4-2.0s, because seeding 600 files costs less than searching
// them — but the worst of them still sits close enough to vitest's 5s default
// that a loaded worker can cross it, and a timeout here would read as a
// windowing bug rather than as a busy machine.
describe('the explorer window', { timeout: 20_000 }, () => {
  it('a small tree renders every row, windowing or not', async () => {
    const { tree } = await setup(30);
    giveHeight(tree);
    scrollTo(tree, 0);

    expect(tree.querySelectorAll('.row')).toHaveLength(30);
    expect(tree.querySelector('.spacer')).toBeNull();
  });

  it('an unmeasured viewport renders every row', async () => {
    // No `giveHeight`: this is jsdom as every other suite sees it, and the
    // tree is well over the windowing threshold.
    const { tree } = await setup(600);
    await settle();

    expect(tree.querySelectorAll('.row')).toHaveLength(600);
  });

  it('a large tree with a measured viewport renders a window, not the tree', async () => {
    const { tree } = await setup(600);
    giveHeight(tree);
    scrollTo(tree, 0);

    const rows = tree.querySelectorAll('.row');
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.length).toBeLessThan(60);
    expect(names(tree)[0]).toBe('f0000.ts');
  });

  it('the spacers place the window at the right offset', async () => {
    const { tree } = await setup(600);
    giveHeight(tree);
    scrollTo(tree, 100 * ROW_HEIGHT);

    const spacers = [...tree.querySelectorAll<HTMLElement>('.spacer')];
    expect(spacers).toHaveLength(2);

    const top = Number.parseInt(spacers[0]!.style.height, 10);
    const bottom = Number.parseInt(spacers[1]!.style.height, 10);
    const rows = tree.querySelectorAll('.row').length;

    expect(top).toBe((100 - 8) * ROW_HEIGHT); // the overscan above
    expect(top + rows * ROW_HEIGHT + bottom).toBe(600 * ROW_HEIGHT);
  });

  it('scrolling renders the rows at that offset', async () => {
    const { tree } = await setup(600);
    giveHeight(tree);
    scrollTo(tree, 0);
    expect(names(tree)).toContain('f0000.ts');

    scrollTo(tree, 300 * ROW_HEIGHT);

    expect(names(tree)).not.toContain('f0000.ts');
    expect(names(tree)).toContain('f0300.ts');
    expect(names(tree)[0]).toBe('f0292.ts'); // 300 - OVERSCAN
  });

  it('every rendered row knows its place in the whole tree', async () => {
    const { tree } = await setup(600);
    giveHeight(tree);
    scrollTo(tree, 300 * ROW_HEIGHT);

    const first = tree.querySelector('.row')!;
    expect(first.getAttribute('aria-setsize')).toBe('600');
    expect(first.getAttribute('aria-posinset')).toBe('293'); // 1-based
  });

  it('arrowing past the bottom edge scrolls, and the lead row is rendered', async () => {
    const { app, tree } = await setup(600);
    giveHeight(tree);
    scrollTo(tree, 0);

    // Land the lead well below the window, the way holding ↓ would.
    app.ui.explorer.set('/w/f0100.ts');
    tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();

    expect(tree.scrollTop).toBeGreaterThan(0);
    expect(names(tree)).toContain('f0101.ts');
  });

  it('arrowing above the top edge scrolls back up', async () => {
    const { app, tree } = await setup(600);
    giveHeight(tree);
    scrollTo(tree, 300 * ROW_HEIGHT);

    app.ui.explorer.set('/w/f0100.ts');
    tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await settle();

    expect(tree.scrollTop).toBeLessThan(300 * ROW_HEIGHT);
    expect(names(tree)).toContain('f0099.ts');
  });

  it('the row height the arithmetic uses is the one the CSS paints', async () => {
    const { tree } = await setup(30);

    expect(tree.style.getPropertyValue('--nox-tree-row-h')).toBe(`${ROW_HEIGHT}px`);
  });
});

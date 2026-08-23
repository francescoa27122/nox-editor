import { describe, expect, it } from 'vitest';
import { placeMenu } from '../src/core/menu-placement';

/**
 * Placement arithmetic for floating menus.
 *
 * Pure on purpose: `tests/support/jsdom-layout.ts` records that a test needing
 * a particular rectangle should not exist under jsdom, so the rules live here
 * and `ContextMenu.svelte` keeps only the measuring.
 */

const base = {
  anchorX: 100,
  anchorY: 100,
  width: 200,
  naturalHeight: 300,
  viewportWidth: 1440,
  viewportHeight: 900,
};

describe('placeMenu', () => {
  it('leaves a menu that fits where the anchor put it', () => {
    expect(placeMenu(base)).toEqual({ x: 100, y: 100, maxHeight: null });
  });

  it('flips up when the bottom edge would be crossed', () => {
    const p = placeMenu({ ...base, anchorY: 800, naturalHeight: 300 });
    // 800 + 300 + 8 > 900, so it opens upward from the anchor.
    expect(p.y).toBe(500);
    expect(p.maxHeight).toBeNull();
  });

  it('flips left when the right edge would be crossed', () => {
    const p = placeMenu({ ...base, anchorX: 1400, width: 200 });
    expect(p.x).toBe(1200);
  });

  /**
   * The bug this guards, measured in the running app on 2026-08-23: the View
   * menu is 34 items and 903px tall in a 900px window. The old rule only
   * flipped — `y = max(margin, y - height)` — which put it at 8 and left it
   * running 11px past the bottom with `overflow-y: visible`, so its last
   * entries were unreachable and nothing indicated more existed.
   */
  it('clamps and scrolls a menu taller than the viewport instead of flipping it off-screen', () => {
    const p = placeMenu({ ...base, anchorY: 36, naturalHeight: 903, viewportHeight: 900 });
    expect(p.y).toBe(8);
    expect(p.maxHeight).toBe(884);
    // The whole menu is now inside the viewport, which the old code could not say.
    expect(p.y + p.maxHeight!).toBeLessThanOrEqual(900);
  });

  it('leaves the next-largest menus alone at laptop height, and clamps them below it', () => {
    // Edit measured 712px. A 768px window still has 752px available, so it
    // fits and must not gain a scrollbar it does not need.
    expect(placeMenu({ ...base, anchorY: 36, naturalHeight: 712, viewportHeight: 768 }).maxHeight)
      .toBeNull();
    // Shrink the window past its height and the same menu clamps.
    const short = placeMenu({ ...base, anchorY: 36, naturalHeight: 712, viewportHeight: 700 });
    expect(short.maxHeight).toBe(684);
    expect(short.y + short.maxHeight!).toBeLessThanOrEqual(700);
  });

  it('does not clamp a menu that exactly fills the available height', () => {
    const p = placeMenu({ ...base, anchorY: 8, naturalHeight: 884, viewportHeight: 900 });
    expect(p.maxHeight).toBeNull();
  });

  /**
   * Idempotence is why the component measures `scrollHeight` rather than the
   * bounding box: feeding a clamped height back in must not undo the clamp.
   */
  it('is stable when re-run on its own output height', () => {
    const first = placeMenu({ ...base, anchorY: 36, naturalHeight: 903, viewportHeight: 900 });
    const second = placeMenu({
      ...base,
      anchorY: 36,
      naturalHeight: 903,
      viewportHeight: 900,
    });
    expect(second).toEqual(first);
  });

  it('pins a menu wider than the viewport at the margin rather than off the left edge', () => {
    const p = placeMenu({ ...base, anchorX: 900, width: 2000, viewportWidth: 1000 });
    expect(p.x).toBe(8);
  });

  it('honours a caller-supplied margin', () => {
    const p = placeMenu({ ...base, anchorY: 36, naturalHeight: 903, viewportHeight: 900, margin: 20 });
    expect(p.y).toBe(20);
    expect(p.maxHeight).toBe(860);
  });
});

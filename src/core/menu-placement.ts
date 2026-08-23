/**
 * Where a floating menu goes, as arithmetic.
 *
 * This lives in `core/` rather than inside `ContextMenu.svelte` for one
 * reason: jsdom has no layout, and `tests/support/jsdom-layout.ts` records the
 * house rule that a test needing a *particular* rectangle should not exist
 * there. Placement is the part of the menu that is pure — measurements in,
 * coordinates out — so it can be tested exhaustively in Node while the
 * component keeps only the measuring.
 */

export interface MenuBox {
  /** Where the caller wants the menu's top-left: pointer, or a button's corner. */
  anchorX: number;
  anchorY: number;
  /** The menu's measured width, and the height it wants when nothing constrains it. */
  width: number;
  naturalHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Breathing room kept between the menu and every viewport edge. */
  margin?: number;
}

export interface MenuPlacement {
  x: number;
  y: number;
  /** Non-null only when the menu had to be shortened; it then scrolls. */
  maxHeight: number | null;
}

export function placeMenu(box: MenuBox): MenuPlacement {
  const margin = box.margin ?? 8;
  let x = box.anchorX;
  let y = box.anchorY;

  // Horizontal: flip to the anchor's other side, then keep it on screen. A
  // menu wider than the viewport is pinned at the margin rather than centred,
  // because the labels start at the left edge and that is the half worth
  // showing.
  if (x + box.width + margin > box.viewportWidth) x = Math.max(margin, x - box.width);

  const available = box.viewportHeight - margin * 2;

  // Flipping only rescues a menu that fits *somewhere*. One taller than the
  // viewport flips to `margin` and still runs off the bottom — Nox's View menu
  // is 34 items and measured 903px in a 900px window, so its last entries were
  // unreachable and no scrollbar said so. Those get the full height and scroll.
  if (box.naturalHeight > available) {
    return { x, y: margin, maxHeight: available };
  }

  if (y + box.naturalHeight + margin > box.viewportHeight) {
    y = Math.max(margin, y - box.naturalHeight);
  }
  return { x, y, maxHeight: null };
}

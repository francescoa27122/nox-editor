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
  const y = box.anchorY;

  // Horizontal: flip to the anchor's other side, then keep it on screen. A
  // menu wider than the viewport is pinned at the margin rather than centred,
  // because the labels start at the left edge and that is the half worth
  // showing.
  if (x + box.width + margin > box.viewportWidth) x = Math.max(margin, x - box.width);

  // Vertical placement is a choice between the two gaps the anchor divides the
  // viewport into. Below is preferred, above is the flip, and a menu too tall
  // for either scrolls inside the roomier one.
  const below = box.viewportHeight - y - margin;
  const above = y - margin;

  if (box.naturalHeight <= below) return { x, y, maxHeight: null };
  if (box.naturalHeight <= above) return { x, y: y - box.naturalHeight, maxHeight: null };

  // Taller than both gaps. The rule used to be `y = margin, maxHeight =
  // viewportHeight - margin * 2` — the whole window — which fixed the View
  // menu running off the bottom and quietly broke something else: a menu that
  // fills the window necessarily covers the thing it dropped from.
  //
  // Measured in the browser build at 1280x720: the File menu is 30 items, so
  // it opened at y=8 while the menu bar it belongs to ends at y=29. The bar
  // was underneath it, which is why sliding the pointer from File to Edit —
  // the one gesture that makes a menu bar a bar — did nothing, and why the
  // explorer's `.row.menu-target` styling, which exists to keep the row a
  // context menu belongs to visible, could be covered by that menu.
  //
  // Growing into one gap instead of over the anchor costs some height on a
  // short window and keeps the anchor on screen, which is the half that
  // matters: the menu scrolls either way.
  if (below >= above) return { x, y, maxHeight: below };
  return { x, y: margin, maxHeight: above };
}

/**
 * The one piece of layout jsdom lacks that CodeMirror needs to *run*.
 *
 * jsdom has no layout engine. `Element.getBoundingClientRect` exists and
 * returns all zeros; `Range.getClientRects` and
 * `Range.getBoundingClientRect` do not exist at all. CodeMirror's
 * `coordsAtPos` calls the former on a text range, and `HoverPlugin` calls
 * `coordsAtPos` from a bare `setTimeout` — so under jsdom a hover throws
 * `TypeError` before the hover source is ever asked.
 *
 * This fills the missing methods with the same zero rectangle jsdom already
 * returns from every element. **Nothing is invented**: the design that
 * introduced the component harness (2026-08-16, §7) refused to stub
 * measurements because the numbers would be made up here, and that still
 * holds — a test that needs a *particular* rectangle should not exist under
 * jsdom. The consequence to keep in mind when reading a hover test: with
 * all-zero geometry `posAtCoords` resolves to offset 0 for any pointer, so
 * a test can prove hovering asks the server about the pane's document and
 * that the answer reaches the DOM, and cannot prove *which* symbol was
 * under the pointer. That is CodeMirror's arithmetic and needs a browser.
 */
const ZERO_RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON() {
    return this;
  },
} as DOMRect;

export function installRangeRects(): void {
  if (typeof Range === 'undefined') return;
  const proto = Range.prototype as unknown as {
    getClientRects?: () => DOMRect[];
    getBoundingClientRect?: () => DOMRect;
  };
  if (!proto.getClientRects) proto.getClientRects = () => [ZERO_RECT];
  if (!proto.getBoundingClientRect) proto.getBoundingClientRect = () => ZERO_RECT;
}

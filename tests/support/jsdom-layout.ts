/**
 * The one piece of layout jsdom lacks that CodeMirror needs to *run*, and
 * the one fact this file makes up in order to supply it.
 *
 * jsdom has no layout engine. On an element, `getBoundingClientRect` exists
 * and returns all zeros, while `getClientRects()` returns an **empty** list.
 * On a `Range`, neither method exists at all. CodeMirror's `coordsAtPos`
 * reaches the range: `TextTile.coordsIn` in `@codemirror/view` does
 *
 *     let rects = textRange(this.dom, from, to).getClientRects();
 *     if (!rects.length) return null;
 *
 * and `HoverPlugin` calls `coordsAtPos` from a bare `setTimeout` — so under
 * jsdom a hover throws `TypeError` before the hover source is ever asked,
 * and an *honest* polyfill returning jsdom's own empty list would make
 * `coordsAtPos` return null and `startHover` give up just as early.
 *
 * So this polyfill **invents that one rectangle exists**. Its numbers are
 * not invented — they are the zeros jsdom already returns from every
 * element — but its length is. That is the single made-up fact, named here
 * so nobody mistakes it for jsdom's own geometry. The design that
 * introduced the component harness (2026-08-16, §7) refused to stub
 * measurements because the numbers would be made up, and that still holds:
 * a test that needs a *particular* rectangle should not exist under jsdom.
 *
 * Only `Range.getClientRects` is filled. `Range.getBoundingClientRect` was
 * removed on 2026-08-19 after checking that `tests/lsp-rendering.test.ts`
 * passes without it; CodeMirror's hover path never reaches it.
 *
 * The consequences to keep in mind when reading a hover test:
 * - with all-zero geometry `posAtCoords` resolves to offset 0 for any
 *   pointer, so a test can prove that hovering asks the server about the
 *   pane's document and that the answer reaches the DOM — and cannot prove
 *   *which* symbol was under the pointer, nor anything about placement.
 *   That is CodeMirror's arithmetic and needs a browser.
 * - pointer (0,0) is the only coordinate that survives `startHover`'s check
 *   of the pointer against the rectangle `coordsAtPos` returns, which is
 *   all zeros here. A hover test that moves the mouse anywhere else gets no
 *   tooltip and no request.
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
  };
  if (!proto.getClientRects) proto.getClientRects = () => [ZERO_RECT];
}

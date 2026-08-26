import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildExtensions } from '../../../src/editor/extensions';
import { defaultSettings } from '../../../src/services/config/schema';

/**
 * What a keystroke costs in a browser that has layout.
 *
 * Production readiness §4 left this open and said why: *"The typing path
 * proper needs a real `EditorView`, so that half is gated on §1's harness.
 * State the dependency rather than pretending a jsdom test covers it."* The
 * dependency is real — `tests/support/jsdom-layout.ts` records that jsdom
 * returns zeros from every measurement CodeMirror makes, and invents the one
 * rectangle it needs to run at all. A keystroke measured against zeros is not
 * a keystroke: viewport calculation, line measurement and DOM reconciliation
 * are most of what one costs, and jsdom has none of them.
 *
 * So this runs in chromium, through the browser project #130's Playwright
 * setup made available.
 */

/** A document of `lines` plausible source lines. */
export function document(lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(`  const value${i} = compute(argument${i % 17}, ${i}); // line ${i}`);
  }
  return out.join('\n');
}

export interface Editor {
  view: EditorView;
  destroy: () => void;
}

/** A real `EditorView` with Nox's full extension set, attached to the page. */
export function mountEditor(doc: string): Editor {
  const host = window.document.createElement('div');
  // A real height, or CodeMirror's viewport is the whole document and the
  // measurement stops being about a viewport at all — which is the thing most
  // worth holding constant between two document sizes.
  host.style.height = '600px';
  host.style.width = '800px';
  host.style.overflow = 'auto';
  window.document.body.appendChild(host);

  const view = new EditorView({
    parent: host,
    state: EditorState.create({ doc, extensions: buildExtensions(defaultSettings()) }),
  });

  return {
    view,
    destroy: () => {
      view.destroy();
      host.remove();
    },
  };
}

/**
 * Type one character, and wait for the browser to have done the work.
 *
 * The forced layout read is the point. `view.dispatch` updates CodeMirror's
 * DOM synchronously but the browser does not lay out until something asks it
 * to, and CodeMirror's own measure phase is scheduled rather than immediate.
 * Timing the dispatch alone would report the JavaScript and none of the
 * layout, which is a number that looks wonderful and means nothing — the frame
 * still has to pay for it before it can paint.
 *
 * `offsetHeight` on the scroller is the cheapest read that forces a synchronous
 * layout of what just changed.
 */
export function typeOneCharacter(view: EditorView): void {
  const at = view.state.selection.main.head;
  view.dispatch({
    changes: { from: at, insert: 'x' },
    selection: { anchor: at + 1 },
    scrollIntoView: true,
  });
  void view.scrollDOM.offsetHeight;
}

/**
 * Each timed block runs for at least this long.
 *
 * **Chrome clamps `performance.now()` to 100 microseconds** unless the page is
 * cross-origin isolated — a Spectre mitigation, and not something a test
 * should be arranging headers to defeat. A keystroke is comfortably *below*
 * that floor, so timing one returned exactly `0.100` or `0.000` every time,
 * and a ratio of two of those came out `Infinity`. The first version of this
 * file did precisely that and reported a flat typing path very convincingly.
 *
 * Timing a batch and dividing puts the block far above the clamp, which is the
 * same fix `tests/support/growth.ts` needed for the same reason.
 */
const TARGET_MS = 12;

/** How many keystrokes it takes to fill `TARGET_MS`. */
function calibrate(view: EditorView): number {
  let batch = 8;
  for (let attempt = 0; attempt < 20; attempt++) {
    const started = performance.now();
    for (let i = 0; i < batch; i++) typeOneCharacter(view);
    const elapsed = performance.now() - started;
    if (elapsed >= TARGET_MS) return batch;
    const growth = Math.max(2, TARGET_MS / Math.max(elapsed, 0.05));
    batch = Math.min(Math.ceil(batch * growth), 20_000);
  }
  return batch;
}

/**
 * The fastest keystroke, in milliseconds, from batches of `batch` of them.
 *
 * Minimum rather than mean: scheduler preemption, GC and a browser deciding to
 * do something else can only ever make a batch slower.
 */
export function fastestKeystroke(view: EditorView, samples = 7, warmup = 20): number {
  for (let i = 0; i < warmup; i++) typeOneCharacter(view);

  const batch = calibrate(view);

  let best = Infinity;
  for (let i = 0; i < samples; i++) {
    const started = performance.now();
    for (let k = 0; k < batch; k++) typeOneCharacter(view);
    const elapsed = (performance.now() - started) / batch;
    if (elapsed < best) best = elapsed;
  }
  return best;
}

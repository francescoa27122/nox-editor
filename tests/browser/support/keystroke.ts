import { javascript } from '@codemirror/lang-javascript';
import { ensureSyntaxTree } from '@codemirror/language';
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

/**
 * A host element sized so CodeMirror's viewport is a real viewport, not the
 * whole document — which is the thing most worth holding constant between
 * two document sizes.
 */
function createHost(): HTMLDivElement {
  const host = window.document.createElement('div');
  host.style.height = '600px';
  host.style.width = '800px';
  host.style.overflow = 'auto';
  window.document.body.appendChild(host);
  return host;
}

/** A real `EditorView` with Nox's full extension set, attached to the page. */
export function mountEditor(doc: string): Editor {
  const host = createHost();

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
 * A real `EditorView`, with Nox's full extension set **and** a real, fully
 * parsed grammar attached (A4-013).
 *
 * `mountEditor` above deliberately mounts with no language: `extensions.ts`'s
 * `languageCompartment` starts empty and is filled in later, asynchronously,
 * once a grammar loads (`EditorPane.svelte`) — so `syntaxTree(state)` is
 * empty there, and any extension keyed on it (sticky scroll, folding, bracket
 * matching, `indentOnInput`) runs against nothing. That is how A4-001
 * shipped a document-sized syntax-tree walk on the typing path past this
 * harness: the walk was real, and the gate that was supposed to catch a
 * regression like it could not see it.
 *
 * The grammar is attached directly, alongside Nox's own extensions, rather
 * than through the lazy compartment: the test wants the parse already
 * finished, not a load in flight. `ensureSyntaxTree` then forces the whole
 * document parsed once before returning — Lezer's own parse-ahead cap
 * (`Work.MaxParseAhead`, ~100,000 characters past the viewport) means a
 * freshly created state holds only a small parsed region regardless of
 * document size, which is the same "honest answer" `sticky.ts` documents for
 * an unparsed region: it pins nothing. Without forcing the parse, this
 * harness would exercise exactly that safe case and still miss a walk over
 * whatever *is* parsed — the same way scrolling to the document's end, a
 * session restored with the cursor near the bottom, or the symbol palette's
 * own `ensureSyntaxTree` call each make the full tree real on a normal path.
 */
export function mountEditorWithGrammar(doc: string): Editor {
  const host = createHost();

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [...buildExtensions(defaultSettings()), javascript({ typescript: true })],
    }),
  });

  ensureSyntaxTree(view.state, view.state.doc.length, 1e9);

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
 * Type one character, and also force CodeMirror's own pending
 * `requestMeasure` work to run, not just the browser's pending layout
 * (A4-013).
 *
 * `offsetHeight` above forces the *browser* to lay out whatever DOM
 * dispatch just produced; it does nothing for work CodeMirror itself has
 * scheduled through `requestMeasure` (`sticky.ts`'s panel is one such
 * consumer), which runs on the next animation frame and is never reached by
 * a tight synchronous loop of dispatches with no frame in between — proven
 * by instrumenting `sticky.ts`'s `paint` during a `typeOneCharacter` batch:
 * it ran zero times. `fastestKeystroke`'s loop is exactly that shape, so a
 * cost that lives entirely inside a `requestMeasure` write phase measured as
 * zero regardless of what it did, silently exempting it from this whole
 * suite.
 *
 * `EditorView.readMeasured` (CodeMirror's internal flush) runs synchronously
 * whenever something reads a value that depends on it while the view is
 * idle — `sticky.ts`'s own `topVisibleLine` uses exactly this path, through
 * `view.lineBlockAtHeight`. Calling the same method here forces the same
 * flush, so a keystroke measured through this function pays for whatever
 * `requestMeasure` scheduled, the way a real frame would.
 */
export function typeOneCharacterAndFlushMeasure(view: EditorView): void {
  typeOneCharacter(view);
  view.lineBlockAtHeight(0);
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
function calibrate(view: EditorView, type: (view: EditorView) => void): number {
  let batch = 8;
  for (let attempt = 0; attempt < 20; attempt++) {
    const started = performance.now();
    for (let i = 0; i < batch; i++) type(view);
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
 *
 * `type` defaults to `typeOneCharacter`; pass `typeOneCharacterAndFlushMeasure`
 * to also measure work CodeMirror does through `requestMeasure` rather than
 * synchronously inside `dispatch` — see that function's own comment for why
 * the two are not interchangeable.
 */
export function fastestKeystroke(
  view: EditorView,
  samples = 7,
  warmup = 20,
  type: (view: EditorView) => void = typeOneCharacter,
): number {
  for (let i = 0; i < warmup; i++) type(view);

  const batch = calibrate(view, type);

  let best = Infinity;
  for (let i = 0; i < samples; i++) {
    const started = performance.now();
    for (let k = 0; k < batch; k++) type(view);
    const elapsed = (performance.now() - started) / batch;
    if (elapsed < best) best = elapsed;
  }
  return best;
}

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import SearchPanel from '../src/ui/SearchPanel.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * The search panel renders the rows you can see.
 *
 * The same window the explorer got in
 * `docs/superpowers/specs/2026-08-20-explorer-virtualisation-design.md`, over
 * a list that is a better fit for it: `SearchService.rows()` is already flat
 * and ordered, and `.row` is one fixed height for a file header and a match
 * alike — which is the premise the index arithmetic rests on, so a stylesheet
 * that ever gave the two kinds different heights would invalidate it.
 *
 * Why it matters here more than there: `MAX_RESULTS` is 5000
 * (`services/search.ts:43`), every match is a row of several elements, and
 * they are appended while the search is still streaming. Unwindowed, this
 * suite's 600-row fixture put 600 rows and 3,800 elements in the list;
 * windowed over a 440px viewport, 36 rows and ~229 elements — and 36 is the
 * ceiling for that viewport however many results arrive.
 *
 * jsdom has no layout, so `clientHeight` is 0 and the panel deliberately
 * renders everything. One case below is about exactly that; every other one
 * stubs the height on `HTMLElement.prototype` **before mounting** and
 * dispatches a real `scroll` event, which is the same door the component's own
 * listeners use.
 *
 * **Before mounting is the load-bearing word**, and it was `giveHeight(list)`
 * *after* `setup` until 2026-08-28. That arrangement let every result stream
 * into an unwindowed list, which is quadratic — each batch re-renders the whole
 * list — and it reproduced a state the product never reaches, since a browser
 * has measured the viewport long before the first batch lands. Measured on the
 * 100-file fixture: 496 ms unwindowed against 54 ms windowed, 600 rendered
 * rows per batch against 36. Two tests in this file were timing out in loaded
 * parallel runs at ~5.2 s and ~6.0 s against the 5 s default; the whole suite
 * is now under 140 ms a test. The five mutation checks below were re-run
 * against the new harness, and two of them bite *more* tests than before.
 *
 * Mutation checks (each made the named test red, then reverted):
 * - `windowed` dropping its `viewportHeight > 0` guard → "an unmeasured
 *   viewport renders every row" (it rendered a window of nothing).
 * - `firstIndex` losing its `- OVERSCAN` → "scrolling renders the rows at that
 *   offset".
 * - the slice starting at 0 instead of `firstIndex` → the same test. At scroll
 *   offset 0 the two are identical, which is why the assertion that catches it
 *   is the scrolled one.
 * - `padTop` fixed at 0 → "the spacers place the window at the right offset".
 * - `aria-posinset` counting within the window rather than the whole list →
 *   "every rendered row knows its place in the whole list". Run twice: once
 *   mutating only the file-header branch and once mutating both, because the
 *   two kinds of row carry these attributes on separate branches of the
 *   markup. The header-only mutation survived the first version of that test,
 *   which asserted on the first rendered row alone — at that offset a match.
 * - `aria-setsize` reporting the window's length → the same test.
 * - `revealFocused`'s scroll-*down* branch removed → "arrowing past the bottom
 *   edge scrolls, and the focused row is rendered".
 * - `revealFocused`'s scroll-*up* branch removed → "arrowing above the top
 *   edge scrolls back up".
 * - `--nox-search-row-h` left off the container → "the row height the
 *   arithmetic uses is the one the CSS paints".
 */

const ROW_HEIGHT = 22;
const VIEWPORT = 440; // 20 rows
const OVERSCAN = 8;
const FILES = 100;
const MATCHES_PER_FILE = 5;
/** One header plus its matches. */
const ROWS_PER_FILE = MATCHES_PER_FILE + 1;
const TOTAL_ROWS = FILES * ROWS_PER_FILE;
/** Mirrors `MIN_ROWS_TO_WINDOW` in `SearchPanel.svelte`, as the constants above do. */
const MIN_ROWS_TO_WINDOW = 200;
/**
 * The fixture for the one test that must stay *unwindowed*.
 *
 * Smaller than `FILES` on purpose. Unwindowed streaming is quadratic — every
 * batch re-renders the whole list — so 600 rows cost ~500 ms where 240 cost
 * ~80 ms, and that test was one of the two that timed out under a loaded
 * parallel run. All it needs is to clear `MIN_ROWS_TO_WINDOW`, so that a
 * window *would* apply if the viewport were measured; the assertion below
 * checks it still does.
 */
const UNWINDOWED_FILES = 40;
const UNWINDOWED_ROWS = UNWINDOWED_FILES * ROWS_PER_FILE;

let mounted: Mounted | null = null;
let restoreViewport: (() => void) | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restoreViewport?.();
  restoreViewport = null;
});

/**
 * Make any `.results` container report a real height, as a browser does.
 *
 * On the prototype and applied **before mounting**, which is the whole point:
 * the panel is then windowed *while results stream in*, not merely after they
 * have all arrived. Measured, because that difference was worth 9x — a real
 * search over the 100-file fixture cost 496 ms unwindowed against 54 ms
 * windowed, rendering 600 rows per streamed batch instead of 36.
 *
 * It is also the more faithful arrangement. A browser has measured the
 * viewport long before the first batch lands; only jsdom reports 0, and
 * `giveHeight`-after-`setup` reproduced a state the product never reaches.
 */
function measureViewport(height = VIEWPORT): () => void {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList?.contains('results') ? height : 0;
    },
  });

  return () => {
    if (original) Object.defineProperty(HTMLElement.prototype, 'clientHeight', original);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
  };
}

async function settle() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  flush();
}

const pad = (n: number) => String(n).padStart(3, '0');

/**
 * `count` files of `MATCHES_PER_FILE` matching lines each, searched for real.
 *
 * A real `MemoryPlatform` walk rather than a seeded `results` signal: it is
 * the same streaming batch path the desktop build takes, which is the
 * condition the panel is slow under.
 */
async function setup(count: number, { measured = true } = {}) {
  // Before the mount, so streaming is windowed from the first batch.
  if (measured) restoreViewport = measureViewport();

  mounted = mountComponent(SearchPanel);
  const { app, platform, container } = mounted;

  for (let file = 0; file < count; file++) {
    const lines = Array.from(
      { length: MATCHES_PER_FILE },
      (_, m) => `needle f${pad(file)} m${m}`,
    );
    platform.seedFile(`/w/f${pad(file)}.ts`, `${lines.join('\n')}\n`);
  }

  await app.workspace.openFolder('/w');
  app.search.query.set('needle');
  await app.search.run();
  await settle();

  return { app, container, list: container.querySelector('.results') as HTMLElement };
}

function scrollTo(list: HTMLElement, top: number) {
  list.scrollTop = top;
  list.dispatchEvent(new Event('scroll'));
  flush();
}

/** The text the row at `index` must carry, derived from the seeded shape. */
function labelAt(index: number): string {
  const file = Math.floor(index / ROWS_PER_FILE);
  const within = index % ROWS_PER_FILE;
  return within === 0 ? `f${pad(file)}.ts` : `needle f${pad(file)} m${within - 1}`;
}

/** Every rendered row, in DOM order, by the same text `labelAt` predicts. */
function labels(list: HTMLElement): string[] {
  return [...list.querySelectorAll('.row')].map((row) => {
    const cell = row.querySelector(row.classList.contains('file') ? '.name' : '.preview');
    return cell?.textContent?.trim() ?? '';
  });
}

function press(list: HTMLElement, key: string) {
  list.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

describe('the search results window', () => {
  it('a small result set renders every row, windowing or not', async () => {
    const { list } = await setup(10);
    scrollTo(list, 0);

    expect(list.querySelectorAll('.row')).toHaveLength(10 * ROWS_PER_FILE);
    expect(list.querySelector('.spacer')).toBeNull();
  });

  it('an unmeasured viewport renders every row', async () => {
    // Unmeasured on purpose: this is jsdom as every other suite over this
    // component sees it, and the result set is well over the windowing
    // threshold. It is also the slow arrangement — see `measureViewport` —
    // which is affordable once, for the case that is actually about it.
    // Or the test proves nothing: below the threshold the panel renders
    // everything anyway, for a reason that has nothing to do with the viewport.
    expect(UNWINDOWED_ROWS).toBeGreaterThan(MIN_ROWS_TO_WINDOW);

    const { list } = await setup(UNWINDOWED_FILES, { measured: false });
    await settle();

    expect(list.querySelectorAll('.row')).toHaveLength(UNWINDOWED_ROWS);
  });

  it('a large result set with a measured viewport renders a window, not the list', async () => {
    const { list } = await setup(FILES);
    scrollTo(list, 0);

    const rows = list.querySelectorAll('.row');
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.length).toBeLessThan(60);
    expect(labels(list)[0]).toBe(labelAt(0));
  });

  it('the spacers place the window at the right offset', async () => {
    const { list } = await setup(FILES);
    scrollTo(list, 100 * ROW_HEIGHT);

    const spacers = [...list.querySelectorAll<HTMLElement>('.spacer')];
    expect(spacers).toHaveLength(2);

    const top = Number.parseInt(spacers[0]!.style.height, 10);
    const bottom = Number.parseInt(spacers[1]!.style.height, 10);
    const rows = list.querySelectorAll('.row').length;

    expect(top).toBe((100 - OVERSCAN) * ROW_HEIGHT);
    expect(top + rows * ROW_HEIGHT + bottom).toBe(TOTAL_ROWS * ROW_HEIGHT);
  });

  it('scrolling renders the rows at that offset', async () => {
    const { list } = await setup(FILES);
    scrollTo(list, 0);
    expect(labels(list)).toContain(labelAt(0));

    scrollTo(list, 300 * ROW_HEIGHT);

    expect(labels(list)).not.toContain(labelAt(0));
    // Both kinds of row, so a slice that lost the header rows would show here.
    expect(labels(list)).toContain(labelAt(300));
    expect(labels(list)).toContain(labelAt(303));
    expect(labels(list)[0]).toBe(labelAt(300 - OVERSCAN));
  });

  it('every rendered row knows its place in the whole list', async () => {
    const { list } = await setup(FILES);
    scrollTo(list, 300 * ROW_HEIGHT);

    const rows = [...list.querySelectorAll('.row')];
    // Every row, not just the first: the two kinds carry the attributes on
    // separate branches of the markup, and an assertion on `.row:first-child`
    // only ever lands on one of them. A mutation that broke the file-header
    // branch alone survived that version of this test.
    expect(rows.some((row) => row.classList.contains('file'))).toBe(true);
    expect(rows.some((row) => row.classList.contains('match'))).toBe(true);
    expect(rows.map((row) => row.getAttribute('aria-setsize'))).toEqual(
      rows.map(() => String(TOTAL_ROWS)),
    );
    expect(rows.map((row) => row.getAttribute('aria-posinset'))).toEqual(
      rows.map((_, i) => String(300 - OVERSCAN + i + 1)), // 1-based, in the whole list
    );
  });

  it('arrowing past the bottom edge scrolls, and the focused row is rendered', async () => {
    const { app, list } = await setup(FILES);
    scrollTo(list, 0);

    // Land the focus well below the window, the way holding ↓ would.
    app.search.focused.set(100);
    press(list, 'ArrowDown');
    await settle();

    expect(app.search.focused.get()).toBe(101);
    expect(list.scrollTop).toBeGreaterThan(0);
    expect(labels(list)).toContain(labelAt(101));
  });

  it('arrowing above the top edge scrolls back up', async () => {
    const { app, list } = await setup(FILES);
    scrollTo(list, 300 * ROW_HEIGHT);

    app.search.focused.set(100);
    press(list, 'ArrowUp');
    await settle();

    expect(list.scrollTop).toBeLessThan(300 * ROW_HEIGHT);
    expect(labels(list)).toContain(labelAt(99));
  });

  it('collapsing a file from the keyboard works with the row off the window', async () => {
    const { app, list } = await setup(FILES);
    scrollTo(list, 0);

    // Index 300 is a file header — six rows per file, so every multiple is.
    const header = `/w/f${pad(300 / ROWS_PER_FILE)}.ts`;
    app.search.focused.set(300);
    await settle();

    press(list, 'ArrowLeft');
    await settle();
    expect(app.search.collapsed.get().has(header)).toBe(true);
    expect(labels(list)).toContain(`f${pad(300 / ROWS_PER_FILE)}.ts`);
    expect(list.querySelectorAll('.row').length).toBeLessThan(60);

    press(list, 'ArrowRight');
    await settle();
    expect(app.search.collapsed.get().has(header)).toBe(false);
  });

  it('arrowing up off the first row returns focus to the query input', async () => {
    const { app, container, list } = await setup(FILES);
    scrollTo(list, 300 * ROW_HEIGHT);

    app.search.focused.set(0);
    await settle();
    press(list, 'ArrowUp');
    await settle();

    expect(app.search.focused.get()).toBe(-1);
    expect(document.activeElement).toBe(container.querySelector('input[aria-label="Search project"]'));
  });

  it('the row height the arithmetic uses is the one the CSS paints', async () => {
    const { list } = await setup(2);

    expect(list.style.getPropertyValue('--nox-search-row-h')).toBe(`${ROW_HEIGHT}px`);
  });
});

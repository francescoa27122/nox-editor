import { browser, $, $$, expect } from '@wdio/globals';

/**
 * The in-window menu bar, driven.
 *
 * Production readiness §5 names this as the specific risk it leaves behind:
 * *"Off macOS there is still no native menu … the in-window bar that stands in
 * for it is three days old and has already produced two defects. That is the
 * freshest code in the product sitting on the least-verified platform."* Both
 * platforms that depend on it — Windows and Linux — had never been walked at
 * all.
 *
 * The specs below are the pointer half of that, because the pointer half is
 * where both defects were. Neither asserts geometry: `smoke.e2e.js` explains
 * why at length, and one of the two defects this file guards was *found* by
 * measuring geometry in a browser, which is a thing to do once by hand rather
 * than forever in CI.
 */

const MAC = process.platform === 'darwin';

async function waitForBoot() {
  await $('.nox-shell').waitForExist({ timeout: 60_000 });
  await $('.nox-statusbar').waitForExist({ timeout: 60_000 });
}

/** Shut any open menu, without relying on the thing under test. */
async function closeAnyMenu() {
  if (await $('.menu').isExisting()) {
    await browser.keys(['Escape']);
    await $('.menu')
      .waitForExist({ reverse: true, timeout: 5_000 })
      .catch(() => {});
  }
}

describe('the in-window menu bar', function () {
  before(async function () {
    // macOS gets a real NSMenu and draws no bar at all; `smoke.e2e.js` pins
    // that absence. There is nothing here to drive.
    if (MAC) this.skip();
    await waitForBoot();
  });

  afterEach(async () => {
    await closeAnyMenu();
  });

  it('opens a menu with items in it', async () => {
    const titles = await $$('.menu-title');
    expect(titles.length).toBeGreaterThan(0);

    await titles[0].click();
    await $('.menu').waitForExist({ timeout: 10_000 });

    // Something to click, not merely a panel. A menu built from an empty
    // command table would still draw the box.
    const items = await $$('.menu .item');
    expect(items.length).toBeGreaterThan(0);
    await expect(titles[0]).toHaveAttribute('aria-expanded', 'true');
  });

  /**
   * **The regression this file exists for.**
   *
   * `7389643`: sliding from File to Edit did nothing, and clicking a second
   * title dismissed instead of switching. `ContextMenu`'s click-away layer is
   * `position: fixed; inset: 0`, so it covered the titles along with
   * everything else and ate every pointer event aimed at one. The bar had had
   * the `onmouseenter` for this since it was written, under a comment calling
   * it "the reason a bar feels like a bar"; it had never once run.
   *
   * The observable is the one the fix's own commit message recorded:
   * `aria-expanded` stayed false on the second title with the first open. So
   * that is what this asserts, and it needs no geometry to do it.
   */
  it('switches to a second menu when its title is clicked', async () => {
    const titles = await $$('.menu-title');
    // Two titles, or there is nothing to switch between. Every platform that
    // draws this bar has at least File and Edit.
    expect(titles.length).toBeGreaterThan(1);

    await titles[0].click();
    await $('.menu').waitForExist({ timeout: 10_000 });
    await expect(titles[0]).toHaveAttribute('aria-expanded', 'true');

    await titles[1].click();

    await browser.waitUntil(async () => (await titles[1].getAttribute('aria-expanded')) === 'true', {
      timeout: 10_000,
      timeoutMsg: 'the second title never opened — the click-away layer is covering the bar again',
    });
    await expect(titles[0]).toHaveAttribute('aria-expanded', 'false');
    await expect($('.menu')).toBeExisting();
  });

  /**
   * Clicking the open title again closes it. The same click-away layer made
   * this ambiguous: the dismiss and the toggle both fired, and which won was
   * a matter of ordering rather than intent.
   */
  it('closes the menu when its own title is clicked again', async () => {
    const titles = await $$('.menu-title');

    await titles[0].click();
    await $('.menu').waitForExist({ timeout: 10_000 });

    await titles[0].click();

    await $('.menu').waitForExist({ reverse: true, timeout: 10_000 });
    await expect(titles[0]).toHaveAttribute('aria-expanded', 'false');
  });

  /**
   * Escape, which the manual walk could never send — it is the computer-use
   * harness's own abort key and never reached the app. The bar itself must
   * survive; a dismiss that took the menu bar with it would leave the window
   * with no menu at all on the two platforms that have no other one.
   */
  it('closes on Escape and leaves the bar behind', async () => {
    const titles = await $$('.menu-title');

    await titles[0].click();
    await $('.menu').waitForExist({ timeout: 10_000 });

    await browser.keys(['Escape']);

    await $('.menu').waitForExist({ reverse: true, timeout: 10_000 });
    await expect($('.menu-bar')).toBeExisting();
    expect((await $$('.menu-title')).length).toBe(titles.length);
  });
});

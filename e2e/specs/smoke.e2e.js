import { browser, $, $$, expect } from '@wdio/globals';

/**
 * The packaged app, driven rather than looked at.
 *
 * Every assertion here is something no prior verification of Nox could make.
 * The desktop walk on file covered macOS only, marked 12 of its 17 items
 * UNSEEN, and reported two defects that were later traced to the walk harness
 * itself. Linux and Windows ship installers that nobody has ever launched.
 *
 * Deliberately **no geometry**. jsdom tests in this repository are forbidden
 * from claiming anything positional (`tests/support/jsdom-layout.ts` says so
 * at length), and a WebDriver suite that asserted on pixel positions would be
 * the flakiest thing in CI for the least return. These assert on existence,
 * text, and state transitions — the things that are either true or not.
 */

/** The shell is up when its root and the editor surface both exist. */
async function waitForBoot() {
  await $('.nox-shell').waitForExist({ timeout: 60_000 });
  // Not the shell alone: the shell renders before the session has restored,
  // and a spec that raced that would be asserting against a half-built app.
  await $('.nox-statusbar').waitForExist({ timeout: 60_000 });
}

describe('the packaged app', () => {
  before(async () => {
    await waitForBoot();
  });

  it('launches and draws its chrome', async () => {
    await expect($('.nox-shell')).toBeExisting();
    await expect($('.nox-titlebar')).toBeExisting();
    await expect($('.nox-statusbar')).toBeExisting();
  });

  /**
   * The in-window menu bar is drawn by Nox on Windows and Linux because those
   * platforms get no native menu — `menu.rs` returns `Ok(())` off macOS. It
   * is also the newest code in the product and has already produced two
   * defects, which makes "does it exist on the platforms that depend on it"
   * a question worth asking automatically.
   */
  it('draws the in-window menu bar off macOS', async () => {
    await expect($('.menu-bar')).toBeExisting();
    const titles = await $$('.menu-title');
    expect(titles.length).toBeGreaterThan(0);
  });
});

describe('the command palette', () => {
  before(async () => {
    await waitForBoot();
  });

  afterEach(async () => {
    // Leave no palette open for the next spec. Escape is the subject of one
    // of these tests, so this cannot rely on it having worked.
    if (await $('.palette').isExisting()) {
      await browser.keys(['Escape']);
      await $('.palette').waitForExist({ reverse: true, timeout: 5_000 }).catch(() => {});
    }
  });

  it('opens on its chord and filters what it lists', async () => {
    await browser.keys(['Control', 'Shift', 'p']);
    await $('.palette').waitForExist({ timeout: 15_000 });

    await browser.keys('settings');
    await browser.waitUntil(async () => (await $$('.palette .row')).length > 0, {
      timeout: 10_000,
      timeoutMsg: 'the palette listed nothing for "settings"',
    });

    const rows = await $$('.palette .row');
    expect(rows.length).toBeGreaterThan(0);
  });

  /**
   * **The assertion this whole harness was built for.**
   *
   * The manual walk could never make it. Escape is the computer-use
   * harness's own user-abort key and was eaten at the OS level before any app
   * saw it — which is half of why BUG-1 was reported as a confirmed defect
   * against code that was fine. A keystroke Nox binds globally
   * (`app.ts:4065`, `Escape` → `view.dismiss`) had no verification path on
   * the desktop at all. It has one now.
   */
  it('closes on Escape, which no manual walk could ever verify', async () => {
    await browser.keys(['Control', 'Shift', 'p']);
    await $('.palette').waitForExist({ timeout: 15_000 });
    await expect($('.palette')).toBeExisting();

    await browser.keys(['Escape']);

    await $('.palette').waitForExist({ reverse: true, timeout: 10_000 });
    await expect($('.palette')).not.toBeExisting();
  });
});

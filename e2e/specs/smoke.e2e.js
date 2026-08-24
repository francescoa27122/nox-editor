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

/**
 * Which platform the app is running on.
 *
 * `process.platform` rather than `browser.capabilities`: the worker and the
 * app are the same machine in every configuration this harness supports, and
 * this is the value that decides what the *app* does — `platform/host.ts`
 * makes the same call from `navigator` and hands the answer to the keymap.
 */
const MAC = process.platform === 'darwin';

/**
 * `Mod`, spelled the way this host spells it.
 *
 * `services/keymap.ts` resolves `Mod` through `isMacHost`, so the palette
 * answers to ⌘⇧P on macOS and Ctrl+Shift+P everywhere else. Sending the wrong
 * one does not fail loudly — the keystroke simply goes nowhere and the panel
 * never opens, which is how this first showed up: a fifteen-second wait for a
 * `.palette` that was never asked for.
 */
const MOD = MAC ? 'Meta' : 'Control';

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
   * Where the menu lives is a platform contract, and this pins both halves.
   *
   * Windows and Linux get no native menu, so Nox draws its own in the window
   * — the newest code in the product, which has already produced two defects.
   * macOS gets a real `NSMenu`, and `TitleBar.svelte` reads
   * `capabilities.applicationMenu` to decide, so the in-window bar must be
   * *absent* there rather than merely unused. Two bars claiming the same
   * commands is the failure this direction guards.
   *
   * The macOS half can only assert the absence: WebDriver sees the webview,
   * and an `NSMenu` is not in it.
   */
  it('draws its own menu bar only where the OS gives it no native one', async () => {
    if (MAC) {
      await expect($('.menu-bar')).not.toBeExisting();
      return;
    }

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
    await browser.keys([MOD, 'Shift', 'p']);
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
    await browser.keys([MOD, 'Shift', 'p']);
    await $('.palette').waitForExist({ timeout: 15_000 });
    await expect($('.palette')).toBeExisting();

    await browser.keys(['Escape']);

    await $('.palette').waitForExist({ reverse: true, timeout: 10_000 });
    await expect($('.palette')).not.toBeExisting();
  });
});

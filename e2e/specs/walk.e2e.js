import { browser, $, $$, expect } from '@wdio/globals';

/**
 * Three of the twelve items the 2026-08-20 desktop walk marked **UNSEEN**.
 *
 * The walk was cut short by machine contention — its own log says *"most
 * computer-use batches aborted with 'user interrupt'"* — and the controller
 * reduced scope to five items, all five of which also aborted. Production
 * readiness §1's fix reads: *"Port the 17-item walk script into it, so the
 * twelve UNSEEN rows become assertions rather than intentions."* These are
 * A4, C5 and C8.
 *
 * The three left here are the ones a *packaged app* can answer. Several of the
 * remaining nine are style contracts (B1, B3, C4 — "one header style", "one
 * button family", "overflow fades"), which belong in a stylesheet test beside
 * `tests/component-css-tokens.test.ts` rather than in a WebDriver run that is
 * forbidden from measuring anything. Two more (C7, C9) need a workspace on
 * disk with a git repository in it, and L1 needs a language server installed
 * on the runner.
 */

const MAC = process.platform === 'darwin';
const MOD = MAC ? 'Meta' : 'Control';

async function waitForBoot() {
  await $('.nox-shell').waitForExist({ timeout: 60_000 });
  await $('.nox-statusbar').waitForExist({ timeout: 60_000 });
}

/** The status-bar item that reads `LF` or `CRLF`. */
async function lineEndingButton() {
  const buttons = await $$('.nox-statusbar button');
  for (const button of buttons) {
    const text = (await button.getText()).trim();
    if (text === 'LF' || text === 'CRLF') return button;
  }
  return null;
}

/** Close the active buffer, discarding changes if it asks. */
async function discardActiveBuffer() {
  await browser.keys([MOD, 'w']);
  if (await $('.confirm').isExisting()) {
    const buttons = await $$('.confirm .actions button');
    for (const button of buttons) {
      if ((await button.getText()).trim() === "Don't Save") {
        await button.click();
        break;
      }
    }
    await $('.confirm')
      .waitForExist({ reverse: true, timeout: 5_000 })
      .catch(() => {});
  }
}

describe('A4 — the destructive confirm', () => {
  before(async () => {
    await waitForBoot();
  });

  /**
   * The walk item: *"Destructive confirm dialog focuses SAFE button — UNSEEN.
   * Never reached: blocked by user-input contention, then scope cut."*
   *
   * `tests/confirm-dialog.test.ts` already pins which choice is *chosen* as
   * the default. What only a real window can say is that focus actually
   * landed there — that Enter, pressed by someone who did not read the
   * dialog, does not discard their work. `ConfirmDialog`'s own comment puts it
   * as "Enter must never destroy, and it must never grant a capability."
   */
  it('puts focus on a safe choice, never the destructive one', async () => {
    await browser.keys([MOD, 'n']);
    await $('.tab').waitForExist({ timeout: 15_000 });

    // Dirty it without driving CodeMirror: an end-of-line switch changes what
    // a save would write, so `isDirty` goes true on its own. That is walk item
    // C5 doing the setup for walk item A4.
    const eol = await lineEndingButton();
    expect(eol).not.toBe(null);
    await eol.click();
    await $('.tab.dirty').waitForExist({ timeout: 10_000 });

    await browser.keys([MOD, 'w']);
    await $('.confirm').waitForExist({ timeout: 10_000 });

    const focusedIsDangerous = await browser.execute(
      () => document.activeElement?.classList.contains('danger') ?? null,
    );
    const focusedLabel = await browser.execute(
      () => document.activeElement?.textContent?.trim() ?? null,
    );

    expect(focusedIsDangerous).toBe(false);
    // And it really is a choice in this dialog, not some other focused thing.
    expect(['Save', 'Cancel']).toContain(focusedLabel);

    await discardActiveBuffer();
  });
});

describe('C5 — the line-ending item', () => {
  before(async () => {
    await waitForBoot();
  });

  /**
   * The walk item: *"Status-bar EOL click flips LF/CRLF + immediate dirty dot
   * — UNSEEN, scope cut by controller (both attempts aborted)."*
   *
   * Both halves matter and the second is the interesting one. An end-of-line
   * change alters what a save writes without touching the document, so a
   * dirty marker driven by document changes alone would stay clean and the
   * change would be lost at the next close with no prompt.
   */
  it('flips the label and marks the buffer dirty', async () => {
    await browser.keys([MOD, 'n']);
    await $('.tab').waitForExist({ timeout: 15_000 });

    const before = (await (await lineEndingButton()).getText()).trim();
    await (await lineEndingButton()).click();

    await browser.waitUntil(
      async () => (await (await lineEndingButton()).getText()).trim() !== before,
      { timeout: 10_000, timeoutMsg: `the line-ending item never moved from ${before}` },
    );

    const after = (await (await lineEndingButton()).getText()).trim();
    expect([before, after].sort()).toEqual(['CRLF', 'LF']);
    await expect($('.tab.dirty')).toBeExisting();

    await discardActiveBuffer();
  });
});

describe('C8 — the sidebar chord', () => {
  before(async () => {
    await waitForBoot();
  });

  /**
   * The walk item: *"Rail collapse/⌘B/References icon — UNSEEN, scope cut by
   * controller (both attempts aborted)."*
   *
   * Written to restore whatever it found rather than to assume a starting
   * state: `workbench.showExplorer` is a **persisted setting**, so the app
   * comes up however the last run left it, and a spec that assumed "open"
   * would pass or fail on the order the suite happened to run in.
   */
  it('toggles the sidebar, both ways', async () => {
    const wasOpen = await $('.nox-sidebar').isExisting();

    await browser.keys([MOD, 'b']);
    await browser.waitUntil(async () => (await $('.nox-sidebar').isExisting()) !== wasOpen, {
      timeout: 10_000,
      timeoutMsg: 'Mod+B did not toggle the sidebar',
    });

    await browser.keys([MOD, 'b']);
    await browser.waitUntil(async () => (await $('.nox-sidebar').isExisting()) === wasOpen, {
      timeout: 10_000,
      timeoutMsg: 'Mod+B did not toggle the sidebar back',
    });
  });
});

import { browser, $, $$, expect } from '@wdio/globals';

/**
 * The tab strip's context menu — walk item **C1**, one of the twelve the
 * 2026-08-20 desktop walk marked UNSEEN.
 *
 * Its note reads: *"UNSEEN, scope cut by controller (both attempts aborted by
 * user-input interrupts)"*, and C2 below it was blocked because it depended on
 * this menu. A right-click is exactly the kind of input that walk could not
 * reliably deliver, which is the argument for asserting it here instead of
 * intending it again.
 *
 * No geometry, as everywhere in this directory. A context menu's *position* is
 * the one thing about it worth measuring and the one thing a CI suite should
 * not: `core/menu-placement.ts` owns that decision and has its own tests.
 */

const MAC = process.platform === 'darwin';
const MOD = MAC ? 'Meta' : 'Control';

async function waitForBoot() {
  await $('.nox-shell').waitForExist({ timeout: 60_000 });
  await $('.nox-statusbar').waitForExist({ timeout: 60_000 });
}

describe('the tab context menu', () => {
  before(async () => {
    await waitForBoot();
  });

  beforeEach(async () => {
    // A buffer of this spec's own. The packaged app starts with no folder on a
    // fresh runner, so nothing can be assumed to be open — and an untitled
    // scratch buffer needs no disk, which keeps this spec from depending on a
    // workspace fixture it would then have to clean up.
    await browser.keys([MOD, 'n']);
    await $('.tab').waitForExist({ timeout: 15_000 });
  });

  afterEach(async () => {
    if (await $('.menu').isExisting()) {
      await browser.keys(['Escape']);
      await $('.menu')
        .waitForExist({ reverse: true, timeout: 5_000 })
        .catch(() => {});
    }
    // Untitled and unmodified, so this closes without a prompt. Leaving tabs
    // behind would make every later spec depend on how many ran before it.
    await browser.keys([MOD, 'w']);
  });

  it('opens on a right-click, with its full set of entries', async () => {
    await $('.tab').click({ button: 'right' });
    await $('.menu').waitForExist({ timeout: 10_000 });

    const elements = await $$('.menu .item .label');
    const labels = [];
    for (const element of elements) labels.push((await element.getText()).trim());

    // The entries the walk went looking for and never saw. Named rather than
    // counted: a count passes just as happily when the wrong seven are there.
    // `Reveal in Explorer` is left out on purpose — it is the one that depends
    // on the buffer having a path, and this spec's buffer is untitled.
    for (const label of [
      'Close',
      'Close Others',
      'Close to the Right',
      'Close Saved',
      'Copy Path',
      'Split Editor',
    ]) {
      expect(labels).toContain(label);
    }
  });

  /**
   * The hints are half of what the walk item asked for — "7-item menu with
   * hints" — and they are not decoration. `MenuBar` and this menu both read
   * the chord from the keymap rather than spelling it, because
   * `keybindings.json` supports `remove` rules and every default binding is
   * reachably unbound; a hardcoded hint would eventually name a key that does
   * nothing. Asserting one exists is asserting that path ran.
   */
  it('shows the keyboard shortcut beside an entry that has one', async () => {
    await $('.tab').click({ button: 'right' });
    await $('.menu').waitForExist({ timeout: 10_000 });

    const hints = await $$('.menu .item .hint');
    expect(hints.length).toBeGreaterThan(0);
  });

  it('closes on Escape without acting on anything', async () => {
    const before = (await $$('.tab')).length;

    await $('.tab').click({ button: 'right' });
    await $('.menu').waitForExist({ timeout: 10_000 });
    await browser.keys(['Escape']);
    await $('.menu').waitForExist({ reverse: true, timeout: 10_000 });

    // Dismissing a menu must not run the entry the pointer happened to be
    // over, which is the failure mode a menu that closed on *any* key would
    // have.
    expect((await $$('.tab')).length).toBe(before);
  });
});

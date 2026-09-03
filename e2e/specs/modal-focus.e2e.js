import { browser, $, expect } from '@wdio/globals';

/**
 * Focus cannot reach the app behind a modal.
 *
 * **The claim being checked is `CONTRIBUTING.md:211`**: "Overlays trap focus
 * and are dismissible with Esc". Escape has been checked since
 * `smoke.e2e.js`. The trap had never been checked anywhere, and a UI review on
 * 2026-08-30 found it did not exist: five components declared
 * `aria-modal="true"` and only the command palette handled `Tab`, so in the
 * other four a keyboard user tabbed out of the dialog into the title bar, the
 * sidebar and the editor, all of which stayed focusable behind the scrim.
 *
 * The fix is one `inert` on `.nox-shell` while a modal is up, which works
 * because `Overlays` is a sibling of the shell rather than a child.
 *
 * **Why this is here and not in `tests/`.** `tests/modal-inert.test.ts` holds
 * the attribute to the condition, which is the half that rots, and it is all
 * jsdom can do: jsdom implements the `inert` *property* and none of its
 * behaviour, so a jsdom test asserting "focus did not reach the editor" would
 * pass against an element that was never inert at all. Whether focus actually
 * moves is a question for a real focus implementation, and this harness has
 * three of them.
 *
 * **Why `focus()` and not `Tab`.** The first version of this file pressed Tab
 * and asserted focus had not left the dialog, which is the way a person would
 * hit the bug. It passed on WebKitGTK against a build with the fix reverted,
 * so it was measured rather than trusted: a 30-press trail printed the same
 * element 30 times. This harness's synthetic key events do not drive the
 * browser's focus navigation at all here, so **a Tab test cannot fail**,
 * whether the trap works or not. Calling `focus()` on each control behind the
 * scrim asks the same question through a path the harness does have, and it
 * is the same mechanism: `inert` makes a subtree unfocusable, which is *why*
 * Tab cannot land there. Mutation-checked in both directions on 2026-08-31,
 * with `inert={modalOpen}` removed from `App.svelte` and the app rebuilt:
 * every case here goes red, and every one is green with it back.
 *
 * It also answers a question this container cannot on its own: `inert` needs
 * WebKit 2.38 and up for the Linux and macOS webviews. The first case checks
 * the engine rather than the app, so a platform in the matrix that lacks it
 * says so instead of reporting a focus failure.
 */

const MAC = process.platform === 'darwin';
const MOD = MAC ? 'Meta' : 'Control';

async function waitForBoot() {
  await $('.nox-shell').waitForExist({ timeout: 60_000 });
  await $('.nox-statusbar').waitForExist({ timeout: 60_000 });
}

/**
 * Try to focus every control behind the scrim, and report the ones that took it.
 *
 * Every one rather than a sample, because the shell is several components and
 * a partial trap is the failure this is about. Reported with element names so
 * a red run says which control was reachable rather than only that one was.
 *
 * The count comes back too: if a change ever renders a shell with nothing
 * focusable in it, this would pass by having nothing to prove, and the count
 * is what catches that.
 */
async function reachableBehindTheScrim() {
  return browser.execute(() => {
    const shell = document.querySelector('.nox-shell');
    if (!shell) return { candidates: 0, reachable: ['no shell'] };

    const controls = [...shell.querySelectorAll('button, input, select, textarea, [tabindex]')];
    const reachable = [];
    for (const control of controls) {
      control.focus();
      if (document.activeElement === control) {
        reachable.push(`${control.tagName}.${String(control.className)}`.slice(0, 60));
      }
    }
    return { candidates: controls.length, reachable };
  });
}

/** Whether the shell is inert, read the way the platform reflects it. */
async function shellState() {
  return browser.execute(() => {
    const shell = document.querySelector('.nox-shell');
    return {
      property: !!(shell && shell.inert),
      attribute: shell ? shell.getAttribute('inert') !== null : false,
    };
  });
}

describe('a modal and the app behind it', () => {
  before(async () => {
    await waitForBoot();
  });

  afterEach(async () => {
    await browser.keys(['Escape']);
    await $('.scrim')
      .waitForExist({ reverse: true, timeout: 5_000 })
      .catch(() => {});
  });

  /**
   * The platform question, asked first so a webview without `inert` fails
   * naming `inert` rather than naming focus.
   *
   * Attribute reflection is the check rather than `'inert' in element`,
   * because `element.inert = true` on an engine that does not implement it
   * silently creates an ordinary property that then reads back as `true`. An
   * engine that reflects the assignment to an attribute has the real one.
   */
  it('runs on a webview that implements inert', async () => {
    const support = await browser.execute(() => {
      const probe = document.createElement('div');
      probe.inert = true;
      return 'inert' in HTMLElement.prototype && probe.getAttribute('inert') === '';
    });
    expect(support ? 'implemented' : 'this webview does not implement inert').toBe('implemented');
  });

  it('marks the shell inert while a modal is up', async () => {
    await browser.keys([MOD, 'Shift', 'p']);
    await $('.palette').waitForExist({ timeout: 15_000 });

    expect(await shellState()).toEqual({ property: true, attribute: true });
  });

  /**
   * The command palette is the one dialog that already trapped `Tab` by hand,
   * so it is the control: it was the only one that behaved before the fix and
   * must still behave after it.
   */
  it('makes the app unreachable behind the command palette', async () => {
    await browser.keys([MOD, 'Shift', 'p']);
    await $('.palette').waitForExist({ timeout: 15_000 });

    const { candidates, reachable } = await reachableBehindTheScrim();
    expect(candidates).toBeGreaterThan(0);
    expect(reachable).toEqual([]);
  });

  /**
   * Settings is one of the four that did not, and the widest: it is a whole
   * screen of controls rather than a single input, so it is the one where a
   * trap that only covered the dialog's own subtree would show.
   */
  it('makes the app unreachable behind the settings dialog', async () => {
    await browser.keys([MOD, ',']);
    await $('.settings').waitForExist({ timeout: 15_000 });

    const { candidates, reachable } = await reachableBehindTheScrim();
    expect(candidates).toBeGreaterThan(0);
    expect(reachable).toEqual([]);
  });

  /** And the app comes back when the modal goes away. */
  it('gives the app back once the modal closes', async () => {
    await browser.keys([MOD, 'Shift', 'p']);
    await $('.palette').waitForExist({ timeout: 15_000 });
    expect((await shellState()).property).toBe(true);

    await browser.keys(['Escape']);
    await $('.palette').waitForExist({ reverse: true, timeout: 10_000 });

    expect((await shellState()).property).toBe(false);
    // Not merely "not inert": the controls are focusable again. A shell that
    // lost its `inert` attribute and stayed unreachable for some other reason
    // would be the same defect wearing the fix's clothes.
    expect((await reachableBehindTheScrim()).reachable.length).toBeGreaterThan(0);
  });
});

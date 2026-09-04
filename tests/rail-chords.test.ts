// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import App from '../src/ui/App.svelte';
import { MemoryPlatform } from '../src/platform/memory';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * Every icon in the sidebar rail names its shortcut.
 *
 * The rail is seven unlabelled icons, so the tooltip is the only place a
 * keyboard-first editor gets to teach the chord that opens each panel. Six of
 * them did. Git read `"Git"` and nothing more — the sidebar scheme is
 * `Mod+Shift+<letter>` and every panel had one except the one whose obvious
 * letter, `G`, was held by `edit.findPrevious`.
 *
 * That is now `git.focus`, and Find Previous keeps `Shift+F3` — the symmetric
 * half of `F3`, so that pair stays whole. What it costs is the shifted half of
 * macOS's `⌘G` pair (A1-007 gave `Ctrl+G` to Go to Line off macOS, so there
 * is no pair to halve there), and one line of `keybindings.json` takes it
 * back.
 *
 * A table-wide assertion rather than one about Git, for the same reason
 * `command-titles.test.ts` gives: each tooltip is individually plausible, and
 * nothing had ever looked at the row as a whole. The eighth panel that lands
 * without a chord fails here instead of being noticed in a walk months later.
 *
 * `chordFrom` is why this is asserted on the *rendered tooltip* rather than on
 * the keybinding table: References deliberately has no chord of its own —
 * `Shift+F12` already fills and shows it — and borrows that command's. Reading
 * the binding table would call that a gap; reading the tooltip sees what the
 * user sees.
 */

let panel: Mounted | null = null;

afterEach(() => {
  panel?.unmount();
  panel = null;
});

describe('the sidebar rail', () => {
  it('names a shortcut on every icon', () => {
    const app = new NoxApp(new MemoryPlatform());
    panel = mountComponent(App, { app, props: { app } });
    flush();

    const buttons = [...panel.container.querySelectorAll('.rail-button')];
    // A rail that rendered nothing would pass every assertion below.
    expect(buttons.length).toBeGreaterThanOrEqual(6);

    for (const button of buttons) {
      const label = button.getAttribute('aria-label') ?? '(unlabelled)';
      const title = button.getAttribute('title') ?? '';
      expect(title, `the ${label} rail icon should name its chord`).toMatch(/\(.+\)$/);
    }
  });

  it('gives Git the letter its scheme was missing', () => {
    const app = new NoxApp(new MemoryPlatform());
    panel = mountComponent(App, { app, props: { app } });
    flush();

    const git = [...panel.container.querySelectorAll('.rail-button')].find(
      (button) => button.getAttribute('aria-label') === 'Git',
    );

    expect(git).toBeDefined();
    // Not the exact string: `Mod` renders as ⌘ or Ctrl by host, and this suite
    // must not care which machine it runs on.
    expect(git!.getAttribute('title')).toMatch(/^Git \(.*Shift\+G\)$/);
  });

  /**
   * The other half of the trade, asserted so it cannot be quietly lost: Find
   * Previous still has a chord, and it is the one that keeps the F-key pair
   * symmetric with Find Next.
   */
  it('leaves Find Previous reachable after taking its chord', () => {
    const app = new NoxApp(new MemoryPlatform());

    expect(app.keymap.displayFor('edit.findPrevious')).not.toBeNull();
    expect(app.keymap.displayFor('edit.findNext')).not.toBeNull();
  });
});

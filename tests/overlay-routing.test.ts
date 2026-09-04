// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import App from '../src/ui/App.svelte';
import { MemoryPlatform } from '../src/platform/memory';
import type { OverlayKind } from '../src/services/ui';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * Every overlay kind renders something.
 *
 * The bug this exists for: `Overlays.svelte` decides which kinds are the
 * multiplexed palette with a hand-written `||` chain, and everything not in
 * that chain falls through to `settings`, `keybindings`, and then nothing at
 * all. Adding `language` to the `OverlayKind` union, opening it from a
 * command, and giving `CommandPalette` a mode for it **compiles perfectly**
 * and puts no overlay on screen. It was found by clicking the control in a
 * browser, which is not a reliable way to find things.
 *
 * The same shape as `SETTING_TO_COMPARTMENTS` in `editor/extensions.ts`,
 * which the CodeMirror notes call out as the likeliest mistake there: a
 * mapping the compiler does not check, whose omission is silence rather than
 * an error.
 *
 * `EVERY_KIND` is a `Record<OverlayKind, …>` on purpose. A new kind fails to
 * compile here until it is listed, and listing it runs it through the
 * assertion below — so the union and this suite cannot drift apart.
 */

let panel: Mounted | null = null;

afterEach(() => {
  panel?.unmount();
  panel = null;
});

/**
 * What proves a kind reached the screen.
 *
 * Most kinds are the palette. The two that are not render their own panel,
 * and are named here rather than lumped in, because "an overlay appeared" is
 * a weaker claim than "the *right* overlay appeared" — and the failure this
 * suite is about is precisely a kind quietly rendering the wrong nothing.
 */
const EVERY_KIND: Record<OverlayKind, string> = {
  palette: '.palette',
  'quick-open': '.palette',
  buffers: '.palette',
  'go-to-line': '.palette',
  'go-to-symbol': '.palette',
  'git-branch': '.palette',
  'code-action': '.palette',
  'note-open': '.palette',
  'task-run': '.palette',
  language: '.palette',
  recent: '.palette',
  settings: '.settings',
  keybindings: '.keys',
};

describe('opening an overlay', () => {
  for (const [kind, selector] of Object.entries(EVERY_KIND) as [OverlayKind, string][]) {
    it(`puts ${kind} on screen`, async () => {
      const app = new NoxApp(new MemoryPlatform());
      panel = mountComponent(App, { app, props: { app } });
      flush();

      app.ui.openOverlay(kind);
      await Promise.resolve();
      flush();

      expect(
        panel.container.querySelector(selector),
        `opening "${kind}" rendered no ${selector} — check the isPalette chain in Overlays.svelte`,
      ).not.toBeNull();
    });
  }
});

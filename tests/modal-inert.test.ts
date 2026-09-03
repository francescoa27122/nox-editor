// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import App from '../src/ui/App.svelte';
import { MemoryPlatform } from '../src/platform/memory';
import type { OverlayKind } from '../src/services/ui';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * The app behind a modal is `inert`, which is what makes `aria-modal` true.
 *
 * **The bug this exists for.** Five components declare `aria-modal="true"` and
 * only `CommandPalette` handled `Tab`. In `ConfirmDialog`, `PromptDialog`,
 * `SettingsPanel` and `KeybindingsPanel` a keyboard user tabbed straight out
 * of the dialog into the title bar, the sidebar and the editor behind the
 * scrim, all of which stayed focusable and stayed announced.
 * `CONTRIBUTING.md:211` states "Overlays trap focus and are dismissible with
 * Esc" as a rule. Escape held. The trap did not, in four of the five places
 * that claimed it. Found by a UI review on 2026-08-30.
 *
 * `Overlays` is a sibling of `.nox-shell`, not a child, so one `inert` on the
 * shell does it for every dialog including ones not yet written.
 *
 * **What this file can and cannot check.** jsdom does not implement `inert`'s
 * behaviour, so nothing here proves focus is actually blocked; it holds the
 * attribute to the condition, which is the half that rots. The behavioural
 * claim is `e2e/specs/modal-focus.e2e.js`, in a real browser on all three
 * platforms, where it calls `focus()` on every control behind the scrim and
 * requires that none of them takes it. "Is this subtree focusable" is a
 * question only a real focus implementation can answer, and jsdom answers it
 * yes for an element it has just been told is inert.
 *
 * Mutation-checked on 2026-08-31: dropping `inert={modalOpen}` from
 * `App.svelte` fails every case here.
 */

let panel: Mounted | null = null;

afterEach(() => {
  panel?.unmount();
  panel = null;
});

/**
 * Whether the shell is inert, read as a **property** rather than an attribute.
 *
 * Svelte sets `element.inert = true` rather than writing `inert=""`, and jsdom
 * implements the property without reflecting it to an attribute, so
 * `hasAttribute('inert')` is false here while the element genuinely is inert.
 * The property is the functional thing in a real browser too. Written down
 * because the first version of this file asserted the attribute, went red
 * against working code, and would have had someone "fixing" `App.svelte`.
 */
function shellIsInert(): boolean {
  const element = panel?.container.querySelector('.nox-shell');
  if (!element) throw new Error('the shell did not render');
  return (element as HTMLElement).inert;
}

function mount() {
  const app = new NoxApp(new MemoryPlatform());
  panel = mountComponent(App, { app, props: { app } });
  flush();
  return app;
}

describe('the app behind a modal', () => {
  it('is not inert with nothing open', () => {
    mount();
    expect(shellIsInert()).toBe(false);
  });

  /**
   * Every overlay kind, not a sample. The condition is a three-way `||` and
   * the failure mode of the thing it replaced was one dialog being forgotten,
   * so a sample would reproduce exactly the gap this is about.
   */
  it.each([
    'palette',
    'quick-open',
    'buffers',
    'go-to-line',
    'go-to-symbol',
    'git-branch',
    'code-action',
    'note-open',
    'task-run',
    'language',
    'settings',
    'keybindings',
  ] satisfies OverlayKind[])('is inert while %s is open', (kind) => {
    const app = mount();

    app.ui.openOverlay(kind);
    flush();
    expect(shellIsInert()).toBe(true);

    app.ui.closeOverlay();
    flush();
    expect(shellIsInert()).toBe(false);
  });

  /** The prompt and the confirm are not overlay kinds; they are their own signals. */
  it('is inert while a prompt is open', async () => {
    const app = mount();

    const answer = app.ui.askForText({ title: 'Name', initialValue: '', confirmLabel: 'Go' });
    flush();
    expect(shellIsInert()).toBe(true);

    app.ui.dismissTop();
    flush();
    await answer;
    expect(shellIsInert()).toBe(false);
  });

  it('is inert while a confirmation is open', async () => {
    const app = mount();

    const answer = app.ui.askToConfirm({
      title: 'Sure?',
      message: 'This deletes something.',
      choices: [{ id: 'yes', label: 'Yes', danger: true }, { id: 'no', label: 'No' }],
    });
    flush();
    expect(shellIsInert()).toBe(true);

    app.ui.dismissTop();
    flush();
    await answer;
    expect(shellIsInert()).toBe(false);
  });
});

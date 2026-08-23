// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import ConfirmDialog from '../src/ui/ConfirmDialog.svelte';
import PromptDialog from '../src/ui/PromptDialog.svelte';
import type { ConfirmRequest, PromptRequest } from '../src/services/ui';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * Where focus goes when a modal dialog closes.
 *
 * The failure this suite was written for, measured in the browser build:
 * press ⌘W on a file with unsaved changes, think better of it, press Escape —
 * and `document.activeElement` is `<body>`. Nothing had changed, the file was
 * still open and still dirty, and the next keystroke went nowhere. Cancel did
 * the same. Every caller of `ui.confirm()` and `ui.prompt()` was exposed:
 * rename, delete, Save As, close-with-changes, the permission prompt.
 *
 * The destructive answers were fine by accident — "Don't Save" closes the
 * buffer, and the pane that replaces it claims focus on its own. So the one
 * path that left you unable to type was the path where nothing happened.
 *
 * `ContextMenu` already had the shape (`returnFocusTo`, restored in the
 * effect's teardown); these two never got it. Captured here rather than
 * passed in, because every caller of `ui.confirm()` is a service or a command
 * and none of them has an element to hand over.
 *
 * Mutation-checked on 2026-08-23: the first two fail when the teardown is
 * removed from its dialog. The third does *not* move when the `isConnected`
 * guard goes, and that is worth saying rather than hiding — a detached
 * element cannot take focus in the first place, so the guard states the
 * intent instead of enforcing it. The test still earns its place as the
 * contract: whatever these dialogs do on the way out, they must not pull the
 * keyboard away from the pane that replaced what they interrupted. It would
 * fail on the obvious wrong fix, which is to send focus somewhere fixed.
 */

let mounted: Mounted | null = null;
let opener: HTMLElement | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  opener?.remove();
  opener = null;
});

/** Something outside the dialog holding focus, the way the editor would be. */
function focusedElsewhere(): HTMLElement {
  const element = document.createElement('textarea');
  document.body.appendChild(element);
  element.focus();
  return element;
}

const confirmRequest = (): ConfirmRequest => ({
  title: 'Save changes to theme.css?',
  message: 'Your changes will be lost if you close without saving.',
  choices: [
    { id: 'save', label: 'Save' },
    { id: 'discard', label: "Don't Save", danger: true },
    { id: 'cancel', label: 'Cancel' },
  ],
  resolve: () => {},
});

const promptRequest = (): PromptRequest => ({
  title: 'Rename',
  initialValue: 'theme.css',
  confirmLabel: 'Rename',
  resolve: () => {},
});

describe('closing a dialog', () => {
  it('gives focus back to whatever the confirm interrupted', () => {
    opener = focusedElsewhere();

    mounted = mountComponent(ConfirmDialog, { props: { request: confirmRequest() } });
    flush();
    expect(document.activeElement, 'the dialog should take focus first').not.toBe(opener);

    mounted.unmount();
    mounted = null;
    flush();

    expect(document.activeElement).toBe(opener);
  });

  it('gives focus back to whatever the prompt interrupted', () => {
    opener = focusedElsewhere();

    mounted = mountComponent(PromptDialog, { props: { request: promptRequest() } });
    flush();
    expect(document.activeElement, 'the dialog should take focus first').not.toBe(opener);

    mounted.unmount();
    mounted = null;
    flush();

    expect(document.activeElement).toBe(opener);
  });

  /**
   * The case the naive fix gets wrong. "Don't Save" closes the buffer, so the
   * element that had focus is gone by the time the dialog tears down, and the
   * pane that takes its place focuses itself. Chasing a detached element would
   * pull focus straight back out of it.
   */
  it('does not chase an opener that has since been removed', () => {
    opener = focusedElsewhere();

    mounted = mountComponent(ConfirmDialog, { props: { request: confirmRequest() } });
    flush();

    // The thing behind the dialog goes away while the dialog is still up.
    opener.remove();
    const replacement = focusedElsewhere();

    mounted.unmount();
    mounted = null;
    flush();

    expect(document.activeElement).toBe(replacement);
    replacement.remove();
  });
});

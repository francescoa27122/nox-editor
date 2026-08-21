// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import ConfirmDialog from '../src/ui/ConfirmDialog.svelte';
import { flush, mountComponent } from './support/component';
import type { ConfirmRequest } from '../src/services/ui';

/** A resolve spy plus the id it was called with, or `undefined` if never called. */
function tracked(): { resolve: (choiceId: string | null) => void; calls: (string | null)[] } {
  const calls: (string | null)[] = [];
  return { resolve: (choiceId) => calls.push(choiceId), calls };
}

/** The text of every button in `container`, in document order. */
const buttonLabels = (container: HTMLElement): (string | null)[] =>
  [...container.querySelectorAll('button')].map((node) => node.textContent?.trim() ?? null);

describe('the confirm dialog', () => {
  /**
   * The failure this prevents: a dialog that drops or reorders a choice, so
   * the title, message or one of the buttons a user is meant to read is
   * silently missing from the page.
   */
  it('renders the title, message, and one button per choice, in order', () => {
    const { resolve } = tracked();
    const request: ConfirmRequest = {
      title: 'Delete file?',
      message: 'This cannot be undone.',
      choices: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'delete', label: 'Delete', danger: true },
      ],
      resolve,
    };

    const { container, unmount } = mountComponent(ConfirmDialog, { props: { request } });
    flush();

    expect(container.textContent).toContain('Delete file?');
    expect(container.textContent).toContain('This cannot be undone.');
    expect(buttonLabels(container)).toEqual(['Cancel', 'Delete']);

    unmount();
  });

  /**
   * The failure this prevents: a dialog that resolves with the wrong choice —
   * the button clicked and the id passed to `resolve` disagreeing, which no
   * type check catches, since `resolve`'s signature accepts any choice id.
   * Paired with the test below: a single click over two choices can't tell
   * "the clicked one" apart from "a fixed one that happens to be index 1"
   * (e.g. a handler hoisted out of the `{#each}` that closes over the wrong
   * `choice`) — clicking each choice, in its own mount, and checking it
   * resolves with its own id can.
   */
  it("clicking the first choice resolves with that choice's id", () => {
    const { resolve, calls } = tracked();
    const request: ConfirmRequest = {
      title: 'Discard changes?',
      message: 'Your edits will be lost.',
      choices: [
        { id: 'keep', label: 'Keep editing' },
        { id: 'discard', label: 'Discard', danger: true },
      ],
      resolve,
    };

    const { container, unmount } = mountComponent(ConfirmDialog, { props: { request } });
    flush();

    const buttons = [...container.querySelectorAll('button')];
    buttons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(calls).toEqual(['keep']);

    unmount();
  });

  /**
   * The failure this prevents: a dialog that resolves with the wrong choice —
   * the button clicked and the id passed to `resolve` disagreeing, which no
   * type check catches, since `resolve`'s signature accepts any choice id.
   * Paired with the test above, which clicks the other choice: together they
   * rule out a handler that resolves with a fixed choice regardless of which
   * button was clicked.
   */
  it("clicking a choice resolves with that choice's id, not another one's", () => {
    const { resolve, calls } = tracked();
    const request: ConfirmRequest = {
      title: 'Discard changes?',
      message: 'Your edits will be lost.',
      choices: [
        { id: 'keep', label: 'Keep editing' },
        { id: 'discard', label: 'Discard', danger: true },
      ],
      resolve,
    };

    const { container, unmount } = mountComponent(ConfirmDialog, { props: { request } });
    flush();

    const buttons = [...container.querySelectorAll('button')];
    buttons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(calls).toEqual(['discard']);

    unmount();
  });

  /**
   * The failure this prevents: a dialog that opens without moving focus to
   * its default action, leaving keyboard and screen-reader users stranded on
   * whatever had focus before the dialog appeared. This is also the one
   * assertion that independently proves the harness's `document.body`
   * attachment works — a container never attached to the document cannot
   * hold focus under jsdom, so this test would fail on a detached container
   * even if the component's own focus effect were correct.
   */
  it('moves focus to the first choice when the dialog opens', () => {
    const { resolve } = tracked();
    const request: ConfirmRequest = {
      title: 'Replace file?',
      message: 'A file with this name already exists.',
      choices: [
        { id: 'replace', label: 'Replace' },
        { id: 'cancel', label: 'Cancel' },
      ],
      resolve,
    };

    const { container, unmount } = mountComponent(ConfirmDialog, { props: { request } });
    flush();

    const first = container.querySelector('button');
    expect(document.activeElement).toBe(first);

    unmount();
  });

  /**
   * The failure this guards: `defaultChoiceId` being ignored, so focus and the
   * primary accent fall back to position or to "the first non-danger choice".
   * That fallback is what put both of them on "Allow for this session" in the
   * permission prompt — where `danger` marks Deny, the *safe* answer — so
   * Enter on an unread prompt granted a session-wide capability.
   */
  it('focuses and paints the named default choice, wherever it sits', () => {
    const { resolve, calls } = tracked();
    const request: ConfirmRequest = {
      title: 'Allow edit what is open?',
      message: 'An agent wants to edit what is open.',
      choices: [
        { id: 'allow-session', label: 'Allow for this session', danger: true },
        { id: 'allow-once', label: 'Allow once' },
        { id: 'deny', label: 'Deny' },
      ],
      defaultChoiceId: 'deny',
      resolve,
    };

    const { container, unmount } = mountComponent(ConfirmDialog, { props: { request } });
    flush();

    const buttons = [...container.querySelectorAll('button')];
    expect(document.activeElement).toBe(buttons[2]);
    expect(buttons[2]?.classList.contains('primary')).toBe(true);
    // And the accent is *only* there: a primary grant is the whole bug.
    expect(buttons[0]?.classList.contains('primary')).toBe(false);
    expect(buttons[1]?.classList.contains('primary')).toBe(false);

    // What Enter on the untouched dialog would do.
    (document.activeElement as HTMLButtonElement).click();
    expect(calls).toEqual(['deny']);

    unmount();
  });

  /**
   * The failure this guards: the fix for the prompt above breaking every other
   * call site, which names no default and relies on "the first safe choice
   * when any choice is destructive" — the delete confirm among them.
   */
  it('still falls back to the first safe choice when no default is named', () => {
    const { resolve } = tracked();
    const request: ConfirmRequest = {
      title: 'Delete file?',
      message: 'This cannot be undone.',
      choices: [
        { id: 'delete', label: 'Delete', danger: true },
        { id: 'cancel', label: 'Cancel' },
      ],
      resolve,
    };

    const { container, unmount } = mountComponent(ConfirmDialog, { props: { request } });
    flush();

    const buttons = [...container.querySelectorAll('button')];
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons[1]?.classList.contains('primary')).toBe(true);

    unmount();
  });
});

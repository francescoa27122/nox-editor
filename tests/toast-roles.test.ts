// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import Toasts from '../src/ui/Toasts.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * Which live region a toast is announced from.
 *
 * What this guards: every kind of notification used to render inside one
 * `role="status" aria-live="polite"` container, so "Could not save
 * notes.md." was announced with the same politeness as "Copied
 * diagnostics", and only after the screen reader finished whatever it was
 * saying. `notifications.ts` already treats an error differently (sticky,
 * timeout 0); the markup did not. An error now lands in a `role="alert"`
 * region, which is assertive by definition, and the rest stay polite.
 *
 * Both regions have to exist before anything is in them: a live region a
 * screen reader has not seen yet does not announce what it mounts with.
 * What this does not catch: whether any screen reader actually speaks the
 * text, which no DOM assertion can.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const alertRegion = (container: HTMLElement) => container.querySelector('[role="alert"]');
const politeRegion = (container: HTMLElement) =>
  container.querySelector('[role="status"][aria-live="polite"]');

describe('toast live regions', () => {
  it('exist before any toast is shown', () => {
    mounted = mountComponent(Toasts);
    flush();

    expect(alertRegion(mounted.container)).not.toBeNull();
    expect(politeRegion(mounted.container)).not.toBeNull();
  });

  it('put an error in the alert region and nothing else there', () => {
    mounted = mountComponent(Toasts);
    const { app, container } = mounted;
    app.notifications.notify('error', 'Could not save notes.md.');
    app.notifications.notify('success', 'Copied diagnostics');
    app.notifications.notify('warning', 'changed on disk');
    app.notifications.notify('info', 'Reloaded');
    flush();

    const alerted = [...alertRegion(container)!.querySelectorAll('.toast')].map(
      (toast) => toast.querySelector('.message')?.textContent?.trim(),
    );
    expect(alerted).toEqual(['Could not save notes.md.']);

    const polite = [...politeRegion(container)!.querySelectorAll('.toast')].map(
      (toast) => toast.querySelector('.message')?.textContent?.trim(),
    );
    expect(polite).toEqual(['Copied diagnostics', 'changed on disk', 'Reloaded']);
  });

  /**
   * The alert region must not sit inside the polite one, or the same text is
   * announced twice, once at each politeness.
   */
  it('keeps the two regions apart', () => {
    mounted = mountComponent(Toasts);
    flush();
    const alert = alertRegion(mounted.container)!;
    const polite = politeRegion(mounted.container)!;

    expect(polite.contains(alert)).toBe(false);
    expect(alert.contains(polite)).toBe(false);
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import AnswersPanel from '../src/ui/AnswersPanel.svelte';
import { flush, mountComponent } from './support/component';

describe('the answers panel with nothing in it', () => {
  /**
   * The failure this prevents: the `{#if answers.length === 0}` branch being
   * inverted or dropped by a later edit, so a user who has never asked
   * anything gets an empty box instead of the sentence telling them how to
   * ask. It is also the first thing that proves the harness itself works —
   * a component that mounts at all has reached `useApp()` through real
   * context.
   */
  it('tells you how to ask instead of rendering an empty list', () => {
    const { container, unmount } = mountComponent(AnswersPanel);
    flush();

    expect(container.querySelector('.empty')).not.toBeNull();
    expect(container.querySelector('.list')).toBeNull();
    expect(container.querySelector('.empty')?.textContent).toContain('Explain Selection');

    unmount();
  });
});

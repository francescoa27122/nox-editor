// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import ProblemsPanel from '../src/ui/ProblemsPanel.svelte';
import NotesPanel from '../src/ui/NotesPanel.svelte';
import ReferencesPanel from '../src/ui/ReferencesPanel.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * Phase B of the UI audit: the shared PanelHeader / PanelEmpty primitives.
 *
 * What is worth pinning is the contract the audit found broken nine ways:
 * every sidebar panel exposes a real heading landmark, and an empty state
 * with a one-click way out actually renders the click. Visual sameness is
 * the primitives' own CSS and needs eyes, not jsdom.
 *
 * Mutation-checked on 2026-08-19: the landmark test fails when PanelHeader
 * renders a <span> instead of <h2>; the action test fails when PanelEmpty
 * drops its action button.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe('the shared panel shape', () => {
  it('gives every converted panel a real heading landmark', () => {
    for (const [component, title] of [
      [ProblemsPanel, 'Problems'],
      [ReferencesPanel, 'References'],
      [NotesPanel, 'Notes'],
    ] as const) {
      mounted = mountComponent(component);
      flush();
      const heading = mounted.container.querySelector('.panel-header h2');
      expect(heading?.textContent, title).toBe(title);
      mounted.unmount();
      mounted = null;
    }
  });

  it('renders the one-click way out of an empty state, and it works', async () => {
    mounted = mountComponent(NotesPanel);
    flush();
    const button = mounted.container.querySelector<HTMLButtonElement>('.panel-empty .nox-button');
    expect(button?.textContent).toBe('New Note');

    button!.click();
    await Promise.resolve();
    flush();
    // The click ran the real command: a note now exists and the empty state
    // is gone.
    expect(mounted.app.notes.notes.get().length).toBe(1);
    expect(mounted.container.querySelector('.panel-empty')).toBeNull();
  });
});

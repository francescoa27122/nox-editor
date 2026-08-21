import { describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';

/**
 * Showing the notes panel actually shows it.
 *
 * `ui.focusNotes()` only chooses *which* panel the sidebar renders. Pairing it
 * with opening the sidebar is what the other five panels already do at their
 * command sites; notes was the one that did not.
 */

describe('revealing the notes panel', () => {
  /**
   * The failure this prevents: running a notes command with the sidebar
   * collapsed doing nothing observable at all. "New Note from Selection"
   * created the note, selected it, and left the screen unchanged — which
   * reads as a broken command, not a hidden panel.
   */
  it('opens the sidebar when it is collapsed', () => {
    const app = new NoxApp(new MemoryPlatform());
    app.config.set('workbench.showExplorer', false);

    app.revealNotes();

    expect(app.config.get('workbench.showExplorer')).toBe(true);
    expect(app.ui.sidebarView.get()).toBe('notes');
  });

  it('still asks the panel for focus, so the caret lands in the note', () => {
    const app = new NoxApp(new MemoryPlatform());
    const before = app.ui.focusNotesRequest.get();

    app.revealNotes();

    expect(app.ui.focusNotesRequest.get()).toBeGreaterThan(before);
  });

  it('leaves an already-open sidebar open', () => {
    const app = new NoxApp(new MemoryPlatform());
    app.config.set('workbench.showExplorer', true);

    app.revealNotes();

    expect(app.config.get('workbench.showExplorer')).toBe(true);
  });
});

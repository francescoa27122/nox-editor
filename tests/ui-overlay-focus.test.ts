import { describe, expect, it } from 'vitest';
import { UIService } from '../src/services/ui';

/**
 * Who gets the caret when an overlay closes.
 *
 * Every picker but one ends in the editor — a file, a line, a symbol, a
 * branch — so `closeOverlay` refocuses it. The note picker does not: it
 * selects a note and focuses the notes panel, and both focus requests are
 * signal bumps read by `$effect`, so they land in the same flush and the
 * editor's wins on effect order rather than on intent.
 */

describe('closing an overlay', () => {
  it('refocuses the editor, which is what every picker but one wants', () => {
    const ui = new UIService();
    const before = ui.focusEditorRequest.get();

    ui.openOverlay('quick-open');
    ui.closeOverlay();

    expect(ui.overlay.get()).toBeNull();
    expect(ui.focusEditorRequest.get()).toBeGreaterThan(before);
  });

  /**
   * The failure this prevents: picking a note from the palette leaving the
   * caret in the editor. `closeOverlay` requested editor focus on the way
   * out, so the panel opened and the very next keystroke went to the file
   * behind it. Anyone folding this back into `closeOverlay` to save a method
   * reopens exactly that.
   */
  it('leaves focus alone when the caller is handing it somewhere else', () => {
    const ui = new UIService();
    const before = ui.focusEditorRequest.get();

    ui.openOverlay('note-open');
    ui.closeOverlayWithoutFocus();

    expect(ui.overlay.get()).toBeNull();
    expect(ui.focusEditorRequest.get()).toBe(before);
  });

  it('does not request focus when nothing was open', () => {
    const ui = new UIService();
    const before = ui.focusEditorRequest.get();

    ui.closeOverlay();

    expect(ui.focusEditorRequest.get()).toBe(before);
  });

  /**
   * The note picker's own sequence, in the order the palette runs it: the
   * panel must end up asked for focus, and the editor must not.
   */
  it('lets the note picker hand focus to the notes panel', () => {
    const ui = new UIService();
    const editorBefore = ui.focusEditorRequest.get();
    const notesBefore = ui.focusNotesRequest.get();

    ui.openOverlay('note-open');
    ui.closeOverlayWithoutFocus();
    ui.focusNotes();

    expect(ui.focusNotesRequest.get()).toBeGreaterThan(notesBefore);
    expect(ui.focusEditorRequest.get()).toBe(editorBefore);
    expect(ui.sidebarView.get()).toBe('notes');
  });
});

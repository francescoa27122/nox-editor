// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import NotesPanel from '../src/ui/NotesPanel.svelte';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * The anchor chip, and what it does when the code it points at is not here.
 *
 * A note anchored in folder A and read in folder B cannot jump anywhere. The
 * behaviour that matters is what happens to the *note* in that case, and it
 * is not something the pure functions can be asked: it lives in the panel's
 * derived state.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const ROOT = '/home/nox/projects/aurora';

function appWithAnchoredNote(path: string): NoxApp {
  const app = new NoxApp(new MemoryPlatform());
  app.workspace.rootPath.set(ROOT);
  const id = app.notes.create();
  app.notes.rename(id, 'why the reader threads changed');
  app.notes.setBody(id, 'the body survives either way');
  app.notes.setAnchor(id, { path, line: 320, snippet: 'for line in BufReader' });
  return app;
}

describe('the anchor chip', () => {
  it('offers the jump when the code is in the folder that is open', () => {
    mounted = mountComponent(NotesPanel, { app: appWithAnchoredNote(`${ROOT}/src/lsp.rs`) });
    flush();

    const chip = mounted.container.querySelector<HTMLButtonElement>('.anchor');
    expect(chip).not.toBeNull();
    expect(chip!.disabled).toBe(false);
  });

  /**
   * Root-relative rather than the basename: the note's default title already
   * says the basename, and a basename cannot tell two `index.ts` apart.
   */
  it('names the file relative to the open folder', () => {
    mounted = mountComponent(NotesPanel, { app: appWithAnchoredNote(`${ROOT}/src/lsp.rs`) });
    flush();

    expect(mounted.container.querySelector('.anchor-label')?.textContent).toBe('src/lsp.rs:320');
  });

  /**
   * The failure this prevents: a note vanishing, or being rewritten, because
   * the folder it was made in is not the folder that is open. `NotesService`
   * is given a `Platform` and nothing else precisely so that opening a folder
   * cannot change or hide notes — dropping the anchor here, or hiding the
   * row, would reintroduce that through the panel instead of the service.
   * An unresolvable anchor costs the jump and nothing else.
   */
  it('keeps the note whole when the anchor points outside the open folder', () => {
    mounted = mountComponent(NotesPanel, {
      app: appWithAnchoredNote('/some/other/checkout/src/lsp.rs'),
    });
    flush();

    const chip = mounted.container.querySelector<HTMLButtonElement>('.anchor');
    expect(chip, 'the chip is greyed, never removed').not.toBeNull();
    expect(chip!.disabled).toBe(true);
    expect(chip!.title).toContain('not in the folder that is open');

    // The note itself is untouched.
    expect(mounted.container.querySelector('.note-title')?.textContent?.trim()).toBe(
      'why the reader threads changed',
    );
    expect(mounted.container.querySelector<HTMLTextAreaElement>('.body')?.value).toBe(
      'the body survives either way',
    );
  });

  it('shows no chip at all for a note that was never anchored', () => {
    const app = new NoxApp(new MemoryPlatform());
    app.workspace.rootPath.set(ROOT);
    app.notes.create();

    mounted = mountComponent(NotesPanel, { app });
    flush();

    expect(mounted.container.querySelector('.anchor')).toBeNull();
  });
});

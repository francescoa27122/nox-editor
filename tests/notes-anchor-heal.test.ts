import { describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';

/**
 * An anchor correcting itself against the file.
 *
 * The chip used to name the line a note was *made* at, which stops being true
 * the first time anything is inserted above it. Rather than resolve on every
 * render — the buffer's revision changes per keystroke, so that would put a
 * scan on the typing path for a label nobody reads while typing — the anchor
 * is brought up to date at the two moments a person actually looks at it:
 * selecting the note, and following it.
 */

const FILE = '/w/src/lsp.rs';

async function appWithAnchoredNote(text: string, line: number, snippet: string) {
  const platform = new MemoryPlatform();
  platform.seedFile(FILE, text);

  const app = new NoxApp(platform);
  app.workspace.rootPath.set('/w');
  await app.openPaths([FILE]);

  const id = app.notes.create();
  app.notes.setAnchor(id, { path: FILE, line, snippet });
  return { app, id };
}

const anchorOf = (app: NoxApp, id: string) =>
  app.notes.notes.get().find((n) => n.id === id)!.anchor!;

describe('refreshing a selected note', () => {
  /**
   * The failure this prevents: the chip reading `lsp.rs:320` while the code
   * it points at now sits at 324. Clicking it always landed correctly, so the
   * label was the only thing lying — which is worse than being wrong
   * everywhere, because nothing suggests you should distrust it.
   */
  it('moves the anchor to where its code actually is', async () => {
    const { app, id } = await appWithAnchoredNote('added\nadded\nalpha\nbeta\n', 1, 'alpha');

    app.refreshNoteAnchor(id);

    expect(anchorOf(app, id).line).toBe(3);
  });

  /**
   * The failure this prevents: a note whose code was deleted having its
   * remembered line overwritten by the clamp it fell back to. The fallback is
   * the neighbourhood the code used to be in, not where it is, and writing it
   * back would destroy the last thing anyone actually knew.
   */
  it('leaves the anchor alone when the snippet is gone', async () => {
    // The remembered line must be one the fallback would *change*, or this
    // passes whether or not the guard exists: the fallback clamps into the
    // file, so a line already inside it comes back unchanged and the guard
    // never decides anything. A file that has shrunk is the real case —
    // mutation-checked on 2026-08-21, and the earlier version of this test
    // did not fail when the guard was removed.
    const { app, id } = await appWithAnchoredNote('one\ntwo\nthree\n', 99, 'deleted long ago');

    app.refreshNoteAnchor(id);

    expect(anchorOf(app, id).line, 'the clamp is a guess, not a finding').toBe(99);
  });

  it('leaves the path and snippet untouched when it corrects the line', async () => {
    const { app, id } = await appWithAnchoredNote('added\nalpha\n', 1, 'alpha');

    app.refreshNoteAnchor(id);

    expect(anchorOf(app, id)).toEqual({ path: FILE, line: 2, snippet: 'alpha' });
  });

  /**
   * Correcting itself is not an edit the user made. `updatedAt` is the one
   * timestamp a reader trusts, and a note that claims to have been edited
   * because a file moved underneath it is lying about it.
   */
  it('does not make the note look edited', async () => {
    const { app, id } = await appWithAnchoredNote('added\nalpha\n', 1, 'alpha');
    const before = app.notes.notes.get().find((n) => n.id === id)!.updatedAt;

    app.refreshNoteAnchor(id);

    expect(app.notes.notes.get().find((n) => n.id === id)!.updatedAt).toBe(before);
  });

  it('does nothing for a note with no anchor', () => {
    const app = new NoxApp(new MemoryPlatform());
    const id = app.notes.create();

    expect(() => app.refreshNoteAnchor(id)).not.toThrow();
  });

  /**
   * Only the open buffer is consulted. An anchor into a file nobody has
   * opened keeps its remembered line rather than costing a disk read to
   * label a chip.
   */
  it('leaves an anchor alone when its file is not open', async () => {
    const platform = new MemoryPlatform();
    platform.seedFile(FILE, 'added\nalpha\n');
    const app = new NoxApp(platform);

    const id = app.notes.create();
    app.notes.setAnchor(id, { path: FILE, line: 1, snippet: 'alpha' });
    app.refreshNoteAnchor(id);

    expect(anchorOf(app, id).line).toBe(1);
  });
});

describe('following an anchor', () => {
  it('corrects the anchor on the way through', async () => {
    const { app, id } = await appWithAnchoredNote('added\nadded\nalpha\n', 1, 'alpha');

    await app.openNoteAnchor(id, anchorOf(app, id));

    expect(anchorOf(app, id).line).toBe(3);
  });
});

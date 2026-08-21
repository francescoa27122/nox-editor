import { describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';

/**
 * Notes out of Nox and back, through the real commands.
 *
 * `core/note-file.ts` proves the format round-trips; this proves the two
 * commands built on it do, including the parts that are not the format —
 * choosing filenames that do not collide, and adding rather than overwriting.
 */

/**
 * A platform whose folder picker answers, which `MemoryPlatform`'s does not —
 * it reports `nativeDialogs: false`, which is exactly why both commands are
 * greyed in the browser build.
 *
 * `capabilities` is widened in the constructor rather than as a field
 * initialiser: it is a parent *class field*, so `super.capabilities` is not
 * reachable from a child field, and re-declaring the whole record here would
 * go stale the next time one is added.
 */
class PickingPlatform extends MemoryPlatform {
  constructor(private readonly folder: string) {
    super();
    this.mkdirp(folder);
    (this.capabilities as { nativeDialogs: boolean }).nativeDialogs = true;
  }

  /** Captions the picker was asked for, in order. */
  readonly pickerTitles: (string | undefined)[] = [];

  override async pickFolder(title?: string): Promise<string | null> {
    this.pickerTitles.push(title);
    return this.folder;
  }
}

const FOLDER = '/exports';

function appWith(notes: { title: string; body: string; pinned?: boolean }[]): {
  app: NoxApp;
  platform: PickingPlatform;
} {
  const platform = new PickingPlatform(FOLDER);
  const app = new NoxApp(platform);
  for (const note of notes) {
    app.notes.importNote({ title: note.title, body: note.body, pinned: note.pinned ?? false });
  }
  return { app, platform };
}

describe('exporting', () => {
  it('writes one file per note', async () => {
    const { app, platform } = appWith([
      { title: 'first', body: 'one' },
      { title: 'second', body: 'two' },
    ]);

    await app.exportNotes();

    const written = (await platform.readDir(FOLDER)).map((e) => e.name).sort();
    expect(written).toEqual(['first.md', 'second.md']);
  });

  /**
   * The failure this prevents: two notes writing to one path, so exporting
   * four notes yields three files and one of them is silently gone. Titles
   * are user-edited and not unique.
   */
  it('does not let two notes with one title share a file', async () => {
    const { app, platform } = appWith([
      { title: 'Notes', body: 'the first' },
      { title: 'Notes', body: 'the second' },
    ]);

    await app.exportNotes();

    const written = await platform.readDir(FOLDER);
    expect(written).toHaveLength(2);

    const bodies = await Promise.all(
      written.map(async (entry) => (await platform.readTextFile(entry.path)).split('---\n')[2]),
    );
    expect(bodies.sort()).toEqual(['the first', 'the second']);
  });
});

describe('round-tripping through a folder', () => {
  /**
   * The property the whole phase is judged on: what goes out comes back.
   */
  it('brings every note back with its title, body and pin intact', async () => {
    const original = [
      { title: 'release checklist', body: 'rotate the signing key\n', pinned: true },
      { title: 'lsp.rs:320 — why', body: '```\nfor line in\n```\n', pinned: false },
    ];
    const { app, platform } = appWith(original);

    await app.exportNotes();

    // A second Nox, sharing only the folder.
    const fresh = new NoxApp(platform);
    await fresh.importNotes();

    const back = fresh.notes.notes
      .get()
      .map((n) => ({ title: n.title, body: n.body, pinned: n.pinned }))
      .sort((a, b) => a.title.localeCompare(b.title));

    expect(back).toEqual([...original].sort((a, b) => a.title.localeCompare(b.title)));
  });

  it('carries an anchor across', async () => {
    const anchor = { path: '/w/src/lsp.rs', line: 320, snippet: 'for line in' };
    const platform = new PickingPlatform(FOLDER);
    const app = new NoxApp(platform);
    const id = app.notes.importNote({ title: 'anchored', body: 'x' });
    app.notes.setAnchor(id, anchor);

    await app.exportNotes();

    const fresh = new NoxApp(platform);
    await fresh.importNotes();

    expect(fresh.notes.notes.get()[0]!.anchor).toEqual(anchor);
  });
});

describe('importing', () => {
  /**
   * The failure this prevents: re-importing an export of this very folder
   * rewriting every note in place. Files carry the id they were exported
   * with, and honouring it would make the safe-looking act of importing your
   * own backup destructive.
   */
  it('adds to what is already here rather than replacing it', async () => {
    const { app } = appWith([{ title: 'mine', body: 'kept' }]);
    await app.exportNotes();

    await app.importNotes();

    expect(app.notes.notes.get()).toHaveLength(2);
    expect(app.notes.notes.get().filter((n) => n.title === 'mine')).toHaveLength(2);
  });

  it('imports plain Markdown that Nox never wrote, titled from its filename', async () => {
    const platform = new PickingPlatform(FOLDER);
    platform.seedFile(`${FOLDER}/from-obsidian.md`, '# Written elsewhere\n\nno front matter.\n');
    const app = new NoxApp(platform);

    await app.importNotes();

    const note = app.notes.notes.get()[0]!;
    expect(note.title).toBe('from-obsidian');
    expect(note.body).toBe('# Written elsewhere\n\nno front matter.\n');
  });

  it('ignores files that are not Markdown', async () => {
    const platform = new PickingPlatform(FOLDER);
    platform.seedFile(`${FOLDER}/notes.md`, 'a note');
    platform.seedFile(`${FOLDER}/photo.png`, 'not a note');
    const app = new NoxApp(platform);

    await app.importNotes();

    expect(app.notes.notes.get()).toHaveLength(1);
  });
});

describe('the folder picker caption', () => {
  /**
   * The failure this prevents: both commands opening a dialog captioned
   * "Open Folder", which is `pickFolder`'s default and reads as "open this as
   * a workspace" — the opposite of writing files into it. Only the caller
   * knows why a folder is being asked for.
   *
   * Not observable in the browser build, where both commands are disabled for
   * want of a dialog, which is why it went unnoticed until the release check.
   */
  it('says what the folder is for when exporting', async () => {
    const { app, platform } = appWith([{ title: 'n', body: '' }]);

    await app.exportNotes();

    expect(platform.pickerTitles).toEqual(['Export Notes Into Folder']);
  });

  it('says what the folder is for when importing', async () => {
    const platform = new PickingPlatform(FOLDER);
    const app = new NoxApp(platform);

    await app.importNotes();

    expect(platform.pickerTitles).toEqual(['Import Notes From Folder']);
  });
});

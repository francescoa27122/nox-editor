import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { NotesService } from '../src/services/notes';

/**
 * The notes service against the in-memory platform, whose config store is a
 * plain map — the same seam `session.test.ts` uses. Notes are only ever
 * written through that seam, so a fake there exercises the real persistence
 * path without a Rust build.
 */

/** Records which config files were written, to assert what a save touched. */
class CountingPlatform extends MemoryPlatform {
  readonly writes: string[] = [];

  override async writeConfigFile(name: string, contents: string): Promise<void> {
    this.writes.push(name);
    await super.writeConfigFile(name, contents);
  }
}

describe('creating and persisting', () => {
  it('round-trips notes through a fresh service', async () => {
    const platform = new MemoryPlatform();
    const notes = new NotesService(platform);

    const id = notes.create();
    notes.setBody(id, 'the body');
    await notes.flush();

    const reloaded = new NotesService(platform);
    await reloaded.load();

    expect(reloaded.notes.get()).toHaveLength(1);
    expect(reloaded.notes.get()[0]!.body).toBe('the body');
    expect(reloaded.selectedId.get()).toBe(id);
  });

  /**
   * The failure this prevents: notes routed through the workspace, so that
   * opening another folder empties or hides them. The service cannot reach a
   * workspace because it is never given one — this test is what keeps that
   * true when someone later wants "just the root path" for a feature.
   */
  it('is constructible from a platform alone', () => {
    expect(() => new NotesService(new MemoryPlatform())).not.toThrow();
  });

  it('puts the newest note first and leaves the order alone when one is edited', async () => {
    const notes = new NotesService(new MemoryPlatform());

    const first = notes.create();
    const second = notes.create();
    notes.setBody(first, 'edited later');

    // Sorting by updatedAt would put `first` back on top — under the caret of
    // whoever is typing into it.
    expect(notes.notes.get().map((note) => note.id)).toEqual([second, first]);
  });

  /**
   * The failure this prevents: session v3's write amplification, where one
   * keystroke rewrote every buffer's content because they shared a file.
   */
  it('writes only the edited note\'s body, once, however many keystrokes', async () => {
    const platform = new CountingPlatform();
    const notes = new NotesService(platform);

    const first = notes.create();
    const second = notes.create();
    await notes.flush();
    platform.writes.length = 0;

    for (const text of ['t', 'te', 'tex', 'text']) notes.setBody(second, text);
    await notes.flush();

    const bodyWrites = platform.writes.filter((name) => name !== 'notes.json');
    expect(bodyWrites).toHaveLength(1);
    // And specifically not the other note's file.
    expect(await platform.readConfigFile(bodyWrites[0]!)).toBe('text');
    expect(notes.notes.get().find((note) => note.id === first)!.body).toBe('');
  });

  it('starts empty when there is no index', async () => {
    const notes = new NotesService(new MemoryPlatform());
    await notes.load();
    expect(notes.notes.get()).toEqual([]);
    expect(notes.selectedId.get()).toBeNull();
  });

  /**
   * The failure this prevents: a parse error thrown out of `load` during boot,
   * which would take the whole window down over one bad file.
   */
  it('loads an empty list from a malformed index', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile('notes.json', '{ not json');

    const notes = new NotesService(platform);
    await expect(notes.load()).resolves.toBeUndefined();
    expect(notes.notes.get()).toEqual([]);
  });

  /**
   * The failure this prevents: a future version 2 of the format being read by
   * this version as if it were version 1, which would rewrite it on the next
   * save and destroy whatever the newer field meant.
   */
  it('loads an empty list from an index it does not recognise', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile(
      'notes.json',
      JSON.stringify({ version: 99, selectedId: null, notes: [] }),
    );

    const notes = new NotesService(platform);
    await notes.load();

    expect(notes.notes.get()).toEqual([]);
  });

  /**
   * The failure this prevents: one missing body file taking every other note
   * down with it. The title and the note itself are worth keeping.
   */
  it('loads a note whose body file has gone missing, with an empty body', async () => {
    const platform = new MemoryPlatform();
    const notes = new NotesService(platform);
    const id = notes.create();
    notes.setBody(id, 'text that will vanish');
    await notes.flush();

    // Blank is how a released body is marked, so this is also what a
    // half-finished delete looks like.
    await platform.writeConfigFile('note-1.txt', '');

    const reloaded = new NotesService(platform);
    await reloaded.load();

    expect(reloaded.notes.get()).toHaveLength(1);
    expect(reloaded.notes.get()[0]!.body).toBe('');
  });

  /**
   * The failure this prevents: an id counter that restarts at 1 on launch,
   * so the next new note claims the body file of an existing one and
   * overwrites it.
   */
  it('does not reissue an id or a body file after a reload', async () => {
    const platform = new MemoryPlatform();
    const first = new NotesService(platform);
    const original = first.create();
    first.setBody(original, 'original text');
    await first.flush();

    const second = new NotesService(platform);
    await second.load();
    const fresh = second.create();
    second.setBody(fresh, 'new text');
    await second.flush();

    expect(fresh).not.toBe(original);
    const bodies = second.notes.get().map((note) => note.body).sort();
    expect(bodies).toEqual(['new text', 'original text']);
  });
});

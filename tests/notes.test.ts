import { describe, expect, it, vi } from 'vitest';
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

/**
 * Lets a test hold a single `writeConfigFile` call open, to act while that
 * write is genuinely in flight — the window `MemoryPlatform` normally closes
 * on the very next microtask, which is why none of the tests above can see
 * it. `started` resolves the instant the write is reached (so a test never
 * has to guess a microtask count to win the race), and the call does not
 * proceed to the real write until `release()` is called.
 */
class LatchedPlatform extends MemoryPlatform {
  #gates = new Map<string, { markStarted: () => void; blocked: Promise<void> }>();

  hold(name: string): { started: Promise<void>; release: () => void } {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#gates.set(name, { markStarted, blocked });
    return { started, release };
  }

  override async writeConfigFile(name: string, contents: string): Promise<void> {
    const gate = this.#gates.get(name);
    if (gate) {
      this.#gates.delete(name);
      gate.markStarted();
      await gate.blocked;
    }
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

  /**
   * The failure this prevents: `#persist` used to clear a note's dirty flag
   * as soon as its body write resolved, with no check that the note was
   * still the text it had just written. A keystroke landing during the
   * write's IPC round trip was silently lost — the next save saw a clean
   * flag and never wrote the newer text at all. A single `flush()` must be
   * enough, because that is the quit path's contract: there is no second
   * chance once the window is closing.
   */
  it('persists a keystroke that lands while its own body write is still in flight, in one flush', async () => {
    const platform = new LatchedPlatform();
    const notes = new NotesService(platform);

    const id = notes.create();
    notes.setBody(id, 'hello');

    const gate = platform.hold('note-1.txt');
    const theFlush = notes.flush();
    await gate.started;

    // The race: this lands while the write above is still awaiting the gate.
    notes.setBody(id, 'hello world');
    gate.release();
    await theFlush;

    const reloaded = new NotesService(platform);
    await reloaded.load();
    expect(reloaded.notes.get()[0]!.body).toBe('hello world');
  });

  /**
   * The failure this prevents: `#doPersist` read every note's body off a
   * single snapshot taken at the top of the call, but compared the *live*
   * revision map after each write's await. For the first dirty note in the
   * loop those two never drift, so a single-note test cannot see the bug —
   * it takes two: b's edit has to land while a's write, ahead of it in the
   * same persist, is still in flight. The loop then wrote b's *stale*
   * pre-edit body (from the entry snapshot) but compared against b's
   * *already-bumped* revision, concluded nothing had changed, and cleared
   * b's dirty flag over text that was never saved — and a second flush()
   * did not recover it, because the loop had already made its one pass.
   */
  it('persists a second note\'s edit that lands while an earlier note\'s write is still in flight, in one flush', async () => {
    const platform = new LatchedPlatform();
    const notes = new NotesService(platform);

    const a = notes.create();
    const b = notes.create();
    notes.setBody(a, 'a0');
    notes.setBody(b, 'b0');

    // `a` was created first, so it is the first id in `#dirtyBodies` and the
    // first write the drain loop reaches.
    const gate = platform.hold('note-1.txt');
    const theFlush = notes.flush();
    await gate.started;

    // The race: b's edit lands while a's write, ahead of it in this same
    // persist, is still in flight.
    notes.setBody(b, 'b1');
    gate.release();
    await theFlush;

    const reloaded = new NotesService(platform);
    await reloaded.load();
    expect(reloaded.notes.get().find((note) => note.id === b)!.body).toBe('b1');
  });

  /**
   * The failure this prevents: the debounce timer firing while `flush()` (the
   * quit path) starts a second, concurrent `#persist`. Two `notes.json`
   * writes in flight at once can resolve in either order; if the older
   * persist's write lands last it reverts the index to its own, older
   * snapshot — silently dropping a note the newer persist had already
   * recorded, even though that note's body file is sitting right there on
   * disk.
   */
  it('serializes overlapping persists so a slower one cannot revert the index', async () => {
    const platform = new LatchedPlatform();
    const notes = new NotesService(platform);

    const first = notes.create();
    const gate = platform.hold('notes.json');
    const firstFlush = notes.flush();
    await gate.started; // the first persist is now stuck writing the index

    const second = notes.create(); // arrives while the first persist is stuck
    const secondFlush = notes.flush();

    // Give the second persist's own (unheld) index write every chance to
    // land before releasing the first's. Serialized, this is a no-op — the
    // second cannot even start until the first finishes, so it just spins.
    // Unserialized, it is exactly the ordering that reverts the index: the
    // two chains race independently, and which one reaches `notes.json`
    // first is otherwise a coin flip that hides the bug half the time.
    for (let i = 0; i < 20; i++) await Promise.resolve();

    gate.release();
    await Promise.all([firstFlush, secondFlush]);

    const reloaded = new NotesService(platform);
    await reloaded.load();
    expect(reloaded.notes.get().map((note) => note.id).sort()).toEqual(
      [first, second].sort(),
    );
  });

  /**
   * The failure this prevents: a `#schedule` with no body behind it — every
   * other test drives persistence through `flush()`, so a debounce that
   * silently did nothing would still pass all of them, even though
   * always-autosaving without an explicit flush is the point of this
   * service.
   */
  it('autosaves after the debounce with no explicit flush, collapsing several keystrokes into one write', async () => {
    vi.useFakeTimers();
    try {
      const platform = new CountingPlatform();
      const notes = new NotesService(platform);

      const id = notes.create();
      for (const text of ['t', 'te', 'tex', 'text']) notes.setBody(id, text);
      expect(platform.writes).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(400);

      const bodyWrites = platform.writes.filter((name) => name !== 'notes.json');
      expect(bodyWrites).toHaveLength(1);
      expect(await platform.readConfigFile(bodyWrites[0]!)).toBe('text');
      expect(await platform.readConfigFile('notes.json')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

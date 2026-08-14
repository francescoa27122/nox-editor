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
   * The failure this prevents: the body drain closed the window during body
   * writes, but `#doPersist` still went on to write `notes.json` and return
   * without ever re-checking `#dirtyBodies` — the same "lost keystroke on
   * the quit path" bug, just moved from the body-write window to the
   * index-write window instead of closed. A single `flush()` has to be
   * enough no matter which write a keystroke happens to land next to.
   */
  it('persists an edit that lands while the index write is still in flight, in one flush', async () => {
    const platform = new LatchedPlatform();
    const notes = new NotesService(platform);

    const id = notes.create();
    notes.setBody(id, 'saved');

    const gate = platform.hold('notes.json');
    const theFlush = notes.flush();
    await gate.started; // the body write already landed; the index write is stuck

    // The race: this lands while the index write, not a body write, is in
    // flight.
    notes.setBody(id, 'typed while quitting');
    gate.release();
    await theFlush;

    const reloaded = new NotesService(platform);
    await reloaded.load();
    expect(reloaded.notes.get()[0]!.body).toBe('typed while quitting');
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

/** Fails every config write, to exercise the save-failure path. */
class RefusingPlatform extends MemoryPlatform {
  failing = false;

  override async writeConfigFile(name: string, contents: string): Promise<void> {
    if (this.failing) throw new Error('disk is full');
    await super.writeConfigFile(name, contents);
  }
}

describe('renaming', () => {
  /**
   * The failure this prevents: rename() existing but never actually
   * reaching the note's title — the base case every other rename test in
   * this block builds on.
   */
  it('renames a note', async () => {
    const notes = new NotesService(new MemoryPlatform());
    const id = notes.create();

    notes.rename(id, 'Reading list');

    expect(notes.notes.get()[0]!.title).toBe('Reading list');
  });

  /**
   * The failure this prevents: a blank row in a list that shows nothing but
   * titles, which the user then cannot pick out to fix.
   */
  it('refuses a blank title and keeps the old one', () => {
    const notes = new NotesService(new MemoryPlatform());
    const id = notes.create();
    notes.rename(id, 'Standup');

    notes.rename(id, '   ');

    expect(notes.notes.get()[0]!.title).toBe('Standup');
  });

  /**
   * The failure this prevents: a title saved with visible leading or
   * trailing padding, which reads as a rendering bug in any list view that
   * shows titles verbatim.
   */
  it('trims surrounding whitespace', () => {
    const notes = new NotesService(new MemoryPlatform());
    const id = notes.create();

    notes.rename(id, '  Ideas  ');

    expect(notes.notes.get()[0]!.title).toBe('Ideas');
  });

  /**
   * The failure this prevents: rename() and select() touch only index-shaped
   * state (title, selection), so nothing marked the index dirty for the
   * persist loop's exit check. That check reads #dirtyBodies and #released
   * only — both empty here — so without a third signal tracking index-only
   * changes, a rename landing while notes.json is already mid-write would
   * see nothing pending, break the loop, and return having written the
   * pre-rename title. A second flush() would never be called on the quit
   * path, so the rename would be lost for good.
   */
  it('persists a rename that lands while the index write is still in flight, in one flush', async () => {
    const platform = new LatchedPlatform();
    const notes = new NotesService(platform);

    const id = notes.create();
    await notes.flush();

    const gate = platform.hold('notes.json');
    const theFlush = notes.flush();
    await gate.started; // notes.json write is now stuck (nothing dirty forced it, but flush always writes the index)

    // The race: this lands while the index write is still in flight.
    notes.rename(id, 'renamed mid-write');
    gate.release();
    await theFlush;

    const reloaded = new NotesService(platform);
    await reloaded.load();
    expect(reloaded.notes.get()[0]!.title).toBe('renamed mid-write');
  });

  /**
   * The failure this prevents: a boolean "index is dirty" flag cannot tell
   * "unchanged since this write started" apart from "changed, but the new
   * value also happens to be true" — which is exactly this shape. The first
   * rename leaves the flag already true before the index write even starts;
   * the second rename, landing mid-write, sets it true again, and true===true
   * looks identical to nothing having happened. A boolean-flagged persist
   * clears the flag, breaks the loop, and writes only the first rename —
   * this needs a revision *number*, comparable by exact value, to catch it.
   */
  it('persists a second rename that lands on an index write that was already dirty when it started, in one flush', async () => {
    const platform = new LatchedPlatform();
    const notes = new NotesService(platform);

    const id = notes.create();
    await notes.flush(); // clean baseline: index and body both on disk

    notes.rename(id, 'first rename'); // dirties the index; debounce still pending

    const gate = platform.hold('notes.json');
    const theFlush = notes.flush(); // starts an index write that is dirty from the moment it begins
    await gate.started;

    // The race: this lands while that already-dirty write is still in flight.
    notes.rename(id, 'second rename');
    gate.release();
    await theFlush;

    const reloaded = new NotesService(platform);
    await reloaded.load();
    expect(reloaded.notes.get()[0]!.title).toBe('second rename');
  });

  /**
   * The failure this prevents: the same boolean-vs-counter gap as above, but
   * hit on the *second* pass of the persist loop rather than the first. Pass
   * 1's mid-write rename correctly forces pass 2 (true flips from false, so a
   * boolean catches it too) — but pass 2's own index write then starts with
   * the flag already true, so a second rename landing mid-write on pass 2 is
   * exactly the "true again" case a boolean cannot distinguish from no
   * change. Two passes, two renames, one flush: only a revision number
   * survives both.
   */
  it('persists two renames that each land during a different pass of the same flush', async () => {
    const platform = new LatchedPlatform();
    const notes = new NotesService(platform);

    const id = notes.create();
    await notes.flush(); // clean baseline

    const gate1 = platform.hold('notes.json');
    const theFlush = notes.flush();
    await gate1.started; // pass 1's index write is stuck

    // Register pass 2's gate before releasing pass 1, so the very next write
    // to notes.json — whichever pass reaches it — is held too.
    const gate2 = platform.hold('notes.json');
    notes.rename(id, 'rename one'); // lands during pass 1's write
    gate1.release();
    await gate2.started; // pass 1 finished dirty, forced pass 2, now stuck too

    notes.rename(id, 'rename two'); // lands during pass 2's write
    gate2.release();
    await theFlush;

    const reloaded = new NotesService(platform);
    await reloaded.load();
    expect(reloaded.notes.get()[0]!.title).toBe('rename two');
  });
});

describe('deleting', () => {
  /**
   * The failure this prevents: a selection pointing at a note that no longer
   * exists, which renders as an editor pane bound to nothing.
   */
  it('selects the next note when the selected one is deleted', () => {
    const notes = new NotesService(new MemoryPlatform());
    const oldest = notes.create();
    const middle = notes.create();
    notes.create();
    // Order is newest first, so `middle` sits between the other two.
    notes.select(middle);

    notes.remove(middle);

    expect(notes.selectedId.get()).toBe(oldest);
    expect(notes.notes.get().map((note) => note.id)).not.toContain(middle);
  });

  /**
   * The failure this prevents: remove()'s fallback reads
   * `remaining[index]` first — the note that slid into the deleted one's
   * slot — but deleting the *newest* note leaves no note at that index at
   * all. Without the `?? remaining[index - 1]?.id` fallback behind it, the
   * selection would land on `undefined` instead of stepping back to the
   * note that was already there.
   */
  it('falls back to the previous note when the last one is deleted', () => {
    const notes = new NotesService(new MemoryPlatform());
    const oldest = notes.create();
    const newest = notes.create();
    notes.select(oldest);

    notes.remove(oldest);

    expect(notes.selectedId.get()).toBe(newest);
  });

  /**
   * The failure this prevents: with no note before or after the deleted one,
   * `remaining[index] ?? remaining[index - 1]?.id ?? null` has to fall all
   * the way through to `null`. Stopping one step early would leave
   * `selectedId` pointing at the id that was just removed.
   */
  it('clears the selection when the last note goes', () => {
    const notes = new NotesService(new MemoryPlatform());
    const only = notes.create();

    notes.remove(only);

    expect(notes.notes.get()).toEqual([]);
    expect(notes.selectedId.get()).toBeNull();
  });

  /**
   * The failure this prevents: the config API has no delete, so a body left
   * unblanked keeps the full text of a deleted note in the config directory
   * indefinitely.
   */
  it('blanks the body file of a deleted note', async () => {
    const platform = new MemoryPlatform();
    const notes = new NotesService(platform);
    const id = notes.create();
    notes.setBody(id, 'private');
    await notes.flush();
    expect(await platform.readConfigFile('note-1.txt')).toBe('private');

    notes.remove(id);
    await notes.flush();

    expect(await platform.readConfigFile('note-1.txt')).toBe('');
  });

  /**
   * The failure this prevents: `remove()` drops the note from `notes` and
   * `#bodyFiles` in memory, but if that never reached disk — e.g. because
   * nothing marked the index dirty — a reload would rebuild the deleted
   * note's row from the still-present index entry.
   */
  it('does not resurrect a deleted note on reload', async () => {
    const platform = new MemoryPlatform();
    const notes = new NotesService(platform);
    const keep = notes.create();
    const drop = notes.create();
    notes.remove(drop);
    await notes.flush();

    const reloaded = new NotesService(platform);
    await reloaded.load();

    expect(reloaded.notes.get().map((note) => note.id)).toEqual([keep]);
  });
});

describe('switching notes', () => {
  /**
   * The failure this prevents: persisting only the *selected* note's body.
   * Every dirty body must be written, or editing A then switching to B loses
   * A's text at the next save.
   */
  it('writes an edited note that is no longer selected', async () => {
    const platform = new MemoryPlatform();
    const notes = new NotesService(platform);
    const first = notes.create();
    const second = notes.create();

    notes.setBody(first, 'first text');
    notes.select(second);
    notes.setBody(second, 'second text');
    await notes.flush();

    const reloaded = new NotesService(platform);
    await reloaded.load();
    const bodies = new Map(reloaded.notes.get().map((note) => [note.id, note.body]));
    expect(bodies.get(first)).toBe('first text');
    expect(bodies.get(second)).toBe('second text');
  });

  /**
   * The failure this prevents: `select()` updating the in-memory signal but
   * never persisting it, so a reload falls back to whichever note happens to
   * load first instead of the one the user actually had open.
   */
  it('remembers which note was selected', async () => {
    const platform = new MemoryPlatform();
    const notes = new NotesService(platform);
    const first = notes.create();
    notes.create();
    notes.select(first);
    await notes.flush();

    const reloaded = new NotesService(platform);
    await reloaded.load();

    expect(reloaded.selectedId.get()).toBe(first);
  });
});

describe('when the disk refuses', () => {
  /**
   * The failure this prevents: swallowing a failed save. Notes have no
   * on-disk original to fall back on — if the write is lost the text exists
   * only in memory, so the user has to be told.
   */
  it('reports a failed write and keeps the note in memory', async () => {
    const platform = new RefusingPlatform();
    const notes = new NotesService(platform);
    const id = notes.create();
    platform.failing = true;

    notes.setBody(id, 'text that cannot be saved');
    await notes.flush();

    expect(notes.error.get()).toBe('disk is full');
    expect(notes.notes.get()[0]!.body).toBe('text that cannot be saved');
  });

  /**
   * The failure this prevents: a body that failed once being dropped from
   * `#dirtyBodies` instead of staying pending, so the text is never retried
   * and is permanently lost once nothing else references it in memory.
   */
  it('saves the pending body once the disk comes back', async () => {
    const platform = new RefusingPlatform();
    const notes = new NotesService(platform);
    const id = notes.create();
    platform.failing = true;
    notes.setBody(id, 'deferred');
    await notes.flush();

    platform.failing = false;
    await notes.flush();

    expect(notes.error.get()).toBeNull();
    expect(await platform.readConfigFile('note-1.txt')).toBe('deferred');
  });
});

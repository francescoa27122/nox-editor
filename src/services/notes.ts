import { Signal } from '@core/signal';
import type { Platform } from '@platform/types';

/**
 * The user's own notes.
 *
 * These are not workspace files, and none of the buffer machinery applies to
 * them: no transactions, no dirty-versus-disk state, no watcher. That is the
 * whole reason this service exists rather than another kind of buffer — a
 * file on disk has other readers (git, a compiler, an agent staging a change
 * set) and a note has none.
 *
 * It takes a `Platform` and nothing else. That is deliberate and load-bearing:
 * with no workspace in reach, opening a different folder cannot change or hide
 * notes, and no later edit can accidentally make it so.
 *
 * Persistence is a small index plus one file per body. Holding every note in
 * one JSON would mean a keystroke in one note rewriting all the others across
 * the IPC boundary — the mistake session v3 made and v4 undid — and would put
 * every note behind a single torn write.
 */

const INDEX_FILE = 'notes.json';
const VERSION = 1;
const UNTITLED = 'Untitled note';
/** Matches the session's debounce; tuned for the same reason — typing. */
const SAVE_DELAY = 400;

export interface Note {
  /**
   * Opaque and stable. The title is a label the user edits, so anything that
   * refers to a note — the selection, a future link, a future file
   * association — refers to this instead.
   */
  id: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

/** A note in the index. The body lives in the file this names. */
interface NoteRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Config-relative file holding the body. */
  body: string;
}

interface NotesFile {
  version: number;
  selectedId: string | null;
  notes: NoteRecord[];
}

/** The number in `n7`, or 0 for an id that did not come from this scheme. */
function ordinalOf(id: string): number {
  const match = /^n(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

export class NotesService {
  readonly notes = new Signal<Note[]>([]);
  readonly selectedId = new Signal<string | null>(null);
  /**
   * Why the last save failed, if it did. Reported by `app.ts` rather than
   * here, so this service keeps its single dependency — the same split
   * `TerminalService` uses for its own errors.
   */
  readonly error = new Signal<string | null>(null);

  #platform: Platform;
  /** Note id → the config file holding its body. */
  #bodyFiles = new Map<string, string>();
  /** Notes whose body has moved since the last successful write. */
  #dirtyBodies = new Set<string>();
  /**
   * Note id → the revision its body was at when the *current or most recent*
   * write for it started. A keystroke bumps this. Comparing it again after
   * the write's await settles is what tells a persist whether the text it
   * just wrote is still the text on the note — if not, another keystroke
   * landed mid-write and the id must stay dirty rather than being cleared
   * for words that were never persisted.
   */
  #bodyRevision = new Map<string, number>();
  #nextRevision = 1;
  /** Body files of deleted notes, waiting to be blanked. */
  #released = new Set<string>();
  /**
   * Set whenever index-only state — a title, a selection — changes with no
   * body write to carry it. `#dirtyBodies` and `#released` are both
   * body-shaped and cannot see a rename or a select; without this, the
   * persist loop's exit check would think nothing was pending and break with
   * a rename dropped mid-index-write, the same lost-edit shape closed for
   * bodies but reopened here. Cleared only when an index write lands and
   * nothing re-dirtied it while that write was in flight, so a failed write
   * leaves it set for the next persist call to retry — see `indexFailed` in
   * `#doPersist` for how a failure this call still avoids spinning the loop
   * forever on that alone.
   */
  #indexDirty = false;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Every call to `#persist` chains onto this rather than running
   * immediately, so two saves — the debounce timer firing mid-write, or
   * `flush()` landing on top of it at quit — can never be in flight at once.
   * Concurrent index writes can resolve in either order; serializing is what
   * stops the second one finishing first and being overwritten by the first,
   * which would revert `notes.json` to the older snapshot and drop whatever
   * the newer one added.
   */
  #saveChain: Promise<void> = Promise.resolve();
  /**
   * Next unused ordinal, feeding both the id and the body filename so the two
   * stay legible together (`n7` ↔ `note-7.txt`). Recomputed on load from the
   * ids actually present, so a restart cannot reissue one and overwrite the
   * body file of an existing note.
   */
  #nextOrdinal = 1;

  constructor(platform: Platform) {
    this.#platform = platform;
  }

  async load(): Promise<void> {
    let raw: string | null;
    try {
      raw = await this.#platform.readConfigFile(INDEX_FILE);
    } catch {
      // An unreadable index is the same as no index. There is nothing the
      // user could do about an error here, so do not raise one.
      return;
    }
    if (!raw) return;

    let parsed: NotesFile;
    try {
      parsed = JSON.parse(raw) as NotesFile;
    } catch {
      return;
    }
    if (parsed.version !== VERSION || !Array.isArray(parsed.notes)) return;

    const loaded: Note[] = [];
    for (const record of parsed.notes) {
      if (!record?.id || typeof record.body !== 'string') continue;
      this.#bodyFiles.set(record.id, record.body);
      this.#nextOrdinal = Math.max(this.#nextOrdinal, ordinalOf(record.id) + 1);
      loaded.push({
        id: record.id,
        title: record.title || UNTITLED,
        // A body file that has gone missing costs this note's text and
        // nothing else. Dropping the note would lose its title as well.
        body: (await this.#read(record.body)) ?? '',
        createdAt: record.createdAt ?? 0,
        updatedAt: record.updatedAt ?? 0,
      });
    }

    this.notes.set(loaded);
    const wanted = parsed.selectedId;
    this.selectedId.set(
      loaded.some((note) => note.id === wanted) ? wanted : (loaded[0]?.id ?? null),
    );
  }

  /** Create an empty note, select it, and return its id. */
  create(): string {
    const ordinal = this.#nextOrdinal++;
    const id = `n${ordinal}`;
    const now = Date.now();

    this.#bodyFiles.set(id, `note-${ordinal}.txt`);
    this.#dirtyBodies.add(id);
    this.#bodyRevision.set(id, this.#nextRevision++);
    // Newest first, and the list never re-sorts afterwards: this is the only
    // place order is decided.
    this.notes.update((list) => [
      { id, title: UNTITLED, body: '', createdAt: now, updatedAt: now },
      ...list,
    ]);
    this.selectedId.set(id);
    this.#schedule();
    return id;
  }

  setBody(id: string, body: string): void {
    const current = this.notes.get().find((note) => note.id === id);
    if (!current || current.body === body) return;

    const now = Date.now();
    this.notes.update((list) =>
      list.map((note) => (note.id === id ? { ...note, body, updatedAt: now } : note)),
    );
    this.#dirtyBodies.add(id);
    this.#bodyRevision.set(id, this.#nextRevision++);
    this.#schedule();
  }

  rename(id: string, title: string): void {
    const trimmed = title.trim();
    // A note with no title is a blank row in a list that shows only titles.
    if (trimmed.length === 0) return;

    const current = this.notes.get().find((note) => note.id === id);
    if (!current || current.title === trimmed) return;

    const now = Date.now();
    this.notes.update((list) =>
      list.map((note) => (note.id === id ? { ...note, title: trimmed, updatedAt: now } : note)),
    );
    // Only the index changed; no body is dirty, but the index itself now is.
    this.#indexDirty = true;
    this.#schedule();
  }

  select(id: string | null): void {
    if (this.selectedId.get() === id) return;
    this.selectedId.set(id);
    this.#indexDirty = true;
    // Not needed for correctness — `setBody` already updated the signal the
    // pending write reads. It is a checkpoint: a switch bounds how long a
    // body lives only in memory, where a kill rather than a clean quit would
    // lose it.
    void this.flush();
  }

  remove(id: string): void {
    const list = this.notes.get();
    const index = list.findIndex((note) => note.id === id);
    if (index < 0) return;

    const file = this.#bodyFiles.get(id);
    // There is no delete on the config API, so a released body is blanked at
    // the next save. Leaving it would keep a deleted note's text on disk.
    if (file) this.#released.add(file);
    this.#bodyFiles.delete(id);
    this.#dirtyBodies.delete(id);
    this.#bodyRevision.delete(id);

    const remaining = list.filter((note) => note.id !== id);
    this.notes.set(remaining);

    // Never leave the selection on a note that is gone: prefer whichever took
    // its place, then the one before it.
    if (this.selectedId.get() === id) {
      this.selectedId.set(remaining[index]?.id ?? remaining[index - 1]?.id ?? null);
    }
    this.#indexDirty = true;
    this.#schedule();
  }

  /** Write everything pending now, cancelling the debounce. */
  async flush(): Promise<void> {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    await this.#persist();
  }

  #schedule(): void {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      void this.#persist();
    }, SAVE_DELAY);
  }

  /**
   * The public entry point for both the debounce timer and `flush()`. Queues
   * behind whatever save is already running instead of starting a second one
   * alongside it — see `#saveChain`.
   */
  async #persist(): Promise<void> {
    const run = this.#saveChain.then(() => this.#doPersist());
    // However `run` settles, the chain itself must not — a rejection sitting
    // in `#saveChain` would jam every persist queued after it, forever.
    this.#saveChain = run.catch(() => {});
    await run;
  }

  /**
   * Sequential rather than parallel: there are a handful of small files, and
   * the ordering below is the point.
   */
  async #doPersist(): Promise<void> {
    let failure: string | null = null;
    // Ids and released files that failed to write on this call. Either kind
    // of write that keeps failing must stay pending for the *next* persist,
    // but must not make the loops below retry it forever within this one.
    const failed = new Set<string>();
    const failedReleases = new Set<string>();
    // Whether the index write has already failed once this call — mirrors
    // `failed` / `failedReleases`: an index write that keeps failing must not
    // spin the outer loop forever just because `#indexDirty` stays set.
    let indexFailed = false;

    // One full pass — bodies, then released files, then the index — and the
    // whole pass repeats for as long as anything landed during it. A
    // setBody or a delete arriving while the *index* write (or the released
    // loop) is in flight is exactly as capable of being lost as one landing
    // during a body write, and flush() promises the caller nothing is left
    // pending when it returns — not "call me again." Each extra pass is
    // paid for by one real user edit, the same bound the body drain below
    // already relies on, so this does not introduce a new way to spin
    // forever: a write that keeps failing is fenced off by `failed` /
    // `failedReleases` above, not retried into an infinite loop.
    for (;;) {
      // Bodies first. An index naming a body that is not on disk yet would
      // lose that text if the process died between the two writes.
      //
      // Drained rather than one pass over a fixed list: a second note's
      // edit can land while an earlier note's write — ahead of it in this
      // same loop — is still in flight, and that second note's dirty flag
      // must not be judged against text this call captured before the edit
      // happened. Looking the note up fresh, immediately before its own
      // write, is what keeps the text written and the revision compared in
      // the same tick.
      for (;;) {
        const id = [...this.#dirtyBodies].find((candidate) => !failed.has(candidate));
        if (!id) break;

        const file = this.#bodyFiles.get(id);
        const note = this.notes.get().find((entry) => entry.id === id);
        if (!note || !file) {
          this.#dirtyBodies.delete(id);
          continue;
        }

        const revisionAtStart = this.#bodyRevision.get(id);
        const problem = await this.#write(file, note.body);
        if (problem) {
          // Stay dirty on failure so the next save tries again: until this
          // write lands, the text exists nowhere but memory.
          failure ??= problem;
          failed.add(id);
          continue;
        }
        // A setBody landing while the write above was in flight bumped the
        // revision again — the text just written is already stale, so the
        // id stays dirty and comes right back around this same loop.
        if (this.#bodyRevision.get(id) === revisionAtStart) this.#dirtyBodies.delete(id);
      }

      for (const file of [...this.#released]) {
        if (failedReleases.has(file)) continue;
        const problem = await this.#write(file, '');
        if (problem) {
          failure ??= problem;
          failedReleases.add(file);
        } else {
          this.#released.delete(file);
        }
      }

      // Read fresh rather than reusing anything captured before the drain
      // above: a note created mid-persist has no dirty body left to write
      // it into the index by the time we get here, but it still needs a
      // row.
      const notes = this.notes.get();
      const data: NotesFile = {
        version: VERSION,
        selectedId: this.selectedId.get(),
        notes: notes.flatMap((note) => {
          const file = this.#bodyFiles.get(note.id);
          return file
            ? [
                {
                  id: note.id,
                  title: note.title,
                  createdAt: note.createdAt,
                  updatedAt: note.updatedAt,
                  body: file,
                },
              ]
            : [];
        }),
      };
      // `rename`/`select` change only this index-shaped state — a title, a
      // selection — with no body write to carry it, so `#dirtyBodies` and
      // `#released` cannot see them. Snapshotting the flag before the write
      // and comparing after it settles is the same trick `#bodyRevision`
      // plays above: `data` was built from state as of a moment ago, so a
      // rename landing while this write is in flight makes what just landed
      // on disk stale, and the flag must survive to force another pass.
      const dirtyBeforeWrite = this.#indexDirty;
      const problem = await this.#write(INDEX_FILE, JSON.stringify(data));
      if (problem) {
        failure ??= problem;
        indexFailed = true;
        // Stay dirty on failure, same as a body: until an index write lands,
        // a rename or a selection change exists nowhere but memory.
        this.#indexDirty = true;
      } else if (this.#indexDirty === dirtyBeforeWrite) {
        // Nothing set the flag again while the write above was in flight.
        this.#indexDirty = false;
      }

      // Anything that moved on while the released loop or the index write
      // above were in flight needs another full pass; anything left is
      // either settled or has already failed once this call.
      const stillDirty = [...this.#dirtyBodies].some((id) => !failed.has(id));
      const stillReleased = [...this.#released].some((file) => !failedReleases.has(file));
      const stillIndexDirty = this.#indexDirty && !indexFailed;
      if (!stillDirty && !stillReleased && !stillIndexDirty) break;
    }

    this.error.set(failure);
  }

  async #read(name: string): Promise<string | null> {
    try {
      const contents = await this.#platform.readConfigFile(name);
      // Blank is how a released body is marked; treat it as absent.
      return contents && contents.length > 0 ? contents : null;
    } catch {
      return null;
    }
  }

  /** Returns the failure message, or null when the write landed. */
  async #write(name: string, contents: string): Promise<string | null> {
    try {
      await this.#platform.writeConfigFile(name, contents);
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  }
}

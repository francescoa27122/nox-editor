import { Signal } from '@core/signal';
import type { NoteAnchor } from '@core/anchor';
import { highestNumbered, type DamagedFile } from '@core/damaged-config';
import type { Platform } from '@platform/types';
import { preserveDamaged } from './damaged-config';

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
/** Fallback for a record whose title was lost, e.g. an empty string on disk. */
const UNTITLED = 'Untitled note';
/** Matches the session's debounce; tuned for the same reason — typing. */
const SAVE_DELAY = 400;

export type { NoteAnchor };

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
  /** Held at the top of the list. Organisational, not content. */
  pinned: boolean;
  /** Where its subject lives, when it has one. */
  anchor?: NoteAnchor;
}

/** A note in the index. The body lives in the file this names. */
interface NoteRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Config-relative file holding the body. */
  body: string;
  /**
   * Optional on disk on purpose. `load()` discards the whole file when
   * `version` does not match, so bumping VERSION for a new field would make
   * an older index take every note down with it. Absent reads as `false`,
   * and an older build ignores a key it does not know — compatible in both
   * directions without a bump.
   */
  pinned?: boolean;
  /** Optional on disk for the same reason `pinned` is — no VERSION bump. */
  anchor?: NoteAnchor;
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
  /**
   * The index Nox could not read at boot, and where it kept a copy.
   *
   * Separate from `error` for the reason `ConfigService.damaged` is. Reported
   * by `app.ts`, like `error`, so this service keeps its single dependency.
   */
  readonly damaged = new Signal<DamagedFile | null>(null);

  #platform: Platform;
  /** Note id → the config file holding its body. */
  #bodyFiles = new Map<string, string>();
  /** Notes whose body has moved since the last successful write. */
  #dirtyBodies = new Set<string>();
  /** Body files of deleted notes, waiting to be blanked. */
  #released = new Set<string>();
  /**
   * Whether index-only state — a title, a selection, list membership — has
   * moved since the current index write started. Set by `rename()`,
   * `select()` and `remove()`, which carry no dirty body to ride on;
   * `#dirtyBodies` and `#released` are both body-shaped and cannot see them.
   *
   * A boolean, where this was once a pair of revision counters. The counters
   * existed because the flag was cleared *after* the write, which made
   * "unchanged since the write started" indistinguishable from "changed, and
   * the new value happens to match" — a second rename landing on an index
   * write that was already dirty when it started. Clearing before the write
   * removes the ambiguity at the source: the flag is false while the write is
   * in flight, so anything that sets it is unambiguously newer than the data
   * being written.
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
      await this.#reportDamage(raw);
      return;
    }
    // A version this build does not know is usually a newer Nox having
    // written the file. Not corruption, but the consequence is identical:
    // discarded, then overwritten by the next save.
    if (parsed.version !== VERSION || !Array.isArray(parsed.notes)) {
      await this.#reportDamage(raw);
      return;
    }

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
        pinned: record.pinned ?? false,
        // Spread so an absent anchor stays absent rather than becoming an
        // explicit `undefined` key, which `toEqual` and JSON both notice.
        ...(record.anchor ? { anchor: record.anchor } : {}),
      });
    }

    this.notes.set(loaded);
    const wanted = parsed.selectedId;
    this.selectedId.set(
      loaded.some((note) => note.id === wanted) ? wanted : (loaded[0]?.id ?? null),
    );
  }

  /**
   * Preserve an index that could not be read, and salvage the ordinal from it.
   *
   * `#nextOrdinal`'s own comment promises that a restart "cannot reissue one
   * and overwrite the body file of an existing note" — a guarantee that held
   * in every case except this one, where the ids it recomputes from never
   * arrive. The ids and the body filenames both survive in the raw text of a
   * file that will not parse, so the counter is recovered from whichever of
   * the two reaches higher.
   */
  async #reportDamage(raw: string): Promise<void> {
    this.#nextOrdinal =
      Math.max(highestNumbered(raw, /"n(\d+)"/g), highestNumbered(raw, /note-(\d+)\.txt/g)) + 1;
    this.damaged.set(await preserveDamaged(this.#platform, INDEX_FILE, raw));
  }

  /** Create an empty note, select it, and return its id. */
  create(): string {
    const ordinal = this.#nextOrdinal++;
    const id = `n${ordinal}`;
    const now = Date.now();

    this.#bodyFiles.set(id, `note-${ordinal}.txt`);
    this.#dirtyBodies.add(id);
    // Deliberately does not set #indexDirty. A new note is also an
    // index-only change (its id and title need a row), but it rides on the
    // dirty body instead: that keeps at least one full pass alive, and the
    // index write within that pass is unconditional and reads notes fresh,
    // so the new row is captured regardless. If the index write ever stops
    // being unconditional, this stops being true and create() needs its own
    // #indexDirty set.
    // Numbered rather than a shared "Untitled note": the list shows only
    // titles, so three fresh notes with the same default would be three
    // indistinguishable rows. Matches `WorkspaceService.newUntitled`, which
    // numbers buffers the same way for the same reason.
    const title = `Untitled note ${ordinal}`;
    // Newest first, and the list never re-sorts afterwards: this is the only
    // place order is decided.
    this.notes.update((list) => [
      { id, title, body: '', createdAt: now, updatedAt: now, pinned: false },
      ...list,
    ]);
    this.selectedId.set(id);
    this.#schedule();
    return id;
  }

  /**
   * Add a note from a file, keeping whatever the file carried.
   *
   * **Always adds.** The `id` a file names is deliberately ignored and a
   * fresh one minted: files carry the id they were exported with, so
   * re-importing an export of this very folder would otherwise rewrite every
   * note in place. Merging needs a conflict UI and a rule for which side
   * wins; adding needs neither, and a duplicate note is a nuisance where an
   * overwritten one is a loss.
   *
   * One update rather than `create()` followed by four setters: importing a
   * folder is the one path where the per-note cost is multiplied by however
   * many files were picked.
   */
  importNote(note: {
    id?: string;
    title: string;
    body: string;
    pinned?: boolean;
    anchor?: NoteAnchor;
    createdAt?: number;
    updatedAt?: number;
  }): string {
    const ordinal = this.#nextOrdinal++;
    const id = `n${ordinal}`;
    const now = Date.now();

    this.#bodyFiles.set(id, `note-${ordinal}.txt`);
    this.#dirtyBodies.add(id);
    // Rides on the dirty body exactly as `create()` does, for the same
    // reason — see the comment there.
    this.notes.update((list) => [
      {
        id,
        title: note.title.trim() || UNTITLED,
        body: note.body,
        createdAt: note.createdAt ?? now,
        updatedAt: note.updatedAt ?? now,
        pinned: note.pinned ?? false,
        ...(note.anchor ? { anchor: note.anchor } : {}),
      },
      ...list,
    ]);
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

  /**
   * Hold a note at the top of the list, or release it.
   *
   * Deliberately does not touch `updatedAt`: pinning is organisational, and a
   * note that says it was edited when it was only filed is lying about the
   * one timestamp a reader trusts.
   */
  pin(id: string, pinned: boolean): void {
    const current = this.notes.get().find((note) => note.id === id);
    if (!current || current.pinned === pinned) return;

    this.notes.update((list) =>
      list.map((note) => (note.id === id ? { ...note, pinned } : note)),
    );
    // Index-only, exactly like `rename()`: no body moved and nothing was
    // released, so this flag is the only thing that will carry it.
    this.#indexDirty = true;
    this.#schedule();
  }

  /**
   * Point a note at a place in the code, or unpoint it.
   *
   * The anchor is stored verbatim and never inspected. A path that resolves
   * to nothing in the current workspace is still worth keeping: it costs the
   * jump, not the note.
   */
  setAnchor(id: string, anchor: NoteAnchor | null): void {
    const current = this.notes.get().find((note) => note.id === id);
    if (!current) return;

    this.notes.update((list) =>
      list.map((note) => {
        if (note.id !== id) return note;
        if (!anchor) {
          const { anchor: _dropped, ...rest } = note;
          return rest;
        }
        return { ...note, anchor };
      }),
    );
    // Index-only, exactly like `rename()` and `pin()`.
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
    // `failed` / `failedReleases`: a failing index write re-arms
    // `#indexDirty` on its way out, so without this the outer loop would
    // pick it straight back up and never terminate.
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
      // same loop — is still in flight, and writing that note from text this
      // call captured before the edit happened would persist the stale
      // version. Looking the note up fresh, immediately before its own
      // write, is what keeps the text written and the flag cleared for it in
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

        // Cleared *before* the write, not after. A setBody landing while the
        // write is in flight puts the id straight back, which is the whole
        // mechanism — there is no revision to capture and compare.
        this.#dirtyBodies.delete(id);
        const problem = await this.#write(file, note.body);
        if (problem) {
          // Until this write lands the text exists nowhere but memory, so
          // re-arm. `failed` is what stops this same call retrying it
          // forever now that a failure re-dirties the id.
          this.#dirtyBodies.add(id);
          failure ??= problem;
          failed.add(id);
        }
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
                  pinned: note.pinned,
                  ...(note.anchor ? { anchor: note.anchor } : {}),
                },
              ]
            : [];
        }),
      };
      // `rename`/`select`/`remove` change only this index-shaped state — a
      // title, a selection, list membership — with no body write to carry
      // it, so `#dirtyBodies` and `#released` cannot see them. `#indexDirty`
      // is what catches them, and it is cleared immediately below rather
      // than after the write: `data` is the state as of this moment, so a
      // change arriving during the await is unambiguously newer than what
      // is being written and forces another pass. Clearing afterwards is
      // what used to need a revision counter, because then a second rename
      // landing on an already-dirty write could not be told apart from no
      // rename at all.
      // Cleared before the write for the same reason as a body: a rename or
      // a selection landing during the await sets it again by itself. `data`
      // is built just above and nothing awaits in between, so the flag going
      // false cannot race the snapshot it corresponds to.
      this.#indexDirty = false;
      const problem = await this.#write(INDEX_FILE, JSON.stringify(data));
      if (problem) {
        // Until an index write lands, a rename or a selection change exists
        // nowhere but memory, so re-arm.
        this.#indexDirty = true;
        failure ??= problem;
        indexFailed = true;
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

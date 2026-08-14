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
  /** Body files of deleted notes, waiting to be blanked. */
  #released = new Set<string>();
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
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
   * Sequential rather than parallel: there are a handful of small files, and
   * the ordering below is the point.
   */
  async #persist(): Promise<void> {
    const notes = this.notes.get();
    let failure: string | null = null;

    // Bodies first. An index naming a body that is not on disk yet would lose
    // that text if the process died between the two writes.
    for (const id of [...this.#dirtyBodies]) {
      const note = notes.find((entry) => entry.id === id);
      const file = this.#bodyFiles.get(id);
      if (!note || !file) {
        this.#dirtyBodies.delete(id);
        continue;
      }
      const problem = await this.#write(file, note.body);
      // Stay dirty on failure so the next save tries again: until this write
      // lands, the text exists nowhere but memory.
      if (problem) failure ??= problem;
      else this.#dirtyBodies.delete(id);
    }

    for (const file of [...this.#released]) {
      const problem = await this.#write(file, '');
      if (problem) failure ??= problem;
      else this.#released.delete(file);
    }

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
    const problem = await this.#write(INDEX_FILE, JSON.stringify(data));
    if (problem) failure ??= problem;

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

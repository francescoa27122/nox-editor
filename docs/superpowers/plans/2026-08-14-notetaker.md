# Notetaker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third sidebar section holding the user's own notes — a list, and an editor for the selected one — persisted outside the workspace so opening a different folder never touches them.

**Architecture:** A `NotesService` that depends on `Platform` and nothing else, persisting through the config-file API as a small `notes.json` index plus one `note-<n>.txt` per body. A render-only `NotesPanel.svelte` in the sidebar. Four commands in `app.ts`, one keybinding. None of the buffer, transaction, change-set or watcher machinery is involved.

**Tech Stack:** TypeScript, Svelte 5 runes, Vitest, Rust (one file, for the atomic config write).

**Spec:** `docs/superpowers/specs/2026-08-14-notetaker-design.md` — read it before Task 2. The plan argues from it.

## Global Constraints

- Branch: `notes-panel`. It already exists and holds the spec commit.
- **Logic in services, components only render.** No `if` deciding behaviour in a platform adapter or a `.svelte` file.
- **Every user action is a command** registered in `src/app.ts`, so it reaches the palette (`Mod+Shift+P`) whether or not it has a chord.
- **Nothing is added to `SETTINGS_SCHEMA`.** No component hardcodes a default, because there is no setting to default.
- Every colour, radius, spacing and duration comes from `src/styles/tokens.css`. Dark only. No new CSS custom properties.
- Comments explain **why**, not what. Match the density of the file you are in.
- Every test carries a comment naming the regression it prevents. House style: `tests/terminal.test.ts`.
- Files are UTF-8. Icons live on the 16×16 grid at 1.5px optical weight.
- Verify commands: `npm test` (530 tests today), `npm run check`, `cargo test --manifest-path src-tauri/Cargo.toml`.
- Commit after every task. Do not push.

## Deviations from the spec, decided while planning

Three, all narrowing:

1. **No title `<input>` in the panel.** The spec's diagram showed one alongside a `notes.rename` command that opens `ui.askForText` — two rename paths for one operation, and a controlled input whose value changes underneath the caret. The selected note's title is a button; clicking it runs `notes.rename`. This matches how the explorer renames files and removes a focus-management problem entirely.
2. **One focus signal, not two.** Consequence of (1): `ui.focusNotesRequest` focuses the body textarea, and nothing else needs focusing.
3. **`select()` flushing is a durability checkpoint, not a correctness fix.** The spec implied switching notes could lose text. It cannot — `setBody` updates the signal synchronously, so the debounced write always sees current text. The flush bounds how long a body lives only in memory before a `kill -9`. The test in Task 3 guards the real regression: persisting only the *selected* note's body instead of every dirty one.

## File structure

| File | Responsibility |
|---|---|
| `src-tauri/src/fs.rs` | *modify* — config writes go through the existing temp-then-rename path |
| `src/services/notes.ts` | *create* — the whole notes model, ordering, debounce, persistence, failure policy |
| `src/services/ui.ts` | *modify* — `'notes'` as a sidebar view and focus zone |
| `src/ui/NotesPanel.svelte` | *create* — renders the list and the body; decides nothing |
| `src/ui/Sidebar.svelte` | *modify* — one rail entry, one branch |
| `src/ui/Icon.svelte` | *modify* — `note` and `trash` glyphs |
| `src/app.ts` | *modify* — construction, four commands, one binding, boot, dispose, error reporting |
| `tests/notes.test.ts` | *create* — the service against fake platforms |

---

### Task 1: Config writes survive a crash

`nox_write_config` calls `fs::write`, which truncates the target and then writes into it. A crash in that window leaves a truncated config file. `write_then_rename` already exists 287 lines above it in the same file and is what file saves use. Notes make this urgent — a torn `notes.json` costs every note's title and ordering — but settings and session get the fix too.

**Files:**
- Modify: `src-tauri/src/fs.rs:409-412` (the command), plus a new helper above it and a test in the existing `mod tests`

**Interfaces:**
- Consumes: nothing
- Produces: `fn write_config_atomically(path: &Path, contents: &str) -> Result<()>` — module-private, used by `nox_write_config` and by the test

- [ ] **Step 1: Write the failing test**

Add to the existing `mod tests` block at the bottom of `src-tauri/src/fs.rs`:

```rust
    /// The failure this prevents: `fs::write` truncates the target before it
    /// writes, so a crash mid-write leaves a half-written config file. Session
    /// and notes both keep their index there, and a truncated index reads as
    /// "you have no notes".
    #[test]
    fn config_writes_replace_atomically_and_leave_no_litter() {
        let scratch = Scratch::new("config-atomic");
        let path = scratch.0.join("notes.json");

        write_config_atomically(&path, r#"{"version":1}"#).expect("first write");
        write_config_atomically(&path, r#"{"version":2}"#).expect("overwrite");

        assert_eq!(fs::read_to_string(&path).expect("read"), r#"{"version":2}"#);

        // A `.tmp` sibling left behind would sit in the user's config
        // directory forever: there is no cleanup pass, and the config API
        // lists nothing, so nothing would ever notice it.
        let strays: Vec<String> = fs::read_dir(&scratch.0)
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name != "notes.json")
            .collect();
        assert!(strays.is_empty(), "left behind: {strays:?}");
    }
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cargo test --manifest-path src-tauri/Cargo.toml config_writes_replace_atomically
```

Expected: compile error, `cannot find function write_config_atomically in this scope`.

- [ ] **Step 3: Add the helper and point the command at it**

In `src-tauri/src/fs.rs`, replace the existing `nox_write_config` (currently `let path = config_path(&app, &name)?; fs::write(&path, contents)...`) with:

```rust
/// The write itself, split from the command so it can be tested without an
/// `AppHandle`.
fn write_config_atomically(path: &Path, contents: &str) -> Result<()> {
    // Same reasoning as a file save: truncate-then-write leaves a window where
    // a crash costs the whole file. A config path always has a parent
    // directory, so the sibling temp always has somewhere to live.
    let temp = temp_path_for(path);
    let outcome = write_then_rename(&temp, path, contents.as_bytes());
    if outcome.is_err() {
        let _ = fs::remove_file(&temp);
    }
    outcome
}

#[tauri::command]
pub fn nox_write_config(app: tauri::AppHandle, name: String, contents: String) -> Result<()> {
    let path = config_path(&app, &name)?;
    write_config_atomically(&path, &contents)
}
```

- [ ] **Step 4: Run the whole Rust suite**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: PASS, 34 tests (33 today plus the new one).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/fs.rs
git commit -m "Write config files atomically

fs::write truncates before it writes, so a crash mid-write leaves a
half-written settings or session file. The temp-then-rename path used by
file saves was already in this file; the config command just was not
using it."
```

---

### Task 2: NotesService — create, edit, persist, reload

The core. Notes round-trip through the config API, ordering is explicit, and each body is its own file so a keystroke in one note does not rewrite the others.

**Files:**
- Create: `src/services/notes.ts`
- Create: `tests/notes.test.ts`

**Interfaces:**
- Consumes: `Signal` from `@core/signal`; `Platform` from `@platform/types` (`readConfigFile(name): Promise<string | null>`, `writeConfigFile(name, contents): Promise<void>`)
- Produces:
  - `export interface Note { id: string; title: string; body: string; createdAt: number; updatedAt: number }`
  - `export class NotesService` with `notes: Signal<Note[]>`, `selectedId: Signal<string | null>`, `error: Signal<string | null>`, `constructor(platform: Platform)`, `load(): Promise<void>`, `create(): string`, `setBody(id: string, body: string): void`, `flush(): Promise<void>`
  - `rename`, `select`, `remove` arrive in Task 3

- [ ] **Step 1: Write the failing tests**

Create `tests/notes.test.ts`:

```ts
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
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/notes.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/services/notes"`.

- [ ] **Step 3: Write the service**

Create `src/services/notes.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/notes.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run check
git add src/services/notes.ts tests/notes.test.ts
git commit -m "Add the notes service

An index plus one file per body, so a keystroke in one note does not
rewrite the others and a torn write cannot cost all of them. The
constructor takes a platform and nothing else: that is what makes
'opening a folder cannot touch your notes' structural rather than a
convention."
```

---

### Task 3: NotesService — rename, delete, selection, failure reporting

Everything that changes which note exists or which one is selected, plus what happens when the disk says no.

**Files:**
- Modify: `src/services/notes.ts`
- Modify: `tests/notes.test.ts`

**Interfaces:**
- Consumes: Task 2's `NotesService`
- Produces: `rename(id: string, title: string): void`, `select(id: string | null): void`, `remove(id: string): void`

- [ ] **Step 1: Write the failing tests**

Append to `tests/notes.test.ts`:

```ts
/** Fails every config write, to exercise the save-failure path. */
class RefusingPlatform extends MemoryPlatform {
  failing = false;

  override async writeConfigFile(name: string, contents: string): Promise<void> {
    if (this.failing) throw new Error('disk is full');
    await super.writeConfigFile(name, contents);
  }
}

describe('renaming', () => {
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

  it('trims surrounding whitespace', () => {
    const notes = new NotesService(new MemoryPlatform());
    const id = notes.create();

    notes.rename(id, '  Ideas  ');

    expect(notes.notes.get()[0]!.title).toBe('Ideas');
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

  it('falls back to the previous note when the last one is deleted', () => {
    const notes = new NotesService(new MemoryPlatform());
    const oldest = notes.create();
    const newest = notes.create();
    notes.select(oldest);

    notes.remove(oldest);

    expect(notes.selectedId.get()).toBe(newest);
  });

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
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/notes.test.ts
```

Expected: FAIL — `notes.rename is not a function`.

- [ ] **Step 3: Add the three methods**

In `src/services/notes.ts`, insert after `setBody`:

```ts
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
    // Only the index changed; no body is dirty.
    this.#schedule();
  }

  select(id: string | null): void {
    if (this.selectedId.get() === id) return;
    this.selectedId.set(id);
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
    this.#schedule();
  }
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/notes.test.ts
```

Expected: PASS, 21 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run check
git add src/services/notes.ts tests/notes.test.ts
git commit -m "Rename, delete and select notes

Deleting blanks the body file, because the config API has no delete and
the text of a deleted note should not sit in the config directory. The
selection is never left pointing at a note that is gone."
```

---

### Task 4: The sidebar learns a third view

`showView` has a comment warning that it used to fall through to the explorer for anything that was not search — invisible with two views, a real bug with three.

**Files:**
- Modify: `src/services/ui.ts:22` (`SidebarView`), `:44` (`FocusZone`), `:102` (near the other focus requests), `:165` (`showView`), and after `focusSearch`

**Interfaces:**
- Consumes: nothing
- Produces: `SidebarView` includes `'notes'`; `FocusZone` includes `'notes'`; `ui.focusNotesRequest: Signal<number>`; `ui.focusNotes(): void`

- [ ] **Step 1: Widen the two unions**

In `src/services/ui.ts`:

```ts
/** Which panel the sidebar is showing. */
export type SidebarView = 'explorer' | 'search' | 'notes';
```

```ts
export type FocusZone = 'editor' | 'explorer' | 'search' | 'find' | 'overlay' | 'terminal' | 'notes';
```

- [ ] **Step 2: Add the focus request signal**

Directly below `readonly focusExplorerRequest = new Signal(0);`:

```ts
  /** Bumped to ask the notes panel to put the cursor in the note body. */
  readonly focusNotesRequest = new Signal(0);
```

- [ ] **Step 3: Add the branch and the focus method**

Extend `showView`, keeping the existing comment intact:

```ts
  showView(view: SidebarView): void {
    // Each branch focuses its own view. This used to fall through to
    // `focusExplorer` for anything that was not search, which set the view
    // straight back to the explorer — invisible while there were only two.
    if (view === 'search') this.focusSearch();
    else if (view === 'notes') this.focusNotes();
    else if (view === 'explorer') this.focusExplorer();
    else this.sidebarView.set(view);
  }
```

And after `focusSearch`:

```ts
  focusNotes(): void {
    this.sidebarView.set('notes');
    this.focusZone.set('notes');
    this.focusNotesRequest.update((n) => n + 1);
  }
```

- [ ] **Step 4: Typecheck**

```bash
npm run check
```

Expected: clean. A `SidebarView` widened without updating `Sidebar.svelte` still typechecks, because its `{#if}` has an `{:else}`; Task 6 gives `'notes'` its own branch.

- [ ] **Step 5: Commit**

```bash
git add src/services/ui.ts
git commit -m "Teach the sidebar a notes view

The third branch in showView is the one its own comment asks for: the
fallthrough it warns about was invisible with two views."
```

---

### Task 5: Two icons

There is no note or pencil glyph, and no trash glyph. Both are needed: the rail entry, and a delete affordance that is not the command palette.

**Files:**
- Modify: `src/ui/Icon.svelte` — the `PATHS` object in the `module` script

**Interfaces:**
- Consumes: nothing
- Produces: `IconName` includes `'note'` and `'trash'`

- [ ] **Step 1: Add both paths**

In the `PATHS` object in `src/ui/Icon.svelte`, after the `file` entry:

```ts
    // A page with ruled lines and deliberately no folded corner, so it does
    // not read as `file` at the rail's 15px.
    note: 'M3.5 2.5h9v11h-9Z M5.75 6h4.5M5.75 8.5h4.5M5.75 11h2.75',
    // `close` was the alternative and is wrong: it means "dismiss this"
    // everywhere else, and delete here is permanent.
    trash: 'M3 4.5h10 M6.25 4.5V2.9a.4.4 0 0 1 .4-.4h2.7a.4.4 0 0 1 .4.4v1.6 M4.6 4.5l.5 8.2a.8.8 0 0 0 .8.8h4.2a.8.8 0 0 0 .8-.8l.5-8.2',
```

Both are stroked, so neither goes in the `FILLED` set.

- [ ] **Step 2: Typecheck**

```bash
npm run check
```

Expected: clean.

- [ ] **Step 3: Look at them**

```bash
npm run dev
```

Open the app and confirm in the running UI that `note` is distinguishable from `file` at 15px and that neither glyph is optically heavier than its neighbours in the rail. Nudge the coordinates if it is off — the numbers above are a starting point, not a spec. The rail entry itself lands in Task 6; for now compare them wherever an icon already renders.

- [ ] **Step 4: Commit**

```bash
git add src/ui/Icon.svelte
git commit -m "Add note and trash icons"
```

---

### Task 6: The panel

Renders the list and the selected note's body. Decides nothing: every action calls a service or runs a command.

**Files:**
- Create: `src/ui/NotesPanel.svelte`
- Modify: `src/ui/Sidebar.svelte:21` (the `VIEWS` array) and `:44` (the `{#if}`)

**Interfaces:**
- Consumes: `app.notes` (Tasks 2–3), `app.ui.focusNotesRequest` (Task 4), the `note` and `trash` icons (Task 5), and the commands `notes.new` / `notes.rename` / `notes.delete` (Task 7 — the buttons are inert until then, which is expected)
- Produces: nothing other tasks consume

- [ ] **Step 1: Write the panel**

Create `src/ui/NotesPanel.svelte`:

```svelte
<script lang="ts">
  import { untrack } from 'svelte';
  import { useApp } from './context';
  import Icon from './Icon.svelte';

  /**
   * The notes panel: a list, and the selected note's body.
   *
   * A `<textarea>` rather than a second CodeMirror instance. A note is prose,
   * not a file: bracket matching, autocomplete and a language compartment are
   * code affordances, and dragging the editor stack in here would undo the
   * point of keeping notes out of the workspace. The textarea also gets native
   * spellcheck, which prose wants and code does not.
   */

  const app = useApp();
  const { notes, ui, commands } = app;

  const list = notes.notes;
  const selectedId = notes.selectedId;
  const focusRequest = ui.focusNotesRequest;

  let bodyInput = $state<HTMLTextAreaElement | null>(null);

  const selected = $derived($list.find((note) => note.id === $selectedId) ?? null);

  /**
   * Load the note into the textarea when the *selection* changes, and never
   * again. Rendering `value={selected.body}` would reassign the element's
   * value on every keystroke, which puts the caret back at the end — the same
   * class of bug as the dialog that kept only the last character typed.
   */
  $effect(() => {
    const id = $selectedId;
    if (!bodyInput) return;
    bodyInput.value = untrack(
      () => notes.notes.get().find((note) => note.id === id)?.body ?? '',
    );
  });

  $effect(() => {
    // Track the counter so a focus command re-runs this effect.
    void $focusRequest;
    untrack(() => bodyInput)?.focus();
  });

  $effect(() => {
    // Switching away from the panel is a checkpoint, like switching notes:
    // it bounds how long a body sits only in memory.
    return () => void notes.flush();
  });
</script>

<div class="notes-panel">
  <div class="header">
    <span class="title">Notes</span>
    <div class="header-actions">
      <button
        class="icon-button"
        title="New Note"
        aria-label="New note"
        onclick={() => void commands.execute('notes.new')}
      >
        <Icon name="plus" size={14} />
      </button>
      <button
        class="icon-button"
        title="Delete Note"
        aria-label="Delete note"
        disabled={selected === null}
        onclick={() => void commands.execute('notes.delete')}
      >
        <Icon name="trash" size={14} />
      </button>
    </div>
  </div>

  {#if $list.length === 0}
    <p class="empty">No notes yet.</p>
  {:else}
    <ul class="list">
      {#each $list as note (note.id)}
        <li>
          <button
            class="row"
            class:selected={note.id === $selectedId}
            aria-current={note.id === $selectedId}
            onclick={() => notes.select(note.id)}
          >
            <Icon name="note" size={13} />
            <span class="row-title">{note.title}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if selected}
    <div class="editor">
      <button class="note-title" title="Rename" onclick={() => void commands.execute('notes.rename')}>
        {selected.title}
      </button>
      <textarea
        bind:this={bodyInput}
        class="body"
        spellcheck="true"
        placeholder="Write…"
        aria-label="Note body"
        oninput={(event) => notes.setBody(selected.id, event.currentTarget.value)}
      ></textarea>
    </div>
  {/if}
</div>

<style>
  .notes-panel {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .header {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
    flex: none;
    height: 28px;
    padding: 0 var(--nox-sp-3) 0 var(--nox-sp-4);
  }

  .title {
    font-size: var(--nox-fs-2xs);
    font-weight: var(--nox-fw-semibold);
    letter-spacing: var(--nox-tracking-wide);
    text-transform: uppercase;
    color: var(--nox-text-muted);
  }

  .header-actions {
    display: flex;
    gap: var(--nox-sp-1);
    margin-left: auto;
  }

  .icon-button {
    display: grid;
    place-items: center;
    width: 22px;
    height: 20px;
    border-radius: var(--nox-r-sm);
    color: var(--nox-text-faint);
    transition:
      background var(--nox-dur-fast) var(--nox-ease),
      color var(--nox-dur-fast) var(--nox-ease);
  }

  .icon-button:hover:not(:disabled) {
    background: var(--nox-hover);
    color: var(--nox-text);
  }

  .icon-button:disabled {
    opacity: 0.4;
  }

  .empty {
    padding: var(--nox-sp-5) var(--nox-sp-4);
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-faint);
  }

  /* Capped so the body always has room: the list is for picking, not reading. */
  .list {
    flex: 0 1 auto;
    max-height: 40%;
    overflow-y: auto;
    padding: 0 var(--nox-sp-2);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-3);
    width: 100%;
    padding: var(--nox-sp-2) var(--nox-sp-3);
    border-radius: var(--nox-r-sm);
    color: var(--nox-text-muted);
    font-size: var(--nox-fs-sm);
    text-align: left;
  }

  .row:hover {
    background: var(--nox-hover);
    color: var(--nox-text);
  }

  .row.selected {
    background: var(--nox-selected);
    color: var(--nox-text-bright);
  }

  .row-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .editor {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    border-top: 1px solid var(--nox-border);
  }

  .note-title {
    flex: none;
    padding: var(--nox-sp-3) var(--nox-sp-4);
    color: var(--nox-text-bright);
    font-size: var(--nox-fs-sm);
    font-weight: var(--nox-fw-medium);
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .note-title:hover {
    background: var(--nox-hover);
  }

  .body {
    flex: 1;
    min-height: 0;
    resize: none;
    padding: 0 var(--nox-sp-4) var(--nox-sp-4);
    background: transparent;
    border: none;
    color: var(--nox-text);
    /* Prose, not code: the UI stack, not the mono one. */
    font-family: var(--nox-font-ui);
    font-size: var(--nox-fs-sm);
    line-height: var(--nox-lh-ui);
  }

  .body:focus {
    outline: none;
  }

  .body::placeholder {
    color: var(--nox-text-faint);
  }
</style>
```

- [ ] **Step 2: Wire it into the sidebar**

In `src/ui/Sidebar.svelte`, add the import beside the other two panels:

```svelte
  import NotesPanel from './NotesPanel.svelte';
```

Add the rail entry to `VIEWS`:

```ts
  const VIEWS: { id: SidebarView; icon: IconName; label: string; command: string }[] = [
    { id: 'explorer', icon: 'sidebar', label: 'Explorer', command: 'nav.focusExplorer' },
    { id: 'search', icon: 'search', label: 'Search', command: 'search.focus' },
    { id: 'notes', icon: 'note', label: 'Notes', command: 'notes.focus' },
  ];
```

And give it a branch:

```svelte
  {#if $view === 'search'}
    <SearchPanel />
  {:else if $view === 'notes'}
    <NotesPanel />
  {:else}
    <ExplorerPanel />
  {/if}
```

- [ ] **Step 3: Typecheck**

```bash
npm run check
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/ui/NotesPanel.svelte src/ui/Sidebar.svelte
git commit -m "Add the notes panel

A textarea, not a second CodeMirror: a note is prose, and the editor
stack is built for files. The body is loaded into the element when the
selection changes and never on a keystroke, or the caret jumps to the
end as you type."
```

---

### Task 7: Wire it into the app

Construction, boot, dispose, error reporting, four commands, one binding. Until this lands the panel's buttons do nothing and nothing loads at startup.

**Files:**
- Modify: `src/app.ts` — imports (~line 50), the field list (~line 93), the constructor (~line 130), `#boot` (~line 185), `#wireServices` (~line 249), `#registerCommands` (after the Terminal block, ~line 2053), `#registerKeybindings` (~line 2122), `dispose` (~line 2239)

**Interfaces:**
- Consumes: `NotesService` (Tasks 2–3), `ui.focusNotes` (Task 4)
- Produces: `app.notes: NotesService`; commands `notes.focus`, `notes.new`, `notes.rename`, `notes.delete`; the binding `Mod+Shift+N`

- [ ] **Step 1: Import, declare, construct**

Add the import alongside the other services:

```ts
import { NotesService } from '@services/notes';
```

Add the field next to `terminal`:

```ts
  /** The user's own notes — not workspace files. See `notes.ts`. */
  readonly notes: NotesService;
```

Construct it in the constructor, before `this.#wireServices()`. It takes the platform alone; nothing else is available to give it:

```ts
    this.notes = new NotesService(platform);
```

- [ ] **Step 2: Load at boot and flush at close**

In `#boot`, beside the other config-backed loads:

```ts
    await this.notes.load();
```

In `dispose`, beside the session save:

```ts
    await this.notes.flush();
```

- [ ] **Step 3: Report save failures**

In `#wireServices`:

```ts
    // Notes have no on-disk original to fall back on: a save that does not
    // land means the text exists only in memory, so it is worth saying.
    this.notes.error.subscribe((message) => {
      if (message) this.notifications.error('Could not save notes', message);
    });
```

- [ ] **Step 4: Register the commands**

In `#registerCommands`, after the Terminal block and before Preferences:

```ts
      // --- Notes ------------------------------------------------------------
      {
        id: 'notes.focus',
        title: 'Show Notes',
        category: 'Notes',
        keyHint: 'Mod+Shift+N',
        keywords: ['note', 'scratch', 'memo'],
        run: () => this.ui.focusNotes(),
      },
      {
        id: 'notes.new',
        title: 'New Note',
        category: 'Notes',
        keywords: ['note', 'create', 'add'],
        run: () => {
          this.notes.create();
          this.ui.focusNotes();
        },
      },
      {
        id: 'notes.rename',
        title: 'Rename Note',
        category: 'Notes',
        enabled: () => this.notes.selectedId.get() !== null,
        run: () => void this.#renameSelectedNote(),
      },
      {
        id: 'notes.delete',
        title: 'Delete Note',
        category: 'Notes',
        keywords: ['remove', 'trash'],
        enabled: () => this.notes.selectedId.get() !== null,
        run: () => void this.#deleteSelectedNote(),
      },
```

Then add the two helpers as private methods on `NoxApp`, next to the other dialog-driven helpers:

```ts
  async #renameSelectedNote(): Promise<void> {
    const id = this.notes.selectedId.get();
    const note = this.notes.notes.get().find((entry) => entry.id === id);
    if (!note) return;

    const title = await this.ui.askForText({
      title: 'Rename Note',
      label: 'Name',
      initialValue: note.title,
      confirmLabel: 'Rename',
      validate: (value) => (value.trim().length === 0 ? 'A note needs a name.' : null),
    });
    if (title === null) return;
    this.notes.rename(note.id, title);
  }

  async #deleteSelectedNote(): Promise<void> {
    const id = this.notes.selectedId.get();
    const note = this.notes.notes.get().find((entry) => entry.id === id);
    if (!note) return;

    // A confirm rather than an undo: there is no trash to recover from, and
    // nothing else in the app will resurrect the text.
    const choice = await this.ui.askToConfirm({
      title: 'Delete Note',
      message: `Delete “${note.title}”? This cannot be undone.`,
      choices: [
        { id: 'delete', label: 'Delete', danger: true },
        { id: 'cancel', label: 'Cancel' },
      ],
    });
    if (choice !== 'delete') return;
    this.notes.remove(note.id);
  }
```

- [ ] **Step 5: Bind the chord**

In `#registerKeybindings`, beside the other two sidebar views:

```ts
      'Mod+Shift+E': 'nav.focusExplorer',
      'Mod+Shift+F': 'search.focus',
      'Mod+Shift+N': 'notes.focus',
```

- [ ] **Step 6: Typecheck and run every test**

```bash
npm run check && npm test
```

Expected: clean, and 551 tests passing (530 today plus Tasks 2–3's 21).

- [ ] **Step 7: Verify in the running app**

```bash
npm run dev
```

Walk the whole feature and confirm each of these by looking at it, not by reasoning about it:

1. `Mod+Shift+N` opens the Notes panel and the rail shows three icons.
2. The `+` button creates a note; typing in the body leaves the caret where you put it, including when you type in the middle of a word.
3. Clicking the title opens the rename dialog; renaming updates both the list row and the title.
4. Create a second note, type in it, switch back to the first — the first note's text is intact.
5. The trash button asks before deleting, and is disabled when nothing is selected.
6. All four commands appear in the palette under **Notes** (`Mod+Shift+P`, type "note"), and rename and delete are greyed when no note is selected.
7. Reload the window (**Reload Window** in the palette — Tauri wires no `⌘R`) and confirm every note, its text and the selection all come back.
8. Open a different folder and confirm the notes are unchanged. This is the requirement the whole design exists for.

- [ ] **Step 8: Commit**

```bash
git add src/app.ts
git commit -m "Wire notes into the app

Four commands so everything is reachable from the palette, and
Mod+Shift+N alongside the other two sidebar views. Deleting asks first:
there is no trash to recover a note from."
```

---

### Task 8: Document it

`ARCHITECTURE.md` §4 records decisions with their tradeoffs, and the notes' persistence shape is exactly the kind of decision that is invisible from the code and expensive to rediscover.

**Files:**
- Modify: `ARCHITECTURE.md` — §3 (where things live) and a new §4 subsection
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the §4 subsection**

Add after the terminal's §4 subsection ("The terminal is a pty, and that is not a detail"), matching the surrounding prose style — the decision, the alternative, and what it cost:

```markdown
### Notes are not files, and are not stored like them

A note has no reader but the user. A file has git, a compiler, and an agent
staging a change set — which is why files get buffers, transactions, dirty
tracking and a watcher, and why notes get none of it. `NotesService` takes a
`Platform` and nothing else: with no workspace in reach, opening another
folder cannot change or hide notes, and no later edit can make it so by
accident.

Storage is a small `notes.json` index plus one `note-<n>.txt` per body. One
JSON holding everything was the obvious alternative and was rejected twice
over. It would rewrite every note on every keystroke, which is precisely the
write amplification session v3 caused and v4 undid. And it would put every
note behind one write: torn once, they are all gone. Split, a torn index costs
titles and ordering while the bodies survive, and a torn body costs one note.

The cost is real: two files to keep agreed, and a load that has to tolerate an
index naming a body that is not there. That case is handled by loading the
note with an empty body rather than dropping it — the title is still worth
keeping.

Notes always autosave, on a 400 ms debounce, and do not follow
`files.autoSave`. That setting exists because writing a file is an
outward-facing act with other observers; a note has none. There is no setting
of its own either, because a preference that stops saving your notes is a
preference that loses them.
```

- [ ] **Step 2: Add the §3 entry**

§3 is an indented tree, not a table, and it lists `services/` file by file
while `ui/` is one line ("Svelte. Rendering only."). So `NotesPanel.svelte`
gets no entry and `notes.ts` gets one. Add it to the `services/` block between
`session.ts` and `ui.ts`, keeping the box-drawing characters and the existing
column alignment:

```
│  ├─ notes.ts          The user's own notes. No workspace, by construction.
```

- [ ] **Step 3: Add the changelog entry**

`CHANGELOG.md` already has `## [Unreleased]` with an `### Added` block whose
entries lead with a bolded phrase and use nested bullets for detail. Add these
to that block, after the terminal entry:

```markdown
- **Notes.** A third sidebar section for your own notes — a list, and an
  editor for the one you pick. <kbd>⌘⇧N</kbd>, or **Show Notes** in the
  palette.
  - They are not workspace files and are stored outside any project, so
    opening a different folder never changes or hides them.
  - Always saved, a moment after you stop typing. There is no save button and
    no setting: a preference that stops saving your notes is a preference that
    loses them.

### Fixed

- Config files are written atomically, so a crash part-way through a save can
  no longer truncate your settings, session or notes.
```

Check whether `### Fixed` already exists under `## [Unreleased]` before adding
a second one.

- [ ] **Step 4: Final verification**

```bash
npm run check && npm test && cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: clean, 551 TypeScript tests, 34 Rust tests. Report the actual numbers — do not restate the expectation.

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md CHANGELOG.md
git commit -m "Document the notes panel

Why notes get an index plus one file per body, and why that is not the
same question as the atomic write."
```

---

## Notes for the executor

- **Tasks 1 and 2 are independent.** Task 1 touches only Rust; Task 2 only TypeScript. Either order works.
- **Tasks 4, 5 and 6 are ordered by dependency** — Task 6 imports both the icon from Task 5 and the focus signal from Task 4.
- **The panel's buttons are inert until Task 7.** That is expected, not a bug: the commands do not exist yet.
- **Do not add anything to `SETTINGS_SCHEMA`.** If a setting seems necessary, stop and raise it — the spec argues against every candidate.
- **Tests passing is not the finish line.** Task 7 Step 7 exists because this project has repeatedly found real bugs that a green suite missed. Walk all eight checks in the running app.

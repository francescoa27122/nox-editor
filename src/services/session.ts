import { highestNumbered, type DamagedFile } from '@core/damaged-config';
import type { Encoding } from '@core/encoding';
import { Signal } from '@core/signal';
import type { Platform } from '@platform/types';
import { preserveDamaged } from './damaged-config';
import type { SelectionRecord, WorkspaceService } from './workspace';

/**
 * Session persistence: which folder was open, which tabs, which one was
 * focused, where the cursor was in each, and any unsaved work.
 *
 * Restoring untitled buffers matters more than it looks — an editor that
 * silently drops a scratch buffer on quit is an editor you stop trusting.
 * The same reasoning applies to a *file* buffer with unsaved edits, which is
 * why those are recorded here too rather than prompted for at quit: nothing
 * the user typed should depend on them answering a dialog correctly.
 */

const SESSION_FILE = 'session.json';

/** Tab churn during startup, and a burst of typing, should be one write. */
const SAVE_DEBOUNCE_MS = 400;

/**
 * The same debounce, for a session holding a dirty buffer over
 * `LARGE_FILE_BYTES`.
 *
 * The backup is the one thing large-file mode must not simply switch off: it
 * *is* the unsaved work, and dropping it would mean the larger the file the
 * less Nox protects what you typed into it. So it is written less often
 * rather than less completely. The debounce is trailing, so the text still
 * reaches disk once typing stops; what changes is that pauses shorter than
 * this cost one write between them instead of one each, and a 5 MB backup
 * costs 4.9 ms of `toString` plus `JSON.stringify` on the renderer side alone
 * before Rust copies it again (see `LARGE_FILE_BYTES`).
 *
 * The exposure that buys is bounded and worth naming: a *crash* loses at most
 * this much typing in a file over the threshold rather than 400 ms of it.
 * Quitting and closing the window call `save()` directly and are unaffected.
 */
const LARGE_FILE_SAVE_DEBOUNCE_MS = 2_000;

/**
 * 2 added editor groups. 3 added cursor positions and unsaved file contents.
 * 4 moved that content out into per-buffer backup files. Older sessions are
 * migrated, not discarded.
 */
const VERSION = 4;

/**
 * Unsaved content lives in its own file, one per buffer.
 *
 * Version 3 inlined it, which meant a keystroke in a 5 MB dirty file rewrote
 * 5 MB of JSON every time the debounce fired — across the IPC boundary, on the
 * typing path. Now `session.json` stays small and describes the layout, and a
 * backup is only rewritten when *that* buffer has actually moved.
 */
interface UnsavedRecord {
  /** Config-relative file holding the text. */
  backup?: string;
  /** Version 3 and earlier put the text here. Read, never written. */
  content?: string;
  /**
   * The file's mtime as Nox last saw it. If the file has moved on by the time
   * we restore, the buffer is flagged as externally modified rather than
   * quietly resurrecting edits based on content that no longer exists.
   */
  baseMtime: number;
}

type TabRecord =
  | {
      kind: 'file';
      path: string;
      selection?: SelectionRecord;
      unsaved?: UnsavedRecord;
      /**
       * A second view of a file an earlier group already restored.
       *
       * `restore` opens tabs by path, and `open` focuses a buffer that is
       * already open rather than adding a tab — so without this the second
       * pane silently lost its copy on every restart.
       *
       * Optional, and VERSION is deliberately **not** bumped for it: `#read`
       * discards a session whose version it does not recognise, so a bump
       * would cost every tab rather than one pane. An older Nox reading this
       * ignores the field and opens the file once, which is exactly what it
       * did before.
       */
      mirror?: true;
      /**
       * The charset this file was read as, when it was not the default.
       *
       * Without it `restore` reopened every tab as UTF-8, and
       * `readEncodedFile` refuses anything it cannot prove is UTF-8 or
       * BOM-marked — so a windows-1252 or Shift JIS file, opened deliberately
       * through the encoding picker, came back as a "Could not open" toast and
       * a missing tab. Its unsaved backup was then orphaned, and released on
       * the next save.
       *
       * Optional, and VERSION is deliberately not bumped for it, for the same
       * reason `mirror` does not bump it: an older Nox ignores the field and
       * opens the file the way it did before.
       */
      encoding?: Encoding;
    }
  | {
      kind: 'untitled';
      name: string;
      /** Version 3 and earlier. Read, never written. */
      content?: string;
      backup?: string;
      languageId: string;
      selection?: SelectionRecord;
    };

interface GroupRecord {
  tabs: TabRecord[];
  activeIndex: number;
}

interface SessionData {
  version: number;
  rootPath: string | null;
  groups: GroupRecord[];
  activeGroupIndex: number;
  recentFiles: string[];
  recentFolders: string[];
  /** Version 1 only. Read by the migration, never written. */
  tabs?: TabRecord[];
  activeIndex?: number;
}

export class SessionService {
  /**
   * Why the last session write failed, or null.
   *
   * The most load-bearing of the three write-failure signals. README.md:80-86
   * headlines "It does not lose your work. Ever.", and that promise rests
   * entirely on this file plus the per-buffer backups: with the write failing
   * there is no prompt at quit to fall back on, because there deliberately
   * isn't one (see `NoxApp.#listenForClose`). Saying nothing here means the
   * user finds out by relaunching into an empty window.
   */
  readonly error = new Signal<string | null>(null);
  /**
   * The session file Nox could not read at boot, and where it kept a copy.
   *
   * Separate from `error` for the reason `ConfigService.damaged` is, and more
   * load-bearing here than anywhere else: this file is the whole of
   * README.md's "It does not lose your work. Ever."
   */
  readonly damaged = new Signal<DamagedFile | null>(null);

  #platform: Platform;
  #workspace: WorkspaceService;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Saves are ignored until boot finishes. Services subscribe to workspace
   * signals in the constructor, and Signal notifies immediately on subscribe —
   * without this latch those empty first values would race the restore and
   * could overwrite a good session with `tabs: []`.
   */
  #ready = false;
  /**
   * Which backup file holds each buffer's unsaved text, and the revision it
   * was written at. The revision is what makes a save cheap: an untouched
   * buffer's backup is left exactly as it is.
   */
  #backups = new Map<string, { name: string; revision: number }>();
  #nextBackup = 1;

  constructor(platform: Platform, workspace: WorkspaceService) {
    this.#platform = platform;
    this.#workspace = workspace;
  }

  /** Allow persistence. Called once boot has settled. */
  markReady(): void {
    this.#ready = true;
  }

  /** Returns true when anything was restored. */
  async restore(): Promise<boolean> {
    const data = await this.#read();
    if (!data) return false;

    this.#workspace.restoreRecents(data.recentFiles ?? [], data.recentFolders ?? []);

    if (data.rootPath) {
      await this.#workspace.openFolder(data.rootPath);
    }

    // Restore each group in turn. `splitEditor` makes the new group active,
    // so opening tabs after it lands them in the right pane.
    const groupActives: (string | null)[] = [];

    for (const [index, group] of (data.groups ?? []).entries()) {
      // `move: false`: `splitEditor` moves the active tab when its group has
      // more than one, so restoring a layout whose first pane held two tabs
      // used to relocate the second of them into the new pane — every launch.
      if (index > 0) this.#workspace.splitEditor({ move: false });

      const tabs = group.tabs ?? [];
      const groupId = this.#workspace.activeGroupId.get();
      const results: (string | null)[] = Array.from({ length: tabs.length }, () => null);

      // A mirror tab's `mirrorInto` is synchronous once its original exists
      // (see `#restoreTab`); every other tab does real I/O
      // (`platform.exists`/`readEncodedFile`/`readConfigFile`). Restoring the
      // group's own active tab first — when it is not itself a mirror — is
      // what gets its content ready before every background tab's round trip
      // even starts, rather than after all of them the way one serial loop
      // used to (A4-007); the rest of the group's tabs then load together.
      // Mirrors wait until every non-mirror tab in the group has settled,
      // since a mirror can only reference a tab restored earlier in this same
      // walk, never a later one — `save()`'s `written` set guarantees that.
      const isMirror = (i: number) => tabs[i]?.kind === 'file' && tabs[i]?.mirror === true;
      const activeIndex =
        tabs.length > 0 ? Math.min(Math.max(group.activeIndex ?? 0, 0), tabs.length - 1) : -1;
      const originals = tabs.map((_, i) => i).filter((i) => !isMirror(i));
      const mirrors = tabs.map((_, i) => i).filter(isMirror);

      if (activeIndex >= 0 && !isMirror(activeIndex)) {
        results[activeIndex] = await this.#restoreTab(tabs[activeIndex]!);
      }
      await Promise.all(
        originals
          .filter((i) => i !== activeIndex)
          .map(async (i) => {
            results[i] = await this.#restoreTab(tabs[i]!);
          }),
      );
      await Promise.all(
        mirrors.map(async (i) => {
          results[i] = await this.#restoreTab(tabs[i]!);
        }),
      );

      // Restoring out of order is what makes the active tab arrive first, but
      // `#insert` (`workspace.ts`) places every new tab right after whichever
      // one is currently active — so without this, the pane's *physical* tab
      // order would end up in whatever order the I/O happened to resolve in,
      // not the order the session recorded. `moveTab` to each tab's final
      // position, left to right, restores it: with earlier positions already
      // correct, each call only ever has to move the one tab still out of
      // place, the standard way of sorting a list via one primitive move.
      const opened = results.filter((id): id is string => id !== null);
      opened.forEach((id, position) => this.#workspace.moveTab(id, position, groupId, groupId));
      groupActives.push(opened[group.activeIndex] ?? opened[0] ?? null);
    }

    // A group whose files all vanished collapses, so re-read the layout
    // rather than assuming indices still line up.
    const groups = this.#workspace.groups.get();
    groups.forEach((group, index) => {
      const wanted = groupActives[index];
      if (wanted && group.tabs.some((tab) => tab.id === wanted)) {
        this.#workspace.setActive(wanted);
      }
    });

    // Re-read rather than reusing `groups`: that snapshot predates the loop
    // above, so its `activeId` is still whichever tab happened to be opened
    // last — which would clobber the tab the session actually named.
    const settled = this.#workspace.groups.get();
    const focus = settled[data.activeGroupIndex] ?? settled[0];
    const focusTarget = focus?.activeId ?? focus?.tabs[0]?.id;
    if (focusTarget) this.#workspace.setActive(focusTarget);

    return this.#workspace.buffers.get().length > 0 || data.rootPath !== null;
  }

  /**
   * Restore one tab: find or fetch its content, and return the buffer id it
   * landed on, or null when there was nothing worth restoring (an empty
   * scratch tab, a deleted file with no unsaved text).
   *
   * Split out of `restore` (A4-007) so the tabs that do real I/O
   * (`platform.exists`, `readEncodedFile`, `readConfigFile`) can run
   * concurrently rather than one at a time: every side effect here
   * (`setSelection`, `#backups`) is scoped to this one tab's own buffer id,
   * so nothing in this function depends on another tab having already run —
   * the one exception, a mirror needing its original, is the caller's job to
   * sequence, by waiting for every non-mirror tab in the group to settle
   * before calling this for a mirror.
   */
  async #restoreTab(tab: TabRecord): Promise<string | null> {
    let id: string | null = null;
    /** The backup this tab's text came from, to keep it on that file. */
    let backup: string | undefined;

    if (tab.kind === 'file') {
      // A second view of a buffer an earlier tab already restored. `open`
      // would focus that one rather than adding a tab here, which is why the
      // marker exists.
      const already = tab.mirror ? this.#workspace.findByPath(tab.path) : undefined;
      if (already) {
        const into = this.#workspace.activeGroupId.get();
        this.#workspace.mirrorInto(into, already.id);
        // Not `setSelection`, which moves the *buffer* and so would drag the
        // other pane here too. This waits for the pane itself.
        if (tab.selection) this.#workspace.setPaneSelection(into, already.id, tab.selection);
        return already.id;
      }

      if (!(await this.#platform.exists(tab.path))) {
        // Deleted since last launch. A clean tab is skipped quietly; one with
        // unsaved work comes back open and marked deleted, as the watcher
        // keeps it while Nox runs. Skipping it too lost the text twice over:
        // the tab vanished without a word, and its backup name was then
        // reissued to another buffer.
        const content = tab.unsaved ? await this.#unsavedText(tab.unsaved) : null;
        if (content === null) return null;
        id = this.#workspace.openDeleted(
          tab.path,
          content,
          tab.encoding ? { encoding: tab.encoding } : {},
        );
        backup = tab.unsaved?.backup;
      } else {
        id = await this.#workspace.open(tab.path, tab.encoding ? { encoding: tab.encoding } : {});
        // Unsaved work goes back on top of the file as it is now, as a real
        // edit — so the tab is dirty and ⌘Z reaches the on-disk content.
        if (id && tab.unsaved) {
          const content = await this.#unsavedText(tab.unsaved);
          // A backup that has gone missing must not silently blank the file.
          if (content !== null) {
            this.#workspace.restoreUnsaved(id, content, tab.unsaved.baseMtime);
            backup = tab.unsaved.backup;
          }
        }
      }
    } else {
      const content = (await this.#readBackup(tab.backup)) ?? tab.content ?? '';
      if (content.length === 0) return null;
      id = this.#workspace.newUntitled({ content, languageId: tab.languageId });
      backup = tab.backup;
    }

    if (!id) return null;
    // After the content, so offsets are clamped against the final document.
    if (tab.selection) this.#workspace.setSelection(id, tab.selection);
    // Registered at the revision the restore left it at, so the first save
    // after boot keeps the buffer on the file it already has and rewrites
    // nothing. Unregistered, every restored buffer was renamed on that save,
    // and with a fresh counter the names collided.
    if (backup) this.#backups.set(id, { name: backup, revision: this.#workspace.revisionOf(id) });
    return id;
  }

  /**
   * The unsaved text for a tab, from wherever this session version put it.
   *
   * Null when a version 4 record names a backup that is gone — restoring an
   * empty string there would replace the user's file with nothing, which is
   * the opposite of what the backup is for.
   */
  async #unsavedText(record: { backup?: string; content?: string }): Promise<string | null> {
    if (record.backup !== undefined) return this.#readBackup(record.backup);
    return record.content ?? null;
  }

  async #readBackup(name: string | undefined): Promise<string | null> {
    if (!name) return null;
    try {
      const contents = await this.#platform.readConfigFile(name);
      // Blank is how a released backup is marked; treat it as absent.
      return contents && contents.length > 0 ? contents : null;
    } catch {
      return null;
    }
  }

  /** Debounced: see `SAVE_DEBOUNCE_MS`. */
  schedule(): void {
    if (!this.#ready) return;
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      void this.save();
    }, this.#debounceMs());
  }

  /**
   * How long this save waits. O(open tabs) and it runs per keystroke, which
   * is the order of the `#sync` fan-out that publishes the very list it reads;
   * `isLarge` is a field decided when the buffer opened, not a size measured
   * here.
   */
  #debounceMs(): number {
    const large = this.#workspace.buffers.get().some((buffer) => buffer.isLarge && buffer.isDirty);
    return large ? LARGE_FILE_SAVE_DEBOUNCE_MS : SAVE_DEBOUNCE_MS;
  }

  async save(): Promise<void> {
    if (!this.#ready) return;
    const layout = this.#workspace.groups.get();
    /** Backups still in use after this save; anything else gets released. */
    const live = new Set<string>();
    /** Each resolves to the reason its write failed, or null. */
    const writes: Promise<string | null>[] = [];

    // Buffers already written into an earlier group. The first appearance is
    // the real tab; the rest are second views of it.
    const written = new Set<string>();

    const groups: GroupRecord[] = layout.map((group) => {
      const tabs: TabRecord[] = [];
      let activeIndex = 0;

      for (const buffer of group.tabs) {
        const mirrored = written.has(buffer.id) ? ({ mirror: true } as const) : {};
        written.add(buffer.id);
        if (buffer.id === group.activeId) activeIndex = tabs.length;
        // Asked of *this pane*: one file in two panes has two cursors, and
        // the buffer only remembers whichever moved last.
        const selection = this.#workspace.selectionOf(buffer.id, group.id) ?? undefined;

        if (buffer.path) {
          // Written only when it is not the default, so an ordinary session
          // stays exactly the shape it was and an older Nox reading this sees
          // nothing new. Restore hands it straight back to `open`.
          const charset =
            buffer.encoding !== 'utf-8' ? ({ encoding: buffer.encoding } as const) : {};

          // Only dirty buffers carry their text; a clean one is already on
          // disk and copying it into the session would just go stale.
          if (!buffer.isDirty) {
            tabs.push({ kind: 'file', path: buffer.path, selection, ...charset, ...mirrored });
            continue;
          }
          const backup = this.#backUp(buffer.id, live, writes);
          tabs.push({
            kind: 'file',
            path: buffer.path,
            selection,
            unsaved: { backup, baseMtime: this.#workspace.knownMtime(buffer.id) },
            ...charset,
            ...mirrored,
          });
        } else {
          // An empty scratch tab is not worth restoring.
          if ((this.#workspace.textOf(buffer.id) ?? '').length === 0) continue;
          tabs.push({
            kind: 'untitled',
            name: buffer.name,
            backup: this.#backUp(buffer.id, live, writes),
            languageId: buffer.languageId,
            selection,
          });
        }
      }
      return { tabs, activeIndex };
    });

    // A buffer that was saved or closed leaves its backup behind. Blanking it
    // is the cleanup: there is no delete on the config API, and a stale
    // megabyte sitting in the config directory is its own small bug.
    for (const [bufferId, record] of [...this.#backups]) {
      if (live.has(record.name)) continue;
      this.#backups.delete(bufferId);
      writes.push(this.#writeConfig(record.name, ''));
    }

    const data: SessionData = {
      version: VERSION,
      rootPath: this.#workspace.rootPath.get(),
      groups,
      activeGroupIndex: Math.max(
        0,
        layout.findIndex((group) => group.isActive),
      ),
      recentFiles: this.#workspace.recentFiles.get(),
      recentFolders: this.#workspace.recentFolders.get(),
    };

    // The backups go first: a session naming a backup that does not exist yet
    // would lose that work if the process died between the two writes.
    const backupProblems = await Promise.all(writes);
    const indexProblem = await this.#writeConfig(SESSION_FILE, JSON.stringify(data));

    // The index write is named first when both failed: without it the layout
    // is gone whatever the backups hold. One reason, not a list — the causes
    // are almost always the same disk or the same permission.
    this.error.set(indexProblem ?? backupProblems.find((problem) => problem !== null) ?? null);
  }

  /**
   * Ensure this buffer's unsaved text is on disk, and return the file holding
   * it. Writes nothing when the buffer has not moved since the last save.
   */
  #backUp(bufferId: string, live: Set<string>, writes: Promise<string | null>[]): string {
    const revision = this.#workspace.revisionOf(bufferId);
    const existing = this.#backups.get(bufferId);

    const name = existing?.name ?? `unsaved-${this.#nextBackup++}.txt`;
    live.add(name);

    // The whole point: typing in one file does not rewrite another's backup,
    // and a save that changes only the layout rewrites no content at all.
    if (existing?.revision === revision) return name;

    this.#backups.set(bufferId, { name, revision });
    writes.push(
      this.#writeConfig(name, this.#workspace.textOf(bufferId) ?? '').then((problem) => {
        // Keep the file name, drop the revision, when the write did not land.
        // The record above is set optimistically, before the write resolves,
        // so leaving it claiming this revision would make the check three
        // lines up skip this buffer on every later save — its unsaved text
        // would never be written again, which is the one thing a backup
        // exists to prevent. -1 matches no revision a buffer can hold.
        if (problem && this.#backups.get(bufferId)?.revision === revision) {
          this.#backups.set(bufferId, { name, revision: -1 });
        }
        return problem;
      }),
    );
    return name;
  }

  /** Resolves to the reason the write failed, or null when it landed. */
  async #writeConfig(name: string, contents: string): Promise<string | null> {
    try {
      await this.#platform.writeConfigFile(name, contents);
      return null;
    } catch (error) {
      // Never thrown: a session that cannot be persisted must not interrupt
      // the editing it is describing. `save()` publishes it on `error`.
      return error instanceof Error ? error.message : String(error);
    }
  }

  async clear(): Promise<void> {
    try {
      await this.#platform.writeConfigFile(SESSION_FILE, '');
    } catch {
      /* ignore */
    }
  }

  /**
   * Read the index, or preserve it and start clean.
   *
   * A file that will not parse — or carries a version this build does not
   * know, which is usually a newer Nox having written it — used to be treated
   * as no file at all. That is what made a downgrade cost you your tabs, and
   * it is what made `#nextBackup` restart at 1 and write over `unsaved-1.txt`,
   * a file holding text the user never saved.
   */
  async #read(): Promise<SessionData | null> {
    let raw: string | null;
    try {
      raw = await this.#platform.readConfigFile(SESSION_FILE);
    } catch {
      // Unreadable is not damaged: there is nothing to copy, and nothing the
      // user could act on. An empty file is how `clear()` releases a session.
      return null;
    }
    if (!raw) return null;

    // Seeded from the names the index uses whether or not it parses (the
    // damaged path below does the same). A tab the restore cannot bring back
    // leaves its name here with a file that may still hold text, and a
    // counter starting at 1 handed that name to the next dirty buffer.
    this.#nextBackup = highestNumbered(raw, /unsaved-(\d+)\.txt/g) + 1;

    try {
      const parsed = JSON.parse(raw) as SessionData;

      // Version 1 had one implicit group. Migrate rather than discard: losing
      // your tabs on upgrade is a bad first impression of a new version.
      if (parsed.version === 1) {
        return {
          ...parsed,
          version: VERSION,
          groups: [{ tabs: parsed.tabs ?? [], activeIndex: parsed.activeIndex ?? 0 }],
          activeGroupIndex: 0,
        };
      }

      // Versions 2 and 3 are subsets of 4: their fields are all still read,
      // and a tab without the newer ones restores exactly as it did before.
      if (parsed.version === 2 || parsed.version === 3) {
        return { ...parsed, version: VERSION };
      }

      if (parsed.version !== VERSION) return await this.#damaged(raw);
      return parsed;
    } catch {
      return await this.#damaged(raw);
    }
  }

  /**
   * Preserve an index that could not be read, and salvage one number from it.
   *
   * The number is the whole point. `#backUp` hands out `unsaved-N.txt` from a
   * counter that is recomputed on load, so a load that fails silently reissues
   * `unsaved-1.txt` and the first dirty buffer overwrites work the user never
   * saved. `JSON.parse` failing does not make the text unreadable — it makes
   * it unstructured — and the names are still in it, in a truncated file just
   * as much as in a valid one.
   *
   * Deliberately not an attempt to recover the *contents* of a damaged index.
   * One number is all it takes to stop the next write landing on a file that
   * still holds the user's text.
   */
  async #damaged(raw: string): Promise<null> {
    this.#nextBackup = highestNumbered(raw, /unsaved-(\d+)\.txt/g) + 1;
    this.damaged.set(await preserveDamaged(this.#platform, SESSION_FILE, raw));
    return null;
  }
}

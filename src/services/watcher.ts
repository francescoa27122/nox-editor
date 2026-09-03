import { basename } from '@core/path';
import { Signal } from '@core/signal';
import type { Platform, Unwatch, WatchEvent } from '@platform/types';
import type { FileTreeService } from './filetree';
import type { NotificationService } from './notifications';
import type { BufferId, WorkspaceService } from './workspace';

/**
 * Reacts to changes made outside Nox.
 *
 * All of the policy lives here, deliberately: the platforms emit raw events
 * and this service decides what to coalesce, what to ignore and what the user
 * needs to be told. That keeps the decisions in one testable place instead of
 * spread across a Rust callback and two platform adapters.
 *
 * The three rules:
 *
 *   1. **Never fight the user.** A clean buffer reloads silently — that is
 *      what "clean" means. A dirty buffer is *never* overwritten; it is marked
 *      and the conflict is resolved at save time.
 *   2. **Never mistake our own writes for someone else's.** Every open buffer
 *      records the mtime Nox last wrote or read, and an event whose mtime
 *      matches is ours.
 *   3. **Never storm.** Events are coalesced over a short window, and the
 *      expensive re-index runs on a much longer one.
 */

/** Long enough to absorb a save-plus-formatter burst, short enough to feel live. */
const COALESCE_MS = 180;
/**
 * The ceiling on how long `COALESCE_MS` may be pushed back.
 *
 * Without one, the sliding window is not a debounce but a hostage: every event
 * cleared and rescheduled the timer, so anything emitting faster than 180 ms
 * apart — codegen, `tsc --watch` writing into `src/`, an rsync — held the
 * flush off for as long as it ran. A measured 6 s / 3588-event stream produced
 * zero flushes, freezing the tree, the index and external-change detection for
 * the whole storm. The sharp edge is the last one: `app.ts`'s save-overwrite
 * dialog is gated on `externalState`, which only a flush sets, so ⌘S mid-storm
 * silently skipped the "changed on disk" prompt.
 *
 * One second, because it is bounded on both sides:
 *
 *   - **Not shorter**, because the ceiling should never fire for the bursty
 *     case, and shortening `COALESCE_MS` instead would be the wrong lever. An
 *     80-file `git checkout` measured 526 events inside a 19 ms span; a second
 *     is two orders of magnitude clear of it, so ordinary work still pays for
 *     exactly one flush.
 *   - **Not longer**, because a flush is what makes ⌘S safe, and a second is
 *     comfortably under the gap between a user noticing a change and reaching
 *     for save.
 *
 * It also sits below `REINDEX_MS`, deliberately: a forced flush refreshes the
 * tree, but the far more expensive project re-walk keeps its own, longer
 * governor rather than inheriting this one.
 */
const MAX_COALESCE_MS = 1000;
/** Re-walking the project for quick-open is far more expensive than a tree refresh. */
const REINDEX_MS = 2000;

export class FileWatcherService {
  /** True while a workspace root is being watched. */
  readonly active = new Signal(false);

  #platform: Platform;
  #workspace: WorkspaceService;
  #files: FileTreeService;
  #notifications: NotificationService;

  #unwatch: Unwatch | null = null;
  #root: string | null = null;

  #pathListeners = new Set<(paths: ReadonlySet<string>) => void>();
  #pendingPaths = new Set<string>();
  #structureChanged = false;
  #coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  #maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  #reindexTimer: ReturnType<typeof setTimeout> | null = null;

  /** Buffers already reported as externally changed, so we warn once each. */
  #warned = new Set<BufferId>();

  constructor(
    platform: Platform,
    workspace: WorkspaceService,
    files: FileTreeService,
    notifications: NotificationService,
  ) {
    this.#platform = platform;
    this.#workspace = workspace;
    this.#files = files;
    this.#notifications = notifications;
  }

  /** Watch `root`, replacing any previous watch. Null stops watching. */
  async start(root: string | null): Promise<void> {
    if (root === this.#root && this.#unwatch) return;
    this.stop();
    if (!root || !this.#platform.capabilities.fileWatching) return;

    this.#root = root;
    try {
      this.#unwatch = await this.#platform.watch(root, (event) => this.#onEvent(event));
      this.active.set(true);
    } catch (error) {
      // A workspace that cannot be watched is degraded, not broken.
      this.#root = null;
      this.#notifications.warn(
        'File watching unavailable',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  stop(): void {
    this.#unwatch?.();
    this.#unwatch = null;
    this.#root = null;
    this.active.set(false);
    this.#clearTimers();
    this.#pendingPaths.clear();
    this.#structureChanged = false;
    this.#warned.clear();
  }

  /** Forget the "already warned" marks for a buffer — used when it is saved. */
  clearWarning(id: BufferId): void {
    this.#warned.delete(id);
  }

  /**
   * Be told which paths changed, after coalescing.
   *
   * Deliberately not "which buffers changed" — a listener may care about a
   * file nothing has open, which is exactly the case `.nox/settings.json` is.
   * Returns an unsubscribe.
   */
  onPathsChanged(listener: (paths: ReadonlySet<string>) => void): () => void {
    this.#pathListeners.add(listener);
    return () => this.#pathListeners.delete(listener);
  }

  /** Run any pending work immediately. Tests use this instead of waiting. */
  async flushNow(): Promise<void> {
    this.#clearTimers();
    await this.#flush();
    await this.#files.buildIndex();
  }

  // --- Internals ---------------------------------------------------------

  #onEvent(event: WatchEvent): void {
    // Creates, removals and renames change the shape of the tree; plain
    // modifications only matter for files that are open.
    if (event.kind !== 'modify') this.#structureChanged = true;
    for (const path of event.paths) this.#pendingPaths.add(path);

    if (this.#coalesceTimer) clearTimeout(this.#coalesceTimer);
    this.#coalesceTimer = setTimeout(() => this.#runFlush(), COALESCE_MS);

    // Started once per batch and deliberately never rescheduled: it is the one
    // timer a steady event stream cannot keep pushing away, which is the whole
    // point of it. A wall-clock deadline would do the same job, but a plain
    // timer is immune to the clock jumping under a suspend or an NTP step.
    this.#maxWaitTimer ??= setTimeout(() => this.#runFlush(), MAX_COALESCE_MS);
  }

  /** Whichever of the two coalescing timers fires first flushes; both stop. */
  #runFlush(): void {
    this.#clearCoalesceTimers();
    void this.#flush();
  }

  async #flush(): Promise<void> {
    const paths = this.#pendingPaths;
    const structureChanged = this.#structureChanged;
    this.#pendingPaths = new Set();
    this.#structureChanged = false;

    if (structureChanged) {
      await this.#files.refresh({ reindex: false });
      this.#scheduleReindex();
    }

    // Before the open-buffer work below, and before its early return: a
    // listener's file need not be open for the change to matter.
    if (paths.size > 0) {
      for (const listener of [...this.#pathListeners]) listener(paths);
    }

    // Match against open buffers. A rename reports both the old and the new
    // path, so checking every pending path covers both sides.
    const open = this.#workspace.fileBuffers();
    if (open.length === 0) return;

    for (const { id, path } of open) {
      if (!paths.has(path)) continue;
      await this.#reconcile(id, path);
    }
  }

  /** Decide what a change to one open file means, and act on it. */
  async #reconcile(id: BufferId, path: string): Promise<void> {
    const exists = await this.#platform.exists(path);

    if (!exists) {
      this.#workspace.markExternalState(id, 'deleted');
      if (this.#warnOnce(id)) {
        this.#notifications.warn(
          `${basename(path)} was deleted on disk`,
          'The tab is still open. Saving will recreate the file.',
        );
      }
      return;
    }

    let mtime = 0;
    try {
      mtime = (await this.#platform.stat(path)).modified;
    } catch {
      return;
    }

    // This is the write we just made ourselves.
    if (mtime === this.#workspace.knownMtime(id)) {
      this.#workspace.markExternalState(id, 'none');
      return;
    }

    const buffer = this.#workspace.buffers.get().find((b) => b.id === id);
    if (!buffer) return;

    if (!buffer.isDirty) {
      // Clean buffer: the file on disk is the truth. Reload without a fuss.
      const reloaded = await this.#workspace.reloadFromDisk(id);
      if (reloaded) {
        this.#warned.delete(id);
        this.#workspace.events.emit('external-change', { id, state: 'modified', reloaded });
        return;
      }
      // Declined: a keystroke landed while the file was being read, so the
      // buffer is dirty now and this is the case below after all.
    }

    // Dirty buffer: the user's unsaved work always wins until they say
    // otherwise. Mark it and resolve the conflict at save time.
    this.#workspace.markExternalState(id, 'modified');
    this.#workspace.events.emit('external-change', { id, state: 'modified', reloaded: false });
    if (this.#warnOnce(id)) {
      this.#notifications.notify('warning', `${basename(path)} changed on disk`, {
        detail: 'Your unsaved changes are kept. Nox will ask before overwriting the file.',
        // The one-obvious-click case toast actions exist for: take the disk's
        // version now instead of meeting a dialog at save time.
        actions: [
          {
            label: 'Reload from Disk',
            run: () => {
              void this.#workspace.reloadFromDisk(id).then(() => this.clearWarning(id));
            },
          },
        ],
      });
    }
  }

  #warnOnce(id: BufferId): boolean {
    if (this.#warned.has(id)) return false;
    this.#warned.add(id);
    return true;
  }

  #scheduleReindex(): void {
    if (this.#reindexTimer) clearTimeout(this.#reindexTimer);
    this.#reindexTimer = setTimeout(() => {
      this.#reindexTimer = null;
      void this.#files.buildIndex();
    }, REINDEX_MS);
  }

  #clearCoalesceTimers(): void {
    if (this.#coalesceTimer) clearTimeout(this.#coalesceTimer);
    if (this.#maxWaitTimer) clearTimeout(this.#maxWaitTimer);
    this.#coalesceTimer = null;
    this.#maxWaitTimer = null;
  }

  #clearTimers(): void {
    this.#clearCoalesceTimers();
    if (this.#reindexTimer) clearTimeout(this.#reindexTimer);
    this.#reindexTimer = null;
  }
}

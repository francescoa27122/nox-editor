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

  #pendingPaths = new Set<string>();
  #structureChanged = false;
  #coalesceTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.#coalesceTimer = setTimeout(() => {
      this.#coalesceTimer = null;
      void this.#flush();
    }, COALESCE_MS);
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
      this.#warned.delete(id);
      this.#workspace.events.emit('external-change', { id, state: 'modified', reloaded });
      return;
    }

    // Dirty buffer: the user's unsaved work always wins until they say
    // otherwise. Mark it and resolve the conflict at save time.
    this.#workspace.markExternalState(id, 'modified');
    this.#workspace.events.emit('external-change', { id, state: 'modified', reloaded: false });
    if (this.#warnOnce(id)) {
      this.#notifications.warn(
        `${basename(path)} changed on disk`,
        'Your unsaved changes are kept. Nox will ask before overwriting the file.',
      );
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

  #clearTimers(): void {
    if (this.#coalesceTimer) clearTimeout(this.#coalesceTimer);
    if (this.#reindexTimer) clearTimeout(this.#reindexTimer);
    this.#coalesceTimer = null;
    this.#reindexTimer = null;
  }
}

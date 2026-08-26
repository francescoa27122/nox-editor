import { basename, join } from '@core/path';
import { Signal } from '@core/signal';
import type { DirEntry, Platform } from '@platform/types';

/**
 * The explorer model and the quick-open file index.
 *
 * Directories load lazily on expand, and the tree is exposed as a *flat*
 * ordered list rather than nested nodes. Flat is what the renderer wants: it
 * makes keyboard navigation a simple index step and leaves the door open for
 * windowing when someone opens a folder with 50,000 entries.
 */

export interface FlatNode {
  path: string;
  name: string;
  isDirectory: boolean;
  depth: number;
  expanded: boolean;
  loading: boolean;
  /** True for a directory known to contain nothing. */
  empty: boolean;
  /**
   * Why an expanded directory could not be read, or `null`.
   *
   * `#load` has recorded this since the tree was written, but nothing ever
   * carried it out of `DirState`, so a permission-denied or since-deleted
   * directory expanded into the same silent nothing as a genuinely empty one
   * — `#load`'s catch stores `entries: []`, which makes `empty` true as well.
   * Read `error` first: it is the more specific answer.
   */
  error: string | null;
}

interface DirState {
  entries: DirEntry[] | null;
  loading: boolean;
  error: string | null;
}

/**
 * Guard rails for the quick-open index so a huge tree cannot hang the app.
 *
 * **`INDEX_MAX_FILES` was 20,000 and is 14,000 as of 2026-08-25, on a
 * measurement rather than a feeling.** The index is not what costs anything to
 * hold — it is what `CommandPalette.fileRows` has to score between a keystroke
 * and the next frame. Measured against a real 13,154-file workspace (deep
 * paths, 71 characters on average, `node_modules` and the rest of
 * `files.excludeFromExplorer` already removed), taking the worst of the four
 * costliest queries at each size, best of nine runs, three times over:
 *
 * ```
 *    8,000   7.3- 8.0 ms   46-50% of a 16 ms frame
 *   10,000   8.8- 9.4      55-58%
 *   12,000   9.7-10.2      60-64%
 *   14,000   9.8-10.4      61-65%
 *   16,000  10.7-11.6      67-73%
 *   18,000  11.8-12.2      74-77%
 *   20,000  12.8-13.6      80-85%   (15.7 observed once, under load)
 * ```
 *
 * 14,000 because the curve is flat between 12,000 and 14,000 — two thousand
 * more files for no more time — and because 80-85% of a frame leaves nothing
 * for a machine slower than the one this was measured on, which is most of
 * them.
 *
 * Note the shape: 2.5x the files costs 1.7x the time, not 2.5x, because the
 * 4,000-survivor break in `fileRows` truncates the scan sooner as the index
 * grows. That is what makes this a *weak* lever — it is also why it is the
 * safe one. **If more headroom is ever wanted, the survivor break is the
 * knob with the better exchange rate**, because on a dense query it is what
 * decides how much of the index gets scanned at all. It costs something
 * different, though: this constant decides which files quick-open can ever
 * find, and that one decides how deep it looks for a particular query.
 */
const INDEX_MAX_FILES = 14_000;
const INDEX_MAX_DEPTH = 12;

export class FileTreeService {
  readonly nodes = new Signal<FlatNode[]>([]);
  readonly fileIndex = new Signal<string[]>([]);
  readonly indexing = new Signal(false);
  /**
   * Why the workspace root itself could not be read, or `null`.
   *
   * The root has no row of its own to hang an error on — it is the tree — so
   * an unreadable root produced an empty node list and the explorer said
   * "This folder is empty." Kept separate from the per-node `error` for that
   * one reason.
   */
  readonly rootError = new Signal<string | null>(null);

  #platform: Platform;
  #root: string | null = null;
  #dirs = new Map<string, DirState>();
  #expanded = new Set<string>();
  #excludes: Set<string> = new Set();

  constructor(platform: Platform) {
    this.#platform = platform;
  }

  /** Names to hide, from `files.excludeFromExplorer`. */
  setExcludes(commaSeparated: string): void {
    const next = new Set(
      commaSeparated
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const changed = next.size !== this.#excludes.size || [...next].some((n) => !this.#excludes.has(n));
    this.#excludes = next;
    if (changed && this.#root) void this.refresh();
  }

  get root(): string | null {
    return this.#root;
  }

  async setRoot(path: string | null): Promise<void> {
    this.#root = path;
    this.#dirs.clear();
    this.#expanded.clear();
    this.fileIndex.set([]);
    if (!path) {
      this.nodes.set([]);
      this.rootError.set(null);
      return;
    }
    this.#expanded.add(path);
    await this.#load(path);
    this.#flatten();
    void this.buildIndex();
  }

  isExpanded(path: string): boolean {
    return this.#expanded.has(path);
  }

  async toggle(path: string): Promise<void> {
    if (this.#expanded.has(path)) {
      this.#expanded.delete(path);
      this.#flatten();
      return;
    }
    this.#expanded.add(path);
    this.#flatten(); // Paint the spinner before awaiting the read.
    await this.#load(path);
    this.#flatten();
  }

  async expand(path: string): Promise<void> {
    if (this.#expanded.has(path)) return;
    await this.toggle(path);
  }

  collapseAll(): void {
    const root = this.#root;
    this.#expanded.clear();
    if (root) this.#expanded.add(root);
    this.#flatten();
  }

  /** Reveal a file by expanding every ancestor directory. */
  async reveal(path: string): Promise<void> {
    if (!this.#root || !path.startsWith(this.#root)) return;
    const relative = path.slice(this.#root.length).split(/[\\/]/).filter(Boolean);
    let current = this.#root;
    // The final segment is the file itself, so stop one short.
    for (const segment of relative.slice(0, -1)) {
      current = join(current, segment);
      this.#expanded.add(current);
      await this.#load(current);
    }
    this.#flatten();
  }

  /**
   * Re-read every directory currently open.
   *
   * `reindex` is separable because the two costs are wildly different: reading
   * the handful of expanded directories is cheap enough to do on every
   * filesystem event, while re-walking the whole tree is not.
   */
  async refresh({ reindex = true }: { reindex?: boolean } = {}): Promise<void> {
    const open = [...this.#expanded];
    this.#dirs.clear();
    await Promise.all(open.map((path) => this.#load(path)));
    this.#flatten();
    if (reindex) void this.buildIndex();
  }

  /** Walk the whole tree once to feed quick-open. Bounded and interruptible. */
  async buildIndex(): Promise<void> {
    const root = this.#root;
    if (!root) return;

    this.indexing.set(true);
    const files: string[] = [];
    const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];

    try {
      while (queue.length > 0 && files.length < INDEX_MAX_FILES) {
        const current = queue.shift()!;
        if (current.depth > INDEX_MAX_DEPTH) continue;

        let entries: DirEntry[];
        try {
          entries = await this.#platform.readDir(current.path);
        } catch {
          continue; // Unreadable directory: skip, do not abort the walk.
        }

        for (const entry of entries) {
          if (this.#excludes.has(entry.name)) continue;
          if (entry.isDirectory) queue.push({ path: entry.path, depth: current.depth + 1 });
          else files.push(entry.path);
        }

        // The root may change mid-walk if the user opens another folder.
        if (this.#root !== root) return;
      }
      this.fileIndex.set(files);
    } finally {
      this.indexing.set(false);
    }
  }

  // --- Internals ---------------------------------------------------------

  async #load(path: string): Promise<void> {
    const existing = this.#dirs.get(path);
    if (existing?.entries && !existing.loading) return;

    this.#dirs.set(path, { entries: existing?.entries ?? null, loading: true, error: null });
    try {
      const entries = await this.#platform.readDir(path);
      this.#dirs.set(path, { entries, loading: false, error: null });
    } catch (error) {
      this.#dirs.set(path, {
        entries: [],
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #flatten(): void {
    const root = this.#root;
    if (!root) {
      this.nodes.set([]);
      this.rootError.set(null);
      return;
    }
    this.rootError.set(this.#dirs.get(root)?.error ?? null);

    const out: FlatNode[] = [];
    const walk = (path: string, depth: number): void => {
      const state = this.#dirs.get(path);
      const entries = (state?.entries ?? []).filter((e) => !this.#excludes.has(e.name));

      for (const entry of entries) {
        const expanded = entry.isDirectory && this.#expanded.has(entry.path);
        const childState = this.#dirs.get(entry.path);
        out.push({
          path: entry.path,
          name: entry.name,
          isDirectory: entry.isDirectory,
          depth,
          expanded,
          loading: expanded && (childState?.loading ?? true),
          empty: expanded && childState?.entries?.length === 0,
          error: expanded ? (childState?.error ?? null) : null,
        });
        if (expanded) walk(entry.path, depth + 1);
      }
    };

    walk(root, 0);
    this.nodes.set(out);
  }
}

/** Display label for the explorer header. */
export function rootLabel(path: string | null): string {
  return path ? basename(path) || path : 'No Folder';
}

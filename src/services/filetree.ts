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
}

interface DirState {
  entries: DirEntry[] | null;
  loading: boolean;
  error: string | null;
}

/** Guard rails for the quick-open index so a huge tree cannot hang the app. */
const INDEX_MAX_FILES = 20_000;
const INDEX_MAX_DEPTH = 12;

export class FileTreeService {
  readonly nodes = new Signal<FlatNode[]>([]);
  readonly fileIndex = new Signal<string[]>([]);
  readonly indexing = new Signal(false);

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
      return;
    }

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

import { basename, contains, dirname, join, normalize, relative } from '@core/path';
import { buildSearchRegex, findMatches, globToRegExp, matchesGlobs } from '@core/search-match';
import {
  PlatformError,
  type DirEntry,
  type FileStat,
  type Platform,
  type PlatformCapabilities,
  type SaveDialogOptions,
  type SearchFileResult,
  type SearchHandle,
  type SearchRequest,
  type SearchSummary,
  type Unwatch,
  type WatchEvent,
  type WatchEventKind,
} from './types';

/**
 * An in-memory filesystem implementing the full Platform contract.
 *
 * Used for two things: the browser dev target (`npm run dev`), and as the
 * test double for every service spec. It is a real implementation, not a
 * stub — if a service works here it works against a disk.
 */
export class MemoryPlatform implements Platform {
  readonly id = 'web' as const;
  readonly capabilities: PlatformCapabilities = {
    nativeDialogs: false,
    windowTitle: true,
    persistentStorage: false,
    fileWatching: true,
    // Nothing to recover from in memory; the UI words its prompt accordingly.
    recoverableDelete: false,
    revealInFileManager: false,
    externalFileDrop: false,
    agentProcesses: false,
    projectSearch: true,
    terminals: false,
  };

  /** path -> contents. Directories are stored with a null value. */
  #nodes = new Map<string, string | null>();
  #mtimes = new Map<string, number>();
  #config = new Map<string, string>();
  #watchers = new Set<{ root: string; onEvent: (event: WatchEvent) => void }>();
  #home: string;
  /**
   * A monotonic stand-in for wall-clock mtime. Every write advances it, which
   * is what lets tests distinguish "Nox wrote this" from "something else did"
   * exactly the way the real platform does.
   */
  #clock: number;

  constructor(options: { home?: string; now?: number } = {}) {
    this.#home = options.home ?? '/home/nox';
    this.#clock = options.now ?? 1;
    this.#nodes.set('/', null);
    this.mkdirp(this.#home);
  }

  // --- Seeding helpers (test + dev only, not part of the Platform API) ---

  mkdirp(path: string): void {
    const p = normalize(path);
    const segments = p.split('/').filter(Boolean);
    let current = '';
    for (const segment of segments) {
      current = `${current}/${segment}`;
      const existing = this.#nodes.get(current);
      if (existing !== undefined && existing !== null) {
        throw new PlatformError(`Not a directory: ${current}`, 'exists', current);
      }
      this.#nodes.set(current, null);
    }
  }

  /** Install a file without emitting a watch event — for fixtures and seeds. */
  seedFile(path: string, contents: string): void {
    const p = normalize(path);
    const parent = dirname(p);
    if (parent) this.mkdirp(parent);
    this.#nodes.set(p, contents);
    this.#mtimes.set(p, this.#clock++);
  }

  /**
   * Simulate a change made outside Nox: writes the file *and* emits the watch
   * event, exactly as a real editor writing to the same disk would.
   */
  externalWrite(path: string, contents: string): void {
    const p = normalize(path);
    const existed = this.#nodes.has(p);
    this.seedFile(p, contents);
    this.#notify(existed ? 'modify' : 'create', [p]);
  }

  /** Simulate an external delete. */
  externalRemove(path: string): void {
    const p = normalize(path);
    if (!this.#nodes.delete(p)) return;
    this.#mtimes.delete(p);
    this.#notify('remove', [p]);
  }

  /** Simulate an external rename. */
  externalRename(from: string, to: string): void {
    const source = normalize(from);
    const target = normalize(to);
    const contents = this.#nodes.get(source);
    if (contents === undefined) return;
    this.#nodes.delete(source);
    this.#mtimes.delete(source);
    this.seedFile(target, contents ?? '');
    this.#notify('rename', [source, target]);
  }

  /** Every path currently known. Sorted, for stable assertions. */
  snapshot(): string[] {
    return [...this.#nodes.keys()].sort();
  }

  /** Number of live watchers — lets tests assert that watches are released. */
  get watcherCount(): number {
    return this.#watchers.size;
  }

  #notify(kind: WatchEventKind, paths: string[]): void {
    for (const watcher of [...this.#watchers]) {
      const relevant = paths.filter((p) => contains(watcher.root, p));
      if (relevant.length > 0) watcher.onEvent({ kind, paths: relevant });
    }
  }

  // --- Platform ----------------------------------------------------------

  async homeDir(): Promise<string | null> {
    return this.#home;
  }

  async readTextFile(path: string): Promise<string> {
    const p = normalize(path);
    const node = this.#nodes.get(p);
    if (node === undefined) throw new PlatformError(`File not found: ${p}`, 'not-found', p);
    if (node === null) throw new PlatformError(`Is a directory: ${p}`, 'io', p);
    return node;
  }

  async writeTextFile(path: string, contents: string): Promise<void> {
    const p = normalize(path);
    const existing = this.#nodes.get(p);
    if (existing === null) throw new PlatformError(`Is a directory: ${p}`, 'io', p);
    const parent = dirname(p);
    if (parent && this.#nodes.get(parent) === undefined) {
      throw new PlatformError(`No such directory: ${parent}`, 'not-found', parent);
    }
    const existed = this.#nodes.has(p);
    this.#nodes.set(p, contents);
    this.#mtimes.set(p, this.#clock++);
    this.#notify(existed ? 'modify' : 'create', [p]);
  }

  async readDir(path: string): Promise<DirEntry[]> {
    const p = normalize(path);
    if (this.#nodes.get(p) === undefined) {
      throw new PlatformError(`Directory not found: ${p}`, 'not-found', p);
    }
    if (this.#nodes.get(p) !== null) {
      throw new PlatformError(`Not a directory: ${p}`, 'io', p);
    }

    const entries: DirEntry[] = [];
    for (const [key, value] of this.#nodes) {
      if (key === p || !contains(p, key)) continue;
      if (dirname(key) !== (p === '/' ? '/' : p)) continue;
      entries.push({ name: basename(key), path: key, isDirectory: value === null });
    }
    return sortEntries(entries);
  }

  async exists(path: string): Promise<boolean> {
    return this.#nodes.has(normalize(path));
  }

  async stat(path: string): Promise<FileStat> {
    const p = normalize(path);
    const node = this.#nodes.get(p);
    if (node === undefined) throw new PlatformError(`Not found: ${p}`, 'not-found', p);
    return {
      size: node === null ? 0 : node.length,
      modified: this.#mtimes.get(p) ?? 0,
      isDirectory: node === null,
    };
  }

  async createDir(path: string): Promise<void> {
    this.mkdirp(path);
    this.#notify('create', [normalize(path)]);
  }

  async createFile(path: string): Promise<void> {
    const p = normalize(path);
    if (this.#nodes.has(p)) throw new PlatformError(`Already exists: ${p}`, 'exists', p);
    const parent = dirname(p);
    if (parent && this.#nodes.get(parent) === undefined) {
      throw new PlatformError(`No such directory: ${parent}`, 'not-found', parent);
    }
    this.#nodes.set(p, '');
    this.#mtimes.set(p, this.#clock++);
    this.#notify('create', [p]);
  }

  async rename(from: string, to: string): Promise<void> {
    const source = normalize(from);
    const target = normalize(to);
    if (source === target) return;

    if (!this.#nodes.has(source)) {
      throw new PlatformError(`Not found: ${source}`, 'not-found', source);
    }
    if (this.#nodes.has(target)) {
      throw new PlatformError(`Already exists: ${target}`, 'exists', target);
    }

    const parent = dirname(target);
    if (parent && this.#nodes.get(parent) === undefined) {
      throw new PlatformError(`No such directory: ${parent}`, 'not-found', parent);
    }

    // Directories carry their whole subtree across.
    const moved: [string, string][] = [];
    for (const key of this.#nodes.keys()) {
      if (key === source) moved.push([key, target]);
      else if (contains(source, key)) moved.push([key, target + key.slice(source.length)]);
    }

    for (const [oldPath, newPath] of moved) {
      const contents = this.#nodes.get(oldPath)!;
      this.#nodes.delete(oldPath);
      this.#mtimes.delete(oldPath);
      this.#nodes.set(newPath, contents);
      this.#mtimes.set(newPath, this.#clock++);
    }

    this.#notify('rename', [source, target]);
  }

  async trash(path: string): Promise<void> {
    const p = normalize(path);
    if (!this.#nodes.has(p)) {
      throw new PlatformError(`Not found: ${p}`, 'not-found', p);
    }

    const removed = [...this.#nodes.keys()].filter((key) => key === p || contains(p, key));
    for (const key of removed) {
      this.#nodes.delete(key);
      this.#mtimes.delete(key);
    }
    this.#notify('remove', removed);
  }

  async copyFile(from: string, to: string): Promise<void> {
    const source = normalize(from);
    const target = normalize(to);
    const contents = this.#nodes.get(source);

    if (contents === undefined) {
      throw new PlatformError(`Not found: ${source}`, 'not-found', source);
    }
    if (contents === null) {
      throw new PlatformError(`Is a directory: ${source}`, 'io', source);
    }
    if (this.#nodes.has(target)) {
      throw new PlatformError(`Already exists: ${target}`, 'exists', target);
    }

    this.#nodes.set(target, contents);
    this.#mtimes.set(target, this.#clock++);
    this.#notify('create', [target]);
  }

  async reveal(path: string): Promise<void> {
    if (!this.#nodes.has(normalize(path))) {
      throw new PlatformError(`Not found: ${path}`, 'not-found', path);
    }
    // No file manager to reveal into; `revealInFileManager` is false so the
    // menu item is never offered.
  }

  /**
   * A real search over the in-memory tree — not a stub. The browser target
   * gets working project search, and every service test exercises the same
   * code path the desktop build uses, just against a different filesystem.
   *
   * Results are delivered in batches on a microtask so callers see the same
   * streaming shape the Rust implementation produces.
   */
  async searchProject(
    root: string,
    request: SearchRequest,
    onBatch: (files: SearchFileResult[]) => void,
  ): Promise<SearchHandle> {
    const started = Date.now();
    let cancelled = false;

    let matcher: RegExp;
    try {
      matcher = buildSearchRegex(request.query, request);
    } catch (error) {
      return {
        cancel: () => {},
        done: Promise.resolve({
          totalMatches: 0,
          totalFiles: 0,
          truncated: false,
          cancelled: false,
          error: error instanceof Error ? error.message : String(error),
          elapsedMs: 0,
        }),
      };
    }

    const includes = request.includes.map(globToRegExp);
    const excludes = request.excludes.map(globToRegExp);
    const normalizedRoot = normalize(root);

    const done = (async (): Promise<SearchSummary> => {
      let totalMatches = 0;
      let totalFiles = 0;
      let truncated = false;
      let batch: SearchFileResult[] = [];

      const paths = [...this.#nodes.entries()]
        .filter(([path, value]) => value !== null && contains(normalizedRoot, path))
        .map(([path]) => path)
        .sort();

      for (const path of paths) {
        if (cancelled) break;

        const relativePath = relative(normalizedRoot, path);
        if (!matchesGlobs(relativePath, includes, excludes)) continue;

        const contents = this.#nodes.get(path);
        if (typeof contents !== 'string') continue;
        if (contents.length > request.maxFileSize) continue;
        // Same binary heuristic the editor uses when opening a file.
        if (contents.slice(0, 8192).includes('\0')) continue;

        const matches = findMatches(contents, matcher);
        if (matches.length === 0) continue;

        totalMatches += matches.length;
        totalFiles += 1;
        batch.push({ path, matches });

        if (batch.length >= 20) {
          onBatch(batch);
          batch = [];
          await Promise.resolve();
        }
        if (totalMatches >= request.maxResults) {
          truncated = true;
          break;
        }
      }

      if (batch.length > 0 && !cancelled) onBatch(batch);

      return {
        totalMatches,
        totalFiles,
        truncated,
        cancelled,
        error: null,
        elapsedMs: Date.now() - started,
      };
    })();

    return {
      cancel: () => {
        cancelled = true;
      },
      done,
    };
  }

  async onExternalFileDrop(): Promise<() => void> {
    // A browser cannot hand us real filesystem paths, and there is no OS to
    // drag from in a test. `externalFileDrop` is false so nothing subscribes.
    return () => {};
  }

  /**
   * There is no window to close under Vitest, but the parameter stays: it is
   * the contract `WebPlatform` overrides with the browser's unload signal.
   */
  async onCloseRequested(_handler: () => Promise<void>): Promise<() => void> {
    return () => {};
  }

  /**
   * There are no processes here to start.
   *
   * Refusing loudly rather than returning a process that does nothing: a
   * silent no-op would let a session sit waiting for a handshake that could
   * never arrive. Callers check `capabilities.agentProcesses` first, and the
   * transport tests supply their own fake process rather than going near this.
   */
  async spawnAgent(): Promise<never> {
    throw new PlatformError(
      'this build cannot start external processes',
      'unsupported',
    );
  }

  async watch(path: string, onEvent: (event: WatchEvent) => void): Promise<Unwatch> {
    const watcher = { root: normalize(path), onEvent };
    this.#watchers.add(watcher);
    return () => {
      this.#watchers.delete(watcher);
    };
  }

  async killAllAgents(): Promise<void> {
    /* No processes in memory; nothing to stop. */
  }

  /**
   * There is no pty here.
   *
   * Refusing loudly for the same reason as `spawnAgent`: a terminal that
   * silently produced nothing would look like a shell that had hung. Callers
   * check `capabilities.terminals` first.
   */
  async openTerminal(): Promise<never> {
    throw new PlatformError('this build has no terminal', 'unsupported');
  }

  async closeAllTerminals(): Promise<void> {
    /* No terminals in memory; nothing to close. */
  }

  async configDir(): Promise<string | null> {
    return null;
  }

  async readConfigFile(name: string): Promise<string | null> {
    return this.#config.get(name) ?? null;
  }

  async writeConfigFile(name: string, contents: string): Promise<void> {
    this.#config.set(name, contents);
  }

  async pickFolder(): Promise<string | null> {
    return null;
  }

  async pickFile(): Promise<string | null> {
    return null;
  }

  async pickSavePath(options: SaveDialogOptions = {}): Promise<string | null> {
    if (!options.defaultName) return null;
    return join(options.defaultPath ?? this.#home, options.defaultName);
  }

  async setWindowTitle(title: string): Promise<void> {
    if (typeof document !== 'undefined') document.title = title;
  }
}

/** Directories first, then case-insensitive name order. Shared by platforms. */
export function sortEntries(entries: DirEntry[]): DirEntry[] {
  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

import { basename, contains, dirname, join, normalize, relative } from '@core/path';
import { buildSearchRegex, findMatches, globToRegExp, matchesGlobs } from '@core/search-match';
import {
  PlatformError,
  type AgentProcess,
  type AgentProcessSpec,
  type DirEntry,
  type FileStat,
  type JsonLinesSpec,
  type LanguageServerProcess,
  type LanguageServerSpec,
  type MenuNode,
  type Platform,
  type PlatformCapabilities,
  type SaveDialogOptions,
  type SearchFileResult,
  type SearchHandle,
  type SearchRequest,
  type SearchSummary,
  type Unwatch,
  type UpdateInfo,
  type UpdateProgress,
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
    localModels: false,
    languageServers: false,
    // No git in a browser tab; tests seed bases with `seedGitBase`.
    gitState: false,
    // A browser tab and a test cannot replace themselves. Tests seed offers with seedUpdate.
    selfUpdate: false,
    // A browser tab's chrome is the browser's. Nothing to hide, nothing to
    // draw in its place.
    customWindowControls: false,
    // …and nothing drawn on top of the title bar, so nothing to reserve for.
    overlayWindowControls: false,
    // No menu bar in a browser tab. The description is still accepted and
    // kept, because that is what makes the menu testable at all.
    applicationMenu: false,
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

  /** root -> its fake repository. */
  #repos = new Map<string, FakeGitRepo>();

  /** Create an empty repository at `root`, for tests. */
  seedGitRepo(root: string, branch = 'main'): void {
    const r = normalize(root);
    if (this.#repos.has(r)) return;
    this.#repos.set(r, {
      branch,
      heads: new Map([[branch, new Map()]]),
      index: new Map(),
      commits: [],
      conflicts: new Set(),
    });
  }

  /**
   * Give the fake git a committed-and-clean version of `path`, for tests:
   * both HEAD and the index hold `contents` — "not mid-staging", the state
   * the gutter's docs call normal. Re-expressed on the repo model; a test
   * that never made a repo gets one implied at the file's parent, which is
   * what the pre-model `seedGitBase` behavior amounted to.
   */
  seedGitBase(path: string, contents: string): void {
    const p = normalize(path);
    if (!this.#repoFor(p)) this.seedGitRepo(dirname(p));
    const [root, repo] = this.#repoEntryFor(p)!;
    const rel = relative(root, p);
    repo.heads.get(repo.branch)!.set(rel, contents);
    repo.index.set(rel, contents);
  }

  /**
   * Leave `path` mid-merge: HEAD and the index keep the pre-merge text, the
   * worktree gets `contents` (in a real conflict, marker soup), and
   * `gitStatus` reports it as a porcelain `u` record instead of an ordinary
   * worktree edit.
   *
   * The model has no merge machinery and does not need any — what a test
   * needs is the one record shape the seeds could not otherwise produce.
   * Without it the fake could emit only `?` and `1` records, so the single
   * state where staging is dangerous was the single state no test could
   * reach.
   */
  seedGitConflict(path: string, contents: string): void {
    const p = normalize(path);
    if (!this.#repoFor(p)) this.seedGitRepo(dirname(p));
    const [root, repo] = this.#repoEntryFor(p)!;
    const rel = relative(root, p);
    // Whatever HEAD already held stays HEAD's; a path conflicted out of
    // nowhere gets `contents` as its base so it is still a tracked file.
    const head = repo.heads.get(repo.branch)!;
    const base = head.get(rel) ?? contents;
    head.set(rel, base);
    // There are no stages 1/2/3 here. Nothing reads the index for a path git
    // calls unmerged, so it holds the base and the `u` record carries the
    // fact that matters.
    repo.index.set(rel, base);
    repo.conflicts.add(rel);
    this.seedFile(p, contents);
  }

  /** Inspection for tests: the current branch, every branch, the log. */
  gitRepoState(
    root: string,
  ): { branch: string; branches: string[]; commits: { hash: string; subject: string }[] } | null {
    const repo = this.#repos.get(normalize(root));
    if (!repo) return null;
    return { branch: repo.branch, branches: [...repo.heads.keys()].sort(), commits: [...repo.commits] };
  }

  /** The deepest repo whose root contains `path`, as [root, repo]. */
  #repoEntryFor(path: string): [string, FakeGitRepo] | null {
    let best: [string, FakeGitRepo] | null = null;
    for (const [root, repo] of this.#repos) {
      if ((path === root || contains(root, path)) && (!best || root.length > best[0].length)) {
        best = [root, repo];
      }
    }
    return best;
  }

  #repoFor(path: string): FakeGitRepo | null {
    return this.#repoEntryFor(path)?.[1] ?? null;
  }

  #requireRepo(root: string): [string, FakeGitRepo] {
    const entry = this.#repoEntryFor(normalize(root));
    if (!entry) {
      throw new PlatformError(
        'fatal: not a git repository (or any of the parent directories): .git',
        'io',
        root,
      );
    }
    return entry;
  }

  /** What `checkForUpdate` will offer. Null until a test seeds one. */
  #update: UpdateInfo | null = null;
  /** Version handed to `installUpdate`, for tests. Null until then. */
  installedUpdate: string | null = null;
  /** Whether `relaunch` was called, for tests. */
  relaunched = false;

  seedUpdate(info: UpdateInfo): void {
    this.#update = info;
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

  /**
   * Answers from whatever a test seeded, null otherwise — a lookup is a
   * legitimate fake, unlike a process spawn. The real build's null means
   * "no repo / untracked / no git", and unseeded means exactly that here.
   */
  async gitFileBase(path: string): Promise<string | null> {
    const p = normalize(path);
    const entry = this.#repoEntryFor(p);
    if (!entry) return null;
    const [root, repo] = entry;
    return repo.index.get(relative(root, p)) ?? null;
  }

  async checkForUpdate(): Promise<UpdateInfo | null> {
    // Absence is the default truth here, not an error — a test simply has
    // no newer Nox unless one was seeded.
    return this.#update;
  }

  async installUpdate(onProgress?: (event: UpdateProgress) => void): Promise<void> {
    const update = this.#update;
    if (!update) {
      throw new PlatformError('no update in hand — check first', 'not-found');
    }
    // The real platform streams; the model replays the smallest honest
    // sequence, so a service that mishandles any phase fails here.
    onProgress?.({ phase: 'started', totalBytes: 3 });
    onProgress?.({ phase: 'progress', chunkBytes: 3 });
    onProgress?.({ phase: 'finished' });
    this.installedUpdate = update.version;
  }

  async relaunch(): Promise<void> {
    this.relaunched = true;
  }

  async gitStatus(root: string): Promise<string> {
    const [repoRoot, repo] = this.#requireRepo(root);
    const head = repo.heads.get(repo.branch)!;

    const paths = new Set<string>([...repo.index.keys(), ...head.keys()]);
    for (const [node, value] of this.#nodes) {
      if (value !== null && contains(repoRoot, node)) paths.add(relative(repoRoot, node));
    }

    const records: string[] = [
      // Mirrors `nox_git_status`'s own synthetic prefix — the panel joins
      // entries on this, not the workspace root, so the fake must carry it
      // too or a workspace-below-repo-root test would only ever pass here.
      `# git.toplevel ${repoRoot}`,
      `# branch.oid ${repo.commits.length === 0 ? '(initial)' : fakeOid(repo.commits.length)}`,
      `# branch.head ${repo.branch}`,
    ];
    const zeros = '0'.repeat(40);
    for (const rel of [...paths].sort()) {
      const worktree = this.#nodes.get(join(repoRoot, rel));
      const inWork = typeof worktree === 'string';
      const inIndex = repo.index.has(rel);
      const inHead = head.has(rel);

      if (repo.conflicts.has(rel)) {
        // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>. UU (both
        // modified) is the conflict a text merge leaves; the record shape,
        // not the XY pair, is what the parser reads.
        records.push(`u UU N... 100644 100644 100644 100644 ${zeros} ${zeros} ${zeros} ${rel}`);
        continue;
      }

      if (!inIndex && !inHead) {
        if (inWork) records.push(`? ${rel}`);
        continue;
      }
      const x = !inHead ? 'A' : !inIndex ? 'D' : head.get(rel) === repo.index.get(rel) ? '.' : 'M';
      const y = !inWork
        ? inIndex
          ? 'D'
          : '.'
        : !inIndex
          ? '.'
          : worktree === repo.index.get(rel)
            ? '.'
            : 'M';
      if (x === '.' && y === '.') continue;
      records.push(`1 ${x}${y} N... 100644 100644 100644 ${zeros} ${zeros} ${rel}`);
    }
    return records.join('\0') + '\0';
  }

  async gitBranches(root: string): Promise<string> {
    const [, repo] = this.#requireRepo(root);
    return [...repo.heads.keys()].sort().join('\n') + '\n';
  }

  async gitStage(root: string, paths: string[]): Promise<void> {
    const [repoRoot, repo] = this.#requireRepo(root);
    for (const path of paths) {
      const p = normalize(path);
      const rel = relative(repoRoot, p);
      const text = this.#nodes.get(p);
      // `git add` on an unmerged path *is* the resolution: it collapses the
      // stages into one index entry, so the conflict has to lift here too or
      // the model would report a file as conflicted forever.
      repo.conflicts.delete(rel);
      if (typeof text === 'string') repo.index.set(rel, text);
      else if (repo.index.has(rel)) repo.index.delete(rel); // staging a deletion
      else {
        throw new PlatformError(`fatal: pathspec '${rel}' did not match any files`, 'io', p);
      }
    }
    this.#notifyGitMeta(repoRoot);
  }

  async gitUnstage(root: string, paths: string[]): Promise<void> {
    const [repoRoot, repo] = this.#requireRepo(root);
    const head = repo.heads.get(repo.branch)!;
    for (const path of paths) {
      const rel = relative(repoRoot, normalize(path));
      if (head.has(rel)) repo.index.set(rel, head.get(rel)!);
      else repo.index.delete(rel);
    }
    this.#notifyGitMeta(repoRoot);
  }

  async gitCommit(root: string, message: string): Promise<string> {
    const [repoRoot, repo] = this.#requireRepo(root);
    if (message.trim().length === 0) {
      throw new PlatformError('Aborting commit due to empty commit message.', 'io');
    }
    const head = repo.heads.get(repo.branch)!;
    const clean =
      head.size === repo.index.size && [...repo.index].every(([k, v]) => head.get(k) === v);
    if (clean) {
      throw new PlatformError('nothing to commit, working tree clean', 'io');
    }
    repo.heads.set(repo.branch, new Map(repo.index));
    const hash = fakeOid(repo.commits.length + 1).slice(0, 7);
    const subject = message.split('\n', 1)[0]!.trim();
    repo.commits.push({ hash, subject });
    this.#notifyGitMeta(repoRoot);
    return `${hash} ${subject}`;
  }

  async gitSwitch(root: string, name: string, create: boolean): Promise<void> {
    const [repoRoot, repo] = this.#requireRepo(root);
    // The same gate `git check-ref-format --branch` provides: only names git
    // itself would bless reach a write. ASCII control chars, space, and
    // git's reserved punctuation are refused with git's wording.
    if (create) {
      if (
        !/^[^\s~^:?*[\\]+$/.test(name) ||
        name.startsWith('-') ||
        name.includes('..') ||
        name.endsWith('/') ||
        name.endsWith('.lock')
      ) {
        throw new PlatformError(`fatal: '${name}' is not a valid branch name`, 'io');
      }
      if (repo.heads.has(name)) {
        throw new PlatformError(`fatal: a branch named '${name}' already exists`, 'io');
      }
      repo.heads.set(name, new Map(repo.heads.get(repo.branch)!));
      repo.branch = name;
      this.#notifyGitMeta(repoRoot);
      return;
    }

    const target = repo.heads.get(name);
    if (!target) throw new PlatformError(`fatal: invalid reference: ${name}`, 'io');
    const current = repo.heads.get(repo.branch)!;

    // git's refusal: a file that differs between the two heads and carries
    // local (worktree or index) changes would be overwritten.
    const clobbered: string[] = [];
    for (const rel of new Set([...current.keys(), ...target.keys()])) {
      if (current.get(rel) === target.get(rel)) continue;
      const worktree = this.#nodes.get(join(repoRoot, rel));
      const dirty =
        repo.index.get(rel) !== current.get(rel) ||
        (typeof worktree === 'string' ? worktree : undefined) !== repo.index.get(rel);
      if (dirty) clobbered.push(rel);
    }
    if (clobbered.length > 0) {
      throw new PlatformError(
        `error: Your local changes to the following files would be overwritten by checkout:\n\t${clobbered.join('\n\t')}\nPlease commit your changes or stash them before you switch branches.\nAborting`,
        'io',
      );
    }

    for (const rel of new Set([...current.keys(), ...target.keys()])) {
      const path = join(repoRoot, rel);
      const text = target.get(rel);
      if (text === undefined) this.externalRemove(path);
      else if (this.#nodes.get(path) !== text) this.externalWrite(path, text);
    }
    repo.index = new Map(target);
    repo.branch = name;
    this.#notifyGitMeta(repoRoot);
  }

  #gitMetaWatchers = new Set<{ root: string; onChange: () => void }>();

  async watchGitMeta(root: string, onChange: () => void): Promise<Unwatch> {
    const watcher = { root: normalize(root), onChange };
    this.#gitMetaWatchers.add(watcher);
    return () => {
      this.#gitMetaWatchers.delete(watcher);
    };
  }

  #notifyGitMeta(root: string): void {
    for (const watcher of [...this.#gitMetaWatchers]) {
      if (watcher.root === root || contains(watcher.root, root) || contains(root, watcher.root)) {
        watcher.onChange();
      }
    }
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
   *
   * The spec is declared, and the return type is the interface's rather than
   * `never`, so a subclass can override this with a process of its own — how
   * `tests/agent-spawn-cwd.test.ts` observes what the app asked to spawn.
   */
  async spawnAgent(_spec: AgentProcessSpec): Promise<AgentProcess> {
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
   * Where a language server comes from, when one can.
   *
   * There is no process in memory, so by default this platform refuses —
   * loudly, for the reason `spawnAgent` gives: a server that silently
   * produced nothing would be indistinguishable from one merely slow to
   * start. A test installs a factory here to hand the app an in-memory
   * server (see `tests/support/fake-lsp-process.ts`), which is what lets the
   * real `LspService`, `EditorPane` and CodeMirror be driven end to end
   * without a process. `capabilities.languageServers` stays `false` even
   * then: that flag says what the build can do for a user, and the browser
   * target still cannot start one.
   */
  languageServerFactory: ((spec: LanguageServerSpec) => LanguageServerProcess) | null = null;

  async startLanguageServer(spec: LanguageServerSpec): Promise<LanguageServerProcess> {
    if (this.languageServerFactory) return this.languageServerFactory(spec);
    throw new PlatformError('this build cannot start language servers', 'unsupported');
  }

  async stopAllLanguageServers(): Promise<void> {
    /* No servers in memory; nothing to stop. */
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

  /**
   * No network in memory. Rejecting is the honest answer: a stream that
   * never emits looks like a slow model rather than a missing one.
   *
   * Parameters are declared, as `spawnAgent`'s are, so a caller holding the
   * concrete `MemoryPlatform` type — as the platform-seam tests do — can
   * still call this with the real argument list under `strict`.
   */
  async streamJsonLines(
    _spec: JsonLinesSpec,
    _onLine: (line: string) => void,
    _onEnd: (error: string | null) => void,
  ): Promise<never> {
    throw new PlatformError('this build cannot reach a local model', 'unsupported');
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

  /**
   * The window controls are inert here, and nothing should be calling them:
   * `capabilities.customWindowControls` is false, so the title bar does not
   * draw the buttons. Inert rather than throwing, because a browser tab
   * having no window to minimise is not a failure to report.
   */
  async minimizeWindow(): Promise<void> {}

  async toggleMaximizeWindow(): Promise<boolean> {
    return false;
  }

  async closeWindow(): Promise<void> {}

  async onMaximizeChange(handler: (maximized: boolean) => void): Promise<() => void> {
    // Called once, like the real one, so a caller that renders from the first
    // value behaves the same on both platforms.
    handler(false);
    return () => {};
  }

  /**
   * The last menu `setApplicationMenu` was given, for tests.
   *
   * Kept rather than dropped even though this platform has no menu bar: the
   * tree is built by a service from the command table, and what it *contains*
   * is the half of the feature that can be checked without a window.
   */
  installedMenu: readonly MenuNode[] | null = null;

  #menuHandlers = new Set<(commandId: string) => void>();

  async setApplicationMenu(menu: readonly MenuNode[]): Promise<void> {
    this.installedMenu = menu;
  }

  async onMenuCommand(handler: (commandId: string) => void): Promise<() => void> {
    this.#menuHandlers.add(handler);
    return () => {
      this.#menuHandlers.delete(handler);
    };
  }

  /** Seam: what the OS would do when a menu item is chosen. Tests only. */
  chooseMenuItem(commandId: string): void {
    for (const handler of [...this.#menuHandlers]) handler(commandId);
  }

  async onFullscreenChange(handler: (fullscreen: boolean) => void): Promise<() => void> {
    // Honest no-op: nothing here can go fullscreen, and there is no OS to hear
    // it from. A test that needs the transition subclasses this and keeps the
    // handler — `onMaximizeChange` is faked the same way in
    // `tests/title-bar-window-controls.test.ts`.
    handler(false);
    return () => {};
  }
}

/**
 * The fake repository — a small honest model, not scripted replies.
 *
 * One per seeded root: what HEAD holds per branch, what the index holds,
 * the commit log, the current branch. The six git methods behave like
 * git's — stage copies working text into the index, commit snapshots the
 * index and refuses when clean or when the message is blank, switch
 * refuses when a dirty file differs from the target — and the refusal
 * texts follow git's shape, which the Rust tests assert against real git
 * so fake and real cannot drift silently. Worktree text always comes from
 * `#nodes`: the same filesystem the app writes to is the one git sees.
 *
 * One deliberate divergence, documented: the clean-index commit refusal
 * always uses git's clean-tree wording ("nothing to commit, working tree
 * clean") even when unstaged changes exist; only the clean case is
 * exercised, and one message keeps the model small.
 *
 * Mutation check (task 10): disabling the `clobbered.length > 0` guard in
 * `gitSwitch` — the refusal itself — turned
 * 'refuses to switch over a dirty conflicting file, and touches nothing'
 * red (`tests/git-platform.test.ts`); restored, suite green.
 */
interface FakeGitRepo {
  branch: string;
  /** branch name -> path (repo-relative) -> text. */
  heads: Map<string, Map<string, string>>;
  index: Map<string, string>;
  commits: { hash: string; subject: string }[];
  /**
   * Repo-relative paths git would call unmerged. Set by `seedGitConflict`
   * and cleared by staging the path; there is no merge to enter or finish
   * here, only the state a merge leaves behind.
   */
  conflicts: Set<string>;
}

/** Directories first, then case-insensitive name order. Shared by platforms. */
export function sortEntries(entries: DirEntry[]): DirEntry[] {
  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

/** A deterministic 40-hex stand-in for an oid, derived from a counter. */
function fakeOid(n: number): string {
  return n.toString(16).padStart(40, '0');
}

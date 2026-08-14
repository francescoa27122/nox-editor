/**
 * The Platform boundary.
 *
 * This interface is the ONLY door between Nox and the operating system.
 * Nothing in `ui/`, `services/` or `core/` may import `@tauri-apps/*`. Two
 * things fall out of that rule, and both are load-bearing:
 *
 *   1. The whole app runs in a plain browser against an in-memory filesystem,
 *      so UI work does not need a Rust rebuild loop.
 *   2. Every service is unit-testable against a fake disk with no mocking
 *      library — you just construct a different Platform.
 *
 * When Tauri's API changes, exactly one file changes: `platform/tauri.ts`.
 */

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface FileStat {
  size: number;
  /** Epoch milliseconds, or 0 when the platform cannot report it. */
  modified: number;
  isDirectory: boolean;
}

export interface PlatformCapabilities {
  /** OS file dialogs. When false, the UI falls back to its own prompt. */
  nativeDialogs: boolean;
  /** Whether the OS window title can be set. */
  windowTitle: boolean;
  /** True when changes actually persist to a real disk. */
  persistentStorage: boolean;
  /** True when `watch()` reports changes made outside Nox. */
  fileWatching: boolean;
  /** True when `trash()` is recoverable rather than a permanent delete. */
  recoverableDelete: boolean;
  /** True when `reveal()` can show an item in the OS file manager. */
  revealInFileManager: boolean;
  /** True when files dragged from the OS deliver real paths. */
  externalFileDrop: boolean;
  /** True when `searchProject` can walk the workspace. */
  projectSearch: boolean;
  /** True when `spawnAgent` can start an external process. */
  agentProcesses: boolean;
}

/** What to start, for `Platform.spawnAgent`. */
export interface AgentProcessSpec {
  command: string;
  args?: string[];
  /** Defaults to the workspace root. */
  cwd?: string;
}

/**
 * A running agent process, as line-delimited streams.
 *
 * Deliberately no knowledge of the agent protocol: this moves lines, and
 * `services/agent/stdio.ts` decides what they mean. That split is what lets
 * the transport be tested against a fake process rather than a real one.
 */
export interface AgentProcess {
  /** Write one message. The newline is added for you. */
  send(line: string): Promise<void>;
  /**
   * Each line the process writes to stdout.
   *
   * **Anything produced before a handler is attached must be buffered and
   * delivered when one is.** A process can write its handshake in the same
   * tick it starts, well before the caller has had a chance to subscribe, and
   * an implementation that drops those lines loses the one message every
   * session begins with.
   */
  onLine(handler: (line: string) => void): void;
  /** Each line it writes to stderr — diagnostics, never protocol. Buffered too. */
  onStderr(handler: (line: string) => void): void;
  /** Called once, when the process ends. Fires immediately if it already has. */
  onExit(handler: (code: number | null) => void): void;
  /** Stop it and release the listeners. Safe to call twice. */
  kill(): Promise<void>;
}

export interface SearchRequest {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  /** Glob patterns; empty means "everything". */
  includes: string[];
  excludes: string[];
  respectGitIgnore: boolean;
  maxResults: number;
  maxFileSize: number;
}

export interface SearchMatch {
  /** 1-based line number in the file. */
  line: number;
  /** 0-based offset of the match within `preview`, in JS string units. */
  column: number;
  length: number;
  /** The line, possibly windowed around the match if it was very long. */
  preview: string;
  /** Units trimmed from the start of the line to produce `preview`. */
  previewOffset: number;
}

export interface SearchFileResult {
  path: string;
  matches: SearchMatch[];
}

export interface SearchSummary {
  totalMatches: number;
  totalFiles: number;
  /** True when the result cap was hit and the walk stopped early. */
  truncated: boolean;
  cancelled: boolean;
  error: string | null;
  elapsedMs: number;
}

export interface SearchHandle {
  cancel(): void;
  /** Resolves once the walk finishes, is cancelled, or fails. */
  done: Promise<SearchSummary>;
}

export type ExternalDropPhase = 'enter' | 'leave' | 'drop';

export interface ExternalDropEvent {
  phase: ExternalDropPhase;
  /** Absolute paths. Empty for `leave`, and for `enter` on some platforms. */
  paths: string[];
}

/**
 * What happened to a path. `rename` may carry two paths (from, to) or one,
 * depending on what the OS reports, so consumers treat it as "re-read".
 */
export type WatchEventKind = 'create' | 'modify' | 'remove' | 'rename';

export interface WatchEvent {
  kind: WatchEventKind;
  paths: string[];
}

/** Stops a watch. Safe to call more than once. */
export type Unwatch = () => void;

export interface SaveDialogOptions {
  defaultPath?: string;
  defaultName?: string;
}

export interface Platform {
  readonly id: 'tauri' | 'web';
  readonly capabilities: PlatformCapabilities;

  /** Path of the user's home directory, or null when unknown. */
  homeDir(): Promise<string | null>;

  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, contents: string): Promise<void>;
  /** Directory children, already sorted: directories first, then by name. */
  readDir(path: string): Promise<DirEntry[]>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat>;
  createDir(path: string): Promise<void>;
  /** Create an empty file. Must fail if something already exists at `path`. */
  createFile(path: string): Promise<void>;

  /**
   * Move a file or directory. Must fail rather than overwrite an existing
   * destination — the explorer cannot show the user what it would clobber.
   * A case-only rename on a case-insensitive filesystem must be allowed.
   */
  rename(from: string, to: string): Promise<void>;

  /**
   * Delete a file or directory. Implementations must prefer a recoverable
   * delete (the OS trash) and advertise that via `recoverableDelete`.
   */
  trash(path: string): Promise<void>;

  /** Copy a single file. Must fail if the destination exists. */
  copyFile(from: string, to: string): Promise<void>;

  /** Show the item in the OS file manager, where one exists. */
  reveal(path: string): Promise<void>;

  /**
   * Observe files dragged into the window from outside the app. Returns a
   * disposer. Platforms without `externalFileDrop` may return a no-op.
   */
  onExternalFileDrop(handler: (event: ExternalDropEvent) => void): Promise<() => void>;

  /**
   * Run `handler` when the user closes the window, before it goes away.
   *
   * The window waits for the returned promise, which is the whole point: the
   * final session write and settings flush have to complete or the last thing
   * the user did is the thing that gets lost. Returns an unsubscribe function.
   */
  onCloseRequested(handler: () => Promise<void>): Promise<() => void>;

  /**
   * Start an external agent process.
   *
   * Throws `PlatformError('unsupported')` where there are no processes to
   * start — the browser target. Check `capabilities.agentProcesses` first.
   *
   * Starting a process is the most powerful thing Nox does on someone's
   * behalf, and it is deliberately not reachable from the agent protocol: an
   * agent cannot spawn another agent. Only the user, through configuration.
   */
  spawnAgent(spec: AgentProcessSpec): Promise<AgentProcess>;

  /**
   * Stop every running agent.
   *
   * Called when the window is going away. Reloading the renderer does not kill
   * the processes it started, so without this a reload leaves them running
   * with nothing left to talk to them.
   */
  killAllAgents(): Promise<void>;

  /**
   * Search every file under `root`, streaming results as they are found.
   * Starting a search supersedes any previous one.
   */
  searchProject(
    root: string,
    request: SearchRequest,
    onBatch: (files: SearchFileResult[]) => void,
  ): Promise<SearchHandle>;

  /**
   * Directory holding the config files, or null where there is no such place
   * — the browser target, which keeps them in `localStorage`.
   */
  configDir(): Promise<string | null>;

  /** Persisted app data (settings, session). Keyed by a bare filename. */
  readConfigFile(name: string): Promise<string | null>;
  writeConfigFile(name: string, contents: string): Promise<void>;

  /**
   * Watch a directory recursively. Events are raw and unbatched — coalescing
   * is the caller's job (see `services/watcher.ts`), so that policy lives in
   * one testable place rather than being split across platforms.
   */
  watch(path: string, onEvent: (event: WatchEvent) => void): Promise<Unwatch>;

  pickFolder(): Promise<string | null>;
  pickFile(): Promise<string | null>;
  pickSavePath(options?: SaveDialogOptions): Promise<string | null>;

  setWindowTitle(title: string): Promise<void>;
}

/** Thrown for every platform failure so services can present one error shape. */
export class PlatformError extends Error {
  constructor(
    message: string,
    readonly code: 'not-found' | 'permission' | 'exists' | 'not-text' | 'unsupported' | 'io' = 'io',
    readonly path?: string,
  ) {
    super(message);
    this.name = 'PlatformError';
  }
}

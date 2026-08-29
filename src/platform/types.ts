import type { Encoding } from '@core/encoding';
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

/** A file's text and the charset it was read as. */
export interface EncodedText {
  text: string;
  encoding: Encoding;
}

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
  /** True when `startPluginWorker` can run a plugin in a worker. */
  pluginWorkers: boolean;
  /** True when `openTerminal` can give a shell a real pty. */
  terminals: boolean;
  /** True when `streamJsonLines` can reach a local model server. */
  localModels: boolean;
  /** True when `startLanguageServer` can start a language server. */
  languageServers: boolean;
  /** True when `gitFileBase` can ask a real git for a file's index version. */
  gitState: boolean;
  /** True when `checkForUpdate` can find a newer build and `installUpdate` can replace this one. */
  selfUpdate: boolean;
  /**
   * True when the window has no OS chrome and the title bar must draw its own
   * minimise / maximise / close.
   *
   * Platform-dependent *within* the desktop build, which is why it is a
   * capability rather than a constant. macOS keeps its traffic lights over an
   * overlay title bar and is false; Windows hides decorations and is true.
   */
  customWindowControls: boolean;
  /**
   * True when the OS draws its own window buttons *on top of* the title bar,
   * so the bar has to keep its leading edge clear for them.
   *
   * The complement of `customWindowControls` rather than its negation: macOS
   * is the only target where the buttons are the OS's and the bar underneath
   * them is ours. Windows hides its decorations and draws its own set (see
   * `TitleBar.svelte`), and a browser tab has neither.
   *
   * A capability rather than a `platform.id === 'tauri' && isMac` test,
   * because that test is structurally unreachable outside the desktop build —
   * `MemoryPlatform.id` is `readonly 'web'` — which left the inset with no
   * coverage at all, and it shipped a permanent 78px gap in fullscreen.
   */
  overlayWindowControls: boolean;
  /**
   * True when `setApplicationMenu` reaches a real menu bar.
   *
   * macOS only today. Windows draws a menu bar *inside* the window frame and
   * Nox turns decorations off there to draw its own title bar, so a menu would
   * land underneath it; and the accelerator reasoning the menu rests on
   * (ARCHITECTURE.md §"The native menu") is WKWebView's, not WebView2's or
   * WebKitGTK's. Both are recorded as debt rather than guessed at.
   */
  applicationMenu: boolean;
}

/** What to start, for `Platform.spawnAgent`. */
/** What to run, for `Platform.startPluginWorker`. */
export interface PluginWorkerSpec {
  /** The plugin's JavaScript, already read from disk. */
  source: string;
  /** Shown in errors. */
  label: string;
}

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

/** What to start, for `Platform.startLanguageServer`. */
export interface LanguageServerSpec {
  command: string;
  args?: string[];
  /** Defaults to the workspace root. */
  cwd?: string;
}

/**
 * A running language server, as complete JSON-RPC messages.
 *
 * Deliberately no knowledge of the protocol: this moves messages, and
 * `services/lsp/` decides what they mean — the same split as `AgentProcess`,
 * for the same reason.
 *
 * The framing is *not* the renderer's business, and cannot be.
 * `Content-Length` counts bytes, and everything on this side of the boundary
 * is a decoded string whose length is in UTF-16 code units; the two disagree
 * on the first non-ASCII character in a hover string or a completion label.
 */
export interface LanguageServerProcess {
  /** Write one message. The framing is added for you. */
  send(message: string): Promise<void>;
  /**
   * Each complete message the server writes.
   *
   * **Anything produced before a handler is attached must be buffered and
   * delivered when one is** — the same rule as `AgentProcess.onLine`, and
   * more load-bearing here: a server can emit `window/logMessage` and its
   * `initialize` response in the tick it starts, and dropping those loses the
   * handshake the whole session is predicated on.
   */
  onMessage(handler: (message: string) => void): void;
  /** Each stderr line — diagnostics about the server, never protocol. Buffered too. */
  onStderr(handler: (line: string) => void): void;
  /** Called once, when the process ends. Fires immediately if it already has. */
  onExit(handler: (code: number | null) => void): void;
  /** Stop it and release the listeners. Safe to call twice. */
  kill(): Promise<void>;
}

/** What to start, for `Platform.openTerminal`. */
export interface TerminalSpec {
  /** Defaults to the user's login shell. */
  shell?: string;
  args?: string[];
  /** Defaults to the workspace root. */
  cwd?: string;
  cols: number;
  rows: number;
}

/**
 * A running terminal, as a stream of bytes in each direction.
 *
 * Deliberately not lines, unlike `AgentProcess`. A shell prompt has no
 * trailing newline, and a keystroke is not a line — the difference is the
 * whole reason terminals do not reuse the agent transport.
 */
export interface TerminalSession {
  /** Send keystrokes. Raw: no newline is added. */
  write(data: string): Promise<void>;
  /** Tell the shell its window changed, so it knows where to wrap. */
  resize(cols: number, rows: number): Promise<void>;
  /** Output, in whatever sized chunks it arrives. Buffered until subscribed. */
  onData(handler: (data: string) => void): void;
  onExit(handler: (code: number | null) => void): void;
  close(): Promise<void>;
}

export interface JsonLinesSpec {
  /**
   * Loopback only. Enforced in Rust, where the request is actually made — a
   * check on this side of the IPC boundary is a suggestion.
   */
  url: string;
  body: unknown;
}

export interface JsonLinesStream {
  /** Stop the request and drop the connection. Safe to call twice. */
  close(): Promise<void>;
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

/**
 * A system menu item the OS supplies and Nox must not reimplement.
 *
 * These are the items whose behaviour is the platform's, not the app's:
 * `about` and `services` open OS panels, `quit`/`hide` are the application
 * lifecycle, and the clipboard six go through the responder chain — which is
 * why they cut and paste in whatever has focus, including a search field,
 * where a command dispatched against the editor would be plainly wrong.
 */
export type PredefinedMenuItemId =
  | 'about'
  | 'services'
  | 'hide'
  | 'hideOthers'
  | 'showAll'
  | 'quit'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'minimize'
  | 'maximize'
  | 'fullscreen';

/**
 * One entry in the application menu.
 *
 * A description rather than a handle: the tree is built in the renderer, where
 * the command table and the keymap live, and sent across as data. The
 * alternative — naming every command again in Rust — would be ~140 titles in
 * two places with nothing to catch them drifting.
 */
export type MenuNode =
  | {
      kind: 'command';
      /** Dispatched through the registry, so enablement and permissions still apply. */
      commandId: string;
      label: string;
      /** Native accelerator, e.g. `Cmd+Shift+P`. Omitted means no chord shown. */
      accelerator?: string;
    }
  | { kind: 'separator' }
  | { kind: 'predefined'; item: PredefinedMenuItemId; label?: string }
  | {
      kind: 'submenu';
      label: string;
      /**
       * A menu the OS attaches its own behaviour to — macOS fills the Window
       * menu with the open windows and puts Help's search field in Help. A
       * submenu without a role is an ordinary one, however it is labelled.
       */
      role?: 'window' | 'help';
      items: readonly MenuNode[];
    };

/** A newer build the release feed offers. */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  /** Release notes from the manifest, when it carries any. */
  notes: string | null;
}

/** Progress of an update download, as the platform reports it. */
export type UpdateProgress =
  | { phase: 'started'; totalBytes: number | null }
  | { phase: 'progress'; chunkBytes: number }
  | { phase: 'finished' };

export interface Platform {
  readonly id: 'tauri' | 'web';
  readonly capabilities: PlatformCapabilities;

  /** Path of the user's home directory, or null when unknown. */
  homeDir(): Promise<string | null>;

  readTextFile(path: string): Promise<string>;
  /**
   * Read a file that may not be UTF-8.
   *
   * Omit `encoding` and only what can be *proved* is accepted — a byte-order
   * mark, or the whole file being valid UTF-8. Anything else rejects with
   * `not-text:`, which is the signal to ask the user which charset it is
   * rather than to guess on their behalf.
   *
   * Returns the charset used, because the caller has to save with the same
   * one or silently convert the file.
   */
  readEncodedFile(path: string, encoding?: Encoding): Promise<EncodedText>;

  /**
   * The version of `path` that git's index holds, or null.
   *
   * Null is the answer to everything that is not content — no repository,
   * an untracked file, git not installed, a binary blob. A missing gutter
   * is the correct degraded state, so none of those may become an error.
   * Check `capabilities.gitState` before expecting real answers.
   */
  gitFileBase(path: string): Promise<string | null>;

  /**
   * Raw `git status --porcelain=v2 --branch -z` output for the repository at
   * `root`. Parsing lives in `core/git-status.ts`, where it is testable
   * without a repo. Rejects with git's own words when git refuses — the one
   * git surface where failure is an error, not a null: a missing gutter is a
   * fine degraded state, but a write surface built on a silent non-answer
   * would act on stale truth. Check `capabilities.gitState` first.
   */
  gitStatus(root: string): Promise<string>;

  /** Raw `git branch --list --format=%(refname:short)` output. */
  gitBranches(root: string): Promise<string>;

  /** `git add --literal-pathspecs -- <paths>`. Absolute paths in; the platform relativizes. */
  gitStage(root: string, paths: string[]): Promise<void>;

  /**
   * `git reset --literal-pathspecs -- <paths>` (never `--hard`, never a ref
   * beyond the implicit `HEAD`). Touches the index only — the working tree
   * is untouchable by construction of the command. Not `git restore
   * --staged`: that fails with "could not resolve HEAD" on a repository
   * with no commits yet, while pathspec-limited `reset` handles it cleanly
   * — see `src-tauri/src/git.rs`'s `nox_git_unstage` and ARCHITECTURE.md.
   */
  gitUnstage(root: string, paths: string[]): Promise<void>;

  /**
   * `git commit --file=-` with the message on stdin (messages contain
   * quotes, dashes, anything — never argv). Resolves to `git log -1
   * --format=%h %s`. Rejects with git's own words: nothing staged, no
   * identity, a failing hook — all verbatim, never overridden.
   */
  gitCommit(root: string, message: string): Promise<string>;

  /**
   * `git switch <name>` / `git switch -c <name>`, the name validated first
   * with `git check-ref-format --branch`. Rejects with git's own words —
   * a switch that would overwrite dirty files is git's refusal to make.
   */
  gitSwitch(root: string, name: string, create: boolean): Promise<void>;

  /**
   * Watch the repository metadata under `root` — `<root>/.git`'s `HEAD` and
   * `index` — calling `onChange` with no detail beyond "repository state
   * moved"; the subscriber refreshes. A fast path, not a load-bearing one:
   * the activation refetch and the palette refresh stay, because watchers
   * miss things (see the watcher service's own docs). Non-recursive on
   * purpose — a `.git` directory's object churn would flood a recursive
   * watch, which is why the workspace watcher hard-denies `.git` entirely.
   */
  watchGitMeta(root: string, onChange: () => void): Promise<Unwatch>;

  writeTextFile(path: string, contents: string): Promise<void>;
  /**
   * Write a file in `encoding`. Rejects with `unmappable:` when the text will
   * not fit the charset, *before* touching the file — a save that cannot be
   * done faithfully must not destroy the original.
   */
  writeEncodedFile(path: string, contents: string, encoding: Encoding): Promise<void>;
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
   * Run a plugin's JavaScript in a worker, as line-delimited messages.
   *
   * The second way to be a plugin, beside `spawnAgent`. It exists because
   * shipping an executable is a high bar for "add a command that runs
   * prettier", and because a worker is already a crash boundary and already
   * off the main thread — the two properties the design gate asks for.
   *
   * Returns an `AgentProcess` deliberately: that interface is documented as
   * having no protocol knowledge, so one host serves both transports rather
   * than branching on which kind of plugin it is talking to.
   *
   * Check `capabilities.pluginWorkers` first.
   */
  startPluginWorker(spec: PluginWorkerSpec): Promise<AgentProcess>;

  /**
   * Stop every running agent.
   *
   * Called when the window is going away. Reloading the renderer does not kill
   * the processes it started, so without this a reload leaves them running
   * with nothing left to talk to them.
   */
  killAllAgents(): Promise<void>;

  /**
   * Start a language server.
   *
   * Throws `PlatformError('unsupported')` where there are no processes to
   * start — the browser target. Check `capabilities.languageServers` first.
   *
   * A language server is started only because the user configured one in
   * `servers.json`; nothing here discovers a server or spawns one on its own.
   */
  startLanguageServer(spec: LanguageServerSpec): Promise<LanguageServerProcess>;

  /**
   * Stop every running language server.
   *
   * Called when the window is going away, for the reason `killAllAgents`
   * gives: reloading the renderer does not kill the processes it started.
   */
  stopAllLanguageServers(): Promise<void>;

  /**
   * Open a terminal running a real shell.
   *
   * Throws `PlatformError('unsupported')` where there is no pty — the browser
   * target. Check `capabilities.terminals` first.
   */
  openTerminal(spec: TerminalSpec): Promise<TerminalSession>;

  /**
   * Close every terminal, for the same reason as `killAllAgents`: a reload
   * would otherwise strand a shell with nothing attached to it.
   */
  closeAllTerminals(): Promise<void>;

  /**
   * POST JSON to a loopback endpoint and stream newline-delimited JSON back.
   *
   * Deliberately not named for a vendor: nothing at this boundary knows what
   * a model is, let alone whose. The path, the request shape and the frame
   * shape all live in `services/agent/ollama.ts`.
   *
   * Rejects where `capabilities.localModels` is false.
   */
  streamJsonLines(
    spec: JsonLinesSpec,
    onLine: (line: string) => void,
    onEnd: (error: string | null) => void,
  ): Promise<JsonLinesStream>;

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

  /**
   * Watch the config directory recursively, **without disturbing `watch`**.
   *
   * A second method rather than a second `watch` call, because on the desktop
   * side `nox_watch` holds one watcher and replaces it on every call — so
   * reusing it here would silently stop watching the workspace, taking
   * external-change detection, tree refresh and the save-overwrite dialog with
   * it. `watchGitMeta` is the precedent: another thing to watch gets its own
   * state, command pair and channel.
   *
   * Recursive, because `themes/` and `plugins/` are subdirectories. Affordable
   * where a project root would not be: this folder is Nox's own, it is small,
   * and nothing in it churns — so it carries no deny list either, which
   * matters for a plugin folder someone named `dist`.
   *
   * Coalescing is the caller's job, as it is for `watch`. Gated on
   * `capabilities.fileWatching`: a platform that cannot watch files cannot
   * watch these either.
   */
  watchConfig(path: string, onEvent: (event: WatchEvent) => void): Promise<Unwatch>;

  /**
   * Ask for a directory. `title` captions the dialog — it is the only thing
   * that says *why* a folder is being asked for, and the caller is the only
   * one that knows. Defaults to opening a workspace, which is what it was
   * used for first.
   */
  pickFolder(title?: string): Promise<string | null>;
  pickFile(): Promise<string | null>;
  pickSavePath(options?: SaveDialogOptions): Promise<string | null>;

  setWindowTitle(title: string): Promise<void>;

  /**
   * The three window controls, for a build that hides its OS chrome.
   *
   * These exist on `Platform` rather than being called directly because
   * `ui/` may not import `@tauri-apps/*` — see the rule at the top of this
   * file. Where `capabilities.customWindowControls` is false nothing calls
   * them, and the implementations are inert rather than throwing: a browser
   * tab has no window to minimise, and that is not an error worth surfacing.
   */
  minimizeWindow(): Promise<void>;

  /** Maximise, or restore when already maximised. Resolves to the new state. */
  toggleMaximizeWindow(): Promise<boolean>;

  /**
   * Close the window the way the OS would — running the close handler, so
   * unsaved work is still persisted. Not `destroy`, which skips it.
   */
  closeWindow(): Promise<void>;

  /**
   * Observe whether the window is maximised, calling `handler` once with the
   * current state and again on every change.
   *
   * Subscription rather than a getter because the user has other ways in:
   * the OS keyboard shortcut, a double-click on the drag region, and on
   * Windows the snap layouts. A button drawn from a value read once goes
   * stale the first time any of those is used.
   */
  onMaximizeChange(handler: (maximized: boolean) => void): Promise<() => void>;

  /**
   * Observe whether the window is fullscreen, calling `handler` once with the
   * current state and again on every change.
   *
   * A subscription for the same reason as `onMaximizeChange`, and one the
   * title bar cannot do without: macOS slides the traffic lights away in
   * fullscreen, so a bar that reserved room for them at construction keeps a
   * dead 78px gap for the whole fullscreen session. There is no way in but the
   * OS's — the green button, ⌃⌘F, the View menu — so nothing in the app would
   * otherwise know it happened.
   */
  onFullscreenChange(handler: (fullscreen: boolean) => void): Promise<() => void>;

  /**
   * Replace the application menu with `menu`.
   *
   * Inert where `capabilities.applicationMenu` is false — a browser tab has no
   * menu bar, and that is not a failure worth surfacing, the same reasoning as
   * the window controls above.
   */
  setApplicationMenu(menu: readonly MenuNode[]): Promise<void>;

  /**
   * Observe menu items being chosen, by the `commandId` they carry.
   *
   * Ids rather than callbacks because the menu crosses the IPC boundary as
   * data; the handler dispatches through the command registry, which is what
   * keeps a menu click identical to a palette entry or a keypress.
   */
  onMenuCommand(handler: (commandId: string) => void): Promise<() => void>;

  /**
   * Ask the release feed whether a newer build exists.
   *
   * Never rejects: null is the answer to everything that is not an
   * installable newer version — no feed published, feed unreachable, this
   * platform absent from it, already current. Absence of an update is a
   * state, not a failure (the `gitFileBase` argument). Check
   * `capabilities.selfUpdate` before expecting real answers.
   */
  checkForUpdate(): Promise<UpdateInfo | null>;

  /**
   * Download, verify and install the update the last successful
   * `checkForUpdate` found. Throws `PlatformError('not-found')` with
   * nothing in hand, and a real error when the download or its signature
   * fails — the user asked for this one, so failure must say why.
   *
   * Installing may exit the process (the Windows installer closes the app
   * to replace its files), so callers flush everything worth keeping first.
   */
  installUpdate(onProgress?: (event: UpdateProgress) => void): Promise<void>;

  /** Restart the app the way the OS would start it. Used after an install. */
  relaunch(): Promise<void>;
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

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { sortEntries } from './memory';
import {
  PlatformError,
  type DirEntry,
  type FileStat,
  type Platform,
  type PlatformCapabilities,
  type AgentProcess,
  type AgentProcessSpec,
  type ExternalDropEvent,
  type JsonLinesSpec,
  type JsonLinesStream,
  type LanguageServerProcess,
  type LanguageServerSpec,
  type SaveDialogOptions,
  type SearchFileResult,
  type SearchHandle,
  type SearchRequest,
  type SearchSummary,
  type TerminalSession,
  type TerminalSpec,
  type Unwatch,
  type WatchEvent,
} from './types';

/**
 * Which OS the shell is running on, for the one capability that differs
 * between desktop targets.
 *
 * Sniffed the same way `services/keymap.ts` decides ⌘ from ⌃, rather than
 * through `@tauri-apps/plugin-os`: this is one boolean read once at startup,
 * and it is not worth a plugin, a permission entry and an async call. It is
 * read here, in the platform layer, because that is where knowledge of the OS
 * is allowed to live.
 */
const PLATFORM_IS_WINDOWS =
  typeof navigator !== 'undefined' && /Win/.test(navigator.platform ?? navigator.userAgent);

/**
 * Desktop target. Every method here is a thin adapter over a Rust command —
 * no logic. If you find yourself writing an `if` in this file, it belongs in a
 * service instead.
 */
export class TauriPlatform implements Platform {
  /** Distinguishes concurrent agent processes on the event bus. */
  static #nextAgent = 0;
  /** The same, for terminals, which share the bus but not the id space. */
  static #nextTerminal = 0;
  /** The same, for JSON-lines streams. */
  static #nextStream = 0;
  /** Distinguishes one load of the window from the next. */
  static #instance = Math.random().toString(36).slice(2, 8);

  readonly id = 'tauri' as const;
  readonly capabilities: PlatformCapabilities = {
    nativeDialogs: true,
    windowTitle: true,
    persistentStorage: true,
    fileWatching: true,
    recoverableDelete: true,
    revealInFileManager: true,
    externalFileDrop: true,
    projectSearch: true,
    agentProcesses: true,
    terminals: true,
    localModels: true,
    // Flipped on once `nox_lsp_start` exists; until then the desktop build
    // genuinely cannot start one, and the flag says what is true today.
    languageServers: false,
    // Windows is the only desktop target that hides its decorations — see
    // `lib.rs`'s setup hook. macOS keeps its traffic lights over an overlay
    // title bar and must not draw a second set beside them.
    customWindowControls: PLATFORM_IS_WINDOWS,
  };

  async homeDir(): Promise<string | null> {
    return call<string | null>('nox_home_dir', {});
  }

  async readTextFile(path: string): Promise<string> {
    return call<string>('nox_read_text_file', { path });
  }

  async writeTextFile(path: string, contents: string): Promise<void> {
    await call<void>('nox_write_text_file', { path, contents });
  }

  async readDir(path: string): Promise<DirEntry[]> {
    const entries = await call<DirEntry[]>('nox_read_dir', { path });
    return sortEntries(entries);
  }

  async exists(path: string): Promise<boolean> {
    return call<boolean>('nox_exists', { path });
  }

  async stat(path: string): Promise<FileStat> {
    return call<FileStat>('nox_stat', { path });
  }

  async createDir(path: string): Promise<void> {
    await call<void>('nox_create_dir', { path });
  }

  async createFile(path: string): Promise<void> {
    await call<void>('nox_create_file', { path });
  }

  async rename(from: string, to: string): Promise<void> {
    await call<void>('nox_rename', { from, to });
  }

  async trash(path: string): Promise<void> {
    await call<void>('nox_trash', { path });
  }

  async copyFile(from: string, to: string): Promise<void> {
    await call<void>('nox_copy_file', { from, to });
  }

  async reveal(path: string): Promise<void> {
    await call<void>('nox_reveal', { path });
  }

  async configDir(): Promise<string | null> {
    return invoke<string>('nox_config_dir');
  }

  async readConfigFile(name: string): Promise<string | null> {
    return call<string | null>('nox_read_config', { name });
  }

  async writeConfigFile(name: string, contents: string): Promise<void> {
    await call<void>('nox_write_config', { name, contents });
  }

  /**
   * The Rust side supports one watcher at a time — Nox only ever watches the
   * open workspace root, and a second call replaces the first. The returned
   * disposer both unsubscribes from the event stream and stops the watcher,
   * so a closed folder costs nothing.
   */
  async watch(path: string, onEvent: (event: WatchEvent) => void): Promise<Unwatch> {
    const unlisten = await listen<WatchEvent>('nox://fs-change', (event) => {
      onEvent(event.payload);
    });

    try {
      await call<void>('nox_watch', { path });
    } catch (error) {
      unlisten();
      throw error;
    }

    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      unlisten();
      void call<void>('nox_unwatch', {}).catch(() => undefined);
    };
  }

  async pickFolder(): Promise<string | null> {
    const picked = await openDialog({ directory: true, multiple: false, title: 'Open Folder' });
    return typeof picked === 'string' ? picked : null;
  }

  async pickFile(): Promise<string | null> {
    const picked = await openDialog({ directory: false, multiple: false, title: 'Open File' });
    return typeof picked === 'string' ? picked : null;
  }

  async pickSavePath(options: SaveDialogOptions = {}): Promise<string | null> {
    const picked = await saveDialog({
      title: 'Save As',
      defaultPath: options.defaultPath ?? options.defaultName,
    });
    return typeof picked === 'string' ? picked : null;
  }

  async setWindowTitle(title: string): Promise<void> {
    await getCurrentWindow().setTitle(title);
  }

  async minimizeWindow(): Promise<void> {
    await getCurrentWindow().minimize();
  }

  async toggleMaximizeWindow(): Promise<boolean> {
    const window = getCurrentWindow();
    await window.toggleMaximize();
    return window.isMaximized();
  }

  /**
   * `close`, never `destroy`.
   *
   * `close` raises the close-requested event that `onCloseRequested` above is
   * listening for, which is what writes the session and flushes settings.
   * `destroy` tears the window down without it, and the unsaved-work
   * guarantee goes with it.
   */
  async closeWindow(): Promise<void> {
    await getCurrentWindow().close();
  }

  async onMaximizeChange(handler: (maximized: boolean) => void): Promise<() => void> {
    const window = getCurrentWindow();
    handler(await window.isMaximized());
    // Resize is the only event that covers every route in: the button here,
    // the OS shortcut, a double-click on the drag region, and Windows' snap
    // layouts. There is no dedicated maximise event to listen for.
    const unlisten = await window.onResized(() => {
      void window.isMaximized().then(handler);
    });
    return unlisten;
  }

  /**
   * OS-level drag and drop. This is the reason the desktop build can accept a
   * dropped file at all: the webview's own HTML5 drop event hands over a
   * sandboxed `File`, never a path, so Nox would have nothing to open.
   *
   * Requires `dragDropEnabled` on the window (see tauri.conf.json).
   */
  async onExternalFileDrop(handler: (event: ExternalDropEvent) => void): Promise<() => void> {
    const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      switch (payload.type) {
        case 'enter':
        case 'over':
          // `over` fires continuously; collapse it into a single 'enter' so
          // the renderer only tracks "something is hovering".
          handler({ phase: 'enter', paths: 'paths' in payload ? payload.paths : [] });
          return;
        case 'drop':
          handler({ phase: 'drop', paths: payload.paths });
          return;
        default:
          handler({ phase: 'leave', paths: [] });
      }
    });

    return () => unlisten();
  }

  async killAllAgents(): Promise<void> {
    await invoke('nox_agent_kill_all');
  }

  /**
   * Not yet. `nox_lsp_start` does not exist in the Rust side at this commit,
   * and a method that invoked a missing command would fail as an opaque IPC
   * error rather than as the capability it actually is.
   */
  async startLanguageServer(_spec: LanguageServerSpec): Promise<LanguageServerProcess> {
    throw new PlatformError('this build cannot start language servers yet', 'unsupported');
  }

  async stopAllLanguageServers(): Promise<void> {
    /* Nothing is started yet, so there is nothing to stop. */
  }

  async onCloseRequested(handler: () => Promise<void>): Promise<() => void> {
    const window = getCurrentWindow();
    const unlisten = await window.onCloseRequested(async (event) => {
      // Hold the close until the handler finishes, then close for real. Tauri
      // does not await the listener on its own, so without preventing first
      // the window is gone before the session write lands.
      event.preventDefault();
      try {
        await handler();
      } finally {
        await window.destroy();
      }
    });

    return () => unlisten();
  }

  async spawnAgent(spec: AgentProcessSpec): Promise<AgentProcess> {
    // The token makes ids unique to *this* load of the window, not just this
    // counter. Reloading resets the counter while the Rust side keeps running
    // whatever it already started, so a bare number collides on the first
    // spawn after a reload.
    const id = `proc-${TauriPlatform.#instance}-${++TauriPlatform.#nextAgent}`;
    const lineHandlers: ((line: string) => void)[] = [];
    const stderrHandlers: ((line: string) => void)[] = [];
    const exitHandlers: ((code: number | null) => void)[] = [];
    // Held until someone subscribes. A child can write its handshake before
    // `spawnAgent` has even returned, and dropping it would lose the one
    // message every session starts with.
    const bufferedLines: string[] = [];
    const bufferedStderr: string[] = [];
    let exitCode: { code: number | null } | null = null;
    let alive = true;

    // Listeners are attached *before* the spawn: a process that writes on its
    // first tick would otherwise have its handshake dropped on the floor.
    const unlisten = await Promise.all([
      listen<{ id: string; line: string }>('nox://agent-line', (event) => {
        if (event.payload.id !== id) return;
        if (lineHandlers.length === 0) bufferedLines.push(event.payload.line);
        else for (const handler of lineHandlers) handler(event.payload.line);
      }),
      listen<{ id: string; line: string }>('nox://agent-stderr', (event) => {
        if (event.payload.id !== id) return;
        if (stderrHandlers.length === 0) bufferedStderr.push(event.payload.line);
        else for (const handler of stderrHandlers) handler(event.payload.line);
      }),
      listen<{ id: string; code: number | null }>('nox://agent-exit', (event) => {
        if (event.payload.id !== id || !alive) return;
        alive = false;
        exitCode = { code: event.payload.code };
        for (const handler of exitHandlers) handler(event.payload.code);
      }),
    ]);

    const release = () => unlisten.forEach((off) => off());

    try {
      await call<void>('nox_agent_spawn', {
        id,
        command: spec.command,
        args: spec.args ?? [],
        cwd: spec.cwd ?? null,
      });
    } catch (error) {
      release();
      throw error;
    }

    return {
      send: (line) => call<void>('nox_agent_send', { id, line }),
      onLine: (handler) => {
        lineHandlers.push(handler);
        for (const line of bufferedLines.splice(0)) handler(line);
      },
      onStderr: (handler) => {
        stderrHandlers.push(handler);
        for (const line of bufferedStderr.splice(0)) handler(line);
      },
      onExit: (handler) => {
        exitHandlers.push(handler);
        if (exitCode) handler(exitCode.code);
      },
      kill: async () => {
        alive = false;
        release();
        await call<void>('nox_agent_kill', { id });
      },
    };
  }

  async openTerminal(spec: TerminalSpec): Promise<TerminalSession> {
    // Same reasoning as `spawnAgent`: the instance token keeps ids unique
    // across a reload, which the Rust side survives.
    const id = `term-${TauriPlatform.#instance}-${++TauriPlatform.#nextTerminal}`;
    const dataHandlers: ((data: string) => void)[] = [];
    const exitHandlers: ((code: number | null) => void)[] = [];
    // A shell writes its prompt immediately — often before `openTerminal` has
    // returned. Dropping that would leave the panel blank until the first
    // keystroke.
    const buffered: string[] = [];
    let exitCode: { code: number | null } | null = null;
    let alive = true;

    const unlisten = await Promise.all([
      listen<{ id: string; data: string }>('nox://pty-data', (event) => {
        if (event.payload.id !== id) return;
        if (dataHandlers.length === 0) buffered.push(event.payload.data);
        else for (const handler of dataHandlers) handler(event.payload.data);
      }),
      listen<{ id: string; code: number | null }>('nox://pty-exit', (event) => {
        if (event.payload.id !== id || !alive) return;
        alive = false;
        exitCode = { code: event.payload.code };
        for (const handler of exitHandlers) handler(event.payload.code);
      }),
    ]);

    const release = () => unlisten.forEach((off) => off());

    try {
      await call<void>('nox_pty_open', {
        id,
        shell: spec.shell ?? null,
        args: spec.args ?? [],
        cwd: spec.cwd ?? null,
        cols: spec.cols,
        rows: spec.rows,
      });
    } catch (error) {
      release();
      throw error;
    }

    return {
      write: (data) => call<void>('nox_pty_write', { id, data }),
      resize: (cols, rows) => call<void>('nox_pty_resize', { id, cols, rows }),
      onData: (handler) => {
        dataHandlers.push(handler);
        for (const data of buffered.splice(0)) handler(data);
      },
      onExit: (handler) => {
        exitHandlers.push(handler);
        if (exitCode) handler(exitCode.code);
      },
      close: async () => {
        alive = false;
        release();
        await call<void>('nox_pty_close', { id });
      },
    };
  }

  async closeAllTerminals(): Promise<void> {
    await invoke('nox_pty_close_all');
  }

  async streamJsonLines(
    spec: JsonLinesSpec,
    onLine: (line: string) => void,
    onEnd: (error: string | null) => void,
  ): Promise<JsonLinesStream> {
    // Same reasoning as `openTerminal`: the instance token keeps ids unique
    // across a reload, which the Rust side survives.
    const id = `http-${TauriPlatform.#instance}-${++TauriPlatform.#nextStream}`;
    let alive = true;

    const unlisten = await Promise.all([
      listen<{ id: string; line: string }>('nox://http-line', (event) => {
        if (event.payload.id !== id || !alive) return;
        onLine(event.payload.line);
      }),
      listen<{ id: string; error: string | null }>('nox://http-end', (event) => {
        if (event.payload.id !== id || !alive) return;
        alive = false;
        release();
        onEnd(event.payload.error);
      }),
    ]);

    const release = () => unlisten.forEach((off) => off());

    try {
      await call<void>('nox_http_stream', { id, url: spec.url, body: spec.body });
    } catch (error) {
      alive = false;
      release();
      throw error;
    }

    return {
      async close() {
        if (!alive) return;
        alive = false;
        release();
        await call<void>('nox_http_cancel', { id });
      },
    };
  }

  /**
   * Project search. Results stream in over the event bus while the Rust walker
   * runs, so a large repo paints its first hits immediately.
   *
   * Batches can arrive before `nox_search_start` has returned the id they
   * belong to, so anything that lands early is buffered and replayed once the
   * id is known — otherwise the first (and fastest) results would be dropped.
   */
  async searchProject(
    root: string,
    request: SearchRequest,
    onBatch: (files: SearchFileResult[]) => void,
  ): Promise<SearchHandle> {
    type Batch = { id: number; files: SearchFileResult[] };
    type Done = SearchSummary & { id: number };

    let id: number | null = null;
    let finished = false;
    const buffered: Batch[] = [];

    let settle: (summary: SearchSummary) => void = () => {};
    const done = new Promise<SearchSummary>((resolve) => {
      settle = resolve;
    });

    const deliver = (batch: Batch) => {
      if (id === null) {
        buffered.push(batch);
        return;
      }
      if (batch.id === id) onBatch(batch.files);
    };

    const unlistenBatch = await listen<Batch>('nox://search-batch', (event) =>
      deliver(event.payload),
    );

    const cleanup = () => {
      unlistenBatch();
      unlistenDone();
    };

    const unlistenDone = await listen<Done>('nox://search-done', (event) => {
      if (id === null || event.payload.id !== id || finished) return;
      finished = true;
      cleanup();
      settle(event.payload);
    });

    try {
      id = await call<number>('nox_search_start', { request: { ...request, root } });
    } catch (error) {
      cleanup();
      return {
        cancel: () => {},
        done: Promise.resolve({
          totalMatches: 0,
          totalFiles: 0,
          truncated: false,
          cancelled: false,
          error: error instanceof PlatformError ? error.message : String(error),
          elapsedMs: 0,
        }),
      };
    }

    // Replay anything that arrived while the id was still in flight.
    for (const batch of buffered.splice(0)) deliver(batch);

    return {
      cancel: () => {
        void call<void>('nox_search_cancel', {}).catch(() => undefined);
      },
      done,
    };
  }
}

/**
 * Rust returns errors as `"<code>: <message>"` so the renderer can branch on
 * cause without parsing prose. Anything unrecognised degrades to 'io'.
 */
async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return (await invoke(command, args)) as T;
  } catch (raw) {
    const text = String(raw);
    const [head, ...rest] = text.split(': ');
    const codes = ['not-found', 'permission', 'exists', 'not-text', 'unsupported', 'io'] as const;
    const code = codes.find((c) => c === head) ?? 'io';
    const message = rest.length > 0 ? rest.join(': ') : text;
    throw new PlatformError(message, code, args.path as string | undefined);
  }
}

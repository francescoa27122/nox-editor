import type { Encoding } from '@core/encoding';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { relaunch as processRelaunch } from '@tauri-apps/plugin-process';
import { check as checkUpdate, type Update } from '@tauri-apps/plugin-updater';
import { sortEntries } from './memory';
import {
  PlatformError,
  type DirEntry,
  type FileStat,
  type Platform,
  type PlatformCapabilities,
  type AgentProcess,
  type AgentProcessSpec,
  type PluginWorkerSpec,
  type ExternalDropEvent,
  type JsonLinesSpec,
  type JsonLinesStream,
  type LanguageServerProcess,
  type LanguageServerSpec,
  type MenuNode,
  type SaveDialogOptions,
  type SearchFileResult,
  type SearchHandle,
  type SearchRequest,
  type SearchSummary,
  type TerminalSession,
  type TerminalSpec,
  type Unwatch,
  type UpdateInfo,
  type UpdateProgress,
  type WatchEvent,
  type EncodedText,
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

/** The same read, for the two capabilities that are macOS's alone. */
const PLATFORM_IS_MAC =
  typeof navigator !== 'undefined' && /Mac/.test(navigator.platform ?? navigator.userAgent);

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
  static #nextServer = 0;
  /** The same, for JSON-lines streams. */
  static #nextStream = 0;
  /** Distinguishes one load of the window from the next. */
  static #instance = Math.random().toString(36).slice(2, 8);
  /** The update the last successful check found, held for `installUpdate`. */
  #pendingUpdate: Update | null = null;

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
    pluginWorkers: true,
    terminals: true,
    localModels: true,
    languageServers: true,
    gitState: true,
    // The desktop build replaces itself through the updater plugin.
    selfUpdate: true,
    // Windows is the only desktop target that hides its decorations — see
    // `lib.rs`'s setup hook. macOS keeps its traffic lights over an overlay
    // title bar and must not draw a second set beside them.
    customWindowControls: PLATFORM_IS_WINDOWS,
    // macOS keeps its traffic lights over the overlay title bar — the one
    // target where the buttons are the OS's and the bar under them is ours.
    overlayWindowControls: PLATFORM_IS_MAC,
    // macOS only; `PlatformCapabilities.applicationMenu` says why.
    applicationMenu: PLATFORM_IS_MAC,
  };

  async homeDir(): Promise<string | null> {
    return call<string | null>('nox_home_dir', {});
  }

  async readTextFile(path: string): Promise<string> {
    return call<string>('nox_read_text_file', { path });
  }

  async gitFileBase(path: string): Promise<string | null> {
    return call<string | null>('nox_git_file_base', { path });
  }

  async gitBlame(path: string, contents: string): Promise<string | null> {
    return call<string | null>('nox_git_blame', { path, contents });
  }

  async gitStatus(root: string): Promise<string> {
    return call<string>('nox_git_status', { root });
  }

  async gitBranches(root: string): Promise<string> {
    return call<string>('nox_git_branches', { root });
  }

  async gitStage(root: string, paths: string[]): Promise<void> {
    await call<void>('nox_git_stage', { root, paths });
  }

  async gitUnstage(root: string, paths: string[]): Promise<void> {
    await call<void>('nox_git_unstage', { root, paths });
  }

  async gitCommit(root: string, message: string): Promise<string> {
    return call<string>('nox_git_commit', { root, message });
  }

  async gitSwitch(root: string, name: string, create: boolean): Promise<void> {
    await call<void>('nox_git_switch', { root, name, create });
  }

  async watchGitMeta(root: string, onChange: () => void): Promise<Unwatch> {
    const unlisten = await listen<null>('nox://git-meta-change', () => onChange());
    try {
      await call<void>('nox_git_meta_watch', { root });
    } catch (error) {
      unlisten();
      throw error;
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      unlisten();
      void call<void>('nox_git_meta_unwatch', {}).catch(() => undefined);
    };
  }

  async writeTextFile(path: string, contents: string): Promise<void> {
    await call<void>('nox_write_text_file', { path, contents });
  }

  async readEncodedFile(path: string, encoding?: Encoding): Promise<EncodedText> {
    return call<EncodedText>('nox_read_encoded_file', { path, encoding: encoding ?? null });
  }

  async writeEncodedFile(path: string, contents: string, encoding: Encoding): Promise<void> {
    await call<void>('nox_write_encoded_file', { path, contents, encoding });
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

  async watchConfig(path: string, onEvent: (event: WatchEvent) => void): Promise<Unwatch> {
    // Its own channel, so a config event and a workspace event cannot be
    // mistaken for one another — the two watches have different subscribers
    // and different consequences.
    const unlisten = await listen<WatchEvent>('nox://config-change', (event) => {
      onEvent(event.payload);
    });

    try {
      await call<void>('nox_config_watch', { path });
    } catch (error) {
      unlisten();
      throw error;
    }

    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      unlisten();
      void call<void>('nox_config_unwatch', {}).catch(() => undefined);
    };
  }

  async pickFolder(title = 'Open Folder'): Promise<string | null> {
    const picked = await openDialog({ directory: true, multiple: false, title });
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

  async onFullscreenChange(handler: (fullscreen: boolean) => void): Promise<() => void> {
    const window = getCurrentWindow();
    handler(await window.isFullscreen());
    // Resize for the same reason `onMaximizeChange` uses it: there is no
    // fullscreen event to listen for, and every route in — the green button,
    // ⌃⌘F, the View menu, a swipe — resizes the window to the display.
    const unlisten = await window.onResized(() => {
      void window.isFullscreen().then(handler);
    });
    return unlisten;
  }

  async setApplicationMenu(menu: readonly MenuNode[]): Promise<void> {
    await call<void>('nox_set_menu', { menu });
  }

  async onMenuCommand(handler: (commandId: string) => void): Promise<() => void> {
    const unlisten = await listen<string>('nox://menu', (event) => handler(event.payload));
    return unlisten;
  }

  async checkForUpdate(): Promise<UpdateInfo | null> {
    try {
      const update = await checkUpdate();
      if (!update) {
        this.#pendingUpdate = null;
        return null;
      }
      this.#pendingUpdate = update;
      return {
        version: update.version,
        currentVersion: update.currentVersion,
        notes: update.body ?? null,
      };
    } catch {
      // No latest.json published, feed unreachable, this platform absent
      // from it (Linux ships no AppImage, so the plugin's TargetNotFound
      // lands here) — all the same answer. Absence is a state, not a
      // failure. See the spec's envelope §4.
      this.#pendingUpdate = null;
      return null;
    }
  }

  async installUpdate(onProgress?: (event: UpdateProgress) => void): Promise<void> {
    const update = this.#pendingUpdate;
    if (!update) {
      throw new PlatformError('no update in hand — check first', 'not-found');
    }
    try {
      await update.downloadAndInstall((event) => {
        if (!onProgress) return;
        if (event.event === 'Started') {
          onProgress({ phase: 'started', totalBytes: event.data.contentLength ?? null });
        } else if (event.event === 'Progress') {
          onProgress({ phase: 'progress', chunkBytes: event.data.chunkLength });
        } else {
          onProgress({ phase: 'finished' });
        }
      });
      this.#pendingUpdate = null;
    } catch (error) {
      // The plugin throws strings as readily as Errors; normalize so the
      // service's failure toast always carries words.
      throw new PlatformError(error instanceof Error ? error.message : String(error), 'io');
    }
  }

  async relaunch(): Promise<void> {
    await processRelaunch();
  }

  async reloadWindow(): Promise<void> {
    globalThis.location.reload();
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

  async startLanguageServer(spec: LanguageServerSpec): Promise<LanguageServerProcess> {
    // Same reasoning as `spawnAgent`: the instance token keeps ids unique
    // across a reload, which the Rust side survives.
    const id = `lsp-${TauriPlatform.#instance}-${++TauriPlatform.#nextServer}`;
    const messageHandlers: ((message: string) => void)[] = [];
    const stderrHandlers: ((line: string) => void)[] = [];
    const exitHandlers: ((code: number | null) => void)[] = [];
    // Held until someone subscribes. A server can emit `window/logMessage` and
    // its `initialize` response in the tick it starts, and dropping those
    // loses the handshake the whole session is predicated on.
    const bufferedMessages: string[] = [];
    const bufferedStderr: string[] = [];
    let exitCode: { code: number | null } | null = null;
    let alive = true;

    // Attached *before* the start, for the same reason as `spawnAgent`.
    const unlisten = await Promise.all([
      listen<{ id: string; message: string }>('nox://lsp-message', (event) => {
        if (event.payload.id !== id) return;
        if (messageHandlers.length === 0) bufferedMessages.push(event.payload.message);
        else for (const handler of messageHandlers) handler(event.payload.message);
      }),
      listen<{ id: string; line: string }>('nox://lsp-stderr', (event) => {
        if (event.payload.id !== id) return;
        if (stderrHandlers.length === 0) bufferedStderr.push(event.payload.line);
        else for (const handler of stderrHandlers) handler(event.payload.line);
      }),
      listen<{ id: string; code: number | null }>('nox://lsp-exit', (event) => {
        if (event.payload.id !== id || !alive) return;
        alive = false;
        exitCode = { code: event.payload.code };
        for (const handler of exitHandlers) handler(event.payload.code);
      }),
    ]);

    const release = () => unlisten.forEach((off) => off());

    try {
      await call<void>('nox_lsp_start', {
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
      send: (message) => call<void>('nox_lsp_send', { id, message }),
      onMessage: (handler) => {
        messageHandlers.push(handler);
        for (const message of bufferedMessages.splice(0)) handler(message);
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
        await call<void>('nox_lsp_stop', { id });
      },
    };
  }

  async stopAllLanguageServers(): Promise<void> {
    await invoke('nox_lsp_stop_all');
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

  /**
   * A plugin in a worker.
   *
   * The source is wrapped in a tiny shim rather than run bare, so a plugin
   * author writes `onRequest`/`send` instead of `postMessage` and a message
   * shape. One line in, one line out, which is exactly what the child-process
   * transport already gives the host — so the host branches on nothing.
   *
   * **This needs `worker-src blob:` in the CSP.** Without it the packaged app
   * refuses to construct the worker at all: the default is `default-src
   * 'self'`, which a blob URL is not. The line was added to
   * `tauri.conf.json` with this method, and it permits same-origin-derived
   * blobs only — never a remote script.
   *
   * Buffering is not optional. A plugin greets in the tick it starts, long
   * before the host has this object back to subscribe to, and
   * `AgentProcess.onLine` requires those lines to survive.
   */
  async startPluginWorker(spec: PluginWorkerSpec): Promise<AgentProcess> {
    const shim = [
      '(function () {',
      '  const handlers = [];',
      '  globalThis.nox = {',
      '    onRequest(handler) { handlers.push(handler); },',
      '    send(message) { postMessage(JSON.stringify(message)); },',
      '  };',
      '  self.onmessage = async (event) => {',
      '    let message;',
      '    try { message = JSON.parse(event.data); } catch { return; }',
      '    for (const handler of handlers) {',
      '      try { await handler(message); } catch (error) {',
      '        globalThis.nox.send({',
      '          id: message.id,',
      '          ok: false,',
      '          error: { code: "internal", message: String(error) },',
      '        });',
      '      }',
      '    }',
      '  };',
      '})();',
      spec.source,
    ].join('\n');

    const url = URL.createObjectURL(new Blob([shim], { type: 'text/javascript' }));
    let worker: Worker;
    try {
      worker = new Worker(url, { type: 'module' });
    } finally {
      // Safe immediately: the worker holds its own reference to the blob once
      // constructed, and leaving it would leak for the life of the window.
      URL.revokeObjectURL(url);
    }

    const buffered: string[] = [];
    let onLine: ((line: string) => void) | null = null;
    let onExit: ((code: number | null) => void) | null = null;
    let exited = false;

    worker.onmessage = (event: MessageEvent<string>) => {
      if (onLine) onLine(event.data);
      else buffered.push(event.data);
    };
    worker.onerror = (event) => {
      // A worker that throws at load never runs, and would otherwise leave the
      // host waiting out the whole handshake deadline on something already
      // dead.
      console.error(`[nox] plugin worker "${spec.label}" failed:`, event.message);
      exited = true;
      onExit?.(1);
    };

    return {
      send: async (line: string) => {
        worker.postMessage(line);
      },
      onLine: (handler) => {
        onLine = handler;
        for (const line of buffered.splice(0)) handler(line);
      },
      onStderr: () => {
        // A worker has no second stream. Its diagnostics reach the devtools
        // console directly, which is where a plugin author is already looking.
      },
      onExit: (handler) => {
        onExit = handler;
        if (exited) handler(1);
      },
      kill: async () => {
        exited = true;
        worker.terminate();
      },
    };
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
      // Lines arrive batched, one event per burst rather than per line, so a
      // chatty agent costs one main-thread hop per burst. Unpacked here, in
      // order, so nothing above the platform sees a batch.
      listen<{ id: string; lines: string[] }>('nox://agent-line', (event) => {
        if (event.payload.id !== id) return;
        for (const line of event.payload.lines) {
          if (lineHandlers.length === 0) bufferedLines.push(line);
          else for (const handler of lineHandlers) handler(line);
        }
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
    return await invoke(command, args);
  } catch (raw) {
    const text = String(raw);
    const [head, ...rest] = text.split(': ');
    const codes = ['not-found', 'permission', 'exists', 'not-text', 'unsupported', 'io'] as const;
    const code = codes.find((c) => c === head) ?? 'io';
    const message = rest.length > 0 ? rest.join(': ') : text;
    throw new PlatformError(message, code, args.path as string | undefined);
  }
}

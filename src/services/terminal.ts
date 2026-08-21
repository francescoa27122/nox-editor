import { Signal } from '@core/signal';
import type { Platform, TerminalSession } from '@platform/types';

/**
 * The terminal session behind the panel.
 *
 * One rule shapes this service: **it does not keep the output.** The visible
 * scrollback belongs to the xterm.js instance in the panel, which already
 * stores it efficiently and renders from it. Mirroring every byte into a
 * signal as well would double the memory of a `cat` of a large file and gain
 * nothing — so data is handed to subscribers as it arrives and then forgotten.
 *
 * That leaves the service owning only what outlives a render: whether a shell
 * is running, what it exited with, and the pty handle itself.
 */

export type TerminalStatus =
  /** Never started, or closed by the user. */
  | 'closed'
  | 'starting'
  | 'running'
  /** The shell exited on its own — `exit`, or a crash. */
  | 'exited';

export class TerminalService {
  readonly status = new Signal<TerminalStatus>('closed');
  /** Exit status of the last shell, for the panel to report. */
  readonly exitCode = new Signal<number | null>(null);
  /** Why the last open failed, if it did. */
  readonly error = new Signal<string | null>(null);
  /**
   * Bumped to ask the panel to restart the shell.
   *
   * The command cannot do it directly: restarting needs the terminal's size
   * in cells, and only the panel has measured it. A command that guessed at
   * 80×24 would leave the new shell wrapping at the wrong column.
   */
  readonly restartRequest = new Signal(0);

  #platform: Platform;
  #workspaceRoot: () => string | null;
  #shell: () => string | null;
  #session: TerminalSession | null = null;
  #dataHandlers = new Set<(data: string) => void>();

  constructor(
    platform: Platform,
    workspaceRoot: () => string | null,
    shell: () => string | null,
  ) {
    this.#platform = platform;
    this.#workspaceRoot = workspaceRoot;
    this.#shell = shell;
  }

  /** False on the browser target, where there is no pty to open. */
  get available(): boolean {
    return this.#platform.capabilities.terminals;
  }

  /**
   * Start a shell. Does nothing if one is already starting or running, so a
   * double-click on the toggle cannot leave a second shell orphaned with no
   * panel attached to it.
   */
  async open(cols: number, rows: number): Promise<void> {
    if (this.status.get() === 'starting' || this.status.get() === 'running') return;
    if (!this.available) {
      this.error.set('this build has no terminal');
      return;
    }

    this.status.set('starting');
    this.error.set(null);
    this.exitCode.set(null);

    const shell = this.#shell();
    try {
      const session = await this.#platform.openTerminal({
        shell: shell && shell.trim().length > 0 ? shell : undefined,
        cwd: this.#workspaceRoot() ?? undefined,
        cols: Math.max(1, Math.floor(cols)),
        rows: Math.max(1, Math.floor(rows)),
      });

      session.onData((data) => {
        for (const handler of this.#dataHandlers) handler(data);
      });
      session.onExit((code) => {
        // Only the session that is still current may report. A close followed
        // by a reopen would otherwise let the old shell's exit knock the new
        // one straight back to 'exited'.
        if (this.#session !== session) return;
        this.#session = null;
        this.exitCode.set(code);
        this.status.set('exited');
      });

      this.#session = session;
      this.status.set('running');
    } catch (cause) {
      this.#session = null;
      this.status.set('closed');
      this.error.set(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /**
   * Send keystrokes. Silently ignored when nothing is running.
   *
   * The catch is not defensive tidiness. Both of these are fire-and-forget
   * calls over IPC that genuinely rejects: for a short window after a shell
   * exits, `#session` is still set while Rust has already dropped the id from
   * its registry, so `nox_pty_write` answers `not-found`. Without a catch that
   * rejection reaches the `unhandledrejection` backstop and the user gets
   * "Something went wrong" for typing into a terminal that had just finished.
   * There is nothing to report: the exit event is a moment behind and says it
   * properly.
   */
  write(data: string): void {
    void this.#session?.write(data).catch(() => undefined);
  }

  /**
   * Tell the shell the panel changed size. Swallows a late rejection for the
   * same reason `write` does — a ResizeObserver tick after the shell exits
   * reaches a `nox_pty_resize` that no longer knows the id.
   */
  resize(cols: number, rows: number): void {
    void this.#session
      ?.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)))
      .catch(() => undefined);
  }

  /** Stop the shell. Safe when nothing is running. */
  async close(): Promise<void> {
    const session = this.#session;
    this.#session = null;
    this.status.set('closed');
    this.exitCode.set(null);
    await session?.close();
  }

  /** Stop whatever is running and start again — the panel's restart button. */
  async restart(cols: number, rows: number): Promise<void> {
    await this.close();
    await this.open(cols, rows);
  }

  /** Ask the panel to restart; see `restartRequest`. */
  requestRestart(): void {
    this.restartRequest.update((n) => n + 1);
  }

  /** Subscribe to output. Returns an unsubscribe. */
  onData(handler: (data: string) => void): () => void {
    this.#dataHandlers.add(handler);
    return () => this.#dataHandlers.delete(handler);
  }
}

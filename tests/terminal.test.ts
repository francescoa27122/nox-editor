import { describe, expect, it } from 'vitest';
import type { Platform, TerminalSession, TerminalSpec } from '../src/platform/types';
import { TerminalService } from '../src/services/terminal';

/**
 * The terminal service against a fake pty.
 *
 * Same reasoning as the agent transport tests: a real shell makes the
 * interesting cases — an exit arriving after a reopen, a pty that refuses to
 * start — almost impossible to provoke on purpose, and leaves processes behind
 * when a test fails.
 */

class FakeSession implements TerminalSession {
  readonly written: string[] = [];
  readonly sizes: [number, number][] = [];
  closed = false;

  #data: ((data: string) => void)[] = [];
  #exits: ((code: number | null) => void)[] = [];

  async write(data: string): Promise<void> {
    this.written.push(data);
  }
  async resize(cols: number, rows: number): Promise<void> {
    this.sizes.push([cols, rows]);
  }
  onData(handler: (data: string) => void): void {
    this.#data.push(handler);
  }
  onExit(handler: (code: number | null) => void): void {
    this.#exits.push(handler);
  }
  async close(): Promise<void> {
    this.closed = true;
  }

  /** Pretend the shell wrote something. */
  emit(data: string): void {
    for (const handler of this.#data) handler(data);
  }
  /** Pretend the shell exited. */
  exit(code: number | null): void {
    for (const handler of this.#exits) handler(code);
  }
}

function harness(options: { terminals?: boolean; fail?: string } = {}) {
  const opened: TerminalSpec[] = [];
  const sessions: FakeSession[] = [];

  const platform = {
    capabilities: { terminals: options.terminals ?? true },
    async openTerminal(spec: TerminalSpec) {
      opened.push(spec);
      if (options.fail) throw new Error(options.fail);
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
  } as unknown as Platform;

  const terminal = new TerminalService(
    platform,
    () => '/workspace',
    () => null,
  );
  return { terminal, opened, sessions };
}

describe('opening', () => {
  it('starts a shell in the workspace root', async () => {
    const { terminal, opened } = harness();

    await terminal.open(80, 24);

    expect(terminal.status.get()).toBe('running');
    expect(opened[0]!).toMatchObject({ cwd: '/workspace', cols: 80, rows: 24 });
  });

  /**
   * The failure this prevents: hitting the toggle twice before the first pty
   * has come back, which used to start a second shell that no panel was
   * attached to — an orphan burning a process until Nox quit.
   */
  it('will not start a second shell while one is running', async () => {
    const { terminal, opened } = harness();

    await Promise.all([terminal.open(80, 24), terminal.open(80, 24)]);
    await terminal.open(80, 24);

    expect(opened).toHaveLength(1);
  });

  it('reports a pty that refuses to start, and stays closed', async () => {
    const { terminal } = harness({ fail: 'no pty available' });

    await terminal.open(80, 24);

    expect(terminal.status.get()).toBe('closed');
    expect(terminal.error.get()).toBe('no pty available');
  });

  it('refuses where the platform has no terminals', async () => {
    const { terminal, opened } = harness({ terminals: false });

    await terminal.open(80, 24);

    expect(terminal.available).toBe(false);
    expect(opened).toHaveLength(0);
    expect(terminal.error.get()).toBe('this build has no terminal');
  });

  /** Columns arrive from a measured DOM element, so they are rarely integers. */
  it('rounds a fractional size to whole cells', async () => {
    const { terminal, opened } = harness();

    await terminal.open(80.7, 23.2);

    expect(opened[0]!).toMatchObject({ cols: 80, rows: 23 });
  });
});

describe('output', () => {
  it('hands data to subscribers without keeping it', async () => {
    const { terminal, sessions } = harness();
    const seen: string[] = [];
    terminal.onData((data) => seen.push(data));

    await terminal.open(80, 24);
    sessions[0]!.emit('$ ');
    sessions[0]!.emit('hello');

    expect(seen).toEqual(['$ ', 'hello']);
  });

  it('stops delivering to an unsubscribed handler', async () => {
    const { terminal, sessions } = harness();
    const seen: string[] = [];
    const off = terminal.onData((data) => seen.push(data));

    await terminal.open(80, 24);
    sessions[0]!.emit('one');
    off();
    sessions[0]!.emit('two');

    expect(seen).toEqual(['one']);
  });
});

describe('lifecycle', () => {
  it('reports the code the shell exited with', async () => {
    const { terminal, sessions } = harness();
    await terminal.open(80, 24);

    sessions[0]!.exit(130);

    expect(terminal.status.get()).toBe('exited');
    expect(terminal.exitCode.get()).toBe(130);
  });

  /**
   * The failure this prevents: closing a terminal and opening a new one, then
   * the *old* shell's exit event arriving late and marking the new, perfectly
   * healthy session as exited.
   */
  it('ignores an exit from a session that has been replaced', async () => {
    const { terminal, sessions } = harness();
    await terminal.open(80, 24);
    const first = sessions[0]!;

    await terminal.close();
    await terminal.open(80, 24);
    first.exit(1);

    expect(terminal.status.get()).toBe('running');
    expect(terminal.exitCode.get()).toBeNull();
  });

  it('closes the underlying session', async () => {
    const { terminal, sessions } = harness();
    await terminal.open(80, 24);

    await terminal.close();

    expect(sessions[0]!.closed).toBe(true);
    expect(terminal.status.get()).toBe('closed');
  });

  it('restarts after the shell exits', async () => {
    const { terminal, sessions } = harness();
    await terminal.open(80, 24);
    sessions[0]!.exit(0);

    await terminal.restart(80, 24);

    expect(terminal.status.get()).toBe('running');
    expect(sessions).toHaveLength(2);
  });

  it('writes and resizes only while something is running', async () => {
    const { terminal, sessions } = harness();
    await terminal.open(80, 24);

    terminal.write('ls\r');
    terminal.resize(100, 30);
    await terminal.close();
    // Neither of these has anywhere to go; they must not throw.
    terminal.write('ignored');
    terminal.resize(10, 10);

    expect(sessions[0]!.written).toEqual(['ls\r']);
    expect(sessions[0]!.sizes).toEqual([[100, 30]]);
  });
});

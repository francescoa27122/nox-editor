import { history } from '@codemirror/commands';
import { describe, expect, it } from 'vitest';
import type { AgentProcess } from '../src/platform/types';
import { MemoryPlatform } from '../src/platform/memory';
import { AgentRuntime, type AgentSession } from '../src/services/agent/runtime';
import { PROTOCOL_VERSION, type Inbound, type Outbound } from '../src/services/agent/protocol';
import { StdioTransport } from '../src/services/agent/stdio';
import { CommandRegistry } from '../src/services/commands';
import { ContextService } from '../src/services/context';
import { FileTreeService } from '../src/services/filetree';
import { JobRunner } from '../src/services/jobs';
import { PermissionService } from '../src/services/permissions';
import { ReviewService } from '../src/services/review';
import { WorkspaceService } from '../src/services/workspace';
import { unhandledRejections } from './support/unhandled-rejections';

/**
 * The transport against a fake process.
 *
 * `StdioTransport` takes an `AgentProcess` rather than a command line, which
 * is what makes this possible: no fixture binary to keep working on three
 * platforms, no process teardown to leak, and failure modes — a silent agent,
 * a crash mid-conversation, garbage on the wire — that are near impossible to
 * provoke on purpose with a real one.
 */
class FakeProcess implements AgentProcess {
  /** Everything Nox has written, parsed. */
  readonly written: Outbound[] = [];
  killed = false;

  #lines: ((line: string) => void)[] = [];
  #exits: ((code: number | null) => void)[] = [];
  #stderr: ((line: string) => void)[] = [];
  // Buffered until someone subscribes, exactly as `AgentProcess` requires —
  // a fake that does not honour the contract tests the wrong thing.
  #bufferedLines: string[] = [];
  #bufferedStderr: string[] = [];
  #exited: { code: number | null } | null = null;
  #onWrite: ((message: Outbound, self: FakeProcess) => void) | null = null;

  constructor(onWrite?: (message: Outbound, self: FakeProcess) => void) {
    this.#onWrite = onWrite ?? null;
  }

  async send(line: string): Promise<void> {
    const message = JSON.parse(line) as Outbound;
    this.written.push(message);
    this.#onWrite?.(message, this);
  }

  onLine(handler: (line: string) => void): void {
    this.#lines.push(handler);
    for (const line of this.#bufferedLines.splice(0)) handler(line);
  }
  onStderr(handler: (line: string) => void): void {
    this.#stderr.push(handler);
    for (const line of this.#bufferedStderr.splice(0)) handler(line);
  }
  onExit(handler: (code: number | null) => void): void {
    this.#exits.push(handler);
    if (this.#exited) handler(this.#exited.code);
  }
  async kill(): Promise<void> {
    this.killed = true;
  }

  /** Pretend the process wrote this to stdout. */
  say(message: Inbound | string): void {
    const line = typeof message === 'string' ? message : JSON.stringify(message);
    if (this.#lines.length === 0) this.#bufferedLines.push(line);
    else for (const handler of this.#lines) handler(line);
  }
  complain(line: string): void {
    if (this.#stderr.length === 0) this.#bufferedStderr.push(line);
    else for (const handler of this.#stderr) handler(line);
  }
  exit(code: number | null = 0): void {
    this.#exited = { code };
    for (const handler of this.#exits) handler(code);
  }
}

const hello = (label = 'Fake agent'): Inbound => ({
  type: 'hello',
  version: PROTOCOL_VERSION,
  label,
});

function transportFor(process: FakeProcess, options = {}) {
  return new StdioTransport(async () => process, 'fake-agent', options);
}

async function harness() {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w');
  platform.seedFile('/w/a.txt', 'one\ntwo\nthree\n');

  const workspace = new WorkspaceService(platform, () => history());
  const files = new FileTreeService(platform);
  const context = new ContextService(workspace, files);
  const commands = new CommandRegistry();
  const permissions = new PermissionService(() => workspace.rootPath.get());
  const review = new ReviewService(workspace);

  await workspace.openFolder('/w');
  const a = (await workspace.open('/w/a.txt'))!;

  return {
    workspace,
    review,
    a,
    runtime: new AgentRuntime({
      workspace,
      context,
      commands,
      permissions,
      review,
      jobs: new JobRunner(),
    }),
  };
}

async function settle(session: AgentSession, budgetMs = 10_000) {
  // A real deadline rather than a loop count — see the note in agent.test.ts.
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (session.status.get() !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`stuck in "${session.status.get()}" after ${budgetMs}ms`);
}

describe('the handshake', () => {
  it('reads the agent label and version', async () => {
    const process = new FakeProcess();
    const transport = transportFor(process);

    const connecting = transport.connect();
    process.say(hello('Rewriter'));

    await expect(connecting).resolves.toEqual({
      version: PROTOCOL_VERSION,
      label: 'Rewriter',
    });
  });

  it('does not lose a line that arrives before anything is waiting', async () => {
    const process = new FakeProcess();
    const transport = transportFor(process);

    const connecting = transport.connect();
    // Two messages in one breath. Without buffering, the request written
    // between the two awaits would simply vanish.
    process.say(hello());
    process.say({ type: 'request', request: { id: 1, method: 'context.openBuffers' } });
    await connecting;

    const seen: number[] = [];
    await transport.run(
      { instruction: 'go', context: '', signal: new AbortController().signal },
      async (request) => {
        seen.push(request.id);
        process.say({ type: 'done' });
        return { id: request.id, ok: true, result: [] };
      },
    );

    expect(seen).toEqual([1]);
  });

  it('gives up on an agent that never speaks', async () => {
    const process = new FakeProcess();
    const transport = transportFor(process, { handshakeTimeoutMs: 20 });

    await expect(transport.connect()).rejects.toThrow(/never introduced itself/);
  });

  it('reports what the agent said on stderr when it dies', async () => {
    const process = new FakeProcess();
    const transport = transportFor(process, { handshakeTimeoutMs: 500 });

    const connecting = transport.connect();
    process.complain('ModuleNotFoundError: no module named nox_agent');
    process.exit(1);

    // A crash during startup is the most common way an agent fails, and its
    // last words on stderr are the only explanation anyone will get.
    await expect(connecting).rejects.toThrow(/ModuleNotFoundError/);
  });

  it('refuses an agent that talks before saying hello', async () => {
    const process = new FakeProcess();
    const transport = transportFor(process);

    const connecting = transport.connect();
    process.say({ type: 'done' });

    await expect(connecting).rejects.toThrow(/before saying hello/);
  });

  it('refuses a line that is not JSON', async () => {
    const process = new FakeProcess();
    const transport = transportFor(process);

    const connecting = transport.connect();
    process.say('Traceback (most recent call last):');

    await expect(connecting).rejects.toThrow(/not JSON/);
  });
});

describe('the conversation', () => {
  it('answers each request and finishes on done', async () => {
    // Replies as soon as Nox writes, so the whole exchange runs without timers.
    const process = new FakeProcess((message, self) => {
      if (message.type === 'run') {
        self.say({
          type: 'request',
          request: { id: 1, method: 'context.bufferText', params: { bufferId: 'buf-1' } },
        });
      }
      if (message.type === 'response') self.say({ type: 'done' });
    });

    const transport = transportFor(process);
    const connecting = transport.connect();
    process.say(hello());
    await connecting;

    await transport.run(
      { instruction: 'read it', context: 'brief', signal: new AbortController().signal },
      async (request) => ({ id: request.id, ok: true, result: 'const a = 1;' }),
    );

    expect(process.written).toEqual([
      { type: 'run', instruction: 'read it', context: 'brief' },
      { type: 'response', response: { id: 1, ok: true, result: 'const a = 1;' } },
    ]);
  });

  it('passes a refusal back to the agent rather than hiding it', async () => {
    const process = new FakeProcess((message, self) => {
      if (message.type === 'run') {
        self.say({
          type: 'request',
          request: { id: 7, method: 'command.execute', params: { commandId: 'file.save' } },
        });
      }
      if (message.type === 'response') self.say({ type: 'done' });
    });

    const transport = transportFor(process);
    const connecting = transport.connect();
    process.say(hello());
    await connecting;

    await transport.run(
      { instruction: 'save', context: '', signal: new AbortController().signal },
      async (request) => ({
        id: request.id,
        ok: false,
        error: { code: 'permission-denied', message: 'not allowed to fs.write' },
      }),
    );

    // An agent that cannot tell "denied" from "no reply" will retry forever.
    expect(process.written.at(-1)).toEqual({
      type: 'response',
      response: {
        id: 7,
        ok: false,
        error: { code: 'permission-denied', message: 'not allowed to fs.write' },
      },
    });
  });

  it('stops cleanly when the process exits without saying done', async () => {
    const process = new FakeProcess((message, self) => {
      if (message.type === 'run') self.exit(0);
    });

    const transport = transportFor(process);
    const connecting = transport.connect();
    process.say(hello());
    await connecting;

    // A crashed agent must not leave the session hanging on a line that will
    // never come.
    await expect(
      transport.run(
        { instruction: 'go', context: '', signal: new AbortController().signal },
        async (request) => ({ id: request.id, ok: true, result: null }),
      ),
    ).resolves.toBeUndefined();
  });

  it('tells the agent to stop when the session is cancelled', async () => {
    const process = new FakeProcess();
    const transport = transportFor(process);
    const connecting = transport.connect();
    process.say(hello());
    await connecting;

    const controller = new AbortController();
    const running = transport.run(
      { instruction: 'go', context: '', signal: controller.signal },
      async (request) => ({ id: request.id, ok: true, result: null }),
    );

    controller.abort();
    process.exit(null);
    await running;

    expect(process.written).toContainEqual({ type: 'cancel' });
  });

  /**
   * The failure this prevents: an agent that is alive and simply not talking
   * parking the session on "Working…" for the life of the app. `connect` has
   * had a deadline since it was written; `run` had none of any kind, so
   * nothing in the transport could ever end this wait.
   *
   * How a healthy agent reaches this state: one byte that is not UTF-8 on its
   * stdout used to end the Rust reader loop, after which no line and no exit
   * event were ever emitted again (`agent.rs`). That cause is fixed, but "the
   * agent stopped writing and did not close stdout" is not a state the
   * renderer can rule out, so it needs an answer of its own.
   */
  it('gives up on an agent that goes quiet mid-run', async () => {
    // Silent but alive: it never replies and never exits.
    const process = new FakeProcess();
    const transport = transportFor(process, { idleTimeoutMs: 20 });
    const connecting = transport.connect();
    process.say(hello());
    await connecting;

    await expect(
      transport.run(
        { instruction: 'go', context: '', signal: new AbortController().signal },
        async (request) => ({ id: request.id, ok: true, result: null }),
      ),
    ).rejects.toThrow(/stopped responding/);
  });

  /**
   * The failure this prevents: `dispose` orphaning the promise a run is
   * waiting on. It cleared `#onLine` and `#onExit`, which are the only two
   * things that could ever settle it, so disposing a stuck session left the
   * job running for ever — the panel could not even be closed out of it.
   */
  it('settles a run in flight when the transport is disposed', async () => {
    const process = new FakeProcess();
    const transport = transportFor(process);
    const connecting = transport.connect();
    process.say(hello());
    await connecting;

    const running = transport.run(
      { instruction: 'go', context: '', signal: new AbortController().signal },
      async (request) => ({ id: request.id, ok: true, result: null }),
    );

    transport.dispose();

    await expect(running).resolves.toBeUndefined();
  });

  /**
   * The failure this prevents: pressing Cancel on an agent that has already
   * crashed showing "Something went wrong". `nox_agent_send` answers
   * `not-found` once the reader thread has removed the id from `AgentState`,
   * which it does *before* emitting the exit (`agent.rs:154-160`) — so that
   * window is exactly when a user reaches for Cancel. `void this.#write(...)`
   * attached no catch, and the rejection reached the `unhandledrejection`
   * backstop at `app.ts:686`.
   */
  it('does not report a cancel the agent is no longer there to receive', async () => {
    const process = new FakeProcess((message) => {
      // The run got through; by the time the cancel goes out the process is
      // gone and Rust has forgotten the id.
      if (message.type === 'cancel') throw new Error('not-found: no agent proc-1-1');
    });
    const transport = transportFor(process);
    const connecting = transport.connect();
    process.say(hello());
    await connecting;

    const controller = new AbortController();
    const running = transport.run(
      { instruction: 'go', context: '', signal: controller.signal },
      async (request) => ({ id: request.id, ok: true, result: null }),
    );

    const rejections = await unhandledRejections(() => {
      controller.abort();
    });

    expect(rejections).toEqual([]);
    await running;
  });

  it('kills the process when disposed', async () => {
    const process = new FakeProcess();
    const transport = transportFor(process);
    const connecting = transport.connect();
    process.say(hello());
    await connecting;

    transport.dispose();
    expect(process.killed).toBe(true);
  });
});

describe('an out-of-process agent, end to end', () => {
  it('reads a file over the wire and proposes an edit from it', async () => {
    const { runtime, review, workspace, a } = await harness();

    // A script that reads, then decides — the thing the protocol exists for,
    // driven entirely through JSON lines.
    const process = new FakeProcess((message, self) => {
      if (message.type === 'run') {
        self.say({
          type: 'request',
          request: { id: 1, method: 'context.bufferText', params: { bufferId: a, lines: { from: 1, to: 1 } } },
        });
        return;
      }
      if (message.type !== 'response') return;

      if (message.response.id === 1) {
        const firstLine = (message.response as { result: string }).result;
        self.say({
          type: 'request',
          request: {
            id: 2,
            method: 'proposal.stage',
            params: {
              description: `Uppercase "${firstLine}"`,
              edits: [
                { bufferId: a, changes: { from: 0, to: firstLine.length, insert: firstLine.toUpperCase() } },
              ],
            },
          },
        });
        return;
      }
      self.say({ type: 'done' });
    });

    const session = runtime.start(transportFor(process), 'Uppercase the first line');
    process.say(hello('Rewriter'));
    await settle(session);

    expect(session.status.get()).toBe('awaiting-review');
    expect(review.staged.get()?.description).toBe('Uppercase "one"');

    expect(review.apply().ok).toBe(true);
    expect(workspace.textOf(a)).toBe('ONE\ntwo\nthree\n');
  });

  it('fails the session when the agent speaks a different protocol', async () => {
    const { runtime } = await harness();
    const process = new FakeProcess();

    const session = runtime.start(transportFor(process), 'Hello');
    process.say({ type: 'hello', version: PROTOCOL_VERSION + 1, label: 'Future agent' });
    await settle(session);

    expect(session.status.get()).toBe('failed');
  });
});

describe('a real child process', () => {
  /**
   * Adapts a Node child process to `AgentProcess`.
   *
   * This is what `src-tauri/src/agent.rs` does, in about the same number of
   * lines. Standing it up here means the wire format, the reference agent and
   * `StdioTransport` are all exercised against genuine pipes — everything
   * except the Rust plumbing itself, which cannot run without a window.
   */
  async function spawnNode(script: string, ...args: string[]): Promise<AgentProcess> {
    const { spawn } = await import('node:child_process');
    const { createInterface } = await import('node:readline');

    const child = spawn(process.execPath, [script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });

    const lines: ((line: string) => void)[] = [];
    const stderr: ((line: string) => void)[] = [];
    const exits: ((code: number | null) => void)[] = [];
    const bufferedLines: string[] = [];
    const bufferedStderr: string[] = [];
    let exited: { code: number | null } | null = null;

    createInterface({ input: child.stdout }).on('line', (line: string) => {
      if (lines.length === 0) bufferedLines.push(line);
      else for (const handler of lines) handler(line);
    });
    createInterface({ input: child.stderr }).on('line', (line: string) => {
      if (stderr.length === 0) bufferedStderr.push(line);
      else for (const handler of stderr) handler(line);
    });
    child.on('exit', (code: number | null) => {
      exited = { code };
      for (const handler of exits) handler(code);
    });

    return {
      send: async (line) => {
        child.stdin.write(`${line}\n`);
      },
      onLine: (handler) => {
        lines.push(handler);
        for (const line of bufferedLines.splice(0)) handler(line);
      },
      onStderr: (handler) => {
        stderr.push(handler);
        for (const line of bufferedStderr.splice(0)) handler(line);
      },
      onExit: (handler) => {
        exits.push(handler);
        if (exited) handler(exited.code);
      },
      kill: async () => {
        child.kill();
      },
    };
  }

  it('runs the reference agent from end to end', async () => {
    const { runtime, review, workspace, a } = await harness();
    workspace.setActive(a);

    const transport = new StdioTransport(
      () => spawnNode('examples/uppercase-agent.mjs'),
      'uppercase',
      { handshakeTimeoutMs: 15_000 },
    );

    const session = runtime.start(transport, 'Uppercase the first line');
    await settle(session);

    expect(session.status.get()).toBe('awaiting-review');
    // The agent's own words, verbatim — the runtime reports what the agent
    // said rather than describing the proposal itself. Asserting the exact
    // string keeps this test honest if the example's wording drifts.
    expect(session.summary.get()).toBe(
      'Proposed uppercasing line 1 of a.txt. Review it and apply what you want.',
    );

    // It read the file over a pipe, decided from what came back, and proposed
    // an edit built out of it — the whole point of the protocol.
    expect(review.staged.get()?.description).toBe('Uppercase the first line of a.txt');
    expect(review.apply().ok).toBe(true);
    expect(workspace.textOf(a)).toBe('ONE\ntwo\nthree\n');

    transport.dispose();
  }, 20_000);

  it('runs the orchestrator example with nothing wired in', async () => {
    const { runtime, review, workspace, a } = await harness();
    workspace.setActive(a);

    const transport = new StdioTransport(
      () => spawnNode('examples/orchestrator-agent.mjs'),
      'orchestrator',
      { handshakeTimeoutMs: 15_000 },
    );

    const session = runtime.start(transport, 'Do something');
    await settle(session);

    // Reaching the end with nothing to propose is an outcome, not a failure —
    // the adapter still has to say so rather than dying quietly.
    expect(session.status.get()).toBe('done');
    expect(session.summary.get()).toBe(
      'No orchestrator is wired in, so there was nothing to propose.',
    );
    expect(review.staged.get()).toBe(null);

    transport.dispose();
  }, 20_000);

  it('stages what an orchestrator returns, against the revision it declared', async () => {
    const { runtime, review, workspace, a } = await harness();
    workspace.setActive(a);

    const transport = new StdioTransport(
      () => spawnNode('examples/orchestrator-agent.mjs', 'tests/fixtures/orchestrator-append-marker.mjs'),
      'orchestrator',
      { handshakeTimeoutMs: 15_000 },
    );

    const session = runtime.start(transport, 'Mark the file');
    await settle(session);

    expect(session.status.get()).toBe('awaiting-review');
    expect(session.summary.get()).toBe('Proposed one line at the end of a.txt.');

    // The edit came back through the proposal rather than through the
    // filesystem, which is the only reason `apply` has anything to do.
    expect(review.staged.get()?.description).toBe('Append a marker to a.txt');
    expect(review.apply().ok).toBe(true);
    expect(workspace.textOf(a)).toBe('one\ntwo\nthree\n// seen\n');

    transport.dispose();
  }, 20_000);

  it('never lets an orchestrator reach a side effect', async () => {
    const { runtime, review, workspace, a } = await harness();
    workspace.setActive(a);

    const transport = new StdioTransport(
      () => spawnNode('examples/orchestrator-agent.mjs', 'tests/fixtures/orchestrator-oversteps.mjs'),
      'orchestrator',
      { handshakeTimeoutMs: 15_000 },
    );

    const session = runtime.start(transport, 'Save everything');
    await settle(session);

    const actions = session.actions.get();
    // Not "refused" — never asked. The adapter stopped it, so no `command`
    // action exists to be granted or denied, and nothing was staged either.
    expect(actions.some((action) => action.kind === 'command')).toBe(false);
    expect(review.staged.get()).toBe(null);
    expect(
      actions.some(
        (action) => action.kind === 'note' && /may not call command\.execute/.test(action.text),
      ),
    ).toBe(true);

    transport.dispose();
  }, 20_000);

  it('remembers one session in the next one', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = mkdtempSync(join(tmpdir(), 'nox-agent-memory-'));
    const store = join(dir, 'memory.jsonl');

    async function runOnce(instruction: string) {
      const { runtime, workspace, a } = await harness();
      workspace.setActive(a);
      const transport = new StdioTransport(
        () => spawnNode('examples/orchestrator-agent.mjs', 'examples/orchestrators/memory.mjs', store),
        'orchestrator',
        { handshakeTimeoutMs: 15_000 },
      );
      const session = runtime.start(transport, instruction);
      await settle(session);
      transport.dispose();
      return session;
    }

    try {
      const first = await runOnce('Rename the parser module');
      expect(first.summary.get()).toBe(
        'Nothing remembered about this workspace yet, and no orchestrator is wired in.',
      );

      // A separate process, a separate Nox session, a separate workspace
      // object — the only thing carried across is the file the agent kept on
      // its own side of the pipe.
      const second = await runOnce('Rename the parser module again');
      expect(second.summary.get()).toBe(
        'Recalled 1 earlier session(s); no orchestrator is wired in, so nothing was proposed.',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('surfaces a crashing agent as a failed session', async () => {
    const { runtime } = await harness();
    const transport = new StdioTransport(
      () => spawnNode('examples/agents/does-not-exist.mjs'),
      'missing',
      { handshakeTimeoutMs: 15_000 },
    );

    const session = runtime.start(transport, 'Go');
    await settle(session);

    expect(session.status.get()).toBe('failed');
    // Node's own error reaches the user rather than a bare "it did not start".
    const last = session.actions.get().at(-1);
    expect(last).toMatchObject({ kind: 'error' });
    expect((last as { message: string }).message).toMatch(/does-not-exist|MODULE_NOT_FOUND|Cannot find/);
  }, 20_000);
});

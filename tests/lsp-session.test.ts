import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { LanguageServerProcess } from '../src/platform/types';
import { LspSession } from '../src/services/lsp/session';
import { spawnLanguageServer } from './support/lsp-child';

/**
 * One server's lifecycle, against a fake process.
 *
 * `LspSession` takes a factory rather than a command line, which is what makes
 * this possible: no fixture binary to keep working on three platforms, no
 * teardown to leak, and failure modes — a server that dies mid-handshake,
 * traffic sent before it can hear it — that are near impossible to provoke on
 * purpose against a real one.
 */

interface Sent {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

class FakeServer implements LanguageServerProcess {
  readonly written: Sent[] = [];
  killed = false;

  #messages: ((message: string) => void)[] = [];
  #stderr: ((line: string) => void)[] = [];
  #exits: ((code: number | null) => void)[] = [];
  // Buffered until someone subscribes, exactly as `LanguageServerProcess`
  // requires — a fake that does not honour the contract tests the wrong thing.
  #bufferedMessages: string[] = [];
  #bufferedStderr: string[] = [];
  #exited: { code: number | null } | null = null;
  #onWrite: ((message: Sent, self: FakeServer) => void) | null = null;

  constructor(onWrite?: (message: Sent, self: FakeServer) => void) {
    this.#onWrite = onWrite ?? null;
  }

  async send(message: string): Promise<void> {
    const parsed = JSON.parse(message) as Sent;
    this.written.push(parsed);
    this.#onWrite?.(parsed, this);
  }

  onMessage(handler: (message: string) => void): void {
    this.#messages.push(handler);
    for (const message of this.#bufferedMessages.splice(0)) handler(message);
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

  /** The server says something. */
  say(message: unknown): void {
    const raw = JSON.stringify(message);
    if (this.#messages.length === 0) this.#bufferedMessages.push(raw);
    else for (const handler of this.#messages) handler(raw);
  }

  complain(line: string): void {
    if (this.#stderr.length === 0) this.#bufferedStderr.push(line);
    else for (const handler of this.#stderr) handler(line);
  }

  die(code: number | null = 1): void {
    this.#exited = { code };
    for (const handler of this.#exits) handler(code);
  }

  /** The methods it was sent, in order. */
  methods(): string[] {
    return this.written.map((message) => message.method ?? '<reply>');
  }
}

/** A server that completes the handshake as soon as it is asked to. */
function politeServer(capabilities: Record<string, unknown> = { textDocumentSync: 1 }) {
  return new FakeServer((message, self) => {
    if (message.method === 'initialize') {
      self.say({ jsonrpc: '2.0', id: message.id, result: { capabilities } });
    }
  });
}

function sessionFor(server: FakeServer) {
  return new LspSession(async () => server, {
    name: 'typescript-language-server',
    rootUri: 'file:///w',
  });
}

describe('starting', () => {
  it('introduces itself with the root and the encoding it can read', async () => {
    const server = politeServer();
    const session = sessionFor(server);
    await session.start();

    const initialize = server.written.find((message) => message.method === 'initialize');
    expect(initialize?.params?.rootUri).toBe('file:///w');
    // Positions are UTF-16 code units everywhere in Nox, and saying so is
    // cheaper than discovering a server chose otherwise.
    expect(initialize?.params?.capabilities).toMatchObject({
      general: { positionEncodings: ['utf-16'] },
    });
  });

  it('is running once the handshake completes', async () => {
    const session = sessionFor(politeServer());
    expect(session.status.get()).toBe('idle');

    await session.start();
    expect(session.status.get()).toBe('running');
  });

  it('follows initialize with initialized, in that order', async () => {
    const server = politeServer();
    await sessionFor(server).start();

    expect(server.methods()).toEqual(['initialize', 'initialized']);
  });

  it('keeps what the server said it can do', async () => {
    const server = politeServer({ textDocumentSync: 2, hoverProvider: true });
    const session = sessionFor(server);
    await session.start();

    expect(session.capabilities.get()).toEqual({ textDocumentSync: 2, hoverProvider: true });
  });
});

describe('traffic before the handshake finishes', () => {
  it('queues a notification rather than sending it early', async () => {
    // Servers are entitled to reject anything before initialize, and a file
    // opened during a cold start is the common case rather than the edge one.
    const server = new FakeServer();
    const session = sessionFor(server);

    const starting = session.start();
    // Wait for the handshake to be *in flight* — the session opens the process
    // before it writes anything, so asserting before that has resolved would
    // pass against an implementation with no queue at all.
    await vi.waitFor(() => expect(server.methods()).toEqual(['initialize']));

    void session.notify('textDocument/didOpen', { uri: 'file:///w/a.ts' });
    expect(server.methods()).toEqual(['initialize']);

    server.say({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } });
    await starting;
    await vi.waitFor(() => expect(server.methods()).toHaveLength(3));

    expect(server.methods()).toEqual(['initialize', 'initialized', 'textDocument/didOpen']);
  });
});

describe('stopping', () => {
  it('asks, tells, then kills — in that order', async () => {
    // A server killed outright can leave its own child running; tsserver does.
    const server = new FakeServer((message, self) => {
      if (message.method === 'initialize') {
        self.say({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
      }
      if (message.method === 'shutdown') {
        self.say({ jsonrpc: '2.0', id: message.id, result: null });
      }
    });

    const session = sessionFor(server);
    await session.start();
    await session.stop();

    expect(server.methods()).toEqual(['initialize', 'initialized', 'shutdown', 'exit']);
    expect(server.killed).toBe(true);
    expect(session.status.get()).toBe('stopped');
  });

  it('still kills a server that never answers shutdown', async () => {
    const server = politeServer();
    const session = new LspSession(async () => server, {
      name: 'stubborn',
      rootUri: 'file:///w',
      timeoutMs: 10,
    });
    await session.start();

    vi.useFakeTimers();
    try {
      const stopping = session.stop();
      await vi.advanceTimersByTimeAsync(50);
      await stopping;
    } finally {
      vi.useRealTimers();
    }

    expect(server.killed).toBe(true);
    expect(session.status.get()).toBe('stopped');
  });
});

describe('failure', () => {
  it('fails when the server cannot be started at all', async () => {
    // What a missing command looks like from here.
    const session = new LspSession(
      async () => {
        throw new Error('spawn: could not start tsserver (ENOENT)');
      },
      { name: 'missing', rootUri: 'file:///w' },
    );

    await session.start();

    expect(session.status.get()).toBe('failed');
    expect(session.error).toMatch(/ENOENT/);
  });

  it('fails when the server dies during the handshake, and keeps its last words', async () => {
    const server = new FakeServer();
    const session = sessionFor(server);

    const starting = session.start();
    server.complain('Cannot find module "typescript"');
    server.die(1);
    await starting;

    expect(session.status.get()).toBe('failed');
    // Its last words on stderr are the only explanation anyone will get.
    expect(session.stderr).toContain('Cannot find module "typescript"');
  });

  it('fails when the server crashes while running, and says so once', async () => {
    const server = politeServer();
    const session = sessionFor(server);
    const exits: (number | null)[] = [];
    session.onExit((code) => exits.push(code));

    await session.start();
    server.die(9);

    expect(session.status.get()).toBe('failed');
    expect(exits).toEqual([9]);
  });

  it('keeps only the last twenty stderr lines', async () => {
    const server = new FakeServer();
    const session = sessionFor(server);
    const starting = session.start();

    for (let i = 0; i < 30; i++) server.complain(`line ${i}`);
    server.die(1);
    await starting;

    expect(session.stderr).toHaveLength(20);
    expect(session.stderr[0]).toBe('line 10');
    expect(session.stderr[19]).toBe('line 29');
  });

  it('rejects a request made after the server is gone', async () => {
    const server = politeServer();
    const session = sessionFor(server);
    await session.start();
    server.die(1);

    await expect(session.request('textDocument/hover')).rejects.toThrow();
  });
});

describe('a real child process', () => {
  /**
   * The same adapter `tests/lsp-integration.test.ts` drives a real server
   * through, so the fake server here and the real one there are reached the
   * same way — a difference between them would otherwise be a difference in
   * the harness rather than in the thing under test.
   */
  const spawnNode = (script: string) => spawnLanguageServer(process.execPath, [script]);
  const SCRIPT = fileURLToPath(new URL('./support/fake-lsp-server.mjs', import.meta.url));

  it('completes a handshake over real pipes', async () => {
    const session = new LspSession(() => spawnNode(SCRIPT), {
      name: 'fake',
      rootUri: 'file:///w',
    });

    await session.start();
    expect(session.status.get()).toBe('running');
    await session.stop();
  });

  it('carries a non-ASCII payload through intact', async () => {
    // 'café — naïve' is longer in bytes than in characters. A client that
    // framed over decoded text would deliver this truncated, and the
    // truncation would land mid-JSON and fail to parse rather than politely
    // losing the accent.
    const session = new LspSession(() => spawnNode(SCRIPT), {
      name: 'fake',
      rootUri: 'file:///w',
    });

    await session.start();
    const info = session.serverInfo.get();
    await session.stop();

    expect(info?.name).toBe('café — naïve');
  });

  it('delivers a pushed notification, unasked', async () => {
    const session = new LspSession(() => spawnNode(SCRIPT), {
      name: 'fake',
      rootUri: 'file:///w',
    });
    const published: unknown[] = [];
    session.onNotification('textDocument/publishDiagnostics', (params) => published.push(params));

    await session.start();
    await session.notify('textDocument/didOpen', {
      textDocument: { uri: 'file:///w/a.ts', languageId: 'typescript', version: 1, text: 'x' },
    });
    await vi.waitFor(() => expect(published).toHaveLength(1));
    await session.stop();

    expect(published[0]).toMatchObject({ uri: 'file:///w/a.ts' });
  });
});

import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { LanguageServerProcess } from '../src/platform/types';
import { LspSession } from '../src/services/lsp/session';

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
   * Adapts a Node child to `LanguageServerProcess`.
   *
   * This is what `src-tauri/src/lsp.rs` does, in about the same number of
   * lines. Standing it up here means the wire format and the whole client are
   * exercised against genuine pipes — everything except the Rust plumbing
   * itself, which cannot run without a window.
   *
   * The reader is byte-based rather than line-based, which is the one thing
   * that could not be copied from `tests/stdio.test.ts`: an LSP body has no
   * trailing newline, so `readline` would hold every message until the next
   * one arrived.
   */
  async function spawnNode(script: string): Promise<LanguageServerProcess> {
    const { spawn } = await import('node:child_process');

    const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });

    const messages: ((message: string) => void)[] = [];
    const stderr: ((line: string) => void)[] = [];
    const exits: ((code: number | null) => void)[] = [];
    const bufferedMessages: string[] = [];
    const bufferedStderr: string[] = [];
    let exited: { code: number | null } | null = null;
    let buffer = Buffer.alloc(0);

    child.stdout.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const split = buffer.indexOf('\r\n\r\n');
        if (split === -1) return;
        const header = buffer.subarray(0, split).toString('ascii');
        // Counted in bytes, which is the whole reason this is a Buffer and not
        // a string. `subarray` slices bytes; `slice` on a decoded string would
        // cut the wrong place on the first accented character.
        const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1]);
        if (buffer.length < split + 4 + length) return;

        const message = buffer.subarray(split + 4, split + 4 + length).toString('utf8');
        buffer = buffer.subarray(split + 4 + length);

        if (messages.length === 0) bufferedMessages.push(message);
        else for (const handler of messages) handler(message);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trimEnd();
      if (stderr.length === 0) bufferedStderr.push(line);
      else for (const handler of stderr) handler(line);
    });

    child.on('exit', (code: number | null) => {
      exited = { code };
      for (const handler of exits) handler(code);
    });

    // A write racing the child's own exit fails asynchronously, and an
    // unhandled 'error' on a stream is an uncaught exception rather than a
    // rejected promise. `exit` is precisely such a write — the server acts on
    // it by dying — so this is the normal path, not a defensive one. The Rust
    // side gets this for free: `write_all` returns an Err that `nox_lsp_send`
    // turns into a message.
    child.stdin.on('error', () => {});

    return {
      send: async (message: string) => {
        if (exited || child.stdin.destroyed) return;
        const body = Buffer.from(message, 'utf8');
        // One write rather than two: a header and a body written separately
        // can be interleaved with the exit and leave half a message on the
        // wire, which is unframeable rather than merely incomplete.
        child.stdin.write(
          Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]),
        );
      },
      onMessage: (handler) => {
        messages.push(handler);
        for (const message of bufferedMessages.splice(0)) handler(message);
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

  // `fileURLToPath`, not `.pathname`: this repository lives under a directory
  // with a space in its name, so the pathname is percent-encoded and naming a
  // file that does not exist. The child then fails to start, and the session
  // reports it as a server that could not be spawned — which is true, and
  // says nothing about why.
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

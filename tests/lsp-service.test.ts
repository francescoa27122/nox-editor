import { describe, expect, it, vi } from 'vitest';
import type { LanguageServerProcess } from '../src/platform/types';
import { MemoryPlatform } from '../src/platform/memory';
import { LspService } from '../src/services/lsp';
import { SERVERS_FILE, ServerRegistry } from '../src/services/lsp/registry';
import { WorkspaceService } from '../src/services/workspace';

/**
 * Diagnostics, held by URI and checked against the text they describe.
 *
 * The service takes a process factory for the same reason `LspSession` does,
 * which is what lets a crash, a stale batch and a restart cap all be staged
 * here rather than hoped for against a real server.
 */

class FakeServer implements LanguageServerProcess {
  readonly written: { id?: number; method?: string }[] = [];
  #messages: ((message: string) => void)[] = [];
  #stderr: ((line: string) => void)[] = [];
  #exits: ((code: number | null) => void)[] = [];
  #buffered: string[] = [];
  #exited: { code: number | null } | null = null;

  async send(message: string): Promise<void> {
    const parsed = JSON.parse(message) as { id?: number; method?: string };
    this.written.push(parsed);
    if (parsed.method === 'initialize') {
      this.say({ jsonrpc: '2.0', id: parsed.id, result: { capabilities: {} } });
    }
    if (parsed.method === 'shutdown') {
      this.say({ jsonrpc: '2.0', id: parsed.id, result: null });
    }
  }

  onMessage(handler: (message: string) => void): void {
    this.#messages.push(handler);
    for (const message of this.#buffered.splice(0)) handler(message);
  }
  onStderr(handler: (line: string) => void): void {
    this.#stderr.push(handler);
  }
  onExit(handler: (code: number | null) => void): void {
    this.#exits.push(handler);
    if (this.#exited) handler(this.#exited.code);
  }
  async kill(): Promise<void> {}

  say(message: unknown): void {
    const raw = JSON.stringify(message);
    if (this.#messages.length === 0) this.#buffered.push(raw);
    else for (const handler of this.#messages) handler(raw);
  }

  publish(uri: string, diagnostics: unknown[], version?: number): void {
    this.say({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics, ...(version === undefined ? {} : { version }) },
    });
  }

  die(code: number | null = 1): void {
    this.#exited = { code };
    for (const handler of this.#exits) handler(code);
  }
}

const ERROR = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
  severity: 1,
  message: 'no',
};

async function setup(options: { servers?: number } = {}) {
  const platform = new MemoryPlatform();
  platform.seedFile('/w/src/main.ts', 'const a = 1;\n');
  await platform.writeConfigFile(
    SERVERS_FILE,
    JSON.stringify({ servers: [{ languages: ['typescript'], command: 'tsserver' }] }),
  );

  const workspace = new WorkspaceService(platform, () => []);
  await workspace.openFolder('/w');

  const registry = new ServerRegistry(platform);
  await registry.load();

  const spawned: FakeServer[] = [];
  const service = new LspService(workspace, registry, {
    rootPath: () => '/w',
    open: async () => {
      const server = new FakeServer();
      spawned.push(server);
      return server;
    },
    ...options,
  });

  return { platform, workspace, registry, service, spawned };
}

describe('diagnostics', () => {
  it('holds what a server publishes, under its URI', async () => {
    const { service, spawned } = await setup();
    await service.start();

    spawned[0]!.publish('file:///w/src/main.ts', [ERROR]);

    expect(service.diagnosticsFor('file:///w/src/main.ts')).toHaveLength(1);
    expect(service.diagnosticsFor('file:///w/src/main.ts')[0]?.message).toBe('no');
  });

  it('keeps diagnostics for a file nobody opened', async () => {
    // A server publishes project-wide errors for files that were never opened.
    // A panel listing only open tabs would be a different, lesser feature.
    const { service, spawned } = await setup();
    await service.start();

    spawned[0]!.publish('file:///w/src/never-opened.ts', [ERROR]);

    expect(service.diagnosticsFor('file:///w/src/never-opened.ts')).toHaveLength(1);
  });

  it('drops a batch the buffer has already outrun', async () => {
    const { workspace, service, spawned } = await setup();
    await service.start();
    const id = (await workspace.open('/w/src/main.ts'))!;

    const stale = workspace.revisionOf(id) - 1;
    spawned[0]!.publish('file:///w/src/main.ts', [ERROR], stale);

    expect(service.diagnosticsFor('file:///w/src/main.ts')).toEqual([]);
  });

  it('applies a batch that names the buffer revision it was computed from', async () => {
    const { workspace, service, spawned } = await setup();
    await service.start();
    const id = (await workspace.open('/w/src/main.ts'))!;

    spawned[0]!.publish('file:///w/src/main.ts', [ERROR], workspace.revisionOf(id));

    expect(service.diagnosticsFor('file:///w/src/main.ts')).toHaveLength(1);
  });

  it('applies a batch with no version at all', async () => {
    // The field is optional, and a server that omits it must not be silently
    // ignored — that would be a feature that works for some servers only.
    const { workspace, service, spawned } = await setup();
    await service.start();
    await workspace.open('/w/src/main.ts');

    spawned[0]!.publish('file:///w/src/main.ts', [ERROR]);

    expect(service.diagnosticsFor('file:///w/src/main.ts')).toHaveLength(1);
  });

  it('clears a URI when the server publishes an empty batch', async () => {
    const { service, spawned } = await setup();
    await service.start();

    spawned[0]!.publish('file:///w/src/main.ts', [ERROR]);
    spawned[0]!.publish('file:///w/src/main.ts', []);

    expect(service.diagnosticsFor('file:///w/src/main.ts')).toEqual([]);
    expect(service.diagnostics.get().has('file:///w/src/main.ts')).toBe(false);
  });
});

describe('a server that dies', () => {
  it('clears every diagnostic it published, so no squiggle outlives it', async () => {
    const { service, spawned } = await setup();
    await service.start();
    spawned[0]!.publish('file:///w/src/main.ts', [ERROR]);

    spawned[0]!.die(1);

    expect(service.diagnosticsFor('file:///w/src/main.ts')).toEqual([]);
  });

  it('restarts it, after a wait', async () => {
    vi.useFakeTimers();
    try {
      const { service, spawned } = await setup();
      await service.start();
      expect(spawned).toHaveLength(1);

      spawned[0]!.die(1);
      await vi.advanceTimersByTimeAsync(1000);

      expect(spawned.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after three attempts rather than respawning forever', async () => {
    // A silent respawn loop is worse than a stop: it burns a core and never
    // says why.
    vi.useFakeTimers();
    try {
      const { service, spawned } = await setup();
      await service.start();

      for (let attempt = 0; attempt < 6; attempt++) {
        spawned[spawned.length - 1]!.die(1);
        await vi.advanceTimersByTimeAsync(10_000);
      }

      expect(spawned).toHaveLength(4); // The first, plus three restarts.
      expect(service.sessions.get()[0]?.status).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('configuration', () => {
  it('starts nothing when servers.json describes nothing', async () => {
    const platform = new MemoryPlatform();
    platform.seedFile('/w/src/main.ts', 'const a = 1;\n');
    const workspace = new WorkspaceService(platform, () => []);
    await workspace.openFolder('/w');

    const registry = new ServerRegistry(platform);
    await registry.load();

    const spawned: FakeServer[] = [];
    const service = new LspService(workspace, registry, {
      rootPath: () => '/w',
      open: async () => {
        const server = new FakeServer();
        spawned.push(server);
        return server;
      },
    });
    await service.start();

    expect(spawned).toEqual([]);
    expect(service.sessions.get()).toEqual([]);
  });

  it('reports which servers are running, and under what name', async () => {
    const { service } = await setup();
    await service.start();

    expect(service.sessions.get()).toEqual([
      expect.objectContaining({ name: 'tsserver', status: 'running' }),
    ]);
  });
});

describe('stopping', () => {
  it('stops every server and forgets every diagnostic', async () => {
    const { service, spawned } = await setup();
    await service.start();
    spawned[0]!.publish('file:///w/src/main.ts', [ERROR]);

    await service.stop();

    expect(service.diagnostics.get().size).toBe(0);
    expect(service.sessions.get()).toEqual([]);
  });
});

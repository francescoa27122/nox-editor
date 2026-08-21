import { describe, expect, it, vi } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { LspService } from '../src/services/lsp';
import { SERVERS_FILE, ServerRegistry } from '../src/services/lsp/registry';
import { WorkspaceService } from '../src/services/workspace';
import { activeLanguageStatus, serverStatusLabel } from '../src/ui/lsp-status';
import { FakeLanguageServer } from './support/fake-lsp-process';

/**
 * Diagnostics, held by URI and checked against the text they describe.
 *
 * The service takes a process factory for the same reason `LspSession` does,
 * which is what lets a crash, a stale batch and a restart cap all be staged
 * here rather than hoped for against a real server.
 */

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

  const spawned: FakeLanguageServer[] = [];
  const service = new LspService(workspace, registry, {
    rootPath: () => '/w',
    open: async () => {
      const server = new FakeLanguageServer();
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

    const spawned: FakeLanguageServer[] = [];
    const service = new LspService(workspace, registry, {
      rootPath: () => '/w',
      open: async () => {
        const server = new FakeLanguageServer();
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

  /**
   * The field the status bar could not do without. `SessionStatusRow` carried
   * no `languages`, so the active buffer's language was not an input to
   * `serverStatusLabel` and could not be made one — which is why the bar read
   * `tsserver` beside an open `main.py`. Taken from `entry.config` rather than
   * re-read from the registry, because a row describes a running session and
   * `lsp.reload` can leave those two disagreeing.
   */
  it('reports which languages each running server answers for', async () => {
    const { service } = await setup();
    await service.start();

    expect(service.sessions.get()[0]?.languages).toEqual(['typescript']);
  });

  it('does not let the bar claim a TypeScript server for a Python file', async () => {
    const { platform, workspace, service } = await setup();
    platform.seedFile('/w/src/main.py', 'x = 1\n');
    await workspace.open('/w/src/main.py');
    await service.start();

    // End to end through the real service rather than a hand-built row, so
    // the language id spelling that `servers.json` uses and the one
    // `BufferSnapshot` uses are checked against each other too.
    const languageId = workspace.activeSnapshot()!.languageId;
    expect(languageId).toBe('python');

    expect(serverStatusLabel(service.sessions.get(), languageId)).toBe('1 server');
    expect(
      activeLanguageStatus(
        { id: languageId, name: 'Python', hasGrammar: true },
        service.sessions.get(),
      ),
    ).toEqual({
      title: 'Python — no language server configured',
      tone: 'muted',
      commandId: 'lsp.configure',
    });
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

describe('the request door', () => {
  it('asks the server that serves the language', async () => {
    const { service, spawned } = await setup();
    await service.start();

    const pending = service.requestFor('typescript', 'textDocument/completion', { a: 1 });
    await vi.waitFor(() =>
      expect(spawned[0]!.written.some((m) => m.method === 'textDocument/completion')).toBe(true),
    );

    const sent = spawned[0]!.written.find((m) => m.method === 'textDocument/completion')!;
    spawned[0]!.say({ jsonrpc: '2.0', id: sent.id, result: { items: [] } });
    await expect(pending).resolves.toEqual({ items: [] });
  });

  it('rejects when no server serves the language', async () => {
    // Distinct from an empty result: "no server" and "no suggestions" mean
    // very different things to someone staring at an empty picker.
    const { service } = await setup();
    await service.start();

    await expect(service.requestFor('rust', 'textDocument/completion', {})).rejects.toThrow(
      /no language server/i,
    );
  });

  it('reports the capabilities of the server for a language', async () => {
    const { service } = await setup();
    await service.start();

    expect(service.capabilitiesFor('typescript')).toEqual({});
    expect(service.capabilitiesFor('rust')).toBeNull();
  });

  it('does not treat a failed server as available', async () => {
    // Queuing a request behind a dead session would resolve long after the
    // keystroke that asked for it, if ever.
    const { service, spawned } = await setup();
    await service.start();
    spawned[0]!.die(1);

    expect(service.capabilitiesFor('typescript')).toBeNull();
    await expect(service.requestFor('typescript', 'x', {})).rejects.toThrow();
  });
});

describe('requests see the current document', () => {
  it('sends pending changes before asking, not after', async () => {
    // The bug this exists for: `didChange` is debounced 300ms, completion
    // fires on the keystroke, and a server that has not been sent the change
    // answers about the text it still holds. Typing `console.` returned 2010
    // globals instead of 20 members, measured against a real tsserver.
    vi.useFakeTimers();
    try {
      const { workspace, service, spawned } = await setup();
      await service.start();
      const id = (await workspace.open('/w/src/main.ts'))!;
      workspace.replaceContents(id, 'console.\n');

      // Nothing sent yet: the debounce has not fired.
      expect(spawned[0]!.written.some((m) => m.method === 'textDocument/didChange')).toBe(false);

      void service.requestFor('typescript', 'textDocument/completion', {});
      await vi.advanceTimersByTimeAsync(0);

      const methods = spawned[0]!.written.map((m) => m.method);
      const changed = methods.indexOf('textDocument/didChange');
      const asked = methods.indexOf('textDocument/completion');

      expect(changed).toBeGreaterThanOrEqual(0);
      expect(asked).toBeGreaterThanOrEqual(0);
      expect(changed).toBeLessThan(asked);
    } finally {
      vi.useRealTimers();
    }
  });
});

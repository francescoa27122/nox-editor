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

/**
 * A4-010: `diagnosticsTotals` is what `StatusBar`, `Sidebar` and
 * `ProblemsPanel` now read for their aggregate count, instead of each
 * re-walking the whole `diagnostics` map on every publish via
 * `problemTotals`. It is kept by the delta each publish makes rather than
 * recomputed, so these check it stays *correct* under exactly the load that
 * made recomputing it expensive: a burst of per-file publishes, a
 * republished batch whose severity mix changes rather than just its count,
 * and a dead server taking its share of the total with it.
 */
describe('diagnosticsTotals', () => {
  const WARNING = { ...ERROR, severity: 2 as const };

  it('stays correct across a burst of per-file publishes', async () => {
    // The shape the finding names: a server's cold-start sweep of a large
    // tree, one publish per file.
    const { service, spawned } = await setup();
    await service.start();

    let expectedErrors = 0;
    let expectedWarnings = 0;
    for (let i = 0; i < 200; i++) {
      const diagnostic = i % 3 === 0 ? WARNING : ERROR;
      if (diagnostic.severity === 2) expectedWarnings++;
      else expectedErrors++;
      spawned[0]!.publish(`file:///w/src/f${i}.ts`, [diagnostic]);
    }

    expect(service.diagnosticsTotals.get()).toEqual({
      errors: expectedErrors,
      warnings: expectedWarnings,
      files: 200,
    });
  });

  it('drops a file from the total when its batch clears, not just from the map', async () => {
    const { service, spawned } = await setup();
    await service.start();
    spawned[0]!.publish('file:///w/src/a.ts', [ERROR]);
    spawned[0]!.publish('file:///w/src/b.ts', [ERROR, WARNING]);
    expect(service.diagnosticsTotals.get()).toEqual({ errors: 2, warnings: 1, files: 2 });

    spawned[0]!.publish('file:///w/src/a.ts', []);

    expect(service.diagnosticsTotals.get()).toEqual({ errors: 1, warnings: 1, files: 1 });
  });

  /**
   * The case a plain "add the new batch's counts" would get wrong: a
   * republish for a URI already in the map has to *replace* its share of the
   * total, not add to it, and the replacement can move errors into warnings
   * without changing the file or diagnostic count at all.
   */
  it('adjusts the total when a republished batch changes severity mix, not just count', async () => {
    const { service, spawned } = await setup();
    await service.start();
    spawned[0]!.publish('file:///w/src/a.ts', [ERROR, ERROR]);
    expect(service.diagnosticsTotals.get()).toEqual({ errors: 2, warnings: 0, files: 1 });

    spawned[0]!.publish('file:///w/src/a.ts', [WARNING]);

    expect(service.diagnosticsTotals.get()).toEqual({ errors: 0, warnings: 1, files: 1 });
  });

  it('drops a dead server\'s share of the total along with its diagnostics', async () => {
    const { service, spawned } = await setup();
    await service.start();
    spawned[0]!.publish('file:///w/src/a.ts', [ERROR]);
    spawned[0]!.publish('file:///w/src/b.ts', [WARNING]);
    expect(service.diagnosticsTotals.get()).toEqual({ errors: 1, warnings: 1, files: 2 });

    spawned[0]!.die(1);

    expect(service.diagnosticsTotals.get()).toEqual({ errors: 0, warnings: 0, files: 0 });
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
    // A4-010: `diagnosticsTotals` is a companion signal, not derived from
    // `diagnostics` on read, so clearing one without the other would have
    // left the bar reporting problems that no longer exist.
    expect(service.diagnosticsTotals.get()).toEqual({ errors: 0, warnings: 0, files: 0 });
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

/**
 * `workspace/configuration`, end to end from `servers.json` to the reply.
 *
 * The unit tests above it cover the resolution and the seam; this covers the
 * wiring between them, which is the part that was missing rather than wrong.
 */
describe('answering a server that asks for its settings', () => {
  async function setupWith(entry: Record<string, unknown>) {
    const platform = new MemoryPlatform();
    platform.seedFile('/w/main.py', 'x = 1\n');
    await platform.writeConfigFile(SERVERS_FILE, JSON.stringify({ servers: [entry] }));

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
    return { service, spawned };
  }

  /** What pyright does, spelled the way pyright spells it. */
  it('answers from the settings the user wrote for that server', async () => {
    const { service, spawned } = await setupWith({
      languages: ['python'],
      command: 'pyright-langserver',
      settings: { python: { analysis: { typeCheckingMode: 'strict' } } },
    });
    await service.start();

    spawned[0]!.say({
      jsonrpc: '2.0',
      id: 42,
      method: 'workspace/configuration',
      params: { items: [{ section: 'python.analysis' }, { section: 'python.nothing' }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const reply = spawned[0]!.written.find((message) => message.id === 42) as
      | { result?: unknown }
      | undefined;
    expect(reply?.result).toEqual([{ typeCheckingMode: 'strict' }, null]);
  });

  /**
   * A server configured without a `settings` block gets exactly what it got
   * before this handler existed — nothing — so adding the handler cannot
   * change a working setup. It gets it as a well-formed reply rather than as
   * MethodNotFound, which is the only difference.
   */
  it('answers nulls when the entry has no settings', async () => {
    const { service, spawned } = await setupWith({
      languages: ['typescript'],
      command: 'tsserver',
    });
    await service.start();

    spawned[0]!.say({
      jsonrpc: '2.0',
      id: 43,
      method: 'workspace/configuration',
      params: { items: [{ section: 'typescript' }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const reply = spawned[0]!.written.find((message) => message.id === 43) as
      | { result?: unknown; error?: unknown }
      | undefined;
    expect(reply?.error).toBeUndefined();
    expect(reply?.result).toEqual([null]);
  });

  /** And the capability that invites the question is now sent. */
  it('tells the server it may ask', async () => {
    const { service, spawned } = await setupWith({
      languages: ['typescript'],
      command: 'tsserver',
    });
    await service.start();

    const initialize = spawned[0]!.written.find((message) => message.method === 'initialize');
    expect(initialize?.params).toMatchObject({
      capabilities: { workspace: { configuration: true } },
    });
  });
});

/**
 * `$/progress`, from the server saying so to the status row carrying it.
 *
 * The symptom: rust-analyzer indexes a cold project for thirty seconds before
 * it can answer anything, and did so in silence. Hover returned nothing,
 * definition returned nothing, and the only available reading was that the
 * server was broken.
 */
describe('showing what a server is busy with', () => {
  async function running() {
    const { service, spawned } = await setup();
    await service.start();
    return { service, server: spawned[0]! };
  }

  const rowFor = (service: LspService) => service.sessions.get()[0]!;

  it('carries work from begin to end', async () => {
    const { service, server } = await running();
    expect(rowFor(service).progress).toEqual([]);

    server.say({
      jsonrpc: '2.0',
      method: '$/progress',
      params: { token: 'idx', value: { kind: 'begin', title: 'Indexing' } },
    });
    expect(rowFor(service).progress).toEqual([{ title: 'Indexing' }]);

    server.say({
      jsonrpc: '2.0',
      method: '$/progress',
      params: { token: 'idx', value: { kind: 'report', message: '3/840', percentage: 20 } },
    });
    expect(rowFor(service).progress).toEqual([
      { title: 'Indexing', message: '3/840', percentage: 20 },
    ]);

    server.say({
      jsonrpc: '2.0',
      method: '$/progress',
      params: { token: 'idx', value: { kind: 'end' } },
    });
    expect(rowFor(service).progress).toEqual([]);
  });

  /**
   * Server-initiated progress *starts* with the server asking to reserve a
   * token, and a server refused there does not go on to send notifications. So
   * a client that never answers this never sees progress at all, however well
   * it handles `$/progress`.
   */
  it('lets the server reserve a progress token', async () => {
    const { server } = await running();

    server.say({
      jsonrpc: '2.0',
      id: 77,
      method: 'window/workDoneProgress/create',
      params: { token: 'idx' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const reply = server.written.find((message) => message.id === 77) as
      | { result?: unknown; error?: unknown }
      | undefined;
    expect(reply?.error).toBeUndefined();
    expect(reply).toHaveProperty('result');
  });

  it('tells the server it can render progress', async () => {
    const { server } = await running();
    const initialize = server.written.find((message) => message.method === 'initialize');
    expect(initialize?.params).toMatchObject({
      capabilities: { window: { workDoneProgress: true } },
    });
  });
});

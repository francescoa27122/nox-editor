import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { DocumentSync } from '../src/services/lsp/documents';
import { WorkspaceService } from '../src/services/workspace';

/**
 * What the server is told about the documents.
 *
 * The version is the assertion that matters most: it is the buffer's own
 * revision, so a diagnostic batch can be checked against the text it was
 * computed from. A second, parallel counter would drift, and the drift would
 * be invisible until a squiggle landed on the wrong line.
 */

interface Notification {
  method: string;
  params: Record<string, unknown>;
}

/** Stands in for `LspSession`, recording only what it was told. */
class RecordingSession {
  readonly sent: Notification[] = [];

  async notify(method: string, params?: unknown): Promise<void> {
    this.sent.push({ method, params: (params ?? {}) as Record<string, unknown> });
  }

  methods(): string[] {
    return this.sent.map((notification) => notification.method);
  }

  last(): Notification | undefined {
    return this.sent[this.sent.length - 1];
  }
}

function setup() {
  const platform = new MemoryPlatform();
  platform.seedFile('/w/src/main.ts', 'const a = 1;\n');
  platform.seedFile('/w/notes.md', '# notes\n');

  const workspace = new WorkspaceService(platform, () => []);
  const session = new RecordingSession();
  const sync = new DocumentSync(workspace, { debounceMs: 300 });
  sync.attach(session, ['typescript']);

  return { platform, workspace, session, sync };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('opening', () => {
  it('tells the server about a document in a language it serves', async () => {
    const { workspace, session } = setup();
    await workspace.openFolder('/w');
    const id = (await workspace.open('/w/src/main.ts'))!;

    expect(session.methods()).toEqual(['textDocument/didOpen']);
    expect(session.last()?.params.textDocument).toEqual({
      uri: 'file:///w/src/main.ts',
      languageId: 'typescript',
      version: workspace.revisionOf(id),
      text: 'const a = 1;\n',
    });
  });

  it('says nothing about a language it does not serve', async () => {
    const { workspace, session } = setup();
    await workspace.openFolder('/w');
    await workspace.open('/w/notes.md');

    expect(session.sent).toEqual([]);
  });

  it('opens each document once, however often the buffer list republishes', async () => {
    const { workspace, session } = setup();
    await workspace.openFolder('/w');
    const id = (await workspace.open('/w/src/main.ts'))!;
    workspace.replaceContents(id, 'const a = 2;\n');

    expect(session.methods().filter((method) => method === 'textDocument/didOpen')).toHaveLength(1);
  });
});

describe('changing', () => {
  it('coalesces edits into one message', async () => {
    vi.useFakeTimers();
    const { workspace, session } = setup();
    await workspace.openFolder('/w');
    const id = (await workspace.open('/w/src/main.ts'))!;

    workspace.replaceContents(id, 'const a = 2;\n');
    workspace.replaceContents(id, 'const a = 3;\n');
    workspace.replaceContents(id, 'const a = 4;\n');
    expect(session.methods()).toEqual(['textDocument/didOpen']);

    await vi.advanceTimersByTimeAsync(300);
    expect(session.methods()).toEqual(['textDocument/didOpen', 'textDocument/didChange']);
  });

  it('sends the whole document, because the sync is full', async () => {
    vi.useFakeTimers();
    const { workspace, session } = setup();
    await workspace.openFolder('/w');
    const id = (await workspace.open('/w/src/main.ts'))!;

    workspace.replaceContents(id, 'const a = 9;\n');
    await vi.advanceTimersByTimeAsync(300);

    expect(session.last()?.params.contentChanges).toEqual([{ text: 'const a = 9;\n' }]);
  });

  it('versions the change with the buffer revision it was computed from', async () => {
    vi.useFakeTimers();
    const { workspace, session } = setup();
    await workspace.openFolder('/w');
    const id = (await workspace.open('/w/src/main.ts'))!;

    workspace.replaceContents(id, 'const a = 9;\n');
    await vi.advanceTimersByTimeAsync(300);

    expect(session.last()?.params.textDocument).toEqual({
      uri: 'file:///w/src/main.ts',
      version: workspace.revisionOf(id),
    });
  });
});

describe('closing', () => {
  it('tells the server the document is gone', async () => {
    const { workspace, session } = setup();
    await workspace.openFolder('/w');
    const id = (await workspace.open('/w/src/main.ts'))!;
    workspace.close(id, { force: true });

    expect(session.methods()).toEqual(['textDocument/didOpen', 'textDocument/didClose']);
    expect(session.last()?.params.textDocument).toEqual({ uri: 'file:///w/src/main.ts' });
  });

  it('drops a pending change rather than sending it after the close', async () => {
    // A didChange arriving after didClose describes a document the server has
    // already forgotten, and servers are entitled to treat that as a protocol
    // error rather than ignore it.
    vi.useFakeTimers();
    const { workspace, session } = setup();
    await workspace.openFolder('/w');
    const id = (await workspace.open('/w/src/main.ts'))!;

    workspace.replaceContents(id, 'const a = 9;\n');
    workspace.close(id, { force: true });
    await vi.advanceTimersByTimeAsync(300);

    expect(session.methods()).toEqual(['textDocument/didOpen', 'textDocument/didClose']);
  });

  it('reports which documents it believes are open', async () => {
    const { workspace, sync } = setup();
    await workspace.openFolder('/w');
    const id = (await workspace.open('/w/src/main.ts'))!;

    expect(sync.openUris()).toEqual(['file:///w/src/main.ts']);

    workspace.close(id, { force: true });
    expect(sync.openUris()).toEqual([]);
  });
});

describe('disposal', () => {
  it('stops listening, and sends nothing more', async () => {
    vi.useFakeTimers();
    const { workspace, session, sync } = setup();
    await workspace.openFolder('/w');
    const id = (await workspace.open('/w/src/main.ts'))!;

    sync.dispose();
    workspace.replaceContents(id, 'const a = 9;\n');
    await vi.advanceTimersByTimeAsync(300);

    expect(session.methods()).toEqual(['textDocument/didOpen']);
  });
});

describe('flushing', () => {
  it('sends a pending change immediately', async () => {
    // A request that depends on document content cannot wait out the
    // debounce: the server would answer about text it has not been sent.
    vi.useFakeTimers();
    const { workspace, session, sync } = setup();
    await workspace.openFolder('/w');
    const id = (await workspace.open('/w/src/main.ts'))!;

    workspace.replaceContents(id, 'const a = 9;\n');
    expect(session.methods()).toEqual(['textDocument/didOpen']);

    sync.flush();

    expect(session.methods()).toEqual(['textDocument/didOpen', 'textDocument/didChange']);
    expect(session.last()?.params.contentChanges).toEqual([{ text: 'const a = 9;\n' }]);
  });

  it('does not send the change twice when the debounce later fires', async () => {
    vi.useFakeTimers();
    const { workspace, session, sync } = setup();
    await workspace.openFolder('/w');
    const id = (await workspace.open('/w/src/main.ts'))!;

    workspace.replaceContents(id, 'const a = 9;\n');
    sync.flush();
    await vi.advanceTimersByTimeAsync(600);

    expect(session.methods().filter((m) => m === 'textDocument/didChange')).toHaveLength(1);
  });

  it('is a no-op when nothing is pending', async () => {
    const { workspace, session, sync } = setup();
    await workspace.openFolder('/w');
    await workspace.open('/w/src/main.ts');

    sync.flush();

    expect(session.methods()).toEqual(['textDocument/didOpen']);
  });
});

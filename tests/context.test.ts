import { history } from '@codemirror/commands';
import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { CommandRegistry, type Command } from '../src/services/commands';
import { ContextService } from '../src/services/context';
import { FileTreeService } from '../src/services/filetree';
import {
  PermissionError,
  PermissionService,
  type Policy,
  type Principal,
} from '../src/services/permissions';
import type { Edit } from '../src/services/transactions';
import { WorkspaceService } from '../src/services/workspace';

const agent: Principal = { kind: 'agent', sessionId: 's1', label: 'Test agent' };

const policy = (rules: Policy['rules'], fallback: Policy['fallback'] = 'deny'): Policy => ({
  fallback,
  rules,
});

async function setup() {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w/src/ui');
  platform.seedFile('/w/README.md', '# Project\n');
  platform.seedFile('/w/src/main.ts', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  platform.seedFile('/w/src/ui/panel.ts', 'export const panel = 1;\n');

  const workspace = new WorkspaceService(platform, () => history());
  const files = new FileTreeService(platform);
  const context = new ContextService(workspace, files);

  await workspace.openFolder('/w');
  await files.setRoot('/w');
  // `setRoot` starts the quick-open index without waiting for it; the tree
  // reads that index, so the test has to let it finish.
  await files.buildIndex();
  return { platform, workspace, files, context };
}

describe('reading buffers', () => {
  it('summarises what is open, with the revision to build on', async () => {
    const { workspace, context } = await setup();
    const id = (await workspace.open('/w/src/main.ts'))!;

    const [buffer] = context.openBuffers();
    expect(buffer).toMatchObject({
      id,
      path: '/w/src/main.ts',
      name: 'main.ts',
      languageId: 'typescript',
      isDirty: false,
      lineCount: 4,
      isActive: true,
    });
    expect(buffer!.revision).toBe(workspace.revisionOf(id));
  });

  it('returns text, whole or by line range', async () => {
    const { workspace, context } = await setup();
    const id = (await workspace.open('/w/src/main.ts'))!;

    expect(context.bufferText(id)).toBe('const a = 1;\nconst b = 2;\nconst c = 3;\n');
    expect(context.bufferText(id, { lines: { from: 2, to: 3 } })).toBe(
      'const b = 2;\nconst c = 3;',
    );
  });

  it('numbers lines so a caller can point at one', async () => {
    const { workspace, context } = await setup();
    const id = (await workspace.open('/w/src/main.ts'))!;

    expect(context.bufferText(id, { lines: { from: 1, to: 2 }, withLineNumbers: true })).toBe(
      '1\tconst a = 1;\n2\tconst b = 2;',
    );
  });

  it('clamps a line range rather than failing on it', async () => {
    const { workspace, context } = await setup();
    const id = (await workspace.open('/w/README.md'))!;

    expect(context.bufferText(id, { lines: { from: 0, to: 999 } })).toBe('# Project\n');
    expect(context.bufferText(id, { lines: { from: 9, to: 2 } })).toBe('');
  });

  it('reports the selection with line numbers and the selected text', async () => {
    const { workspace, context } = await setup();
    const id = (await workspace.open('/w/src/main.ts'))!;
    workspace.setSelection(id, { ranges: [[13, 25]], main: 0 });

    const selection = context.selection(id)!;
    expect(selection.isEmpty).toBe(false);
    expect(selection.ranges[0]).toMatchObject({ from: 13, to: 25, fromLine: 2, toLine: 2 });
    expect(selection.ranges[0]!.text).toBe('const b = 2;');
  });

  it('answers null for a buffer that is not open', async () => {
    const { context } = await setup();
    expect(context.bufferText('buf-nope')).toBeNull();
    expect(context.selection('buf-nope')).toBeNull();
  });

  it('reports no viewport for a buffer nothing is showing', async () => {
    const { workspace, context } = await setup();
    const id = (await workspace.open('/w/src/main.ts'))!;

    // "Open" and "on screen" are different questions, and with no editor
    // attached the honest answer to the second one is nothing.
    expect(context.viewport(id)).toBeNull();
  });

  it('reports the viewport the editor provides', async () => {
    const { workspace, files } = await setup();
    const context = new ContextService(workspace, files, () => ({ from: 4, to: 40 }));
    const id = (await workspace.open('/w/src/main.ts'))!;

    expect(context.viewport(id)).toEqual({ from: 4, to: 40 });
  });
});

describe('reading the workspace', () => {
  it('builds a tree from the indexed files', async () => {
    const { context } = await setup();
    const tree = context.workspaceTree();

    expect(tree.root).toBe('/w');
    expect(tree.fileCount).toBe(3);
    expect(tree.nodes.map((node) => node.name).sort()).toEqual(['README.md', 'src']);

    const src = tree.nodes.find((node) => node.name === 'src')!;
    expect(src.kind).toBe('directory');
    expect(src.children!.map((child) => child.name).sort()).toEqual(['main.ts', 'ui']);
    expect(src.path).toBe('/w/src');
  });

  it('limits directory depth when asked', async () => {
    const { context } = await setup();
    const src = context.workspaceTree({ depth: 1 }).nodes.find((n) => n.name === 'src')!;

    // main.ts is a file at the limit and still appears; the `ui` directory
    // below it does not, because a tree of empty folders answers nothing.
    expect(src.children!.map((child) => child.name)).toEqual(['main.ts']);
  });

  it('reports recent transactions with their author', async () => {
    const { workspace, context } = await setup();
    const id = (await workspace.open('/w/src/main.ts'))!;
    workspace.apply({
      description: 'Rename a thing',
      author: agent,
      edits: [{ bufferId: id, changes: { from: 0, insert: '// x\n' } }],
    });

    expect(context.recentTransactions(5)).toMatchObject([
      { description: 'Rename a thing', author: agent, bufferIds: [id] },
    ]);
  });
});

describe('nothing live escapes', () => {
  it('returns only data that survives serialisation', async () => {
    const { workspace, context } = await setup();
    const id = (await workspace.open('/w/src/main.ts'))!;
    workspace.setSelection(id, { ranges: [[0, 5]], main: 0 });
    workspace.apply({
      description: 'Something',
      author: agent,
      edits: [{ bufferId: id, changes: { from: 0, insert: '//\n' } }],
    });

    const snapshot = {
      buffers: context.openBuffers(),
      selection: context.selection(id),
      tree: context.workspaceTree(),
      transactions: context.recentTransactions(5),
    };

    // A caller that could reach a Buffer or an EditorState could mutate it
    // behind the permission model. Round-tripping proves there is no handle
    // hidden in here — a class instance would not survive equal.
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('copies the buffer list rather than sharing the array in the log', async () => {
    const { workspace, context } = await setup();
    const id = (await workspace.open('/w/src/main.ts'))!;
    workspace.apply({
      description: 'Something',
      author: agent,
      edits: [{ bufferId: id, changes: { from: 0, insert: '//\n' } }],
    });

    context.recentTransactions(1)[0]!.bufferIds.push('buf-injected');
    expect(workspace.log.recent(1)[0]!.bufferIds).toEqual([id]);
  });
});

describe('the read log', () => {
  it('records every read a non-user principal makes', async () => {
    const { workspace, context } = await setup();
    const id = (await workspace.open('/w/src/main.ts'))!;
    const reader = context.reader(agent);

    reader.openBuffers();
    reader.bufferText(id);
    reader.selection(id);

    expect(context.reads.get().map((read) => [read.method, read.target])).toEqual([
      ['openBuffers', undefined],
      ['bufferText', id],
      ['selection', id],
    ]);
    expect(context.reads.get().every((read) => read.principal === agent)).toBe(true);
  });

  it('does not record the user', async () => {
    const { context } = await setup();
    context.reader({ kind: 'user' }).openBuffers();
    expect(context.reads.get()).toEqual([]);
  });

  it('leaves the log alone for reads that bypass a reader', async () => {
    const { context } = await setup();
    // The service methods are the UI's path; only `reader()` is an audit trail.
    context.openBuffers();
    expect(context.reads.get()).toEqual([]);
  });
});

describe('an agent, end to end', () => {
  /**
   * The whole platform in one test: read through the context API, propose a
   * change set against the revisions that were read, go through the command
   * dispatcher under a policy, and be attributable afterwards.
   */
  async function agentSetup() {
    const base = await setup();
    const permissions = new PermissionService(() => base.workspace.rootPath.get());
    const commands = new CommandRegistry();

    commands.setGuard(async (command, principal, resource) => {
      for (const capability of command.capabilities ?? []) {
        await permissions.require({
          principal,
          capability,
          ...(resource ? { resource } : {}),
        });
      }
    });

    /** What the agent actually calls. Its only way to change anything. */
    const applyEdits: Command = {
      id: 'agent.applyEdits',
      title: 'Apply Agent Edits',
      capabilities: ['buffer.edit'],
      run: (arg) => {
        const proposal = arg as { edits: Edit[]; baseRevisions: Map<string, number> };
        return base.workspace.apply({
          description: 'Uppercase the first line',
          author: agent,
          edits: proposal.edits,
          baseRevisions: proposal.baseRevisions,
        });
      },
    };
    commands.register(applyEdits);

    return { ...base, permissions, commands };
  }

  /** Reads context, then proposes an edit built from what it read. */
  function propose(context: ContextService, principal: Principal) {
    const reader = context.reader(principal);
    const target = reader.openBuffers().find((buffer) => buffer.path?.endsWith('main.ts'));
    if (!target) throw new Error('nothing to edit');

    const firstLine = reader.bufferText(target.id, { lines: { from: 1, to: 1 } })!;
    return {
      edits: [
        { bufferId: target.id, changes: { from: 0, to: firstLine.length, insert: firstLine.toUpperCase() } },
      ] as Edit[],
      baseRevisions: new Map([[target.id, target.revision]]),
    };
  }

  it('reads, proposes, and is refused when it may not edit', async () => {
    const { workspace, context, permissions, commands } = await agentSetup();
    await workspace.open('/w/src/main.ts');
    permissions.setPolicy(agent, policy({ 'buffer.edit': 'deny' }));

    const proposal = propose(context, agent);
    await expect(
      commands.execute('agent.applyEdits', proposal, { principal: agent }),
    ).rejects.toThrow(PermissionError);

    expect(workspace.textOf(workspace.findByPath('/w/src/main.ts')!.id)).toBe(
      'const a = 1;\nconst b = 2;\nconst c = 3;\n',
    );
  });

  it('reads, proposes, applies, and leaves a trail on both sides', async () => {
    const { workspace, context, permissions, commands } = await agentSetup();
    const id = (await workspace.open('/w/src/main.ts'))!;
    permissions.setPolicy(agent, policy({ 'buffer.edit': 'allow' }));

    const proposal = propose(context, agent);
    expect(await commands.execute('agent.applyEdits', proposal, { principal: agent })).toBe(true);

    expect(workspace.textOf(id)).toBe('CONST A = 1;\nconst b = 2;\nconst c = 3;\n');

    // What it looked at...
    expect(context.reads.get().map((read) => read.method)).toEqual(['openBuffers', 'bufferText']);
    // ...what it changed, and that it was the agent...
    const [entry] = workspace.log.recent(1);
    expect(entry).toMatchObject({ author: agent, bufferIds: [id] });
    // ...and that it was permitted, on the record.
    expect(permissions.decisions.get().at(-1)).toMatchObject({
      capability: 'buffer.edit',
      granted: true,
    });

    // One step takes the whole thing back.
    workspace.undoChangeSet(entry!.id);
    expect(workspace.textOf(id)).toBe('const a = 1;\nconst b = 2;\nconst c = 3;\n');
  });

  it('is refused when the buffer moved between reading and proposing', async () => {
    const { workspace, context, permissions, commands } = await agentSetup();
    const id = (await workspace.open('/w/src/main.ts'))!;
    permissions.setPolicy(agent, policy({ 'buffer.edit': 'allow' }));

    const proposal = propose(context, agent);
    // The user types while the agent is still thinking.
    workspace.applyTransaction(
      id,
      workspace.stateOf(id)!.update({ changes: { from: 0, insert: '// mine\n' } }),
    );

    const result = await commands
      .execute('agent.applyEdits', proposal, { principal: agent })
      .then(() => workspace.log.recent(1));

    // Permitted, but stale — the revision it read is the thing that saves the
    // user's keystrokes here, not the permission check.
    expect(result).toEqual([]);
    expect(workspace.textOf(id)).toBe('// mine\nconst a = 1;\nconst b = 2;\nconst c = 3;\n');
  });
});

describe('paths from a Windows platform', () => {
  it('builds a real tree from backslash-separated paths', async () => {
    const { workspace, files, context } = await setup();
    workspace.rootPath.set('C:\\work');
    files.fileIndex.set(['C:\\work\\src\\main.ts', 'C:\\work\\README.md']);

    const tree = context.workspaceTree();
    const src = tree.nodes.find((node) => node.name === 'src');

    // Splitting on `/` alone made every file one flat node whose name was the
    // whole relative path.
    expect(src?.kind).toBe('directory');
    expect(src?.path).toBe('C:\\work\\src');
    expect(src?.children?.map((child) => child.name)).toEqual(['main.ts']);
    expect(tree.nodes.map((node) => node.name).sort()).toEqual(['README.md', 'src']);
  });
});

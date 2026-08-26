import { describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';

/**
 * Asking for code actions, and where the answer lands.
 *
 * The core reader has its own tests; these are the two decisions above it:
 * what goes out in the request, and the rule that one file is applied while
 * more than one is staged.
 *
 * No server and no process — `LspService.requestFor` is replaced on the
 * instance, which is the same seam `editor/completion.ts` takes as a
 * parameter. See
 * `docs/superpowers/specs/2026-08-22-lsp-code-actions-design.md`.
 */

interface Asked {
  method: string;
  params: Record<string, unknown>;
}

async function appWith(
  respond: (method: string, params: unknown) => unknown,
  files: Record<string, string> = { '/w/a.ts': 'const a = 1;\nconst b = 2;\n' },
): Promise<{ app: NoxApp; asked: Asked[]; platform: MemoryPlatform }> {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w');
  for (const [path, body] of Object.entries(files)) platform.seedFile(path, body);

  const app = new NoxApp(platform);
  await app.workspace.openFolder('/w');
  await app.workspace.open('/w/a.ts');

  const asked: Asked[] = [];
  // The language server, stood in for at the one method the feature uses.
  app.lsp.requestFor = (async (_language: string, method: string, params: unknown) => {
    asked.push({ method, params: params as Record<string, unknown> });
    return respond(method, params);
  }) as typeof app.lsp.requestFor;
  app.lsp.capabilitiesFor = (() => ({ codeActionProvider: true }));

  return { app, asked, platform };
}

const edit = (uri: string, line: number, from: number, to: number, newText: string) => ({
  changes: {
    [uri]: [
      { range: { start: { line, character: from }, end: { line, character: to } }, newText },
    ],
  },
});

/** Drive the command the way a keypress would. */
async function ask(app: NoxApp): Promise<void> {
  await app.commands.execute('lsp.codeAction');
}

describe('the request', () => {
  /**
   * The part that is easiest to leave out and most load-bearing:
   * `context.diagnostics` is what a server keys its quick fixes off. Send
   * none and tsserver answers with refactors only, so "no quick fix here"
   * would be Nox's fault rather than the server's.
   */
  it('sends the diagnostics that overlap the caret, and no others', async () => {
    const { app, asked } = await appWith(() => []);
    const uri = 'file:///w/a.ts';
    app.lsp.diagnostics.set(
      new Map([
        [
          uri,
          [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, message: 'here' },
            { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, message: 'elsewhere' },
          ],
        ],
      ]),
    );

    await ask(app);

    const context = asked[0]!.params.context as { diagnostics: { message: string }[] };
    expect(asked[0]!.method).toBe('textDocument/codeAction');
    expect(context.diagnostics.map((d) => d.message)).toEqual(['here']);
  });

  it('sends the selection as the range', async () => {
    const { app, asked } = await appWith(() => []);
    const id = app.workspace.activeId.get()!;
    app.workspace.setSelection(id, { ranges: [[0, 11]], main: 0 });

    await ask(app);

    expect(asked[0]!.params.range).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 11 },
    });
  });

  it('says so rather than opening an empty picker', async () => {
    const { app } = await appWith(() => []);

    await ask(app);

    expect(app.ui.overlay.get()).toBeNull();
  });

  it('does not open the picker when the server errors', async () => {
    const { app } = await appWith(() => {
      throw new Error('server is unwell');
    });

    await ask(app);

    expect(app.ui.overlay.get()).toBeNull();
  });
});

describe('choosing an action', () => {
  it('applies a one-file edit straight into the buffer', async () => {
    const { app } = await appWith(() => [
      { title: 'Make it three', kind: 'quickfix', edit: edit('file:///w/a.ts', 0, 10, 11, '3') },
    ]);

    await ask(app);
    expect(app.ui.overlay.get()).toBe('code-action');
    expect(app.ui.codeActions.get().map((a) => a.title)).toEqual(['Make it three']);

    await app.applyCodeAction(0);

    const id = app.workspace.activeId.get()!;
    expect(app.workspace.textOf(id)).toBe('const a = 3;\nconst b = 2;\n');
    // Directly, not through review: a fix at your own caret is not a proposal.
    expect(app.review.staged.get()).toBeNull();
  });

  /**
   * One transaction, so one ⌘Z takes the whole fix back — a fix that undid in
   * pieces would be worse than one that never applied.
   *
   * Counted by revision rather than driven through undo: undo is the editor's
   * path and wants an `EditorView`, while the revision moves once per
   * transaction and is exactly what is being claimed.
   */
  it('applies as a single transaction, and leaves the buffer dirty', async () => {
    const { app } = await appWith(() => [
      { title: 'Make it three', edit: edit('file:///w/a.ts', 0, 10, 11, '3') },
    ]);
    await ask(app);

    const id = app.workspace.activeId.get()!;
    const before = app.workspace.revisionOf(id);
    await app.applyCodeAction(0);

    expect(app.workspace.revisionOf(id)).toBe(before + 1);
    expect(app.workspace.buffers.get().find((b) => b.id === id)?.isDirty).toBe(true);
  });

  /**
   * A change reaching files you have not opened is exactly what review is
   * for, and it is the shape rename already produces.
   */
  it('stages an edit that reaches a second file', async () => {
    const { app } = await appWith(
      () => [
        {
          title: 'Fix both',
          edit: {
            changes: {
              'file:///w/a.ts': [
                { range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } }, newText: '3' },
              ],
              'file:///w/b.ts': [
                { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'Z' },
              ],
            },
          },
        },
      ],
      { '/w/a.ts': 'const a = 1;\nconst b = 2;\n', '/w/b.ts': 'x\n' },
    );

    await ask(app);
    await app.applyCodeAction(0);

    expect(app.review.staged.get()).not.toBeNull();
    // Nothing has been written yet: review is the point.
    const a = app.workspace.buffers.get().find((b) => b.name === 'a.ts')!;
    expect(app.workspace.textOf(a.id)).toBe('const a = 1;\nconst b = 2;\n');
  });

  /**
   * The picker is open in between, and while the overlay has focus the user
   * cannot type — but an external change still can. Project replace's rule: a
   * computed edit is refused rather than applied to a buffer that moved.
   */
  it('refuses when the buffer moved after the server answered', async () => {
    const { app } = await appWith(() => [
      { title: 'Make it three', edit: edit('file:///w/a.ts', 0, 10, 11, '3') },
    ]);
    await ask(app);

    const id = app.workspace.activeId.get()!;
    app.workspace.applyTransaction(
      id,
      app.workspace.stateOf(id)!.update({ changes: { from: 0, insert: '// later\n' } }),
    );

    await app.applyCodeAction(0);

    expect(app.workspace.textOf(id)).toBe('// later\nconst a = 1;\nconst b = 2;\n');
  });

  it('sends the command for an action that carries one', async () => {
    const { app, asked } = await appWith(() => [
      { title: 'Organize imports', command: 'typescript.organizeImports', arguments: ['/w/a.ts'] },
    ]);
    app.lsp.capabilitiesFor = (() => ({
      codeActionProvider: true,
      executeCommandProvider: {},
    }));
    await ask(app);

    expect(app.ui.codeActions.get()[0]).toMatchObject({ runnable: true });

    await app.applyCodeAction(0);

    // Nox edits nothing itself here: the server does the work and asks back
    // with `workspace/applyEdit`, which is a separate arrival.
    const executed = asked.find((entry) => entry.method === 'workspace/executeCommand');
    expect(executed?.params).toEqual({
      command: 'typescript.organizeImports',
      arguments: ['/w/a.ts'],
    });
  });

  /**
   * A server that registered no commands cannot run one, and saying so beats
   * sending a request it is bound to refuse.
   */
  it('refuses a command when the server does not run commands', async () => {
    const { app, asked } = await appWith(() => [
      { title: 'Organize imports', command: 'typescript.organizeImports' },
    ]);
    await ask(app);
    await app.applyCodeAction(0);

    expect(asked.some((entry) => entry.method === 'workspace/executeCommand')).toBe(false);
  });

  /**
   * Listed, not hidden. Hiding what Nox cannot run would say the server
   * offered nothing where it offered something unbuilt, and the user would
   * blame their language server.
   */
  it('offers a command-only action as runnable', async () => {
    const { app } = await appWith(() => [
      { title: 'Organize imports', command: 'typescript.organizeImports' },
    ]);

    await ask(app);

    expect(app.ui.overlay.get()).toBe('code-action');
    expect(app.ui.codeActions.get()[0]).toMatchObject({ runnable: true, reason: undefined });
  });

  /** One offer, one apply: a second click cannot replay the first. */
  it('cannot be applied twice', async () => {
    const { app } = await appWith(() => [
      { title: 'Make it three', edit: edit('file:///w/a.ts', 0, 10, 11, '3') },
    ]);
    await ask(app);

    await app.applyCodeAction(0);
    await app.applyCodeAction(0);

    const id = app.workspace.activeId.get()!;
    expect(app.workspace.textOf(id)).toBe('const a = 3;\nconst b = 2;\n');
  });
});

describe('the command itself', () => {
  it('is disabled when the server offers no code actions', async () => {
    const { app } = await appWith(() => []);
    app.lsp.capabilitiesFor = (() => ({}));

    expect(app.commands.isEnabled('lsp.codeAction')).toBe(false);
  });

  it('is enabled when it does', async () => {
    const { app } = await appWith(() => []);
    expect(app.commands.isEnabled('lsp.codeAction')).toBe(true);
  });
});

/**
 * `workspace/applyEdit` — the server asking Nox to change files, on its own
 * initiative, usually as the second half of a command it was told to run.
 *
 * The rule is the same one code actions use, and that is the point: whether a
 * server may write to a file you have not opened is one question, and having
 * two answers to it depending on which message carried the edit is how one of
 * them ends up wrong.
 */
describe('an edit the server asks for', () => {
  const twoFiles = {
    '/w/a.ts': 'const a = 1;\nconst b = 2;\n',
    '/w/b.ts': 'const c = 3;\n',
  };

  it('lands directly when it reaches one file', async () => {
    const { app } = await appWith(() => [], twoFiles);

    const applied = await app.applyServerEdit(edit('file:///w/a.ts', 0, 10, 11, '9'), 'tsserver');

    expect(applied).toBe(true);
    const id = app.workspace.findByPath('/w/a.ts')!.id;
    expect(app.workspace.textOf(id)).toBe('const a = 9;\nconst b = 2;\n');
    // Nothing to review: a change to the file in front of you is not a proposal.
    expect(app.review.staged.get()).toBeNull();
  });

  it('stages when it reaches more than one', async () => {
    const { app } = await appWith(() => [], twoFiles);

    const applied = await app.applyServerEdit(
      {
        changes: {
          'file:///w/a.ts': [
            { range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } }, newText: '9' },
          ],
          'file:///w/b.ts': [
            { range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } }, newText: '9' },
          ],
        },
      },
      'tsserver',
    );

    expect(applied).toBe(true);
    expect(app.review.staged.get()).not.toBeNull();
    // Staged, not written: the buffers still hold what they held.
    const id = app.workspace.findByPath('/w/a.ts')!.id;
    expect(app.workspace.textOf(id)).toBe('const a = 1;\nconst b = 2;\n');
  });

  /**
   * Rename's rule, and the reply the server needs. `applied: false` is acted
   * on — several servers report it or roll back their own state — so a refusal
   * has to come back as a refusal rather than as a silent no-op.
   */
  it('refuses a file operation, and says so on the wire', async () => {
    const { app } = await appWith(() => [], twoFiles);

    const applied = await app.applyServerEdit(
      { documentChanges: [{ kind: 'rename', oldUri: 'file:///w/a.ts', newUri: 'file:///w/z.ts' }] },
      'tsserver',
    );

    expect(applied).toBe(false);
    expect(app.notifications.items.get().some((n) => /does not make/i.test(n.message))).toBe(true);
  });

  it('refuses an edit it could not read, rather than reporting success', async () => {
    const { app } = await appWith(() => [], twoFiles);

    expect(await app.applyServerEdit({}, 'tsserver')).toBe(false);
    expect(await app.applyServerEdit(undefined, 'tsserver')).toBe(false);
    expect(app.notifications.items.get().some((n) => /could not read/i.test(n.message))).toBe(true);
  });

  it('names the server in what it tells the user', async () => {
    const { app } = await appWith(() => [], twoFiles);
    await app.applyServerEdit({}, 'rust-analyzer');
    expect(app.notifications.items.get()[0]?.message).toMatch(/rust-analyzer/);
  });
});

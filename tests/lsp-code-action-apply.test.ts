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
  app.lsp.capabilitiesFor = (() => ({ codeActionProvider: true })) as typeof app.lsp.capabilitiesFor;

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

  it('does nothing for an action it said it could not run', async () => {
    const { app } = await appWith(() => [
      { title: 'Organize imports', command: 'typescript.organizeImports' },
    ]);
    await ask(app);

    expect(app.ui.codeActions.get()[0]).toMatchObject({ runnable: false });

    await app.applyCodeAction(0);

    const id = app.workspace.activeId.get()!;
    expect(app.workspace.textOf(id)).toBe('const a = 1;\nconst b = 2;\n');
  });

  /**
   * Listed, not hidden. Hiding what Nox cannot run would say the server
   * offered nothing where it offered something unbuilt, and the user would
   * blame their language server.
   */
  it('offers a command-only action rather than pretending there was none', async () => {
    const { app } = await appWith(() => [
      { title: 'Organize imports', command: 'typescript.organizeImports' },
    ]);

    await ask(app);

    expect(app.ui.overlay.get()).toBe('code-action');
    expect(app.ui.codeActions.get()[0]?.reason).toMatch(/command/i);
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
    app.lsp.capabilitiesFor = (() => ({})) as typeof app.lsp.capabilitiesFor;

    expect(app.commands.isEnabled('lsp.codeAction')).toBe(false);
  });

  it('is enabled when it does', async () => {
    const { app } = await appWith(() => []);
    expect(app.commands.isEnabled('lsp.codeAction')).toBe(true);
  });
});

// @vitest-environment jsdom
import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { createLspCompletionSource, type CompletionDeps } from '../src/editor/completion';
import type { LspCompletionItem } from '../src/core/lsp-completion';
import { installRangeRects } from './support/jsdom-layout';

installRangeRects();

/**
 * Auto-imports: `additionalTextEdits` on a completion.
 *
 * The defect these cover is silent wrong output rather than a missing
 * feature — accepting `readFileSync` inserted the symbol and dropped the
 * `import` the server had already computed, so the completion appeared to
 * work and produced code that does not compile.
 *
 * Driven through a real `EditorView`, because `apply` is a callback CodeMirror
 * invokes with a view and the transaction it dispatches is the thing under
 * test. jsdom has no layout, and nothing below claims anything geometric.
 *
 * See `docs/superpowers/specs/2026-08-22-completion-additional-edits-design.md`.
 */

const DOC = 'const x = 1;\nread\n';
/** End of `read` on line 2 — a word being typed, so the source asks. */
const CURSOR = 17;

/** The import a server would add at the very top. */
const IMPORT = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  newText: "import { readFileSync } from 'fs';\n",
};

interface Options {
  resolveProvider?: boolean;
  listEdits?: unknown;
  resolveEdits?: unknown;
  resolveRejects?: boolean;
  resolveGate?: Promise<void>;
}

function deps(options: Options = {}): { deps: CompletionDeps; count: { resolves: number } } {
  const state = { resolves: 0 };
  const item: LspCompletionItem = {
    label: 'readFileSync',
    kind: 3,
    ...(options.listEdits !== undefined
      ? { additionalTextEdits: options.listEdits }
      : {}),
  };

  const d: CompletionDeps = {
    lsp: {
      capabilitiesFor: () => ({
        completionProvider: {
          triggerCharacters: ['.'],
          resolveProvider: options.resolveProvider ?? false,
        },
      }),
      requestFor: async <T,>(_language: string, method: string): Promise<T> => {
        if (method === 'completionItem/resolve') {
          state.resolves++;
          if (options.resolveGate) await options.resolveGate;
          if (options.resolveRejects) throw new Error('server said no');
          return {
            ...item,
            ...(options.resolveEdits !== undefined
              ? { additionalTextEdits: options.resolveEdits }
              : {}),
          } as T;
        }
        return { items: [item] } as T;
      },
    },
    documentOf: () => ({ uri: 'file:///w/main.ts', languageId: 'typescript' }),
  };

  return { deps: d, count: state };
}

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

/** Run the source, then accept the first option through a live view. */
async function accept(
  d: CompletionDeps,
  doc = DOC,
  cursor = CURSOR,
  edit?: (v: EditorView) => void,
): Promise<EditorView> {
  const context = new CompletionContext(EditorState.create({ doc }), cursor, false);
  const result = await createLspCompletionSource(d)(context);
  const option = result!.options[0]!;

  view = new EditorView({ state: EditorState.create({ doc }) });
  view.dispatch({ selection: { anchor: cursor } });
  // Anything the user does between the request and pressing Enter.
  edit?.(view);

  const from = result!.from;
  const to = cursor;
  if (typeof option.apply === 'function') option.apply(view, option, from, to);
  else view.dispatch({ changes: { from, to, insert: option.apply ?? option.label } });

  return view;
}

/** Let a resolve that was started during `apply` settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a completion whose server sent the import in the list', () => {
  it('inserts the import along with the symbol', async () => {
    const { deps: d } = deps({ listEdits: [IMPORT] });

    const v = await accept(d);

    expect(v.state.doc.toString()).toBe(
      "import { readFileSync } from 'fs';\nconst x = 1;\nreadFileSync\n",
    );
  });

  /**
   * One ⌘Z takes back both. A symbol without its import is not a state the
   * user asked for, so it must not be a state undo can stop at.
   */
  it('puts both in one transaction', async () => {
    const { deps: d } = deps({ listEdits: [IMPORT] });

    /** Inserted ranges per document-changing transaction, in order. */
    const seen: number[] = [];
    const context = new CompletionContext(EditorState.create({ doc: DOC }), CURSOR, false);
    const result = await createLspCompletionSource(d)(context);
    const option = result!.options[0]!;

    view = new EditorView({
      state: EditorState.create({ doc: DOC }),
      dispatchTransactions: (transactions, instance) => {
        for (const transaction of transactions) {
          if (!transaction.docChanged) continue;
          let ranges = 0;
          transaction.changes.iterChanges(() => {
            ranges++;
          });
          seen.push(ranges);
        }
        instance.update(transactions);
      },
    });
    (option.apply as (v: EditorView, c: unknown, f: number, t: number) => void)(
      view,
      option,
      result!.from,
      CURSOR,
    );

    // One transaction, carrying both changes — the import and the symbol.
    // Counting the changes matters as much as counting the transactions: a
    // version that dropped the import entirely would also dispatch exactly
    // one.
    expect(seen).toEqual([2]);
  });

  it('asks for no resolve at all when the server offers none', async () => {
    const { deps: d, count } = deps({ listEdits: [IMPORT] });
    await accept(d);
    await settle();
    expect(count.resolves).toBe(0);
  });
});

describe('a completion whose server only sends the import on resolve', () => {
  /** tsserver is this shape: the list carries `data` and nothing else. */
  it('resolves and then inserts the import', async () => {
    const { deps: d } = deps({ resolveProvider: true, resolveEdits: [IMPORT] });

    const v = await accept(d);
    // The symbol is there immediately — the typing path never waits.
    expect(v.state.doc.toString()).toContain('readFileSync\n');

    await settle();
    expect(v.state.doc.toString()).toBe(
      "import { readFileSync } from 'fs';\nconst x = 1;\nreadFileSync\n",
    );
  });

  it('leaves the completion standing when the resolve fails', async () => {
    const { deps: d } = deps({ resolveProvider: true, resolveRejects: true });

    const v = await accept(d);
    await settle();

    expect(v.state.doc.toString()).toBe('const x = 1;\nreadFileSync\n');
  });

  it('does nothing extra when the resolve carries no edits', async () => {
    const { deps: d } = deps({ resolveProvider: true });

    const v = await accept(d);
    await settle();

    expect(v.state.doc.toString()).toBe('const x = 1;\nreadFileSync\n');
  });

  /**
   * The offsets are in the coordinates of the document the *request* was made
   * against, and the list is filtered locally while the user keeps typing —
   * so by the time the edits arrive the document has moved. Everything the
   * user typed is after an import at the top, which is why the guard is a
   * prefix compare rather than a refusal to move at all.
   */
  it('still lands when the user typed more after the request', async () => {
    const { deps: d } = deps({ resolveProvider: true, resolveEdits: [IMPORT] });

    const v = await accept(d, DOC, CURSOR, (live) => {
      live.dispatch({ changes: { from: CURSOR, insert: 'F' }, selection: { anchor: CURSOR + 1 } });
    });
    await settle();

    expect(v.state.doc.toString()).toContain("import { readFileSync } from 'fs';\n");
  });

  /**
   * …and is dropped, not guessed at, when the text the offsets refer to has
   * itself changed. The same call `undoLastReplace` and rename make: when the
   * world has moved, refuse rather than write at a position that now means
   * something else.
   */
  it('drops the import when the text above the cursor has changed', async () => {
    const { deps: d } = deps({
      resolveProvider: true,
      // An edit that replaces the whole of line 1, which the user is about to
      // change out from under it.
      resolveEdits: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } },
          newText: 'const x = 2;',
        },
      ],
    });

    // Length-preserving on purpose: CodeMirror maps `from`/`to` through
    // intervening changes before it calls `apply`, and `accept` above does
    // not, so a test that shifted them would be testing the harness.
    const v = await accept(d, DOC, CURSOR, (live) => {
      live.dispatch({ changes: { from: 10, to: 11, insert: '9' } });
    });
    await settle();

    // The user's own edit stands, and the server's stale one never landed.
    expect(v.state.doc.toString()).toContain('const x = 9;');
    expect(v.state.doc.toString()).not.toContain('const x = 2;');
  });
});

describe('edits the server got wrong', () => {
  it('drops anything that is not a well-formed edit', async () => {
    const { deps: d } = deps({
      listEdits: [{ range: { start: { line: 0 } }, newText: 'bad' }, IMPORT, null, 7],
    });

    const v = await accept(d);

    expect(v.state.doc.toString()).toBe(
      "import { readFileSync } from 'fs';\nconst x = 1;\nreadFileSync\n",
    );
  });

  it('ignores a field that is not an array', async () => {
    const { deps: d } = deps({ listEdits: 'nope' });

    const v = await accept(d);

    expect(v.state.doc.toString()).toBe('const x = 1;\nreadFileSync\n');
  });
});

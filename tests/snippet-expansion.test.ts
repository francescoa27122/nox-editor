// @vitest-environment jsdom
import {
  acceptCompletion,
  completionStatus,
  nextSnippetField,
  startCompletion,
} from '@codemirror/autocomplete';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snippet } from '../src/core/snippets';
import { completionExtension, type CompletionDeps } from '../src/editor/completion';
import type { LspCompletionItem } from '../src/core/lsp-completion';

/**
 * Snippets, expanded.
 *
 * Everything here runs the real picker and the real snippet lifecycle, because
 * the parts that break are the ones a structural test cannot see: which
 * transaction the text lands in, where the cursor stops, and whether Tab is
 * still doing the other two jobs it has.
 */

const AFTER_INTERACTION_DELAY = 120;

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

function deps(options: {
  item?: LspCompletionItem;
  snippets?: Snippet[];
  capabilities?: Record<string, unknown> | null;
}): CompletionDeps {
  return {
    lsp: {
      capabilitiesFor: () =>
        options.item ? (options.capabilities ?? { completionProvider: {} }) : null,
      requestFor: async <T,>(): Promise<T> =>
        ({ items: options.item ? [options.item] : [] }) as T,
    },
    documentOf: () => ({ uri: 'file:///w/main.ts', languageId: 'typescript' }),
    snippets: () => options.snippets ?? [],
  };
}

function mount(doc: string, extensions: Extension[]): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({ doc, selection: { anchor: doc.length }, extensions }),
  });
  return view;
}

/** Open the picker, wait past the guard, and take the highlighted option. */
async function accept(editor: EditorView): Promise<void> {
  startCompletion(editor);
  await vi.waitFor(() => expect(completionStatus(editor.state)).toBe('active'));
  await new Promise((resolve) => setTimeout(resolve, AFTER_INTERACTION_DELAY));
  acceptCompletion(editor);
}

describe('a snippet from the language server', () => {
  const item: LspCompletionItem = {
    label: 'log',
    kind: 15,
    insertTextFormat: 2,
    insertText: 'console.log(${1:value})$0',
  };

  it('expands its template instead of inserting the placeholder text', async () => {
    const editor = mount('lo', [completionExtension(deps({ item }))]);
    await accept(editor);

    // Before snippet support this wrote `console.log(value)` with the cursor
    // at the end — the placeholder flattened to its default and nothing to
    // Tab between.
    expect(editor.state.doc.toString()).toBe('console.log(value)');
  });

  it('leaves the first field selected, so typing replaces it', async () => {
    const editor = mount('lo', [completionExtension(deps({ item }))]);
    await accept(editor);

    const { from, to } = editor.state.selection.main;
    expect(editor.state.doc.sliceString(from, to)).toBe('value');
  });

  it('moves to the final stop on Tab', async () => {
    const editor = mount('lo', [completionExtension(deps({ item }))]);
    await accept(editor);
    nextSnippetField(editor);

    // `$0` is after the closing paren, which is the whole point of writing it
    // there rather than letting the cursor sit inside the call.
    expect(editor.state.selection.main.head).toBe('console.log(value)'.length);
  });

  it('is one undo, not two', async () => {
    const editor = mount('lo', [completionExtension(deps({ item }))]);
    await accept(editor);

    expect(editor.state.doc.toString()).toBe('console.log(value)');
  });
});

describe('a completion that carries an auto-import', () => {
  /**
   * The bug this pins.
   *
   * `additionalTextEdits` and the completion were merged into one transaction
   * — right, and the reason ⌘Z takes both back together — but the selection
   * `insertCompletionText` computed was in the coordinates of a document with
   * only the completion in it. Merging an import above it moved everything
   * down and nothing moved the cursor with it, so **accepting a completion
   * from any server that sends its imports in the list left the cursor inside
   * the import line at the top of the file.** tsserver sends them on resolve
   * and dodged it; rust-analyzer, gopls and pyright do not.
   */
  const item: LspCompletionItem = {
    label: 'readFile',
    kind: 3,
    insertText: 'readFile',
    additionalTextEdits: [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: "import { readFile } from 'node:fs';\n",
      },
    ],
  };

  it('lands the cursor after the completion, not inside the import', async () => {
    const editor = mount('readF', [completionExtension(deps({ item }))]);
    await accept(editor);

    const text = editor.state.doc.toString();
    expect(text).toBe("import { readFile } from 'node:fs';\nreadFile");
    expect(editor.state.selection.main.head).toBe(text.length);
  });
});

describe('a snippet the user wrote', () => {
  const snippets: Snippet[] = [
    { prefix: 'gofor', body: 'for ${1:i} := range ${2:items} {\n\t$0\n}', description: 'range loop' },
  ];

  it('is offered with no language server anywhere', async () => {
    const editor = mount('gofo', [completionExtension(deps({ snippets }))]);
    await accept(editor);

    // Written with a tab, arriving as the buffer's indent unit: CodeMirror
    // re-indents a snippet's leading tabs on the way in, so one snippets file
    // serves a tabs project and a spaces one.
    expect(editor.state.doc.toString()).toBe('for i := range items {\n  \n}');
  });

  it('selects its first field and Tab reaches the second', async () => {
    const editor = mount('gofo', [completionExtension(deps({ snippets }))]);
    await accept(editor);

    const first = editor.state.selection.main;
    expect(editor.state.doc.sliceString(first.from, first.to)).toBe('i');

    nextSnippetField(editor);
    const second = editor.state.selection.main;
    expect(editor.state.doc.sliceString(second.from, second.to)).toBe('items');
  });

  it('is offered alongside a server rather than instead of it', async () => {
    const item: LspCompletionItem = { label: 'gofmt', kind: 3, insertText: 'gofmt' };
    const editor = mount('gof', [completionExtension(deps({ item, snippets }))]);

    startCompletion(editor);
    await vi.waitFor(() => expect(completionStatus(editor.state)).toBe('active'));

    const { currentCompletions } = await import('@codemirror/autocomplete');
    const labels = currentCompletions(editor.state).map((option) => option.label);
    expect(labels).toContain('gofor');
    expect(labels).toContain('gofmt');
  });
});

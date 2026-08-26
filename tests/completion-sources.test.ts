// @vitest-environment jsdom
import { completionStatus, currentCompletions, startCompletion } from '@codemirror/autocomplete';
import { html } from '@codemirror/lang-html';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WORD_COMPLETION_MAX_BYTES,
  completionExtension,
  type CompletionDeps,
} from '../src/editor/completion';

/**
 * Which sources answer, and when.
 *
 * The regression this guards is invisible to a structural test. The extension
 * used to be `autocompletion({ override: [lspSource] })`, and `override`
 * **replaces** the sources CodeMirror gathers from language data
 * (`@codemirror/autocomplete`, `index.cjs:894`) rather than adding to them —
 * so `@codemirror/lang-html`'s own tag completion was in the bundle, wired up,
 * and switched off. Asserting that the html source is registered would have
 * passed throughout. So every case here goes through the real picker and reads
 * what CodeMirror actually offered.
 */

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

/** Deps for a language with no server behind it. */
function noServer(languageId = 'plaintext'): CompletionDeps {
  return {
    lsp: {
      capabilitiesFor: () => null,
      requestFor: async <T,>(): Promise<T> => {
        throw new Error('no server should be asked');
      },
    },
    documentOf: () => ({ uri: `file:///w/main.${languageId}`, languageId }),
  };
}

/** Deps for a language whose server offers completion and answers with one item. */
function withServer(label: string): CompletionDeps {
  return {
    lsp: {
      capabilitiesFor: () => ({ completionProvider: { triggerCharacters: ['.'] } }),
      requestFor: async <T,>(): Promise<T> =>
        ({ items: [{ label, kind: 6, detail: '(from the server)' }] }) as T,
    },
    documentOf: () => ({ uri: 'file:///w/main.ts', languageId: 'typescript' }),
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

/** Open the picker and return the labels it holds. */
async function labelsFor(editor: EditorView): Promise<string[]> {
  startCompletion(editor);
  await vi.waitFor(() => expect(completionStatus(editor.state)).toBe('active'));
  return currentCompletions(editor.state).map((option) => option.label);
}

describe('a language that brings its own completions', () => {
  it('still offers them when no server is running', async () => {
    const editor = mount('<di', [html(), completionExtension(noServer('html'))]);

    // `div` comes from `@codemirror/lang-html`, which ships in the bundle and
    // was reachable only by deleting the override.
    expect(await labelsFor(editor)).toContain('div');
  });
});

describe('a language with neither a server nor a grammar source', () => {
  it('falls back to the words already in the document', async () => {
    const editor = mount('threshold = 1\nthres', [completionExtension(noServer())]);

    expect(await labelsFor(editor)).toContain('threshold');
  });

  it('offers nothing above the size the fallback will scan', async () => {
    // One word per line, so the document is large by bytes rather than by
    // being one pathological line.
    const filler = `${'threshold = 1\n'.repeat(Math.ceil(WORD_COMPLETION_MAX_BYTES / 14) + 1)}thres`;
    expect(filler.length).toBeGreaterThan(WORD_COMPLETION_MAX_BYTES);

    const editor = mount(filler, [completionExtension(noServer())]);

    startCompletion(editor);
    // Nothing to wait for: the source declines synchronously, so the picker
    // never becomes active. A word list here would be the regression.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(currentCompletions(editor.state).map((o) => o.label)).not.toContain('threshold');
  });
});

describe('a language whose server answers', () => {
  it('stands the word fallback down rather than mixing the two', async () => {
    const editor = mount('threshold = 1\nthres', [completionExtension(withServer('thresholdFor'))]);

    const labels = await labelsFor(editor);
    // The server's item is there...
    expect(labels).toContain('thresholdFor');
    // ...and the raw word is not, because a server item carries `detail` and
    // would not dedupe against it — the two would sit in the list together.
    expect(labels).not.toContain('threshold');
  });
});

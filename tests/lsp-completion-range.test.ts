// @vitest-environment jsdom
import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { createLspCompletionSource, type LspDeps } from '../src/editor/completion';
import type { LspCompletionItem } from '../src/core/lsp-completion';
import { installRangeRects } from './support/jsdom-layout';

installRangeRects();

/**
 * The range the server named, and who wins when it has gone stale.
 *
 * `toCodeMirrorCompletions` has always read `textEdit.range` into `from`/`to`
 * — "believed over any range the client would guess", says its comment, and
 * "ignoring it is how `console.log` becomes `console.console.log`", says its
 * test. **Nothing read the result.** The source inserted at the list-level
 * `from`, which is the start of the word CodeMirror's own `[\w$]+` matched,
 * and the two only usually agree.
 *
 * Driven through a real `EditorView`, because `apply` is a callback CodeMirror
 * invokes with one. jsdom has no layout and nothing here claims anything
 * geometric.
 */

/** A path being completed inside a string: the word is `ut`, the range is `src/ut`. */
const DOC = "const path = 'src/ut';\n";
/** Index of `s` in `src/ut` — where the server wants the replacement to begin. */
const RANGE_START = 14;
/** End of `ut`, where the caret is. */
const CURSOR = 20;
/** What CodeMirror's own word match would give: the start of `ut`. */
const WORD_START = 18;

function deps(textEdit?: unknown, insertText?: string): LspDeps {
  const item: LspCompletionItem = {
    label: 'REPLACED',
    kind: 17,
    ...(textEdit !== undefined ? { textEdit: textEdit as never } : {}),
    ...(insertText !== undefined ? { insertText } : {}),
  };
  return {
    lsp: {
      capabilitiesFor: () => ({ completionProvider: { triggerCharacters: ['/'] } }),
      requestFor: async <T,>(): Promise<T> => ({ items: [item] }) as T,
    },
    documentOf: () => ({ uri: 'file:///w/main.ts', languageId: 'typescript' }),
  };
}

/** The server naming `src/ut` — a range wider than the word CodeMirror sees. */
const WIDE_EDIT = {
  range: { start: { line: 0, character: RANGE_START }, end: { line: 0, character: CURSOR } },
  newText: 'REPLACED',
};

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

/**
 * Accept the first option, the way CodeMirror does.
 *
 * `before` stands in for anything that happened between the request and the
 * keypress. CodeMirror maps its `from`/`to` through exactly those changes
 * before calling `apply` (`ActiveResult.updateFor`, with assoc 1 on `to` so it
 * follows the caret), so this harness maps them too — a version that passed
 * the raw request-time numbers would be testing itself.
 */
async function accept(
  d: LspDeps,
  before?: (v: EditorView) => { from: number; to: number },
): Promise<string> {
  const context = new CompletionContext(EditorState.create({ doc: DOC }), CURSOR, false);
  const result = await createLspCompletionSource(d)(context);
  const option = result!.options[0]!;

  view = new EditorView({ state: EditorState.create({ doc: DOC }) });
  view.dispatch({ selection: { anchor: CURSOR } });

  let from = result!.from;
  let to = CURSOR;
  if (before) ({ from, to } = before(view));

  if (typeof option.apply === 'function') {
    option.apply(view, option, from, to);
  } else {
    view.dispatch({ changes: { from, to, insert: option.apply ?? option.label } });
  }
  return view.state.doc.toString();
}

describe('a server that names its own range', () => {
  it('replaces what the server asked for, not just the word', async () => {
    expect(await accept(deps(WIDE_EDIT))).toBe("const path = 'REPLACED';\n");
  });

  /**
   * The failure the core test's comment has described since the conversion was
   * written, finally reachable: inserting at the word start leaves the part of
   * the range before it in place.
   */
  it('does not leave the rest of the range behind', async () => {
    expect(await accept(deps(WIDE_EDIT))).not.toContain('src/REPLACED');
  });

  it('still uses the word when the server named no range', async () => {
    // `insertText` and no `textEdit`: CodeMirror's own `from` is all there is.
    expect(await accept(deps(undefined, 'REPLACED'))).toBe("const path = 'src/REPLACED';\n");
  });
});

describe('a range that no longer means what it said', () => {
  /**
   * The offsets are in the coordinates of the document the request was made
   * against. CodeMirror maps its `from` from a request-time position too, so
   * `from === requestFrom` is exactly the test for "nothing before the
   * completion has moved" — and when something has, the editor's own mapping
   * is the answer and the server's raw number is not.
   */
  it('falls back to the editor mapping when text before it has moved', async () => {
    const shifted = await accept(deps(WIDE_EDIT), (live) => {
      live.dispatch({ changes: { from: 0, insert: '// header\n' } });
      // What CodeMirror would hand `apply` after that change.
      return { from: WORD_START + 10, to: CURSOR + 10 };
    });

    // The word is replaced, the wider range is not trusted, and nothing lands
    // at an offset that now points somewhere else.
    expect(shifted).toBe("// header\nconst path = 'src/REPLACED';\n");
  });

  /** Typing on, which is the normal case, does not move `from` at all. */
  it('still uses the range when the caret has only moved forward', async () => {
    const typed = await accept(deps(WIDE_EDIT), (live) => {
      live.dispatch({ changes: { from: CURSOR, insert: 'i' } });
      // `from` is unmoved; `to` follows the caret, assoc 1.
      return { from: WORD_START, to: CURSOR + 1 };
    });

    expect(typed).toBe("const path = 'REPLACED';\n");
  });
});

describe('a range the server got wrong', () => {
  /**
   * `insertReplaceEdit` — `{ newText, insert, replace }` — is the 3.16 shape,
   * and it has no `range` at all. Nox does not advertise
   * `insertReplaceSupport`, so no conforming server should send it; a
   * non-conforming one used to reach `item.textEdit.range.start` and throw a
   * `TypeError` out of the completion source, which kills completions for that
   * server entirely and says nothing.
   */
  it('keeps the text and drops the range when the range is not one', async () => {
    const insertReplace = {
      newText: 'REPLACED',
      insert: { start: { line: 0, character: 18 }, end: { line: 0, character: 20 } },
      replace: { start: { line: 0, character: 14 }, end: { line: 0, character: 20 } },
    };

    expect(await accept(deps(insertReplace))).toBe("const path = 'src/REPLACED';\n");
  });

  it('ignores a range that starts after the caret', async () => {
    const backwards = {
      range: { start: { line: 0, character: 40 }, end: { line: 0, character: 41 } },
      newText: 'REPLACED',
    };

    expect(await accept(deps(backwards))).toBe("const path = 'src/REPLACED';\n");
  });
});

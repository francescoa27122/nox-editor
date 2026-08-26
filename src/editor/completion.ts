import {
  autocompletion,
  completeAnyWord,
  completeFromList,
  insertCompletionText,
  pickedCompletion,
  snippet,
  snippetCompletion,
  type Completion,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import {
  ChangeSet,
  EditorState,
  Transaction,
  type Extension,
  type TransactionSpec,
} from '@codemirror/state';
import { toCodeMirrorTemplate, type Snippet } from '@core/snippets';
import type { EditorView } from '@codemirror/view';
import {
  documentationOf,
  toCodeMirrorCompletions,
  type LspCompletionItem,
} from '@core/lsp-completion';
import { positionAt } from '@core/lsp-position';
import { changesOf, textEditsOf, type Change } from '@core/lsp-text-edit';

/**
 * Completions: the language server first, the words in the file underneath.
 *
 * The server source takes the two service methods it needs rather than the
 * service, which is what lets the cases worth testing be written down: no
 * server, a server that errors, and a result that arrives after the keystroke
 * that asked for it. Both sources are registered through language data so the
 * grammar packages keep theirs — see `completionExtension` for why that is
 * not `override`.
 *
 * This layer owns the DOM. `core/lsp-completion.ts` converts the items and
 * stays runnable under Node; CodeMirror's lazy `info` callback has to return
 * a node, so it is attached here.
 */

/** Just enough of `LspService` to ask a question. */
export interface CompletionLsp {
  capabilitiesFor(languageId: string): Record<string, unknown> | null;
  requestFor<T>(languageId: string, method: string, params: unknown): Promise<T>;
}

/**
 * What a source backed by a language server needs.
 *
 * Separate from `CompletionDeps` so hover, and the two sources that never
 * look at a snippet, ask for exactly what they use. Requiring `snippets` of
 * a hover tooltip would be a lie in a type.
 */
export interface LspDeps {
  lsp: CompletionLsp;
  /**
   * The document the view is showing, or null.
   *
   * A function rather than a value: the pane re-points one view at many
   * buffers, and the answer changes under the extension without it being
   * rebuilt.
   */
  documentOf: () => { uri: string; languageId: string } | null;
  /**
   * The snippets that apply to what is being edited.
   *
   * A function of no arguments rather than of a language id: resolving which
   * language a buffer is, and layering the wildcard set under it, is
   * `SnippetService`'s job. This layer needs only the answer, and needs it to
   * change under the extension without it being rebuilt - the same reason
   * `documentOf` is a function.
   *
   * Also the reason it is not read off `documentOf().languageId`: that is null
   * for a buffer with no path, and an untitled scratch buffer is exactly where
   * a snippet earns its keep.
   */
}

/** What the picker as a whole needs: the server's answers, and the user's own. */
export interface CompletionDeps extends LspDeps {
  /**
   * The snippets that apply to what is being edited.
   *
   * A function of no arguments rather than of a language id: resolving which
   * language a buffer is, and layering the wildcard set under it, is
   * `SnippetService`'s job. This layer needs only the answer, and needs it to
   * change under the extension without it being rebuilt.
   *
   * Also the reason it is not read off `documentOf().languageId`: that is null
   * for a buffer with no path, and an untitled scratch buffer is exactly where
   * a snippet earns its keep.
   */
  snippets: () => Snippet[];
}

interface CompletionProvider {
  triggerCharacters?: string[];
  resolveProvider?: boolean;
}

/** Renders resolved documentation. A node, because `CompletionInfo` is one. */
function infoNode(text: string): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'cm-completionInfo-lsp';
  dom.textContent = text;
  return dom;
}

/**
 * The additional edits as changes, or null when they cannot be trusted.
 *
 * `additionalTextEdits` offsets are in the coordinates of the document the
 * completion was *requested* against. The list is filtered locally while the
 * user keeps typing (`validFor` below), so no new request is made and those
 * offsets go stale by however many characters were typed at the cursor —
 * every one of them after an import at the top of the file.
 *
 * So the check is a prefix compare: the current document and the request-time
 * document must still agree on everything up to the last position the edits
 * touch. If they do, the offsets mean what they said. If they do not, the
 * edits are **dropped rather than written at a position that now means
 * something else** — the same call `undoLastReplace` and rename make.
 */
function trustedChanges(
  requestText: string,
  current: string,
  edits: unknown,
): Change[] | null {
  const parsed = textEditsOf(edits);
  if (parsed.length === 0) return null;

  const changes = changesOf(requestText, parsed);
  const reach = changes.reduce((furthest, change) => Math.max(furthest, change.to), 0);
  if (current.length < reach) return null;
  if (current.slice(0, reach) !== requestText.slice(0, reach)) return null;

  return changes;
}

/**
 * Where the replacement begins: the server's range, or CodeMirror's word.
 *
 * `toCodeMirrorCompletions` reads `textEdit.range` — "believed over any range
 * the client would guess" — and until now nothing applied it. The source
 * inserted at the list-level `from`, the start of whatever `[\w$]+` matched,
 * and the two only *usually* agree. They part company for a path inside a
 * string, a member expression, anything the server wants to rewrite more of
 * than the last word: accepting left the rest of the range in place, which is
 * how `console.log` becomes `console.console.log`.
 *
 * The range is in the coordinates of the document the completion was
 * *requested* against, and CodeMirror hands `apply` positions it has mapped
 * forward through everything since (`ActiveResult.updateFor`). `requestFrom`
 * is the request-time value of that same mapped position, so `from ===
 * requestFrom` is exactly the test for "nothing before the completion has
 * moved" — and when something has, the editor's mapping is the answer and the
 * server's raw offset is not.
 *
 * `to` is CodeMirror's throughout, never the server's: it is mapped with
 * assoc 1, so it follows the caret through the characters typed while the
 * list was being filtered locally. See `ConvertedCompletion` for why the
 * server's end is read and deliberately not applied.
 */
function startFor(
  named: number | undefined,
  requestFrom: number,
  from: number,
  to: number,
): number {
  if (named === undefined || from !== requestFrom) return from;
  // A range that begins after the caret cannot be what the user is
  // completing; fall back rather than dispatch a backwards change.
  if (named < 0 || named > to) return from;
  return named;
}

/**
 * A snippet expansion, as a spec rather than a dispatch.
 *
 * `snippet()` dispatches for itself, which is right everywhere except here:
 * the expansion may have to travel in the same transaction as an auto-import,
 * and two transactions would be two undo steps. A `dispatch` that captures is
 * the only seam it offers, and what it builds - the changes, a selection over
 * the first field, the effect that arms the field keymap - is exactly what a
 * spec needs.
 */
function snippetSpec(
  template: string,
  completion: Completion,
  state: EditorState,
  from: number,
  to: number,
): TransactionSpec {
  let captured: Transaction | undefined;
  // Translated on the way in: a server's `$0` is a tab stop and CodeMirror's
  // parser only reads braced ones. See `toCodeMirrorTemplate`.
  snippet(toCodeMirrorTemplate(template))(
    {
      state,
      dispatch: (transaction: Transaction) => {
        captured = transaction;
      },
    },
    completion,
    from,
    to,
  );

  const built = captured;
  if (!built) throw new Error('the snippet produced no transaction');

  return {
    changes: built.changes,
    selection: built.newSelection,
    // Carries `setActive`, and the `appendConfig` that installs the snippet
    // field, its `Prec.highest` Tab keymap and its pointer handler the first
    // time a snippet runs in a buffer. Dropping it would insert the text and
    // lose every field with it.
    effects: built.effects,
    annotations: [pickedCompletion.of(completion), Transaction.userEvent.of('input.complete')],
    scrollIntoView: true,
  };
}

/**
 * Apply a completion together with the edits that must land with it.
 *
 * **The subtlety is the cursor, and it was wrong from the day imports landed.**
 * The old shape merged both change sets into one spec and kept the selection
 * `insertCompletionText` had computed - but that selection is a position in a
 * document containing only the completion. An import merged in above it moves
 * everything down and nothing moved the cursor with it, so accepting a
 * completion from a server that sends `additionalTextEdits` *in the list* left
 * the caret inside the import at the top of the file. tsserver sends them on
 * resolve instead and never hit it; rust-analyzer, gopls and pyright do not.
 *
 * So the extra edits are applied to a throwaway state **first** and the
 * completion is built against that. Its positions are then already final, and
 * `compose` is the honest way to join two change sets where the second is
 * expressed in the first's output - there is no position mapping left to get
 * wrong.
 */
function withEdits(
  view: EditorView,
  extra: Change[],
  from: number,
  to: number,
  build: (state: EditorState, from: number, to: number) => TransactionSpec,
): void {
  if (extra.length === 0) {
    view.dispatch(build(view.state, from, to));
    return;
  }

  const changes = ChangeSet.of(extra, view.state.doc.length);
  const base = view.state.update({ changes }).state;
  // Both ends map with assoc 1, and the start is the one that matters: an
  // import is inserted at offset 0, and a completion at the top of an
  // otherwise empty file starts there too. Mapping the start with the
  // default assoc leaves it *before* the import, so the completion replaces
  // the import it was supposed to travel with.
  const spec = build(base, changes.mapPos(from, 1), changes.mapPos(to, 1));

  view.dispatch({
    ...spec,
    changes: changes.compose(ChangeSet.of(spec.changes ?? [], base.doc.length)),
  });
}

export function createLspCompletionSource(deps: LspDeps): CompletionSource {
  return async (context): Promise<CompletionResult | null> => {
    const document_ = deps.documentOf();
    if (!document_) return null;

    const provider = deps.lsp.capabilitiesFor(document_.languageId)?.completionProvider as
      | CompletionProvider
      | undefined;
    if (!provider) return null;

    const text = context.state.doc.toString();
    const before = text.slice(Math.max(0, context.pos - 1), context.pos);
    const word = context.matchBefore(/[\w$]+/);
    const triggered = (provider.triggerCharacters ?? []).includes(before);

    // Otherwise every space bar press is a round trip.
    if (!context.explicit && !word && !triggered) return null;

    let response: unknown;
    try {
      response = await deps.lsp.requestFor(document_.languageId, 'textDocument/completion', {
        textDocument: { uri: document_.uri },
        position: positionAt(text, context.pos),
      });
    } catch {
      // A server error must not become an exception inside the picker.
      return null;
    }

    // Checked after the await: CodeMirror cancels stale queries as the user
    // keeps typing, and a result that outlives its keystroke describes text
    // that is no longer there.
    if (context.aborted) return null;

    const list = Array.isArray(response)
      ? { items: response as LspCompletionItem[], isIncomplete: false }
      : ((response ?? {}) as { items?: LspCompletionItem[]; isIncomplete?: boolean });
    const items = list.items ?? [];

    const options = toCodeMirrorCompletions(text, items);
    /**
     * The list-level `from`, before CodeMirror maps it. Kept so `apply` can
     * tell whether the document has moved under the server's own offsets.
     */
    const requestFrom = word?.from ?? context.pos;

    for (const [index, option] of options.entries()) {
      const item = items[index]!;
      /**
       * What `completionItem/resolve` came back with, if it has been asked.
       *
       * Shared between `info` and `apply` on purpose. `info` is the tooltip's
       * lazy resolve and CodeMirror calls it when an item is *highlighted* —
       * which for a keyboard user is before they press Enter, and for a
       * tsserver item is always, because those carry no documentation in the
       * list. So by the time `apply` runs the edits are usually already here,
       * and the import can go in the same transaction as the symbol.
       */
      let resolved: LspCompletionItem | null = null;

      const resolve = async (): Promise<LspCompletionItem | null> => {
        if (resolved) return resolved;
        if (!provider.resolveProvider) return null;
        try {
          resolved = await deps.lsp.requestFor<LspCompletionItem>(
            document_.languageId,
            'completionItem/resolve',
            item,
          );
          return resolved;
        } catch {
          // A server that will not resolve costs a tooltip or an import, not
          // an exception inside the picker.
          return null;
        }
      };

      if (provider.resolveProvider && documentationOf(item) === null) {
        // Called only for the highlighted item. Resolving the whole list
        // would be hundreds of round trips to render one tooltip.
        option.info = async () => {
          const answer = await resolve();
          const documentation = answer && documentationOf(answer);
          return documentation ? infoNode(documentation) : null;
        };
      }

      // Only items with something to decide get a callback; everything else
      // keeps the plain string `apply` and CodeMirror's own insertion. A
      // named range is one of those things — it is the difference between
      // replacing `src/ut` and replacing `ut`.
      if (
        item.additionalTextEdits === undefined &&
        !provider.resolveProvider &&
        option.from === undefined &&
        option.snippet === undefined
      ) {
        continue;
      }

      /** The server's own start, in request-time coordinates. */
      const named = option.from;

      const insert = typeof option.apply === 'string' ? option.apply : option.label;
      /** The server's own template, when it sent one. */
      const template = option.snippet;

      option.apply = (view: EditorView, completion: Completion, from: number, to: number) => {
        const known = trustedChanges(text, view.state.doc.toString(), item.additionalTextEdits);
        const start = startFor(named, requestFrom, from, to);

        // One transaction, so one undo: a symbol without its import is not a
        // state the user asked for, and must not be one undo stops at. The
        // completion itself goes in through CodeMirror's own machinery - the
        // string-`apply` helper, or the snippet lifecycle - so the transaction
        // carries `input.complete` and `pickedCompletion` exactly as before.
        withEdits(view, known ?? [], start, to, (state, at, until) =>
          template === undefined
            ? insertCompletionText(state, insert, at, until)
            : snippetSpec(template, completion, state, at, until),
        );

        // The import follows if one arrives - the typing path never waits on a
        // server. A late edit elsewhere does not disturb an open snippet: its
        // fields are ranges, and ranges map through a change.
        if (!provider.resolveProvider) return;

        void resolve().then((answer) => {
          const late = answer
            ? trustedChanges(text, view.state.doc.toString(), answer.additionalTextEdits)
            : null;
          if (late) view.dispatch({ changes: late });
        });
      };
    }

    return {
      from: requestFrom,
      options,
      // `isIncomplete` is the server saying "ask again on the next
      // character". Caching such a list shows suggestions for a prefix the
      // user has already typed past.
      ...(list.isIncomplete ? {} : { validFor: /^[\w$]*$/ }),
    };
  };
}

/**
 * How much document the word fallback will read.
 *
 * `completeAnyWord` scans the whole document, caching per rope node, so an
 * edit rescans one chunk and reuses the rest. What it cannot cache is the
 * merge: above ~2000 distinct words the top-level result is never stored
 * (`@codemirror/autocomplete`, `collectWords`), so every query re-merges the
 * cached child lists, and that cost tracks distinct words rather than
 * keystrokes.
 *
 * Measured on this machine over synthetic source text, per query, after the
 * first: 0.25 MB 2-3 ms, 0.5 MB 3-4 ms, 1 MB ~8 ms, 2 MB ~23 ms, 10 MB
 * ~112 ms. The cap is where the query still leaves most of a frame for
 * everything else — the same rule quick-open's index cap was set by, which
 * rejected a scan taking 80-85% of one. Above it the fallback declines
 * rather than slows: a file this size is generated or data, and a list of
 * every word in it is noise even when it is free.
 */
export const WORD_COMPLETION_MAX_BYTES = 1024 * 1024;

/**
 * The words already in the document — the floor under everything else.
 *
 * Two conditions turn it off. **A language server that offers completion**
 * takes the question: its items carry `detail`, so CodeMirror's own
 * cross-source dedupe (`sortOptions`) would not collapse a bare word against
 * the same symbol described properly, and the list would carry both. **A
 * document past the cap** costs more per query than it returns.
 *
 * A language that brings its own source — html, css, javascript — keeps this
 * one as well. Those sources answer in syntactic positions rather than
 * everywhere (`lang-javascript` completes locally-bound names only), so the
 * overlap is small and the words are what fill the gap. They arrive typed
 * `text`, which is CodeMirror's own signal for "this is only a word that
 * appears in your file".
 */
export function createWordCompletionSource(deps: LspDeps): CompletionSource {
  return (context) => {
    if (context.state.doc.length > WORD_COMPLETION_MAX_BYTES) return null;

    const document_ = deps.documentOf();
    if (document_ && deps.lsp.capabilitiesFor(document_.languageId)?.completionProvider) {
      return null;
    }

    return completeAnyWord(context);
  };
}

/**
 * How far a snippet outranks a plain word of the same prefix.
 *
 * Small on purpose. A snippet you wrote should beat a word that merely
 * appears in the file, and should not beat a language server's exact match -
 * the server knows what is in scope and a snippet list does not.
 */
const SNIPPET_BOOST = 1;

/**
 * The user's own snippets, from `snippets.json`.
 *
 * Built per query rather than cached, which is affordable because the list is
 * a person's own snippets - tens of entries, not thousands - and because the
 * alternative is a cache this layer would have to be told to invalidate every
 * time the file is saved. `completeFromList` does the prefix matching that
 * every other source in the picker already gets.
 */
export function createSnippetCompletionSource(deps: Pick<CompletionDeps, 'snippets'>): CompletionSource {
  return (context) => {
    const available = deps.snippets();
    if (available.length === 0) return null;

    return completeFromList(
      available.map((entry) =>
        snippetCompletion(toCodeMirrorTemplate(entry.body), {
          label: entry.prefix,
          type: 'snippet',
          boost: SNIPPET_BOOST,
          ...(entry.description === undefined ? {} : { detail: entry.description }),
        }),
      ),
    )(context);
  };
}

/**
 * The extension, for `EditorPane`.
 *
 * The sources go in through **language data, not `override`**. `override`
 * replaces the list CodeMirror gathers from language data rather than adding
 * to it, so the previous shape silently switched off every completion source
 * the grammar packages register — html tags, css properties, javascript
 * locals were all in the bundle and unreachable, and a file whose language had
 * no server got nothing at all. Registering on the bare `languageData` facet
 * adds these two to whatever the language already contributes;
 * `languageDataAt` collects from every provider that has the key.
 */
export function completionExtension(deps: CompletionDeps): Extension {
  /**
   * Built once, deliberately.
   *
   * CodeMirror tracks a running query per source and finds it by **identity**
   * of the source function (`CompletionState.update`: `active.find(s =>
   * s.source == source)`). The language-data provider is called on every
   * transaction, so constructing the sources inside it hands back a new pair
   * each time, no running query is ever recognised as its own, and every
   * source is reset to pending on the transaction that would have delivered
   * its result. The picker then stays pending forever rather than opening —
   * which is a hang, not a wrong list, and it is what
   * `tests/completion-sources.test.ts` catches.
   */
  const languageData = [
    { autocomplete: createLspCompletionSource(deps) },
    { autocomplete: createSnippetCompletionSource(deps) },
    { autocomplete: createWordCompletionSource(deps) },
  ];

  return [autocompletion(), EditorState.languageData.of(() => languageData)];
}

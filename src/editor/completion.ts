import {
  autocompletion,
  insertCompletionText,
  type Completion,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import type { ChangeSpec, Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  documentationOf,
  toCodeMirrorCompletions,
  type LspCompletionItem,
} from '@core/lsp-completion';
import { positionAt } from '@core/lsp-position';
import { changesOf, textEditsOf, type Change } from '@core/lsp-text-edit';

/**
 * Completions from the language server.
 *
 * Takes the two service methods it needs rather than the service, which is
 * what lets the cases worth testing be written down: no server, a server that
 * errors, and a result that arrives after the keystroke that asked for it.
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

export interface CompletionDeps {
  lsp: CompletionLsp;
  /**
   * The document the view is showing, or null.
   *
   * A function rather than a value: the pane re-points one view at many
   * buffers, and the answer changes under the extension without it being
   * rebuilt.
   */
  documentOf: () => { uri: string; languageId: string } | null;
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

export function createLspCompletionSource(deps: CompletionDeps): CompletionSource {
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

      // Only items that could carry other edits get a callback; everything
      // else keeps the plain string `apply` and CodeMirror's own insertion.
      if (item.additionalTextEdits === undefined && !provider.resolveProvider) continue;

      const insert = typeof option.apply === 'string' ? option.apply : option.label;

      option.apply = (view: EditorView, _completion: Completion, from: number, to: number) => {
        const known = trustedChanges(text, view.state.doc.toString(), item.additionalTextEdits);

        // The completion itself goes in through the same helper CodeMirror's
        // string `apply` uses, so the transaction carries `input.complete`
        // and the `pickedCompletion` annotation exactly as it did before.
        const main = insertCompletionText(view.state, insert, from, to);
        if (known) {
          // One transaction, so one undo: a symbol without its import is not
          // a state the user asked for, and must not be one undo stops at.
          view.dispatch({
            ...main,
            changes: [main.changes as ChangeSpec, ...known],
          });
          return;
        }

        // Nothing known yet. The completion lands **now** — the typing path
        // never waits on a server — and the import follows if one arrives.
        view.dispatch(main);
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
      from: word?.from ?? context.pos,
      options,
      // `isIncomplete` is the server saying "ask again on the next
      // character". Caching such a list shows suggestions for a prefix the
      // user has already typed past.
      ...(list.isIncomplete ? {} : { validFor: /^[\w$]*$/ }),
    };
  };
}

/** The extension, for `buildExtensions`. */
export function lspCompletionExtension(deps: CompletionDeps): Extension {
  return autocompletion({ override: [createLspCompletionSource(deps)] });
}

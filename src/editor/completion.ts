import {
  autocompletion,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import {
  documentationOf,
  toCodeMirrorCompletions,
  type LspCompletionItem,
} from '@core/lsp-completion';
import { positionAt } from '@core/lsp-position';

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

    if (provider.resolveProvider) {
      for (const [index, option] of options.entries()) {
        const item = items[index]!;
        if (documentationOf(item) !== null) continue;

        // Called only for the highlighted item. Resolving the whole list
        // would be hundreds of round trips to render one tooltip.
        option.info = async () => {
          try {
            const resolved = await deps.lsp.requestFor<LspCompletionItem>(
              document_.languageId,
              'completionItem/resolve',
              item,
            );
            const documentation = documentationOf(resolved);
            return documentation === null ? null : infoNode(documentation);
          } catch {
            // A missing tooltip is a small loss; an exception in the picker
            // is not.
            return null;
          }
        };
      }
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

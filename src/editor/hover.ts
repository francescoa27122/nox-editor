import type { Extension } from '@codemirror/state';
import { hoverTooltip, type EditorView, type Tooltip } from '@codemirror/view';
import { hoverBlocks, type HoverBlock } from '@core/lsp-hover';
import { offsetAt, positionAt, type LspPosition } from '@core/lsp-position';
import type { CompletionDeps } from './completion';

/**
 * What the server says about the symbol under the pointer.
 *
 * CodeMirror owns the hover timing, the lifecycle and the dismissal, so none
 * of that is here. What is here is the request, and the decision about how a
 * third-party process's text reaches the DOM.
 */

/** CodeMirror's default; named because the design refers to it. */
const HOVER_TIME_MS = 300;

interface HoverResponse {
  contents?: unknown;
  range?: { start: LspPosition; end: LspPosition };
}

/**
 * Build the tooltip's DOM.
 *
 * **Everything goes in through `textContent`.** A language server is a
 * third-party process started from `servers.json` and run on the user's
 * machine, and hover text is derived from source code — which arrives from
 * repositories people clone. Parsing its markdown into HTML would buy
 * typographic polish with an injection surface inside a desktop application
 * that can read the filesystem.
 *
 * The cost, paid deliberately: inline markdown such as `**bold**` shows as
 * the characters it is. `tests/lsp-hover-source.test.ts` asserts that, and it
 * should fail loudly if anyone reaches for `innerHTML` here later.
 */
export function renderHover(blocks: readonly HoverBlock[]): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'cm-tooltip-lsp-hover';

  for (const block of blocks) {
    const element = document.createElement(block.kind === 'code' ? 'pre' : 'p');
    element.textContent = block.text;
    dom.appendChild(element);
  }

  return dom;
}

export function createLspHoverSource(
  deps: CompletionDeps,
): (view: EditorView, pos: number) => Promise<Tooltip | null> {
  return async (view, pos) => {
    const document_ = deps.documentOf();
    if (!document_) return null;

    const capabilities = deps.lsp.capabilitiesFor(document_.languageId);
    if (!capabilities?.hoverProvider) return null;

    const text = view.state.doc.toString();

    let response: HoverResponse | null;
    try {
      response = await deps.lsp.requestFor<HoverResponse | null>(
        document_.languageId,
        'textDocument/hover',
        {
          textDocument: { uri: document_.uri },
          position: positionAt(text, pos),
        },
      );
    } catch {
      return null;
    }

    const blocks = hoverBlocks(response?.contents);
    // Nothing to say means no tooltip, rather than an empty box that follows
    // the pointer around.
    if (blocks.length === 0) return null;

    // The server's own range where it gave one. CodeMirror draws nothing for
    // it — `pos`/`end` decide when the tooltip *closes*: it stays while the
    // pointer is anywhere over the symbol, not only the character it was
    // over when the timer fired.
    const range = response?.range;

    return {
      pos: range ? offsetAt(text, range.start) : pos,
      ...(range ? { end: offsetAt(text, range.end) } : {}),
      create: () => ({ dom: renderHover(blocks) }),
    };
  };
}

/** The extension, for the pane's LSP compartment. */
export function lspHoverExtension(deps: CompletionDeps): Extension {
  return hoverTooltip(createLspHoverSource(deps), { hoverTime: HOVER_TIME_MS });
}

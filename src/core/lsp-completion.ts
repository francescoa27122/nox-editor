import type { Completion } from '@codemirror/autocomplete';
import { offsetAt, type LspPosition } from './lsp-position';
import { isLspRange } from './lsp-text-edit';

/**
 * LSP completion items to CodeMirror completions.
 *
 * Its own module, with its own tests, for the reason `toCodeMirrorDiagnostics`
 * is: this is where being wrong is invisible. A mis-mapped kind is a wrong
 * icon, but a mishandled `textEdit` silently corrupts the line the user is
 * typing on.
 */

export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { value: string };
  sortText?: string;
  filterText?: string;
  insertText?: string;
  /** 1 plain text, 2 snippet. */
  insertTextFormat?: 1 | 2;
  textEdit?: { range: { start: LspPosition; end: LspPosition }; newText: string };
  /**
   * Other changes to make when this item is chosen — the import an
   * auto-import completion needs.
   *
   * Deliberately `unknown`: it arrives from a third-party process and is
   * validated by `textEditsOf` rather than trusted by its type. Ranges are in
   * the coordinates of the document the *request* was made against, and the
   * protocol requires them not to overlap `textEdit`'s range.
   *
   * Read by `editor/completion.ts`, not here: applying it needs a view, and
   * this module must keep running under Node.
   */
  additionalTextEdits?: unknown;
  /** Opaque to Nox; handed back verbatim on `completionItem/resolve`. */
  data?: unknown;
}

/**
 * A converted completion, plus the range the server asked to replace.
 *
 * `from`/`to` are not part of CodeMirror's `Completion` — they are carried
 * here for the source to read, because only the item knows whether the server
 * named its own range. Absent when the server named none, or named one that
 * is not a well-formed range.
 *
 * **`from` is applied and `to` deliberately is not.** A range may end *after*
 * the caret — "replace the whole word I am standing in the middle of" — and
 * honouring that is replace mode, which LSP gates behind
 * `insertReplaceSupport`, a capability Nox does not advertise
 * (`services/lsp/session.ts:155`). Insert mode is also what every editor does
 * by default. `to` is read because reading the protocol honestly is what this
 * module is for, and because the feature that wants it will want it here.
 */
export type ConvertedCompletion = Completion & {
  from?: number;
  to?: number;
  /**
   * The server's template, when it sent one (`insertTextFormat: 2`).
   *
   * Carried rather than expanded, because expanding needs CodeMirror's
   * snippet lifecycle and this module has to keep running under Node.
   * `apply` still holds the flattened text beside it, so a caller that does
   * not know about snippets inserts something sensible rather than the
   * label.
   */
  snippet?: string;
};

/**
 * The protocol's 25 kinds, to the strings CodeMirror renders icons from.
 *
 * Several collapse: the protocol distinguishes Unit from Keyword and Struct
 * from Class, and CodeMirror's icon set does not. Mapping to the nearest
 * available icon beats inventing type names nothing styles.
 */
const KINDS: Record<number, string> = {
  1: 'text',
  2: 'method',
  3: 'function',
  4: 'function', // Constructor
  5: 'property', // Field
  6: 'variable',
  7: 'class',
  8: 'interface',
  9: 'namespace', // Module
  10: 'property',
  11: 'keyword', // Unit
  12: 'constant', // Value
  13: 'enum',
  14: 'keyword',
  15: 'text', // Snippet
  16: 'constant', // Color
  17: 'text', // File
  18: 'text', // Reference
  19: 'text', // Folder
  20: 'constant', // EnumMember
  21: 'constant',
  22: 'class', // Struct
  23: 'keyword', // Event
  24: 'keyword', // Operator
  25: 'type', // TypeParameter
};

/**
 * Anything unrecognised is a `variable`: an untyped completion renders with
 * no icon, which reads as broken rather than as unknown.
 */
export function completionKind(kind: number | undefined): string {
  return (kind !== undefined ? KINDS[kind] : undefined) ?? 'variable';
}

/**
 * Reduce snippet syntax to the text it would insert.
 *
 * `${1:arg}` becomes `arg`; `$1` and `$0` vanish. This was once the whole of
 * Nox's answer to snippets. It is now the **fallback beside the template**:
 * `editor/completion.ts` expands the real thing, and this is what a caller
 * that cannot — anything without a view — inserts instead. Keeping it means
 * a path that misses the snippet writes `console.log(value)` rather than
 * `${1:value}` or the bare label.
 */
export function stripSnippet(text: string): string {
  return text
    .replace(/\$\{(\d+):([^}]*)\}/g, '$2')
    .replace(/\$\{\d+\}/g, '')
    .replace(/\$\d+/g, '')
    .replace(/\\\$/g, '$');
}

/**
 * The documentation an item carried with it, if any.
 *
 * Exported because the *editor* layer decides what to do when there is none:
 * CodeMirror's lazy `info` callback must return a DOM node, and `core/` stays
 * free of the DOM so it runs unchanged under Node. See `editor/completion.ts`.
 */
export function documentationOf(item: LspCompletionItem): string | null {
  if (item.documentation === undefined) return null;
  return typeof item.documentation === 'string' ? item.documentation : item.documentation.value;
}

export function toCodeMirrorCompletions(
  text: string,
  items: readonly LspCompletionItem[],
): ConvertedCompletion[] {
  return items.map((item) => {
    const isSnippet = item.insertTextFormat === 2;

    let apply: string | undefined;
    /** The unflattened template, when this item is a snippet. */
    let template: string | undefined;
    let range: { from: number; to: number } | undefined;

    if (item.textEdit) {
      // The server naming the exact range it wants replaced. Believed over
      // any range the client would guess.
      apply = isSnippet ? stripSnippet(item.textEdit.newText) : item.textEdit.newText;
      if (isSnippet) template = item.textEdit.newText;
      // Checked, not assumed. The 3.16 `InsertReplaceEdit` shape is
      // `{ newText, insert, replace }` with **no `range` at all**, and
      // reaching into it threw a `TypeError` out of the whole completion
      // source — which kills completions for that server and says nothing.
      // Nox does not advertise `insertReplaceSupport`, so no conforming
      // server should send one; this module reads a third-party process and
      // does not get to rely on that.
      if (isLspRange(item.textEdit.range)) {
        range = {
          from: offsetAt(text, item.textEdit.range.start),
          to: offsetAt(text, item.textEdit.range.end),
        };
      }
    } else if (item.insertText !== undefined) {
      apply = isSnippet ? stripSnippet(item.insertText) : item.insertText;
      if (isSnippet) template = item.insertText;
    }

    // CodeMirror matches typed input against `label`, so a server that
    // decorates its labels needs `filterText` to be the thing matched and the
    // decorated form shown.
    const label = item.filterText ?? item.label;

    const completion: ConvertedCompletion = {
      label,
      type: completionKind(item.kind),
      ...(label !== item.label ? { displayLabel: item.label } : {}),
      ...(item.detail ? { detail: item.detail } : {}),
      ...(item.sortText ? { sortText: item.sortText } : {}),
      ...(apply !== undefined ? { apply } : {}),
      ...(isSnippet && template !== undefined ? { snippet: template } : {}),
      ...(range ?? {}),
    };

    // Only the string form here. An item with no documentation is left
    // without `info`, and the editor layer attaches the lazy callback — that
    // callback has to return a DOM node, and this module must keep running
    // under Node.
    const documentation = documentationOf(item);
    if (documentation !== null) completion.info = documentation;

    return completion;
  });
}

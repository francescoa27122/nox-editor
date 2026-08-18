import { setDiagnostics, lintGutter, type Diagnostic } from '@codemirror/lint';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { offsetAt } from '@core/lsp-position';
import type { LspDiagnostic } from '@services/lsp';

/**
 * Language-server diagnostics, drawn by CodeMirror.
 *
 * Push, not poll. `@codemirror/lint`'s headline API is `linter()`, which runs
 * a source on a timer — the wrong shape for a server that publishes when it
 * is ready. `setDiagnostics` is dispatched on receipt instead, and the
 * squiggles, the gutter marks and the hover tooltip all come from that one
 * extension. Nothing here draws anything by hand.
 */

/** LSP severities are 1-4; CodeMirror names them. 1 is the spec's default. */
const SEVERITY = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
} as const;

/**
 * Convert one batch against the text it will be drawn on.
 *
 * Every range is clamped, and that is correctness rather than caution:
 * CodeMirror throws on an out-of-range position, and `publishDiagnostics`
 * carries an *optional* version, so a batch from a server one revision behind
 * cannot always be rejected before it gets here.
 */
export function toCodeMirrorDiagnostics(
  text: string,
  diagnostics: readonly LspDiagnostic[],
): Diagnostic[] {
  return diagnostics.map((diagnostic) => {
    const start = offsetAt(text, diagnostic.range.start);
    const end = offsetAt(text, diagnostic.range.end);

    // Normalised rather than trusted: a server may emit a range whose end
    // precedes its start, and CodeMirror treats that as a programming error.
    let from = Math.min(start, end);
    let to = Math.max(start, end);

    // A squiggle of no width is one nobody can see or click. Widen by a
    // character, preferring forwards and falling back at the end of the file.
    if (from === to) {
      if (to < text.length) to = to + 1;
      else if (from > 0) from = from - 1;
    }

    return {
      from,
      to,
      severity: SEVERITY[diagnostic.severity ?? 1],
      message: diagnostic.message,
      ...(diagnostic.source ? { source: diagnostic.source } : {}),
    };
  });
}

/** The gutter marks. Squiggles come with `setDiagnostics` and need no extension. */
export function lspDiagnosticsExtension(): Extension {
  return [lintGutter()];
}

/** Draw a batch now. */
export function applyDiagnostics(
  view: EditorView,
  diagnostics: readonly LspDiagnostic[],
): void {
  const text = view.state.doc.toString();
  view.dispatch(setDiagnostics(view.state, toCodeMirrorDiagnostics(text, diagnostics)));
}

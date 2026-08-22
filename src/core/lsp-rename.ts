import type { LspRange } from './lsp-definition';
import { isLspRange } from './lsp-text-edit';

/**
 * Rename symbol: what `textDocument/prepareRename` answers.
 *
 * The `WorkspaceEdit` half of rename is `core/lsp-workspace-edit.ts`, which
 * code actions read too. Pure; the app opens the files, converts positions and
 * stages the change set. See
 * `docs/superpowers/specs/2026-08-19-lsp-rename-design.md`.
 */

/**
 * What to seed the rename prompt with, from a `prepareRename` answer.
 *
 * `null` from the server means "nothing here can be renamed", and is
 * returned as null so the caller can say so instead of prompting. A
 * placeholder is the server's own suggestion; a bare range names the text;
 * `{ defaultBehavior: true }` — and anything unreadable — falls back to the
 * word under the cursor, which is what a server without prepare gets too.
 */
export function prepareRenameSeed(
  response: unknown,
  fallback: string,
  textAt: (range: LspRange) => string,
): string | null {
  if (response === null) return null;
  if (typeof response !== 'object') return fallback;
  const record = response as Record<string, unknown>;
  if (typeof record.placeholder === 'string' && isLspRange(record.range)) return record.placeholder;
  if (isLspRange(response)) return textAt(response);
  return fallback;
}

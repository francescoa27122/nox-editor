import type { LspRange } from './lsp-definition';
import { isLspRange, textEditsOf, type TextEdit } from './lsp-text-edit';

/**
 * Rename symbol: the two answers a server gives, reduced.
 *
 * `textDocument/prepareRename` says whether the thing under the cursor can
 * be renamed and what to seed the prompt with; `textDocument/rename` answers
 * with a `WorkspaceEdit`, whose text edits live in one of two places and may
 * sit beside file operations Nox does not perform. Pure; the app opens the
 * files, converts positions and stages the change set. See
 * `docs/superpowers/specs/2026-08-19-lsp-rename-design.md`.
 */

export type { TextEdit } from './lsp-text-edit';

export interface FileEdits {
  uri: string;
  edits: TextEdit[];
}

export interface RenamePlan {
  files: FileEdits[];
  /**
   * Resource operations the edit asked for — `create`, `rename`, `delete` —
   * which Nox does not perform. A caller that sees any should refuse the
   * whole rename: half of one is worse than none.
   */
  unsupported: string[];
}

/**
 * The text edits of a `WorkspaceEdit`, grouped by file, in the order the
 * server gave them.
 *
 * `documentChanges` wins over `changes` when both are present, as the
 * specification says a client supporting it should; entries for one URI are
 * merged. A malformed entry is dropped rather than thrown on, so one bad
 * edit among good ones still yields the good ones — and the caller's
 * position conversion is what finally decides whether each lands.
 */
export function renameEdits(response: unknown): RenamePlan {
  const plan: RenamePlan = { files: [], unsupported: [] };
  if (typeof response !== 'object' || response === null) return plan;
  const { changes, documentChanges } = response as Record<string, unknown>;

  const byUri = new Map<string, TextEdit[]>();
  const add = (uri: string, edits: TextEdit[]) => {
    const list = byUri.get(uri);
    if (list) list.push(...edits);
    else byUri.set(uri, [...edits]);
  };

  if (Array.isArray(documentChanges)) {
    for (const entry of documentChanges) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.kind === 'string') {
        plan.unsupported.push(record.kind);
        continue;
      }
      const textDocument = record.textDocument as Record<string, unknown> | undefined;
      const uri = textDocument?.uri;
      if (typeof uri !== 'string') continue;
      add(uri, textEditsOf(record.edits));
    }
  } else if (typeof changes === 'object' && changes !== null) {
    for (const [uri, edits] of Object.entries(changes as Record<string, unknown>)) {
      add(uri, textEditsOf(edits));
    }
  }

  for (const [uri, edits] of byUri) {
    if (edits.length > 0) plan.files.push({ uri, edits });
  }
  return plan;
}

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

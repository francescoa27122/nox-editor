import { textEditsOf, type TextEdit } from './lsp-text-edit';

/**
 * A `WorkspaceEdit`, reduced to a list of files and the edits for each.
 *
 * Its own module because two features read one shape. It began inside
 * `lsp-rename.ts`, which was right while rename was the only caller and
 * misleading the moment code actions became the second: a `WorkspaceEdit` is
 * not a rename concept, and the next reader should not have to know that
 * rename happened to get here first.
 *
 * Pure. The caller opens the files, converts positions and decides whether the
 * result is applied or staged. See
 * `docs/superpowers/specs/2026-08-19-lsp-rename-design.md` and
 * `docs/superpowers/specs/2026-08-22-lsp-code-actions-design.md`.
 */

export type { TextEdit } from './lsp-text-edit';

export interface FileEdits {
  uri: string;
  edits: TextEdit[];
}

export interface WorkspaceEditPlan {
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
export function workspaceEditPlan(response: unknown): WorkspaceEditPlan {
  const plan: WorkspaceEditPlan = { files: [], unsupported: [] };
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

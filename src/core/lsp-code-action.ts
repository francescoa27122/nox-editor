import type { LspRange } from './lsp-definition';
import { workspaceEditPlan, type WorkspaceEditPlan } from './lsp-workspace-edit';

/**
 * `textDocument/codeAction`, read and reduced.
 *
 * The answer is a union — `(Command | CodeAction)[]` — from a third-party
 * process, and the interesting part is that Nox can apply one half of it and
 * not the other. An action carrying a `WorkspaceEdit` is applicable now; one
 * carrying only a `Command` needs `workspace/executeCommand` and a
 * server-request handler, which do not exist yet.
 *
 * **The half Nox cannot run is kept, not dropped.** A picker that hid them
 * would say the server offered nothing where it offered something unbuilt,
 * and the user would conclude their language server was broken. So every
 * entry with a title comes back, and `runnable` says which is which.
 *
 * Pure: the caller opens files, converts positions, and decides between
 * applying and staging. See
 * `docs/superpowers/specs/2026-08-22-lsp-code-actions-design.md`.
 */

export interface CodeAction {
  title: string;
  /** The server's own classification: `quickfix`, `refactor.extract`, … */
  kind: string | undefined;
  /** The server marking the obvious choice among several. */
  preferred: boolean;
  /** True when there is a `WorkspaceEdit` here that Nox can apply. */
  runnable: boolean;
  /** Why not, when `runnable` is false. Shown to the user verbatim. */
  reason: string | undefined;
  /** The edit, grouped by file. Present only when `runnable`. */
  plan: WorkspaceEditPlan | undefined;
}

function titleOf(entry: Record<string, unknown>): string | null {
  const { title } = entry;
  return typeof title === 'string' && title.trim().length > 0 ? title : null;
}

/**
 * Every action in `response`, in the order the server gave them.
 *
 * Order is the server's ranking and is left alone — sorting `isPreferred`
 * first would override a judgement the server made with more information than
 * this module has. `preferred` is reported so the picker can mark it.
 */
export function codeActionsOf(response: unknown): CodeAction[] {
  if (!Array.isArray(response)) return [];

  const actions: CodeAction[] = [];
  for (const entry of response) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const title = titleOf(record);
    if (title === null) continue;

    const kind = typeof record.kind === 'string' ? record.kind : undefined;
    const preferred = record.isPreferred === true;
    const base = { title, kind, preferred };

    // The server's own 3.16 refusal. Its reason is written for the user and is
    // better than anything this module could say instead.
    const disabled = record.disabled as { reason?: unknown } | undefined;
    if (typeof disabled?.reason === 'string') {
      actions.push({ ...base, runnable: false, reason: disabled.reason, plan: undefined });
      continue;
    }

    if (record.edit === undefined) {
      // A bare `Command`, or a `CodeAction` whose payload is one. Listed so
      // the picker tells the truth about what the server offered.
      actions.push({
        ...base,
        runnable: false,
        reason: 'Nox cannot run an action that is a server command yet.',
        plan: undefined,
      });
      continue;
    }

    const plan = workspaceEditPlan(record.edit);
    if (plan.unsupported.length > 0) {
      // Rename's rule, for rename's reason: half a change is worse than none.
      actions.push({
        ...base,
        runnable: false,
        reason: `This would ${[...new Set(plan.unsupported)].join(', ')} a file, which Nox does not do.`,
        plan: undefined,
      });
      continue;
    }

    if (plan.files.length === 0) {
      // Every entry was malformed, or the edit was empty. Offering it would
      // make accepting it a no-op that looked like it worked.
      actions.push({
        ...base,
        runnable: false,
        reason: 'The server sent no edits Nox could read.',
        plan: undefined,
      });
      continue;
    }

    actions.push({ ...base, runnable: true, reason: undefined, plan });
  }

  return actions;
}

/**
 * Just enough of a diagnostic to place it.
 *
 * Structural rather than an import of `LspDiagnostic`: that type lives in
 * `services/lsp/`, and `core/` does not import from `services/`. Anything with
 * a range fits, which is what makes this testable without one.
 */
export interface Ranged {
  range: LspRange;
}

/** True when `a` starts at or before `b` in document order. */
function atOrBefore(a: { line: number; character: number }, b: { line: number; character: number }): boolean {
  return a.line < b.line || (a.line === b.line && a.character <= b.character);
}

/**
 * The diagnostics `range` touches, for the request's `context`.
 *
 * Not decoration: `context.diagnostics` is what a server keys its quick fixes
 * off. Send none and tsserver answers with refactors only, so "no quick fix
 * here" would be Nox's fault rather than the server's.
 *
 * Touching counts, including at either edge — a caret resting on the end of a
 * squiggle is still on it, and that is where a user asks for the fix.
 */
export function overlapping<T extends Ranged>(diagnostics: readonly T[], range: LspRange): T[] {
  return diagnostics.filter(
    (diagnostic) =>
      atOrBefore(diagnostic.range.start, range.end) && atOrBefore(range.start, diagnostic.range.end),
  );
}

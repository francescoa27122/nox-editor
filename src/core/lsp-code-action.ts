import type { LspRange } from './lsp-definition';
import { workspaceEditPlan, type WorkspaceEditPlan } from './lsp-workspace-edit';

/**
 * `textDocument/codeAction`, read and reduced.
 *
 * The answer is a union — `(Command | CodeAction)[]` — from a third-party
 * process, and it arrives in three shapes rather than two. An action may carry
 * a `WorkspaceEdit`, which Nox applies itself. It may carry a `Command`, which
 * only the server can run: Nox sends `workspace/executeCommand` and the server
 * answers by calling `workspace/applyEdit` *back*. And it may carry **both**,
 * in which case the specification is explicit that the edit is applied first
 * and the command run after.
 *
 * **Nothing with a title is dropped.** A picker that hid what it could not run
 * would say the server offered nothing where it offered something, and the
 * user would conclude their language server was broken. `runnable` says which
 * is which, and `reason` says why not.
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
  /** True when Nox can do something with this — an edit, a command, or both. */
  runnable: boolean;
  /** Why not, when `runnable` is false. Shown to the user verbatim. */
  reason: string | undefined;
  /** The edit, grouped by file. Absent when the action is a command alone. */
  plan: WorkspaceEditPlan | undefined;
  /**
   * The server command to run, when there is one.
   *
   * Present alongside `plan` for an action that carries both, and the order is
   * not ours to choose: the edit goes first.
   */
  command: ServerCommand | undefined;
}

/** A `Command` — something only the server can carry out. */
export interface ServerCommand {
  /** The identifier the server registered, e.g. `_typescript.organizeImports`. */
  command: string;
  /** Opaque, passed back verbatim. Nox never reads inside these. */
  arguments?: unknown[];
}

/**
 * Read a `Command`, from either a bare `Command` entry or a `CodeAction`'s
 * `command` field.
 *
 * `arguments` is passed through untouched and deliberately never inspected:
 * they are the server's own bookkeeping — file URIs, ranges, internal ids —
 * and a client that reinterpreted them would break the moment a server
 * changed its private shape.
 */
export function serverCommandOf(value: unknown): ServerCommand | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const command = record.command;
  if (typeof command !== 'string' || command.trim() === '') return undefined;
  return {
    command,
    ...(Array.isArray(record.arguments) ? { arguments: record.arguments } : {}),
  };
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
      actions.push({
        ...base,
        runnable: false,
        reason: disabled.reason,
        plan: undefined,
        command: undefined,
      });
      continue;
    }

    // A bare `Command` has its identifier at the top level; a `CodeAction`
    // nests one under `command`. Both spellings are the same thing to a
    // caller, so both are read here rather than at the call site.
    const command = serverCommandOf(record.command) ?? serverCommandOf(record);

    if (record.edit === undefined) {
      if (command) {
        // Only the server can carry this out. Nox sends
        // `workspace/executeCommand` and the server answers by calling
        // `workspace/applyEdit` back, which is why this needed the
        // server-request seam before it could be offered at all.
        actions.push({ ...base, runnable: true, reason: undefined, plan: undefined, command });
        continue;
      }
      // Neither an edit nor a command: nothing to run and nothing to explain
      // beyond that. Kept so the picker still reports what the server offered.
      actions.push({
        ...base,
        runnable: false,
        reason: 'The server offered no edit and no command for this.',
        plan: undefined,
        command: undefined,
      });
      continue;
    }

    const plan = workspaceEditPlan(record.edit);
    if (plan.unsupported.length > 0) {
      // Rename's rule, for rename's reason: half a change is worse than none.
      // Refused even when a command is attached, because running the command
      // half of an action whose edit half was refused is exactly the partial
      // application this rule exists to prevent.
      actions.push({
        ...base,
        runnable: false,
        reason: `This would ${[...new Set(plan.unsupported)].join(', ')} a file, which Nox does not do.`,
        plan: undefined,
        command: undefined,
      });
      continue;
    }

    if (plan.files.length === 0) {
      // An empty edit beside a command is not malformed — a server may send
      // `edit: {}` and mean "the command does the work" — so the command
      // still makes this runnable.
      if (command) {
        actions.push({ ...base, runnable: true, reason: undefined, plan: undefined, command });
        continue;
      }
      // Every entry was malformed, or the edit was empty. Offering it would
      // make accepting it a no-op that looked like it worked.
      actions.push({
        ...base,
        runnable: false,
        reason: 'The server sent no edits Nox could read.',
        plan: undefined,
        command: undefined,
      });
      continue;
    }

    actions.push({ ...base, runnable: true, reason: undefined, plan, command });
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

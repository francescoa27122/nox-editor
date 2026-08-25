import { describe, expect, it } from 'vitest';
import { codeActionsOf, overlapping } from '../src/core/lsp-code-action';

/**
 * Reading a `textDocument/codeAction` answer.
 *
 * Its own module and its own tests for the reason every other `core/lsp-*`
 * reader has them: the response comes from a third-party process, its shape is
 * a union — `(Command | CodeAction)[]` — and the half Nox cannot run has to be
 * told apart from the half it can *without* being thrown away, or the picker
 * would say the server offered nothing when it offered something Nox has not
 * built yet.
 */

const range = (line: number, from: number, to: number) => ({
  start: { line, character: from },
  end: { line, character: to },
});

const EDIT = { changes: { 'file:///w/a.ts': [{ range: range(0, 0, 1), newText: 'x' }] } };

describe('codeActionsOf', () => {
  it('is empty for anything that is not a list', () => {
    for (const response of [null, undefined, {}, 'no', 7]) {
      expect(codeActionsOf(response)).toEqual([]);
    }
  });

  it('reads a title, a kind and an edit', () => {
    const [action] = codeActionsOf([
      { title: 'Add import', kind: 'quickfix', edit: EDIT },
    ]);

    expect(action?.title).toBe('Add import');
    expect(action?.kind).toBe('quickfix');
    expect(action?.runnable).toBe(true);
    expect(action?.plan?.files.map((f) => f.uri)).toEqual(['file:///w/a.ts']);
  });

  /**
   * A bare `Command` is the pre-3.8 shape and still legal. Running one needs
   * `workspace/executeCommand` and a server-request handler, neither of which
   * exists — so it comes back listed and not runnable, never dropped.
   */
  /**
   * A bare `Command` carries its identifier at the top level. Runnable as of
   * 2026-08-25: Nox sends `workspace/executeCommand` and the server answers by
   * calling `workspace/applyEdit` back.
   */
  it('reads a bare Command and offers to run it', () => {
    const [action] = codeActionsOf([
      { title: 'Organize imports', command: 'typescript.organizeImports' },
    ]);

    expect(action?.title).toBe('Organize imports');
    expect(action?.runnable).toBe(true);
    expect(action?.command).toEqual({ command: 'typescript.organizeImports' });
    expect(action?.plan).toBeUndefined();
  });

  /** A `CodeAction` nests the same thing under `command`. */
  it('reads a CodeAction whose only payload is a command', () => {
    const [action] = codeActionsOf([
      {
        title: 'Extract function',
        kind: 'refactor.extract',
        command: { title: 'x', command: 'rust-analyzer.applySourceChange', arguments: [{ id: 3 }] },
      },
    ]);

    expect(action?.runnable).toBe(true);
    expect(action?.kind).toBe('refactor.extract');
    expect(action?.command).toEqual({
      command: 'rust-analyzer.applySourceChange',
      arguments: [{ id: 3 }],
    });
  });

  /**
   * Both halves. The specification is explicit that the edit is applied first
   * and the command run after, so both have to survive parsing.
   */
  it('keeps the edit and the command when an action carries both', () => {
    const [action] = codeActionsOf([
      { title: 'Fix all', edit: EDIT, command: { command: 'ts.fixAll', arguments: [1] } },
    ]);

    expect(action?.runnable).toBe(true);
    expect(action?.plan?.files).toHaveLength(1);
    expect(action?.command).toEqual({ command: 'ts.fixAll', arguments: [1] });
  });

  it('refuses an entry with neither an edit nor a command', () => {
    const [action] = codeActionsOf([{ title: 'Nothing here' }]);

    expect(action?.runnable).toBe(false);
    expect(action?.reason).toMatch(/no edit and no command/i);
  });

  /**
   * The rename rule, applied to the pair: an action whose edit half would
   * rename a file is refused *entirely*, command included. Running half of it
   * is the partial application that rule exists to prevent.
   */
  it('refuses a command whose edit half asks for a file operation', () => {
    const [action] = codeActionsOf([
      {
        title: 'Move to new file',
        edit: { documentChanges: [{ kind: 'rename', oldUri: 'file:///a', newUri: 'file:///b' }] },
        command: { command: 'ts.move' },
      },
    ]);

    expect(action?.runnable).toBe(false);
    expect(action?.command).toBeUndefined();
  });

  /** `edit: {}` beside a command means "the command does the work". */
  it('runs a command whose edit is empty', () => {
    const [action] = codeActionsOf([
      { title: 'Organize', edit: {}, command: { command: 'ts.organize' } },
    ]);

    expect(action?.runnable).toBe(true);
    expect(action?.command).toEqual({ command: 'ts.organize' });
  });

  /** The server's own 3.16 `disabled`, whose reason belongs to the user. */
  it('carries the server disabled reason through', () => {
    const [action] = codeActionsOf([
      { title: 'Add await', edit: EDIT, disabled: { reason: 'Not inside an async function' } },
    ]);

    expect(action?.runnable).toBe(false);
    expect(action?.reason).toBe('Not inside an async function');
  });

  /**
   * An edit whose entries are all malformed leaves nothing to apply. Listing
   * it as runnable would make accepting it a no-op that looked like success.
   */
  it('is not runnable when the edit reduces to no files', () => {
    const [action] = codeActionsOf([{ title: 'Broken', edit: { changes: { 'file:///w/a.ts': ['nonsense'] } } }]);

    expect(action?.runnable).toBe(false);
  });

  /** Resource operations are rename's rule: refuse the whole thing. */
  it('is not runnable when the edit asks for a file operation', () => {
    const [action] = codeActionsOf([
      {
        title: 'Move to new file',
        edit: {
          documentChanges: [
            { kind: 'create', uri: 'file:///w/b.ts' },
            { textDocument: { uri: 'file:///w/a.ts' }, edits: [{ range: range(0, 0, 1), newText: 'x' }] },
          ],
        },
      },
    ]);

    expect(action?.runnable).toBe(false);
    expect(action?.reason).toMatch(/create/);
  });

  it('drops an entry with no title, which nothing could show', () => {
    expect(codeActionsOf([{ kind: 'quickfix', edit: EDIT }, null, 3])).toEqual([]);
  });

  it('keeps the server order, which is the server ranking', () => {
    const actions = codeActionsOf([
      { title: 'One', edit: EDIT },
      { title: 'Two', command: 'x' },
      { title: 'Three', edit: EDIT },
    ]);

    expect(actions.map((a) => a.title)).toEqual(['One', 'Two', 'Three']);
  });

  /** `isPreferred` is the server saying "this is the obvious one". */
  it('reads isPreferred', () => {
    const [plain, preferred] = codeActionsOf([
      { title: 'Other', edit: EDIT },
      { title: 'The fix', edit: EDIT, isPreferred: true },
    ]);

    expect(plain?.preferred).toBe(false);
    expect(preferred?.preferred).toBe(true);
  });
});

describe('overlapping', () => {
  const diagnostic = (line: number, from: number, to: number) => ({
    range: range(line, from, to),
    message: `at ${line}`,
  });

  /**
   * The diagnostics handed to the server as `context` are what it keys its
   * quick fixes off: send none and tsserver answers with refactors only, so
   * "no quick fix here" would be Nox's fault rather than the server's.
   */
  it('keeps a diagnostic the range touches', () => {
    const found = overlapping([diagnostic(3, 0, 8)], range(3, 2, 2));
    expect(found).toHaveLength(1);
  });

  it('keeps one that merely starts before the range and runs into it', () => {
    expect(overlapping([diagnostic(1, 0, 40)], range(1, 10, 12))).toHaveLength(1);
  });

  it('drops one on another line entirely', () => {
    expect(overlapping([diagnostic(9, 0, 4)], range(3, 0, 0))).toEqual([]);
  });

  /** A caret resting exactly on the end of a diagnostic still counts. */
  it('counts a caret at either edge', () => {
    expect(overlapping([diagnostic(2, 4, 9)], range(2, 4, 4))).toHaveLength(1);
    expect(overlapping([diagnostic(2, 4, 9)], range(2, 9, 9))).toHaveLength(1);
  });

  it('drops one the caret has moved past', () => {
    expect(overlapping([diagnostic(2, 4, 9)], range(2, 10, 10))).toEqual([]);
  });

  /** A multi-line selection reaches diagnostics on the lines between. */
  it('spans lines', () => {
    const found = overlapping([diagnostic(4, 0, 2), diagnostic(9, 0, 2)], range(3, 0, 0));
    expect(found).toHaveLength(0);
    expect(overlapping([diagnostic(4, 0, 2), diagnostic(9, 0, 2)], { start: { line: 3, character: 0 }, end: { line: 5, character: 0 } })).toHaveLength(1);
  });
});

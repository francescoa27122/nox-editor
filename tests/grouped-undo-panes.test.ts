// @vitest-environment jsdom
import { history } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { mirroredAnnotation } from '../src/services/transactions';
import { WorkspaceService, type BufferId } from '../src/services/workspace';

/**
 * Grouped undo when the buffer is shown in two panes.
 *
 * Guards A3-002. `buffer.state` is whichever pane's state dispatched last,
 * including for a selection-only transaction such as a click. `#runOnBuffer`
 * built the undo transaction from that state and handed the *transaction* to
 * the first pane accepting the buffer, and `@codemirror/view` refuses a
 * transaction that does not start from the view's own state: clicking into
 * the second pane and undoing through the palette threw `RangeError`, with
 * any buffer earlier in the set already undone.
 *
 * Two real `EditorView`s are required. `tests/groups.test.ts` and the
 * `FakePane` in `tests/pane-fidelity.test.ts` model a pane as
 * `EditorState.update`, which accepts any start state, so neither can see
 * this. Wired the way `EditorPane.svelte` wires a pane: every non-mirrored
 * transaction goes to `applyTransaction` with the view as origin, and the
 * channel runs a command against its own view.
 *
 * Does not catch the same mismatch through `undoActive` / `redoActive`,
 * which nothing calls.
 */

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

function pane(workspace: WorkspaceService, id: BufferId): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view: EditorView = new EditorView({
    state: workspace.stateOf(id)!,
    parent,
    dispatchTransactions: (transactions, instance) => {
      instance.update(transactions);
      for (const transaction of transactions) {
        if (transaction.annotation(mirroredAnnotation)) continue;
        workspace.applyTransaction(id, transaction, instance);
      }
    },
  });
  views.push(view);
  workspace.addViewDispatcher(
    (target, spec) => {
      if (target !== id) return false;
      view.dispatch(spec);
      return true;
    },
    {
      owner: view,
      run: (target, command) => (target === id ? command(view) : null),
    },
  );
  return view;
}

async function setup() {
  const platform = new MemoryPlatform();
  platform.seedFile('/w/a.ts', 'alpha\n');
  platform.seedFile('/w/b.ts', 'beta\n');
  const workspace = new WorkspaceService(platform, () => [history()]);
  const a = (await workspace.open('/w/a.ts'))!;
  const b = (await workspace.open('/w/b.ts'))!;
  workspace.setActive(a);
  workspace.openCopyToSide();

  const first = pane(workspace, a);
  const second = pane(workspace, a);
  return { workspace, a, b, first, second };
}

describe('grouped undo with one file in two panes', () => {
  it.each([
    ['the mirrored buffer first', (a: BufferId, b: BufferId) => [a, b]],
    ['the mirrored buffer second', (a: BufferId, b: BufferId) => [b, a]],
  ])('undoes the whole set after a click in the second pane, %s', async (_name, order) => {
    const { workspace, a, b, first, second } = await setup();

    const result = workspace.apply({
      description: 'Replace across files',
      author: { kind: 'user' },
      edits: order(a, b).map((bufferId) => ({ bufferId, changes: { from: 0, insert: 'X ' } })),
    });
    if (!result.ok) throw new Error('setup failed');
    expect(first.state.doc.toString()).toBe('X alpha\n');
    expect(second.state.doc.toString()).toBe('X alpha\n');

    // A click in the second pane: a selection-only transaction, which makes
    // that pane's state the buffer's.
    second.dispatch({ selection: { anchor: 1 } });

    expect(workspace.pendingGroupedUndo()).toBe(result.id);
    const outcome = workspace.undoChangeSet(result.id);

    expect(outcome.skipped).toEqual([]);
    expect(outcome.undone.sort()).toEqual([a, b].sort());
    expect(workspace.textOf(a)).toBe('alpha\n');
    expect(workspace.textOf(b)).toBe('beta\n');
    expect(first.state.doc.toString()).toBe('alpha\n');
    expect(second.state.doc.toString()).toBe('alpha\n');
  });

  it('still undoes cleanly when the first pane dispatched last', async () => {
    const { workspace, a, b, first, second } = await setup();
    const result = workspace.apply({
      description: 'Replace across files',
      author: { kind: 'user' },
      edits: [a, b].map((bufferId) => ({ bufferId, changes: { from: 0, insert: 'X ' } })),
    });
    if (!result.ok) throw new Error('setup failed');

    first.dispatch({ selection: { anchor: 1 } });
    const outcome = workspace.undoChangeSet(result.id);

    expect(outcome.skipped).toEqual([]);
    expect(first.state.doc.toString()).toBe('alpha\n');
    expect(second.state.doc.toString()).toBe('alpha\n');
  });
});

import { history } from '@codemirror/commands';
import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import type { Author } from '../src/services/transactions';
import { WorkspaceService } from '../src/services/workspace';

/**
 * The transaction layer, exercised against real CodeMirror history.
 *
 * The state factory installs `history()` deliberately: grouped undo is built
 * on CodeMirror's own undo depths, so a test without history would pass while
 * proving nothing about the mechanism it is meant to cover.
 */
const withHistory = () => history();

const agent: Author = { kind: 'agent', sessionId: 'session-1', label: 'Test agent' };

async function setup() {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w');
  platform.seedFile('/w/a.ts', 'alpha\n');
  platform.seedFile('/w/b.ts', 'beta\n');
  platform.seedFile('/w/c.ts', 'gamma\n');

  const workspace = new WorkspaceService(platform, withHistory);
  const a = (await workspace.open('/w/a.ts'))!;
  const b = (await workspace.open('/w/b.ts'))!;
  const c = (await workspace.open('/w/c.ts'))!;
  return { platform, workspace, a, b, c };
}

/** Prepend text to a buffer, as one edit of a change set. */
const prepend = (bufferId: string, text: string) => ({
  bufferId,
  changes: { from: 0, insert: text },
});

describe('applying change sets', () => {
  it('applies edits across several buffers as one set', async () => {
    const { workspace, a, b } = await setup();

    const result = workspace.apply({
      description: 'Rename across files',
      author: agent,
      edits: [prepend(a, 'x '), prepend(b, 'y ')],
    });

    expect(result.ok).toBe(true);
    expect(workspace.textOf(a)).toBe('x alpha\n');
    expect(workspace.textOf(b)).toBe('y beta\n');
  });

  it('rejects the whole set when one buffer has moved on, touching nothing', async () => {
    const { workspace, a, b } = await setup();
    const baseRevisions = workspace.revisionsOf([a, b]);

    // Something edits `b` between the caller reading it and applying.
    workspace.applyTransaction(b, workspace.stateOf(b)!.update({ changes: { from: 0, insert: '!' } }));

    const result = workspace.apply({
      description: 'Stale set',
      author: agent,
      edits: [prepend(a, 'x '), prepend(b, 'y ')],
      baseRevisions,
    });

    expect(result).toEqual({ ok: false, reason: 'stale', buffers: [b] });
    // The point of validating first: `a` is untouched even though its own
    // revision was fine and its edit came first.
    expect(workspace.textOf(a)).toBe('alpha\n');
    expect(workspace.textOf(b)).toBe('!beta\n');
    expect(workspace.log.recent(10)).toHaveLength(0);
  });

  it('rejects a set naming a buffer that has been closed', async () => {
    const { workspace, a, b } = await setup();
    workspace.close(b, { force: true });

    const result = workspace.apply({
      description: 'Set on a closed buffer',
      author: agent,
      edits: [prepend(a, 'x '), prepend(b, 'y ')],
    });

    expect(result).toEqual({ ok: false, reason: 'missing', buffers: [b] });
    expect(workspace.textOf(a)).toBe('alpha\n');
  });

  it('refuses a range the document cannot honour, touching nothing', async () => {
    const { workspace, a, b } = await setup();

    // `b` is listed first, so a naive implementation writes it and *then*
    // throws on `a` — leaving the half-applied set this design claims is
    // impossible, with nothing in the log to undo. It did exactly that until
    // the change sets were built up front.
    const result = workspace.apply({
      description: 'Past the end',
      author: agent,
      edits: [prepend(b, 'y '), { bufferId: a, changes: { from: 9_999, insert: 'x' } }],
    });

    expect(result).toEqual({ ok: false, reason: 'invalid', buffers: [a] });
    expect(workspace.textOf(a)).toBe('alpha\n');
    expect(workspace.textOf(b)).toBe('beta\n');
    expect(workspace.log.recent(10)).toHaveLength(0);
  });

  it.each([
    ['a backwards range', { from: 4, to: 1, insert: 'x' }],
    ['a negative offset', { from: -2, insert: 'x' }],
    ['an end past the document', { from: 0, to: 9_999, insert: 'x' }],
  ])('refuses %s', async (_name, changes) => {
    const { workspace, a } = await setup();
    const result = workspace.apply({
      description: 'Malformed',
      author: agent,
      edits: [{ bufferId: a, changes }],
    });

    expect(result).toEqual({ ok: false, reason: 'invalid', buffers: [a] });
    expect(workspace.textOf(a)).toBe('alpha\n');
  });

  it('refuses two edits that overlap in the same buffer', async () => {
    const { workspace, a } = await setup();

    // CodeMirror does not reject these — it merges them into text nobody
    // asked for, which is the failure this layer exists to prevent.
    const result = workspace.apply({
      description: 'Overlapping',
      author: agent,
      edits: [
        { bufferId: a, changes: { from: 0, to: 4, insert: 'X' } },
        { bufferId: a, changes: { from: 2, to: 5, insert: 'Y' } },
      ],
    });

    expect(result).toEqual({ ok: false, reason: 'invalid', buffers: [a] });
    expect(workspace.textOf(a)).toBe('alpha\n');
  });

  it('allows edits that merely touch', async () => {
    const { workspace, a } = await setup();
    const result = workspace.apply({
      description: 'Adjacent',
      author: agent,
      edits: [
        { bufferId: a, changes: { from: 0, to: 2, insert: 'AL' } },
        { bufferId: a, changes: { from: 2, to: 5, insert: 'PHA' } },
      ],
    });

    expect(result.ok).toBe(true);
    expect(workspace.textOf(a)).toBe('ALPHA\n');
  });

  it('passes the revision check when nothing has moved', async () => {
    const { workspace, a } = await setup();
    const result = workspace.apply({
      description: 'Fresh set',
      author: agent,
      edits: [prepend(a, 'x ')],
      baseRevisions: workspace.revisionsOf([a]),
    });
    expect(result.ok).toBe(true);
  });

  it('records the author and the buffers touched', async () => {
    const { workspace, a, b } = await setup();
    workspace.apply({
      description: 'Rename across files',
      author: agent,
      edits: [prepend(a, 'x '), prepend(b, 'y ')],
    });

    const [entry] = workspace.log.recent(10);
    expect(entry?.description).toBe('Rename across files');
    expect(entry?.author).toEqual(agent);
    expect(entry?.bufferIds).toEqual([a, b]);
    expect(workspace.log.bySession('session-1')).toHaveLength(1);
  });
});

describe('grouped undo', () => {
  it('takes back every buffer in one step', async () => {
    const { workspace, a, b, c } = await setup();
    const result = workspace.apply({
      description: 'Replace across files',
      author: agent,
      edits: [prepend(a, 'x '), prepend(b, 'y '), prepend(c, 'z ')],
    });
    if (!result.ok) throw new Error('setup failed');

    const outcome = workspace.undoChangeSet(result.id);

    expect(outcome.undone).toEqual([a, b, c]);
    expect(outcome.skipped).toEqual([]);
    expect(workspace.textOf(a)).toBe('alpha\n');
    expect(workspace.textOf(b)).toBe('beta\n');
    expect(workspace.textOf(c)).toBe('gamma\n');
  });

  it('skips a buffer the user has edited since, and keeps their work', async () => {
    const { workspace, a, b } = await setup();
    const result = workspace.apply({
      description: 'Replace across files',
      author: agent,
      edits: [prepend(a, 'x '), prepend(b, 'y ')],
    });
    if (!result.ok) throw new Error('setup failed');

    // The user types in `b` after the set landed.
    workspace.applyTransaction(
      b,
      workspace.stateOf(b)!.update({ changes: { from: 0, insert: 'mine ' } }),
    );

    const outcome = workspace.undoChangeSet(result.id);

    expect(outcome.undone).toEqual([a]);
    expect(outcome.skipped).toEqual([b]);
    expect(workspace.textOf(a)).toBe('alpha\n');
    // Untouched: undoing here would have destroyed what they just typed.
    expect(workspace.textOf(b)).toBe('mine y beta\n');
  });

  it('undoes again once the later edit has itself been undone', async () => {
    const { workspace, a, b } = await setup();
    const result = workspace.apply({
      description: 'Replace across files',
      author: agent,
      edits: [prepend(a, 'x '), prepend(b, 'y ')],
    });
    if (!result.ok) throw new Error('setup failed');

    workspace.setActive(b);
    workspace.applyTransaction(
      b,
      workspace.stateOf(b)!.update({ changes: { from: 0, insert: 'mine ' } }),
    );
    expect(workspace.pendingGroupedUndo()).toBeNull();

    // Plain undo removes the typing; the change set is on top again.
    workspace.undoActive();
    expect(workspace.pendingGroupedUndo()).toBe(result.id);

    expect(workspace.undoChangeSet(result.id).undone).toEqual([a, b]);
    expect(workspace.textOf(b)).toBe('beta\n');
  });

  it('offers grouped undo only for sets spanning more than one buffer', async () => {
    const { workspace, a } = await setup();
    workspace.setActive(a);
    workspace.apply({ description: 'One file', author: agent, edits: [prepend(a, 'x ')] });

    // A single-buffer set undoes identically through CodeMirror's own command.
    expect(workspace.pendingGroupedUndo()).toBeNull();
  });

  it('redoes the whole set after a grouped undo', async () => {
    const { workspace, a, b } = await setup();
    const result = workspace.apply({
      description: 'Replace across files',
      author: agent,
      edits: [prepend(a, 'x '), prepend(b, 'y ')],
    });
    if (!result.ok) throw new Error('setup failed');

    workspace.setActive(a);
    workspace.undoChangeSet(result.id);
    expect(workspace.pendingGroupedRedo()).toBe(result.id);

    expect(workspace.redoChangeSet(result.id).undone).toEqual([a, b]);
    expect(workspace.textOf(a)).toBe('x alpha\n');
    expect(workspace.textOf(b)).toBe('y beta\n');
  });

  it('does not offer a redo once a new edit has replaced it', async () => {
    const { workspace, a, b } = await setup();
    const result = workspace.apply({
      description: 'Replace across files',
      author: agent,
      edits: [prepend(a, 'x '), prepend(b, 'y ')],
    });
    if (!result.ok) throw new Error('setup failed');

    workspace.setActive(a);
    workspace.undoChangeSet(result.id);
    workspace.applyTransaction(
      a,
      workspace.stateOf(a)!.update({ changes: { from: 0, insert: 'new ' } }),
    );

    expect(workspace.pendingGroupedRedo()).toBeNull();
  });

  it('forgets a change set whose buffer was reloaded from disk', async () => {
    const { platform, workspace, a, b } = await setup();
    const result = workspace.apply({
      description: 'Replace across files',
      author: agent,
      edits: [prepend(a, 'x '), prepend(b, 'y ')],
    });
    if (!result.ok) throw new Error('setup failed');

    // A reload replaces the state outright, taking its history with it.
    platform.seedFile('/w/a.ts', 'rewritten\n');
    await workspace.reloadFromDisk(a);

    const outcome = workspace.undoChangeSet(result.id);
    expect(outcome.skipped).toContain(a);
    expect(workspace.textOf(a)).toBe('rewritten\n');
  });
});

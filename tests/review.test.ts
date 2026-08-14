import { history } from '@codemirror/commands';
import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { ReviewService } from '../src/services/review';
import { UIService } from '../src/services/ui';
import type { Author } from '../src/services/transactions';
import { WorkspaceService } from '../src/services/workspace';

const agent: Author = { kind: 'agent', sessionId: 's1', label: 'Test agent' };

const ORIGINAL = 'one\ntwo\nthree\nfour\nfive\n';

async function setup() {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w');
  platform.seedFile('/w/a.txt', ORIGINAL);
  platform.seedFile('/w/b.txt', 'alpha\nbeta\n');

  const workspace = new WorkspaceService(platform, () => history());
  const review = new ReviewService(workspace);
  const a = (await workspace.open('/w/a.txt'))!;
  const b = (await workspace.open('/w/b.txt'))!;
  return { platform, workspace, review, a, b };
}

/** Change lines 1 and 5, leaving the middle alone: two separate hunks. */
const twoHunks = (bufferId: string) => ({
  description: 'Shout at both ends',
  author: agent,
  edits: [
    { bufferId, changes: { from: 0, to: 3, insert: 'ONE' } },
    { bufferId, changes: { from: 19, to: 23, insert: 'FIVE' } },
  ],
});

describe('staging', () => {
  it('changes nothing in the buffer', async () => {
    const { workspace, review, a } = await setup();
    const revisionBefore = workspace.revisionOf(a);

    review.stage(twoHunks(a));

    // The whole point of staging: the proposal exists, the document does not
    // know about it yet.
    expect(workspace.textOf(a)).toBe(ORIGINAL);
    expect(workspace.revisionOf(a)).toBe(revisionBefore);
    expect(workspace.log.recent(5)).toEqual([]);
  });

  it('renders the proposal as hunks against the current text', async () => {
    const { review, a } = await setup();
    const staged = review.stage(twoHunks(a))!;

    expect(staged.files).toHaveLength(1);
    expect(staged.files[0]!.hunks.map((h) => [h.displayLine, h.removed, h.added])).toEqual([
      [1, ['one\n'], ['ONE\n']],
      [5, ['five\n'], ['FIVE\n']],
    ]);
  });

  it('starts with everything accepted', async () => {
    const { review, a } = await setup();
    review.stage(twoHunks(a));

    // Review is for catching the wrong ones. Making someone tick every box to
    // get what they asked for is how a review panel gets clicked through.
    expect(review.acceptedCount()).toEqual({ hunks: 2, files: 1, total: 2 });
  });

  it('spans several buffers', async () => {
    const { review, a, b } = await setup();
    const staged = review.stage({
      description: 'Across two files',
      author: agent,
      edits: [
        { bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } },
        { bufferId: b, changes: { from: 0, to: 5, insert: 'ALPHA' } },
      ],
    })!;

    expect(staged.files.map((file) => file.name)).toEqual(['a.txt', 'b.txt']);
  });

  it('returns null for a proposal that would change nothing', async () => {
    const { review, a } = await setup();
    const staged = review.stage({
      description: 'A no-op',
      author: agent,
      edits: [{ bufferId: a, changes: { from: 0, to: 3, insert: 'one' } }],
    });

    expect(staged).toBeNull();
    expect(review.staged.get()).toBeNull();
  });
});

describe('accepting and rejecting', () => {
  it('applies exactly the accepted hunks', async () => {
    const { workspace, review, a } = await setup();
    const staged = review.stage(twoHunks(a))!;

    // Reject the first, keep the second.
    review.toggleHunk(a, staged.files[0]!.hunks[0]!.id);
    expect(review.acceptedCount().hunks).toBe(1);

    const result = review.apply();
    expect(result.ok).toBe(true);
    expect(workspace.textOf(a)).toBe('one\ntwo\nthree\nfour\nFIVE\n');
  });

  it('applies the whole proposal when everything is kept', async () => {
    const { workspace, review, a } = await setup();
    review.stage(twoHunks(a));

    expect(review.apply().ok).toBe(true);
    expect(workspace.textOf(a)).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
  });

  it('lands as one change set, so one undo takes it back', async () => {
    const { workspace, review, a } = await setup();
    review.stage(twoHunks(a));
    review.apply();

    const [entry] = workspace.log.recent(1);
    expect(entry).toMatchObject({ description: 'Shout at both ends', author: agent });

    workspace.undoChangeSet(entry!.id);
    expect(workspace.textOf(a)).toBe(ORIGINAL);
  });

  it('changes nothing when everything is rejected', async () => {
    const { workspace, review, a } = await setup();
    review.stage(twoHunks(a));
    review.setAllAccepted(false);

    expect(review.apply()).toEqual({ ok: false, reason: 'empty' });
    expect(workspace.textOf(a)).toBe(ORIGINAL);
    expect(review.staged.get()).toBeNull();
  });

  it('rejects a whole file while keeping another', async () => {
    const { workspace, review, a, b } = await setup();
    review.stage({
      description: 'Across two files',
      author: agent,
      edits: [
        { bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } },
        { bufferId: b, changes: { from: 0, to: 5, insert: 'ALPHA' } },
      ],
    });

    review.setFileAccepted(a, false);
    expect(review.apply().ok).toBe(true);

    expect(workspace.textOf(a)).toBe(ORIGINAL);
    expect(workspace.textOf(b)).toBe('ALPHA\nbeta\n');
  });

  it('handles insertions and deletions, not just replacements', async () => {
    const { workspace, review, a } = await setup();
    const staged = review.stage({
      description: 'Insert and delete',
      author: agent,
      // Drop "two", and add a line after "four".
      edits: [
        { bufferId: a, changes: { from: 4, to: 8, insert: '' } },
        { bufferId: a, changes: { from: 19, to: 19, insert: 'extra\n' } },
      ],
    })!;

    expect(staged.files[0]!.hunks.map((h) => [h.removed, h.added])).toEqual([
      [['two\n'], []],
      [[], ['extra\n']],
    ]);

    // Keep only the insertion.
    review.toggleHunk(a, staged.files[0]!.hunks[0]!.id);
    review.apply();

    expect(workspace.textOf(a)).toBe('one\ntwo\nthree\nfour\nextra\nfive\n');
  });

  it('discards without touching anything', async () => {
    const { workspace, review, a } = await setup();
    review.stage(twoHunks(a));
    review.discard();

    expect(review.staged.get()).toBeNull();
    expect(workspace.textOf(a)).toBe(ORIGINAL);
  });
});

describe('a buffer that moves during review', () => {
  it('is refused rather than overwritten', async () => {
    const { workspace, review, a } = await setup();
    review.stage(twoHunks(a));

    // The user types while the review is open.
    workspace.applyTransaction(
      a,
      workspace.stateOf(a)!.update({ changes: { from: 0, insert: '// mine\n' } }),
    );

    const result = review.apply();
    expect(result).toEqual({ ok: false, reason: 'stale', buffers: [a] });
    expect(workspace.textOf(a)).toBe(`// mine\n${ORIGINAL}`);
  });

  it('keeps the review on screen so the decisions are not lost', async () => {
    const { workspace, review, a } = await setup();
    const staged = review.stage(twoHunks(a))!;
    review.toggleHunk(a, staged.files[0]!.hunks[0]!.id);

    workspace.applyTransaction(
      a,
      workspace.stateOf(a)!.update({ changes: { from: 0, insert: '// mine\n' } }),
    );
    review.apply();

    // Throwing away someone's review decisions because a buffer moved would
    // be its own small betrayal; they can retry or discard.
    expect(review.staged.get()).not.toBeNull();
    expect(review.acceptedCount().hunks).toBe(1);
  });
});

describe('putting a review away', () => {
  it('closes to the background without deciding anything', () => {
    const ui = new UIService();
    ui.reviewOpen.set(true);

    expect(ui.hasDismissible()).toBe(true);
    expect(ui.dismissTop()).toBe(true);

    // Escape closes the panel. The staged set is untouched — the only ways to
    // resolve a review are Apply and Discard, and neither is an accident.
    expect(ui.reviewOpen.get()).toBe(false);
  });

  it('yields to anything stacked on top of it', () => {
    const ui = new UIService();
    ui.reviewOpen.set(true);
    ui.openOverlay('palette');

    ui.dismissTop();
    expect(ui.overlay.get()).toBeNull();
    expect(ui.reviewOpen.get()).toBe(true);
  });
});

import { diffText, type Hunk } from '@core/diff';
import { Signal } from '@core/signal';
import type { ApplyResult, Author, ChangeSetSpec } from './transactions';
import type { BufferId, WorkspaceService } from './workspace';

/**
 * Staged change sets and hunk-level review.
 *
 * A staged set has been **built and validated but not applied**. It is
 * rendered as a diff against each buffer's current text, and accepting or
 * rejecting works per hunk.
 *
 * The load-bearing property: rejecting hunks produces a *narrowed* change set
 * that goes through `workspace.apply` like any other. There is no second write
 * path, and nothing partially applied ever exists — the buffers do not change
 * at all until the whole reviewed result lands in one transaction.
 *
 * See AGENT-PLATFORM.md §2.3.
 */

export interface ReviewHunk extends Hunk {
  id: string;
  /** 1-based first line in the buffer, for display. */
  displayLine: number;
  accepted: boolean;
}

export interface ReviewFile {
  bufferId: BufferId;
  name: string;
  path: string | null;
  languageId: string;
  hunks: ReviewHunk[];
  /**
   * The buffer's revision when the proposal was staged. Carried into `apply`,
   * so a buffer the user edits during review is refused rather than
   * overwritten with text computed before they typed.
   */
  baseRevision: number;
}

export interface StagedChangeSet {
  description: string;
  author: Author;
  files: ReviewFile[];
}

export class ReviewService {
  /** The proposal under review, or null. One at a time, deliberately. */
  readonly staged = new Signal<StagedChangeSet | null>(null);

  #workspace: WorkspaceService;
  #nextHunkId = 1;

  constructor(workspace: WorkspaceService) {
    this.#workspace = workspace;
  }

  /**
   * Turn a proposal into a reviewable diff, changing nothing.
   *
   * The edits are applied to a *copy* of each buffer's state to find out what
   * the result would be. CodeMirror states are immutable, so this costs a
   * transaction that is computed and dropped — no dispatch, no history entry,
   * nothing on screen.
   *
   * Returns null when the proposal would change nothing, which is worth
   * distinguishing from an empty review the user has to dismiss.
   */
  stage(spec: ChangeSetSpec): StagedChangeSet | null {
    const byBuffer = new Map<BufferId, ChangeSetSpec['edits']>();
    for (const edit of spec.edits) {
      const list = byBuffer.get(edit.bufferId);
      if (list) list.push(edit);
      else byBuffer.set(edit.bufferId, [edit]);
    }

    const files: ReviewFile[] = [];
    for (const [bufferId, edits] of byBuffer) {
      const state = this.#workspace.stateOf(bufferId);
      const snapshot = this.#workspace.buffers.get().find((b) => b.id === bufferId);
      if (!state || !snapshot) continue;

      const before = state.doc.toString();
      const after = state.update({ changes: edits.map((edit) => edit.changes) }).state.doc.toString();
      const hunks = diffText(before, after);
      if (hunks.length === 0) continue;

      files.push({
        bufferId,
        name: snapshot.name,
        path: snapshot.path,
        languageId: snapshot.languageId,
        baseRevision: this.#workspace.revisionOf(bufferId),
        hunks: hunks.map((hunk) => ({
          ...hunk,
          id: `hunk-${this.#nextHunkId++}`,
          displayLine: hunk.fromLine + 1,
          // Accepted by default: review is for catching the wrong ones, and
          // making someone tick every box to get the thing they asked for is
          // how review panels end up being clicked through blind.
          accepted: true,
        })),
      });
    }

    if (files.length === 0) return null;

    const set: StagedChangeSet = { description: spec.description, author: spec.author, files };
    this.staged.set(set);
    return set;
  }

  toggleHunk(bufferId: BufferId, hunkId: string): void {
    this.#update((file) =>
      file.bufferId === bufferId
        ? {
            ...file,
            hunks: file.hunks.map((hunk) =>
              hunk.id === hunkId ? { ...hunk, accepted: !hunk.accepted } : hunk,
            ),
          }
        : file,
    );
  }

  setFileAccepted(bufferId: BufferId, accepted: boolean): void {
    this.#update((file) =>
      file.bufferId === bufferId
        ? { ...file, hunks: file.hunks.map((hunk) => ({ ...hunk, accepted })) }
        : file,
    );
  }

  setAllAccepted(accepted: boolean): void {
    this.#update((file) => ({
      ...file,
      hunks: file.hunks.map((hunk) => ({ ...hunk, accepted })),
    }));
  }

  acceptedCount(): { hunks: number; files: number; total: number } {
    const staged = this.staged.get();
    if (!staged) return { hunks: 0, files: 0, total: 0 };

    let hunks = 0;
    let files = 0;
    let total = 0;
    for (const file of staged.files) {
      const accepted = file.hunks.filter((hunk) => hunk.accepted).length;
      hunks += accepted;
      total += file.hunks.length;
      if (accepted > 0) files++;
    }
    return { hunks, files, total };
  }

  discard(): void {
    this.staged.set(null);
  }

  /**
   * Apply the accepted hunks as one change set.
   *
   * Hunks are converted back to offsets against each buffer's current
   * document, which is sound precisely because `baseRevisions` is carried
   * along: if the document had moved, `apply` refuses and these offsets are
   * never used.
   */
  apply(): ApplyResult {
    const staged = this.staged.get();
    if (!staged) return { ok: false, reason: 'empty' };

    const edits: ChangeSetSpec['edits'] = [];
    const baseRevisions = new Map<BufferId, number>();

    for (const file of staged.files) {
      const state = this.#workspace.stateOf(file.bufferId);
      if (!state) continue;

      const accepted = file.hunks.filter((hunk) => hunk.accepted);
      if (accepted.length === 0) continue;

      baseRevisions.set(file.bufferId, file.baseRevision);
      const doc = state.doc;

      for (const hunk of accepted) {
        // `splitLines` keeps terminators, so a line index is a document line
        // number minus one and none of this has to reason about newlines.
        const from = doc.line(hunk.fromLine + 1).from;
        const endLine = hunk.fromLine + hunk.removed.length;
        const to = endLine < doc.lines ? doc.line(endLine + 1).from : doc.length;
        edits.push({
          bufferId: file.bufferId,
          changes: { from, to, insert: hunk.added.join('') },
        });
      }
    }

    if (edits.length === 0) {
      this.staged.set(null);
      return { ok: false, reason: 'empty' };
    }

    const result = this.#workspace.apply({
      description: staged.description,
      author: staged.author,
      edits,
      baseRevisions,
    });

    // A rejected set stays on screen: the user has review decisions in it, and
    // throwing those away because a buffer moved would be its own small
    // betrayal. They can retry or discard.
    if (result.ok) this.staged.set(null);
    return result;
  }

  #update(map: (file: ReviewFile) => ReviewFile): void {
    this.staged.update((current) =>
      current ? { ...current, files: current.files.map(map) } : current,
    );
  }
}

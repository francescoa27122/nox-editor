import { Annotation, type ChangeSpec, type EditorSelection } from '@codemirror/state';
import { Signal } from '@core/signal';
import type { BufferId } from './workspace';

/**
 * The transaction model: who changed what, as one unit.
 *
 * Nothing here knows about agents. It exists because a project-wide replace
 * should undo in one keystroke rather than one per file, and because an edit
 * with no recorded author is an edit nobody can review. That an agent will
 * later be one of those authors is a consequence, not the reason.
 *
 * See AGENT-PLATFORM.md §2.1–2.4.
 */

/** Who produced a change set. */
export type Author =
  | { kind: 'user' }
  | { kind: 'agent'; sessionId: string; label: string }
  | { kind: 'plugin'; pluginId: string }
  | { kind: 'script'; name: string };

export type ChangeSetId = string;

/** Human-readable author, for the log and for notifications. */
export function authorLabel(author: Author): string {
  switch (author.kind) {
    case 'user':
      return 'You';
    case 'agent':
      return author.label;
    case 'plugin':
      return author.pluginId;
    case 'script':
      return author.name;
  }
}

/**
 * What a marked range knows about itself.
 *
 * Denormalised on purpose: whatever renders this never looks anything up. The
 * log below is bounded, so a change set can rotate out of it while its marks
 * are still on screen — a tooltip that went blank when that happened would be
 * its own small lie.
 */
export interface Provenance {
  changeSetId: ChangeSetId;
  authorKind: Author['kind'];
  /** `authorLabel(author)`, resolved once at record time. */
  authorLabel: string;
  description: string;
  at: number;
}

/** One buffer's worth of a change set. Several may target the same buffer. */
export interface Edit {
  bufferId: BufferId;
  changes: ChangeSpec;
  /** Where to leave the cursor. Applied only if the edit lands. */
  selection?: EditorSelection;
}

export interface ChangeSetSpec {
  /** Shown in the log and in the undo notification: "Replace across 4 files". */
  description: string;
  author: Author;
  edits: Edit[];
  /**
   * The revision each buffer is expected to be at.
   *
   * Omit for edits computed from the buffer's current state in the same tick.
   * A programmatic caller that read a buffer, went away and came back *must*
   * pass this: it is the only thing standing between a stale edit and silent
   * corruption. See `ApplyResult`'s `stale` case.
   */
  baseRevisions?: ReadonlyMap<BufferId, number>;
}

/** A change set that made it into the buffers, as recorded in the log. */
export interface AppliedChangeSet {
  id: ChangeSetId;
  description: string;
  author: Author;
  /** Every buffer the set touched, in the order it touched them. */
  bufferIds: BufferId[];
  at: number;
}

export type ApplyResult =
  | { ok: true; id: ChangeSetId; bufferIds: BufferId[] }
  /** A buffer moved on since the caller read it. Nothing was applied. */
  | { ok: false; reason: 'stale'; buffers: BufferId[] }
  /** A buffer was closed since the caller read it. Nothing was applied. */
  | { ok: false; reason: 'missing'; buffers: BufferId[] }
  /**
   * The edits do not describe a change the document can honour — an offset
   * past the end, a backwards range, two edits overlapping. Nothing was
   * applied, and nothing partially was.
   */
  | { ok: false; reason: 'invalid'; buffers: BufferId[] }
  | { ok: false; reason: 'empty' };

/**
 * Marks a transaction as belonging to a change set, and says who made it.
 *
 * Carries the whole record rather than the id alone: the attribution field in
 * `editor/provenance.ts` needs the author, and a bare id would force it to
 * reach back into the log — which is bounded, so the answer would eventually
 * be "no idea".
 */
export const changeSetAnnotation = Annotation.define<Provenance>();

/** How many applied change sets the log keeps before dropping the oldest. */
const LOG_LIMIT = 200;

/**
 * An append-only, bounded record of what has been applied.
 *
 * In memory only. Undo history does not survive a restart, so a log that did
 * would list changes it could not undo — and a button that lies is worse than
 * one that is absent.
 */
export class TransactionLog {
  readonly entries = new Signal<AppliedChangeSet[]>([]);

  #byId = new Map<ChangeSetId, AppliedChangeSet>();

  record(entry: AppliedChangeSet): void {
    this.#byId.set(entry.id, entry);
    this.entries.update((current) => {
      const next = [entry, ...current];
      // Newest first, so the tail is what falls off the end.
      for (const dropped of next.splice(LOG_LIMIT)) this.#byId.delete(dropped.id);
      return next;
    });
  }

  get(id: ChangeSetId): AppliedChangeSet | undefined {
    return this.#byId.get(id);
  }

  /** Most recent first. The context API's `recentTransactions`. */
  recent(limit: number): AppliedChangeSet[] {
    return this.entries.get().slice(0, limit);
  }

  /** Every set produced by one agent session, newest first. */
  bySession(sessionId: string): AppliedChangeSet[] {
    return this.entries
      .get()
      .filter((entry) => entry.author.kind === 'agent' && entry.author.sessionId === sessionId);
  }

  clear(): void {
    this.#byId.clear();
    this.entries.set([]);
  }
}

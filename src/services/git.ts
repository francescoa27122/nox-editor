import { diffText, type Hunk } from '@core/diff';
import { parseGitBlame, type BlameLine } from '@core/git-blame';
import { normalizeGitBase } from '@core/git-gutter';
import { parseGitBranches, parseGitStatus, type GitStatus } from '@core/git-status';
import { Signal } from '@core/signal';
import type { Platform, Unwatch } from '@platform/types';
import type { NotificationService } from './notifications';
import type { BufferId, WorkspaceService } from './workspace';

/**
 * What git holds for each open file, diffed against what the buffer says.
 *
 * The base of the comparison is the **index** (`:0:`) — the gutter's
 * question is "what have I changed that git doesn't hold yet", and for
 * anyone not mid-staging the index is HEAD anyway.
 *
 * Mid-merge there *is* no stage 0, and reading its absence as "git holds
 * nothing for this file" is what used to blank the gutter on exactly the
 * files a conflict makes hardest to read. `nox_git_file_base` now falls back
 * to stage 2 (*ours*) and then stage 1 (the merge base); stage 2 first
 * because it is the mid-merge analogue of HEAD, so the gutter keeps marking
 * what the merge proposes to add rather than the user's own committed work.
 *
 * The base text is
 * normalized the way `decode` normalizes a buffer (BOM off, CRLF → LF),
 * because the editor's document is canonical LF and an unnormalized CRLF
 * base would mark every line modified.
 *
 * **The `.git` blind spot, named:** the file watcher hard-denies `.git`,
 * so a commit, stage or branch switch emits no event at all. A checkout
 * that rewrites working files does emit, and is covered by
 * `external-change`. For the rest, the base is refetched when a buffer
 * becomes active (throttled) and on the explicit refresh command — the
 * honest answer until the stage/commit work brings real `.git` watching.
 *
 * See `docs/superpowers/specs/2026-08-19-git-gutter-design.md`.
 */

export interface BufferHunks {
  hunks: Hunk[];
  /** The buffer revision the hunks describe, read at compute time. */
  revision: number;
}

/** Above this, the diff is skipped: Myers' trace is O(D·(N+M)) memory. */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;

/**
 * Above this, blame is not asked for.
 *
 * A proxy, and knowingly so: blame's real cost is the file's *history*, not
 * its size, and nothing cheap here can measure that ahead of the walk. Size
 * is what correlates with it — a two-megabyte source file is not a file
 * anyone blames — and it also bounds the two things that are certainly
 * proportional to it: the text sent to git's stdin, and the porcelain
 * stream, larger still, that comes back.
 */
export const MAX_BLAME_BYTES = 2 * 1024 * 1024;

const DEBOUNCE_MS = 300;
const ACTIVATION_REFETCH_MS = 2000;

export class GitService {
  /** Hunks per buffer. No entry means no repo, no changes, or too large. */
  readonly hunks = new Signal<ReadonlyMap<BufferId, BufferHunks>>(new Map());
  /**
   * Bumped whenever a base is fetched or forgotten. The hunks signal is
   * silent when a *clean* file's base arrives — nothing changed in it — but
   * the diff view still has to move from "asking git" to "no changes", and
   * this is what it watches.
   */
  readonly baseRevision = new Signal(0);

  /**
   * The working state: branch, staged, unstaged. Null before the first
   * answer, over no root, and over a folder that is not a repository — the
   * panel words each of those from its own context.
   */
  readonly status = new Signal<GitStatus | null>(null);

  /**
   * Blamed lines for the buffers blame is switched *on* for.
   *
   * **An entry is the switch.** Present means the gutter is showing for that
   * buffer, absent means it is not — there is no second flag to disagree
   * with this one. The array is empty between the toggle and git's first
   * answer, and stays empty when git had none, so a file outside a
   * repository turns the gutter on and shows nothing rather than refusing:
   * absence is this service's degraded state everywhere else too.
   *
   * Per buffer, never global. "On demand, not always on" is the row's whole
   * constraint (ROADMAP v0.5), and a global switch would spawn a `git blame`
   * for every file the user opened afterwards, including the ones they only
   * tabbed through.
   */
  readonly blame = new Signal<ReadonlyMap<BufferId, readonly BlameLine[]>>(new Map());

  #platform: Platform;
  #workspace: WorkspaceService;
  #notifications: NotificationService | undefined;
  /** path -> normalized index text, or null when git has nothing for it. */
  #bases = new Map<string, string | null>();
  /** What each buffer was last computed at, to skip no-op recomputes. */
  #computed = new Map<BufferId, number>();
  #timers = new Map<BufferId, ReturnType<typeof setTimeout>>();
  /** path -> when its base was last refetched on activation. */
  #refetched = new Map<string, number>();
  #unsubscribes: (() => void)[] = [];
  #started = false;
  #statusInFlight = false;
  #statusQueued = false;
  #metaUnwatch: Unwatch | null = null;
  #metaTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(platform: Platform, workspace: WorkspaceService, notifications?: NotificationService) {
    this.#platform = platform;
    this.#workspace = workspace;
    this.#notifications = notifications;
  }

  /** Whether `start()` has run — what the commands gate on, LSP-style. */
  get started(): boolean {
    return this.#started;
  }

  /**
   * Subscribe and compute for what is already open.
   *
   * The app calls this only when `capabilities.gitState` holds; tests call
   * it directly over a `MemoryPlatform` with seeded bases — the language
   * server pattern.
   */
  start(): void {
    if (this.#started) return;
    this.#started = true;

    const workspace = this.#workspace;

    this.#unsubscribes.push(
      // The buffer list is republished on every document change, which is
      // exactly the cadence a gutter needs — debounced per buffer below.
      workspace.buffers.subscribe(() => this.#reconcile()),
      workspace.events.on('buffer-opened', ({ id }) => void this.#refresh(id)),
      workspace.events.on('saved', ({ id }) => {
        void this.#refresh(id);
        void this.refreshStatus();
        // Saving is the one edit that can change blame's answer without
        // touching `.git`: the lines that were "uncommitted" a moment ago
        // are still uncommitted, but every line's *position* is now what git
        // will see, so this is where a blame taken mid-edit stops being an
        // approximation. Only for a buffer blame is already on for — the
        // switch stays where the user put it.
        void this.#refreshBlame(id);
      }),
      workspace.events.on('buffer-reset', ({ id }) => void this.#refresh(id)),
      workspace.events.on('external-change', ({ id }) => {
        void this.#refresh(id);
        void this.refreshStatus();
        void this.#refreshBlame(id);
      }),
      workspace.events.on('buffer-closed', ({ id }) => this.#drop(id)),
      // "Committed in the terminal, tabbed back" — nothing watches .git, so
      // the moment a buffer is looked at again is the moment to re-ask.
      workspace.activeId.subscribe((id) => {
        if (id) void this.#refetchOnActivation(id);
      }),
      workspace.rootPath.subscribe((root) => {
        this.#reset();
        void this.refreshStatus();
        void this.#watchMeta(root);
      }),
    );
  }

  /**
   * The normalized index text for `path`: `undefined` not fetched yet,
   * `null` git has nothing, a string otherwise. The diff view reads this
   * rather than fetching — the service's triggers own freshness, and the
   * view inherits the gutter's staleness story, `.git` blind spot included.
   */
  baseFor(path: string): string | null | undefined {
    return this.#bases.get(path);
  }

  /**
   * Forget every base and re-ask git about every open file.
   *
   * Blame goes with it, for the buffers it is on for: this runs after a
   * stage or commit and on a `.git` change, and a commit is precisely the
   * event that turns a run of "uncommitted" lines into somebody's. Buffers
   * blame is *off* for are still not asked about — the switch is the user's,
   * and a refresh must not turn it on.
   */
  async refreshAll(): Promise<void> {
    this.#bases.clear();
    this.#refetched.clear();
    await Promise.all([
      ...this.#workspace.fileBuffers().map(({ id }) => this.#refresh(id)),
      ...[...this.blame.get().keys()].map((id) => this.#refreshBlame(id)),
    ]);
  }

  /** Whether the blame gutter is showing for `id`. */
  blameShown(id: BufferId): boolean {
    return this.blame.get().has(id);
  }

  /**
   * Switch blame on or off for `id`, fetching on the way on.
   *
   * The only entry point, and deliberately the only one: nothing else in
   * this service ever *starts* a blame, so a file nobody asked about never
   * costs a `git blame`. That is the whole of the row's "on demand, not
   * always on".
   *
   * The empty array goes in before the fetch so the gutter appears with the
   * keystroke rather than after git answers — on a large repository that is
   * the difference between a toggle and a toggle that seems not to have
   * worked.
   */
  async toggleBlame(id: BufferId): Promise<void> {
    if (this.blameShown(id)) {
      this.#setBlame(id, null);
      return;
    }
    this.#setBlame(id, []);
    await this.#refreshBlame(id);
  }

  /**
   * Re-ask git for every buffer blame is on for. What the palette's refresh
   * reaches; `refreshAll` does the same as part of its own job.
   */
  async refreshBlame(): Promise<void> {
    await Promise.all([...this.blame.get().keys()].map((id) => this.#refreshBlame(id)));
  }

  /**
   * Ask git to blame `id`'s current text, and paint the answer.
   *
   * `retry` exists for one race and closes it: the answer describes the text
   * as it was when the request went out, and if the user typed a *line* in
   * the meantime every annotation below it is off by one until the next
   * save. One re-request, and only when the revision actually moved, costs at
   * most a second `git blame` per trigger and converges the moment typing
   * stops. It cannot become a loop: nothing here is triggered by an edit, so
   * a second stale answer is simply painted and corrected at the next save.
   */
  async #refreshBlame(id: BufferId, retry = true): Promise<void> {
    // Off, or never on. Blame is never fetched for a buffer nobody asked
    // about, and this is the check that guarantees it.
    if (!this.blameShown(id)) return;

    const path = this.#pathOf(id);
    const text = this.#workspace.textOf(id);
    if (!path || text === undefined) return;
    if (text.length > MAX_BLAME_BYTES) {
      this.#setBlame(id, []);
      return;
    }

    const requestedAt = this.#workspace.revisionOf(id);
    let raw: string | null;
    try {
      raw = await this.#platform.gitBlame(path, text);
    } catch {
      // The platform contract says a file with no blame answers null, but a
      // broken seam must degrade to an empty gutter, never to an error.
      raw = null;
    }

    // Switched off, or the buffer closed, while git was working. Painting
    // now would put a gutter back that the user has already dismissed.
    if (!this.blameShown(id)) return;

    if (retry && this.#workspace.revisionOf(id) !== requestedAt) {
      await this.#refreshBlame(id, false);
      return;
    }

    this.#setBlame(id, raw === null ? [] : parseGitBlame(raw));
  }

  /** Set, or delete when `lines` is null. Null is "blame is off for this". */
  #setBlame(id: BufferId, lines: readonly BlameLine[] | null): void {
    const current = this.blame.get();
    if (lines === null && !current.has(id)) return;
    const next = new Map(current);
    if (lines === null) next.delete(id);
    else next.set(id, lines);
    this.blame.set(next);
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribes.splice(0)) unsubscribe();
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    if (this.#metaTimer) clearTimeout(this.#metaTimer);
    this.#metaTimer = null;
    this.#metaUnwatch?.();
    this.#metaUnwatch = null;
    this.#reset();
    this.#started = false;
  }

  /** Fire every pending debounce now — for tests and for jump-to-hunk later. */
  flush(): void {
    for (const [id, timer] of this.#timers) {
      clearTimeout(timer);
      this.#timers.delete(id);
      this.#compute(id);
    }
  }

  #reset(): void {
    this.#bases.clear();
    this.#computed.clear();
    this.#refetched.clear();
    this.hunks.set(new Map());
    this.baseRevision.update((n) => n + 1);
    this.status.set(null);
    // A new root is a new repository; every blame on screen described the
    // old one, and the switches went with it.
    this.blame.set(new Map());
  }

  #drop(id: BufferId): void {
    const timer = this.#timers.get(id);
    if (timer) clearTimeout(timer);
    this.#timers.delete(id);
    this.#computed.delete(id);
    // Closing the tab switches blame off with it. A buffer id is not reused,
    // so a surviving entry would be a leak rather than a restored setting.
    this.#setBlame(id, null);
    const current = this.hunks.get();
    if (current.has(id)) {
      const next = new Map(current);
      next.delete(id);
      this.hunks.set(next);
    }
  }

  /** Debounce changed buffers; a buffer whose revision moved gets a timer. */
  #reconcile(): void {
    for (const buffer of this.#workspace.buffers.get()) {
      if (!buffer.path) continue;
      if (!this.#bases.has(buffer.path)) continue; // No base yet; #refresh owns the first fetch.
      if (this.#computed.get(buffer.id) === buffer.revision) continue;
      if (this.#timers.has(buffer.id)) continue;
      this.#timers.set(
        buffer.id,
        setTimeout(() => {
          this.#timers.delete(buffer.id);
          // Text and revision are read at fire time, not schedule time, so
          // the hunks are labelled with the revision they actually describe.
          this.#compute(buffer.id);
        }, DEBOUNCE_MS),
      );
    }
  }

  /** Refetch the base for `id`'s path, then recompute its hunks. */
  async #refresh(id: BufferId): Promise<void> {
    const path = this.#pathOf(id);
    if (!path) return;
    let base: string | null;
    try {
      base = await this.#platform.gitFileBase(path);
    } catch {
      // The platform contract says failures are nulls, but a broken seam
      // must degrade to "no gutter", never to an error surface.
      base = null;
    }
    this.#bases.set(path, base === null ? null : normalizeGitBase(base));
    this.baseRevision.update((n) => n + 1);
    this.#compute(id);
  }

  async #refetchOnActivation(id: BufferId): Promise<void> {
    const path = this.#pathOf(id);
    if (!path) return;
    const last = this.#refetched.get(path) ?? 0;
    const now = Date.now();
    if (now - last < ACTIVATION_REFETCH_MS) return;
    this.#refetched.set(path, now);
    void this.refreshStatus();
    await this.#refresh(id);
  }

  /**
   * The `.git` meta watch — spec §5. Debounced 300 ms (a rebase in the
   * terminal fires dozens), then status + bases. A watch that cannot be
   * established is swallowed: this is a fast path, and the activation
   * refetch and the palette refresh remain the load-bearing ones.
   */
  async #watchMeta(root: string | null): Promise<void> {
    this.#metaUnwatch?.();
    this.#metaUnwatch = null;
    if (!root) return;
    try {
      this.#metaUnwatch = await this.#platform.watchGitMeta(root, () => this.#onMetaChange());
    } catch {
      /* No watcher on this platform or this root; the slow paths remain. */
    }
  }

  #onMetaChange(): void {
    if (this.#metaTimer) clearTimeout(this.#metaTimer);
    this.#metaTimer = setTimeout(() => {
      this.#metaTimer = null;
      void this.refreshStatus();
      void this.refreshAll();
    }, DEBOUNCE_MS);
  }

  /**
   * Re-ask git for the working state. Coalesced: one refresh in flight at a
   * time, and any number of requests arriving meanwhile queue exactly one
   * more — the second answer is already computed from the state the burst
   * produced, so a third would learn nothing.
   *
   * Mutation check (task 10): disabling `this.#statusQueued = true` — a
   * concurrent call arriving while one is in flight no longer queues a
   * follow-up — turned
   * 'coalesces concurrent refreshes: one in flight, one queued, not N' red
   * (`tests/git-service.test.ts`, expected 2 calls, got 1); restored, suite
   * green.
   */
  async refreshStatus(): Promise<void> {
    if (this.#statusInFlight) {
      this.#statusQueued = true;
      return;
    }
    this.#statusInFlight = true;
    try {
      const root = this.#workspace.rootPath.get();
      if (!root) {
        this.status.set(null);
        return;
      }
      const raw = await this.#platform.gitStatus(root);
      this.status.set(parseGitStatus(raw));
    } catch {
      // Not a repository (or git absent). For a *read*, absence is the
      // honest degraded state — refusals only matter for writes.
      this.status.set(null);
    } finally {
      this.#statusInFlight = false;
      if (this.#statusQueued) {
        this.#statusQueued = false;
        void this.refreshStatus();
      }
    }
  }

  /** Local branches, parsed. Empty when git has no answer. */
  async listBranches(): Promise<string[]> {
    const root = this.#workspace.rootPath.get();
    if (!root) return [];
    try {
      return parseGitBranches(await this.#platform.gitBranches(root));
    } catch {
      return [];
    }
  }

  /**
   * One write, one shape: try, surface a refusal verbatim as a notification,
   * refresh regardless — the panel never shows a state its own action made
   * stale, and after a failure the refresh shows the truth (envelope §6, §4).
   */
  async #write(action: () => Promise<void>): Promise<boolean> {
    let ok = true;
    try {
      await action();
    } catch (error) {
      ok = false;
      this.#notifications?.error(error instanceof Error ? error.message : String(error));
    }
    await this.refreshStatus();
    await this.refreshAll();
    return ok;
  }

  /** `git add` by name. Absolute paths; the platform relativizes. */
  async stage(paths: string[]): Promise<void> {
    const root = this.#workspace.rootPath.get();
    if (!root) return;
    await this.#write(() => this.#platform.gitStage(root, paths));
  }

  /** `git reset -- <pathspec>` by name. The index only, by construction. */
  async unstage(paths: string[]): Promise<void> {
    const root = this.#workspace.rootPath.get();
    if (!root) return;
    await this.#write(() => this.#platform.gitUnstage(root, paths));
  }

  /**
   * `git commit --file=-` — commits the index, never `-a`, never pathspecs
   * (envelope §5): the staged list on screen is the commit preview. Returns
   * `"<short-hash> <subject>"`, or null after a refusal (already surfaced).
   */
  async commit(message: string): Promise<string | null> {
    const root = this.#workspace.rootPath.get();
    if (!root) return null;
    let result: string | null = null;
    const ok = await this.#write(async () => {
      result = await this.#platform.gitCommit(root, message);
    });
    return ok ? result : null;
  }

  /**
   * `git switch <name>` / `git switch -c <name>` (spec §2). A refusal —
   * dirty conflicting files, an invalid name — is git's to make and ours to
   * show verbatim; we never pass -f (envelope §4).
   */
  async switch(name: string, create: boolean): Promise<void> {
    const root = this.#workspace.rootPath.get();
    if (!root) return;
    await this.#write(() => this.#platform.gitSwitch(root, name, create));
  }

  #pathOf(id: BufferId): string | null {
    return this.#workspace.buffers.get().find((b) => b.id === id)?.path ?? null;
  }

  #compute(id: BufferId): void {
    const path = this.#pathOf(id);
    const text = this.#workspace.textOf(id);
    if (!path || text === undefined) return;

    const base = this.#bases.get(path);
    const revision = this.#workspace.revisionOf(id);
    this.#computed.set(id, revision);

    const current = this.hunks.get();

    if (
      base === null ||
      base === undefined ||
      base.length > MAX_DIFF_BYTES ||
      text.length > MAX_DIFF_BYTES
    ) {
      if (!current.has(id)) return;
      const next = new Map(current);
      next.delete(id);
      this.hunks.set(next);
      return;
    }

    const hunks = diffText(base, text);
    if (hunks.length === 0 && !current.has(id)) return;
    const next = new Map(current);
    if (hunks.length === 0) next.delete(id);
    else next.set(id, { hunks, revision });
    this.hunks.set(next);
  }
}

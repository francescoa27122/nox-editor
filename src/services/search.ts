import { basename, dirname, relative } from '@core/path';
import { computeReplacements, expandReplacement, preserveCase } from '@core/replace';
import { buildSearchRegex, findMatches, type LineMatch } from '@core/search-match';
import { Signal } from '@core/signal';
import type { Platform, SearchFileResult, SearchSummary } from '@platform/types';
import type { JobRunner } from './jobs';
import type { ChangeSetId, Edit } from './transactions';
import type { BufferId, WorkspaceService } from './workspace';

/**
 * Project-wide search.
 *
 * Owns the query, the options, and the accumulated results. The heavy lifting
 * happens in the platform layer; this service is about *presentation state* —
 * what is expanded, what is focused, and when to start a new search.
 *
 * Results are exposed both grouped (for rendering) and flattened (for keyboard
 * navigation), because a results tree that you cannot drive with the arrow
 * keys is only half a feature in a keyboard-first editor.
 */

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  preserveCase: boolean;
  includes: string;
  excludes: string;
  respectGitIgnore: boolean;
}

export type SearchStatus = 'idle' | 'searching' | 'done';

export interface SearchRow {
  kind: 'file' | 'match';
  /** Index into `results`. */
  fileIndex: number;
  /** Index into `results[fileIndex].matches`; -1 for a file row. */
  matchIndex: number;
}

/** Stop after this many matches; the UI says so rather than pretending. */
const MAX_RESULTS = 5000;
const MAX_FILE_SIZE = 8 * 1024 * 1024;
const DEBOUNCE_MS = 220;
/** Below this, auto-search would just churn on every keystroke. */
const MIN_AUTO_QUERY = 2;
/** Job keys. Starting one of these cancels the previous run of the same kind. */
const SEARCH_JOB = 'search.project';
const REPLACE_JOB = 'search.replace';

export class SearchService {
  readonly query = new Signal('');
  readonly options = new Signal<SearchOptions>({
    caseSensitive: false,
    wholeWord: false,
    regexp: false,
    preserveCase: false,
    includes: '',
    excludes: '',
    respectGitIgnore: true,
  });

  readonly results = new Signal<SearchFileResult[]>([]);
  readonly status = new Signal<SearchStatus>('idle');
  readonly summary = new Signal<SearchSummary | null>(null);
  readonly collapsed = new Signal<ReadonlySet<string>>(new Set());
  /**
   * Matches the user has taken out of the replace, by identity.
   *
   * **Never by index.** `#replacePaths` recomputes from the file's current
   * text rather than trusting the stored result rows — that is what stops a
   * replace using stale coordinates for a file edited since the search — so
   * index 3 of the results and index 3 of the text being replaced are the same
   * match only while nothing has moved. The key is the path, the line, and the
   * *absolute* column, which is what `findMatches` will report again from the
   * same walk `computeReplacements` performs.
   *
   * Public so the panel can tell a dismissed run from an empty one; nothing
   * outside this service constructs a key.
   */
  readonly dismissed = new Signal<ReadonlySet<string>>(new Set());
  /** Index into `rows()`, or -1. Drives keyboard navigation. */
  readonly focused = new Signal(-1);

  #platform: Platform;
  #workspace: WorkspaceService;
  #jobs: JobRunner;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The change set the last replace produced across open buffers, if any.
   * Closed files are covered by `lastReplace`'s journal instead — they have no
   * buffer, so there is no undo history to put them in.
   */
  #lastReplaceSet: ChangeSetId | null = null;

  constructor(platform: Platform, workspace: WorkspaceService, jobs: JobRunner) {
    this.#platform = platform;
    this.#workspace = workspace;
    this.#jobs = jobs;
  }

  get available(): boolean {
    return this.#platform.capabilities.projectSearch;
  }

  setQuery(text: string): void {
    this.query.set(text);
    this.#scheduleRun();
  }

  setOption<K extends keyof SearchOptions>(key: K, value: SearchOptions[K]): void {
    this.options.update((current) => ({ ...current, [key]: value }));
    this.#scheduleRun();
  }

  toggle(key: 'caseSensitive' | 'wholeWord' | 'regexp' | 'preserveCase' | 'respectGitIgnore'): void {
    this.setOption(key, !this.options.get()[key]);
  }

  /** Seed from the editor's selection, the way ⌘⇧F does everywhere else. */
  seed(text: string): void {
    if (text.length === 0 || text.includes('\n')) return;
    this.query.set(text);
    this.#scheduleRun({ immediate: true });
  }

  #scheduleRun(options: { immediate?: boolean } = {}): void {
    if (this.#timer) clearTimeout(this.#timer);

    const query = this.query.get();
    if (query.length === 0) {
      this.cancel();
      this.results.set([]);
      this.summary.set(null);
      this.status.set('idle');
      return;
    }

    if (!options.immediate && query.length < MIN_AUTO_QUERY) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.run();
    }, options.immediate ? 0 : DEBOUNCE_MS);
  }

  /** Start a search now, superseding any in flight. */
  async run(): Promise<void> {
    const root = this.#workspace.rootPath.get();
    const query = this.query.get();
    if (!root || query.length === 0 || !this.available) return;

    this.#cancelTimer();

    this.results.set([]);
    this.summary.set(null);
    this.collapsed.set(new Set());
    this.focused.set(-1);
    // A new search is a new question: the matches these exclusions named do
    // not exist any more, whatever the new results turn out to be.
    this.dismissed.set(new Set());
    this.status.set('searching');
    // A fresh search invalidates the undo: its journal describes files that
    // the new results no longer correspond to.
    this.lastReplace.set(null);
    this.#lastReplaceSet = null;

    const options = this.options.get();
    let matched = 0;

    // Keyed, so starting this search cancels whichever one was already
    // walking. That used to be a generation counter checked by hand in the
    // batch callback; the runner does it once, for everything.
    const job = this.#jobs.run(
      { title: `Searching for "${query}"`, key: SEARCH_JOB },
      async (context) => {
        const handle = await this.#platform.searchProject(
          root,
          {
            query,
            caseSensitive: options.caseSensitive,
            wholeWord: options.wholeWord,
            regexp: options.regexp,
            includes: splitPatterns(options.includes),
            excludes: splitPatterns(options.excludes),
            respectGitIgnore: options.respectGitIgnore,
            maxResults: MAX_RESULTS,
            maxFileSize: MAX_FILE_SIZE,
          },
          (files) => {
            // A batch that arrives after cancellation belongs to a search the
            // user has already moved on from.
            if (context.cancelled) return;
            this.results.update((current) => [...current, ...files]);
            matched += files.reduce((sum, file) => sum + file.matches.length, 0);
            context.report({ done: matched, message: files.at(-1)?.path });
          },
        );

        // Registered after the await on purpose, and safe because `onCancel`
        // fires immediately when cancellation already happened — otherwise
        // cancelling during this await would never reach the Rust walker.
        context.onCancel(() => handle.cancel());
        return handle.done;
      },
    );

    const outcome = await job.result;
    // A superseded or cancelled search must not touch the panel: the state it
    // would be describing belongs to a search nobody is waiting for.
    if (outcome.status !== 'done') return;

    this.summary.set(outcome.value);
    this.status.set('done');
  }

  /**
   * Stop the search in flight and forget its results.
   *
   * Cancelling leaves the panel as though the search had not been started,
   * rather than showing however far it happened to get.
   */
  cancel(): void {
    this.#cancelTimer();
    this.#jobs.cancelActive(SEARCH_JOB);
    if (this.status.get() === 'searching') {
      this.results.set([]);
      this.summary.set(null);
      this.focused.set(-1);
      this.status.set('idle');
    }
  }

  #cancelTimer(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  clear(): void {
    this.cancel();
    this.query.set('');
    this.results.set([]);
    this.summary.set(null);
    this.collapsed.set(new Set());
    this.focused.set(-1);
    this.dismissed.set(new Set());
    this.status.set('idle');
  }

  toggleFile(path: string): void {
    this.collapsed.update((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  collapseAll(): void {
    this.collapsed.set(new Set(this.results.get().map((file) => file.path)));
  }

  expandAll(): void {
    this.collapsed.set(new Set());
  }

  /** Remove one file's results — the "dismiss" affordance on a result group. */
  dismissFile(path: string): void {
    this.results.update((current) => current.filter((file) => file.path !== path));
    this.focused.set(-1);
  }

  /**
   * Remove one match, and keep any later replace off it.
   *
   * Two effects, deliberately in one call. Taking the row out of `results` is
   * what makes the panel's counts follow — they read `results` and nothing
   * else, so there is no second tally to keep in step — and recording the
   * identity is what makes a replace of the *rest of the file* skip it. A file
   * whose last match is dismissed leaves the results entirely, exactly as
   * `dismissFile` would have left it.
   */
  dismissMatch(path: string, match: MatchPosition): void {
    const key = matchKey(path, match);
    this.dismissed.update((current) => new Set(current).add(key));
    this.results.update((current) =>
      current
        .map((file) =>
          file.path === path
            ? { ...file, matches: file.matches.filter((row) => matchKey(path, row) !== key) }
            : file,
        )
        .filter((file) => file.matches.length > 0),
    );
    this.focused.set(-1);
  }

  /** Flattened, collapse-aware row list. The axis for keyboard navigation. */
  rows(): SearchRow[] {
    const collapsed = this.collapsed.get();
    const rows: SearchRow[] = [];

    this.results.get().forEach((file, fileIndex) => {
      rows.push({ kind: 'file', fileIndex, matchIndex: -1 });
      if (collapsed.has(file.path)) return;
      file.matches.forEach((_, matchIndex) => {
        rows.push({ kind: 'match', fileIndex, matchIndex });
      });
    });

    return rows;
  }

  /**
   * The focused row resolved to what it points at, or null.
   *
   * `rows()` returns indices into two arrays, which is right for rendering and
   * wrong for every command: a caller that has to re-derive the file and the
   * match from a `SearchRow` has to know the shape of `results` to do it, and
   * would get it subtly wrong the first time a row was focused after a
   * dismissal.
   */
  focusedRow(): FocusedResult | null {
    const row = this.rows()[this.focused.get()];
    if (!row) return null;
    const file = this.results.get()[row.fileIndex];
    if (!file) return null;
    if (row.kind === 'file') return { kind: 'file', path: file.path };
    const match = file.matches[row.matchIndex];
    return match ? { kind: 'match', path: file.path, match } : null;
  }

  moveFocus(delta: number): void {
    const rows = this.rows();
    if (rows.length === 0) return;
    const current = this.focused.get();
    const next = current === -1 ? (delta > 0 ? 0 : rows.length - 1) : current + delta;
    this.focused.set(Math.max(0, Math.min(rows.length - 1, next)));
  }

  /** Open the focused row: a match jumps to it; a file toggles its group. */
  async activateFocused(): Promise<void> {
    const row = this.rows()[this.focused.get()];
    if (!row) return;

    const file = this.results.get()[row.fileIndex];
    if (!file) return;

    if (row.kind === 'file') {
      this.toggleFile(file.path);
      return;
    }
    await this.openMatch(file.path, file.matches[row.matchIndex]);
  }

  /** Open a file at a specific match. */
  async openMatch(
    path: string,
    match: { line: number; column: number; previewOffset: number } | undefined,
  ): Promise<void> {
    if (!match) return;
    const id = await this.#workspace.open(path);
    if (!id) return;
    // `column` is relative to the preview, which may have been windowed.
    this.onReveal?.(match.line, match.previewOffset + match.column + 1);
  }

  /** Set by the app to move the editor cursor; keeps this service view-free. */
  onReveal: ((line: number, column: number) => void) | null = null;

  // --- Replace -------------------------------------------------------------

  readonly replacement = new Signal('');
  readonly replaceMode = new Signal(false);
  /** The last replace, for a one-shot undo. Cleared when a new search runs. */
  readonly lastReplace = new Signal<ReplaceRecord[] | null>(null);

  setReplacement(text: string): void {
    this.replacement.set(text);
  }

  showReplace(show: boolean): void {
    this.replaceMode.set(show);
  }

  /**
   * What one match will look like after replacement, for the preview row.
   *
   * Groups are resolved by matching the pattern *at* the match's own column,
   * and the result is shown only when it reproduces exactly what the search
   * reported. Anything less certain returns null, and the row shows no
   * preview: this is the input to the most destructive feature in the app, so
   * a preview that disagrees with the write is worse than no preview at all.
   */
  previewReplacement(match: { preview: string; column: number; length: number }): string | null {
    const template = this.replacement.get();
    const options = this.options.get();
    // Same string a `computeReplacements` call would shape the case against —
    // the matched text itself, not the pattern that found it.
    const matched = match.preview.slice(match.column, match.column + match.length);

    if (!options.regexp) {
      return options.preserveCase ? preserveCase(matched, template) : template;
    }

    let matcher: RegExp;
    try {
      const base = buildSearchRegex(this.query.get(), options);
      // Sticky, so the group is resolved *at* the match's own column rather
      // than by rescanning the preview for it. A long line's preview is a
      // window that starts mid-line, and rescanning that window realigns the
      // matches -- `a{7}` from a lead of 143 lands on 56, 63, 70, never on the
      // match's column 60 -- so a scan can miss the very match it was handed.
      matcher = new RegExp(base.source, `${base.flags}y`);
    } catch {
      return null;
    }

    matcher.lastIndex = match.column;
    const found = matcher.exec(match.preview);
    // Only a match that reproduces exactly what the search reported can be
    // previewed honestly. A window can truncate a long match, and results can
    // outlive the query that found them; in both cases the row shows no
    // preview rather than a template the write will not produce. A zero-width
    // match is rejected by the same check, since search never reports one.
    if (!found || found[0].length !== match.length) return null;

    const expanded = expandReplacement(template, found, true);
    return options.preserveCase ? preserveCase(found[0], expanded) : expanded;
  }

  /**
   * The text a replace should operate on.
   *
   * An open buffer wins over the file on disk. The search results came from
   * disk, so replacing disk text under a buffer with unsaved edits would throw
   * that work away — the buffer is what the user believes the file contains.
   */
  async #sourceTextFor(path: string): Promise<{ text: string; bufferId: string | null } | null> {
    const buffer = this.#workspace.buffers.get().find((candidate) => candidate.path === path);
    if (buffer) {
      const text = this.#workspace.textOf(buffer.id);
      if (text !== undefined) return { text, bufferId: buffer.id };
    }

    try {
      return { text: await this.#platform.readTextFile(path), bufferId: null };
    } catch {
      return null;
    }
  }

  /**
   * Which match indices this file's replace must leave alone, or null.
   *
   * Null means "an exclusion names a match this text does not have" — the
   * file has moved under it, and the caller refuses rather than guessing.
   *
   * Indices come from walking the *current* text with `findMatches`, which is
   * the same loop `computeReplacements` runs — same split, same `exec` order,
   * same zero-width rule — so the nth match here and the nth skip index there
   * are the same match by construction. Nothing here trusts the result rows.
   */
  #skipFor(
    path: string,
    text: string,
    matcher: RegExp,
    only: string | undefined,
  ): Set<number> | null {
    const dismissed = this.dismissed.get();
    const wanted = only !== undefined;
    // The common path: nothing dismissed and no single target, so no second
    // walk of the file and no way to refuse it.
    if (!wanted && ![...dismissed].some((key) => key.startsWith(`${path}\u0000`))) {
      return new Set();
    }

    const found = findMatches(text, matcher);
    const skip = new Set<number>();
    const located = new Set<string>();
    let kept = 0;

    found.forEach((match, index) => {
      const key = matchKey(path, match);
      if (wanted) {
        if (key === only) {
          located.add(key);
          kept++;
        } else {
          skip.add(index);
        }
        return;
      }
      if (dismissed.has(key)) {
        located.add(key);
        skip.add(index);
      }
    });

    if (wanted) return kept === 1 ? skip : null;

    const expected = [...dismissed].filter((key) => key.startsWith(`${path}\u0000`));
    return located.size === expected.length ? skip : null;
  }

  /** Write new contents, through the editor when the file is open. */
  async #writeText(path: string, text: string, bufferId: string | null): Promise<boolean> {
    if (bufferId) {
      const wasDirty = this.#workspace.buffers.get().find((b) => b.id === bufferId)?.isDirty;
      this.#workspace.replaceContents(bufferId, text);
      // A file that was in sync with disk stays in sync; one with unsaved
      // edits keeps them, and stays the user's to save.
      if (!wasDirty) await this.#workspace.save(bufferId);
      return true;
    }

    try {
      await this.#platform.writeTextFile(path, text);
      return true;
    } catch {
      return false;
    }
  }

  /** Replace every match in one file. Returns how many were replaced. */
  async replaceInFile(path: string): Promise<number> {
    const outcome = await this.#replacePaths([path]);
    return outcome.matches;
  }

  /**
   * Replace exactly one match. Returns 1, or 0 when it could not be found.
   *
   * `skip` inverted — every index in the file except this one — over the same
   * recomputed walk everything else uses, which is why it costs a method
   * rather than a mechanism and why it inherits the staleness refusal for
   * free: a match that is no longer where it was does nothing at all rather
   * than replacing whatever moved into its place.
   */
  async replaceMatch(path: string, match: MatchPosition): Promise<number> {
    const outcome = await this.#replacePaths([path], { only: matchKey(path, match) });
    return outcome.matches;
  }

  /** Replace every match in every result. */
  async replaceAll(): Promise<ReplaceOutcome> {
    return this.#replacePaths(this.results.get().map((file) => file.path));
  }

  /** How many matches a replace-all would affect right now. */
  pendingReplaceCount(): { files: number; matches: number } {
    const results = this.results.get();
    return {
      files: results.length,
      matches: results.reduce((sum, file) => sum + file.matches.length, 0),
    };
  }

  async #replacePaths(
    paths: readonly string[],
    scope: { only?: string } = {},
  ): Promise<ReplaceOutcome> {
    const query = this.query.get();
    const options = this.options.get();
    if (query.length === 0 || paths.length === 0) {
      return { files: 0, matches: 0, failed: [] };
    }

    let matcher: RegExp;
    try {
      matcher = buildSearchRegex(query, options);
    } catch {
      return { files: 0, matches: 0, failed: [] };
    }

    const replacement = this.replacement.get();
    const only = scope.only;

    /**
     * The walk runs as a job and **writes nothing**. It reads every file,
     * computes the new text, and hands back a plan; applying it happens below,
     * on the main path. That is what makes cancelling a replace safe without a
     * per-step correctness argument — there is nothing to unwind, because
     * nothing has been changed yet.
     */
    const job = this.#jobs.run(
      { title: `Replacing "${query}"`, key: REPLACE_JOB },
      async (context) => {
        const journal: ReplaceRecord[] = [];
        const failed: string[] = [];
        const edits: Edit[] = [];
        /** Buffers that matched disk beforehand, and should still match after. */
        const saveAfter: BufferId[] = [];
        const diskWrites: { path: string; text: string }[] = [];
        /** What each buffer was at when its replacement was computed. */
        const baseRevisions = new Map<BufferId, number>();
        let matches = 0;

        for (const [index, path] of paths.entries()) {
          if (context.cancelled) break;
          context.report({ done: index, total: paths.length, message: path });

          const source = await this.#sourceTextFor(path);
          if (!source) {
            failed.push(path);
            continue;
          }

          const skip = this.#skipFor(path, source.text, matcher, only);
          // The exclusions named matches this text no longer has. Refusing is
          // the point: replacing the rest would be replacing something the
          // user said not to touch, and nothing here can tell which.
          if (skip === null) {
            failed.push(path);
            continue;
          }

          // Recomputed from the current text rather than trusting the stored
          // result rows, which may be stale for a file edited since the search.
          const result = computeReplacements(source.text, matcher, replacement, {
            expand: options.regexp,
            preserveCase: options.preserveCase,
            ...(skip.size > 0 ? { skip } : {}),
          });
          if (result.count === 0) continue;

          if (source.bufferId) {
            edits.push({
              bufferId: source.bufferId,
              // One change per match, in the coordinates `computeReplacements`
              // already resolved them in — not a single from-0-to-end swap.
              // Provenance marks whatever a change set actually inserted, so
              // collapsing every match into one edit would mark the entire
              // file as changed instead of just the matched spans.
              changes: result.edits,
            });
            // Recorded now, so an edit the user makes while the rest of the
            // walk is still reading gets caught by `apply` instead of being
            // overwritten by text computed before they typed it.
            baseRevisions.set(source.bufferId, this.#workspace.revisionOf(source.bufferId));
            const buffer = this.#workspace.buffers.get().find((b) => b.id === source.bufferId);
            // A file that was in sync with disk stays in sync; one with unsaved
            // edits keeps them, and stays the user's to save.
            if (!buffer?.isDirty) saveAfter.push(source.bufferId);
          } else {
            diskWrites.push({ path, text: result.text });
          }

          journal.push({
            path,
            before: source.text,
            after: result.text,
            count: result.count,
            bufferId: source.bufferId,
          });
          matches += result.count;
        }

        return { journal, failed, edits, saveAfter, diskWrites, baseRevisions, matches };
      },
    );

    const planned = await job.result;
    if (planned.status !== 'done') {
      // Cancelled or failed: nothing was written, so there is nothing to say
      // beyond that it did not happen.
      return { files: 0, matches: 0, failed: [], cancelled: planned.status === 'cancelled' };
    }

    const { journal, failed, edits, saveAfter, diskWrites, baseRevisions } = planned.value;
    let { matches } = planned.value;

    // Every open buffer in one change set: that is what makes a project-wide
    // replace cost one ⌘Z instead of one per file.
    this.#lastReplaceSet = null;
    if (edits.length > 0) {
      const applied = this.#workspace.apply({
        description: `Replace "${query}"`,
        author: { kind: 'user' },
        edits,
        baseRevisions,
      });

      if (applied.ok) {
        this.#lastReplaceSet = applied.id;
      } else {
        // Nothing was applied, so nothing about those files is true any more.
        const rejected = new Set(edits.map((edit) => edit.bufferId));
        for (const entry of journal.filter((e) => e.bufferId && rejected.has(e.bufferId))) {
          failed.push(entry.path);
          matches -= entry.count;
        }
        journal.splice(
          0,
          journal.length,
          ...journal.filter((entry) => !entry.bufferId || !rejected.has(entry.bufferId)),
        );
        saveAfter.length = 0;
      }
    }

    for (const write of diskWrites) {
      try {
        await this.#platform.writeTextFile(write.path, write.text);
      } catch {
        failed.push(write.path);
        const index = journal.findIndex((entry) => entry.path === write.path);
        if (index >= 0) matches -= journal.splice(index, 1)[0]!.count;
      }
    }

    for (const bufferId of saveAfter) await this.#workspace.save(bufferId);

    this.lastReplace.set(journal.length > 0 ? journal : null);

    // Drop the replaced files from the results; their matches are gone.
    if (journal.length > 0) {
      const replaced = new Set(journal.map((entry) => entry.path));
      this.results.update((current) => current.filter((file) => !replaced.has(file.path)));
      this.focused.set(-1);
    }

    return { files: journal.length, matches, failed };
  }

  /**
   * Undo the last replace.
   *
   * A file whose contents no longer match what the replace produced is left
   * alone: something else has touched it since, and restoring the old text
   * would destroy that newer work. The count of skipped files is reported so
   * the outcome is never silently partial.
   */
  async undoLastReplace(): Promise<{ restored: number; skipped: number }> {
    const journal = this.lastReplace.get();
    if (!journal) return { restored: 0, skipped: 0 };

    let restored = 0;
    let skipped = 0;

    // Open buffers come back through their change set where that is still
    // possible, because taking the edit off the undo stack is truer than
    // writing the old text on top of it.
    const undoneBuffers = new Set<BufferId>();
    if (this.#lastReplaceSet) {
      const outcome = this.#workspace.undoChangeSet(this.#lastReplaceSet);
      for (const bufferId of outcome.undone) undoneBuffers.add(bufferId);
      restored += outcome.undone.length;
      this.#lastReplaceSet = null;
    }

    for (const entry of journal) {
      if (entry.bufferId && undoneBuffers.has(entry.bufferId)) continue;

      // Anything the change set could not take back falls through to the
      // journal, which is the older and more literal mechanism: restore the
      // previous text, but only if the file still says what the replace left
      // there. That check is what stops it clobbering newer work, and it is
      // why the journal stays the backstop rather than being retired.
      const source = await this.#sourceTextFor(entry.path);
      if (!source || source.text !== entry.after) {
        skipped++;
        continue;
      }
      if (await this.#writeText(entry.path, entry.before, source.bufferId)) restored++;
      else skipped++;
    }

    this.lastReplace.set(null);
    return { restored, skipped };
  }

  /** Display label for a result group, relative to the workspace root. */
  labelFor(path: string): { name: string; folder: string } {
    const root = this.#workspace.rootPath.get();
    const display = root ? relative(root, path) : path;
    return { name: basename(display), folder: dirname(display) };
  }
}

/** One file changed by a replace, and the text it had beforehand. */
export interface ReplaceRecord {
  path: string;
  before: string;
  after: string;
  count: number;
  /** Set when the file was open, in which case the change set owns the undo. */
  bufferId?: BufferId | null;
}

export interface ReplaceOutcome {
  /** True when the walk was cancelled, in which case nothing was written. */
  cancelled?: boolean;
  files: number;
  matches: number;
  /** Files that could not be read or written. */
  failed: string[];
}

/** What the focused row points at — a whole file, or one match in one. */
export type FocusedResult =
  | { kind: 'file'; path: string }
  | { kind: 'match'; path: string; match: LineMatch };

/** Enough of a match row to say which match it is. */
export interface MatchPosition {
  line: number;
  column: number;
  previewOffset: number;
}

/**
 * The identity of one match: path, 1-based line, absolute column.
 *
 * `column` is relative to the preview, which is a *window* into a long line
 * rather than the line itself — so `previewOffset` has to be added back or two
 * matches on one long line would key the same. NUL as the separator because no
 * path, and no number, can contain one.
 */
function matchKey(path: string, match: MatchPosition): string {
  return `${path}\u0000${match.line}\u0000${match.previewOffset + match.column}`;
}

/** Split a comma- or newline-separated glob list. */
export function splitPatterns(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
}

import { isolateHistory, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import {
  ChangeSet,
  EditorSelection,
  EditorState,
  type Extension,
  type StateCommand,
  type StateEffect,
  type Text,
  type Transaction,
  type TransactionSpec,
} from '@codemirror/state';
import { Emitter } from '@core/emitter';
import { detectLanguage, languageById, type LanguageInfo } from '@core/languages';
import { basename, canMoveInto, contains, dirname, join, topLevelPaths } from '@core/path';
import { Signal } from '@core/signal';
import { PlatformError, type Platform } from '@platform/types';
import {
  authorLabel,
  changeSetAnnotation,
  TransactionLog,
  type ApplyResult,
  type ChangeSetId,
  type ChangeSetSpec,
  type Edit,
  type Provenance,
} from './transactions';

/**
 * Buffers, tabs and file operations.
 *
 * Each buffer owns a CodeMirror `EditorState`, which is what makes per-tab
 * undo history, selection and scroll position work: switching tabs is a
 * `view.setState()`, not a reload. `@codemirror/state` is DOM-free, so this
 * service still runs headless under Vitest.
 *
 * The view-layer extensions (theme, gutters, grammars) are injected via
 * `StateFactory` rather than imported, keeping this file free of any
 * dependency on `@codemirror/view`.
 *
 * `@codemirror/commands` *is* imported, for the history primitives grouped
 * undo is built on. The rule that matters is staying headless, and it does —
 * `tests/transactions.test.ts` drives real undo history under Node.
 */

export type BufferId = string;
export type GroupId = string;
export type Eol = '\n' | '\r\n';

/**
 * How the file's bytes are encoded.
 *
 * Nox reads and writes UTF-8 only; the distinction that matters in practice is
 * whether the file carries a byte-order mark, because dropping one that was
 * there (or adding one that was not) is a diff nobody asked for. Legacy
 * encodings are recorded as known debt rather than half-supported.
 */
export type Encoding = 'utf-8' | 'utf-8-bom';

/** A selection flattened to offsets so it can be written to disk as JSON. */
export interface SelectionRecord {
  /** `[anchor, head]` per cursor, in document order. */
  ranges: [number, number][];
  /** Index into `ranges` of the primary cursor. */
  main: number;
}

/** U+FEFF, spelled as an escape: an invisible character in source is a trap. */
const BOM = '\uFEFF';

/** One editor pane: an ordered set of tabs and which of them is showing. */
interface EditorGroup {
  id: GroupId;
  order: BufferId[];
  activeId: BufferId | null;
}

export interface GroupSnapshot {
  id: GroupId;
  tabs: BufferSnapshot[];
  activeId: BufferId | null;
  isActive: boolean;
}

/** Above this size, dirty tracking uses a cheap change counter — see `#recomputeDirty`. */
const EXACT_DIRTY_LIMIT = 2_000_000;

/** Files larger than this are refused; the editor is not a hex viewer. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

export interface StateFactoryArgs {
  doc: string;
  languageId: string;
}

export type StateFactory = (args: StateFactoryArgs) => Extension;

/**
 * What has happened to this buffer's file behind Nox's back.
 * `none` is the normal case; the others are set by `FileWatcherService`.
 */
export type ExternalState = 'none' | 'modified' | 'deleted';

export interface BufferSnapshot {
  id: BufferId;
  path: string | null;
  name: string;
  languageId: string;
  languageName: string;
  isUntitled: boolean;
  isDirty: boolean;
  eol: Eol;
  encoding: Encoding;
  externalState: ExternalState;
}

class Buffer {
  readonly id: BufferId;
  path: string | null;
  name: string;
  language: LanguageInfo;
  eol: Eol;
  encoding: Encoding;
  state: EditorState;
  savedDoc: Text;
  changeCount = 0;
  savedChangeCount = 0;
  /**
   * Monotonic counter, bumped on every change to the document.
   *
   * Distinct from `changeCount`, which `resetState` zeroes as part of dirty
   * tracking. A revision that can go backwards is useless for staleness: a
   * caller holding revision 3 across a reload would silently pass the check
   * against a completely different document. This one only ever goes up.
   */
  revision = 0;
  /**
   * Modification time of the file as Nox last saw it. Comparing against a
   * fresh stat is how the watcher tells "Nox wrote this" from "something else
   * did" — far more reliable than a time window around our own writes.
   */
  diskMtime = 0;
  externalState: ExternalState = 'none';

  constructor(init: {
    id: BufferId;
    path: string | null;
    name: string;
    language: LanguageInfo;
    eol: Eol;
    encoding?: Encoding;
    state: EditorState;
  }) {
    this.id = init.id;
    this.path = init.path;
    this.name = init.name;
    this.language = init.language;
    this.eol = init.eol;
    this.encoding = init.encoding ?? 'utf-8';
    this.state = init.state;
    this.savedDoc = init.state.doc;
  }

  get isUntitled(): boolean {
    return this.path === null;
  }

  get isDirty(): boolean {
    if (this.changeCount === this.savedChangeCount) return false;
    const doc = this.state.doc;
    if (doc.length !== this.savedDoc.length) return true;
    // Exact comparison so undoing back to the saved state clears the marker.
    // Skipped on very large files where the walk would be felt while typing.
    if (doc.length > EXACT_DIRTY_LIMIT) return true;
    return !doc.eq(this.savedDoc);
  }

  snapshot(): BufferSnapshot {
    return {
      id: this.id,
      path: this.path,
      name: this.name,
      languageId: this.language.id,
      languageName: this.language.name,
      isUntitled: this.isUntitled,
      isDirty: this.isDirty,
      eol: this.eol,
      encoding: this.encoding,
      externalState: this.externalState,
    };
  }
}

export interface WorkspaceEvents {
  /** A buffer's EditorState was replaced wholesale — the view must re-sync. */
  'buffer-reset': { id: BufferId };
  'buffer-opened': { id: BufferId };
  'buffer-closed': { id: BufferId };
  saved: { id: BufferId; path: string };
  /** The file changed or vanished behind Nox's back. */
  'external-change': { id: BufferId; state: ExternalState; reloaded: boolean };
  error: { message: string; detail?: string };
}

/**
 * Lets the workspace push a change into the live editor view.
 *
 * The mirror image of `applyTransaction`. Returns false when the buffer is not
 * the one this view is showing, in which case the workspace applies the change
 * to the background state itself. This is what allows an external reload to
 * keep scroll position and undo history instead of resetting the view.
 *
 * Accepts a whole `Transaction` as well as a spec, because commands like
 * `undo` produce transactions rather than specs and both have to reach the
 * view that is showing the buffer.
 */
export type ViewDispatcher = (id: BufferId, spec: TransactionSpec | Transaction) => boolean;

export class WorkspaceService {
  /** Every open buffer, in group then tab order. */
  readonly buffers = new Signal<BufferSnapshot[]>([]);
  /** The layout: one entry per editor group. */
  readonly groups = new Signal<GroupSnapshot[]>([]);
  readonly activeGroupId = new Signal<GroupId>('group-1');
  /** Active buffer of the active group. Derived — never set directly. */
  readonly activeId = new Signal<BufferId | null>(null);
  readonly rootPath = new Signal<string | null>(null);
  readonly recentFiles = new Signal<string[]>([]);
  readonly recentFolders = new Signal<string[]>([]);
  readonly events = new Emitter<WorkspaceEvents>();
  /** What has been applied, and by whom. See `transactions.ts`. */
  readonly log = new TransactionLog();

  #platform: Platform;
  #createState: StateFactory;
  /**
   * Editor groups, left to right (or top to bottom). A flat list rather than
   * a nested tree: it covers side-by-side work, which is what splits are
   * actually for, without the complexity of arbitrary nesting. See
   * ARCHITECTURE.md for why nesting is deliberately out of scope.
   */
  #groups: EditorGroup[] = [{ id: 'group-1', order: [], activeId: null }];
  #activeGroupId: GroupId = 'group-1';
  #nextGroupId = 2;
  #map = new Map<BufferId, Buffer>();
  /** Buffer ids in most-recently-focused order. Front is the current tab. */
  #mru: BufferId[] = [];
  #nextId = 1;
  #untitledCounter = 0;
  #viewDispatchers = new Set<ViewDispatcher>();
  #nextChangeSetId = 1;
  /**
   * Per buffer, the change sets sitting in its undo history, innermost last,
   * each with the `undoDepth` it produced. Comparing that depth against the
   * buffer's current one is how grouped undo knows whether a set is still the
   * next thing to be taken back — rather than keeping a second history and
   * hoping it stays in step with CodeMirror's.
   */
  #undoIndex = new Map<BufferId, { id: ChangeSetId; depth: number }[]>();
  #redoIndex = new Map<BufferId, { id: ChangeSetId; depth: number }[]>();

  constructor(platform: Platform, createState: StateFactory) {
    this.#platform = platform;
    this.#createState = createState;
    // Publish the initial layout: consumers must see the one empty group that
    // exists from construction, not an empty list until something changes.
    this.#sync();
  }

  /**
   * Registered by each editor pane; see `ViewDispatcher`. Returns a function
   * that unregisters it.
   *
   * A *set* rather than a single slot: with split panes there is one view per
   * pane, and a single slot meant the last pane to mount silently owned the
   * channel. Edits aimed at any other pane's buffer took the background path
   * and left that pane's view showing stale text.
   */
  addViewDispatcher(dispatch: ViewDispatcher): () => void {
    this.#viewDispatchers.add(dispatch);
    return () => this.#viewDispatchers.delete(dispatch);
  }

  /** True when some view was showing the buffer and took the change. */
  #dispatchToView(id: BufferId, spec: TransactionSpec | Transaction): boolean {
    for (const dispatch of this.#viewDispatchers) {
      if (dispatch(id, spec)) return true;
    }
    return false;
  }

  // --- Accessors ---------------------------------------------------------

  get(id: BufferId): Buffer | undefined {
    return this.#map.get(id);
  }

  active(): Buffer | undefined {
    const id = this.activeId.get();
    return id ? this.#map.get(id) : undefined;
  }

  activeSnapshot(): BufferSnapshot | null {
    return this.active()?.snapshot() ?? null;
  }

  stateOf(id: BufferId): EditorState | undefined {
    return this.#map.get(id)?.state;
  }

  textOf(id: BufferId): string | undefined {
    return this.#map.get(id)?.state.doc.toString();
  }

  hasUnsavedChanges(): boolean {
    return [...this.#map.values()].some((b) => b.isDirty);
  }

  findByPath(path: string): Buffer | undefined {
    return [...this.#map.values()].find((b) => b.path === path);
  }

  // --- Buffer lifecycle --------------------------------------------------

  /** Open a file, or focus the tab already showing it. Returns the buffer id. */
  async open(path: string): Promise<BufferId | null> {
    const existing = this.findByPath(path);
    if (existing) {
      this.setActive(existing.id);
      // Re-focusing counts as use: quick-open orders by recency, and a file
      // you keep returning to should not sink down the list.
      this.#pushRecentFile(path);
      return existing.id;
    }

    let raw: string;
    let mtime = 0;
    try {
      const stat = await this.#platform.stat(path);
      if (stat.isDirectory) {
        this.#fail(`${basename(path)} is a folder.`);
        return null;
      }
      if (stat.size > MAX_FILE_BYTES) {
        this.#fail(`${basename(path)} is too large to open.`, `${formatBytes(stat.size)}`);
        return null;
      }
      mtime = stat.modified;
      raw = await this.#platform.readTextFile(path);
    } catch (error) {
      this.#fail(`Could not open ${basename(path)}.`, describe(error));
      return null;
    }

    if (looksBinary(raw)) {
      this.#fail(`${basename(path)} is not a text file.`);
      return null;
    }

    const { doc, eol, encoding } = decode(raw);
    const language = detectLanguage(path);

    const buffer = new Buffer({
      id: this.#mintId(),
      path,
      name: basename(path),
      language,
      eol,
      encoding,
      state: EditorState.create({
        doc,
        extensions: this.#createState({ doc, languageId: language.id }),
      }),
    });

    buffer.diskMtime = mtime;
    this.#insert(buffer);
    this.#pushRecentFile(path);
    this.events.emit('buffer-opened', { id: buffer.id });
    return buffer.id;
  }

  /** Create an empty untitled buffer and focus it. */
  newUntitled(options: { languageId?: string; content?: string } = {}): BufferId {
    const language = options.languageId ? languageById(options.languageId) : detectLanguage(null);
    const doc = options.content ?? '';
    const buffer = new Buffer({
      id: this.#mintId(),
      path: null,
      name: `Untitled-${++this.#untitledCounter}`,
      language,
      eol: '\n',
      state: EditorState.create({
        doc,
        extensions: this.#createState({ doc, languageId: language.id }),
      }),
    });
    this.#insert(buffer);
    this.events.emit('buffer-opened', { id: buffer.id });
    return buffer.id;
  }

  /**
   * Close a tab. Refuses when the buffer is dirty unless `force` is set —
   * the confirmation prompt is the caller's job, not the model's.
   */
  close(id: BufferId, options: { force?: boolean } = {}): boolean {
    const buffer = this.#map.get(id);
    if (!buffer) return true;
    if (buffer.isDirty && !options.force) return false;

    const group = this.#groupOf(id);
    if (group) {
      const index = group.order.indexOf(id);
      group.order.splice(index, 1);
      if (group.activeId === id) {
        group.activeId = group.order[Math.min(index, group.order.length - 1)] ?? null;
      }
    }
    this.#map.delete(id);
    const mruIndex = this.#mru.indexOf(id);
    if (mruIndex >= 0) this.#mru.splice(mruIndex, 1);
    this.#undoIndex.delete(id);
    this.#redoIndex.delete(id);

    // An emptied group folds away, unless it is the only one left — the
    // layout should not keep a hole where a pane used to be.
    if (group && group.order.length === 0 && this.#groups.length > 1) {
      this.#removeGroup(group.id);
    }

    this.#sync();
    this.events.emit('buffer-closed', { id });
    return true;
  }

  closeOthers(keep: BufferId): void {
    const group = this.#groupOf(keep);
    if (!group) return;
    for (const id of [...group.order]) {
      if (id !== keep) this.close(id, { force: true });
    }
  }

  closeAll(options: { force?: boolean } = {}): boolean {
    let allClosed = true;
    for (const id of [...this.#map.keys()]) {
      if (!this.close(id, options)) allClosed = false;
    }
    return allClosed;
  }

  /** Focus a buffer, switching to whichever group holds it. */
  setActive(id: BufferId | null): void {
    if (id === null) {
      this.#activeGroup().activeId = null;
      this.#sync();
      return;
    }
    if (!this.#map.has(id)) return;

    const group = this.#groupOf(id);
    if (!group) return;
    group.activeId = id;
    this.#activeGroupId = group.id;
    this.#touch(id);
    this.#sync();
  }

  /**
   * Open buffers in most-recently-used order, current one first.
   *
   * Tab order answers "where is this file"; MRU answers "what was I just
   * doing", and those are different questions — which is why the switcher
   * cannot simply read the tab strip.
   */
  recentBuffers(): BufferSnapshot[] {
    const seen = new Set(this.#mru);
    const rest = [...this.#map.keys()].filter((id) => !seen.has(id));
    return [...this.#mru, ...rest]
      .map((id) => this.#map.get(id))
      .filter((buffer): buffer is Buffer => buffer !== undefined)
      .map((buffer) => buffer.snapshot());
  }

  /** Move a buffer to the front of the MRU list. */
  #touch(id: BufferId): void {
    const index = this.#mru.indexOf(id);
    if (index === 0) return;
    if (index > 0) this.#mru.splice(index, 1);
    this.#mru.unshift(id);
  }

  /** Cycle tabs within the active group. `delta` +1 is "next"; wraps around. */
  cycle(delta: number): void {
    const group = this.#activeGroup();
    if (group.order.length === 0) return;
    const index = group.activeId ? group.order.indexOf(group.activeId) : -1;
    const next = (index + delta + group.order.length) % group.order.length;
    this.setActive(group.order[next] ?? null);
  }

  /** Activate the nth tab of the active group, 0-based. */
  activateIndex(index: number): void {
    const id = this.#activeGroup().order[index];
    if (id) this.setActive(id);
  }

  /** Reorder tabs, used by drag-and-drop in the tab strip. */
  moveTab(id: BufferId, toIndex: number, targetGroupId?: GroupId): void {
    const from = this.#groupOf(id);
    if (!from) return;
    const to = targetGroupId ? this.#group(targetGroupId) : from;
    if (!to) return;

    from.order.splice(from.order.indexOf(id), 1);
    const clamped = Math.max(0, Math.min(to.order.length, toIndex));
    to.order.splice(clamped, 0, id);

    if (from !== to) {
      // Dragging the last tab out of a group takes the group with it.
      if (from.activeId === id) from.activeId = from.order[0] ?? null;
      to.activeId = id;
      this.#activeGroupId = to.id;
      if (from.order.length === 0 && this.#groups.length > 1) this.#removeGroup(from.id);
    }
    this.#sync();
  }

  // --- Groups (split panes) ------------------------------------------------

  /**
   * Open a new group beside the active one and focus it.
   *
   * If the active group has more than one tab, the active tab moves across —
   * you get what you were looking at, side by side with where it was. With a
   * single tab there is nothing useful to move, so the new group starts empty
   * and waits for you to open something into it.
   */
  splitEditor(): GroupId {
    const source = this.#activeGroup();
    const group: EditorGroup = { id: `group-${this.#nextGroupId++}`, order: [], activeId: null };
    this.#groups.splice(this.#groups.indexOf(source) + 1, 0, group);

    const moving = source.order.length > 1 ? source.activeId : null;
    if (moving) {
      source.order.splice(source.order.indexOf(moving), 1);
      source.activeId = source.order[0] ?? null;
      group.order.push(moving);
      group.activeId = moving;
    }

    this.#activeGroupId = group.id;
    this.#sync();
    return group.id;
  }

  /** Close a group, moving its tabs into the neighbour rather than losing them. */
  closeGroup(id: GroupId): boolean {
    if (this.#groups.length <= 1) return false;
    const group = this.#group(id);
    if (!group) return false;

    const index = this.#groups.indexOf(group);
    const neighbour = this.#groups[index === 0 ? 1 : index - 1]!;
    neighbour.order.push(...group.order);
    if (group.activeId) neighbour.activeId = group.activeId;

    this.#removeGroup(id);
    this.#activeGroupId = neighbour.id;
    this.#sync();
    return true;
  }

  focusGroup(id: GroupId): void {
    if (!this.#group(id)) return;
    this.#activeGroupId = id;
    this.#sync();
  }

  /** Move focus to an adjacent group, wrapping around. */
  cycleGroup(delta: number): void {
    if (this.#groups.length <= 1) return;
    const index = this.#groups.findIndex((group) => group.id === this.#activeGroupId);
    const next = (index + delta + this.#groups.length) % this.#groups.length;
    this.focusGroup(this.#groups[next]!.id);
  }

  /** Send the active tab to an adjacent group, creating one if needed. */
  moveActiveToGroup(delta: number): void {
    const source = this.#activeGroup();
    const id = source.activeId;
    if (!id) return;

    const index = this.#groups.indexOf(source);
    const targetIndex = index + delta;
    const target = this.#groups[targetIndex];

    if (!target) {
      if (source.order.length <= 1) return; // Already alone; nothing to gain.
      this.splitEditor();
      return;
    }
    this.moveTab(id, target.order.length, target.id);
  }

  #group(id: GroupId): EditorGroup | undefined {
    return this.#groups.find((group) => group.id === id);
  }

  #activeGroup(): EditorGroup {
    return this.#group(this.#activeGroupId) ?? this.#groups[0]!;
  }

  #groupOf(bufferId: BufferId): EditorGroup | undefined {
    return this.#groups.find((group) => group.order.includes(bufferId));
  }

  #removeGroup(id: GroupId): void {
    const index = this.#groups.findIndex((group) => group.id === id);
    if (index === -1) return;
    this.#groups.splice(index, 1);
    if (this.#activeGroupId === id) {
      this.#activeGroupId = this.#groups[Math.min(index, this.#groups.length - 1)]!.id;
    }
  }

  // --- Editing -----------------------------------------------------------

  /**
   * The single point through which document changes flow. The view dispatches
   * here rather than mutating its own state so the workspace always holds the
   * authoritative state for every tab, including background ones.
   */
  applyTransaction(id: BufferId, transaction: Transaction): void {
    const buffer = this.#map.get(id);
    if (!buffer) return;
    buffer.state = transaction.state;
    if (transaction.docChanged) {
      buffer.changeCount++;
      buffer.revision++;
      this.#sync();
    }
  }

  /** Replace a buffer's state outright (used by session restore and reload). */
  resetState(id: BufferId, state: EditorState): void {
    const buffer = this.#map.get(id);
    if (!buffer) return;
    buffer.state = state;
    buffer.savedDoc = state.doc;
    buffer.changeCount = 0;
    buffer.savedChangeCount = 0;
    buffer.revision++;
    // The old state's history went with it, so any change set indexed against
    // it can no longer be undone. Forget them rather than leave entries whose
    // depths refer to a history that no longer exists.
    this.#undoIndex.delete(id);
    this.#redoIndex.delete(id);
    this.#sync();
    this.events.emit('buffer-reset', { id });
  }

  // --- Persistence -------------------------------------------------------

  /**
   * Write a buffer to disk. Untitled buffers need a path first: the caller
   * should run `saveAs` instead. Returns true when bytes were written.
   */
  async save(
    id: BufferId,
    options: { trimTrailingWhitespace?: boolean; insertFinalNewline?: boolean } = {},
  ): Promise<boolean> {
    const buffer = this.#map.get(id);
    if (!buffer || buffer.path === null) return false;

    let text = buffer.state.doc.toString();
    if (options.trimTrailingWhitespace) text = text.replace(/[ \t]+$/gm, '');
    if (options.insertFinalNewline && text.length > 0 && !text.endsWith('\n')) text += '\n';

    const onDisk = encode(text, buffer.eol, buffer.encoding);

    try {
      await this.#platform.writeTextFile(buffer.path, onDisk);
    } catch (error) {
      this.#fail(`Could not save ${buffer.name}.`, describe(error));
      return false;
    }

    // Formatting on save changes the document, so push it back into the state
    // as a real transaction — the user can undo it.
    if (text !== buffer.state.doc.toString()) {
      const transaction = buffer.state.update({
        changes: { from: 0, to: buffer.state.doc.length, insert: text },
        scrollIntoView: false,
      });
      buffer.state = transaction.state;
      buffer.changeCount++;
      buffer.revision++;
      this.events.emit('buffer-reset', { id });
    }

    buffer.savedDoc = buffer.state.doc;
    buffer.savedChangeCount = buffer.changeCount;
    buffer.externalState = 'none';

    // Record the mtime we just produced so the watch event this write is about
    // to trigger is recognised as ours and ignored.
    try {
      buffer.diskMtime = (await this.#platform.stat(buffer.path)).modified;
    } catch {
      buffer.diskMtime = 0;
    }

    this.#pushRecentFile(buffer.path);
    this.#sync();
    this.events.emit('saved', { id, path: buffer.path });
    return true;
  }

  /** Point a buffer at a new path, then save it there. */
  async saveAs(id: BufferId, path: string, options: Parameters<this['save']>[1] = {}): Promise<boolean> {
    const buffer = this.#map.get(id);
    if (!buffer) return false;

    const previousPath = buffer.path;
    const previousName = buffer.name;
    const previousLanguage = buffer.language;

    buffer.path = path;
    buffer.name = basename(path);
    buffer.language = detectLanguage(path);

    const saved = await this.save(id, options);
    if (!saved) {
      buffer.path = previousPath;
      buffer.name = previousName;
      buffer.language = previousLanguage;
      this.#sync();
      return false;
    }

    // The grammar may have changed with the extension; the view rebuilds.
    if (previousLanguage.id !== buffer.language.id) {
      this.events.emit('buffer-reset', { id });
    }
    return true;
  }

  /**
   * Re-read the file from disk, replacing the document.
   *
   * Applied as a *transaction* rather than a fresh state, which keeps scroll
   * position, maps the selection through the change, and leaves the reload on
   * the undo stack — so a surprise reload is recoverable. The buffer ends
   * clean because `savedDoc` moves with it.
   */
  async reloadFromDisk(id: BufferId): Promise<boolean> {
    const buffer = this.#map.get(id);
    if (!buffer || buffer.path === null) return false;

    let raw: string;
    let mtime = 0;
    try {
      raw = await this.#platform.readTextFile(buffer.path);
      mtime = (await this.#platform.stat(buffer.path)).modified;
    } catch (error) {
      this.#fail(`Could not reload ${buffer.name}.`, describe(error));
      return false;
    }

    // A rewrite can change the line endings or add a BOM; the buffer should
    // follow the file rather than keep asserting what it used to be.
    const { doc, eol, encoding } = decode(raw);
    buffer.eol = eol;
    buffer.encoding = encoding;

    if (doc === buffer.state.doc.toString()) {
      // Identical content: record the new mtime and leave the document alone
      // rather than pushing a no-op onto the undo stack.
      buffer.diskMtime = mtime;
      buffer.externalState = 'none';
      this.#sync();
      return true;
    }

    const spec: TransactionSpec = {
      changes: { from: 0, to: buffer.state.doc.length, insert: doc },
      scrollIntoView: false,
    };

    // Prefer the live view so the on-screen buffer keeps its scroll position.
    if (!this.#dispatchToView(id, spec)) {
      buffer.state = buffer.state.update(spec).state;
      buffer.changeCount++;
      buffer.revision++;
    }

    buffer.savedDoc = buffer.state.doc;
    buffer.savedChangeCount = buffer.changeCount;
    buffer.diskMtime = mtime;
    buffer.externalState = 'none';
    this.#sync();
    return true;
  }

  /** Discard in-memory changes and re-read from disk. */
  async revert(id: BufferId): Promise<boolean> {
    return this.reloadFromDisk(id);
  }

  /**
   * Apply edits to an open buffer as a single transaction.
   *
   * Used by project replace. Going through a transaction rather than writing
   * the file underneath the buffer is what makes the change undoable with
   * ⌘Z like any other edit, and what stops a replace from silently discarding
   * the user's unsaved work in that file.
   */
  applyEdits(id: BufferId, edits: readonly { from: number; to: number; insert: string }[]): boolean {
    const buffer = this.#map.get(id);
    if (!buffer || edits.length === 0) return false;

    // Built up front, for the same reason `apply` does it: CodeMirror throws
    // on a range the document cannot honour, and a throw here would surface as
    // an exception at whichever caller happened to hold a stale offset rather
    // than as the `false` the signature promises.
    let changes: ChangeSet;
    try {
      changes = ChangeSet.of([...edits], buffer.state.doc.length);
    } catch {
      return false;
    }

    const spec: TransactionSpec = { changes, scrollIntoView: false };
    if (!this.#dispatchToView(id, spec)) {
      buffer.state = buffer.state.update(spec).state;
      buffer.changeCount++;
      buffer.revision++;
      this.#sync();
    }
    return true;
  }

  /** Replace a buffer's entire contents in one transaction. */
  replaceContents(id: BufferId, text: string): boolean {
    const buffer = this.#map.get(id);
    if (!buffer) return false;
    if (buffer.state.doc.toString() === text) return false;
    return this.applyEdits(id, [{ from: 0, to: buffer.state.doc.length, insert: text }]);
  }

  /**
   * The current selection as plain offsets, for session persistence.
   *
   * Deliberately not an `EditorSelection`: what is written to `session.json`
   * has to be data, not a class the next launch has to reconstruct.
   */
  selectionOf(id: BufferId): SelectionRecord | null {
    const state = this.#map.get(id)?.state;
    if (!state) return null;
    return {
      ranges: state.selection.ranges.map((range) => [range.anchor, range.head] as [number, number]),
      main: state.selection.mainIndex,
    };
  }

  /**
   * Restore a selection recorded by `selectionOf`.
   *
   * Offsets are clamped to the document: the file may have been edited by
   * something else between sessions, and a cursor past the end throws rather
   * than degrading. A record that cannot be honoured collapses to a cursor at
   * the nearest valid offset instead of failing the whole restore.
   */
  setSelection(id: BufferId, selection: SelectionRecord): void {
    const buffer = this.#map.get(id);
    if (!buffer || selection.ranges.length === 0) return;

    const limit = buffer.state.doc.length;
    const clamp = (value: number) => Math.max(0, Math.min(limit, value));
    const ranges = selection.ranges.map(([anchor, head]) =>
      EditorSelection.range(clamp(anchor), clamp(head)),
    );
    const main = Math.max(0, Math.min(ranges.length - 1, selection.main));

    let spec: TransactionSpec;
    try {
      spec = { selection: EditorSelection.create(ranges, main), scrollIntoView: true };
    } catch {
      // `create` rejects overlapping ranges, which clamping can produce.
      spec = { selection: EditorSelection.cursor(clamp(selection.ranges[main]?.[1] ?? 0)) };
    }

    if (!this.#dispatchToView(id, spec)) {
      buffer.state = buffer.state.update(spec).state;
      this.#sync();
    }
  }

  /**
   * Re-apply unsaved work recorded in the session on top of the file as it is
   * on disk now.
   *
   * Goes through `applyEdits`, so the buffer comes back genuinely dirty rather
   * than pretending: `savedDoc` stays the disk content, the tab shows its
   * marker, and ⌘Z takes you back to what the file actually says.
   */
  restoreUnsaved(id: BufferId, content: string, baseMtime: number): void {
    const buffer = this.#map.get(id);
    if (!buffer) return;

    this.replaceContents(id, content);

    // The file moved under us between sessions. Say so through the same
    // channel the watcher uses, so saving goes through the existing conflict
    // prompt rather than overwriting whatever arrived while Nox was closed.
    if (baseMtime !== 0 && buffer.diskMtime !== baseMtime) {
      this.markExternalState(id, 'modified');
    }
  }

  // --- Transactions ------------------------------------------------------

  /** Monotonic revision of a buffer's document. See `Buffer.revision`. */
  revisionOf(id: BufferId): number {
    return this.#map.get(id)?.revision ?? -1;
  }

  /**
   * Snapshot the revisions of the given buffers, to pass back as
   * `ChangeSetSpec.baseRevisions` once the edits have been computed.
   */
  revisionsOf(ids: Iterable<BufferId>): Map<BufferId, number> {
    const revisions = new Map<BufferId, number>();
    for (const id of ids) {
      const buffer = this.#map.get(id);
      if (buffer) revisions.set(id, buffer.revision);
    }
    return revisions;
  }

  /**
   * Apply a change set: the single entry point for programmatic edits.
   *
   * Everything is validated before anything is dispatched. That ordering is
   * the whole design — once validation passes, each transaction is being
   * applied to state that has already been checked, and CodeMirror cannot
   * fail on it. A half-applied change set is therefore unrepresentable rather
   * than merely unlikely, which is not something a rollback path could
   * promise.
   */
  apply(spec: ChangeSetSpec): ApplyResult {
    if (spec.edits.length === 0) return { ok: false, reason: 'empty' };

    const named = new Set<BufferId>([
      ...spec.edits.map((edit) => edit.bufferId),
      ...(spec.baseRevisions?.keys() ?? []),
    ]);
    const missing = [...named].filter((id) => !this.#map.has(id));
    if (missing.length > 0) return { ok: false, reason: 'missing', buffers: missing };

    const stale = [...(spec.baseRevisions ?? [])]
      .filter(([id, revision]) => this.#map.get(id)!.revision !== revision)
      .map(([id]) => id);
    if (stale.length > 0) return { ok: false, reason: 'stale', buffers: stale };

    const grouped = new Map<BufferId, Edit[]>();
    for (const edit of spec.edits) {
      const list = grouped.get(edit.bufferId);
      if (list) list.push(edit);
      else grouped.set(edit.bufferId, [edit]);
    }

    /**
     * Turn every buffer's edits into a real `ChangeSet` *before* dispatching
     * any of them.
     *
     * `ChangeSet.of` is pure and throws on a range the document cannot honour
     * — an offset past the end, a backwards range — which is the single most
     * likely mistake a programmatic caller makes. Building them all up front
     * is what actually delivers the guarantee this method claims: without it,
     * a bad offset in the *second* buffer threw after the first had already
     * been written, leaving exactly the half-applied set the design says is
     * impossible, with nothing in the log to undo.
     */
    const prepared = new Map<BufferId, { changes: ChangeSet; edits: Edit[] }>();
    const invalid: BufferId[] = [];
    for (const [bufferId, edits] of grouped) {
      const buffer = this.#map.get(bufferId)!;
      const overlap = overlaps(edits);
      if (overlap) {
        invalid.push(bufferId);
        continue;
      }
      try {
        prepared.set(bufferId, {
          changes: ChangeSet.of(
            edits.map((edit) => edit.changes),
            buffer.state.doc.length,
          ),
          edits,
        });
      } catch {
        invalid.push(bufferId);
      }
    }
    if (invalid.length > 0) return { ok: false, reason: 'invalid', buffers: invalid };

    // Validation is complete; from here nothing can refuse.
    const id: ChangeSetId = `cs-${this.#nextChangeSetId++}`;

    // One timestamp for the annotation and the log entry, so a mark and the
    // log never disagree about when something happened.
    const at = Date.now();
    const provenance: Provenance = {
      changeSetId: id,
      authorKind: spec.author.kind,
      authorLabel: authorLabel(spec.author),
      description: spec.description,
      at,
    };

    const bufferIds: BufferId[] = [];
    for (const [bufferId, { changes, edits }] of prepared) {
      const buffer = this.#map.get(bufferId)!;
      const selection = edits.find((edit) => edit.selection)?.selection;
      const transaction: TransactionSpec = {
        changes,
        ...(selection ? { selection } : {}),
        // `isolateHistory` guarantees the set is exactly one history event in
        // this buffer — never merged into adjacent typing. Grouped undo
        // depends on that being true.
        annotations: [changeSetAnnotation.of(provenance), isolateHistory.of('full')],
        scrollIntoView: false,
      };

      if (!this.#dispatchToView(bufferId, transaction)) {
        buffer.state = buffer.state.update(transaction).state;
        buffer.changeCount++;
        buffer.revision++;
      }

      const stack = this.#undoIndex.get(bufferId) ?? [];
      stack.push({ id, depth: undoDepth(buffer.state) });
      this.#undoIndex.set(bufferId, stack);
      // Any new edit invalidates whatever was waiting to be redone.
      this.#redoIndex.delete(bufferId);
      bufferIds.push(bufferId);
    }

    this.#sync();
    this.log.record({
      id,
      description: spec.description,
      author: spec.author,
      bufferIds,
      at,
    });
    return { ok: true, id, bufferIds };
  }

  /**
   * Dispatch a state effect to every buffer, live or background.
   *
   * The same view-or-state fallback as `apply()`: a buffer with a mounted
   * view takes the effect through `#dispatchToView`, and one with no view
   * showing it gets `buffer.state` updated directly. Kept generic — the
   * caller supplies the effect — so this file stays free of any dependency
   * on what the effect means; `@editor/provenance` (and its
   * `@codemirror/view` import) has no reason to appear here. Exists for
   * "Clear Change Marks", whose design promise is dropping every mark in
   * every buffer, not just the one on screen.
   */
  broadcastEffect(effect: StateEffect<unknown>): void {
    const spec: TransactionSpec = { effects: effect };
    for (const [id, buffer] of this.#map) {
      if (!this.#dispatchToView(id, spec)) {
        buffer.state = buffer.state.update(spec).state;
      }
    }
    // `apply()` republishes unconditionally after its loop too — cheap, and
    // simpler than tracking whether any buffer actually took the background
    // path.
    this.#sync();
  }

  /**
   * Undo a change set across every buffer it touched.
   *
   * A buffer is skipped when the set is no longer the most recent thing in
   * its history: the user has edited since, and taking their work back is not
   * what they asked for. Skips are reported rather than swallowed, so a
   * partial undo can be said out loud.
   */
  undoChangeSet(id: ChangeSetId): { undone: BufferId[]; skipped: BufferId[] } {
    return this.#stepChangeSet(id, 'undo');
  }

  /** The mirror of `undoChangeSet`. */
  redoChangeSet(id: ChangeSetId): { undone: BufferId[]; skipped: BufferId[] } {
    return this.#stepChangeSet(id, 'redo');
  }

  /**
   * Plain undo/redo on the focused buffer.
   *
   * Routed through the workspace rather than straight at the view so that the
   * grouped and ungrouped paths behave identically for background buffers and
   * stay testable without a DOM.
   */
  undoActive(): boolean {
    const buffer = this.active();
    return buffer ? this.#runOnBuffer(buffer.id, undo) : false;
  }

  redoActive(): boolean {
    const buffer = this.active();
    return buffer ? this.#runOnBuffer(buffer.id, redo) : false;
  }

  /**
   * The change set that plain undo should take back as a unit, if any.
   *
   * Null for a single-buffer set: CodeMirror's own undo does exactly the same
   * thing there, and routing the common case through the grouped path would
   * add moving parts for no behavioural difference.
   */
  pendingGroupedUndo(): ChangeSetId | null {
    return this.#pendingGrouped('undo');
  }

  pendingGroupedRedo(): ChangeSetId | null {
    return this.#pendingGrouped('redo');
  }

  #pendingGrouped(direction: 'undo' | 'redo'): ChangeSetId | null {
    const buffer = this.active();
    if (!buffer) return null;

    const index = direction === 'undo' ? this.#undoIndex : this.#redoIndex;
    const depthOf = direction === 'undo' ? undoDepth : redoDepth;
    const top = index.get(buffer.id)?.at(-1);
    if (!top || depthOf(buffer.state) !== top.depth) return null;

    const entry = this.log.get(top.id);
    return entry && entry.bufferIds.length > 1 ? top.id : null;
  }

  #stepChangeSet(
    id: ChangeSetId,
    direction: 'undo' | 'redo',
  ): { undone: BufferId[]; skipped: BufferId[] } {
    const entry = this.log.get(id);
    const undone: BufferId[] = [];
    const skipped: BufferId[] = [];
    if (!entry) return { undone, skipped };

    const from = direction === 'undo' ? this.#undoIndex : this.#redoIndex;
    const to = direction === 'undo' ? this.#redoIndex : this.#undoIndex;
    const depthBefore = direction === 'undo' ? undoDepth : redoDepth;
    const depthAfter = direction === 'undo' ? redoDepth : undoDepth;
    const command = direction === 'undo' ? undo : redo;

    for (const bufferId of entry.bufferIds) {
      const buffer = this.#map.get(bufferId);
      const stack = from.get(bufferId);
      const top = stack?.at(-1);

      // The set has to still be on top of this buffer's history. Comparing
      // CodeMirror's own depth is what makes that check honest — it accounts
      // for edits, undos and redos we never saw.
      if (!buffer || !top || top.id !== id || depthBefore(buffer.state) !== top.depth) {
        skipped.push(bufferId);
        continue;
      }

      if (!this.#runOnBuffer(bufferId, command)) {
        skipped.push(bufferId);
        continue;
      }

      stack!.pop();
      const target = to.get(bufferId) ?? [];
      target.push({ id, depth: depthAfter(buffer.state) });
      to.set(bufferId, target);
      undone.push(bufferId);
    }

    this.#sync();
    return { undone, skipped };
  }

  /**
   * Run a CodeMirror state command against a buffer, wherever it lives.
   *
   * Prefers the view showing the buffer so the change lands on screen with
   * scroll and focus intact; falls back to the background state for buffers
   * no pane is displaying.
   */
  #runOnBuffer(id: BufferId, command: StateCommand): boolean {
    const buffer = this.#map.get(id);
    if (!buffer) return false;

    return command({
      state: buffer.state,
      dispatch: (transaction) => {
        if (this.#dispatchToView(id, transaction)) return;
        buffer.state = transaction.state;
        if (transaction.docChanged) {
          buffer.changeCount++;
          buffer.revision++;
        }
      },
    });
  }

  /** Record what happened to this buffer's file behind Nox's back. */
  markExternalState(id: BufferId, state: ExternalState): void {
    const buffer = this.#map.get(id);
    if (!buffer || buffer.externalState === state) return;
    buffer.externalState = state;
    this.#sync();
  }

  /** Modification time of the file as Nox last saw it. */
  knownMtime(id: BufferId): number {
    return this.#map.get(id)?.diskMtime ?? 0;
  }

  /** Buffers backed by a file, for the watcher to match events against. */
  fileBuffers(): { id: BufferId; path: string }[] {
    // Every buffer, regardless of which group holds it.
    return [...this.#map.values()]
      .filter((b): b is Buffer & { path: string } => b.path !== null)
      .map((b) => ({ id: b.id, path: b.path }));
  }

  // --- Folders -----------------------------------------------------------

  async openFolder(path: string): Promise<boolean> {
    try {
      await this.#platform.readDir(path);
    } catch (error) {
      this.#fail(`Could not open ${basename(path)}.`, describe(error));
      return false;
    }
    this.rootPath.set(path);
    this.recentFolders.update((list) => [path, ...list.filter((p) => p !== path)].slice(0, 12));
    return true;
  }

  closeFolder(): void {
    this.rootPath.set(null);
  }

  /** Create an empty file on disk and open it. */
  async createFile(path: string): Promise<BufferId | null> {
    try {
      const parent = dirname(path);
      if (parent && !(await this.#platform.exists(parent))) {
        await this.#platform.createDir(parent);
      }
      await this.#platform.createFile(path);
    } catch (error) {
      this.#fail(`Could not create ${basename(path)}.`, describe(error));
      return null;
    }
    return this.open(path);
  }

  async createFolder(path: string): Promise<boolean> {
    try {
      await this.#platform.createDir(path);
      return true;
    } catch (error) {
      this.#fail(`Could not create ${basename(path)}.`, describe(error));
      return false;
    }
  }

  /**
   * Move a file or directory, carrying any open buffers with it.
   *
   * Without the re-point step a rename would leave tabs aimed at paths that no
   * longer exist — they would look fine until the moment you pressed save.
   */
  async renamePath(from: string, to: string): Promise<boolean> {
    if (from === to) return true;

    try {
      await this.#platform.rename(from, to);
    } catch (error) {
      this.#fail(`Could not rename ${basename(from)}.`, describe(error));
      return false;
    }

    for (const buffer of this.#map.values()) {
      if (buffer.path === null) continue;
      if (buffer.path === from) {
        await this.#repoint(buffer, to);
      } else if (contains(from, buffer.path)) {
        // A renamed directory takes every buffer beneath it along.
        await this.#repoint(buffer, to + buffer.path.slice(from.length));
      }
    }

    this.#sync();
    return true;
  }

  /**
   * Delete a file or directory.
   *
   * Clean buffers for the deleted paths close — you asked for the file to be
   * gone. Dirty ones stay open and marked, because losing unsaved work to a
   * menu click is not a trade the user agreed to.
   */
  async deletePath(path: string): Promise<boolean> {
    const { failed } = await this.deletePaths([path]);
    return failed.length === 0;
  }

  /**
   * Delete several paths as one operation.
   *
   * Nested entries are reduced to their top-level ancestors first: selecting a
   * folder *and* a file inside it and pressing delete would otherwise remove
   * the folder and then fail on the file with "not found".
   */
  async deletePaths(paths: readonly string[]): Promise<{ deleted: string[]; failed: string[] }> {
    const roots = topLevelPaths(paths);
    const deleted: string[] = [];
    const failed: string[] = [];
    let lastError = '';

    for (const path of roots) {
      try {
        await this.#platform.trash(path);
        deleted.push(path);
      } catch (error) {
        failed.push(path);
        lastError = describe(error);
      }
    }

    for (const buffer of [...this.#map.values()]) {
      if (buffer.path === null) continue;
      const path = buffer.path;
      if (!deleted.some((root) => path === root || contains(root, path))) continue;

      if (buffer.isDirty) {
        buffer.externalState = 'deleted';
      } else {
        this.close(buffer.id, { force: true });
      }
    }

    if (failed.length === 1) {
      this.#fail(`Could not delete ${basename(failed[0]!)}.`, lastError);
    } else if (failed.length > 1) {
      this.#fail(`Could not delete ${failed.length} items.`, lastError);
    }

    this.#sync();
    return { deleted, failed };
  }

  /**
   * Move entries into `targetDir`. The drag-and-drop operation.
   *
   * Nested selections collapse to their top-level ancestor first, and anything
   * that cannot legally move (into itself, into its own subtree, or where it
   * already lives) is dropped rather than attempted — the UI refuses those
   * drops, but a command caller could still ask.
   */
  async movePaths(
    paths: readonly string[],
    targetDir: string,
  ): Promise<{ moved: string[]; failed: string[] }> {
    const candidates = topLevelPaths(paths).filter((path) => canMoveInto(path, targetDir));
    const moved: string[] = [];
    const failed: string[] = [];
    let lastError = '';

    for (const path of candidates) {
      const target = join(targetDir, basename(path));
      if (await this.#platform.exists(target)) {
        failed.push(path);
        lastError = `${basename(path)} already exists in ${basename(targetDir) || targetDir}.`;
        continue;
      }

      try {
        await this.#platform.rename(path, target);
      } catch (error) {
        failed.push(path);
        lastError = describe(error);
        continue;
      }

      // Same re-pointing rename relies on: tabs must follow their file.
      for (const buffer of this.#map.values()) {
        if (buffer.path === null) continue;
        if (buffer.path === path) await this.#repoint(buffer, target);
        else if (contains(path, buffer.path)) {
          await this.#repoint(buffer, target + buffer.path.slice(path.length));
        }
      }
      moved.push(target);
    }

    if (failed.length === 1) {
      this.#fail(`Could not move ${basename(failed[0]!)}.`, lastError);
    } else if (failed.length > 1) {
      this.#fail(`Could not move ${failed.length} items.`, lastError);
    }

    this.#sync();
    return { moved, failed };
  }

  /** Duplicate several files. Directories are skipped with an error each. */
  async duplicatePaths(paths: readonly string[]): Promise<string[]> {
    const created: string[] = [];
    for (const path of paths) {
      const target = await this.duplicatePath(path);
      if (target) created.push(target);
    }
    return created;
  }

  /** Copy a file next to itself under a free name. Returns the new path. */
  async duplicatePath(path: string): Promise<string | null> {
    const target = await this.#freeCopyName(path);
    try {
      await this.#platform.copyFile(path, target);
      return target;
    } catch (error) {
      this.#fail(`Could not duplicate ${basename(path)}.`, describe(error));
      return null;
    }
  }

  /** `notes.md` → `notes copy.md` → `notes copy 2.md`, first one free. */
  async #freeCopyName(path: string): Promise<string> {
    const parent = dirname(path);
    const name = basename(path);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';

    for (let attempt = 1; attempt < 1000; attempt++) {
      const suffix = attempt === 1 ? ' copy' : ` copy ${attempt}`;
      const candidate = join(parent, `${stem}${suffix}${extension}`);
      if (!(await this.#platform.exists(candidate))) return candidate;
    }
    return join(parent, `${stem} copy ${Date.now()}${extension}`);
  }

  /** Point a buffer at a new path, refreshing everything derived from it. */
  async #repoint(buffer: Buffer, path: string): Promise<void> {
    const previousLanguage = buffer.language;
    buffer.path = path;
    buffer.name = basename(path);
    buffer.language = detectLanguage(path);
    buffer.externalState = 'none';

    try {
      buffer.diskMtime = (await this.#platform.stat(path)).modified;
    } catch {
      buffer.diskMtime = 0;
    }

    // The extension may have changed, which means a different grammar.
    if (previousLanguage.id !== buffer.language.id) {
      this.events.emit('buffer-reset', { id: buffer.id });
    }
  }

  /** Suggested path for Save As on an untitled buffer. */
  suggestedSavePath(id: BufferId): string {
    const buffer = this.#map.get(id);
    const root = this.rootPath.get();
    const name = buffer?.name ?? 'untitled';
    return root ? join(root, name) : name;
  }

  // --- Session -----------------------------------------------------------

  restoreRecents(files: string[], folders: string[]): void {
    this.recentFiles.set(files.slice(0, 24));
    this.recentFolders.set(folders.slice(0, 12));
  }

  // --- Internals ---------------------------------------------------------

  #mintId(): BufferId {
    return `buf-${this.#nextId++}`;
  }

  #insert(buffer: Buffer): void {
    this.#map.set(buffer.id, buffer);
    const group = this.#activeGroup();
    const activeIndex = group.activeId ? group.order.indexOf(group.activeId) : -1;
    // New tabs land immediately after the active one, like a browser.
    if (activeIndex >= 0) group.order.splice(activeIndex + 1, 0, buffer.id);
    else group.order.push(buffer.id);
    group.activeId = buffer.id;
    this.#touch(buffer.id);
    this.#sync();
  }

  #pushRecentFile(path: string): void {
    this.recentFiles.update((list) => [path, ...list.filter((p) => p !== path)].slice(0, 24));
  }

  #sync(): void {
    const snapshots: GroupSnapshot[] = this.#groups.map((group) => ({
      id: group.id,
      activeId: group.activeId,
      isActive: group.id === this.#activeGroupId,
      tabs: group.order.map((id) => this.#map.get(id)!).filter(Boolean).map((b) => b.snapshot()),
    }));

    this.groups.set(snapshots);
    this.activeGroupId.set(this.#activeGroupId);
    this.buffers.set(snapshots.flatMap((group) => group.tabs));
    this.activeId.set(this.#activeGroup().activeId);
  }

  #fail(message: string, detail?: string): void {
    this.events.emit('error', { message, detail });
  }
}

// --- Helpers --------------------------------------------------------------

/**
 * Split a file's text into the document the editor works on plus the two
 * facts about its on-disk form that must survive a round trip.
 *
 * The document is always LF with no BOM, so every editing command, the search
 * layer and the diff of a dirty buffer see one canonical shape. `encode`
 * reverses this exactly at save time.
 */
function decode(raw: string): { doc: string; eol: Eol; encoding: Encoding } {
  const encoding: Encoding = raw.startsWith(BOM) ? 'utf-8-bom' : 'utf-8';
  const body = encoding === 'utf-8-bom' ? raw.slice(BOM.length) : raw;
  const eol: Eol = body.includes('\r\n') ? '\r\n' : '\n';
  return { doc: eol === '\r\n' ? body.replace(/\r\n/g, '\n') : body, eol, encoding };
}

/** The inverse of `decode`. */
function encode(doc: string, eol: Eol, encoding: Encoding): string {
  const body = eol === '\r\n' ? doc.replace(/\n/g, '\r\n') : doc;
  return encoding === 'utf-8-bom' ? BOM + body : body;
}

/**
 * True when two edits for the same buffer cover overlapping ranges.
 *
 * CodeMirror does not reject these — it merges them into something the caller
 * almost certainly did not mean. Silently producing text nobody asked for is
 * the exact failure this layer exists to prevent, so it is refused instead.
 * Touching ranges (`from === previous.to`) are fine and stay allowed.
 */
function overlaps(edits: readonly Edit[]): boolean {
  const ranges: { from: number; to: number }[] = [];
  for (const edit of edits) {
    const spec = edit.changes as { from?: number; to?: number };
    // Only plain `{from,to}` specs can be checked here. An array or a
    // function form is passed through to CodeMirror as before.
    if (typeof spec?.from !== 'number') return false;
    ranges.push({ from: spec.from, to: spec.to ?? spec.from });
  }

  ranges.sort((a, b) => a.from - b.from);
  return ranges.some((range, index) => index > 0 && range.from < ranges[index - 1]!.to);
}

/** Heuristic: a NUL byte in the first 8 KB means this is not source code. */
function looksBinary(text: string): boolean {
  const limit = Math.min(text.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 0) return true;
  }
  return false;
}

function describe(error: unknown): string {
  if (error instanceof PlatformError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

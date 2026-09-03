import { isolateHistory, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import {
  ChangeSet,
  EditorSelection,
  EditorState,
  type Extension,
  type StateCommand,
  type StateEffect,
  Text,
  type Transaction,
  type TransactionSpec,
} from '@codemirror/state';
import type { Encoding } from '@core/encoding';
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
  mirroredAnnotation,
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
// Declared in `core/encoding.ts` now that `Platform` names it too, and
// re-exported here so every existing importer is unaffected.
export type { Encoding };

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

/**
 * Above this size, dirty tracking uses a cheap change counter — see
 * `#recomputeDirty`.
 *
 * **Measured 2026-08-25, and the number holds.** `doc.eq(savedDoc)` over equal
 * documents costs 1.2 ms at 1 MB, **2.6 ms at 2 MB**, 6.2 ms at 4 MB and
 * 23.2 ms at 16 MB — linear, as a tree walk should be. Against a 16 ms frame
 * the cut-off buys the exact comparison for 2.6 ms and refuses it at the point
 * where it starts to be a meaningful fraction of a frame.
 *
 * It is also less hot than it looks, which is why 2 MB is generous rather than
 * reckless: `isDirty` reaches the walk only when the change counter moved *and*
 * the length still matches. An ordinary keystroke changes the length and
 * returns on the line above. What reaches here is typing a character and
 * deleting it again, or a same-length replacement.
 */
const EXACT_DIRTY_LIMIT = 2_000_000;

/**
 * Files larger than this are refused; the editor is not a hex viewer.
 *
 * **Measured 2026-08-25, and the number holds** — on time. Building the
 * renderer's half of a document costs 1.3 ms at 1 MB, 10.5 ms at 16 MB, and
 * **35.9 ms at the 64 MB limit** (26.9 ms to split the string into lines,
 * 9.0 ms for `Text.of`). That is a one-off on open rather than anything on the
 * typing path, and a third of a second is not what a refusal is for.
 *
 * Two costs are still unmeasured and both argue for *lowering* this rather
 * than raising it, so treat 64 MB as a ceiling that has been checked from one
 * side only: the IPC hop, where the file crosses as a JSON string and is
 * therefore copied and re-parsed, and peak memory, where the transferred
 * string, the parsed string and the `Text` tree are all live at once.
 */
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
  /**
   * `Buffer.revision`, published so it can be *subscribed to*.
   *
   * `revisionOf(id)` answers the same question, but it is a method: a
   * component cannot depend on a method call, so a panel comparing revisions
   * to decide whether an answer still describes the code could not see the
   * edit that invalidated it. This list is already republished on every
   * document change, which is exactly the cadence that question needs.
   */
  revision: number;
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
  /** What `eol` was at the last save, for the dirty check above. */
  savedEol: Eol;
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
    this.savedEol = init.eol;
  }

  get isUntitled(): boolean {
    return this.path === null;
  }

  get isDirty(): boolean {
    // An EOL switch changes what a save writes without touching the doc, so
    // it dirties the buffer on its own.
    if (this.eol !== this.savedEol) return true;
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
      revision: this.revision,
    };
  }
}

export interface WorkspaceEvents {
  /** A buffer's EditorState was replaced wholesale — the view must re-sync. */
  'buffer-reset': { id: BufferId };
  'buffer-opened': { id: BufferId };
  /**
   * The user asked for this buffer — by clicking its tab, its row in the
   * explorer, or anything else that calls `setActive`.
   *
   * Distinct from the `activeId` signal changing, and that distinction is the
   * point: re-selecting the file you are already on changes nothing, so a
   * subscriber to the signal never hears about the single most common way of
   * saying "show me this file". This fires either way.
   */
  'buffer-activated': { id: BufferId };
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

/**
 * A registered pane. `owner` is the pane's own view, used only to tell it
 * apart from its siblings — the workspace never looks inside it.
 */
interface PaneChannel {
  dispatch: ViewDispatcher;
  owner: object | undefined;
  /** Which pane this is, when the caller said. */
  groupId: GroupId | undefined;
  /**
   * This pane's cursor **in one named buffer**, asked for rather than pushed.
   *
   * A selection changes on every cursor move, so publishing one would put
   * work on the typing path for something only the session ever reads. It is
   * pulled at save time instead.
   *
   * The buffer id is not decoration. A pane's *live* selection is its active
   * tab's, so a channel that answers whatever it is asked hands back the
   * foreground tab's cursor for every background tab in that pane — which is
   * what the session then persisted. A pane returns null for a buffer it is
   * not currently showing, and the caller falls back to that buffer's own
   * state, which is where a background tab's cursor actually lives.
   */
  readSelection: ((id: BufferId) => SelectionRecord | null) | undefined;
}

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
  #viewDispatchers = new Set<PaneChannel>();
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
  addViewDispatcher(
    dispatch: ViewDispatcher,
    options: {
      owner?: object;
      groupId?: GroupId;
      readSelection?: (id: BufferId) => SelectionRecord | null;
    } = {},
  ): () => void {
    const channel: PaneChannel = {
      dispatch,
      owner: options.owner,
      groupId: options.groupId,
      readSelection: options.readSelection,
    };
    this.#viewDispatchers.add(channel);
    return () => this.#viewDispatchers.delete(channel);
  }

  /**
   * Hand a change to the first view showing `id`, and say whether one took it.
   *
   * **First acceptor, not broadcast** — and the difference is a data-loss bug,
   * not a preference. A pane routes everything it is handed back through
   * `applyTransaction`, which forwards the change to every *other* pane
   * showing the file. So one delivery already reaches all of them; a second
   * delivery arrives at a document that has already moved. With a reload,
   * whose spec is `{from: 0, to: oldLength, insert: newDoc}`, a file that grew
   * came back as the new text with a slice of itself appended — and
   * `reloadFromDisk` then marked that document *clean*, so the next save wrote
   * it to disk. A file that shrank threw `RangeError` mid-reload instead.
   *
   * This was written as a broadcast to fix the opposite failure — one pane
   * updated, the other left showing text that no longer exists. The forwarding
   * in `applyTransaction` arrived later and covers that case properly, at
   * which point the broadcast became a second delivery rather than the only
   * one reaching the second pane.
   *
   * The forward is `#mirrorToOtherViews`, which does still broadcast — see
   * there for why the two cannot be the same method.
   */
  #dispatchToView(id: BufferId, spec: TransactionSpec | Transaction): boolean {
    for (const channel of this.#viewDispatchers) {
      // A pane showing a different buffer declines, so this is the first
      // *acceptor* rather than simply the first channel.
      if (channel.dispatch(id, spec)) return true;
    }
    return false;
  }

  /**
   * Push one pane's change out to every *other* pane showing the same buffer.
   *
   * A broadcast, unlike `#dispatchToView`, and safe as one for the reason that
   * method is not: the spec carries `mirroredAnnotation`, so a pane applies it
   * and stops rather than routing it back. Nothing re-enters, so nothing can
   * arrive twice — and with three panes on one file, stopping at the first
   * would leave the third holding text that no longer exists.
   *
   * `origin` is the pane the change came from. It has already applied the
   * change locally; handing it back would apply it a second time.
   */
  #mirrorToOtherViews(id: BufferId, changes: ChangeSet, origin: object): void {
    const spec: TransactionSpec = {
      changes,
      annotations: [mirroredAnnotation.of(true)],
    };
    for (const channel of this.#viewDispatchers) {
      if (channel.owner === origin) continue;
      channel.dispatch(id, spec);
    }
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
  async open(path: string, options: { encoding?: Encoding } = {}): Promise<BufferId | null> {
    const existing = this.findByPath(path);
    if (existing) {
      this.setActive(existing.id);
      // Re-focusing counts as use: quick-open orders by recency, and a file
      // you keep returning to should not sink down the list.
      this.#pushRecentFile(path);
      return existing.id;
    }

    let raw: string;
    let readEncoding: Encoding = 'utf-8';
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
      // `readEncodedFile` with no charset accepts only what can be proved —
      // a byte-order mark, or valid UTF-8. Anything else rejects, which is
      // what sends the user to the picker rather than to mojibake.
      const read = await this.#platform.readEncodedFile(path, options.encoding);
      raw = read.text;
      readEncoding = read.encoding;
    } catch (error) {
      this.#fail(`Could not open ${basename(path)}.`, describe(error));
      return null;
    }

    if (looksBinary(raw)) {
      this.#fail(`${basename(path)} is not a text file.`);
      return null;
    }

    const { doc, eol, encoding } = decode(raw, readEncoding);
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
  close(id: BufferId, options: { force?: boolean; group?: GroupId } = {}): boolean {
    const buffer = this.#map.get(id);
    if (!buffer) return true;
    if (buffer.isDirty && !options.force) return false;

    const group = this.#groupOf(id, options.group);
    if (group) {
      const index = group.order.indexOf(id);
      group.order.splice(index, 1);
      if (group.activeId === id) {
        group.activeId = group.order[Math.min(index, group.order.length - 1)] ?? null;
      }
    }

    // The document outlives a tab that was only one of its views. Deleting it
    // here would take the text out from under the pane still showing it —
    // which is what happened before a buffer could be in two groups.
    const stillShown = this.#groupsShowing(id).length > 0;
    if (stillShown) {
      if (group && group.order.length === 0 && this.#groups.length > 1) {
        this.#removeGroup(group.id);
      }
      this.#sync();
      return true;
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

  /**
   * Close every saved tab in a group — the one holding `within`, or the
   * active group. Dirty buffers are skipped, never prompted: this is the
   * sweep-away-what-is-safe gesture, so it must not be able to destroy
   * anything. (Contrast `closeOthers`, which force-discards.)
   */
  closeSaved(within?: BufferId): void {
    const group = (within ? this.#groupOf(within) : null) ?? this.#activeGroup();
    for (const id of [...group.order]) {
      this.close(id); // refuses dirty buffers without force — exactly the point
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
    // After the sync, so a handler that reads the workspace sees the state
    // this call produced. Unconditional: see the event's own comment.
    this.events.emit('buffer-activated', { id });
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

  /**
   * Reorder tabs, used by drag-and-drop in the tab strip.
   *
   * `fromGroupId` says which pane the tab leaves when the buffer is shown in
   * more than one; without it the first pane showing it is assumed, which is
   * the wrong one for a move out of the copy.
   */
  moveTab(id: BufferId, toIndex: number, targetGroupId?: GroupId, fromGroupId?: GroupId): void {
    const from = this.#groupOf(id, fromGroupId);
    if (!from) return;
    const to = targetGroupId ? this.#group(targetGroupId) : from;
    if (!to) return;

    from.order.splice(from.order.indexOf(id), 1);
    // A pane already showing the buffer takes the move as a close here plus
    // an activate there. A tab cannot be shown twice in one pane (see
    // `mirrorInto`): the keyed tab strip throws on the duplicate id and stops
    // updating.
    if (!to.order.includes(id)) {
      const clamped = Math.max(0, Math.min(to.order.length, toIndex));
      to.order.splice(clamped, 0, id);
    }

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
  /**
   * Show the active file in a second pane, side by side with this one.
   *
   * Unlike `splitEditor`, which *moves* a tab, this leaves it where it is and
   * adds a second view of the same document — the thing people mostly split
   * for: watching one part of a long file while editing another.
   *
   * Returns null when there is nothing to copy.
   */
  openCopyToSide(): GroupId | null {
    const source = this.#activeGroup();
    const id = source.activeId;
    if (id === null) return null;

    // The pane beside this one, either side, before making a new one — with a
    // layout that already has two, "to the side" means the one that is there.
    const index = this.#groups.indexOf(source);
    let group = this.#groups[index + 1] ?? this.#groups[index - 1];

    if (!group) {
      // Built here rather than through `splitEditor`, which *moves* the
      // active tab when its group has more than one. A copy must leave the
      // original where it is, or this is the split command under a new name.
      group = { id: `group-${this.#nextGroupId++}`, order: [], activeId: null };
      this.#groups.splice(index + 1, 0, group);
    }

    if (!group.order.includes(id)) group.order.push(id);
    group.activeId = id;
    this.#activeGroupId = group.id;
    this.#sync();
    return group.id;
  }

  /**
   * Add a pane beside the active one.
   *
   * The command moves the active tab across when its group has more than one,
   * which is what "split" means to someone pressing the key. **Session
   * restore must not**, and used to: it called this once per group after the
   * first, so a layout whose first pane held two tabs came back with the
   * second of them relocated into the new pane, every launch. `move: false`
   * is that caller — it wants an empty pane to open tabs into, nothing more.
   */
  splitEditor(options: { move?: boolean } = {}): GroupId {
    const source = this.#activeGroup();
    const group: EditorGroup = { id: `group-${this.#nextGroupId++}`, order: [], activeId: null };
    this.#groups.splice(this.#groups.indexOf(source) + 1, 0, group);

    const moving =
      options.move !== false && source.order.length > 1 ? source.activeId : null;
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
    // Only what the neighbour is not already showing: a file open in both
    // panes would otherwise become two tabs in one, which the keyed tab strip
    // refuses to render. The active tab is fine either way, since the id is
    // in the neighbour whichever branch it took.
    neighbour.order.push(...group.order.filter((id) => !neighbour.order.includes(id)));
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
    // From *this* pane, named: the buffer may be showing in both, and the
    // default lookup finds the first pane rather than the active one.
    this.moveTab(id, target.order.length, target.id, source.id);
  }

  #group(id: GroupId): EditorGroup | undefined {
    return this.#groups.find((group) => group.id === id);
  }

  #activeGroup(): EditorGroup {
    return this.#group(this.#activeGroupId) ?? this.#groups[0]!;
  }

  /**
   * The group showing `bufferId`, or a named one when the caller knows which.
   *
   * A buffer can now be in two groups, so `find` alone silently addresses
   * whichever comes first — which is right for the common case and wrong for
   * every caller acting on a specific pane. Passing `groupId` says which.
   */
  #groupOf(bufferId: BufferId, groupId?: GroupId): EditorGroup | undefined {
    if (groupId !== undefined) {
      const named = this.#groups.find((group) => group.id === groupId);
      return named?.order.includes(bufferId) ? named : undefined;
    }
    return this.#groups.find((group) => group.order.includes(bufferId));
  }

  /** Every group showing `bufferId`. */
  #groupsShowing(bufferId: BufferId): EditorGroup[] {
    return this.#groups.filter((group) => group.order.includes(bufferId));
  }

  /**
   * Show a buffer that is already open in a second group.
   *
   * The buffer is not copied — both tabs point at one `Buffer`, so there is
   * still one document, one dirty flag and one undo history. That is what
   * keeps saving, replace and the transaction log untouched by this feature.
   */
  mirrorInto(groupId: GroupId, bufferId: BufferId): boolean {
    const group = this.#groups.find((candidate) => candidate.id === groupId);
    if (!group || !this.#map.has(bufferId)) return false;
    // Already here: a tab cannot be shown twice in one pane.
    if (group.order.includes(bufferId)) return false;

    group.order.push(bufferId);
    group.activeId = bufferId;
    this.#sync();
    return true;
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
  applyTransaction(id: BufferId, transaction: Transaction, origin?: object): void {
    const buffer = this.#map.get(id);
    if (!buffer) return;
    buffer.state = transaction.state;
    if (transaction.docChanged) {
      // A transaction that is *itself* a mirror is never forwarded again.
      // The guard belongs here rather than in the panes: a consumer that
      // re-enters this method without checking would otherwise bounce one
      // keystroke between two views forever, and the workspace should not
      // depend on every caller's discipline for that.
      const isMirror = transaction.annotation(mirroredAnnotation) === true;
      // Forwarded only when the caller says which pane it is. Without that
      // there is no way to skip the sender, and it would receive its own
      // change and apply it twice — `RangeError: Applying change set to a
      // document with the wrong length`, which is how the watcher's fake
      // pane found this. A caller that does not identify itself gets exactly
      // the behaviour it had before panes could be mirrored.
      // Every other pane showing this file gets the change, or its own
      // `EditorState` goes stale — and its next edit would then be computed
      // against a document that no longer exists and silently discard this
      // one. Only the changes are forwarded, never the `Transaction` itself:
      // `@codemirror/view` rejects a transaction that does not start from the
      // state it is being applied to.
      if (!isMirror && origin !== undefined) {
        this.#mirrorToOtherViews(id, transaction.changes, origin);
      }
      buffer.changeCount++;
      buffer.revision++;
      this.#sync();
    }
  }

  /**
   * Switch what a save will write at each line's end.
   *
   * The document itself is canonical LF and does not change; `encode`
   * applies `eol` at save time. Dirties the buffer (see `isDirty`) because
   * the file on disk no longer matches what a save would write.
   */
  setEol(id: BufferId, eol: Eol): void {
    const buffer = this.#map.get(id);
    if (!buffer || buffer.eol === eol) return;
    buffer.eol = eol;
    buffer.revision++;
    this.#sync();
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

    // What the save is writing, captured before the await below. A keystroke
    // can land while the write is in flight, and the document after the
    // await is then not the document that went to disk. Everything past the
    // write compares against these, never against the live state.
    const written = buffer.state.doc;
    const writtenCount = buffer.changeCount;

    // The formatting as targeted changes, never one replacement of the whole
    // document: CodeMirror maps a position strictly inside a replaced range
    // to its start, so the replacement sent every cursor to offset 0, and the
    // `buffer-reset` that followed cost the pane its scroll position too.
    // Applied as changes, everything outside the edited spans maps through
    // untouched and the pane needs no reset at all.
    const formatting: { from: number; to?: number; insert?: string }[] = [];
    let text = written.toString();
    if (options.trimTrailingWhitespace) {
      for (const match of text.matchAll(/[ \t]+$/gm)) {
        formatting.push({ from: match.index, to: match.index + match[0].length });
      }
      text = text.replace(/[ \t]+$/gm, '');
    }
    if (options.insertFinalNewline && text.length > 0 && !text.endsWith('\n')) {
      formatting.push({ from: written.length, insert: '\n' });
      text += '\n';
    }

    const onDisk = encode(text, buffer.eol, buffer.encoding);

    try {
      // `writeEncodedFile`, never `writeTextFile`: the charset is whatever
      // the file was read as, and writing UTF-8 over a windows-1252 file
      // would change its bytes under a user who only pressed save.
      await this.#platform.writeEncodedFile(buffer.path, onDisk, buffer.encoding);
    } catch (error) {
      this.#fail(`Could not save ${buffer.name}.`, describe(error));
      return false;
    }

    if (buffer.changeCount !== writtenCount) {
      // The user typed during the write. The document is theirs now, and
      // replacing it with what was written would revert those keystrokes,
      // which was the failure here: the revert merged with the keystroke into
      // one history event, so undo could not reach the text either. The
      // formatting is skipped (the next save applies it), and the buffer is
      // dirty by exactly the edits that arrived: `savedDoc` is the text that
      // actually reached the disk, and the count is the one it was made at.
      buffer.savedDoc = Text.of(text.split('\n'));
      buffer.savedChangeCount = writtenCount;
    } else {
      // Formatting on save changes the document, so push it back into the
      // state as a real transaction — the user can undo it. Through the live
      // view where there is one, as a reload does, so the selection maps.
      if (formatting.length > 0) {
        const spec: TransactionSpec = { changes: formatting, scrollIntoView: false };
        if (!this.#dispatchToView(id, spec)) {
          buffer.state = buffer.state.update(spec).state;
          buffer.changeCount++;
          buffer.revision++;
        }
      }

      buffer.savedDoc = buffer.state.doc;
      buffer.savedChangeCount = buffer.changeCount;
    }
    buffer.savedEol = buffer.eol;
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

  /**
   * Set a buffer's language by hand, overriding what its name implied.
   *
   * Until this existed the language was whatever `detectLanguage` inferred at
   * open time and there was no way to disagree with it — which left every
   * untitled buffer as plaintext until its first save, and every unusual
   * extension unhighlighted for good.
   *
   * `buffer-reset` for the same reason `saveAs` emits it: the grammar has
   * changed, and so has the language the LSP document was opened under, and
   * the view has to re-sync to pick up both. That costs the scroll position,
   * which is a view concern and not in the `EditorState` — acceptable for a
   * rare, deliberate act, and the same price `saveAs` already pays.
   *
   * Returns false when nothing changed, so callers do not announce a no-op.
   */
  setLanguage(id: BufferId, languageId: string): boolean {
    const buffer = this.#map.get(id);
    if (!buffer) return false;

    // `languageById` falls back to plaintext rather than throwing, so an id
    // from a stale session cannot stop a buffer opening.
    const language = languageById(languageId);
    if (language.id === buffer.language.id) return false;

    buffer.language = language;
    this.#sync();
    this.events.emit('buffer-reset', { id });
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
  async reloadFromDisk(id: BufferId, readAs?: Encoding): Promise<boolean> {
    const buffer = this.#map.get(id);
    if (!buffer || buffer.path === null) return false;

    // Re-reading in a *different* charset is the same operation as reloading,
    // so it is the same method: the bytes on disk have not changed, only the
    // way they are being read. Passing one adopts it for every later save.
    const charset = readAs ?? buffer.encoding;

    let raw: string;
    let mtime = 0;
    try {
      // Pinned, not re-detected. Re-guessing on every external write is
      // exactly where mojibake creeps in: one reload of a legacy file with
      // no mark would otherwise refuse, or worse, come back as something else.
      raw = (await this.#platform.readEncodedFile(buffer.path, charset)).text;
      mtime = (await this.#platform.stat(buffer.path)).modified;
    } catch (error) {
      this.#fail(`Could not reload ${buffer.name}.`, describe(error));
      return false;
    }

    // A rewrite can change the line endings or add a BOM; the buffer should
    // follow the file rather than keep asserting what it used to be.
    // The charset is the one the buffer already has, not one re-inferred
    // from the new bytes: a legacy file has nothing in it to infer from, and
    // guessing again on every external write is where mojibake creeps in.
    const { doc, eol, encoding } = decode(raw, charset);
    buffer.eol = eol;
    buffer.savedEol = eol;
    buffer.encoding = encoding;

    const before = buffer.state.doc.toString();
    if (doc === before) {
      // Identical content: record the new mtime and leave the document alone
      // rather than pushing a no-op onto the undo stack.
      buffer.diskMtime = mtime;
      buffer.externalState = 'none';
      this.#sync();
      return true;
    }

    const spec: TransactionSpec = {
      changes: minimalChange(before, doc),
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
  selectionOf(id: BufferId, groupId?: GroupId): SelectionRecord | null {
    if (groupId !== undefined) {
      // One file can be shown in two panes, each with its own cursor. The
      // buffer's state carries whichever pane last dispatched, so the pane
      // has to be asked directly or both are recorded in the same place.
      for (const channel of this.#viewDispatchers) {
        if (channel.groupId !== groupId || !channel.readSelection) continue;
        // Asked about `id` rather than for "your cursor": see `PaneChannel`.
        const live = channel.readSelection(id);
        if (live) return live;
      }
    }
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
  /**
   * Cursor to give a pane the first time it shows a buffer, keyed by both.
   *
   * Restore runs before any `EditorView` exists, and a pane adopts the
   * buffer's state when it mounts — so two panes showing one file would land
   * on the same line. This is where the second one's cursor waits.
   */
  #pendingSelections = new Map<string, SelectionRecord>();

  /** Remember a cursor for a pane that is not showing yet. */
  setPaneSelection(groupId: GroupId, id: BufferId, selection: SelectionRecord): void {
    this.#pendingSelections.set(`${groupId}\u0000${id}`, selection);
  }

  /** Take it, once. A pane applies it on mount and never again. */
  takePaneSelection(groupId: GroupId, id: BufferId): SelectionRecord | null {
    const key = `${groupId}\u0000${id}`;
    const found = this.#pendingSelections.get(key) ?? null;
    if (found) this.#pendingSelections.delete(key);
    return found;
  }

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
    // Deduplicated by id: `tabs` is per pane, and a file shown in two panes
    // is still one open file. Anything counting or iterating open buffers —
    // save-all, the buffer switcher — must not see it twice.
    const seen = new Set<BufferId>();
    this.buffers.set(
      snapshots
        .flatMap((group) => group.tabs)
        .filter((tab) => !seen.has(tab.id) && seen.add(tab.id)),
    );
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
function decode(raw: string, reported: Encoding = 'utf-8'): { doc: string; eol: Eol; encoding: Encoding } {
  // The BOM still decides between the two UTF-8 spellings, because the mark
  // arrives in the string and has to be stripped from the document either
  // way. For anything else the platform's answer is authoritative — nothing
  // in the text can tell windows-1252 from shift_jis.
  const encoding: Encoding = raw.startsWith(BOM)
    ? 'utf-8-bom'
    : reported === 'utf-8-bom'
      ? 'utf-8'
      : reported;
  const body = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw;
  const eol: Eol = body.includes('\r\n') ? '\r\n' : '\n';
  return { doc: eol === '\r\n' ? body.replace(/\r\n/g, '\n') : body, eol, encoding };
}

/** The inverse of `decode`. */
function encode(doc: string, eol: Eol, encoding: Encoding): string {
  const body = eol === '\r\n' ? doc.replace(/\n/g, '\r\n') : doc;
  return encoding === 'utf-8-bom' ? BOM + body : body;
}

/**
 * The one change that turns `before` into `after`, trimmed to the span that
 * actually differs.
 *
 * A reload used to replace `[0, length)` with the new text, and CodeMirror
 * maps every position strictly inside a replaced range to its start, so the
 * cursor landed at offset 0 on every external rewrite while the viewport
 * stayed where it was. Trimming the common prefix and suffix keeps every
 * cursor, fold and mark outside the rewritten span exactly where it was; one
 * inside it lands at the start of what changed, the nearest position that
 * still means anything. A line diff would place those better, but this is
 * one linear pass with no allocation, which is what makes it safe on a file
 * at the size limit.
 */
function minimalChange(before: string, after: string): { from: number; to: number; insert: string } {
  const shortest = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shortest && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++;
  }
  // Never cut between the halves of a surrogate pair: the boundary is not a
  // position a cursor can sit at, and both strings hold the same half there.
  if (prefix > 0 && (before.charCodeAt(prefix - 1) & 0xfc00) === 0xd800) prefix--;
  if (suffix > 0 && (before.charCodeAt(before.length - suffix) & 0xfc00) === 0xdc00) suffix--;
  return { from: prefix, to: before.length - suffix, insert: after.slice(prefix, after.length - suffix) };
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

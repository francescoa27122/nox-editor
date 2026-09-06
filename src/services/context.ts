import { containsResolved } from '@core/path';
import { Signal } from '@core/signal';
import type { FileTreeService } from './filetree';
import type { Principal } from './permissions';
import type { AppliedChangeSet, Author, ChangeSetId } from './transactions';
import type { BufferId, Encoding, Eol, ExternalState, WorkspaceService } from './workspace';

/**
 * Structured read access for programmatic callers. This is what an agent
 * reads from.
 *
 * Two properties hold the whole design together:
 *
 * 1. **Nothing live is handed out.** Every return value is plain data that
 *    survives `JSON.stringify` — never a `Buffer`, an `EditorState` or a
 *    `Signal`. A caller that could reach a buffer could mutate it, and every
 *    mutation is supposed to go through `workspace.apply` under the
 *    permission model. A read API that leaks a handle is a hole in that.
 * 2. **Reading is bounded by the workspace, and recorded.** A non-user
 *    principal reads the buffers inside the open folder and nothing else, so
 *    a `.env` or an `~/.aws/credentials` the user happens to have in a tab is
 *    not part of what Nox hands a program. The boundary is the one
 *    `PermissionService` already applies to `fs.*`, asked with the same
 *    `containsResolved`, because two definitions of "inside the workspace"
 *    would be a rule nobody could state. `inScope` below is the whole of it.
 *
 *    Within that bound reads are recorded rather than prompted: a dialog per
 *    read would be a dialog for every keystroke of an agent's thinking, so
 *    every read by a non-user principal lands in `reads`, refusals included.
 *    This used to rest on "context cannot leave the process on its own",
 *    which was never true of a stdio agent. That is another process with its
 *    own network, and `net.request` gates Nox's commands, not it. The
 *    capability is still real and still worth having
 *    (`tests/net-request-gate.test.ts` stops it lapsing again); it just
 *    bounds what an in-process caller can send, not what an agent can.
 *
 * See AGENT-PLATFORM.md §2.5.
 */

/** A 1-based, inclusive line range. Lines, because that is how people read. */
export interface LineRange {
  from: number;
  to: number;
}

export interface BufferSummary {
  id: BufferId;
  path: string | null;
  name: string;
  languageId: string;
  languageName: string;
  isUntitled: boolean;
  isDirty: boolean;
  /**
   * The buffer's monotonic document revision — for comparing across reads to
   * see that it moved, and for passing back as `proposal.stage`'s
   * `baseRevisions` to say which revision an edit's offsets were computed
   * against. A declared revision the buffer is no longer at refuses the stage.
   *
   * Declaring it is optional, so an agent that does not is left with what
   * `AgentRuntime` recorded at its own reads, which does not cover a buffer
   * this listing is the only thing the session ever looked at.
   */
  revision: number;
  lineCount: number;
  /** Characters, not bytes. */
  length: number;
  eol: Eol;
  encoding: Encoding;
  externalState: ExternalState;
  isActive: boolean;
}

export interface SelectionRangeInfo {
  anchor: number;
  head: number;
  from: number;
  to: number;
  fromLine: number;
  toLine: number;
  /** Empty when the range is a bare cursor. */
  text: string;
}

export interface SelectionInfo {
  ranges: SelectionRangeInfo[];
  /** Index into `ranges` of the primary cursor. */
  main: number;
  isEmpty: boolean;
}

export interface TreeNode {
  path: string;
  name: string;
  kind: 'file' | 'directory';
  children?: TreeNode[];
}

export interface WorkspaceTree {
  root: string | null;
  nodes: TreeNode[];
  /**
   * True while the index is still being built, so a caller can tell a small
   * project from a partial answer.
   */
  indexing: boolean;
  fileCount: number;
}

export interface ChangeSetSummary {
  id: ChangeSetId;
  description: string;
  author: Author;
  bufferIds: BufferId[];
  at: number;
}

export interface TextOptions {
  /** 1-based, inclusive. Omit for the whole document. */
  lines?: LineRange;
  /** Prefix each line with its number, right-aligned, then a tab. */
  withLineNumbers?: boolean;
}

/** One read, for the audit trail. */
export interface ContextRead {
  principal: Principal;
  method: string;
  target?: string;
  at: number;
  /**
   * Set when the read was refused for asking about a buffer outside the root.
   *
   * Recorded rather than dropped, because "the agent tried to read the file
   * you have open outside the project" is exactly what an audit is looking
   * for, and a refusal that leaves no trace is indistinguishable from a read
   * that never happened.
   */
  refused?: true;
}

/** Where a buffer is scrolled to, when it is on screen at all. */
export type ViewportProvider = (id: BufferId) => LineRange | null;

const READ_LOG_LIMIT = 500;

export class ContextService {
  /** Reads by non-user principals, newest last. */
  readonly reads = new Signal<ContextRead[]>([]);

  #workspace: WorkspaceService;
  #files: FileTreeService;
  #viewport: ViewportProvider;

  constructor(
    workspace: WorkspaceService,
    files: FileTreeService,
    viewport: ViewportProvider = () => null,
  ) {
    this.#workspace = workspace;
    this.#files = files;
    this.#viewport = viewport;
  }

  setViewportProvider(viewport: ViewportProvider): void {
    this.#viewport = viewport;
  }

  /**
   * A reader bound to whoever is asking.
   *
   * Binding the principal once means no call site can forget to pass it, and
   * the read log cannot end up with anonymous entries.
   */
  reader(principal: Principal): ContextReader {
    return new ContextReader(this, principal);
  }

  /** @internal — called by `ContextReader`. */
  record(principal: Principal, method: string, target?: string, refused = false): void {
    // The user's reads are not recorded, for the same reason their permission
    // decisions are not: it would bury what an audit is looking for.
    if (principal.kind === 'user') return;
    this.reads.update((current) =>
      [
        ...current,
        {
          principal,
          method,
          at: Date.now(),
          ...(target ? { target } : {}),
          ...(refused ? { refused: true as const } : {}),
        },
      ].slice(-READ_LOG_LIMIT),
    );
  }

  /**
   * Whether a buffer is inside the boundary a non-user principal reads within.
   *
   * Three cases, and only the last refuses:
   *
   * - **No path.** An untitled buffer is not outside anything, and refusing it
   *   would leave an agent with nothing to read in the state Nox opens in:
   *   no folder, one scratch buffer.
   * - **No folder open.** There is no boundary to be outside of, which is the
   *   answer `PermissionService` already gives `fs.*` in that state. What
   *   still bounds a reader is that everything reachable here is a buffer the
   *   user opened by hand.
   * - **A path outside the root.** Refused, including a file that is already
   *   open. What the boundary is about is what Nox hands a program, and a
   *   credentials file in a tab is the case that motivated it.
   *
   * `containsResolved` rather than `contains`, for the reason that function
   * records: `<root>/../secrets/.env` reads as being under the root and is
   * not. What neither resolves is a symlink, so a link inside the root
   * pointing out of it is still readable. Closing that wants a real-path
   * capability the renderer does not have, and the permission layer has the
   * same gap for `fs.*`, so it is one known limit of one boundary rather than
   * a second quieter one. ARCHITECTURE.md §7 carries it.
   */
  inScope(id: BufferId): boolean {
    const path = this.#workspace.get(id)?.path ?? null;
    if (path === null) return true;
    const root = this.#workspace.rootPath.get();
    if (!root) return true;
    return containsResolved(root, path);
  }

  // --- The reads themselves ------------------------------------------------

  openBuffers(): BufferSummary[] {
    const activeId = this.#workspace.activeId.get();
    return this.#workspace.buffers.get().map((snapshot) => {
      const state = this.#workspace.stateOf(snapshot.id);
      return {
        ...snapshot,
        revision: this.#workspace.revisionOf(snapshot.id),
        lineCount: state?.doc.lines ?? 0,
        length: state?.doc.length ?? 0,
        isActive: snapshot.id === activeId,
      };
    });
  }

  activeBuffer(): BufferId | null {
    return this.#workspace.activeId.get();
  }

  bufferText(id: BufferId, options: TextOptions = {}): string | null {
    const state = this.#workspace.stateOf(id);
    if (!state) return null;

    const doc = state.doc;
    const from = Math.max(1, options.lines?.from ?? 1);
    const to = Math.min(doc.lines, options.lines?.to ?? doc.lines);
    if (from > to) return '';

    const width = String(to).length;
    const lines: string[] = [];
    for (let number = from; number <= to; number++) {
      const text = doc.line(number).text;
      lines.push(options.withLineNumbers ? `${String(number).padStart(width)}\t${text}` : text);
    }
    return lines.join('\n');
  }

  selection(id: BufferId): SelectionInfo | null {
    const state = this.#workspace.stateOf(id);
    if (!state) return null;

    const ranges = state.selection.ranges.map((range) => ({
      anchor: range.anchor,
      head: range.head,
      from: range.from,
      to: range.to,
      fromLine: state.doc.lineAt(range.from).number,
      toLine: state.doc.lineAt(range.to).number,
      text: state.doc.sliceString(range.from, range.to),
    }));

    return {
      ranges,
      main: state.selection.mainIndex,
      isEmpty: ranges.every((range) => range.from === range.to),
    };
  }

  viewport(id: BufferId): LineRange | null {
    return this.#viewport(id);
  }

  /**
   * The workspace as a tree.
   *
   * Built from the quick-open index rather than by walking the disk again, so
   * it shows exactly what ⌘P shows: the same exclusions, the same bounds, no
   * second definition of "the project" to drift. That also keeps every method
   * here synchronous, which the sketch did not manage — an async read is one
   * more await for a caller to get wrong.
   *
   * The cost is honest and reported: directories containing no indexed file do
   * not appear, and `indexing` says when the answer may still be partial.
   */
  workspaceTree(options: { depth?: number } = {}): WorkspaceTree {
    const root = this.#workspace.rootPath.get();
    const paths = this.#files.fileIndex.get();
    const maxDepth = options.depth ?? Infinity;

    const rootNodes: TreeNode[] = [];
    const directories = new Map<string, TreeNode>();

    for (const path of paths) {
      const relative = root && path.startsWith(root) ? path.slice(root.length + 1) : path;
      // Both separators: a Windows path is backslash-separated, and splitting
      // on `/` alone turned every file into one flat node whose name was the
      // whole relative path.
      const segments = relative.split(/[\\/]+/).filter(Boolean);
      if (segments.length === 0) continue;

      // Rebuild with whatever separator the path arrived with, so a node's
      // `path` is something the platform will accept back.
      const separator = path.includes('\\') ? '\\' : '/';
      let siblings = rootNodes;
      let prefix = root ?? '';

      for (const [index, segment] of segments.entries()) {
        const isLeaf = index === segments.length - 1;
        // `depth` counts directory levels; a file at the limit still shows,
        // because a tree of empty folders answers nothing.
        if (index >= maxDepth && !isLeaf) break;

        prefix = prefix ? `${prefix}${separator}${segment}` : segment;
        if (isLeaf) {
          siblings.push({ path: prefix, name: segment, kind: 'file' });
          break;
        }

        let directory = directories.get(prefix);
        if (!directory) {
          directory = { path: prefix, name: segment, kind: 'directory', children: [] };
          directories.set(prefix, directory);
          siblings.push(directory);
        }
        siblings = directory.children!;
      }
    }

    return {
      root,
      nodes: rootNodes,
      indexing: this.#files.indexing.get(),
      fileCount: paths.length,
    };
  }

  recentTransactions(limit = 20): ChangeSetSummary[] {
    return this.#workspace.log.recent(limit).map(summarise);
  }
}

function summarise(entry: AppliedChangeSet): ChangeSetSummary {
  return {
    id: entry.id,
    description: entry.description,
    author: entry.author,
    // Copied, not shared: the log's own array must not be reachable.
    bufferIds: [...entry.bufferIds],
    at: entry.at,
  };
}

/**
 * The context API as one principal sees it.
 *
 * Every method records the read before answering, so an audit of what an agent
 * looked at is complete by construction rather than by remembering to log.
 */
export class ContextReader {
  #context: ContextService;
  #principal: Principal;

  constructor(context: ContextService, principal: Principal) {
    this.#context = context;
    this.#principal = principal;
  }

  get principal(): Principal {
    return this.#principal;
  }

  /**
   * Whether this principal may read `id`.
   *
   * The user is exempt, for the same reason their reads are not logged: this
   * bounds what Nox hands a program, and it is not a restriction on the person
   * who opened the file. Every other principal, agent and plugin alike, gets
   * the workspace boundary, because "which program is asking" is not what the
   * question turns on.
   */
  #mayRead(id: BufferId): boolean {
    return this.#principal.kind === 'user' || this.#context.inScope(id);
  }

  /** Record a refused read and answer with nothing. */
  #refuse(method: string, id: BufferId): null {
    this.#context.record(this.#principal, method, id, true);
    return null;
  }

  openBuffers(): BufferSummary[] {
    this.#context.record(this.#principal, 'openBuffers');
    const open = this.#context.openBuffers();
    // Filtered rather than refused: a listing is not about one buffer, so
    // there is nothing to answer `null` to. Omitting the out-of-root ones is
    // also what keeps the opening brief honest, since `AgentRuntime` builds it
    // from this listing and so cannot name, or quote a selection from, a file
    // the reader would refuse the text of a moment later.
    return open.filter((buffer) => this.#mayRead(buffer.id));
  }

  activeBuffer(): BufferId | null {
    this.#context.record(this.#principal, 'activeBuffer');
    const id = this.#context.activeBuffer();
    // Null, not the id: an id handed out here is one `bufferText` refuses, and
    // pointing an agent at a buffer it may not read is worse than saying there
    // is no active one.
    if (id !== null && !this.#mayRead(id)) return null;
    return id;
  }

  bufferText(id: BufferId, options?: TextOptions): string | null {
    if (!this.#mayRead(id)) return this.#refuse('bufferText', id);
    this.#context.record(this.#principal, 'bufferText', id);
    return this.#context.bufferText(id, options);
  }

  selection(id: BufferId): SelectionInfo | null {
    if (!this.#mayRead(id)) return this.#refuse('selection', id);
    this.#context.record(this.#principal, 'selection', id);
    return this.#context.selection(id);
  }

  viewport(id: BufferId): LineRange | null {
    if (!this.#mayRead(id)) return this.#refuse('viewport', id);
    this.#context.record(this.#principal, 'viewport', id);
    return this.#context.viewport(id);
  }

  workspaceTree(options?: { depth?: number }): WorkspaceTree {
    this.#context.record(this.#principal, 'workspaceTree');
    return this.#context.workspaceTree(options);
  }

  recentTransactions(limit?: number): ChangeSetSummary[] {
    this.#context.record(this.#principal, 'recentTransactions');
    return this.#context.recentTransactions(limit);
  }
}

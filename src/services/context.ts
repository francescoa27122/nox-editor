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
 * 2. **Reading is not gated, but it is recorded.** Context cannot leave the
 *    process on its own — `net.request` is the capability that matters, and
 *    it is checked by the five commands that can reach the network. It was
 *    declared by none of them until 2026-08-31, which made this sentence an
 *    intention rather than a fact; `tests/net-request-gate.test.ts` is what
 *    stops it becoming one again. Prompting per read would mean a dialog for every
 *    keystroke of an agent's thinking, so instead every read by a non-user
 *    principal lands in `reads`.
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
  record(principal: Principal, method: string, target?: string): void {
    // The user's reads are not recorded, for the same reason their permission
    // decisions are not: it would bury what an audit is looking for.
    if (principal.kind === 'user') return;
    this.reads.update((current) =>
      [...current, { principal, method, at: Date.now(), ...(target ? { target } : {}) }].slice(
        -READ_LOG_LIMIT,
      ),
    );
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

  openBuffers(): BufferSummary[] {
    this.#context.record(this.#principal, 'openBuffers');
    return this.#context.openBuffers();
  }

  activeBuffer(): BufferId | null {
    this.#context.record(this.#principal, 'activeBuffer');
    return this.#context.activeBuffer();
  }

  bufferText(id: BufferId, options?: TextOptions): string | null {
    this.#context.record(this.#principal, 'bufferText', id);
    return this.#context.bufferText(id, options);
  }

  selection(id: BufferId): SelectionInfo | null {
    this.#context.record(this.#principal, 'selection', id);
    return this.#context.selection(id);
  }

  viewport(id: BufferId): LineRange | null {
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

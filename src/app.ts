import {
  copyLineDown,
  cursorDocEnd,
  cursorDocStart,
  deleteLine,
  indentLess,
  indentMore,
  moveLineDown,
  moveLineUp,
  redo,
  selectAll,
  toggleComment,
  undo,
} from '@codemirror/commands';
import { selectNextOccurrence } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import { definitionTargets, type LspLocation } from '@core/lsp-definition';
import { locationRows, referenceTargets, type LocationList } from '@core/lsp-references';
import { prepareRenameSeed, renameEdits } from '@core/lsp-rename';
import { changesOf, textEditsOf } from '@core/lsp-text-edit';
import { offsetAt, positionAt } from '@core/lsp-position';
import { ANCHOR_WINDOW, resolveAnchorLine } from '@core/anchor';
import { formatNoteFile, noteFileName, parseNoteFile } from '@core/note-file';
import { basename, dirname, join, relative, topLevelPaths } from '@core/path';
import { Signal } from '@core/signal';
import { pathToUri, uriToPath } from '@core/uri';
import { addCursorAbove, addCursorBelow, goToLine } from '@editor/commands';
import {
  foldAll,
  foldCode,
  foldToLevel,
  unfoldAll,
  unfoldAtCursor,
  unfoldCode,
} from '@editor/folding';
import { buildExtensions } from '@editor/extensions';
import { FindController } from '@editor/find';
import {
  clearProvenanceEffect,
  hasProvenance,
  nextProvenance,
  previousProvenance,
} from '@editor/provenance';
import { createPlatform } from '@platform/index';
import type { Platform } from '@platform/types';
import { CommandRegistry, type Command } from '@services/commands';
import { ConfigService, workspaceConfigPath, type SettingKey } from '@services/config';
import {
  AgentConfigService,
  AGENTS_FILE,
  isProcessAgent,
  runnableAgents,
  type AgentConfig,
  type OllamaAgentConfig,
} from '@services/agent/config';
import { LspService, ServerRegistry, SERVERS_FILE, type SessionStatusRow } from '@services/lsp';
import { OllamaProvider } from '@services/agent/ollama';
import type { AgentTransport } from '@services/agent/protocol';
import type { AnswerExpectation, ModelProvider } from '@services/agent/provider';
import {
  AgentRuntime,
  EXPLAIN_INSTRUCTION,
  ProviderTransport,
  scopeFromSelection,
} from '@services/agent/runtime';
import { StdioTransport } from '@services/agent/stdio';
import { ContextService } from '@services/context';
import { FileTreeService } from '@services/filetree';
import { KeymapService, platformIsMac } from '@services/keymap';
import { JobRunner } from '@services/jobs';
import { NotesService, type NoteAnchor } from '@services/notes';
import { NotificationService } from '@services/notifications';
import { ReviewService, type ReviewScope } from '@services/review';
import {
  describeCapability,
  PermissionError,
  PermissionService,
  type PermissionRequest,
  type Principal,
  type PromptAnswer,
} from '@services/permissions';
import { SearchService } from '@services/search';
import { MenuService } from '@services/menu';
import { SessionService } from '@services/session';
import { TerminalService } from '@services/terminal';
import { UIService } from '@services/ui';
import { UpdateService } from '@services/updates';
import { FileWatcherService } from '@services/watcher';
import { GitService } from '@services/git';
import { WorkspaceService, type BufferId } from '@services/workspace';
import { authorLabel, type ChangeSetSpec } from '@services/transactions';

/** What `NoxApp.formatBuffer` did. The save path and the command read it differently. */
export type FormatOutcome =
  | { kind: 'formatted' }
  | { kind: 'unchanged' }
  | { kind: 'unavailable' }
  | { kind: 'stale' }
  | { kind: 'timeout' }
  | { kind: 'failed'; message: string };

export interface CursorReadout {
  line: number;
  column: number;
  selectionLength: number;
  selectionLines: number;
  cursors: number;
}

/**
 * The application object.
 *
 * Owns every service and the command table. Components receive this through
 * Svelte context and never construct services themselves, which keeps the
 * dependency graph a tree rather than a web and makes the whole app
 * constructible in a test with one line.
 */
export class NoxApp {
  readonly platform: Platform;
  readonly config: ConfigService;
  readonly commands = new CommandRegistry();
  readonly keymap: KeymapService;
  readonly workspace: WorkspaceService;
  readonly files: FileTreeService;
  readonly watcher: FileWatcherService;
  readonly session: SessionService;
  readonly notifications = new NotificationService();
  /** Long-running background work: progress, cancellation. See `jobs.ts`. */
  readonly jobs = new JobRunner();
  readonly ui = new UIService();
  readonly find = new FindController();
  readonly search: SearchService;
  /** Policy for programmatic callers. See `permissions.ts`. */
  readonly permissions: PermissionService;
  /** Structured read access for programmatic callers. See `context.ts`. */
  readonly context: ContextService;
  /** Staged change sets awaiting hunk-level review. See `review.ts`. */
  readonly review: ReviewService;
  /** Agent sessions, their audit trail, and session-level undo. */
  readonly agents: AgentRuntime;
  /** Agents the user has configured in `agents.json`. */
  readonly agentConfig: AgentConfigService;
  /** Language servers the user has configured in `servers.json`. */
  readonly serverRegistry: ServerRegistry;
  /** Failures already announced, so a republished status does not repeat one. */
  #reportedFailures = new Set<string>();
  /** The running servers, and the diagnostics they publish. */
  readonly lsp: LspService;
  readonly terminal: TerminalService;
  /** What git holds for each open file, for the gutter. */
  readonly git: GitService;
  /** The user's own notes — not workspace files. See `notes.ts`. */
  readonly notes: NotesService;
  /** Checks for, and installs, newer releases. See `updates.ts`. */
  readonly updates: UpdateService;
  /** The native menu, built from the command table. See `menu.ts`. */
  readonly menu: MenuService;

  /** Set by EditorPane once a view exists. Null when no tab is open. */
  readonly view = new Signal<EditorView | null>(null);
  /**
   * The most recent answer to "where is this used" or "where is this
   * defined", as the References view shows it. One signal for both, because
   * the view is one panel and the last question asked is the one wanted.
   */
  readonly locations = new Signal<LocationList | null>(null);
  readonly homeDir = new Signal<string | null>(null);
  /** Cursor/selection readout for the status bar, updated by EditorPane. */
  readonly cursor = new Signal<CursorReadout>({
    line: 1,
    column: 1,
    selectionLength: 0,
    selectionLines: 0,
    cursors: 1,
  });

  #disposeDropListener: (() => void) | null = null;
  #disposeCloseListener: (() => void) | null = null;
  #disposeRejectionListener: (() => void) | null = null;
  /**
   * Errors already turned into a notification by the command failure sink.
   *
   * `CommandRegistry.execute` reports *and* rethrows, and nearly every call
   * site discards the promise — so the rejection backstop sees the same error
   * a moment later. Without this the user gets two toasts for one failure.
   */
  #reportedErrors = new WeakSet<object>();

  constructor(platform: Platform) {
    this.platform = platform;
    this.config = new ConfigService(platform);
    this.keymap = new KeymapService(this.commands, platform);
    // Buffers are created with the current settings and no grammar; the
    // grammar is reconfigured in once it resolves. See EditorPane.
    this.workspace = new WorkspaceService(platform, () =>
      buildExtensions(this.config.settings.get()),
    );
    this.files = new FileTreeService(platform);
    this.watcher = new FileWatcherService(
      platform,
      this.workspace,
      this.files,
      this.notifications,
    );
    this.session = new SessionService(platform, this.workspace);
    this.search = new SearchService(platform, this.workspace, this.jobs);
    // Keeps the search service free of any editor dependency.
    this.search.onReveal = (line, column) => this.goToLine(line, column);

    this.context = new ContextService(this.workspace, this.files, (id) => this.viewportOf(id));
    this.review = new ReviewService(this.workspace);
    this.permissions = new PermissionService(() => this.workspace.rootPath.get());
    this.permissions.setPrompter((request) => this.#askPermission(request));
    // The one place permissions are enforced. Every action is already a
    // command, so this single check covers everything a plugin or agent could
    // ask for — and the user never reaches it.
    this.commands.setGuard(async (command, principal, resource) => {
      for (const capability of command.capabilities ?? []) {
        await this.permissions.require({
          principal,
          capability,
          description: command.title,
          ...(resource ? { resource } : {}),
        });
      }
    });
    // The one place a failed command becomes something the user can see.
    this.commands.setFailureSink((command, error) => {
      this.#reportFailure(`${command.title} failed`, error);
    });
    this.#installRejectionBackstop();

    this.agentConfig = new AgentConfigService(platform);
    this.serverRegistry = new ServerRegistry(platform);
    this.lsp = LspService.spawnedBy(platform, this.workspace, this.serverRegistry, () =>
      this.workspace.rootPath.get() ?? '',
    );
    this.terminal = new TerminalService(
      platform,
      () => this.workspace.rootPath.get(),
      () => this.config.get('terminal.shell'),
    );
    this.agents = new AgentRuntime({
      workspace: this.workspace,
      context: this.context,
      commands: this.commands,
      permissions: this.permissions,
      review: this.review,
      jobs: this.jobs,
    });
    this.notes = new NotesService(platform);
    this.git = new GitService(platform, this.workspace, this.notifications);
    // Behind the capability: over a platform without git every base would
    // be null and the subscriptions pure overhead. Tests start it directly
    // over a MemoryPlatform with seeded bases — the language-server pattern.
    if (platform.capabilities.gitState) this.git.start();

    this.updates = new UpdateService(
      platform,
      this.config,
      this.notifications,
      this.jobs,
      // What quit flushes, in quit's order (see dispose()): the restart an
      // install ends in must not cost a keystroke.
      async () => {
        await this.notes.flush();
        await this.config.flush();
        await this.session.save();
      },
    );
    // Behind the capability, like git: a platform that cannot replace
    // itself would make every check a no-op. Tests start it directly.
    if (platform.capabilities.selfUpdate) this.updates.start();

    // Constructed here but installed in `#boot`: it reads the command table
    // and the keymap when it builds the tree, and neither is complete until
    // the registrations below and the user's own rules have both landed.
    this.menu = new MenuService(platform, this.commands, this.keymap);

    this.#wireServices();
    this.#registerCommands();
    this.#registerKeybindings();
  }

  static async create(): Promise<NoxApp> {
    const platform = await createPlatform();
    const app = new NoxApp(platform);
    await app.#boot();
    return app;
  }

  // --- Boot ---------------------------------------------------------------

  async #boot(): Promise<void> {
    this.homeDir.set(await this.platform.homeDir());
    await this.config.load();
    // Before the session restores a root: the subscription above fires on
    // that restore, but boot's own `files.setRoot` below should already see
    // the project's excludes.
    await this.config.loadWorkspace(this.workspace.rootPath.get());
    // After the constructor, so `#registerKeybindings` has already recorded
    // the defaults these rules are layered over.
    await this.keymap.loadUserRules();
    await this.agentConfig.load();
    await this.serverRegistry.load();
    await this.notes.load();
    this.files.setExcludes(this.config.get('files.excludeFromExplorer'));

    const restored = this.config.get('workbench.restoreSession')
      ? await this.session.restore()
      : false;

    // The browser build has an in-memory demo project; opening it on a cold
    // start is far better than showing an empty window.
    if (!restored && this.platform.id === 'web') {
      const folder = await this.platform.pickFolder();
      if (folder) {
        await this.workspace.openFolder(folder);
        await this.workspace.open(join(folder, 'README.md'));
      }
    }

    await this.files.setRoot(this.workspace.rootPath.get());
    await this.#listenForExternalDrops();
    await this.#listenForClose();
    await this.#installMenu();
    this.#applyTheme();
    this.#updateWindowTitle();
    // Only now is it safe to persist: everything the session describes exists.
    this.session.markReady();
  }

  /**
   * Put the command table in the menu bar.
   *
   * Behind the capability like git and the updater: a target with no menu bar
   * would be building a tree for nothing. Failure is warned about and not
   * fatal — an editor with no menu still edits, and refusing to boot over the
   * chrome would be the worse trade.
   */
  async #installMenu(): Promise<void> {
    if (!this.platform.capabilities.applicationMenu) return;
    try {
      await this.menu.start();
    } catch (error) {
      console.warn('[nox] application menu unavailable:', error);
    }
  }

  async #listenForExternalDrops(): Promise<void> {
    if (!this.platform.capabilities.externalFileDrop) return;

    try {
      this.#disposeDropListener = await this.platform.onExternalFileDrop((event) => {
        if (event.phase === 'drop') {
          this.ui.externalDropActive.set(false);
          void this.openDroppedPaths(event.paths);
          return;
        }
        this.ui.externalDropActive.set(event.phase === 'enter');
      });
    } catch (error) {
      // Drag-and-drop is a convenience; failing to wire it must not stop boot.
      console.warn('[nox] external file drop unavailable:', error);
    }
  }

  /**
   * Flush everything worth keeping before the window goes away.
   *
   * There is deliberately no "you have unsaved changes" prompt: the session
   * records unsaved work and restores it on next launch, which is strictly
   * better than a dialog — you cannot lose work by answering it wrong, and
   * quitting stays instant.
   */
  async #listenForClose(): Promise<void> {
    try {
      this.#disposeCloseListener = await this.platform.onCloseRequested(async () => {
        await this.dispose();
      });
    } catch (error) {
      // Without this the debounced session save is the only persistence, which
      // is a real gap — worth a warning even though boot must continue.
      console.warn('[nox] close handler unavailable; quit may lose recent changes:', error);
    }
  }

  #wireServices(): void {
    this.workspace.events.on('error', ({ message, detail }) => {
      this.notifications.error(message, detail);
    });

    // A new proposal shows itself; discarding or applying puts it away.
    this.review.staged.subscribe((staged) => this.ui.reviewOpen.set(staged !== null));

    // Opening a file from quick-open should show it in the tree, so the
    // explorer never disagrees with what you are looking at.
    this.workspace.events.on('buffer-opened', ({ id }) => {
      const path = this.workspace.buffers.get().find((b) => b.id === id)?.path;
      if (path && this.workspace.rootPath.get()) void this.files.reveal(path);
    });

    // Going to a file has to show you the file. Hooked to the *active buffer*
    // rather than to opening one, because clicking a tab or a file that is
    // already open does not open anything — and that is the common case.
    // The review is kept, not discarded; the status bar offers it back.
    this.workspace.activeId.subscribe(() => {
      if (this.ui.reviewOpen.get()) this.ui.reviewOpen.set(false);
      if (this.ui.agentsOpen.get()) this.ui.agentsOpen.set(false);
      // `diffOpen` deliberately survives: the diff view is a lens on
      // whichever file is active, and switching tabs while it is open
      // should show the new file's changes, not put the view away.
    });

    // Servers are per workspace, so they start when one opens and stop when it
    // changes. Nothing starts without a root: a server given a root of nowhere
    // indexes nothing and reports nothing, which looks exactly like a broken
    // server.
    this.workspace.rootPath.subscribe((root) => {
      void this.#restartLanguageServers(root);
    });

    // A server that fails says so once, with the reason.
    //
    // The status bar already turns yellow and the tooltip already carries the
    // message, but a colour change is something you notice and then have to
    // interrogate. The most common first-run failure -- a server that cannot
    // find its own TypeScript -- is entirely diagnosable from the text the
    // server sent, and leaving that text one hover away wastes it.
    this.lsp.sessions.subscribe((sessions) => this.#reportFailedServers(sessions));

    // Diagnostics are painted by `EditorPane`, not from here. See the comment
    // there: this class knows `workspace.activeId`, which is not the same
    // question as "which buffer does that view currently hold", and answering
    // the wrong one wrote diagnostics into the wrong file's state.

    this.workspace.rootPath.subscribe((root) => {
      void this.files.setRoot(root);
      void this.watcher.start(root);
      // A project's own settings arrive and leave with the project. Closing a
      // folder must not leave its indentation behind.
      void this.config.loadWorkspace(root);
      this.#updateWindowTitle();
      this.session.schedule();
    });

    // `.nox/settings.json` edited in Nox or in another window is the same
    // event: a file changed. Saving it from a tab arrives here too.
    this.watcher.onPathsChanged((paths) => {
      const root = this.workspace.rootPath.get();
      if (!root) return;
      if (!paths.has(workspaceConfigPath(root))) return;
      void this.config.loadWorkspace(root);
    });

    // A closed tab should not keep its "changed on disk" warning suppressed.
    this.workspace.events.on('buffer-closed', ({ id }) => this.watcher.clearWarning(id));

    this.workspace.buffers.subscribe(() => {
      this.#updateWindowTitle();
      this.session.schedule();
    });

    this.workspace.activeId.subscribe(() => {
      this.#updateWindowTitle();
      this.session.schedule();
    });

    this.config.changed.subscribe((keys) => {
      if (keys.has('workbench.theme')) this.#applyTheme();
      if (keys.has('files.excludeFromExplorer')) {
        this.files.setExcludes(this.config.get('files.excludeFromExplorer'));
      }
    });

    // Notes have no on-disk original to fall back on: a save that does not
    // land means the text exists only in memory, so it is worth saying.
    this.notes.error.subscribe((message) => {
      if (message) this.notifications.error('Could not save notes', message);
    });

    // The same treatment for the three writes that used to fail in silence.
    // Each message says what is actually at stake rather than "write failed",
    // because the consequence is different every time and only the user can
    // do anything about the cause.
    this.config.error.subscribe((message) => {
      if (message) {
        this.notifications.error(
          'Could not save your settings',
          `${message}\n\nNox is using your changes now, but they will be back to their previous values next launch.`,
        );
      }
    });

    this.keymap.error.subscribe((message) => {
      if (message) {
        this.notifications.error(
          'Could not save your keyboard shortcuts',
          `${message}\n\nYour rebindings work for this session and will be gone next launch.`,
        );
      }
    });

    this.session.error.subscribe((message) => {
      if (message) {
        this.notifications.error(
          'Could not save your session',
          `${message}\n\nUnsaved work is only in memory. Save anything you cannot lose before quitting.`,
        );
      }
    });

    // Each configured local model becomes a provider the agent panel can start
    // a session with. Re-registered wholesale when agents.json changes, which
    // is rare and much simpler than diffing the list.
    let disposeProviders: (() => void)[] = [];
    this.agentConfig.agents.subscribe((agents) => {
      for (const dispose of disposeProviders) dispose();
      disposeProviders = agents
        .filter((agent): agent is OllamaAgentConfig => agent.kind === 'ollama')
        .filter(() => this.platform.capabilities.localModels)
        .map((agent) => this.agents.registerProvider(new OllamaProvider(this.platform, agent)));
    });
  }

  #applyTheme(): void {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-nox-theme', this.config.get('workbench.theme'));
  }

  #updateWindowTitle(): void {
    const active = this.workspace.activeSnapshot();
    const root = this.workspace.rootPath.get();
    const parts: string[] = [];
    if (active) parts.push(`${active.isDirty ? '● ' : ''}${active.name}`);
    if (root) parts.push(basename(root));
    parts.push('Nox');
    void this.platform.setWindowTitle(parts.join(' — '));
  }

  // --- Editor access ------------------------------------------------------

  /** Run a CodeMirror command against the focused editor. */
  #runEditor(command: (view: EditorView) => boolean): boolean {
    const view = this.view.get();
    if (!view) return false;
    const handled = command(view);
    view.focus();
    return handled;
  }

  /**
   * Undo or redo, taking a multi-file change set back as one step.
   *
   * A project-wide replace is one action to the user, so it should cost one
   * ⌘Z — not one per file it happened to touch. Anything that only touched a
   * single buffer falls through to CodeMirror's own command, which does the
   * same thing with fewer moving parts.
   */
  #step(direction: 'undo' | 'redo'): boolean {
    const setId =
      direction === 'undo'
        ? this.workspace.pendingGroupedUndo()
        : this.workspace.pendingGroupedRedo();

    if (setId) {
      const entry = this.workspace.log.get(setId);
      const outcome =
        direction === 'undo'
          ? this.workspace.undoChangeSet(setId)
          : this.workspace.redoChangeSet(setId);

      if (outcome.undone.length > 0) {
        const verb = direction === 'undo' ? 'Undid' : 'Redid';
        const files = `${outcome.undone.length} file${outcome.undone.length === 1 ? '' : 's'}`;
        // A partial result is stated rather than passed off as complete: the
        // skipped files are ones edited since, and their work was kept.
        const skipped =
          outcome.skipped.length > 0 ? ` — ${outcome.skipped.length} changed since, left alone` : '';
        this.notifications.info(
          `${verb} ${entry?.description ?? 'change'} across ${files}${skipped}`,
        );
        this.view.get()?.focus();
        return true;
      }
    }

    return this.#runEditor(direction === 'undo' ? undo : redo);
  }

  #activeHasProvenance(): boolean {
    const view = this.view.get();
    return view ? hasProvenance(view.state) : false;
  }

  /**
   * Whether any open buffer — not just the active one — has marks.
   *
   * Gates "Clear Change Marks", which the design promises drops marks
   * everywhere: the only live producer of change sets is a project-wide
   * replace across several open files, so the command must stay enabled
   * whenever any of them still carries a mark, not just the tab on screen.
   */
  #anyBufferHasProvenance(): boolean {
    return this.workspace.buffers.get().some((buffer) => {
      const state = this.workspace.stateOf(buffer.id);
      return state ? hasProvenance(state) : false;
    });
  }

  /**
   * Move the cursor to the next or previous marked region.
   *
   * Says so when there is nothing further rather than wrapping: a review that
   * silently returns to the top is a review you lose your place in.
   */
  #goToProvenance(direction: 'next' | 'previous'): void {
    const view = this.view.get();
    if (!view) return;
    const from = view.state.selection.main.head;
    const target =
      direction === 'next'
        ? nextProvenance(view.state, from)
        : previousProvenance(view.state, from);

    if (!target) {
      this.notifications.info(
        direction === 'next' ? 'No later changes in this file' : 'No earlier changes in this file',
      );
      return;
    }

    view.dispatch({
      selection: { anchor: target.from, head: target.to },
      scrollIntoView: true,
    });
    view.focus();
  }

  /**
   * "Clear Change Marks": drops every mark in every buffer, live or
   * background — not just the active one. `WorkspaceService.broadcastEffect`
   * carries the effect to a background buffer's state directly, the same
   * fallback `apply()` uses for a buffer with no mounted view.
   */
  #clearProvenance(): void {
    this.workspace.broadcastEffect(clearProvenanceEffect.of(null));
  }

  /**
   * Turn a thrown thing into a notification, once.
   *
   * `PermissionError` is skipped: a refusal is the permission model working,
   * and the person who answered the prompt does not need to be told what they
   * just said. Everything else is a fault, and a fault with no artefact is
   * indistinguishable from success — which is why "Save As…" was the worst
   * case of this: silence there reads as "saved".
   */
  #reportFailure(headline: string, error: unknown): void {
    if (error instanceof PermissionError) return;
    if (typeof error === 'object' && error !== null) {
      if (this.#reportedErrors.has(error)) return;
      this.#reportedErrors.add(error);
    }
    this.notifications.error(headline, error instanceof Error ? error.message : String(error));
  }

  /**
   * Catch promise rejections nothing else caught.
   *
   * The failure sink covers commands, which is most of the app; this covers
   * the rest — a rejected `void`-ed promise in a component effect, a service
   * callback, a listener. There is no devtools console in the release
   * webview, so without this those genuinely vanish.
   */
  #installRejectionBackstop(): void {
    // Node has no `addEventListener` on `globalThis`, so the headless test
    // environment simply gets no backstop rather than a crash at construction.
    if (typeof globalThis.addEventListener !== 'function') return;

    const onRejection = (event: Event) => {
      // Typed structurally rather than as `PromiseRejectionEvent`: the handler
      // is registered on `globalThis`, whose listener signature is `Event`.
      const { reason } = event as Event & { reason?: unknown };
      this.#reportFailure('Something went wrong', reason);
    };

    globalThis.addEventListener('unhandledrejection', onRejection);
    this.#disposeRejectionListener = () =>
      globalThis.removeEventListener('unhandledrejection', onRejection);
  }

  /**
   * Ask the user to decide a permission.
   *
   * Dismissing the dialog is a denial: an unanswered question about whether
   * something may change your files has exactly one safe reading. So is
   * pressing Enter the instant the prompt appears, which is why `deny` is
   * named as the default and the session-wide grant — the widest answer on
   * offer, and the only one that keeps applying after this question — is the
   * one marked destructive.
   */
  async #askPermission(request: PermissionRequest): Promise<PromptAnswer> {
    const who = request.principal.kind === 'agent' ? request.principal.label : 'A plugin';
    const where = request.resource ? `\n\n${this.#displayPath(request.resource)}` : '';

    const choice = await this.ui.askToConfirm({
      title: `Allow ${describeCapability(request.capability)}?`,
      message: `${who} wants to ${describeCapability(request.capability)}${
        request.description ? ` (${request.description})` : ''
      }.${where}`,
      choices: [
        { id: 'allow-session', label: 'Allow for this session', danger: true },
        { id: 'allow-once', label: 'Allow once' },
        { id: 'deny', label: 'Deny' },
      ],
      defaultChoiceId: 'deny',
    });

    return choice === 'allow-session' || choice === 'allow-once' ? choice : 'deny';
  }

  /**
   * Take back standing permissions, and leave everything else alone.
   *
   * Shared by the palette commands and the Agents panel button so the two
   * cannot drift into reporting different things, which is the same reason
   * `applyReview` exists.
   *
   * The detail line is the load-bearing half. Before this, `forgetSession`
   * had exactly one caller — `AgentRuntime.undoSession` — so the only way to
   * stop an agent writing was to revert everything it had written. A user
   * pressing something called "revoke" has every reason to expect the same
   * thing here, and has to be told plainly that their files were left alone.
   */
  revokeGrants(principal?: Principal): number {
    const forgotten = this.permissions.forgetSession(principal);
    const who = principal ? authorLabel(principal) : 'Agents and plugins';

    if (forgotten.length === 0) {
      // Deliberately not phrased as a success. Saying "revoked" when nothing
      // was standing would leave the user believing a door was shut that was
      // never open, and §2.6 spends its length on exactly that distinction.
      this.notifications.info(
        principal ? `${who} holds no standing permissions` : 'No standing permissions to revoke',
        'Anything allowed so far was allowed once, or allowed by policy. Neither is a grant.',
      );
      return 0;
    }

    this.notifications.success(
      `Revoked ${forgotten.length} standing ${
        forgotten.length === 1 ? 'permission' : 'permissions'
      }`,
      `${who} will be asked again next time. Nothing already written has changed — ` +
        'undo the session for that.',
    );
    return forgotten.length;
  }

  /**
   * Apply the accepted hunks of the staged review, and say what happened.
   *
   * Shared by the panel's Apply button and the palette command, so the two
   * cannot drift into reporting different things.
   */
  applyReview(): boolean {
    const { hunks, files } = this.review.acceptedCount();
    const result = this.review.apply();

    if (result.ok) {
      this.notifications.success(
        `Applied ${hunks} ${hunks === 1 ? 'change' : 'changes'} across ${files} ${
          files === 1 ? 'file' : 'files'
        }`,
      );
      return true;
    }

    if (result.reason === 'stale') {
      this.notifications.warn(
        'Those files changed while you were reviewing',
        'Nothing was applied. Discard this review and ask again, so the change is built on what the files say now.',
      );
    } else if (result.reason === 'missing') {
      this.notifications.warn('Some of those files are no longer open', 'Nothing was applied.');
    }
    return false;
  }

  /**
   * Start a configured agent on an instruction.
   *
   * Two prompts rather than one dialog: which agent (skipped when there is
   * only one), then what to ask it. Both are cancellable, and nothing starts
   * until the instruction is given.
   */
  async runAgent(agentId?: string): Promise<void> {
    const chosen = await this.#chooseAgent(agentId);
    if (!chosen) return;

    const instruction = await this.ui.askForText({
      title: `Ask ${chosen.label}`,
      label: 'Instruction',
      initialValue: '',
      placeholder: 'Rename Task to Job across the project',
      confirmLabel: 'Run',
      validate: (value) => (value.trim().length === 0 ? 'Say what you want done' : null),
    });
    if (!instruction) return;

    await this.#startAgentSession(chosen, instruction);
  }

  /**
   * Ask a model to change the selected text.
   *
   * The scope is captured before the instruction is typed, so it describes
   * what the user was looking at when they ran the command. It only ever
   * defaults a hunk in the review panel, so a scope that goes stale while
   * they type costs a checkbox, not correctness.
   */
  async runAgentOnSelection(): Promise<void> {
    const scope = this.#selectionScope();
    if (!scope) {
      this.notifications.info('Nothing is selected', 'Select the text you want changed, then run this again.');
      return;
    }

    const chosen = await this.#chooseAgent();
    if (!chosen) return;

    const instruction = await this.ui.askForText({
      title: `Ask ${chosen.label} about the selection`,
      label: 'What should it do?',
      initialValue: '',
      placeholder: 'Rewrite this as a single expression',
      confirmLabel: 'Run',
      validate: (value) => (value.trim().length === 0 ? 'Say what you want done' : null),
    });
    if (!instruction) return;

    await this.#startAgentSession(chosen, instruction, scope);
  }

  /**
   * Ask a model about the selected text, in prose.
   *
   * The mirror of `runAgentOnSelection`, and deliberately the same shape: the
   * scope is captured before anything is typed, so it describes where the
   * user was looking rather than where they ended up. Here it records what
   * the answer is *about* rather than defaulting a hunk — a prose session
   * produces none.
   *
   * `instruction` is supplied by **Explain Selection**, which skips the
   * dialog; **Ask About Selection…** leaves it undefined and asks.
   */
  async askAboutSelection(instruction?: string): Promise<void> {
    const scope = this.#selectionScope();
    if (!scope) {
      this.notifications.info(
        'Nothing is selected',
        'Select the code you want explained, then run this again.',
      );
      return;
    }

    const chosen = await this.#chooseAgent();
    if (!chosen) return;

    const question =
      instruction ??
      (await this.ui.askForText({
        title: `Ask ${chosen.label} about the selection`,
        label: 'What do you want to know?',
        initialValue: '',
        placeholder: 'What does this actually do when the list is empty?',
        confirmLabel: 'Ask',
        validate: (value) => (value.trim().length === 0 ? 'Say what you want to know' : null),
      }));
    if (!question) return;

    await this.#startAgentSession(chosen, question, scope, 'prose');
  }

  /** Pick a runnable agent, or explain why there is none. */
  async #chooseAgent(agentId?: string): Promise<AgentConfig | undefined> {
    const configured = this.agentConfig.agents.get();
    const choices = this.#runnableAgents();

    if (choices.length === 0) {
      if (configured.length === 0) {
        this.notifications.info('No agents are configured', 'Run "Configure Agents" to add one.');
      } else {
        this.notifications.warn(
          'None of the configured agents can run here',
          'The browser build can neither start a process nor reach a local model.',
        );
      }
      return undefined;
    }

    const named = agentId ? choices.find((agent) => agent.id === agentId) : undefined;
    if (named) return named;
    if (choices.length === 1) return choices[0];

    const picked = await this.ui.askToConfirm({
      title: 'Which agent?',
      message: 'Pick the agent to run this instruction.',
      choices: choices.map((agent) => ({ id: agent.id, label: agent.label })),
    });
    if (!picked) return undefined;
    return choices.find((agent) => agent.id === picked);
  }

  /**
   * Start a session against a chosen record.
   *
   * Shared by every agent command so a fix to one cannot miss the others —
   * the reload guard below was written once and is load-bearing for all of
   * them.
   */
  async #startAgentSession(
    chosen: AgentConfig,
    instruction: string,
    scope?: ReviewScope,
    expects?: AnswerExpectation,
  ): Promise<void> {
    let transport: AgentTransport;
    // Defaults to the record picked from the list; the ollama branch below
    // overrides it with the label of the provider actually looked up, so a
    // rename that lands mid-typing is reflected rather than papered over.
    let label = chosen.label;
    if (isProcessAgent(chosen)) {
      // Where the child runs. The record wins; otherwise the open project,
      // which is what `AgentProcessSpec.cwd` documents and what
      // `TerminalService` and `LspService` already do. Left out entirely when
      // no folder is open: the alternative is inheriting whatever directory
      // Nox was launched from — `/` from Finder — against which the relative
      // `./my-agent.js` in `AGENTS_TEMPLATE` resolves somewhere different
      // every launch.
      const cwd = chosen.cwd ?? this.workspace.rootPath.get();
      const spec = {
        command: chosen.command,
        ...(chosen.args ? { args: chosen.args } : {}),
        ...(cwd ? { cwd } : {}),
      };
      transport = StdioTransport.spawnedBy(this.platform, spec, { label: chosen.label });
    } else {
      // Looked up now rather than when it was picked: agents.json can be
      // reloaded while the instruction is being typed, and that drops every
      // provider. Starting a session against a deregistered one would run a
      // model the user can no longer see configured.
      const provider = this.#providerFor(chosen.id);
      if (!provider) {
        this.notifications.warn(
          `${chosen.label} is no longer configured`,
          'agents.json was reloaded while you were typing.',
        );
        return;
      }
      transport = new ProviderTransport(provider);
      // The same id can survive a reload under a different label (a typing
      // edit to agents.json, not just removal) — that yields a *new*
      // provider under the old id, so the session must be named after the
      // provider that will actually run it, not the record picked before it.
      label = provider.label;
    }

    this.agents.start(transport, instruction.trim(), {
      label,
      ...(scope ? { scope } : {}),
      ...(expects ? { expects } : {}),
    });
    // A question goes where its answer will be. The agents panel is a record
    // of what a session read and ran, and takes over the editor area to show
    // it — the wrong place, and the wrong size, for a paragraph of prose.
    if (expects === 'prose') {
      // The sidebar can be hidden, and unlike the edit path prose has no
      // second surface to land on: the answer would arrive in a panel that is
      // not on screen and nothing would say so. Same move `search.focus` and
      // `nav.focusExplorer` make before focusing.
      this.config.set('workbench.showExplorer', true);
      this.ui.focusAnswers();
    } else this.ui.showAgents();
  }

  /** The scope the active editor's selection implies, or null. */
  #selectionScope(): ReviewScope | null {
    const buffer = this.workspace.active();
    if (!buffer) return null;
    return scopeFromSelection(buffer.id, this.context.selection(buffer.id));
  }

  /** The provider registered for an agent record, by its id. */
  #providerFor(id: string): ModelProvider | undefined {
    return this.agents.providers.get().find((provider) => provider.id === id);
  }

  /**
   * The configured agents this build can actually start, in configured order.
   *
   * Thin wrapper around the pure `runnableAgents`: the policy itself lives in
   * `services/agent/config.ts` so it is testable without an `App`, and so
   * `AgentPanel.svelte` — which cannot reach this private method — can call
   * the same function instead of re-deriving its own copy.
   */
  #runnableAgents(): AgentConfig[] {
    return runnableAgents(this.agentConfig.agents.get(), {
      canSpawn: this.platform.capabilities.agentProcesses,
      providerIds: new Set(this.agents.providers.get().map((provider) => provider.id)),
    });
  }

  /**
   * Bring the servers in line with the workspace.
   *
   * Stops whatever was running first: a server started against the previous
   * root would answer every question about the wrong project.
   */
  async #restartLanguageServers(root: string | null): Promise<void> {
    await this.lsp.stop();
    if (!root) return;
    if (!this.platform.capabilities.languageServers) return;
    await this.lsp.start();
  }

  /**
   * Announce a newly failed server, once each.
   *
   * Keyed by name and message together, so a server that fails, is fixed, and
   * fails again for a different reason says so again — while a status
   * republished for any other reason stays quiet.
   */
  #reportFailedServers(sessions: readonly SessionStatusRow[]): void {
    const failed = new Set<string>();

    for (const session of sessions) {
      if (session.status !== 'failed') continue;

      const key = `${session.name}: ${session.error ?? ''}`;
      failed.add(key);
      if (this.#reportedFailures.has(key)) continue;

      // The server's own words first: it knows why it refused, and no
      // paraphrase here could be more useful than the original. Its last
      // stderr lines are the fallback, for a server that died without saying
      // anything on the protocol.
      const detail =
        session.error ?? (session.stderr.length > 0 ? session.stderr.slice(-3).join(' · ') : null);

      this.notifications.error(
        `${session.name} could not start`,
        detail ?? 'The server exited without saying why.',
      );
    }

    // Forgotten once recovered, so a later failure is announced again rather
    // than silently swallowed by a stale key.
    this.#reportedFailures = failed;
  }

  /** Open `servers.json` for editing, creating it with an example if absent. */
  async openServerConfig(): Promise<void> {
    try {
      await this.serverRegistry.ensureFile();
    } catch (error) {
      this.notifications.error(
        'Could not create servers.json',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    const directory = await this.platform.configDir().catch(() => null);
    if (!directory) {
      this.notifications.info(
        'Language servers are configured in servers.json',
        'The browser build keeps settings in the browser, so there is no file to open here.',
      );
      return;
    }

    await this.openPaths([join(directory, SERVERS_FILE)]);
    this.notifications.info(
      'Edit servers.json, then run "Reload Language Servers"',
      'Each entry needs a command and the languages it serves.',
    );
  }

  /** Open `agents.json` for editing, creating it with an example if absent. */
  async openAgentConfig(): Promise<void> {
    try {
      await this.agentConfig.ensureFile();
    } catch (error) {
      this.notifications.error(
        'Could not create agents.json',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    const directory = await this.platform.configDir().catch(() => null);
    if (!directory) {
      // The browser target keeps config in localStorage, so there is no file
      // to open. Saying so beats opening nothing.
      this.notifications.info(
        'Agents are configured in agents.json',
        'The browser build keeps settings in the browser, so there is no file to open here.',
      );
      return;
    }

    await this.openPaths([join(directory, AGENTS_FILE)]);
    this.notifications.info(
      'Edit agents.json, then run "Reload Agent Configuration"',
      'Each entry needs an id and a command.',
    );
  }

  /** A path relative to the workspace when it is inside one, else absolute. */
  #displayPath(path: string): string {
    const root = this.workspace.rootPath.get();
    return root && path.startsWith(root) ? relative(root, path) : path;
  }

  #hasEditor = (): boolean => this.view.get() !== null;
  #hasActiveBuffer = (): boolean => this.workspace.activeId.get() !== null;
  #hasFolder = (): boolean => this.workspace.rootPath.get() !== null;

  // --- File operations ----------------------------------------------------

  async openFileDialog(): Promise<void> {
    if (!this.platform.capabilities.nativeDialogs) {
      this.ui.openOverlay('quick-open');
      return;
    }
    const path = await this.platform.pickFile();
    if (path) await this.workspace.open(path);
  }

  async openFolderDialog(): Promise<void> {
    const path = await this.platform.pickFolder();
    if (!path) return;
    await this.workspace.openFolder(path);
  }

  async save(id = this.workspace.activeId.get()): Promise<boolean> {
    if (!id) return false;
    const buffer = this.workspace.buffers.get().find((b) => b.id === id);
    if (!buffer) return false;
    if (buffer.isUntitled) return this.saveAs(id);

    // The file changed underneath us while we held unsaved edits. Saving now
    // would silently destroy someone else's work, so ask first.
    if (buffer.externalState === 'modified') {
      const choice = await this.ui.askToConfirm({
        title: `${buffer.name} changed on disk`,
        message:
          'This file was modified outside Nox after you started editing. Overwrite it with your version, or discard your changes and load the version on disk?',
        choices: [
          { id: 'overwrite', label: 'Overwrite', danger: true },
          { id: 'reload', label: 'Discard & Reload' },
          { id: 'cancel', label: 'Cancel' },
        ],
      });

      if (choice === null || choice === 'cancel') return false;
      if (choice === 'reload') {
        await this.workspace.reloadFromDisk(id);
        this.watcher.clearWarning(id);
        return false;
      }
    }

    await this.#formatBeforeSave(id, buffer.name);

    const saved = await this.workspace.save(id, this.#saveOptions());
    if (saved) {
      this.watcher.clearWarning(id);
      this.notifications.success(`Saved ${buffer.name}`);
    }
    return saved;
  }

  /** How long a save waits for the formatter before going ahead without it. */
  static readonly FORMAT_ON_SAVE_TIMEOUT_MS = 2000;

  /**
   * Format on save, as a courtesy on the way to the disk.
   *
   * **The save always happens.** Whatever this returns, the caller writes —
   * this only decides whether the bytes are the formatted ones. Bounded in
   * time so a slow server cannot make Save a thing that sometimes does not
   * save; a late answer is dropped, because applying it after the write
   * would leave a just-saved file dirty with an edit nobody saw coming.
   * Skipped under after-delay autosave: a format on every pause in typing
   * rewrites the text under the cursor.
   */
  async #formatBeforeSave(id: BufferId, name: string): Promise<void> {
    if (!this.config.get('files.formatOnSave')) return;
    if (this.config.get('files.autoSave') === 'afterDelay') return;

    const outcome = await this.formatBuffer(id, { timeoutMs: NoxApp.FORMAT_ON_SAVE_TIMEOUT_MS });

    if (outcome.kind === 'timeout') {
      this.notifications.warn(
        `Saved ${name} without formatting`,
        'The language server did not answer in time.',
      );
    } else if (outcome.kind === 'failed') {
      this.notifications.warn(`Saved ${name} without formatting`, outcome.message);
    }
    // unavailable, unchanged, formatted: nothing to say. stale: the user was
    // typing, and the keystroke wins over the format, silently.
  }

  /**
   * Ask the server to format `id` and apply the answer as one change set.
   *
   * Not through the review panel: a format is not a proposal, it is the same
   * text arranged the way the project already agreed on. One undo takes it
   * back. The revision is captured before the request and checked by
   * `apply`, so a keystroke while the server thinks is refused rather than
   * formatted over.
   *
   * With `timeoutMs`, a server that has not answered by then yields
   * `timeout` and its eventual answer is **never applied** — the race is
   * decided before the apply, not after it, which is the only place that
   * guarantee can be made. (A first version raced the whole call and checked
   * a flag afterwards; the edit had already landed by then.)
   */
  async formatBuffer(id: BufferId, options: { timeoutMs?: number } = {}): Promise<FormatOutcome> {
    const buffer = this.workspace.get(id);
    const snapshot = this.workspace.buffers.get().find((b) => b.id === id);
    if (!buffer || !snapshot?.path) return { kind: 'unavailable' };
    if (!this.lsp.capabilitiesFor(snapshot.languageId)?.documentFormattingProvider) {
      return { kind: 'unavailable' };
    }

    const revision = this.workspace.revisionOf(id);
    const request = this.lsp.requestFor(snapshot.languageId, 'textDocument/formatting', {
      textDocument: { uri: pathToUri(snapshot.path) },
      // The editor's own indentation, so a formatter and a keystroke agree.
      options: {
        tabSize: this.config.get('editor.tabSize'),
        insertSpaces: this.config.get('editor.insertSpaces'),
      },
    });

    const TIMEOUT = Symbol('timeout');
    const answered = request.then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );
    const winner =
      options.timeoutMs === undefined
        ? await answered
        : await Promise.race([
            answered,
            new Promise<typeof TIMEOUT>((resolve) => setTimeout(() => resolve(TIMEOUT), options.timeoutMs)),
          ]);
    if (winner === TIMEOUT) return { kind: 'timeout' };
    if ('error' in winner) {
      const { error } = winner;
      return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
    const { response } = winner;

    const edits = textEditsOf(response);
    if (edits.length === 0) return { kind: 'unchanged' };
    const text = this.workspace.textOf(id);
    if (text === undefined) return { kind: 'unavailable' };

    const result = this.workspace.apply({
      description: `Format ${snapshot.name}`,
      author: { kind: 'user' },
      edits: [{ bufferId: id, changes: changesOf(text, edits) }],
      baseRevisions: new Map([[id, revision]]),
    });
    if (result.ok) return { kind: 'formatted' };
    if (result.reason === 'stale') return { kind: 'stale' };
    return { kind: 'failed', message: `The server's edits could not be applied (${result.reason}).` };
  }

  async saveAs(id = this.workspace.activeId.get()): Promise<boolean> {
    if (!id) return false;
    const buffer = this.workspace.buffers.get().find((b) => b.id === id);
    if (!buffer) return false;

    const suggestion = this.workspace.suggestedSavePath(id);
    const path = this.platform.capabilities.nativeDialogs
      ? await this.platform.pickSavePath({ defaultPath: suggestion, defaultName: buffer.name })
      : await this.#promptForPath('Save As', suggestion);

    if (!path) return false;
    await this.#formatBeforeSave(id, basename(path));
    const saved = await this.workspace.saveAs(id, path, this.#saveOptions());
    if (saved) {
      this.notifications.success(`Saved ${basename(path)}`);
      void this.files.refresh();
    }
    return saved;
  }

  async saveAll(): Promise<void> {
    for (const buffer of this.workspace.buffers.get()) {
      if (buffer.isDirty) await this.save(buffer.id);
    }
  }

  /** Close a tab, asking about unsaved changes first. */
  async closeBuffer(id = this.workspace.activeId.get()): Promise<boolean> {
    if (!id) return false;
    const buffer = this.workspace.buffers.get().find((b) => b.id === id);
    if (!buffer) return true;

    if (buffer.isDirty) {
      const choice = await this.ui.askToConfirm({
        title: `Save changes to ${buffer.name}?`,
        message: 'Your changes will be lost if you close without saving.',
        choices: [
          { id: 'save', label: 'Save' },
          { id: 'discard', label: "Don't Save", danger: true },
          { id: 'cancel', label: 'Cancel' },
        ],
      });
      if (choice === null || choice === 'cancel') return false;
      if (choice === 'save' && !(await this.save(id))) return false;
    }

    return this.workspace.close(id, { force: true });
  }

  async newFileInFolder(directory: string): Promise<void> {
    const name = await this.ui.askForText({
      title: 'New File',
      label: `In ${basename(directory) || directory}`,
      initialValue: '',
      placeholder: 'filename.ts',
      confirmLabel: 'Create',
      validate: (value) => (value.trim().length === 0 ? 'Enter a file name' : null),
    });
    if (!name) return;

    const path = join(directory, name.trim());
    if (await this.platform.exists(path)) {
      this.notifications.error(`${name} already exists.`);
      return;
    }
    const id = await this.workspace.createFile(path);
    if (id) {
      await this.files.refresh();
      await this.files.reveal(path);
    }
  }

  async newFolderIn(directory: string): Promise<void> {
    const name = await this.ui.askForText({
      title: 'New Folder',
      label: `In ${basename(directory) || directory}`,
      initialValue: '',
      placeholder: 'folder-name',
      confirmLabel: 'Create',
      validate: (value) => (value.trim().length === 0 ? 'Enter a folder name' : null),
    });
    if (!name) return;
    if (await this.workspace.createFolder(join(directory, name.trim()))) {
      await this.files.refresh();
    }
  }

  /** Directory that "new file" should target: the active file's folder, or root. */
  contextDirectory(): string | null {
    const active = this.workspace.activeSnapshot();
    if (active?.path) return dirname(active.path);
    return this.workspace.rootPath.get();
  }

  // --- Explorer operations -------------------------------------------------

  /**
   * Which path a file operation applies to.
   *
   * The context menu passes one explicitly. Invoked from the palette there is
   * no click to read, so fall back to the explorer selection and then to the
   * file you are editing — in that order, because that is the order of
   * "what the user was most recently looking at".
   */
  targetPath(explicit?: unknown): string | null {
    if (typeof explicit === 'string' && explicit.length > 0) return explicit;
    if (Array.isArray(explicit) && typeof explicit[0] === 'string') return explicit[0];
    return this.ui.explorer.lead.get() ?? this.workspace.activeSnapshot()?.path ?? null;
  }

  /**
   * Every path an operation applies to, in tree order.
   *
   * Single-target commands (rename) use `targetPath`; anything that can
   * sensibly act on many (delete, duplicate, copy path) uses this.
   */
  targetPaths(explicit?: unknown): string[] {
    if (typeof explicit === 'string' && explicit.length > 0) return [explicit];
    if (Array.isArray(explicit) && explicit.length > 0) {
      return explicit.filter((path): path is string => typeof path === 'string');
    }

    if (!this.ui.explorer.isEmpty()) {
      return this.ui.explorer.ordered(this.files.nodes.get().map((node) => node.path));
    }

    const active = this.workspace.activeSnapshot()?.path;
    return active ? [active] : [];
  }

  async renamePath(path: string): Promise<void> {
    const name = basename(path);
    const dot = name.lastIndexOf('.');
    const parent = dirname(path);

    const next = await this.ui.askForText({
      title: 'Rename',
      label: name,
      initialValue: name,
      confirmLabel: 'Rename',
      // Pre-select the stem so typing replaces the name, not the extension.
      selectTo: dot > 0 ? dot : name.length,
      validate: (value) => {
        const trimmed = value.trim();
        if (trimmed.length === 0) return 'Enter a name';
        if (/[\\/]/.test(trimmed)) return 'A name cannot contain a path separator';
        if (trimmed === '.' || trimmed === '..') return 'Not a valid name';
        return null;
      },
    });

    if (!next) return;
    const trimmed = next.trim();
    if (trimmed === name) return;

    const target = join(parent, trimmed);
    // Case-only renames must pass through: the platform allows them, and the
    // existence check would otherwise reject them on macOS and Windows.
    const collides =
      trimmed.toLowerCase() !== name.toLowerCase() && (await this.platform.exists(target));
    if (collides) {
      this.notifications.error(`${trimmed} already exists.`);
      return;
    }

    if (await this.workspace.renamePath(path, target)) {
      await this.files.refresh();
      this.ui.explorer.set(target);
      await this.files.reveal(target);
    }
  }

  /** Delete one or many. The confirmation names what is actually at stake. */
  async deletePaths(paths: readonly string[]): Promise<void> {
    const roots = topLevelPaths(paths);
    if (roots.length === 0) return;

    const recoverable = this.platform.capabilities.recoverableDelete;
    const verb = recoverable ? 'Move to Trash' : 'Delete';
    const outcome = recoverable
      ? 'will be moved to the Trash. You can restore it from there.'
      : 'will be deleted permanently. This cannot be undone.';

    let title: string;
    let subject: string;

    if (roots.length === 1) {
      const path = roots[0]!;
      const name = basename(path);
      let isDirectory = false;
      try {
        isDirectory = (await this.platform.stat(path)).isDirectory;
      } catch {
        /* Deleting something already gone is not worth an error. */
      }
      title = recoverable ? `Move ${name} to Trash?` : `Delete ${name}?`;
      subject = isDirectory ? `“${name}” and everything inside it` : `“${name}”`;
    } else {
      title = recoverable ? `Move ${roots.length} items to Trash?` : `Delete ${roots.length} items?`;
      // Naming a few beats a bare count: it is the difference between
      // confirming a number and confirming what you actually picked.
      const names = roots.slice(0, 3).map((path) => `“${basename(path)}”`);
      const rest = roots.length - names.length;
      subject = rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(', ');
    }

    const choice = await this.ui.askToConfirm({
      title,
      message: `${subject} ${outcome}`,
      choices: [
        { id: 'delete', label: verb, danger: true },
        { id: 'cancel', label: 'Cancel' },
      ],
    });
    if (choice !== 'delete') return;

    const { deleted } = await this.workspace.deletePaths(roots);
    if (deleted.length === 0) return;

    await this.files.refresh();
    this.ui.explorer.remove(deleted);

    const what = deleted.length === 1 ? basename(deleted[0]!) : `${deleted.length} items`;
    this.notifications.success(recoverable ? `Moved ${what} to Trash` : `Deleted ${what}`);
  }

  async duplicatePaths(paths: readonly string[]): Promise<void> {
    const created = await this.workspace.duplicatePaths(paths);
    if (created.length === 0) return;

    await this.files.refresh();
    for (const path of created) await this.files.reveal(path);

    // Leave the copies selected — that is almost always what you act on next.
    this.ui.explorer.set(created[0]!);
    for (const path of created.slice(1)) this.ui.explorer.toggle(path);
    this.ui.explorer.lead.set(created[0]!);

    this.notifications.success(
      created.length === 1 ? `Created ${basename(created[0]!)}` : `Created ${created.length} copies`,
    );
  }

  /** Move entries into a folder. Backs the explorer's drag-and-drop. */
  async movePaths(paths: readonly string[], targetDir: string): Promise<void> {
    const { moved } = await this.workspace.movePaths(paths, targetDir);
    if (moved.length === 0) return;

    await this.files.refresh();
    await this.files.expand(targetDir);
    for (const path of moved) await this.files.reveal(path);

    // Leave the moved entries selected so the next action lands on them.
    this.ui.explorer.set(moved[0]!);
    for (const path of moved.slice(1)) this.ui.explorer.toggle(path);
    this.ui.explorer.lead.set(moved[0]!);

    const what = moved.length === 1 ? basename(moved[0]!) : `${moved.length} items`;
    this.notifications.success(`Moved ${what} to ${basename(targetDir) || targetDir}`);
  }

  /**
   * Handle files dropped onto the window from the OS.
   *
   * The rule is the one people expect without being told: files become tabs,
   * a lone folder becomes the workspace. Dropping a folder when you meant to
   * open a file is far rarer than the reverse, so files win in a mixed drop.
   */
  async openDroppedPaths(paths: readonly string[]): Promise<void> {
    const files: string[] = [];
    const folders: string[] = [];

    for (const path of paths) {
      try {
        const stat = await this.platform.stat(path);
        (stat.isDirectory ? folders : files).push(path);
      } catch {
        /* Vanished between drop and stat; nothing to open. */
      }
    }

    if (files.length === 0 && folders.length === 1) {
      await this.openFolderDialogFor(folders[0]!);
      return;
    }

    if (files.length === 0 && folders.length > 1) {
      this.notifications.warn('Drop a single folder to open it as a workspace.');
      return;
    }

    for (const path of files) await this.workspace.open(path);

    if (folders.length > 0) {
      this.notifications.info(
        folders.length === 1
          ? `Opened ${files.length} file${files.length === 1 ? '' : 's'}; ignored the folder.`
          : `Opened ${files.length} files; ignored ${folders.length} folders.`,
      );
    }
  }

  /** Open a known folder path as the workspace, with unsaved-work guarding. */
  async openFolderDialogFor(path: string): Promise<void> {
    if (await this.workspace.openFolder(path)) {
      this.ui.explorer.clear();
    }
  }

  /**
   * Replace across the whole project, behind a confirmation.
   *
   * This is the single most destructive thing Nox can do — it rewrites files
   * the user cannot see — so it states the scale up front and leaves an undo
   * behind afterwards.
   */
  async replaceAcrossProject(): Promise<void> {
    const { files, matches } = this.search.pendingReplaceCount();
    if (matches === 0) return;

    const replacement = this.search.replacement.get();
    const target = replacement.length === 0 ? 'delete' : 'replace';

    const choice = await this.ui.askToConfirm({
      title: `${target === 'delete' ? 'Delete' : 'Replace'} ${matches} ${
        matches === 1 ? 'occurrence' : 'occurrences'
      }?`,
      message:
        replacement.length === 0
          ? `The replacement is empty, so every match in ${files} ${files === 1 ? 'file' : 'files'} will be removed. This can be undone from the search panel.`
          : `Across ${files} ${files === 1 ? 'file' : 'files'}. Files you have open keep their undo history; the rest can be reverted from the search panel.`,
      choices: [
        { id: 'replace', label: 'Replace All', danger: true },
        { id: 'cancel', label: 'Cancel' },
      ],
    });
    if (choice !== 'replace') return;

    const outcome = await this.search.replaceAll();
    if (outcome.matches === 0 && outcome.failed.length === 0) {
      this.notifications.info('Nothing was replaced.');
      return;
    }

    if (outcome.failed.length > 0) {
      this.notifications.warn(
        `Replaced ${outcome.matches} in ${outcome.files} files.`,
        `${outcome.failed.length} could not be written.`,
      );
    } else {
      this.notifications.success(
        `Replaced ${outcome.matches} ${outcome.matches === 1 ? 'occurrence' : 'occurrences'} in ${outcome.files} ${outcome.files === 1 ? 'file' : 'files'}`,
      );
    }
  }

  /** Replace every match in one file, without a prompt — it is a small blast radius. */
  async replaceInOneFile(path: string): Promise<void> {
    const count = await this.search.replaceInFile(path);
    if (count > 0) {
      this.notifications.success(
        `Replaced ${count} in ${basename(path)}`,
      );
    }
  }

  async undoProjectReplace(): Promise<void> {
    const { restored, skipped } = await this.search.undoLastReplace();
    if (restored === 0 && skipped === 0) return;

    if (skipped > 0) {
      this.notifications.warn(
        `Restored ${restored} ${restored === 1 ? 'file' : 'files'}.`,
        `${skipped} changed since the replace and ${skipped === 1 ? 'was' : 'were'} left alone.`,
      );
    } else {
      this.notifications.success(`Restored ${restored} ${restored === 1 ? 'file' : 'files'}`);
    }
  }

  /** Open every selected file. Directories in the selection are skipped. */
  /**
   * What a note made from the current selection would contain, or null when
   * there is nothing to make one from.
   *
   * Split out so `enabled` and `run` cannot disagree about what counts as a
   * usable selection — a command that is offered and then does nothing is
   * worse than one that is greyed.
   */
  #selectionSeed(): { title: string; body: string; anchor: NoteAnchor } | null {
    const view = this.view.get();
    const path = this.workspace.activeSnapshot()?.path;
    if (!view || !path) return null;

    const main = view.state.selection.main;
    if (main.empty) return null;

    const text = view.state.sliceDoc(main.from, main.to);
    const line = view.state.doc.lineAt(main.from).number;
    return {
      title: `${basename(path)}:${line}`,
      // Fenced so the code reads as code, and a trailing blank line so the
      // caret has somewhere to start writing that is not inside the quote.
      body: `\`\`\`\n${text}\n\`\`\`\n\n`,
      // The first line only: `core/anchor.ts` matches a line at a time, so a
      // multi-line snippet could never match one.
      anchor: { path, line, snippet: (text.split('\n')[0] ?? '').trim() },
    };
  }

  #newNoteFromSelection(): void {
    const seed = this.#selectionSeed();
    if (!seed) return;

    const id = this.notes.create();
    this.notes.rename(id, seed.title);
    this.notes.setBody(id, seed.body);
    this.notes.setAnchor(id, seed.anchor);
    this.ui.focusNotes();
  }

  /**
   * Open the code a note points at.
   *
   * The line is re-found rather than trusted: edits above an anchor move its
   * subject, and a stale line number points at the wrong code while still
   * looking right. Only a window around the remembered line is read, so this
   * costs the same on a 10 MB file as on a small one.
   */
  async openNoteAnchor(anchor: NoteAnchor): Promise<void> {
    await this.openPaths([anchor.path]);

    const view = this.view.get();
    if (!view) return;

    const doc = view.state.doc;
    const first = Math.max(1, anchor.line - ANCHOR_WINDOW);
    const last = Math.min(doc.lines, anchor.line + ANCHOR_WINDOW);
    const text = doc.sliceString(doc.line(first).from, doc.line(last).to);

    const withinWindow = resolveAnchorLine(text, anchor.line - first + 1, anchor.snippet);
    this.goToLine(withinWindow + first - 1, 1);
  }

  /**
   * Write every note into a folder as Markdown.
   *
   * Through `writeTextFile` rather than the config API, which addresses files
   * by name inside Nox's own directory and cannot reach a folder the user
   * chose.
   */
  async exportNotes(): Promise<void> {
    const folder = await this.platform.pickFolder();
    if (!folder) return;

    const notes = this.notes.notes.get();
    const taken = new Set<string>();
    let written = 0;
    let failure: string | null = null;

    for (const note of notes) {
      // Ordinal from the id, which is where the note's own uniqueness already
      // lives (`n7` ↔ `note-7.txt`).
      const ordinal = Number(/^n(\d+)$/.exec(note.id)?.[1] ?? 0);
      const name = noteFileName(note.title, ordinal, taken);
      taken.add(name);

      const text = formatNoteFile(
        {
          id: note.id,
          title: note.title,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
          pinned: note.pinned,
          ...(note.anchor ? { anchor: note.anchor } : {}),
        },
        note.body,
      );

      try {
        await this.platform.writeTextFile(join(folder, name), text);
        written++;
      } catch (cause) {
        // Keep going: one unwritable name should not cost the other notes.
        failure ??= cause instanceof Error ? cause.message : String(cause);
      }
    }

    if (failure) {
      this.notifications.error(
        `Exported ${written} of ${notes.length} notes`,
        failure,
      );
    } else {
      this.notifications.success(`Exported ${written} notes`, folder);
    }
  }

  /**
   * Read every `.md` in a folder back in as notes.
   *
   * Additive: nothing already here is changed or removed. See
   * `NotesService.importNote` for why the id in a file is ignored.
   */
  async importNotes(): Promise<void> {
    const folder = await this.platform.pickFolder();
    if (!folder) return;

    let entries;
    try {
      entries = await this.platform.readDir(folder);
    } catch (cause) {
      this.notifications.error(
        'Could not read that folder',
        cause instanceof Error ? cause.message : String(cause),
      );
      return;
    }

    const files = entries.filter((entry) => !entry.isDirectory && entry.name.endsWith('.md'));
    let imported = 0;
    let failure: string | null = null;

    for (const entry of files) {
      try {
        const text = await this.platform.readTextFile(entry.path);
        const parsed = parseNoteFile(text);
        this.notes.importNote({
          // Falls back to the filename so plain Markdown written elsewhere
          // arrives with a name rather than as "Untitled".
          title: parsed.meta.title ?? entry.name.replace(/\.md$/, ''),
          body: parsed.body,
          ...(parsed.meta.pinned !== undefined ? { pinned: parsed.meta.pinned } : {}),
          ...(parsed.meta.anchor ? { anchor: parsed.meta.anchor } : {}),
          ...(parsed.meta.createdAt !== undefined ? { createdAt: parsed.meta.createdAt } : {}),
          ...(parsed.meta.updatedAt !== undefined ? { updatedAt: parsed.meta.updatedAt } : {}),
        });
        imported++;
      } catch (cause) {
        failure ??= cause instanceof Error ? cause.message : String(cause);
      }
    }

    if (files.length === 0) {
      this.notifications.info('No .md files in that folder', folder);
      return;
    }
    if (failure) {
      this.notifications.error(`Imported ${imported} of ${files.length} notes`, failure);
    } else {
      this.notifications.success(`Imported ${imported} notes`, folder);
      this.ui.focusNotes();
    }
  }

  async openPaths(paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      try {
        if ((await this.platform.stat(path)).isDirectory) continue;
      } catch {
        continue;
      }
      await this.workspace.open(path);
    }
  }

  /**
   * Directory a "new file/folder here" should land in: the target itself when
   * it is a folder, otherwise the folder containing it.
   */
  async #targetDirectory(explicit?: unknown): Promise<string | null> {
    const path = this.targetPath(explicit);
    if (!path) return this.workspace.rootPath.get();
    try {
      return (await this.platform.stat(path)).isDirectory ? path : dirname(path);
    } catch {
      return this.workspace.rootPath.get();
    }
  }

  /** Clipboard write with a fallback for webviews that block the async API. */
  async copyToClipboard(text: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.notifications.success(`Copied ${label}`);
      return;
    } catch {
      /* Fall through to the legacy path below. */
    }

    try {
      const field = document.createElement('textarea');
      field.value = text;
      field.setAttribute('aria-hidden', 'true');
      field.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(field);
      field.select();
      const ok = document.execCommand('copy');
      field.remove();
      if (ok) this.notifications.success(`Copied ${label}`);
      else this.notifications.error('Could not copy to the clipboard.');
    } catch {
      this.notifications.error('Could not copy to the clipboard.');
    }
  }

  #saveOptions() {
    return {
      trimTrailingWhitespace: this.config.get('files.trimTrailingWhitespace'),
      insertFinalNewline: this.config.get('files.insertFinalNewline'),
    };
  }

  async #promptForPath(title: string, suggestion: string): Promise<string | null> {
    const value = await this.ui.askForText({
      title,
      label: 'Path',
      initialValue: suggestion,
      confirmLabel: 'Save',
      selectTo: suggestion.length - (basename(suggestion).includes('.') ? extLength(suggestion) : 0),
      validate: (v) => (v.trim().length === 0 ? 'Enter a path' : null),
    });
    return value ? value.trim() : null;
  }

  async #renameSelectedNote(): Promise<void> {
    const id = this.notes.selectedId.get();
    const note = this.notes.notes.get().find((entry) => entry.id === id);
    if (!note) return;

    const title = await this.ui.askForText({
      title: 'Rename Note',
      label: 'Name',
      initialValue: note.title,
      confirmLabel: 'Rename',
      validate: (value) => (value.trim().length === 0 ? 'A note needs a name.' : null),
    });
    if (title === null) return;
    this.notes.rename(note.id, title);
  }

  async #deleteSelectedNote(): Promise<void> {
    const id = this.notes.selectedId.get();
    const note = this.notes.notes.get().find((entry) => entry.id === id);
    if (!note) return;

    // A confirm rather than an undo: there is no trash to recover from, and
    // nothing else in the app will resurrect the text.
    const choice = await this.ui.askToConfirm({
      title: 'Delete Note',
      message: `Delete “${note.title}”? This cannot be undone.`,
      choices: [
        { id: 'delete', label: 'Delete', danger: true },
        { id: 'cancel', label: 'Cancel' },
      ],
    });
    if (choice !== 'delete') return;
    this.notes.remove(note.id);
  }

  // --- Commands -----------------------------------------------------------

  #registerCommands(): void {
    const editorEnabled = this.#hasEditor;
    const bufferEnabled = this.#hasActiveBuffer;

    const commands: Command[] = [
      // --- File ---------------------------------------------------------
      {
        id: 'file.new',
        // Deliberately no `resourceFrom`, unlike its twelve `buffer.edit`
        // siblings: the buffer this creates does not exist yet, so the active
        // file is the one file the prompt must not name.
        capabilities: ['buffer.edit'],
        title: 'New File',
        category: 'File',
        keywords: ['create', 'untitled'],
        run: () => {
          this.workspace.newUntitled();
        },
      },
      {
        id: 'file.newInFolder',
        capabilities: ['fs.create'],
        title: 'New File in Folder…',
        category: 'File',
        enabled: this.#hasFolder,
        run: async () => {
          const directory = this.contextDirectory();
          if (directory) await this.newFileInFolder(directory);
        },
      },
      {
        id: 'file.newFolder',
        capabilities: ['fs.create'],
        title: 'New Folder…',
        category: 'File',
        enabled: this.#hasFolder,
        run: async () => {
          const directory = this.contextDirectory();
          if (directory) await this.newFolderIn(directory);
        },
      },
      {
        id: 'file.open',
        capabilities: ['fs.read'],
        title: 'Open File…',
        category: 'File',
        run: () => this.openFileDialog(),
      },
      {
        id: 'file.openFolder',
        capabilities: ['workspace.open'],
        title: 'Open Folder…',
        category: 'File',
        keywords: ['workspace', 'project', 'directory'],
        run: () => this.openFolderDialog(),
      },
      {
        id: 'file.closeFolder',
        title: 'Close Folder',
        category: 'File',
        enabled: this.#hasFolder,
        run: () => {
          this.workspace.closeFolder();
        },
      },
      {
        id: 'file.save',
        resourceFrom: () => this.workspace.activeSnapshot()?.path ?? undefined,
        capabilities: ['fs.write'],
        title: 'Save',
        category: 'File',
        enabled: bufferEnabled,
        run: () => this.save(),
      },
      {
        id: 'file.saveAs',
        resourceFrom: () => this.workspace.activeSnapshot()?.path ?? undefined,
        capabilities: ['fs.write'],
        title: 'Save As…',
        category: 'File',
        enabled: bufferEnabled,
        run: () => this.saveAs(),
      },
      {
        id: 'file.saveAll',
        capabilities: ['fs.write'],
        title: 'Save All',
        category: 'File',
        enabled: () => this.workspace.hasUnsavedChanges(),
        run: () => this.saveAll(),
      },
      {
        id: 'file.toggleLineEnding',
        resourceFrom: () => this.workspace.activeSnapshot()?.path ?? undefined,
        // Dirties the buffer — `WorkspaceService.setEol` says why — so it is
        // as much an edit as typing is.
        capabilities: ['buffer.edit'],
        title: 'Switch Line Endings',
        category: 'File',
        keywords: ['eol', 'crlf', 'lf', 'windows', 'unix', 'line endings'],
        enabled: bufferEnabled,
        run: () => {
          const active = this.workspace.activeSnapshot();
          if (!active) return;
          this.workspace.setEol(active.id, active.eol === '\r\n' ? '\n' : '\r\n');
        },
      },
      {
        id: 'file.revert',
        resourceFrom: () => this.workspace.activeSnapshot()?.path ?? undefined,
        capabilities: ['fs.read', 'buffer.edit'],
        title: 'Reload File from Disk',
        category: 'File',
        keywords: ['revert', 'discard', 'refresh', 'external'],
        enabled: () => Boolean(this.workspace.activeSnapshot()?.path),
        run: async () => {
          const id = this.workspace.activeId.get();
          if (!id) return;

          const buffer = this.workspace.buffers.get().find((b) => b.id === id);
          if (buffer?.isDirty) {
            const choice = await this.ui.askToConfirm({
              title: `Discard changes to ${buffer.name}?`,
              message: 'Your unsaved changes will be replaced by the version on disk.',
              choices: [
                { id: 'reload', label: 'Discard & Reload', danger: true },
                { id: 'cancel', label: 'Cancel' },
              ],
            });
            if (choice !== 'reload') return;
          }

          if (await this.workspace.reloadFromDisk(id)) {
            this.watcher.clearWarning(id);
            this.notifications.info(`Reloaded ${buffer?.name ?? 'file'}`);
          }
        },
      },
      {
        id: 'file.close',
        title: 'Close File',
        category: 'File',
        enabled: bufferEnabled,
        run: () => this.closeBuffer(),
      },
      {
        id: 'file.closeAll',
        title: 'Close All Files',
        category: 'File',
        enabled: bufferEnabled,
        run: async () => {
          for (const buffer of [...this.workspace.buffers.get()]) {
            if (!(await this.closeBuffer(buffer.id))) break;
          }
        },
      },
      // The scoped closes take an optional BufferId from the tab context menu
      // and fall back to the active buffer when run from the palette.
      // `workspace.closeOthers` force-discards dirty buffers (fine for the
      // programmatic API); these route every close through `closeBuffer` so
      // a dirty tab gets its save prompt, and stop when one is cancelled.
      {
        id: 'file.closeOthers',
        title: 'Close Other Files',
        category: 'File',
        enabled: bufferEnabled,
        run: async (arg) => {
          const keep = typeof arg === 'string' ? arg : this.workspace.activeId.get();
          if (!keep) return;
          const group = this.workspace.groups.get().find((g) => g.tabs.some((t) => t.id === keep));
          for (const tab of group?.tabs ?? []) {
            if (tab.id !== keep && !(await this.closeBuffer(tab.id))) break;
          }
        },
      },
      {
        id: 'file.closeToRight',
        title: 'Close Files to the Right',
        category: 'File',
        enabled: bufferEnabled,
        run: async (arg) => {
          const anchorId = typeof arg === 'string' ? arg : this.workspace.activeId.get();
          if (!anchorId) return;
          const group = this.workspace.groups.get().find((g) => g.tabs.some((t) => t.id === anchorId));
          const index = group ? group.tabs.findIndex((t) => t.id === anchorId) : -1;
          if (!group || index < 0) return;
          for (const tab of group.tabs.slice(index + 1)) {
            if (!(await this.closeBuffer(tab.id))) break;
          }
        },
      },
      {
        id: 'file.closeSaved',
        title: 'Close Saved Files',
        category: 'File',
        enabled: bufferEnabled,
        run: (arg) => this.workspace.closeSaved(typeof arg === 'string' ? arg : undefined),
      },

      // --- Explorer -------------------------------------------------------
      // Each takes an optional path argument from the context menu and falls
      // back to `targetPath()` when run from the palette.
      // --- Project search ---------------------------------------------------
      {
        id: 'search.focus',
        title: 'Search in Project',
        category: 'Search',
        keywords: ['find in files', 'grep', 'project search', 'find across'],
        enabled: () => this.search.available,
        run: () => {
          // Seed from the editor selection, matching ⌘F's behaviour.
          const view = this.view.get();
          if (view) {
            const main = view.state.selection.main;
            if (!main.empty && main.to - main.from <= 200) {
              this.search.seed(view.state.sliceDoc(main.from, main.to));
            }
          }
          this.config.set('workbench.showExplorer', true);
          this.ui.focusSearch();
        },
      },
      {
        id: 'search.rerun',
        title: 'Run Project Search',
        category: 'Search',
        enabled: () => this.search.available && this.workspace.rootPath.get() !== null,
        run: () => this.search.run(),
      },
      {
        id: 'search.clear',
        title: 'Clear Search Results',
        category: 'Search',
        run: () => this.search.clear(),
      },
      {
        id: 'search.toggleCase',
        title: 'Toggle Match Case',
        category: 'Search',
        run: () => this.search.toggle('caseSensitive'),
      },
      {
        id: 'search.toggleWholeWord',
        title: 'Toggle Whole Word',
        category: 'Search',
        run: () => this.search.toggle('wholeWord'),
      },
      {
        id: 'search.toggleRegexp',
        title: 'Toggle Regular Expression',
        category: 'Search',
        run: () => this.search.toggle('regexp'),
      },
      {
        id: 'search.togglePreserveCase',
        title: 'Toggle Preserve Case',
        category: 'Search',
        keywords: ['case', 'preserve', 'AB'],
        run: () => this.search.toggle('preserveCase'),
      },
      {
        id: 'search.toggleGitIgnore',
        title: 'Toggle Respect .gitignore',
        category: 'Search',
        run: () => this.search.toggle('respectGitIgnore'),
      },
      {
        id: 'search.replaceAll',
        capabilities: ['fs.write', 'buffer.edit'],
        title: 'Replace All in Project…',
        category: 'Search',
        keywords: ['replace across files', 'substitute'],
        enabled: () => this.search.pendingReplaceCount().matches > 0,
        run: () => this.replaceAcrossProject(),
      },
      {
        id: 'search.undoReplace',
        title: 'Undo Last Project Replace',
        category: 'Search',
        enabled: () => this.search.lastReplace.get() !== null,
        run: () => this.undoProjectReplace(),
      },
      {
        id: 'search.collapseAll',
        title: 'Collapse All Results',
        category: 'Search',
        run: () => this.search.collapseAll(),
      },

      {
        id: 'explorer.newFile',
        resourceFrom: (arg) => (typeof arg === 'string' ? arg : this.targetPath() ?? undefined),
        capabilities: ['fs.create'],
        title: 'New File Here…',
        category: 'Explorer',
        enabled: this.#hasFolder,
        run: async (arg) => {
          const directory = await this.#targetDirectory(arg);
          if (directory) await this.newFileInFolder(directory);
        },
      },
      {
        id: 'explorer.newFolder',
        resourceFrom: (arg) => (typeof arg === 'string' ? arg : this.targetPath() ?? undefined),
        capabilities: ['fs.create'],
        title: 'New Folder Here…',
        category: 'Explorer',
        enabled: this.#hasFolder,
        run: async (arg) => {
          const directory = await this.#targetDirectory(arg);
          if (directory) await this.newFolderIn(directory);
        },
      },
      {
        id: 'explorer.rename',
        resourceFrom: (arg) => (typeof arg === 'string' ? arg : this.targetPath() ?? undefined),
        capabilities: ['fs.write'],
        title: 'Rename…',
        category: 'Explorer',
        keywords: ['move'],
        enabled: () => this.targetPath() !== null,
        run: async (arg) => {
          const path = this.targetPath(arg);
          if (path) await this.renamePath(path);
        },
      },
      {
        id: 'explorer.duplicate',
        resourceFrom: (arg) => (typeof arg === 'string' ? arg : this.targetPath() ?? undefined),
        capabilities: ['fs.create'],
        title: 'Duplicate',
        category: 'Explorer',
        keywords: ['copy file'],
        enabled: () => this.targetPaths().length > 0,
        run: async (arg) => {
          const paths = this.targetPaths(arg);
          if (paths.length > 0) await this.duplicatePaths(paths);
        },
      },
      {
        id: 'explorer.delete',
        resourceFrom: (arg) => (typeof arg === 'string' ? arg : this.targetPath() ?? undefined),
        capabilities: ['fs.delete'],
        title: 'Delete…',
        category: 'Explorer',
        keywords: ['remove', 'trash'],
        enabled: () => this.targetPaths().length > 0,
        run: async (arg) => {
          const paths = this.targetPaths(arg);
          if (paths.length > 0) await this.deletePaths(paths);
        },
      },
      {
        id: 'explorer.openSelection',
        resourceFrom: (arg) => (typeof arg === 'string' ? arg : this.targetPath() ?? undefined),
        capabilities: ['fs.read'],
        title: 'Open Selected Files',
        category: 'Explorer',
        enabled: () => this.targetPaths().length > 0,
        run: async (arg) => {
          await this.openPaths(this.targetPaths(arg));
        },
      },
      {
        id: 'explorer.copyPath',
        title: 'Copy Path',
        category: 'Explorer',
        enabled: () => this.targetPaths().length > 0,
        run: async (arg) => {
          const paths = this.targetPaths(arg);
          if (paths.length === 0) return;
          await this.copyToClipboard(
            paths.join('\n'),
            paths.length === 1 ? 'path' : `${paths.length} paths`,
          );
        },
      },
      {
        id: 'explorer.copyRelativePath',
        title: 'Copy Relative Path',
        category: 'Explorer',
        enabled: () => this.targetPaths().length > 0 && this.#hasFolder(),
        run: async (arg) => {
          const paths = this.targetPaths(arg);
          const root = this.workspace.rootPath.get();
          if (paths.length === 0 || !root) return;
          await this.copyToClipboard(
            paths.map((path) => relative(root, path)).join('\n'),
            paths.length === 1 ? 'relative path' : `${paths.length} relative paths`,
          );
        },
      },
      {
        id: 'explorer.moveTo',
        resourceFrom: (arg) => (typeof arg === 'string' ? arg : this.targetPath() ?? undefined),
        capabilities: ['fs.write'],
        title: 'Move to Folder',
        category: 'Explorer',
        // Needs a drop target, so it is not meaningful from the palette; it
        // exists as a command so drag-and-drop goes through the same door as
        // everything else rather than calling a service directly.
        hidden: true,
        run: async (arg) => {
          const request = arg as { paths?: unknown; target?: unknown } | undefined;
          const target = typeof request?.target === 'string' ? request.target : null;
          const paths = Array.isArray(request?.paths)
            ? request.paths.filter((path): path is string => typeof path === 'string')
            : [];
          if (target && paths.length > 0) await this.movePaths(paths, target);
        },
      },
      {
        id: 'explorer.selectAll',
        title: 'Select All in Explorer',
        category: 'Explorer',
        enabled: this.#hasFolder,
        run: () => {
          this.ui.explorer.selectAll(this.files.nodes.get().map((node) => node.path));
        },
      },
      {
        id: 'explorer.revealInFileManager',
        resourceFrom: (arg) => (typeof arg === 'string' ? arg : this.targetPath() ?? undefined),
        capabilities: ['shell.exec'],
        title: 'Reveal in File Manager',
        category: 'Explorer',
        keywords: ['finder', 'explorer', 'show'],
        hidden: !this.platform.capabilities.revealInFileManager,
        enabled: () =>
          this.platform.capabilities.revealInFileManager && this.targetPath() !== null,
        run: async (arg) => {
          const path = this.targetPath(arg);
          if (!path) return;
          try {
            await this.platform.reveal(path);
          } catch (error) {
            this.notifications.error(
              'Could not reveal the file.',
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      },
      {
        id: 'explorer.refresh',
        title: 'Refresh Explorer',
        category: 'Explorer',
        enabled: this.#hasFolder,
        run: () => this.files.refresh(),
      },
      {
        id: 'explorer.collapseAll',
        title: 'Collapse All Folders',
        category: 'Explorer',
        enabled: this.#hasFolder,
        run: () => this.files.collapseAll(),
      },

      {
        id: 'file.revealInExplorer',
        title: 'Reveal in Explorer',
        category: 'File',
        enabled: () => Boolean(this.workspace.activeSnapshot()?.path) && this.#hasFolder(),
        run: async () => {
          const path = this.workspace.activeSnapshot()?.path;
          if (!path) return;
          await this.revealInExplorer(path);
        },
      },

      // --- Navigation ---------------------------------------------------
      {
        id: 'nav.commandPalette',
        title: 'Command Palette',
        category: 'Go',
        keywords: ['run', 'action', 'commands'],
        run: () => this.ui.toggleOverlay('palette'),
      },
      {
        id: 'nav.quickOpen',
        title: 'Go to File…',
        category: 'Go',
        keywords: ['quick open', 'find file', 'jump'],
        run: () => this.ui.toggleOverlay('quick-open'),
      },
      {
        id: 'nav.goToLine',
        title: 'Go to Line…',
        category: 'Go',
        keywords: ['jump', 'line number'],
        enabled: editorEnabled,
        run: () => this.ui.openOverlay('go-to-line'),
      },
      {
        id: 'view.reloadWindow',
        title: 'Reload Window',
        category: 'View',
        keywords: ['refresh', 'restart', 'developer'],
        // Deliberately unbound. The desktop shell wires no reload of its own,
        // so without this there is no way to get a clean slate short of
        // quitting — which is what makes a stuck-looking window impossible to
        // tell apart from a stuck one. Unsaved work survives: it is in the
        // session. In-memory state does not — agent sessions and the
        // transaction log start again — so this stays off the keyboard where
        // it cannot be hit by accident.
        run: () => {
          this.notifications.info('Reloading…');
          globalThis.location.reload();
        },
      },
      {
        id: 'agents.show',
        title: 'Show Agents',
        category: 'View',
        keywords: ['sessions', 'audit', 'history', 'ai'],
        run: () => this.ui.showAgents(),
      },
      {
        id: 'agents.run',
        title: 'Run Agent…',
        category: 'Agents',
        keywords: ['ai', 'session', 'start', 'ask'],
        // Starting a process is the most powerful thing Nox does for someone,
        // so it is a command they run, never something that happens for them.
        enabled: () => this.#runnableAgents().length > 0,
        run: (arg) => this.runAgent(typeof arg === 'string' ? arg : undefined),
      },
      {
        id: 'agents.runOnSelection',
        title: 'Edit Selection with a Model…',
        category: 'Agents',
        keywords: ['ai', 'refactor', 'fix', 'rewrite', 'selection'],
        // Same predicate as agents.run, plus a selection to act on: a command
        // offered and then refused is the drift this predicate was extracted
        // to prevent.
        enabled: () => this.#runnableAgents().length > 0 && this.#selectionScope() !== null,
        run: () => this.runAgentOnSelection(),
      },
      {
        id: 'agents.askAboutSelection',
        title: 'Ask About Selection…',
        category: 'Agents',
        keywords: ['ai', 'explain', 'what does', 'question', 'selection'],
        // The same predicate as the edit command, for the same reason: a
        // command offered and then refused is the drift it exists to prevent.
        enabled: () => this.#runnableAgents().length > 0 && this.#selectionScope() !== null,
        run: () => this.askAboutSelection(),
      },
      {
        id: 'agents.explainSelection',
        title: 'Explain Selection',
        category: 'Agents',
        keywords: ['ai', 'what does this do', 'describe', 'selection'],
        enabled: () => this.#runnableAgents().length > 0 && this.#selectionScope() !== null,
        run: () => this.askAboutSelection(EXPLAIN_INSTRUCTION),
      },
      {
        id: 'agents.configure',
        title: 'Configure Agents',
        category: 'Agents',
        keywords: ['agents.json', 'add agent', 'ai'],
        capabilities: ['fs.create'],
        run: () => this.openAgentConfig(),
      },
      {
        id: 'lsp.configure',
        title: 'Configure Language Servers',
        category: 'Language',
        keywords: ['servers.json', 'lsp', 'diagnostics', 'typescript'],
        capabilities: ['fs.create'],
        run: () => this.openServerConfig(),
      },
      {
        id: 'lsp.reload',
        title: 'Reload Language Servers',
        category: 'Language',
        keywords: ['servers.json', 'lsp', 'restart'],
        run: async () => {
          const previous = this.serverRegistry.servers.get();
          await this.serverRegistry.load();

          const error = this.serverRegistry.error.get();
          if (error) {
            // The previous configuration stays live. A typo should not
            // silently disarm the servers that were working a moment ago.
            this.notifications.error('servers.json could not be read', error);
            this.serverRegistry.servers.set(previous);
            return;
          }

          await this.#restartLanguageServers(this.workspace.rootPath.get());
          const count = this.serverRegistry.servers.get().length;
          this.notifications.info(
            `${count} language ${count === 1 ? 'server' : 'servers'} configured`,
          );
        },
      },
      {
        id: 'lsp.goToDefinition',
        title: 'Go to Definition',
        category: 'Language',
        keywords: ['definition', 'declaration', 'jump', 'lsp'],
        enabled: () => {
          const snapshot = this.workspace.activeSnapshot();
          if (!snapshot?.path) return false;
          return Boolean(this.lsp.capabilitiesFor(snapshot.languageId)?.definitionProvider);
        },
        run: () => this.#goToDefinition(),
      },
      {
        id: 'lsp.findReferences',
        title: 'Find References',
        category: 'Language',
        keywords: ['references', 'usages', 'uses', 'lsp'],
        enabled: () => {
          const snapshot = this.workspace.activeSnapshot();
          if (!snapshot?.path) return false;
          return Boolean(this.lsp.capabilitiesFor(snapshot.languageId)?.referencesProvider);
        },
        run: () => this.#findReferences(),
      },
      {
        id: 'lsp.renameSymbol',
        resourceFrom: () => this.workspace.activeSnapshot()?.path ?? undefined,
        title: 'Rename Symbol',
        category: 'Language',
        keywords: ['rename', 'refactor', 'symbol', 'lsp'],
        capabilities: ['buffer.edit'],
        enabled: () => {
          const snapshot = this.workspace.activeSnapshot();
          if (!snapshot?.path) return false;
          return Boolean(this.lsp.capabilitiesFor(snapshot.languageId)?.renameProvider);
        },
        run: () => this.#renameSymbol(),
      },
      {
        id: 'lsp.formatDocument',
        resourceFrom: () => this.workspace.activeSnapshot()?.path ?? undefined,
        title: 'Format Document',
        category: 'Language',
        keywords: ['format', 'prettify', 'indent', 'lsp'],
        capabilities: ['buffer.edit'],
        enabled: () => {
          const snapshot = this.workspace.activeSnapshot();
          if (!snapshot?.path) return false;
          return Boolean(this.lsp.capabilitiesFor(snapshot.languageId)?.documentFormattingProvider);
        },
        run: async () => {
          const id = this.workspace.activeId.get();
          if (!id) return;
          const outcome = await this.formatBuffer(id);
          if (outcome.kind === 'failed') this.notifications.error('Format failed', outcome.message);
          else if (outcome.kind === 'unavailable') {
            this.notifications.info('No language server offers formatting for this file');
          }
          // formatted, unchanged, stale: the document shows the result, and a
          // format that lost to a keystroke is not worth a toast.
        },
      },
      {
        id: 'references.focus',
        title: 'Show References',
        category: 'Language',
        keywords: ['references', 'usages', 'definitions', 'lsp'],
        run: () => {
          this.config.set('workbench.showExplorer', true);
          this.ui.showView('references');
        },
      },
      {
        id: 'git.focus',
        title: 'Show Git',
        category: 'Git',
        keywords: ['git', 'stage', 'commit', 'branch', 'changes', 'status'],
        run: () => {
          this.config.set('workbench.showExplorer', true);
          this.ui.showView('git');
        },
      },
      {
        id: 'git.showDiff',
        title: 'Show Changes',
        category: 'Git',
        keywords: ['diff', 'changes', 'compare', 'git'],
        // On the service, not the platform flag: the service only starts
        // where the capability holds, and tests start it over a memory
        // platform — the language-server pattern.
        enabled: () => this.git.started && Boolean(this.workspace.activeSnapshot()?.path),
        run: () => this.ui.showDiff(),
      },
      {
        id: 'git.refreshGutter',
        title: 'Refresh Git Gutter',
        category: 'Git',
        keywords: ['git', 'gutter', 'diff', 'refresh'],
        // Nothing watches .git, so a commit or stage made in the terminal
        // changes the base behind the gutter's back; this re-asks for every
        // open file at once.
        enabled: () => this.git.started,
        run: () => {
          void this.git.refreshStatus();
          void this.git.refreshAll();
        },
      },
      {
        id: 'agents.reloadConfig',
        title: 'Reload Agent Configuration',
        category: 'Agents',
        run: async () => {
          await this.agentConfig.load();
          const error = this.agentConfig.error.get();
          if (error) this.notifications.error('agents.json could not be read', error);
          else {
            const count = this.agentConfig.agents.get().length;
            this.notifications.info(`${count} ${count === 1 ? 'agent' : 'agents'} configured`);
          }
        },
      },
      {
        id: 'agents.cancel',
        title: 'Stop the Running Agent',
        category: 'Agents',
        keywords: ['abort', 'kill'],
        enabled: () => this.agents.sessions.get().some((s) => s.status === 'running'),
        run: () => {
          const running = this.agents.sessions.get().find((s) => s.status === 'running');
          if (running) this.agents.session(running.id)?.cancel();
        },
      },
      {
        id: 'agents.undoLastSession',
        title: 'Undo the Last Agent Session',
        category: 'View',
        keywords: ['revert', 'take back', 'ai'],
        enabled: () => this.agents.sessions.get().some((s) => this.agents.changesBy(s.id).length > 0),
        run: () => {
          const session = this.agents.sessions.get().find((s) => this.agents.changesBy(s.id).length > 0);
          if (!session) return;
          const { undone, skipped } = this.agents.undoSession(session.id);
          if (skipped.length > 0) {
            this.notifications.warn(
              `Took back ${undone.length} of ${undone.length + skipped.length} files`,
              'The rest have been edited since, so their changes were left alone.',
            );
          } else {
            this.notifications.success(`Took back everything ${session.label} did`);
          }
        },
      },
      // --- Permissions ------------------------------------------------------
      // Revoking is its own command rather than a step inside `undoSession`.
      // Keeping an agent's edits while closing the door it wrote through is
      // the case that had no move at all before these two existed.
      {
        id: 'permissions.revokeGrants',
        title: 'Revoke Every Standing Permission',
        category: 'Agents',
        keywords: ['permission', 'grant', 'access', 'revoke', 'forget', 'trust', 'session'],
        capabilities: ['permissions.revoke'],
        enabled: () => this.permissions.grants.get().length > 0,
        run: () => this.revokeGrants(),
      },
      {
        id: 'permissions.revokeSessionGrants',
        title: "Revoke One Agent's Standing Permissions",
        category: 'Agents',
        // Needs a session id, so it says nothing useful in the palette. It is
        // still a command so the Agents panel button goes through the same
        // door as everything else instead of calling the service directly.
        hidden: true,
        capabilities: ['permissions.revoke'],
        run: (arg) => {
          if (typeof arg !== 'string') return;
          // The label the panel shows, so the toast names the agent the same
          // way the row above it does rather than falling back to an id.
          const label = this.agents.sessions.get().find((s) => s.id === arg)?.label ?? arg;
          this.revokeGrants({ kind: 'agent', sessionId: arg, label });
        },
      },

      // --- Review -----------------------------------------------------------
      // Staging is programmatic; these are the decisions a human makes about
      // what was staged, and every one of them is a command like anything else.
      {
        id: 'review.apply',
        title: 'Apply Reviewed Changes',
        category: 'Review',
        keywords: ['accept', 'diff', 'staged'],
        // No `resourceFrom` here or on `search.replaceAll`: both write across
        // every file in a set, and naming the active one would understate the
        // reach of the grant rather than narrow it.
        capabilities: ['buffer.edit'],
        enabled: () => this.review.acceptedCount().hunks > 0,
        run: () => this.applyReview(),
      },
      {
        id: 'review.show',
        title: 'Show Review',
        category: 'Review',
        keywords: ['diff', 'staged', 'proposal'],
        enabled: () => this.review.staged.get() !== null,
        run: () => this.ui.reviewOpen.set(true),
      },
      {
        id: 'review.keepAll',
        title: 'Keep All Changes',
        category: 'Review',
        enabled: () => this.review.staged.get() !== null,
        run: () => this.review.setAllAccepted(true),
      },
      {
        id: 'review.rejectAll',
        title: 'Reject All Changes',
        category: 'Review',
        enabled: () => this.review.staged.get() !== null,
        run: () => this.review.setAllAccepted(false),
      },
      {
        id: 'review.discard',
        title: 'Discard Review',
        category: 'Review',
        keywords: ['cancel', 'close diff'],
        enabled: () => this.review.staged.get() !== null,
        run: () => this.review.discard(),
      },
      {
        id: 'jobs.cancel',
        title: 'Cancel Background Task',
        category: 'View',
        keywords: ['stop', 'abort', 'search', 'replace', 'job'],
        // A job with room for exactly one offered here — same as the
        // status bar — must be one this can actually stop.
        enabled: () => (this.jobs.foremost()?.cancellable ?? false),
        run: () => {
          const job = this.jobs.foremost();
          if (!job || !job.cancellable) return;
          this.jobs.cancel(job.id);
          this.notifications.info(`Cancelled ${job.title}`);
        },
      },
      {
        id: 'nav.switchBuffer',
        title: 'Switch Open File',
        category: 'Go',
        keywords: ['buffer', 'recent', 'mru', 'switcher', 'open files'],
        enabled: bufferEnabled,
        run: () => this.ui.toggleOverlay('buffers'),
      },
      {
        id: 'nav.nextTab',
        title: 'Next Tab',
        category: 'Go',
        enabled: bufferEnabled,
        run: () => this.workspace.cycle(1),
      },
      {
        id: 'nav.previousTab',
        title: 'Previous Tab',
        category: 'Go',
        enabled: bufferEnabled,
        run: () => this.workspace.cycle(-1),
      },
      {
        id: 'nav.goToTab',
        title: 'Go to Tab by Number',
        category: 'Go',
        hidden: true,
        run: (arg) => this.workspace.activateIndex(Number(arg) || 0),
      },
      {
        id: 'nav.focusEditor',
        title: 'Focus Editor',
        category: 'Go',
        enabled: editorEnabled,
        run: () => this.ui.focusEditor(),
      },
      {
        id: 'nav.focusExplorer',
        title: 'Focus Explorer',
        category: 'Go',
        enabled: this.#hasFolder,
        run: () => {
          this.config.set('workbench.showExplorer', true);
          this.ui.focusExplorer();
        },
      },
      {
        id: 'nav.goToSymbol',
        title: 'Go to Symbol in File…',
        category: 'Go',
        keyHint: 'Mod+R',
        keywords: ['symbol', 'outline', 'function', 'class', 'method', 'definition'],
        run: () => this.ui.openOverlay('go-to-symbol'),
      },
      {
        id: 'nav.documentStart',
        title: 'Go to Start of File',
        category: 'Go',
        enabled: editorEnabled,
        run: () => this.#runEditor(cursorDocStart),
      },
      {
        id: 'nav.documentEnd',
        title: 'Go to End of File',
        category: 'Go',
        enabled: editorEnabled,
        run: () => this.#runEditor(cursorDocEnd),
      },

      // --- Edit -----------------------------------------------------------
      {
        id: 'edit.undo',
        resourceFrom: () => this.workspace.activeSnapshot()?.path ?? undefined,
        capabilities: ['buffer.edit'],
        title: 'Undo',
        keyHint: 'Mod+Z',
        category: 'Edit',
        enabled: editorEnabled,
        run: () => this.#step('undo'),
      },
      {
        id: 'edit.redo',
        resourceFrom: () => this.workspace.activeSnapshot()?.path ?? undefined,
        capabilities: ['buffer.edit'],
        title: 'Redo',
        keyHint: 'Mod+Shift+Z',
        category: 'Edit',
        enabled: editorEnabled,
        run: () => this.#step('redo'),
      },
      {
        id: 'edit.selectAll',
        title: 'Select All',
        keyHint: 'Mod+A',
        category: 'Edit',
        enabled: editorEnabled,
        run: () => this.#runEditor(selectAll),
      },
      {
        id: 'edit.find',
        title: 'Find',
        category: 'Edit',
        keywords: ['search'],
        enabled: editorEnabled,
        run: () => {
          this.find.seedFromSelection();
          this.ui.openFind(false);
        },
      },
      {
        id: 'edit.replace',
        resourceFrom: () => this.workspace.activeSnapshot()?.path ?? undefined,
        capabilities: ['buffer.edit'],
        title: 'Replace',
        category: 'Edit',
        keywords: ['substitute', 'find and replace'],
        enabled: editorEnabled,
        run: () => {
          this.find.seedFromSelection();
          this.ui.openFind(true);
        },
      },
      {
        id: 'edit.findNext',
        title: 'Find Next',
        category: 'Edit',
        enabled: editorEnabled,
        run: () => this.find.next(),
      },
      {
        id: 'edit.findPrevious',
        title: 'Find Previous',
        category: 'Edit',
        enabled: editorEnabled,
        run: () => this.find.previous(),
      },
      {
        id: 'edit.selectAllMatches',
        title: 'Select All Occurrences',
        category: 'Edit',
        keywords: ['multi cursor'],
        enabled: editorEnabled,
        run: () => {
          if (this.ui.findOpen.get()) this.find.selectAllMatches();
          else this.#runEditor(selectNextOccurrence);
        },
      },
      {
        id: 'edit.selectNextOccurrence',
        title: 'Add Selection to Next Match',
        keyHint: 'Mod+D',
        category: 'Edit',
        keywords: ['multi cursor'],
        enabled: editorEnabled,
        run: () => this.#runEditor(selectNextOccurrence),
      },
      {
        id: 'edit.addCursorAbove',
        title: 'Add Cursor Above',
        keyHint: 'Mod+Alt+Up',
        category: 'Edit',
        keywords: ['multi cursor'],
        enabled: editorEnabled,
        run: () => this.#runEditor(addCursorAbove),
      },
      {
        id: 'edit.addCursorBelow',
        title: 'Add Cursor Below',
        keyHint: 'Mod+Alt+Down',
        category: 'Edit',
        keywords: ['multi cursor'],
        enabled: editorEnabled,
        run: () => this.#runEditor(addCursorBelow),
      },
      // --- Folding ---------------------------------------------------------
      // CodeMirror ships a `foldKeymap`, but its chords collide with Nox's tab
      // bindings on Windows/Linux (Ctrl-Shift-[). Folding is registered as
      // application commands instead, so exactly one layer claims each chord
      // and every action shows up in the palette.
      {
        id: 'edit.fold',
        title: 'Fold',
        category: 'Edit',
        keywords: ['collapse'],
        enabled: editorEnabled,
        run: () => this.#runEditor(foldCode),
      },
      {
        id: 'edit.unfold',
        title: 'Unfold',
        category: 'Edit',
        keywords: ['expand'],
        enabled: editorEnabled,
        run: () => this.#runEditor((view) => unfoldCode(view) || unfoldAtCursor(view)),
      },
      {
        id: 'edit.foldAll',
        title: 'Fold All',
        category: 'Edit',
        keywords: ['collapse all'],
        enabled: editorEnabled,
        run: () => this.#runEditor(foldAll),
      },
      {
        id: 'edit.unfoldAll',
        title: 'Unfold All',
        category: 'Edit',
        keywords: ['expand all'],
        enabled: editorEnabled,
        run: () => this.#runEditor(unfoldAll),
      },
      {
        id: 'edit.foldLevel',
        title: 'Fold to Level…',
        category: 'Edit',
        hidden: true,
        enabled: editorEnabled,
        run: (arg) => {
          const level = Number(arg);
          if (Number.isFinite(level) && level > 0) this.#runEditor(foldToLevel(level));
        },
      },
      {
        id: 'edit.toggleComment',
        resourceFrom: () => this.workspace.activeSnapshot()?.path ?? undefined,
        capabilities: ['buffer.edit'],
        title: 'Toggle Line Comment',
        keyHint: 'Mod+/',
        category: 'Edit',
        enabled: editorEnabled,
        run: () => this.#runEditor(toggleComment),
      },
      ...[1, 2, 3, 4, 5].map((level) => ({
        id: `edit.foldLevel${level}`,
        title: `Fold Level ${level}`,
        category: 'Edit',
        keywords: ['outline', 'collapse to depth'],
        enabled: editorEnabled,
        run: () => this.#runEditor(foldToLevel(level)),
      })),
      {
        id: 'edit.duplicateLine',
        resourceFrom: () => this.workspace.activeSnapshot()?.path ?? undefined,
        capabilities: ['buffer.edit'],
        title: 'Duplicate Line',
        keyHint: 'Shift+Alt+Down',
        category: 'Edit',
        enabled: editorEnabled,
        run: () => this.#runEditor(copyLineDown),
      },
      {
        id: 'edit.deleteLine',
        resourceFrom: () => this.workspace.activeSnapshot()?.path ?? undefined,
        capabilities: ['buffer.edit'],
        title: 'Delete Line',
        keyHint: 'Mod+Shift+K',
        category: 'Edit',
        enabled: editorEnabled,
        run: () => this.#runEditor(deleteLine),
      },
      {
        id: 'edit.moveLineUp',
        resourceFrom: () => this.workspace.activeSnapshot()?.path ?? undefined,
        capabilities: ['buffer.edit'],
        title: 'Move Line Up',
        keyHint: 'Alt+Up',
        category: 'Edit',
        enabled: editorEnabled,
        run: () => this.#runEditor(moveLineUp),
      },
      {
        id: 'edit.moveLineDown',
        resourceFrom: () => this.workspace.activeSnapshot()?.path ?? undefined,
        capabilities: ['buffer.edit'],
        title: 'Move Line Down',
        keyHint: 'Alt+Down',
        category: 'Edit',
        enabled: editorEnabled,
        run: () => this.#runEditor(moveLineDown),
      },
      {
        id: 'edit.indent',
        resourceFrom: () => this.workspace.activeSnapshot()?.path ?? undefined,
        capabilities: ['buffer.edit'],
        title: 'Indent Line',
        keyHint: 'Mod+]',
        category: 'Edit',
        enabled: editorEnabled,
        run: () => this.#runEditor(indentMore),
      },
      {
        id: 'edit.outdent',
        resourceFrom: () => this.workspace.activeSnapshot()?.path ?? undefined,
        capabilities: ['buffer.edit'],
        title: 'Outdent Line',
        keyHint: 'Mod+[',
        category: 'Edit',
        enabled: editorEnabled,
        run: () => this.#runEditor(indentLess),
      },

      // --- View -----------------------------------------------------------
      {
        id: 'view.toggleExplorer',
        title: 'Toggle Explorer',
        category: 'View',
        keywords: ['sidebar', 'files'],
        run: () => this.config.set('workbench.showExplorer', !this.config.get('workbench.showExplorer')),
      },
      {
        id: 'view.splitEditor',
        title: 'Split Editor',
        category: 'View',
        keywords: ['pane', 'side by side', 'split'],
        run: () => {
          this.workspace.splitEditor();
          this.ui.focusEditor();
        },
      },
      {
        id: 'view.closeGroup',
        title: 'Close Editor Pane',
        category: 'View',
        keywords: ['unsplit', 'close split'],
        enabled: () => this.workspace.groups.get().length > 1,
        run: () => {
          this.workspace.closeGroup(this.workspace.activeGroupId.get());
          this.ui.focusEditor();
        },
      },
      {
        id: 'view.focusNextGroup',
        title: 'Focus Next Pane',
        category: 'View',
        enabled: () => this.workspace.groups.get().length > 1,
        run: () => {
          this.workspace.cycleGroup(1);
          this.ui.focusEditor();
        },
      },
      {
        id: 'view.focusPreviousGroup',
        title: 'Focus Previous Pane',
        category: 'View',
        enabled: () => this.workspace.groups.get().length > 1,
        run: () => {
          this.workspace.cycleGroup(-1);
          this.ui.focusEditor();
        },
      },
      {
        id: 'view.moveEditorToNextGroup',
        title: 'Move Editor to Next Pane',
        category: 'View',
        enabled: bufferEnabled,
        run: () => {
          this.workspace.moveActiveToGroup(1);
          this.ui.focusEditor();
        },
      },
      {
        id: 'view.moveEditorToPreviousGroup',
        title: 'Move Editor to Previous Pane',
        category: 'View',
        enabled: bufferEnabled,
        run: () => {
          this.workspace.moveActiveToGroup(-1);
          this.ui.focusEditor();
        },
      },
      {
        id: 'view.toggleSplitOrientation',
        title: 'Toggle Split Orientation',
        category: 'View',
        keywords: ['vertical', 'horizontal', 'rows', 'columns'],
        enabled: () => this.workspace.groups.get().length > 1,
        run: () =>
          this.config.set(
            'workbench.splitOrientation',
            this.config.get('workbench.splitOrientation') === 'vertical' ? 'horizontal' : 'vertical',
          ),
      },
      {
        id: 'view.toggleStatusBar',
        title: 'Toggle Status Bar',
        category: 'View',
        run: () =>
          this.config.set('workbench.showStatusBar', !this.config.get('workbench.showStatusBar')),
      },
      {
        id: 'view.toggleWordWrap',
        title: 'Toggle Word Wrap',
        category: 'View',
        run: () => this.config.set('editor.wordWrap', !this.config.get('editor.wordWrap')),
      },
      {
        id: 'view.toggleIndentType',
        title: 'Toggle Tabs and Spaces',
        category: 'View',
        keywords: ['indent', 'indentation', 'tab size', 'whitespace'],
        run: () =>
          this.config.set('editor.insertSpaces', !this.config.get('editor.insertSpaces')),
      },
      {
        id: 'view.toggleLineNumbers',
        title: 'Toggle Line Numbers',
        category: 'View',
        run: () => this.config.set('editor.lineNumbers', !this.config.get('editor.lineNumbers')),
      },
      {
        id: 'view.toggleRelativeLineNumbers',
        title: 'Toggle Relative Line Numbers',
        category: 'View',
        run: () =>
          this.config.set(
            'editor.relativeLineNumbers',
            !this.config.get('editor.relativeLineNumbers'),
          ),
      },
      {
        id: 'view.toggleTheme',
        title: 'Switch Theme',
        category: 'View',
        keywords: ['dark', 'eclipse', 'umbra', 'oled'],
        run: () =>
          this.config.set(
            'workbench.theme',
            this.config.get('workbench.theme') === 'eclipse' ? 'umbra' : 'eclipse',
          ),
      },
      {
        id: 'view.increaseFontSize',
        title: 'Increase Font Size',
        category: 'View',
        // "Zoom" is what every other editor calls this, and without the synonym
        // the palette returns nothing at all for the word.
        keywords: ['zoom', 'zoom in', 'bigger', 'larger', 'text size'],
        run: () => this.config.set('editor.fontSize', this.config.get('editor.fontSize') + 1),
      },
      {
        id: 'view.decreaseFontSize',
        title: 'Decrease Font Size',
        category: 'View',
        keywords: ['zoom', 'zoom out', 'smaller', 'text size'],
        run: () => this.config.set('editor.fontSize', this.config.get('editor.fontSize') - 1),
      },
      {
        id: 'view.resetFontSize',
        title: 'Reset Font Size',
        category: 'View',
        keywords: ['zoom', 'zoom reset', 'actual size', 'text size'],
        run: () => this.config.reset('editor.fontSize'),
      },
      {
        id: 'view.dismiss',
        title: 'Dismiss',
        category: 'View',
        hidden: true,
        enabled: () => this.ui.hasDismissible(),
        run: () => {
          this.ui.dismissTop();
        },
      },

      // --- Terminal ---------------------------------------------------------
      {
        id: 'terminal.toggle',
        title: 'Toggle Terminal',
        category: 'Terminal',
        keyHint: 'Ctrl+`',
        keywords: ['shell', 'console', 'command line'],
        // Hidden rather than disabled on the browser target: a command that
        // can never run is noise in the palette, not a discovery.
        enabled: () => this.terminal.available,
        run: () => this.ui.toggleTerminal(),
      },
      {
        id: 'terminal.focus',
        title: 'Focus Terminal',
        category: 'Terminal',
        keywords: ['shell', 'console'],
        enabled: () => this.terminal.available,
        run: () => this.ui.focusTerminal(),
      },
      {
        id: 'terminal.restart',
        title: 'Restart Terminal',
        category: 'Terminal',
        keywords: ['shell', 'new', 'kill'],
        enabled: () => this.terminal.available,
        run: () => {
          // The panel owns the measured size, so it does the restart; this
          // just asks. A command must not guess at geometry.
          this.ui.focusTerminal();
          this.terminal.requestRestart();
        },
      },

      // --- Answers ------------------------------------------------------------
      {
        id: 'answers.focus',
        title: 'Show Answers',
        category: 'Answers',
        keyHint: 'Mod+Shift+A',
        keywords: ['explain', 'ask', 'ai', 'answer'],
        // The agent half of the selection predicate only: this command and
        // the sidebar rail must never disagree about whether the section
        // exists.
        enabled: () => this.#runnableAgents().length > 0,
        run: () => {
          // Otherwise ⌘⇧A is inert whenever the sidebar is hidden.
          this.config.set('workbench.showExplorer', true);
          this.ui.focusAnswers();
        },
      },

      // --- Problems ---------------------------------------------------------
      {
        id: 'problems.focus',
        title: 'Show Problems',
        category: 'Language',
        keywords: ['diagnostics', 'errors', 'warnings', 'lsp'],
        run: () => {
          // Otherwise the command is inert whenever the sidebar is hidden,
          // which is the same trap `answers.focus` documents.
          this.config.set('workbench.showExplorer', true);
          this.ui.showView('problems');
        },
      },

      // --- Notes ------------------------------------------------------------
      {
        id: 'notes.focus',
        title: 'Show Notes',
        category: 'Notes',
        keyHint: 'Mod+Shift+N',
        keywords: ['note', 'scratch', 'memo'],
        run: () => this.ui.focusNotes(),
      },
      {
        id: 'notes.newFromSelection',
        title: 'New Note from Selection',
        category: 'Notes',
        keywords: ['note', 'selection', 'quote', 'anchor', 'annotate'],
        // No `capabilities`: reads the active buffer and writes a note.
        // Neither touches the workspace filesystem.
        enabled: () => this.#selectionSeed() !== null,
        run: () => this.#newNoteFromSelection(),
      },
      {
        id: 'notes.export',
        title: 'Export Notes to Folder…',
        category: 'Notes',
        keywords: ['note', 'export', 'markdown', 'backup', 'save'],
        // Writes files into a folder the user picked — the first notes
        // command to leave Nox's own config directory. See the design's §4.3.
        capabilities: ['fs.create'],
        // Both halves need a folder, and the browser build has no dialog to
        // pick one with. Greyed rather than hidden: a greyed command explains
        // itself, a missing one does not.
        enabled: () => this.platform.capabilities.nativeDialogs,
        run: () => void this.exportNotes(),
      },
      {
        id: 'notes.import',
        title: 'Import Notes from Folder…',
        category: 'Notes',
        keywords: ['note', 'import', 'markdown', 'restore', 'load'],
        capabilities: ['fs.read'],
        enabled: () => this.platform.capabilities.nativeDialogs,
        run: () => void this.importNotes(),
      },
      {
        id: 'notes.open',
        title: 'Go to Note',
        category: 'Notes',
        keywords: ['note', 'find', 'search', 'jump', 'open'],
        // No `capabilities`: this moves the selection and the focus and
        // touches nothing outside Nox's own notes.
        enabled: () => this.notes.notes.get().length > 0,
        run: () => this.ui.openOverlay('note-open'),
      },
      {
        id: 'notes.new',
        title: 'New Note',
        category: 'Notes',
        keywords: ['note', 'create', 'add'],
        run: () => {
          this.notes.create();
          this.ui.focusNotes();
        },
      },
      {
        id: 'notes.rename',
        title: 'Rename Note',
        category: 'Notes',
        enabled: () => this.notes.selectedId.get() !== null,
        run: () => void this.#renameSelectedNote(),
      },
      {
        id: 'notes.delete',
        title: 'Delete Note',
        category: 'Notes',
        keywords: ['remove', 'trash'],
        enabled: () => this.notes.selectedId.get() !== null,
        run: () => void this.#deleteSelectedNote(),
      },

      // --- Change marks -----------------------------------------------------
      {
        id: 'provenance.nextChange',
        title: 'Go to Next Change',
        category: 'Change Marks',
        keywords: ['provenance', 'author', 'agent', 'replace'],
        enabled: () => this.#activeHasProvenance(),
        run: () => this.#goToProvenance('next'),
      },
      {
        id: 'provenance.previousChange',
        title: 'Go to Previous Change',
        category: 'Change Marks',
        keywords: ['provenance', 'author', 'agent', 'replace'],
        enabled: () => this.#activeHasProvenance(),
        run: () => this.#goToProvenance('previous'),
      },
      {
        id: 'provenance.clear',
        title: 'Clear Change Marks',
        category: 'Change Marks',
        keywords: ['provenance', 'dismiss', 'reset'],
        enabled: () => this.#anyBufferHasProvenance(),
        run: () => this.#clearProvenance(),
      },

      // --- Preferences ------------------------------------------------------
      {
        id: 'prefs.open',
        title: 'Open Settings',
        category: 'Preferences',
        keywords: ['configuration', 'options'],
        run: () => this.ui.toggleOverlay('settings'),
      },
      {
        id: 'prefs.keybindings',
        title: 'Keyboard Shortcuts',
        category: 'Preferences',
        keywords: ['keys', 'bindings', 'shortcuts'],
        run: () => this.ui.toggleOverlay('keybindings'),
      },
      {
        id: 'prefs.reset',
        title: 'Reset All Settings',
        category: 'Preferences',
        run: async () => {
          const choice = await this.ui.askToConfirm({
            title: 'Reset all settings?',
            message: 'Every preference returns to its Nox default. This cannot be undone.',
            choices: [
              { id: 'reset', label: 'Reset', danger: true },
              { id: 'cancel', label: 'Cancel' },
            ],
          });
          if (choice === 'reset') {
            this.config.resetAll();
            this.notifications.info('Settings reset to defaults');
          }
        },
      },

      {
        id: 'prefs.openWorkspaceSettings',
        title: 'Open Workspace Settings',
        category: 'Preferences',
        keywords: ['project', 'nox', 'folder', 'settings', 'shared'],
        // Creating the file is a write, and every command that writes says so.
        capabilities: ['fs.write'],
        enabled: this.#hasFolder,
        run: async () => {
          const root = this.workspace.rootPath.get();
          if (!root) return;
          const path = workspaceConfigPath(root);
          if (!(await this.platform.exists(path))) {
            // An empty object rather than a commented template: JSON has no
            // comments, and a template of keys nobody asked for is a file
            // that gets committed half-read.
            const dir = dirname(path);
            if (!(await this.platform.exists(dir))) await this.platform.createDir(dir);
            await this.platform.writeTextFile(path, '{}\n');
          }
          await this.workspace.open(path);
        },
      },

      // --- Application ------------------------------------------------------
      {
        id: 'app.checkForUpdates',
        title: 'Check for Updates…',
        category: 'Application',
        keywords: ['update', 'upgrade', 'version', 'release', 'new'],
        // On the service, not the platform flag — the git.showDiff argument:
        // tests start the service over a memory platform.
        enabled: () => this.updates.started,
        // Returned, not voided: execute() awaits run's return value, and a
        // caller (or test) that awaits the command should see the check done.
        run: () => this.updates.checkNow({ manual: true }),
      },
    ];

    this.commands.registerAll(commands);
  }

  #registerKeybindings(): void {
    this.keymap.bindAll({
      // File
      'Mod+N': 'file.new',
      'Mod+O': 'file.open',
      'Mod+Shift+O': 'file.openFolder',
      'Mod+S': 'file.save',
      'Mod+Shift+S': 'file.saveAs',
      'Mod+Alt+S': 'file.saveAll',
      'Mod+W': 'file.close',

      // Navigation
      'Mod+Shift+P': 'nav.commandPalette',
      'Mod+K': 'nav.commandPalette',
      'Mod+P': 'nav.quickOpen',
      // Sibling to ⌘P: the same question asked of what is already open.
      'Mod+E': 'nav.switchBuffer',
      'Mod+Shift+]': 'nav.nextTab',
      'Mod+Shift+[': 'nav.previousTab',
      // These previously duplicated ⌘⇧] / ⌘⇧[; panes are a better use of them.
      'Mod+Alt+Right': 'view.focusNextGroup',
      'Mod+Alt+Left': 'view.focusPreviousGroup',
      'Mod+\\': 'view.splitEditor',
      'Mod+Shift+\\': 'view.closeGroup',
      'Mod+Alt+Shift+Right': 'view.moveEditorToNextGroup',
      'Mod+Alt+Shift+Left': 'view.moveEditorToPreviousGroup',
      'Mod+Shift+E': 'nav.focusExplorer',
      'Mod+R': 'nav.goToSymbol',
      'Mod+Shift+F': 'search.focus',
      'Mod+Shift+N': 'notes.focus',
      // The problems list is the panel most worth a hotkey, and ⌘⇧M is the
      // convention everywhere. References keeps no chord of its own: its
      // natural entry is Shift+F12, which already fills and shows the view.
      'Mod+Shift+M': 'problems.focus',
      'Mod+Shift+A': 'answers.focus',
      // The agents panel had no chord and no button, so the only way to it was
      // knowing its name in the palette. ⇧⌘Y because the mnemonic letters are
      // all taken — A is Answers, G is Find Previous — and Y is free on every
      // platform and unclaimed by CodeMirror's keymap.
      'Mod+Shift+Y': 'agents.show',

      // Edit
      'Mod+F': 'edit.find',
      'Mod+Alt+F': 'edit.replace',
      'Mod+G': 'edit.findNext',
      'Mod+Shift+G': 'edit.findPrevious',
      F3: 'edit.findNext',
      'Shift+F3': 'edit.findPrevious',
      'Mod+Shift+L': 'edit.selectAllMatches',
      // ⌘⇧[ / ⌘⇧] already switch tabs, so folding takes the ⌥ variants.
      'Mod+Alt+[': 'edit.fold',
      'Mod+Alt+]': 'edit.unfold',
      'Mod+Alt+Shift+[': 'edit.foldAll',
      'Mod+Alt+Shift+]': 'edit.unfoldAll',

      // Language. F12 is the convention everywhere; it needs no chord.
      F12: 'lsp.goToDefinition',
      'Shift+F12': 'lsp.findReferences',
      F2: 'lsp.renameSymbol',
      'Shift+Alt+F': 'lsp.formatDocument',

      // View
      'Mod+B': 'view.toggleExplorer',
      'Alt+Z': 'view.toggleWordWrap',
      'Mod+=': 'view.increaseFontSize',
      'Mod+-': 'view.decreaseFontSize',
      'Mod+0': 'view.resetFontSize',

      // Terminal. `Ctrl+\`` rather than a Mod chord on purpose: it is the
      // convention on every platform, and ⌘` is already macOS's cycle-windows.
      'Ctrl+`': 'terminal.toggle',

      // Preferences
      'Mod+,': 'prefs.open',
      'Mod+Alt+K': 'prefs.keybindings',
    });

    // Go to Line: ⌃G matches macOS convention without colliding with ⌘G
    // (Find Next). On Windows and Linux ⌃G is already Find Next, so use ⌥G.
    this.keymap.bind(platformIsMac ? 'Ctrl+G' : 'Alt+G', 'nav.goToLine');

    // ⌘1…⌘9 jump to a tab by position.
    for (let index = 0; index < 9; index++) {
      this.keymap.bind(`Mod+${index + 1}`, 'nav.goToTab', { arg: index });
    }

    // Escape only claims the key when there is something to dismiss;
    // otherwise it falls through to CodeMirror to collapse multi-cursors.
    this.keymap.bind('Escape', 'view.dismiss', { when: () => this.ui.hasDismissible() });
  }

  // --- Editor bridge -------------------------------------------------------

  /**
   * Views, one per editor group.
   *
   * `app.view` always points at the *focused* pane, so every command that
   * runs against "the editor" keeps working unchanged now that there can be
   * several of them.
   */
  #groupViews = new Map<string, EditorView>();

  registerGroupView(groupId: string, view: EditorView): void {
    this.#groupViews.set(groupId, view);
    if (this.workspace.activeGroupId.get() === groupId) this.setActiveGroupView(groupId);
  }

  unregisterGroupView(groupId: string): void {
    const view = this.#groupViews.get(groupId);
    this.#groupViews.delete(groupId);
    if (this.view.get() === view) this.setView(null);
  }

  /**
   * The lines of a buffer that are actually rendered, if any pane is showing
   * it. Null for a background tab — which is the honest answer: "on screen"
   * and "open" are different questions, and an agent asking the first one
   * should not be told the second.
   */
  viewportOf(bufferId: string): { from: number; to: number } | null {
    for (const group of this.workspace.groups.get()) {
      if (group.activeId !== bufferId) continue;
      const view = this.#groupViews.get(group.id);
      if (!view) continue;

      const { from, to } = view.viewport;
      const doc = view.state.doc;
      return { from: doc.lineAt(from).number, to: doc.lineAt(Math.min(to, doc.length)).number };
    }
    return null;
  }

  /** Point `app.view` at a group's editor. */
  setActiveGroupView(groupId: string): void {
    const view = this.#groupViews.get(groupId) ?? null;
    if (view !== this.view.get()) this.setView(view);
  }

  /** Called by EditorPane when the view is created or destroyed. */
  setView(view: EditorView | null): void {
    this.view.set(view);
    this.find.attach(view);
  }

  goToLine(line: number, column = 1): void {
    const view = this.view.get();
    if (view) goToLine(view, line, column);
  }

  async #goToDefinition(): Promise<void> {
    const view = this.view.get();
    const snapshot = this.workspace.activeSnapshot();
    if (!view || !snapshot?.path) return;

    const text = view.state.doc.toString();
    let response: unknown;
    try {
      response = await this.lsp.requestFor(snapshot.languageId, 'textDocument/definition', {
        textDocument: { uri: pathToUri(snapshot.path) },
        position: positionAt(text, view.state.selection.main.head),
      });
    } catch (error) {
      this.notifications.error(
        'Go to definition failed',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    const targets = definitionTargets(response);
    if (targets.length === 0) {
      this.notifications.info('No definition found');
      return;
    }

    const landed = await this.revealLocation(targets[0]!);
    if (landed && targets.length > 1) {
      // The common case is one, and a jump that sometimes does not jump is
      // worse than one that goes to the first and shows the rest.
      await this.showLocations('Definitions', wordAt(view), targets);
    }
  }

  /** Every place the symbol under the cursor is used, listed in the sidebar. */
  async #findReferences(): Promise<void> {
    const view = this.view.get();
    const snapshot = this.workspace.activeSnapshot();
    if (!view || !snapshot?.path) return;

    const text = view.state.doc.toString();
    let response: unknown;
    try {
      response = await this.lsp.requestFor(snapshot.languageId, 'textDocument/references', {
        textDocument: { uri: pathToUri(snapshot.path) },
        position: positionAt(text, view.state.selection.main.head),
        // A list of uses that leaves out the declaration sends the reader to
        // go to definition to find it; including it costs one row.
        context: { includeDeclaration: true },
      });
    } catch (error) {
      this.notifications.error(
        'Find references failed',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    const targets = referenceTargets(response);
    if (targets.length === 0) {
      this.notifications.info('No references found');
      return;
    }

    // The cursor stays. Twenty places is a choice, and choosing for the user
    // is what "went to the first" was apologising for.
    await this.showLocations('References', wordAt(view), targets);
  }

  /**
   * Rename the symbol under the cursor everywhere the server says it is —
   * staged in the review panel, never written blind.
   *
   * Every file the edit touches is opened first: the review needs a buffer,
   * and after apply the tab is where the result is seen and saved from. One
   * file that cannot be opened stops the whole rename before anything is
   * staged, because a rename applied to eleven of twelve files is a
   * half-rename nobody asked for. Applied buffers are left dirty, as every
   * reviewed change set is; Save All is one command away. The design doc
   * says why.
   */
  async #renameSymbol(): Promise<void> {
    const view = this.view.get();
    const snapshot = this.workspace.activeSnapshot();
    if (!view || !snapshot?.path) return;

    const { languageId, path } = snapshot;
    const text = view.state.doc.toString();
    const position = positionAt(text, view.state.selection.main.head);
    const textDocument = { uri: pathToUri(path) };
    const subject = wordAt(view);

    // Ask first where the server offers it: a keyword, whitespace or a
    // library symbol gets "nothing to rename" instead of a prompt that can
    // only fail.
    let seed = subject;
    const provider = this.lsp.capabilitiesFor(languageId)?.renameProvider as
      | boolean
      | { prepareProvider?: boolean }
      | undefined;
    if (typeof provider === 'object' && provider?.prepareProvider) {
      let prepared: unknown;
      try {
        prepared = await this.lsp.requestFor(languageId, 'textDocument/prepareRename', {
          textDocument,
          position,
        });
      } catch (error) {
        this.notifications.error(
          'Rename failed',
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      const prepareSeed = prepareRenameSeed(prepared, subject, (range) =>
        text.slice(offsetAt(text, range.start), offsetAt(text, range.end)),
      );
      if (prepareSeed === null) {
        this.notifications.info('Nothing to rename here');
        return;
      }
      seed = prepareSeed;
    }

    const newName = await this.ui.askForText({
      title: 'Rename Symbol',
      label: 'New name',
      initialValue: seed,
      selectTo: seed.length,
      confirmLabel: 'Rename',
      validate: (value) => {
        if (value.trim().length === 0) return 'A name is required';
        if (value === seed) return 'That is the current name';
        return null;
      },
    });
    if (newName === null) return;

    let response: unknown;
    try {
      response = await this.lsp.requestFor(languageId, 'textDocument/rename', {
        textDocument,
        position,
        newName,
      });
    } catch (error) {
      // The server's message, because it is the one that knows why — the
      // usual reason is that it refused the new name.
      this.notifications.error(
        'Rename failed',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    const plan = renameEdits(response);
    if (plan.unsupported.length > 0) {
      this.notifications.warn(
        'Rename needs file operations Nox does not perform',
        `The server asked to ${[...new Set(plan.unsupported)].join(', ')} a file. Nothing was changed.`,
      );
      return;
    }
    if (plan.files.length === 0) {
      this.notifications.info('Nothing to rename');
      return;
    }

    // Open everything before staging anything. The positions the server sent
    // are against the text it was sent — an open buffer's, or the disk's —
    // and opening reads the disk, so once every file is open each buffer's
    // text is what the server saw. A keystroke after staging is caught by
    // the review's own revision guard at apply time, not here.
    const edits: ChangeSetSpec['edits'] = [];
    for (const file of plan.files) {
      let filePath: string;
      try {
        filePath = uriToPath(file.uri);
      } catch {
        this.notifications.warn('Rename touches a file Nox cannot open', `${file.uri} — nothing was changed.`);
        return;
      }
      const id = await this.workspace.open(filePath);
      if (!id) {
        // The workspace has already said why, through its error event.
        this.notifications.warn('Rename stopped', `${basename(filePath)} could not be opened, so nothing was changed.`);
        return;
      }
      const bufferText = this.workspace.textOf(id);
      if (bufferText === undefined) return;
      edits.push({ bufferId: id, changes: changesOf(bufferText, file.edits) });
    }
    // Opening activates, and the user asked from `snapshot`'s file: the
    // review panel is what they look at next, and the file they were in is
    // what they should find behind it.
    this.workspace.setActive(snapshot.id);

    const staged = this.review.stage({
      description: `Rename ${subject || 'symbol'} → ${newName}`,
      author: { kind: 'user' },
      edits,
    });
    if (!staged) {
      this.notifications.info('Nothing to rename', 'The server’s edit would change nothing.');
    }
  }

  /**
   * Fill the References view with `locations` and show it.
   *
   * The line each row shows is read once, here: an open buffer's text from
   * the workspace, anything else from disk, a failed read becoming an empty
   * line. The panel is a snapshot of an answer, and the answer was already
   * a snapshot.
   */
  async showLocations(title: string, subject: string, locations: readonly LspLocation[]): Promise<void> {
    const texts = new Map<string, string>();
    for (const location of locations) {
      let path: string;
      try {
        path = uriToPath(location.uri);
      } catch {
        continue;
      }
      if (texts.has(path)) continue;
      const open = this.workspace.findByPath(path);
      const text = open ? this.workspace.textOf(open.id) : undefined;
      if (text !== undefined) {
        texts.set(path, text);
        continue;
      }
      try {
        texts.set(path, await this.platform.readTextFile(path));
      } catch {
        texts.set(path, '');
      }
    }

    const rows = locationRows(locations, texts, this.workspace.rootPath.get());
    this.locations.set({
      title,
      subject,
      rows,
      files: rows.filter((row) => row.kind === 'file').length,
      total: rows.length - rows.filter((row) => row.kind === 'file').length,
    });
    // Otherwise the view is set and nothing shows, the trap `problems.focus`
    // documents.
    this.config.set('workbench.showExplorer', true);
    this.ui.showView('references');
  }

  /**
   * Open the file a location names and select the range. Returns whether the
   * selection was set: the caller may have something to say about the jump,
   * and must not say it after one that did not happen. Public because find
   * references lands the same way.
   */
  async revealLocation(location: LspLocation): Promise<boolean> {
    let path: string;
    try {
      path = uriToPath(location.uri);
    } catch {
      this.notifications.info('Definition is not in a file Nox can open', location.uri);
      return false;
    }

    // `open` returns the id of a file already open, so there is nothing to
    // save by checking first. A null means it already said why through the
    // workspace's error event; a second toast here would only repeat it.
    const id = await this.workspace.open(path);
    if (!id) return false;

    const text = this.workspace.textOf(id);
    if (text === undefined) return false;

    // Through the workspace, not the view: `setSelection` dispatches to the
    // pane showing the buffer and otherwise updates the buffer's own state,
    // so it is right whether or not a pane has swapped to the target yet. It
    // inherits the workspace's clamping and its scrollIntoView.
    const from = offsetAt(text, location.range.start);
    // A server that hands back an inverted range must not become a backwards
    // selection.
    const to = Math.max(from, offsetAt(text, location.range.end));
    this.workspace.setSelection(id, { ranges: [[from, to]], main: 0 });
    return true;
  }

  /**
   * Show the explorer, open every directory above `path`, and select it.
   *
   * `expandSelf` is for a directory target. `files.reveal` stops one segment
   * short — its argument is normally a file, and expanding a file means
   * nothing — so revealing `src/ui` opens `src` and leaves `ui` shut. A
   * caller naming a directory wants that directory open, not its parent.
   *
   * Selecting is what makes the reveal visible: the explorer scrolls its lead
   * row into view and nothing else, so a directory opened without being
   * selected can expand entirely off-screen. This does stomp a multi-selection,
   * unlike the panel's follow-the-active-tab effect, which deliberately does
   * not — that one fires on its own and must not interrupt a selection being
   * built, while everything reaching here was asked for by name.
   */
  async revealInExplorer(path: string, { expandSelf = false } = {}): Promise<void> {
    this.config.set('workbench.showExplorer', true);
    await this.files.reveal(path);
    if (expandSelf) await this.files.expand(path);
    this.ui.explorer.set(path);
  }

  /** Settings that need a live reconfigure rather than a state rebuild. */
  settingsAffectingEditor(keys: ReadonlySet<SettingKey>): boolean {
    for (const key of keys) if (key.startsWith('editor.')) return true;
    return false;
  }

  async dispose(): Promise<void> {
    this.#disposeDropListener?.();
    this.#disposeDropListener = null;
    this.#disposeCloseListener?.();
    this.#disposeCloseListener = null;
    this.#disposeRejectionListener?.();
    this.#disposeRejectionListener = null;
    this.keymap.detach();
    this.menu.dispose();
    this.watcher.stop();
    this.updates.stop();
    // Notes first: settings and session each have an on-disk original to
    // fall back on if their flush is lost, but a note does not.
    // Before the flushes: a reload does not kill the processes the renderer
    // started, so without this every reload leaves a server orphaned with
    // nothing left to talk to it.
    await this.lsp.stop();
    await this.platform.stopAllLanguageServers().catch(() => undefined);
    await this.notes.flush();
    await this.config.flush();
    await this.session.save();
  }
}

/** Length of the trailing `.ext`, used to pre-select the stem in Save As. */
/** The word at the main cursor, or '' when the cursor is not on one. */
function wordAt(view: EditorView): string {
  const { head } = view.state.selection.main;
  const word = view.state.wordAt(head);
  return word ? view.state.sliceDoc(word.from, word.to) : '';
}

function extLength(path: string): number {
  const name = basename(path);
  const index = name.lastIndexOf('.');
  return index > 0 ? name.length - index : 0;
}

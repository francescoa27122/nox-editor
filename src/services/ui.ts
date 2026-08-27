import { Signal } from '@core/signal';
import { ExplorerSelection } from './selection';

/**
 * Transient interface state: which overlay is showing, whether find is open,
 * and what has focus.
 *
 * This lives in a service rather than in components so commands can drive the
 * UI without reaching into the component tree, and so exactly one thing knows
 * what Escape should close.
 */

export type OverlayKind =
  | 'palette'
  | 'quick-open'
  | 'buffers'
  | 'go-to-line'
  | 'go-to-symbol'
  | 'git-branch'
  | 'code-action'
  // The language a buffer is *edited* as, not anything to do with a language
  // server — see the `Language` command category, which holds both.
  | 'language'
  // Not 'notes': `SidebarView` and `FocusZone` below both already have one,
  // and three unions sharing a member name makes a bare string literal
  // ambiguous at every call site.
  | 'note-open'
  | 'settings'
  | 'keybindings';

/** One row of the code-action picker. */
export interface CodeActionChoice {
  title: string;
  kind: string | undefined;
  preferred: boolean;
  runnable: boolean;
  /** Why it cannot be run, shown on the row. */
  reason: string | undefined;
}

/** The panels Nox itself ships. */
export type CoreSidebarView =
  | 'explorer'
  | 'search'
  | 'notes'
  | 'answers'
  | 'problems'
  | 'references'
  | 'git';

/**
 * A panel contributed by a plugin.
 *
 * A template literal rather than `string`, which is the whole reason this
 * stayed a useful type after plugins arrived: every plugin view id is
 * `plugin.<id>.<name>` by construction, so the union still says what a view
 * *is* and a typo in a core name is still a compile error. Widening to
 * `string` would have made every one of those checks vanish at once.
 */
export type PluginSidebarView = `plugin.${string}`;

/** Which panel the sidebar is showing. */
export type SidebarView = CoreSidebarView | PluginSidebarView;

/** True when a view belongs to a plugin rather than to Nox. */
export function isPluginView(view: SidebarView): view is PluginSidebarView {
  return view.startsWith('plugin.');
}

export interface PromptRequest {
  title: string;
  label?: string;
  initialValue: string;
  placeholder?: string;
  confirmLabel: string;
  /** Pre-select this many characters, e.g. the stem before a file extension. */
  selectTo?: number;
  validate?: (value: string) => string | null;
  resolve: (value: string | null) => void;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  /** `danger` marks a choice destructive: it never becomes the default. */
  choices: { id: string; label: string; danger?: boolean }[];
  /**
   * Which choice Enter picks, and which one wears the primary colour.
   *
   * Name it whenever the safe answer is not simply "the first non-danger
   * choice". The permission prompt is exactly that case — its three choices
   * are two grants and a refusal, so inferring the default from position or
   * from `danger` alone put the keyboard on "Allow for this session".
   */
  defaultChoiceId?: string;
  resolve: (choiceId: string | null) => void;
}

export type FocusZone =
  | 'editor'
  | 'explorer'
  | 'search'
  | 'find'
  | 'overlay'
  | 'terminal'
  | 'notes'
  | 'answers'
  | 'problems'
  | 'references'
  | 'git';

export class UIService {
  readonly overlay = new Signal<OverlayKind | null>(null);
  /**
   * The code actions the picker is showing.
   *
   * Filled by `NoxApp` before the overlay opens, rather than fetched by the
   * component the way the branch picker fetches its branches. Asking for them
   * needs the caret, the selection and the diagnostics that overlap it, and
   * deciding which of those to send is a service's job — a component that
   * assembled an LSP request would be the `if` about what should happen that
   * rule 1 keeps out of components.
   *
   * Plain data on purpose: a title, whether it can be run, and why not. What
   * running one *means* stays behind `NoxApp.applyCodeAction`.
   */
  readonly codeActions = new Signal<readonly CodeActionChoice[]>([]);
  /**
   * What is highlighted in the explorer. Lifted out of the component so
   * commands can act on it from the palette, and so it survives a remount.
   */
  readonly explorer = new ExplorerSelection();
  readonly sidebarView = new Signal<SidebarView>('explorer');
  /** Bumped to ask the search panel's input to take focus. */
  readonly focusSearchRequest = new Signal(0);
  /** True while files from outside the app are hovering over the window. */
  readonly externalDropActive = new Signal(false);
  /**
   * The tab currently being dragged, and where it is hovering.
   *
   * Shared rather than component-local because a tab dragged between two panes
   * starts in one TabBar and is dropped on another: the receiving strip has to
   * know a drag is in progress before it will accept the drop at all.
   */
  readonly tabDrag = new Signal<{
    bufferId: string;
    overGroupId: string | null;
    overIndex: number | null;
  } | null>(null);
  readonly findOpen = new Signal(false);
  /**
   * Whether the review panel is showing.
   *
   * Separate from "a change set is staged", because the two are different
   * questions. The panel takes over the editor area, so without this there was
   * no way to look at the file you were reviewing except by discarding the
   * review or applying it — the two destructive options.
   */
  readonly reviewOpen = new Signal(false);
  /**
   * Whether the agents panel is showing. Shares the editor area with the
   * review panel: an audit trail of what a session read and ran needs the
   * width, and it wrapped to nonsense in a 200px sidebar.
   */
  readonly agentsOpen = new Signal(false);
  /**
   * Whether the git diff view is showing, in the same slot. Layered below
   * review and agents in both the render conditional and `dismissTop`:
   * staging a set while the diff is open shows the review, and Escape then
   * uncovers the diff again rather than the editor.
   */
  readonly diffOpen = new Signal(false);
  /**
   * Whether the welcome screen was asked for.
   *
   * It renders in this slot anyway whenever no buffer is open, so this signal
   * is only about the *other* case: someone with files open who wants it
   * back. Before this existed there was no way back — the one screen that
   * names the essential chords and lists recent folders appeared on first
   * launch, vanished the moment a file opened, and could only be reached
   * again by closing every tab. Off macOS that left an app with 148 commands
   * offering nothing in its chrome that answers "where do I start".
   *
   * Not a layer under the file panels but a stand-in *for* the editor: asking
   * for it clears review, agents and diff, and anything that shows you the
   * editor again clears it. That rule lives in `focusEditor`, which is what
   * every route back to a file goes through.
   */
  readonly welcomeOpen = new Signal(false);
  /**
   * Whether the terminal panel is showing.
   *
   * Sits *below* the editor rather than taking it over, unlike review and
   * agents: the whole point of a terminal in an editor is watching a build
   * fail next to the code that failed.
   */
  readonly terminalOpen = new Signal(false);
  /** Bumped to ask the terminal to take focus. */
  readonly focusTerminalRequest = new Signal(0);
  readonly findReplaceMode = new Signal(false);
  readonly prompt = new Signal<PromptRequest | null>(null);
  readonly confirm = new Signal<ConfirmRequest | null>(null);
  readonly focusZone = new Signal<FocusZone>('editor');
  /** Bumped to ask the editor host to take focus. */
  readonly focusEditorRequest = new Signal(0);
  readonly focusExplorerRequest = new Signal(0);
  /** Bumped to ask the notes panel to put the cursor in the note body. */
  readonly focusNotesRequest = new Signal(0);
  /**
   * Bumped to put the caret on the menu bar — the same focus-request shape
   * every panel uses. Only meaningful where Nox draws its own menu.
   */
  readonly focusMenuBarRequest = new Signal(0);
  /**
   * Whether a menu-bar menu is showing. Held here rather than in the
   * component because this file owns the answer to "what does Escape close",
   * and a menu hanging open under a dialog would be two things claiming it.
   */
  readonly menuBarOpen = new Signal(false);
  /** Bumped to ask the answers panel to take focus. */
  readonly focusAnswersRequest = new Signal(0);
  /** Bumped to ask the problems list to take focus. */
  readonly focusProblemsRequest = new Signal(0);
  /** Bumped to ask the references list to take focus. */
  readonly focusReferencesRequest = new Signal(0);
  /** Bumped to ask the git panel to take focus. */
  readonly focusGitRequest = new Signal(0);

  openOverlay(kind: OverlayKind): void {
    this.overlay.set(kind);
    this.focusZone.set('overlay');
  }

  toggleOverlay(kind: OverlayKind): void {
    if (this.overlay.get() === kind) this.closeOverlay();
    else this.openOverlay(kind);
  }

  closeOverlay(): void {
    if (this.overlay.get() === null) return;
    this.overlay.set(null);
    this.focusEditor();
  }

  /**
   * Close the overlay and leave focus to the caller.
   *
   * `closeOverlay` above refocuses the editor, which is right for every
   * picker whose result *is* the editor — a file, a line, a symbol, a
   * branch. It is wrong for one that hands focus somewhere else: both focus
   * requests are signal bumps read by `$effect`, so they land in the same
   * flush and the editor's wins on effect order rather than on intent. The
   * note picker selects a note and then focuses the notes panel, and without
   * this the panel opens with the caret still in the editor.
   */
  closeOverlayWithoutFocus(): void {
    if (this.overlay.get() === null) return;
    this.overlay.set(null);
  }

  openFind(replace: boolean): void {
    this.findReplaceMode.set(replace);
    this.findOpen.set(true);
    this.focusZone.set('find');
  }

  closeFind(): void {
    if (!this.findOpen.get()) return;
    this.findOpen.set(false);
    this.focusEditor();
  }

  focusEditor(): void {
    this.focusZone.set('editor');
    this.focusEditorRequest.update((n) => n + 1);
  }

  /** Open the terminal panel and put the cursor in it. */
  focusTerminal(): void {
    this.terminalOpen.set(true);
    this.focusZone.set('terminal');
    this.focusTerminalRequest.update((n) => n + 1);
  }

  /**
   * Hide the terminal panel. The shell keeps running — closing the panel is
   * not a reason to kill a build half way through.
   */
  hideTerminal(): void {
    if (!this.terminalOpen.get()) return;
    this.terminalOpen.set(false);
    this.focusEditor();
  }

  toggleTerminal(): void {
    if (this.terminalOpen.get()) this.hideTerminal();
    else this.focusTerminal();
  }

  /** Show the agents panel, which shares the editor area with review. */
  showAgents(): void {
    this.reviewOpen.set(false);
    this.diffOpen.set(false);
    this.agentsOpen.set(true);
  }

  /** Show the git diff view, which shares the same slot. */
  showDiff(): void {
    this.reviewOpen.set(false);
    this.agentsOpen.set(false);
    this.diffOpen.set(true);
  }

  /**
   * Show the welcome screen, which shares the same slot again.
   *
   * Clears the other three for the same reason they clear each other: one
   * thing at a time in the editor area. Asking for the welcome screen is an
   * explicit act, so it wins over a diff that was following the active file.
   */
  showWelcome(): void {
    this.reviewOpen.set(false);
    this.agentsOpen.set(false);
    this.diffOpen.set(false);
    this.welcomeOpen.set(true);
  }

  showView(view: SidebarView): void {
    // Each branch focuses its own view. This used to fall through to
    // `focusExplorer` for anything that was not search, which set the view
    // straight back to the explorer — invisible while there were only two.
    if (view === 'search') this.focusSearch();
    else if (view === 'notes') this.focusNotes();
    else if (view === 'answers') this.focusAnswers();
    else if (view === 'explorer') this.focusExplorer();
    else if (view === 'problems') this.focusProblems();
    else if (view === 'references') this.focusReferences();
    else if (view === 'git') this.focusGit();
    else this.sidebarView.set(view);
  }

  focusExplorer(): void {
    this.sidebarView.set('explorer');
    this.focusZone.set('explorer');
    this.focusExplorerRequest.update((n) => n + 1);
  }

  focusSearch(): void {
    this.sidebarView.set('search');
    this.focusZone.set('search');
    this.focusSearchRequest.update((n) => n + 1);
  }

  focusMenuBar(): void {
    this.focusMenuBarRequest.update((n) => n + 1);
  }

  focusNotes(): void {
    this.sidebarView.set('notes');
    this.focusZone.set('notes');
    this.focusNotesRequest.update((n) => n + 1);
  }

  focusAnswers(): void {
    this.sidebarView.set('answers');
    this.focusZone.set('answers');
    this.focusAnswersRequest.update((n) => n + 1);
  }

  // These two were the panels the focus model forgot: `showView` fell to the
  // bare `sidebarView.set`, no request signal existed, and the lists' arrow
  // handlers were unreachable until a mouse click. Found by the 2026-08-19
  // UI audit.
  focusProblems(): void {
    this.sidebarView.set('problems');
    this.focusZone.set('problems');
    this.focusProblemsRequest.update((n) => n + 1);
  }

  focusReferences(): void {
    this.sidebarView.set('references');
    this.focusZone.set('references');
    this.focusReferencesRequest.update((n) => n + 1);
  }

  focusGit(): void {
    this.sidebarView.set('git');
    this.focusZone.set('git');
    this.focusGitRequest.update((n) => n + 1);
  }

  /**
   * Stop showing a view that is no longer available.
   *
   * The answers section exists only while an agent does, and agents.json can
   * be edited or reloaded at any time. Falling back to the explorer is the
   * same healing the editor groups do when a pane empties: a layout with a
   * hole where something used to be is worse than one that closes up.
   */
  dropView(view: SidebarView): void {
    if (this.sidebarView.get() === view) this.focusExplorer();
  }

  /** True when something is showing that Escape should dismiss. */
  hasDismissible(): boolean {
    return (
      this.overlay.get() !== null ||
      this.findOpen.get() ||
      this.reviewOpen.get() ||
      this.agentsOpen.get() ||
      this.diffOpen.get() ||
      this.welcomeOpen.get() ||
      this.menuBarOpen.get() ||
      this.prompt.get() !== null ||
      this.confirm.get() !== null
    );
  }

  /** Close the topmost dismissible layer. Returns false when nothing closed. */
  dismissTop(): boolean {
    if (this.confirm.get()) {
      this.confirm.get()!.resolve(null);
      this.confirm.set(null);
      return true;
    }
    if (this.prompt.get()) {
      this.prompt.get()!.resolve(null);
      this.prompt.set(null);
      return true;
    }
    if (this.overlay.get()) {
      this.closeOverlay();
      return true;
    }
    if (this.findOpen.get()) {
      this.closeFind();
      return true;
    }
    // Ahead of the panels below: a menu is drawn over them, so it is what a
    // person means by Escape while one is showing. The bar itself clears the
    // flag and restores focus; this is the ordering claim, not the mechanism.
    if (this.menuBarOpen.get()) {
      this.menuBarOpen.set(false);
      return true;
    }
    // Escape puts the review away without deciding anything. The staged set
    // survives; only the panel closes.
    if (this.reviewOpen.get()) {
      this.reviewOpen.set(false);
      this.focusEditor();
      return true;
    }
    if (this.agentsOpen.get()) {
      this.agentsOpen.set(false);
      this.focusEditor();
      return true;
    }
    if (this.diffOpen.get()) {
      this.diffOpen.set(false);
      this.focusEditor();
      return true;
    }
    // Last, and mostly a formality: `focusEditor` below clears the signal
    // anyway, so this branch exists to answer *whether* Escape did something.
    // With no buffer open the screen stays on screen afterwards — it is the
    // empty state as well as a layer, and Escape has no business closing an
    // empty state.
    if (this.welcomeOpen.get()) {
      this.welcomeOpen.set(false);
      this.focusEditor();
      return true;
    }
    return false;
  }

  /** Ask the user for a string. Resolves null when cancelled. */
  askForText(request: Omit<PromptRequest, 'resolve'>): Promise<string | null> {
    return new Promise((resolve) => {
      this.prompt.set({
        ...request,
        resolve: (value) => {
          this.prompt.set(null);
          resolve(value);
        },
      });
    });
  }

  /** Ask the user to choose. Resolves null when dismissed. */
  askToConfirm(request: Omit<ConfirmRequest, 'resolve'>): Promise<string | null> {
    return new Promise((resolve) => {
      this.confirm.set({
        ...request,
        resolve: (choice) => {
          this.confirm.set(null);
          resolve(choice);
        },
      });
    });
  }
}

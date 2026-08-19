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
  | 'settings'
  | 'keybindings';

/** Which panel the sidebar is showing. */
export type SidebarView = 'explorer' | 'search' | 'notes' | 'answers' | 'problems' | 'references';

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
  /** First choice is the default; `danger` renders it in the warning colour. */
  choices: { id: string; label: string; danger?: boolean }[];
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
  | 'answers';

export class UIService {
  readonly overlay = new Signal<OverlayKind | null>(null);
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
  /** Bumped to ask the answers panel to take focus. */
  readonly focusAnswersRequest = new Signal(0);

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
    this.agentsOpen.set(true);
  }

  showView(view: SidebarView): void {
    // Each branch focuses its own view. This used to fall through to
    // `focusExplorer` for anything that was not search, which set the view
    // straight back to the explorer — invisible while there were only two.
    if (view === 'search') this.focusSearch();
    else if (view === 'notes') this.focusNotes();
    else if (view === 'answers') this.focusAnswers();
    else if (view === 'explorer') this.focusExplorer();
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

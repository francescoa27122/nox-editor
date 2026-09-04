<script lang="ts">
  import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
  import { LANGUAGES } from '@core/languages';
  import { basename, dirname, relative } from '@core/path';
  import { fuzzyFilter, fuzzyMatch, fuzzyMatchPath, segmentMatch } from '@core/fuzzy';
  import { createSymbolCache, symbolListState, type SymbolKind } from '@core/symbols';
  import { taskCommandLine } from '@core/tasks';
  import { cachedLanguage, hasGrammar, hasSymbolStructure } from '@editor/languages';
  import type { Command } from '@services/commands';
  import { formatChord, normalizeChord } from '@services/keymap';
  import type { OverlayKind } from '@services/ui';
  import { useApp } from './context';
  import Icon, { type IconName } from './Icon.svelte';

  /**
   * One component serves the command palette, quick open, the buffer switcher,
   * go-to-line and go-to-symbol.
   *
   * They share an input, a result list, ranking and keyboard handling — only
   * the item source and the accept action differ. Prefixes (`>`, `~`, `:`,
   * `@`) switch between them mid-typing, so a single muscle memory covers all
   * five.
   */

  interface Props {
    mode: OverlayKind;
  }

  let { mode }: Props = $props();

  const app = useApp();
  const { commands, workspace, files, keymap, ui } = app;
  const codeActions = ui.codeActions;

  const fileIndex = files.fileIndex;
  const buffers = workspace.buffers;
  const recentFiles = workspace.recentFiles;
  const recentFolders = workspace.recentFolders;
  const rootPath = workspace.rootPath;
  const commandVersion = commands.version;

  let input = $state<HTMLInputElement | null>(null);
  let listElement = $state<HTMLElement | null>(null);
  // Intentionally a one-time seed: Overlays keys this component on the mode,
  // so a mode change remounts rather than mutating the query mid-typing.
  // svelte-ignore state_referenced_locally
  let text = $state(initialText(mode));
  let selected = $state(0);

  function initialText(kind: OverlayKind): string {
    if (kind === 'palette') return '>';
    if (kind === 'buffers') return '~';
    if (kind === 'go-to-line') return ':';
    if (kind === 'go-to-symbol') return '@';
    if (kind === 'git-branch') return '';
    if (kind === 'language') return '';
    return '';
  }

  /** The active mode, which the prefix can change without reopening. */
  const effectiveMode = $derived.by<
    | 'commands'
    | 'files'
    | 'buffers'
    | 'line'
    | 'symbols'
    | 'branches'
    | 'notes'
    | 'actions'
    | 'languages'
    | 'recent'
    | 'tasks'
  >(
    () => {
      // The branch picker is a picker, not the multiplexed palette: no prefix
      // may switch it into another mode, because "?" or ">" are legal in what
      // the user might type while filtering.
      if (mode === 'git-branch') return 'branches';
      // Same reasoning as the branch picker: a dedicated picker, so no
      // prefix may switch it. A note title may legitimately start with '>'.
      if (mode === 'note-open') return 'notes';
      // Same again: an action's title is the server's prose and may start with
      // anything, so no prefix may switch this one either.
      if (mode === 'code-action') return 'actions';
      // And again: a dedicated picker, so no prefix may switch it. `C++`
      // starts with nothing special, but `>` is not worth the exception.
      if (mode === 'language') return 'languages';
      // A picker over paths, and a path may start with anything.
      if (mode === 'recent') return 'recent';
      // And again. A task's label is the author's prose, so it may start with
      // anything a prefix would otherwise claim.
      if (mode === 'task-run') return 'tasks';
      if (text.startsWith('>')) return 'commands';
      if (text.startsWith('~')) return 'buffers';
      if (text.startsWith(':')) return 'line';
      if (text.startsWith('@')) return 'symbols';
      return 'files';
    },
  );

  const term = $derived(
    effectiveMode === 'files' ||
    effectiveMode === 'branches' ||
    effectiveMode === 'notes' ||
    effectiveMode === 'actions' ||
    effectiveMode === 'languages' ||
    effectiveMode === 'recent' ||
    effectiveMode === 'tasks'
      ? text.trim()
      : text.slice(1).trim(),
  );

  const placeholder = $derived.by(() => {
    switch (effectiveMode) {
      case 'languages':
        return 'Edit this file as…';
      case 'commands':
        return 'Search commands…';
      case 'buffers':
        return 'Switch to an open file…';
      case 'line':
        return 'Go to line:column…';
      case 'symbols':
        return 'Go to a symbol in this file…';
      case 'branches':
        return 'Switch to a branch, or create one…';
      case 'notes':
        return 'Go to a note…';
      case 'actions':
        return 'Choose a fix…';
      case 'recent':
        return 'Open a recent folder or file…';
      case 'tasks':
        return 'Run a task…';
      default:
        return 'Search files by name…';
    }
  });

  /**
   * What the dialog is called. A screen reader hears this before anything
   * else, and "Command palette" for every mode told a user nothing about
   * whether the picker that just opened wanted a file, a line or a branch.
   * Derived from the effective mode, not the opening one, because the
   * prefixes switch modes without reopening.
   */
  const dialogLabel = $derived.by(() => {
    switch (effectiveMode) {
      case 'languages':
        return 'Set language';
      case 'commands':
        return 'Command palette';
      case 'buffers':
        return 'Switch to an open file';
      case 'line':
        return 'Go to line';
      case 'symbols':
        return 'Go to symbol';
      case 'branches':
        return 'Switch branch';
      case 'notes':
        return 'Go to note';
      case 'actions':
        return 'Code actions';
      default:
        return 'Go to file';
    }
  });

  const modeIcon = $derived.by<IconName>(() => {
    switch (effectiveMode) {
      case 'commands':
        return 'command';
      case 'buffers':
        return 'file';
      case 'line':
        return 'arrow-down';
      case 'symbols':
        return 'dot';
      case 'branches':
        return 'branch';
      case 'notes':
        return 'note';
      case 'actions':
        return 'lightbulb';
      case 'tasks':
        return 'play';
      default:
        return 'search';
    }
  });

  /**
   * Skips the walk while the tree stands still. `rows` recomputes on every
   * keystroke and the palette is remounted per opening, so one cache per
   * mount is exactly the lifetime the file being looked at has.
   */
  const symbolsFor = createSymbolCache();

  // Fetched once per opening: the palette remounts per opening (Overlays
  // keys on the mode), which is exactly the freshness a picker needs.
  let branches = $state<string[] | null>(null);
  $effect(() => {
    if (mode !== 'git-branch') return;
    void app.git.listBranches().then((list) => {
      branches = list;
    });
  });

  interface Row {
    key: string;
    title: string;
    /** Highlight positions into `title`. */
    positions: number[];
    detail?: string;
    badge?: string;
    hint?: string;
    /**
     * The keyword this row matched on, when the title itself did not match.
     * Rendered as a chip so a keyword hit does not look like a mis-hit with
     * zero highlighted characters.
     */
    keyword?: string;
    disabled?: boolean;
    /**
     * Native tooltip. The list is one line per row with no space for a
     * sentence, and a greyed row with no explanation anywhere in the UI is
     * the question "why is Save As… grey?" with no answer.
     */
    tooltip?: string;
    icon: IconName;
    accept: () => void;
  }

  /**
   * `total` is the real match count before the per-mode display caps, so the
   * header count can be honest about truncation ("first M of N") instead of
   * presenting the sliced length as the whole story.
   */
  interface RowsResult {
    rows: Row[];
    total: number;
  }

  const result = $derived.by<RowsResult>(() => {
    void $commandVersion;
    if (effectiveMode === 'commands') return commandRows(term);
    if (effectiveMode === 'buffers') return bufferRows(term);
    if (effectiveMode === 'line') return lineRows(term);
    if (effectiveMode === 'symbols') return symbolRows(term);
    if (effectiveMode === 'branches') return branchRows(term);
    if (effectiveMode === 'tasks') return taskRows(term);
    if (effectiveMode === 'notes') return noteRows(term);
    if (effectiveMode === 'actions') return actionRows(term);
    if (effectiveMode === 'languages') return languageRows(term);
    if (effectiveMode === 'recent') return recentRows(term);
    return fileRows(term);
  });
  const rows = $derived(result.rows);
  const total = $derived(result.total);

  /**
   * Where the cursor lands when the result set changes.
   *
   * Normally the top match. The buffer switcher opens on the *second* entry
   * instead, because the first is the file you are already looking at — the
   * whole point of the switcher is getting back to the one before it.
   */
  const defaultIndex = $derived(
    effectiveMode === 'buffers' && term.length === 0 && rows.length > 1 ? 1 : 0,
  );

  $effect(() => {
    void rows;
    selected = defaultIndex;
  });

  $effect(() => {
    input?.focus();
  });

  /**
   * What a category hit is worth next to a title hit.
   *
   * The palette used to score the rendered `"Category: Title"` label as one
   * string, which let category *length* decide the winner: "Preferences"
   * contains r-e-f-e-r-e-n-c-e from index 0 and collects `BONUS_FIRST`, while
   * "Language: Find References" pays `PENALTY_LEADING` for its 15-character
   * prefix — so typing "reference" put four Preferences commands above both
   * References commands. Scoring title and category separately and weighting
   * the category down restores what a category was ever meant to be: a
   * secondary signal, not the deciding one.
   */
  const CATEGORY_WEIGHT = 0.25;

  /** How far a command is greyed out of the ranking. Disabled always loses. */
  const DISABLED_PENALTY = 1000;

  interface CommandHit {
    score: number;
    /** Positions into the rendered label, not into whichever part matched. */
    positions: number[];
    keyword?: string;
  }

  /**
   * Score one command against the query.
   *
   * Four sources in decreasing authority: the title, the category, the two
   * concatenated, and the keywords. The concatenation survives only as a
   * fallback for a query that straddles the separator ("file save") — the
   * row would otherwise vanish, and *that* is the only thing scoring the
   * label was ever buying us.
   */
  function scoreCommand(query: string, command: Command, label: string): CommandHit | null {
    const titleOffset = label.length - command.title.length;
    const title = fuzzyMatch(query, command.title);
    const category = command.category ? fuzzyMatch(query, command.category) : null;

    if (title) {
      return {
        score: title.score + CATEGORY_WEIGHT * (category?.score ?? 0),
        positions: title.positions.map((p) => p + titleOffset),
      };
    }
    // A category-only hit lists the whole category, well below any title hit.
    if (category) return { score: CATEGORY_WEIGHT * category.score, positions: category.positions };

    const spanning = fuzzyMatch(query, label);
    if (spanning) return { score: spanning.score, positions: spanning.positions };

    return matchAgainstKeywords(query, command);
  }

  /**
   * Commands that open the very list they would be listed in.
   *
   * `nav.commandPalette` sorted first on an empty query, so the highlighted
   * row on opening the palette was "Go: Command Palette" and Enter re-opened
   * what was already on screen — the one keystroke a new user is most likely
   * to try, answered with nothing happening. They stay in the Go menu and the
   * keybinding editor, which is where discovering them is useful.
   */
  const SELF_OPENING = new Set(['nav.commandPalette']);

  function commandRows(query: string): RowsResult {
    const scored: { row: Row; score: number; title: string }[] = [];

    for (const command of commands.palette()) {
      if (SELF_OPENING.has(command.id)) continue;
      const label = command.category ? `${command.category}: ${command.title}` : command.title;
      const won = scoreCommand(query, command, label);
      if (!won) continue;

      const enabled = commands.isEnabled(command.id);
      // Application bindings win; `keyHint` covers the CodeMirror-owned ones.
      const hint =
        keymap.displayFor(command.id) ??
        (command.keyHint ? formatChord(normalizeChord(command.keyHint)) : undefined);
      scored.push({
        score: won.score - (enabled ? 0 : DISABLED_PENALTY),
        title: command.title,
        row: {
          key: command.id,
          title: label,
          positions: won.positions,
          disabled: !enabled,
          tooltip: tooltipFor(label, enabled, hint),
          icon: 'command',
          ...(hint ? { hint } : {}),
          // Only a keyword-won match carries the chip; a title hit already
          // shows where it landed via the highlights.
          ...(won.keyword ? { keyword: won.keyword } : {}),
          accept: () => {
            ui.closeOverlay();
            void commands.execute(command.id);
          },
        },
      });
    }

    // With an empty query, float this session's recently-run commands to the
    // top in most-recent-first order, skipping any that are disabled right
    // now; everything else keeps its order below.
    //
    // Registration order in `app.ts` is a curated, category-grouped list, and
    // with every score equal a stable sort is what preserves it — which is
    // why the empty-query branch sorts on score alone and the tie-break below
    // is reserved for a real query.
    if (query.length === 0) {
      scored.sort((a, b) => b.score - a.score);
      const rank = new Map(commands.recentCommands().map((id, index) => [id, index]));
      const recent: typeof scored = [];
      const rest: typeof scored = [];
      for (const entry of scored) {
        if (!entry.row.disabled && rank.has(entry.row.key)) recent.push(entry);
        else rest.push(entry);
      }
      recent.sort((a, b) => rank.get(a.row.key)! - rank.get(b.row.key)!);
      scored.length = 0;
      scored.push(...recent, ...rest);
      return { rows: scored.slice(0, 200).map((s) => s.row), total: scored.length };
    }

    // Under a query the sort had no tie-break at all, so `Array.sort` being
    // stable meant every tie was decided by registration order — by accident.
    // That is how ">undo" ran `agents.undoLastSession`, which reverts an
    // agent's edits across files with no confirmation, instead of `edit.undo`;
    // and how ">close" ran `file.closeFolder` and dropped the workspace
    // instead of `file.close`. The keys below, in order:
    //
    // 1. Score. What you typed still decides, outright.
    // 2. Shorter title. Among equally-good matches the terser title is the
    //    more general action — "Undo" over "Undo the Last Agent Session",
    //    "Close File" over "Close Files to the Right", "Save" over "Save As…".
    // 3. Recency, this session. The previous comment here argued against
    //    blending recency under a query, on the grounds that a ranking which
    //    reorders under your fingers is worse than a predictable one. That
    //    reasoning is kept and the conclusion narrowed rather than reversed:
    //    recency is a *tie-break*, never a bonus, so it can only order rows
    //    the query itself scored identically — no row ever overtakes a
    //    better-matching one because of what you ran earlier. As a bonus it
    //    would also be actively unsafe here, since running the agent undo
    //    once would float it back above `edit.undo` for ">undo".
    // 4. The id, so the order is total and reproducible in a test.
    const rank = new Map(commands.recentCommands().map((id, index) => [id, index]));
    const recencyOf = (id: string) => rank.get(id) ?? Number.MAX_SAFE_INTEGER;
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.title.length - b.title.length ||
        recencyOf(a.row.key) - recencyOf(b.row.key) ||
        (a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : 0),
    );

    return { rows: scored.slice(0, 200).map((s) => s.row), total: scored.length };
  }

  /**
   * What a row says on hover.
   *
   * A disabled row is drawn at 0.42 opacity and explains itself nowhere, so
   * the honest answer is the one given here. It cannot name the actual reason
   * — enablement is an opaque `() => boolean` on `Command`, with no companion
   * that says why — so it names the usual causes and does not pretend to more
   * than it knows. A first-class `disabledReason?: () => string` on `Command`
   * would replace this; that lives in `services/commands.ts`.
   */
  function tooltipFor(label: string, enabled: boolean, hint: string | undefined): string {
    if (!enabled) {
      return `${label} — unavailable right now, usually because no file or folder is open, or no language server is running for this file`;
    }
    return hint ? `${label} — ${hint}` : label;
  }

  function matchAgainstKeywords(query: string, command: Command): CommandHit | null {
    for (const keyword of command.keywords ?? []) {
      const match = fuzzyMatch(query, keyword);
      // Keyword hits rank below title hits so exact titles always win. The
      // keyword itself travels along so the row can say what it matched on.
      if (match) return { score: match.score * 0.6, positions: [] as number[], keyword };
    }
    return null;
  }

  /** A path with everything quick-open derives from it, computed once. */
  interface FileEntry {
    path: string;
    display: string;
    nameStart: number;
    name: string;
    folder: string;
  }

  function buildEntries(root: string | null, source: readonly string[]): FileEntry[] {
    return source.map((path) => {
      const display = root ? relative(root, path) : path;
      const name = basename(display);
      return { path, display, name, nameStart: display.length - name.length, folder: dirname(display) };
    });
  }

  /**
   * The derived half of the index, memoised on the index array's identity.
   *
   * `relative`, `basename` and `dirname` are pure in `(root, path)`, and both
   * inputs are the same from one keystroke to the next — but this ran over
   * every path on every keystroke, and `basename` twice per path. Measured on
   * a 16,000-path index it was **6.6 ms of a 16 ms frame**, which was most of
   * the fixed cost of a search that found nothing at all.
   *
   * Keyed on the array's identity rather than its contents: `FileTreeService`
   * publishes a new array when the index is rebuilt, so a stale entry cannot
   * outlive the paths it describes, and the comparison stays O(1).
   */
  let entryCache: { root: string | null; source: readonly string[]; entries: FileEntry[] } | null =
    null;

  function cachedEntries(root: string | null, source: readonly string[]): FileEntry[] {
    if (entryCache && entryCache.root === root && entryCache.source === source) {
      return entryCache.entries;
    }
    const entries = buildEntries(root, source);
    entryCache = { root, source, entries };
    return entries;
  }

  function fileRows(query: string): RowsResult {
    const root = $rootPath;
    // The empty-query list is a fresh 100-item array every call, so it is
    // built rather than cached — caching it would evict the index the moment
    // the query was cleared, which is exactly when the index is next wanted.
    const entries =
      query.length === 0 ? buildEntries(root, recentFirst()) : cachedEntries(root, $fileIndex);

    const scored: { row: Row; score: number }[] = [];
    for (const { path, display, nameStart, name, folder } of entries) {
      const match = fuzzyMatchPath(query, display, nameStart);
      if (!match) continue;

      // Highlights are computed against the full display path; shift them
      // onto the filename, which is what the row actually renders.
      const positions = match.positions.filter((p) => p >= nameStart).map((p) => p - nameStart);

      scored.push({
        score: match.score,
        row: {
          key: path,
          title: name,
          positions,
          icon: 'file',
          ...(folder ? { detail: folder } : {}),
          accept: () => {
            ui.closeOverlay();
            void workspace.open(path);
          },
        },
      });
      if (scored.length > 4000) break;
    }

    scored.sort((a, b) => b.score - a.score);
    // `total` is capped by the 4000-candidate scoring break above, so on a
    // huge index it is a lower bound — still far more honest than the slice.
    return { rows: scored.slice(0, 100).map((s) => s.row), total: scored.length };
  }

  /**
   * Recent folders, then recent files, each most recent first.
   *
   * Folders lead because switching project is the case quick-open cannot
   * serve at all: it indexes the folder that is open, and a folder that is
   * not open is not in it. Both lists are already capped by the workspace,
   * so nothing here is sliced. With no query the order is left alone, for
   * the reason `bufferRows` gives.
   */
  function recentRows(query: string): RowsResult {
    const root = $rootPath;
    const scored: { row: Row; score: number; order: number }[] = [];

    const push = (path: string, kind: 'folder' | 'file', order: number) => {
      const name = basename(path);
      const match = query.length === 0 ? { score: 0, positions: [] } : fuzzyMatch(query, name);
      if (!match) return;
      const detail = kind === 'folder' ? dirname(path) : dirname(root ? relative(root, path) : path);
      scored.push({
        score: match.score,
        order,
        row: {
          key: `${kind}:${path}`,
          title: name,
          positions: match.positions,
          icon: kind,
          ...(detail && detail !== '.' ? { detail } : {}),
          ...(kind === 'folder' ? { hint: 'Folder' } : {}),
          accept: () => {
            ui.closeOverlay();
            if (kind === 'folder') void app.openFolderDialogFor(path);
            else void workspace.open(path);
          },
        },
      });
    };

    $recentFolders.forEach((path, order) => push(path, 'folder', order));
    $recentFiles.forEach((path, order) => push(path, 'file', $recentFolders.length + order));

    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    return { rows: scored.map((s) => s.row), total: scored.length };
  }

  /**
   * Open buffers, most recently used first.
   *
   * Distinct from quick open on purpose: this searches what is already open,
   * ranked by when you last looked at it, so it answers "take me back" rather
   * than "find me this file". With no query the order is left alone — MRU is
   * the ranking, and fuzzy scoring would only scramble it.
   */
  function bufferRows(query: string): RowsResult {
    // Establishes the reactive dependency; the order itself comes from the
    // MRU list, which the snapshot signal does not carry.
    void $buffers;
    const root = $rootPath;

    const scored: { row: Row; score: number; order: number }[] = [];
    workspace.recentBuffers().forEach((buffer, order) => {
      const match = query.length === 0 ? { score: 0, positions: [] } : fuzzyMatch(query, buffer.name);
      if (!match) return;

      const folder = buffer.path ? dirname(root ? relative(root, buffer.path) : buffer.path) : '';
      scored.push({
        score: match.score,
        order,
        row: {
          key: buffer.id,
          title: buffer.name,
          positions: match.positions,
          icon: 'file',
          ...(folder && folder !== '.' ? { detail: folder } : {}),
          ...(buffer.isDirty ? { badge: 'unsaved' } : {}),
          accept: () => {
            ui.closeOverlay();
            workspace.setActive(buffer.id);
            ui.focusEditor();
          },
        },
      });
    });

    // Score first, then MRU as the tie-break — which with no query is the
    // only thing separating them.
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    // No display cap here: every open buffer is shown, so total === rows.
    return { rows: scored.map((s) => s.row), total: scored.length };
  }

  /**
   * Notes by title, pinned ones first.
   *
   * Fuzzy here and substring in the panel's filter box, deliberately: this is
   * the "I know which note I want" path, where a subsequence match reads as
   * mind-reading, while a filter box wants a query that can be narrowed.
   * Titles only — the body is what the panel searches, and a palette row has
   * nowhere to put a matching line.
   */
  /**
   * The code actions the server offered.
   *
   * Server order is kept — it is the server's ranking, and it knows more about
   * which fix is likely than a fuzzy score does — so filtering narrows the
   * list without re-sorting it. Only a typed query scores at all.
   *
   * An action Nox cannot run is **listed and disabled**, never hidden: a
   * picker that hid them would say the server offered nothing where it offered
   * something Nox has not built, and the user would blame their server.
   */
  function actionRows(query: string): RowsResult {
    const rows: Row[] = [];
    for (const [index, action] of $codeActions.entries()) {
      const match =
        query.length === 0 ? { score: 0, positions: [] as number[] } : fuzzyMatch(query, action.title);
      if (!match) continue;
      rows.push({
        key: `action:${index}`,
        title: action.title,
        positions: match.positions,
        icon: 'lightbulb',
        ...(action.kind ? { detail: action.kind } : {}),
        ...(action.preferred ? { badge: 'preferred' } : {}),
        ...(action.runnable ? {} : { disabled: true, hint: action.reason ?? 'Not available' }),
        accept: () => {
          ui.closeOverlay();
          void app.applyCodeAction(index);
        },
      });
    }
    return { rows, total: rows.length };
  }

  /**
   * Every language a buffer can be edited as.
   *
   * Sorted by name rather than by the table's own order, because that order
   * is about detection precedence — `tsx` before `typescript` — and means
   * nothing to someone reading an alphabetical list looking for "Ruby".
   *
   * The current language keeps its place in that list rather than being
   * pulled to the top: this picker is for changing the language, so promoting
   * the one answer that changes nothing would put the least useful row under
   * the cursor. It wears a badge instead.
   *
   * A language with no installed grammar is offered anyway, and says so. It
   * is still the right answer — the LSP document is opened under this id too,
   * and the status bar stops claiming the file is something it is not — so
   * refusing it would be withholding a correct choice over a cosmetic one.
   */
  function languageRows(query: string): RowsResult {
    // `void $buffers` for the dependency, then the service for the answer —
    // the same shape `bufferRows` uses, because the snapshot list does not
    // carry which of its entries is active.
    void $buffers;
    const active = workspace.activeSnapshot();
    const rows: Row[] = [];

    for (const language of [...LANGUAGES].sort((a, b) => a.name.localeCompare(b.name))) {
      const match =
        query.length === 0 ? { score: 0, positions: [] as number[] } : fuzzyMatch(query, language.name);
      if (!match) continue;

      const current = active?.languageId === language.id;
      rows.push({
        key: `language:${language.id}`,
        title: language.name,
        positions: match.positions,
        icon: 'file',
        ...(current ? { badge: 'current' } : {}),
        ...(hasGrammar(language.id) ? {} : { detail: 'no grammar installed' }),
        accept: () => {
          ui.closeOverlay();
          if (active) void app.commands.execute('lang.setLanguage', language.id);
        },
      });
    }
    return { rows, total: rows.length };
  }

  function noteRows(query: string): RowsResult {
    const all = app.notes.notes.get();
    const scored: { row: Row; score: number; pinned: boolean }[] = [];

    for (const note of all) {
      const match =
        query.length === 0 ? { score: 0, positions: [] as number[] } : fuzzyMatch(query, note.title);
      if (!match) continue;
      scored.push({
        score: match.score,
        pinned: note.pinned,
        row: {
          key: `note:${note.id}`,
          title: note.title,
          positions: match.positions,
          icon: 'note',
          ...(note.pinned ? { badge: 'pinned' } : {}),
          accept: () => {
            // Not `closeOverlay`: that refocuses the editor, and its focus
            // request would beat `focusNotes` below to the same flush.
            ui.closeOverlayWithoutFocus();
            app.notes.select(note.id);
            app.revealNotes();
          },
        },
      });
    }

    // Pinned first, then by score. Sorting by score alone would bury a pinned
    // note under a better-scoring one, which is the opposite of what pinning
    // was asked to do.
    scored.sort((a, b) => (a.pinned === b.pinned ? b.score - a.score : a.pinned ? -1 : 1));
    return { rows: scored.map((entry) => entry.row), total: scored.length };
  }

  /**
   * Local branches, "Create branch…" pinned first (the spec's §1 order).
   * The current branch is shown but inert — switching to where you stand
   * is a no-op git would also shrug at.
   */
  function branchRows(query: string): RowsResult {
    const current = app.git.status.get()?.branch ?? null;
    const rows: Row[] = [
      {
        key: 'create-branch',
        title: 'Create branch…',
        positions: [],
        icon: 'plus',
        accept: () => {
          ui.closeOverlay();
          void ui
            .askForText({
              title: 'Create Branch',
              initialValue: '',
              placeholder: 'branch name',
              confirmLabel: 'Create',
            })
            .then((name) => {
              // Validation is git's: check-ref-format runs before the write,
              // and its refusal arrives verbatim (envelope §4).
              if (name) void app.git.switch(name.trim(), true);
            });
        },
      },
    ];

    const scored: { row: Row; score: number }[] = [];
    for (const branch of branches ?? []) {
      const match = query.length === 0 ? { score: 0, positions: [] as number[] } : fuzzyMatch(query, branch);
      if (!match) continue;
      const isCurrent = branch === current;
      scored.push({
        score: match.score,
        row: {
          key: `branch:${branch}`,
          title: branch,
          positions: match.positions,
          icon: 'branch',
          ...(isCurrent ? { badge: 'current', disabled: true } : {}),
          accept: () => {
            ui.closeOverlay();
            if (!isCurrent) void app.git.switch(branch, false);
          },
        },
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return { rows: [...rows, ...scored.map((s) => s.row)], total: 1 + scored.length };
  }

  /**
   * Every task, the user's and the project's.
   *
   * A project task is badged as such *in the picker*, before it is chosen,
   * rather than only in the dialog `TaskService.run` raises afterwards. The
   * confirmation is the gate; this is so nobody meets the gate by surprise.
   */
  function taskRows(query: string): RowsResult {
    const scored: { row: Row; score: number }[] = [];
    for (const task of app.tasks.tasks.get()) {
      const match =
        query.length === 0 ? { score: 0, positions: [] as number[] } : fuzzyMatch(query, task.label);
      if (!match) continue;
      scored.push({
        score: match.score,
        row: {
          key: `task:${task.id}`,
          title: task.label,
          positions: match.positions,
          icon: 'play',
          detail: taskCommandLine(task),
          ...(task.source === 'project' ? { badge: 'project' } : {}),
          accept: () => {
            ui.closeOverlay();
            void commands.execute('tasks.run', task.id);
          },
        },
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return { rows: scored.map((entry) => entry.row), total: scored.length };
  }

  /** With an empty query, show recents first — that is what people want. */
  function recentFirst(): string[] {
    const recents = $recentFiles;
    const seen = new Set(recents);
    return [...recents, ...$fileIndex.filter((p) => !seen.has(p))].slice(0, 100);
  }

  function lineRows(query: string): RowsResult {
    const view = app.view.get();
    if (!view) return { rows: [], total: 0 };

    // Named to stay clear of the component-level `total` derived above.
    const totalLines = view.state.doc.lines;
    const [rawLine, rawColumn] = query.split(':');
    const line = Number.parseInt(rawLine ?? '', 10);
    const column = Number.parseInt(rawColumn ?? '', 10);

    if (!Number.isFinite(line)) {
      return {
        rows: [
          {
            key: 'goto-hint',
            title: `Current file has ${totalLines} lines`,
            positions: [],
            detail: 'Type a line number, optionally line:column',
            disabled: true,
            icon: 'info',
            accept: () => {},
          },
        ],
        total: 1,
      };
    }

    const clamped = Math.min(Math.max(1, line), totalLines);
    const preview = view.state.doc.line(clamped).text.trim().slice(0, 90);

    return {
      rows: [
        {
          key: 'goto',
          title: `Go to line ${clamped}${Number.isFinite(column) ? `, column ${column}` : ''}`,
          positions: [],
          icon: 'arrow-down',
          ...(preview ? { detail: preview } : {}),
          ...(line !== clamped ? { badge: `clamped from ${line}` } : {}),
          accept: () => {
            ui.closeOverlay();
            app.goToLine(clamped, Number.isFinite(column) ? column : 1);
          },
        },
      ],
      total: 1,
    };
  }

  /**
   * How long to spend parsing before listing what we have.
   *
   * The palette is a keystroke-latency surface, so this is a budget rather
   * than a wait. Past it the list is honest about being partial instead of
   * looking complete.
   */
  const PARSE_BUDGET_MS = 100;

  /** One word per kind, shown in the row's detail. */
  const KIND_LABEL: Record<SymbolKind, string> = {
    function: 'function',
    class: 'class',
    interface: 'interface',
    type: 'type',
    enum: 'enum',
    module: 'module',
    rule: 'rule',
    heading: 'heading',
  };

  /** A single disabled row, the shape `lineRows` uses to explain an empty list. */
  function hintRow(title: string, detail: string): RowsResult {
    return {
      rows: [
        { key: 'symbol-hint', title, positions: [], detail, disabled: true, icon: 'info', accept: () => {} },
      ],
      total: 1,
    };
  }

  function symbolRows(query: string): RowsResult {
    const view = app.view.get();
    // Settled before there is anything to parse or a language to ask about,
    // which is why it is the one state `symbolListState` does not name.
    if (!view) return hintRow('No file is open', 'Open a file to list its symbols');

    const buffer = workspace.active();

    // `syntaxTree` returns only what has been parsed so far, so on a large
    // file a plain read silently stops partway and the list *looks* complete.
    // `ensureSyntaxTree` forces the rest with a deadline and returns null when
    // it cannot finish in it. A language with no grammar, or one whose
    // grammar has not loaded, has no parser to spend that deadline on and
    // comes straight back.
    const tree = ensureSyntaxTree(view.state, view.state.doc.length, PARSE_BUDGET_MS);
    const symbols = symbolsFor(tree ?? syntaxTree(view.state), view.state.doc);

    // Which of the five things this list is saying — the branching lives in
    // `core/` where it can be tested, and the sentences live here, because
    // that is all this component is deciding. `hasGrammar(id) &&
    // !cachedLanguage(id)` is the same pairing that guards the reconfigure at
    // EditorPane.svelte:150.
    const state = symbolListState({
      language: buffer ? buffer.language.name : null,
      hasGrammar: buffer ? hasGrammar(buffer.language.id) : true,
      grammarLoaded: buffer ? cachedLanguage(buffer.language.id) !== null : true,
      structuredGrammar: buffer ? hasSymbolStructure(buffer.language.id) : true,
      parsed: tree !== null,
      count: symbols.length,
    });

    switch (state.kind) {
      case 'no-grammar':
        return hintRow(
          `Nox has no parser for ${state.language}`,
          'Symbols come from the grammar, the same one syntax highlighting uses',
        );
      case 'no-structure':
        return hintRow(
          `Nox cannot list symbols in ${state.language} yet`,
          'Its grammar colours the file but does not build the structure this reads',
        );
      case 'loading-grammar':
        return hintRow('Loading the grammar for this file', 'Reopen this list once it is ready');
      case 'still-parsing':
        return hintRow('Still parsing this file', 'More symbols may appear');
      case 'no-symbols':
        return hintRow(
          'No functions or classes in this file',
          'Only structure is listed, not variables',
        );
    }

    // No limit passed: `fuzzyFilter` sorts the full match set before any
    // slice regardless, and the pre-slice count is what makes the header
    // count honest when the 200-cap truncates a fully-parsed file.
    const matches = query
      ? fuzzyFilter(query, symbols, (s) => s.qualified)
      : symbols.map((item) => ({ item, score: 0, positions: [] as number[] }));
    const scored = matches.slice(0, 200);

    const built = scored.map(({ item, positions }) => {
      // The symbol's start, not the start of its line: §7 says accepting puts
      // the cursor on the symbol, and `goToLine` already takes the column.
      const line = view.state.doc.lineAt(item.from);
      return {
        key: `${item.from}:${item.qualified}`,
        title: item.qualified,
        positions,
        detail: KIND_LABEL[item.kind],
        icon: 'dot' as const,
        accept: () => {
          ui.closeOverlay();
          app.goToLine(line.number, item.from - line.from + 1);
        },
      };
    });

    const rows = state.partial
      ? [
          ...built,
          {
            key: 'symbol-partial',
            title: 'Still parsing this file',
            positions: [],
            detail: 'More symbols may appear',
            disabled: true,
            icon: 'info' as const,
            accept: () => {},
          },
        ]
      : built;
    // The appended "still parsing" hint counts on both sides so an uncapped
    // partial list still renders a plain count rather than "first N of N-1".
    return { rows, total: matches.length + (state.partial ? 1 : 0) };
  }

  /**
   * What to try next when nothing matched.
   *
   * "No matches" is a dead end, and a measured one: "zoom", "quit" and
   * "minimap" all return nothing, and every mode has an escape hatch the user
   * cannot be expected to have read off the footer legend. Naming the query
   * back also makes a stale or mistyped term obvious.
   */
  const emptyHint = $derived.by(() => {
    switch (effectiveMode) {
      case 'commands':
        return 'Try a shorter word, or ~ for an open file, : for a line, @ for a symbol.';
      case 'buffers':
        return 'Only files that are already open are listed — delete the ~ to search the whole folder.';
      case 'symbols':
        return 'Only structure is listed, not variables — delete the @ to search files instead.';
      case 'branches':
        return 'Choose "Create branch…" above to make one with that name.';
      case 'notes':
        return 'Titles only here — use the filter box in the Notes panel to search inside a note.';
      case 'actions':
        return 'No action here matches that.';
      case 'recent':
        return 'Only folders and files opened before are listed — try Go to File for the rest.';
      case 'tasks':
        return 'Tasks come from your own tasks.json, or the project\u2019s .nox/tasks.json.';
      case 'files':
        return 'Try part of the file name, or > for commands and ~ for an open file.';
      default:
        return '';
    }
  });

  function move(delta: number) {
    if (rows.length === 0) return;
    selected = (selected + delta + rows.length) % rows.length;
    queueMicrotask(() => {
      listElement?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
    });
  }

  function onKeydown(event: KeyboardEvent) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'PageDown':
        event.preventDefault();
        move(8);
        break;
      case 'PageUp':
        event.preventDefault();
        move(-8);
        break;
      case 'Enter': {
        event.preventDefault();
        const row = rows[selected];
        if (row && !row.disabled) row.accept();
        break;
      }
      case 'Tab':
        // Trap focus: the palette is modal, Tab must not escape it.
        event.preventDefault();
        move(event.shiftKey ? -1 : 1);
        break;
    }
  }
</script>

<div class="palette" role="dialog" aria-modal="true" aria-label={dialogLabel}>
  <div class="input-row">
    <Icon name={modeIcon} size={15} class="mode-icon" />
    <input
      bind:this={input}
      bind:value={text}
      onkeydown={onKeydown}
      type="text"
      {placeholder}
      spellcheck="false"
      autocomplete="off"
      aria-label={placeholder}
      aria-controls="nox-palette-list"
      aria-activedescendant={rows[selected] ? `nox-row-${selected}` : undefined}
    />
    {#if rows.length > 0 && effectiveMode !== 'line'}
      <!-- Honest about the display caps: a sliced list says so. The label
           carries the noun the visible number leaves out, and `status` makes
           it a polite live region so a screen reader hears the count change
           as the query narrows rather than a bare "158" once. -->
      <span
        class="result-count"
        role="status"
        aria-label={total === rows.length
          ? `${total} ${total === 1 ? 'result' : 'results'}`
          : `first ${rows.length} of ${total} results`}
      >
        {total === rows.length ? rows.length : `first ${rows.length} of ${total}`}
      </span>
    {/if}
  </div>

  <div class="results nox-scroll" id="nox-palette-list" role="listbox" bind:this={listElement}>
    {#each rows as row, index (row.key)}
      <div
        class="row"
        class:selected={index === selected}
        class:disabled={row.disabled}
        id="nox-row-{index}"
        title={row.tooltip}
        role="option"
        aria-selected={index === selected}
        tabindex="-1"
        onclick={() => !row.disabled && row.accept()}
        onmousemove={() => (selected = index)}
        onkeydown={() => {}}
      >
        <Icon name={row.icon} size={14} class="row-icon" />

        <span class="label">
          {#each segmentMatch(row.title, row.positions) as segment, i (i)}
            <span class:hit={segment.hit}>{segment.text}</span>
          {/each}
        </span>

        {#if row.keyword}
          <span class="keyword">{row.keyword}</span>
        {/if}

        {#if row.detail}
          <span class="detail">{row.detail}</span>
        {/if}

        {#if row.badge}
          <span class="badge">{row.badge}</span>
        {/if}

        {#if row.hint}
          <kbd class="nox-kbd hint">{row.hint}</kbd>
        {/if}
      </div>
    {:else}
      <p class="nox-empty">
        {#if effectiveMode === 'files' && $fileIndex.length === 0}
          No folder open — press {keymap.displayFor('file.openFolder') ?? '⇧⌘O'} to open one.
        {:else if term.length === 0}
          No matches
        {:else}
          <span class="empty-query">Nothing matches “{term}”</span>
          {#if emptyHint}
            <span class="empty-hint">{emptyHint}</span>
          {/if}
        {/if}
      </p>
    {/each}
  </div>

  <div class="footer">
    <span class="hint-group"><kbd class="nox-kbd">↑↓</kbd> navigate</span>
    <span class="hint-group"><kbd class="nox-kbd">↵</kbd> select</span>
    <span class="hint-group"><kbd class="nox-kbd">esc</kbd> dismiss</span>
    <span class="spacer"></span>
    <span class="hint-group prefix"><kbd class="nox-kbd">&gt;</kbd> commands</span>
    <span class="hint-group prefix"><kbd class="nox-kbd">~</kbd> switch file</span>
    <span class="hint-group prefix"><kbd class="nox-kbd">:</kbd> line</span>
    <span class="hint-group prefix"><kbd class="nox-kbd">@</kbd> symbol</span>
  </div>
</div>

<style>
  .palette {
    display: flex;
    flex-direction: column;
    width: min(660px, calc(100vw - 64px));
    max-height: min(60vh, 520px);
    background: var(--nox-bg-raised);
    border-radius: var(--nox-r-xl);
    box-shadow: var(--nox-shadow-lg);
    overflow: hidden;
  }

  .input-row {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-4);
    flex: none;
    padding: 0 var(--nox-sp-5);
    height: 46px;
    border-bottom: 1px solid var(--nox-border);
  }

  .input-row :global(.mode-icon) {
    color: var(--nox-accent);
    flex: none;
  }

  .input-row input {
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    outline: none;
    font-size: var(--nox-fs-lg);
    color: var(--nox-text-bright);
    user-select: text;
    letter-spacing: var(--nox-tracking-tight);
  }

  .input-row input::placeholder {
    color: var(--nox-text-muted);
  }

  .result-count {
    flex: none;
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-muted);
    font-variant-numeric: tabular-nums;
  }

  .results {
    flex: 1;
    padding: var(--nox-sp-2);
    min-height: 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-4);
    height: 30px;
    padding: 0 var(--nox-sp-4);
    border-radius: var(--nox-r-md);
    font-size: var(--nox-fs-md);
    color: var(--nox-text-muted);
    cursor: default;
    min-width: 0;
  }

  .row.selected {
    background: var(--nox-selected);
    color: var(--nox-text-bright);
  }

  .row.disabled {
    opacity: 0.42;
  }

  .row :global(.row-icon) {
    color: var(--nox-text-faint);
    flex: none;
  }

  .row.selected :global(.row-icon) {
    color: var(--nox-accent);
  }

  .label {
    flex: none;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .label .hit {
    color: var(--nox-accent);
    font-weight: var(--nox-fw-medium);
  }

  /* Why this row matched when the title shows no highlight: the keyword it
     hit. Same quiet register as the footer legend — informative, not loud. */
  .keyword {
    flex: none;
    font-size: var(--nox-fs-2xs);
    color: var(--nox-text-muted);
    border: 1px solid var(--nox-border);
    border-radius: var(--nox-r-full);
    padding: 0 var(--nox-sp-3);
    line-height: 15px;
    white-space: nowrap;
  }

  .detail {
    flex: 1;
    min-width: 0;
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }

  .badge {
    flex: none;
    font-size: var(--nox-fs-2xs);
    color: var(--nox-warning);
    text-transform: uppercase;
    letter-spacing: var(--nox-tracking-wide);
  }

  .hint {
    flex: none;
    margin-left: auto;
  }

  /* The selection wash changes the ground under the row, and muted text on
     it measures 3.34:1 over the palette's surface. This is the one row the
     keyboard user is reading, so its path and chord step up to body text:
     8.08:1, held by tests/token-contrast.test.ts. */
  .row.selected .hint,
  .row.selected .detail {
    color: var(--nox-text);
  }

  /* The query, quoted back, is the line that gets read first. */
  .empty-query {
    color: var(--nox-text-muted);
  }

  .empty-hint {
    max-width: 46ch;
    font-size: var(--nox-fs-xs);
    line-height: var(--nox-lh-ui);
  }

  .footer {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-5);
    flex: none;
    height: 28px;
    padding: 0 var(--nox-sp-5);
    border-top: 1px solid var(--nox-border);
    background: var(--nox-bg-base);
    font-size: var(--nox-fs-2xs);
    color: var(--nox-text-muted);
  }

  .hint-group {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
  }

  .spacer {
    flex: 1;
  }

  .prefix :global(.nox-kbd),
  .hint-group :global(.nox-kbd) {
    color: var(--nox-text-muted);
  }
</style>

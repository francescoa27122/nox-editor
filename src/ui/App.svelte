<script lang="ts">
  import { onMount } from 'svelte';
  import type { NoxApp } from '../app';
  import { provideApp } from './context';
  import TitleBar from './TitleBar.svelte';
  import Sidebar from './Sidebar.svelte';
  import EditorArea from './EditorArea.svelte';
  import StatusBar from './StatusBar.svelte';
  import AgentPanel from './AgentPanel.svelte';
  import TerminalPanel from './TerminalPanel.svelte';
  import DiffView from './DiffView.svelte';
  import ReviewPanel from './ReviewPanel.svelte';
  import TasksPanel from './TasksPanel.svelte';
  import Welcome from './Welcome.svelte';
  import Overlays from './Overlays.svelte';
  import Toasts from './Toasts.svelte';
  import DropZone from './DropZone.svelte';

  let { app }: { app: NoxApp } = $props();

  // `app` is a singleton created once at bootstrap and never replaced, so
  // reading it eagerly here is correct rather than a missed reactive read.
  // svelte-ignore state_referenced_locally
  provideApp(app);
  // svelte-ignore state_referenced_locally
  const { config, workspace } = app;

  const settings = config.settings;
  const buffers = workspace.buffers;

  let sidebarWidth = $state(config.get('workbench.explorerWidth'));
  let resizing = $state(false);

  // svelte-ignore state_referenced_locally
  const staged = app.review.staged;
  // svelte-ignore state_referenced_locally
  const reviewOpen = app.ui.reviewOpen;
  // svelte-ignore state_referenced_locally
  const agentsOpen = app.ui.agentsOpen;
  // svelte-ignore state_referenced_locally
  const diffOpen = app.ui.diffOpen;
  // svelte-ignore state_referenced_locally
  const tasksOpen = app.ui.tasksOpen;
  // svelte-ignore state_referenced_locally
  const welcomeOpen = app.ui.welcomeOpen;

  // svelte-ignore state_referenced_locally
  const overlay = app.ui.overlay;
  // svelte-ignore state_referenced_locally
  const prompt = app.ui.prompt;
  // svelte-ignore state_referenced_locally
  const confirm = app.ui.confirm;

  /**
   * Whether a modal is up, and therefore whether the app behind it is `inert`.
   *
   * **This is what makes `aria-modal="true"` true.** Five components declare
   * it and until 2026-08-31 only the palette handled `Tab`, so in the other
   * four a keyboard user tabbed straight out of the dialog into the title bar,
   * the sidebar and the editor behind the scrim, all of which stayed focusable
   * and stayed announced. `CONTRIBUTING.md` states "Overlays trap focus and
   * are dismissible with Esc" as a rule; Escape held and the trap did not.
   *
   * One attribute here rather than a `Tab` handler in each dialog, and the
   * reason is that `Overlays` is a **sibling** of `.nox-shell` rather than a
   * child. So marking the shell inert takes the whole app out of the tab order
   * and out of the accessibility tree at once, which is what a modal means,
   * and no future dialog has to remember to do anything.
   *
   * The condition is `Overlays`' own, deliberately: if the two ever disagree
   * the app would be either inert with nothing on top of it, or reachable
   * behind something claiming to be modal.
   */
  const modalOpen = $derived($overlay !== null || $prompt !== null || $confirm !== null);

  // svelte-ignore state_referenced_locally
  const terminalOpen = app.ui.terminalOpen;
  // Latches on first open. The panel hides itself thereafter rather than
  // unmounting, which is what preserves the scrollback.
  let terminalMounted = $state(false);
  $effect(() => {
    if ($terminalOpen) terminalMounted = true;
  });

  const showExplorer = $derived($settings['workbench.showExplorer']);
  const showStatusBar = $derived($settings['workbench.showStatusBar']);
  const hasBuffers = $derived($buffers.length > 0);

  onMount(() => {
    const detach = app.keymap.attach(window);

    // Persist work before the window goes away. `beforeunload` is the only
    // hook both a browser tab and a Tauri window close reliably give us.
    const beforeUnload = () => {
      void app.session.save();
      void app.config.flush();
      // A reload replaces this renderer, and the agent processes it started
      // would otherwise keep running with nobody listening.
      void app.platform.killAllAgents();
      // Shells too, for the same reason — and a shell left behind holds the
      // workspace directory open and keeps whatever it was running alive.
      void app.platform.closeAllTerminals();
    };
    window.addEventListener('beforeunload', beforeUnload);

    return () => {
      detach();
      window.removeEventListener('beforeunload', beforeUnload);
    };
  });

  function startResize(event: PointerEvent) {
    event.preventDefault();
    resizing = true;
    const startX = event.clientX;
    const startWidth = sidebarWidth;

    const move = (e: PointerEvent) => {
      sidebarWidth = Math.max(150, Math.min(520, startWidth + (e.clientX - startX)));
    };
    const up = () => {
      resizing = false;
      config.set('workbench.explorerWidth', sidebarWidth);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function resizeByKey(event: KeyboardEvent) {
    const step = event.shiftKey ? 32 : 8;
    if (event.key === 'ArrowLeft') sidebarWidth = Math.max(150, sidebarWidth - step);
    else if (event.key === 'ArrowRight') sidebarWidth = Math.min(520, sidebarWidth + step);
    else return;
    event.preventDefault();
    config.set('workbench.explorerWidth', sidebarWidth);
  }
</script>

<div class="nox-shell" class:is-resizing={resizing} inert={modalOpen}>
  <TitleBar />

  <div class="nox-body">
    {#if showExplorer}
      <div class="nox-sidebar-slot" style="width: {sidebarWidth}px">
        <Sidebar />
      </div>
      <!--
        A focusable splitter is exactly what `role="separator"` with a tabindex
        is specified for (WAI-ARIA window splitter pattern); the linter cannot
        tell it apart from a decorative rule.
      -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="nox-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize explorer"
        aria-valuenow={sidebarWidth}
        aria-valuemin={150}
        aria-valuemax={520}
        tabindex="0"
        onpointerdown={startResize}
        onkeydown={resizeByKey}
      ></div>
    {/if}

    <main class="nox-main">
      <!--
        A review takes over the editor area rather than sitting beside it: a
        diff needs the width, and deciding what to keep is not a thing you do
        out of the corner of your eye while typing somewhere else.
      -->
      <div class="nox-main-content">
        {#if $staged && $reviewOpen}
          <ReviewPanel />
        {:else if $agentsOpen}
          <AgentPanel />
        {:else if $diffOpen}
          <DiffView />
        {:else if $tasksOpen}
          <TasksPanel />
        {:else if hasBuffers && !$welcomeOpen}
          <EditorArea />
        {:else}
          <!--
            Both the empty state and a screen you can ask for. One element
            rather than two branches, because they render the same thing for
            the same reason — there is nothing to edit, either because no file
            is open or because you wanted the map instead.
          -->
          <Welcome />
        {/if}
      </div>

      <!--
        Mounted from the first time it is opened and never unmounted, so the
        scrollback survives hiding the panel. See TerminalPanel.
      -->
      {#if terminalMounted}
        <TerminalPanel />
      {/if}
    </main>
  </div>

  {#if showStatusBar}
    <StatusBar />
  {/if}
</div>

<Overlays />
<DropZone />
<Toasts />

<style>
  .nox-shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--nox-bg-base);
    /* One hairline of separation from the desktop behind the window. */
    box-shadow: inset 0 0 0 1px var(--nox-border);
  }

  .nox-body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .nox-sidebar-slot {
    flex: none;
    min-width: 0;
    display: flex;
  }

  .nox-resizer {
    flex: none;
    width: 1px;
    background: var(--nox-border);
    cursor: col-resize;
    position: relative;
    transition: background var(--nox-dur-fast) var(--nox-ease);
  }

  /* Widen the hit area well past the visible hairline. */
  .nox-resizer::after {
    content: '';
    position: absolute;
    inset: 0 -4px;
  }

  .nox-resizer:hover,
  .nox-resizer:focus-visible,
  .is-resizing .nox-resizer {
    background: var(--nox-accent-dim);
  }

  /*
    The splitter is a real tab stop with arrow-key resize, so it needs a focus
    indicator that is both visible and *not* the hover treatment — tinting the
    same 1px hairline told a keyboard user nothing they could tell apart from
    a stray pointer. The global ring is still suppressed because a box-shadow
    on a 1px column spreads outward over both neighbouring panes; painting the
    ::after instead keeps the indicator inside the gutter the splitter already
    reserves for its hit area, and 9px of --nox-accent-dim measures 5.10:1
    against the panel beside it.
  */
  .nox-resizer:focus-visible {
    box-shadow: none;
    outline: none;
  }

  .nox-resizer:focus-visible::after {
    background: var(--nox-accent-dim);
  }

  .nox-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--nox-bg-editor);
  }

  /* Takes the space the terminal is not using. */
  .nox-main-content {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* Kill text-selection flicker while dragging the divider. */
  .is-resizing {
    cursor: col-resize;
  }

  :global(.is-resizing *) {
    user-select: none !important;
  }
</style>

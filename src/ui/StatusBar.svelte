<script lang="ts">
  import { encodingLabel } from '@core/encoding';
  import { runnableAgents } from '@services/agent/config';
  import { hasGrammar } from '@editor/languages';
  import { useApp } from './context';
  import Icon from './Icon.svelte';
  import { activeLanguageStatus, serverStatusLabel, serverStatusTitle } from './lsp-status';

  const app = useApp();
  const { workspace, config, commands, files, jobs, review, ui, lsp, keymap, agentConfig, agents } =
    app;
  // A running total (A4-010), not `problemTotals($diagnostics)` re-walked on
  // every publish: `lsp.diagnosticsTotals` is kept in step with the map by
  // the delta each publish makes.
  const diagnosticsTotals = lsp.diagnosticsTotals;
  const pluginStatus = app.plugins.status.items;
  const problemCounts = $derived($diagnosticsTotals);

  /**
   * "Label (⌘⇧M)", or just the label when the command has no binding.
   *
   * Never an interpolated chord with literal parentheses around it:
   * `keybindings.json` supports `remove` rules, so every default binding in
   * the app is reachably unbound, and the hardcoded fallback produced tooltips
   * reading "Show Problems ()". The chord itself must come from the keymap for
   * the same reason this bar cannot spell ⌘⇧M itself — Nox ships Windows and
   * Linux builds, where `formatChord` renders `Ctrl+Shift+M`.
   */
  function withChord(label: string, commandId: string): string {
    const chord = keymap.displayFor(commandId);
    return chord ? `${label} (${chord})` : label;
  }

  const terminalOpen = ui.terminalOpen;
  const agentsOpen = ui.agentsOpen;
  const configuredAgents = agentConfig.agents;
  const providers = agents.providers;

  /**
   * The same availability test `Sidebar.svelte` and `NoxApp.#runnableAgents`
   * use, so the entry point and the thing it opens cannot disagree about
   * whether agents exist on this platform at all.
   */
  const agentsAvailable = $derived(
    runnableAgents($configuredAgents, {
      canSpawn: app.platform.capabilities.agentProcesses,
      providerIds: new Set($providers.map((provider) => provider.id)),
    }).length > 0,
  );

  const buffers = workspace.buffers;
  const activeId = workspace.activeId;
  const cursor = app.cursor;
  const settings = config.settings;
  const indexing = files.indexing;
  const activeJobs = jobs.active;
  const staged = review.staged;
  const reviewOpen = ui.reviewOpen;

  /** A review put away is easy to forget about; this is how it gets found. */
  const pendingReview = $derived($staged && !$reviewOpen ? review.acceptedCount() : null);

  /**
   * One job at a time. The status bar has room for a line, not a queue, and
   * showing the oldest keeps the label from flickering between concurrent
   * jobs — anything richer belongs in a panel, which nothing needs yet.
   */
  const job = $derived($activeJobs[0] ?? null);

  const jobLabel = $derived.by(() => {
    if (!job) return '';
    const { done, total } = job.progress;
    if (total) return `${job.title} · ${Math.round((done / total) * 100)}%`;
    return done > 0 ? `${job.title} · ${done}` : job.title;
  });

  const lspSessions = lsp.sessions;

  const active = $derived($buffers.find((b) => b.id === $activeId) ?? null);

  /**
   * The active buffer's language, not the aggregate. Without it the bar named
   * whichever server it found — leaving `typescript-language-server` on screen
   * beside an open `main.py`, in the one readout people take to mean "this is
   * what understands the file I am looking at".
   */
  const lspLabel = $derived(serverStatusLabel($lspSessions, active?.languageId ?? null));
  const lspFailed = $derived($lspSessions.some((session) => session.status === 'failed'));

  const languageStatus = $derived(
    active
      ? activeLanguageStatus(
          {
            id: active.languageId,
            name: active.languageName,
            hasGrammar: hasGrammar(active.languageId),
          },
          $lspSessions,
        )
      : null,
  );

  /**
   * What clicking the language item does. Never nothing, now.
   *
   * Falls back to the picker rather than replacing `commandId` with it: when
   * this file *should* have language intelligence and does not, the item
   * says so and offers the fix, and that behaviour is argued for at length in
   * `lsp-status.ts`. Changing the language is the obvious meaning of a
   * control labelled with a language, but it is the less urgent one, so it
   * takes the states the other does not claim. The tooltip distinguishes
   * them — "Markdown" against "Markdown — no language server configured".
   */
  const languageCommand = $derived(languageStatus?.commandId ?? 'lang.setLanguage');
  const languageTitle = $derived(languageStatus?.title ?? active?.languageName ?? '');
  const dirtyCount = $derived($buffers.filter((b) => b.isDirty).length);

  const indentLabel = $derived(
    $settings['editor.insertSpaces']
      ? `Spaces: ${$settings['editor.tabSize']}`
      : `Tabs: ${$settings['editor.tabSize']}`,
  );

  const selectionLabel = $derived.by(() => {
    const { selectionLength, selectionLines, cursors } = $cursor;
    if (cursors > 1) return `${cursors} cursors`;
    if (selectionLength === 0) return null;
    if (selectionLines > 1) return `${selectionLength} selected · ${selectionLines} lines`;
    return `${selectionLength} selected`;
  });
</script>

<footer class="nox-statusbar">
  <div class="side">
    <!--
      The terminal and the agent runtime are two of the headline desktop
      capabilities and neither had a single visible entry point: the terminal
      shipped a Hide button and no way back in, and `agents.show` was reachable
      only from the palette by someone who already knew its name.

      Both sit first on the bar rather than after the transient items, so the
      one always-present control on this side does not slide sideways every
      time a job starts or a file goes dirty.
    -->
    {#if app.platform.capabilities.terminals}
      <button
        class="item"
        class:on={$terminalOpen}
        aria-pressed={$terminalOpen}
        title={withChord($terminalOpen ? 'Hide Terminal' : 'Show Terminal', 'terminal.toggle')}
        onclick={() => void commands.execute('terminal.toggle')}
      >
        Terminal
      </button>
    {/if}

    {#if agentsAvailable}
      <!-- Not `aria-pressed`: `agents.show` opens the panel and never closes
           it, so this is a link to a place, not a switch. -->
      <button
        class="item"
        class:on={$agentsOpen}
        title={withChord('Show Agents', 'agents.show')}
        onclick={() => void commands.execute('agents.show')}
      >
        Agents
      </button>
    {/if}

    {#if pendingReview}
      <button
        class="item job"
        title="Go back to the review you left open"
        onclick={() => void commands.execute('review.show')}
      >
        <Icon name="file" size={11} />
        Review · {pendingReview.hunks}/{pendingReview.total}
      </button>
    {/if}

    {#if problemCounts.errors + problemCounts.warnings > 0}
      <button
        class="item problems"
        title={withChord('Show Problems', 'problems.focus')}
        onclick={() => void commands.execute('problems.focus')}
      >
        {#if problemCounts.errors > 0}
          <span class="problem-part error"><Icon name="error" size={10} />{problemCounts.errors}</span>
        {/if}
        {#if problemCounts.warnings > 0}
          <span class="problem-part warning"><Icon name="warning" size={10} />{problemCounts.warnings}</span>
        {/if}
      </button>
    {/if}

    {#if job && job.cancellable}
      <button
        class="item job"
        title={`${job.progress.message ?? job.title} — click to cancel`}
        onclick={() => jobs.cancel(job.id)}
      >
        <span class="pulse" aria-hidden="true"></span>
        <span class="job-label">{jobLabel}</span>
        <Icon name="close" size={10} />
      </button>
    {:else if job}
      <!-- Not cancellable (e.g. the update install): no click affordance,
           because clicking would show silence while it kept going anyway. -->
      <span class="item job" title={job.progress.message ?? job.title}>
        <span class="pulse" aria-hidden="true"></span>
        <span class="job-label">{jobLabel}</span>
      </span>
    {/if}

    {#if $indexing}
      <span class="item static">
        <span class="pulse" aria-hidden="true"></span>
        Indexing
      </span>
    {/if}

    {#if dirtyCount > 0}
      <!-- Reads like the readouts beside it but writes every dirty buffer to
           disk, so the label has to say so before the click, not after: the
           natural reading of "3 unsaved" is "show me which". -->
      <button
        class="item"
        title={withChord(
          `Save all ${dirtyCount} unsaved ${dirtyCount === 1 ? 'file' : 'files'}`,
          'file.saveAll',
        )}
        aria-label={`Save all ${dirtyCount} unsaved ${dirtyCount === 1 ? 'file' : 'files'}`}
        onclick={() => void commands.execute('file.saveAll')}
      >
        <Icon name="dot" size={9} />
        {dirtyCount} unsaved
      </button>
    {/if}

    {#if active && active.externalState !== 'none'}
      <button
        class="item"
        class:warn={active.externalState === 'modified'}
        class:danger={active.externalState === 'deleted'}
        title="Reload this file from disk"
        onclick={() => void commands.execute('file.revert')}
      >
        <Icon name={active.externalState === 'deleted' ? 'error' : 'warning'} size={11} />
        {active.externalState === 'deleted' ? 'Deleted on disk' : 'Changed on disk'}
      </button>
    {/if}

    <!--
      Plugin items, last on this side.

      Last because everything above is Nox's own and must not move when a
      plugin appears: the row is shared, and a plugin that arrives mid-session
      should not slide the Save-all button out from under the pointer. A plugin
      may own three of these at most, each capped in length — see
      `services/plugin/status.ts`, where the reason is that this bar cannot
      scroll.
    -->
    {#each $pluginStatus as item (item.id)}
      {#if item.command}
        <button
          class="item plugin"
          title={item.tooltip ?? item.text}
          onclick={() => void commands.execute(item.command ?? '')}
        >
          {item.text}
        </button>
      {:else}
        <span class="item static plugin" title={item.tooltip ?? item.text}>{item.text}</span>
      {/if}
    {/each}
  </div>

  <div class="side right">
    {#if lspLabel}
      <button
        class="item"
        class:warn={lspFailed}
        title={serverStatusTitle($lspSessions)}
        onclick={() => void commands.execute('lsp.reload')}
      >
        {lspLabel}
      </button>
    {/if}

    {#if selectionLabel}
      <span class="item static accent">{selectionLabel}</span>
    {/if}

    {#if active}
      <button
        class="item"
        title="Go to Line"
        onclick={() => void commands.execute('nav.goToLine')}
      >
        Ln {$cursor.line} : Col {$cursor.column}
      </button>

      <!-- Through the registry, not `config.set`: a click here is the same
           action as the palette's "Toggle Tabs and Spaces", and a chrome
           control that bypasses the command table is an action nobody can
           find, bind or teach the palette's recency ranking about. -->
      <button
        class="item"
        title={withChord('Toggle Tabs and Spaces', 'view.toggleIndentType')}
        onclick={() => void commands.execute('view.toggleIndentType')}
      >
        {indentLabel}
      </button>

      <!-- A button now, not a label: this is the way out of the refusal when
           a file is not UTF-8, and the slot was already sitting here. -->
      <button
        class="item"
        title={withChord('Reopen with a different encoding', 'file.reopenWithEncoding')}
        onclick={() => void commands.execute('file.reopenWithEncoding')}
      >
        {encodingLabel(active.encoding)}
      </button>

      <button
        class="item"
        title={withChord(
          "Switch line endings — what a save writes at each line's end",
          'file.toggleLineEnding',
        )}
        onclick={() => void commands.execute('file.toggleLineEnding')}
      >
        {active.eol === '\r\n' ? 'CRLF' : 'LF'}
      </button>

      <!-- Why a squiggle, a gutter mark or a fresh backup is missing on this
           file. Without it the mode is indistinguishable from the editor
           being broken, which is the whole reason it is on screen.

           Static rather than a button, unlike its neighbours: there is no
           action to offer. The mode follows from the file's size, it is not a
           setting, and the way out of it is a smaller file. A control that
           looked live and did nothing is the defect the language item below
           was fixed for. -->
      {#if active.isLarge}
        <span
          class="item static"
          title="Large file: no language server, no gutter diff, and unsaved work backed up less often"
        >
          Large file
        </span>
      {/if}

      <!--
        One control, two facts: whether a grammar is installed and whether a
        language server is. Both are "something this file could have and does
        not", and the grammar half already said so here — a second control for
        the server half would have split one question across two places.

        Always a button now. It used to be one only when there was somewhere
        to go, which left it inert in the common case — the single dead item
        in a row of live ones, labelled with a language and refusing to let
        you change it. Changing the language *is* somewhere to go, and it is
        the obvious reading of a control that names one, so it takes every
        state `lsp.configure` does not claim. A missing grammar is no longer a
        dead end either: picking a language you do have one for is a real
        answer to it.

        The button keeps `.muted` — faint is how this bar says "not
        installed", and the audit's worry about inert and clickable items
        looking alike is answered by the hover response rather than the
        resting colour: `button.item:hover` outranks `.item.muted`, so this
        one lights up and takes a ground where `.item.static` does neither.
      -->
      <button
        class="item"
        class:muted={languageStatus?.tone === 'muted'}
        class:warn={languageStatus?.tone === 'warn'}
        title={languageTitle}
        onclick={() => void commands.execute(languageCommand)}
      >
        {active.languageName}
      </button>

      <!--
        Inside `{#if active}`: wrap is a property of the buffer on screen, and
        outside it this button was the *only* item left when a pane was empty —
        a lone "Wrap" adrift in the far corner of an otherwise blank bar.
      -->
      <button
        class="item"
        title={withChord('Toggle word wrap', 'view.toggleWordWrap')}
        class:on={$settings['editor.wordWrap']}
        aria-pressed={$settings['editor.wordWrap']}
        onclick={() => void commands.execute('view.toggleWordWrap')}
      >
        Wrap
      </button>
    {/if}

  </div>
</footer>

<style>
  .nox-statusbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: var(--nox-statusbar-h);
    flex: none;
    padding: 0 var(--nox-sp-3);
    background: var(--nox-bg-base);
    border-top: 1px solid var(--nox-border);
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-muted);
    font-variant-numeric: tabular-nums;
  }

  .side {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-1);
    min-width: 0;
  }

  .item {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
    height: 18px;
    padding: 0 var(--nox-sp-3);
    border-radius: var(--nox-r-sm);
    color: inherit;
    white-space: nowrap;
    transition:
      background var(--nox-dur-fast) var(--nox-ease),
      color var(--nox-dur-fast) var(--nox-ease);
  }

  /*
     Plugin items read as Nox's own except for this: a plugin should not be
     able to pass its readout off as the editor's, and a leading mark is the
     smallest thing that says whose it is without a second row of chrome.
  */
  .item.plugin::before {
    /* Written as a CSS escape rather than the character. The bullet shipped
       once as U+0082 followed by a literal "2", which is what `\2022` becomes
       when a tool reads `\202` as an octal escape, and the control byte was
       invisible in every diff. A CSS escape survives that round trip. */
    content: '\2022';
    color: var(--nox-accent-dim);
    font-size: var(--nox-fs-2xs);
  }

  button.item:hover {
    background: var(--nox-hover);
    color: var(--nox-text-bright);
  }

  .item.static {
    cursor: default;
    /* Visibly not a control: the audit found clickable and inert items
       identical, discoverable only by accidental hover. */
    color: var(--nox-text-muted);
  }

  .item.static:hover {
    background: none;
  }

  .problem-part {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  .problem-part.error :global(svg) {
    color: var(--nox-danger);
  }

  .problem-part.warning :global(svg) {
    color: var(--nox-warning);
  }

  .item.muted {
    color: var(--nox-text-muted);
  }

  .item.accent {
    color: var(--nox-accent);
  }

  .item.warn {
    color: var(--nox-warning);
  }

  .item.danger {
    color: var(--nox-danger);
  }

  /* A ground as well as a colour. Accent-on-default was the only signal that
     wrap was on, which WCAG 1.4.1 rules out and which nothing distinguishes
     for anyone who cannot tell the two greys apart. Matches the sidebar
     rail's `.rail-button.active`, which already did this correctly. */
  .item.on {
    color: var(--nox-accent);
    background: var(--nox-active);
  }

  .item.job {
    color: var(--nox-accent);
  }

  /*
   * The label is the only thing here that varies in width, and a long file
   * path would otherwise push everything else along the bar as the walk
   * moves through the project.
   */
  .job-label {
    max-width: 22ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item.job :global(svg) {
    opacity: 0.55;
  }

  .item.job:hover :global(svg) {
    opacity: 1;
  }

  .pulse {
    width: 6px;
    height: 6px;
    border-radius: var(--nox-r-full);
    background: var(--nox-accent);
    /* Token-driven so prefers-reduced-motion (which zeroes the token) stops
       the one infinite animation in the app for the users who asked. */
    animation: nox-pulse var(--nox-dur-pulse) var(--nox-ease) infinite;
  }

  @keyframes nox-pulse {
    0%,
    100% {
      opacity: 0.25;
    }
    50% {
      opacity: 1;
    }
  }
</style>

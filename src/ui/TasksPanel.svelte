<script lang="ts">
  import { taskCommandLine, type Task } from '@core/tasks';
  import { useApp } from './context';
  import PanelEmpty from './PanelEmpty.svelte';

  /**
   * The project's commands, and what the last run of each one printed.
   *
   * Renders state and forwards input. Every decision it looks like it makes is
   * a service's: whether a task may run at all is `TaskService.run`, which asks
   * the user when the repository named the task, and stopping one is the job
   * runner's cancellation rather than anything here.
   *
   * Output is not virtualised. The service caps a run at `MAX_OUTPUT_LINES`
   * (5,000), which is the same order as the Problems and References panels
   * that are also unwindowed. See the Known debt table's row for those two.
   */

  const app = useApp();
  const { tasks, ui, commands, platform } = app;

  /**
   * Whether this build can start a process at all.
   *
   * Read here as well as in the command's `enabled`, so the button and what
   * running the command would actually do cannot disagree. `AgentPanel` makes
   * the same argument for the same reason. Without it the browser target drew
   * a working-looking Run button that did nothing at all when clicked, because
   * `CommandRegistry.execute` returns false for a disabled command in silence.
   */
  const canRun = platform.capabilities.agentProcesses;

  const list = tasks.tasks;
  const shadowed = tasks.shadowed;
  const runs = tasks.runs;
  const running = tasks.running;
  const trusted = tasks.trusted;
  const error = tasks.error;

  /**
   * Which task's output is on screen.
   *
   * Local rather than a service signal: it is which row you clicked, and no
   * command needs to drive it. Null means "whatever ran last", which is what
   * someone who just hit the chord is looking for.
   */
  let selectedId = $state<string | null>(null);

  const selected = $derived.by(() => {
    const id = selectedId ?? [...$running][0] ?? tasks.lastTaskId.get();
    if (id && $list.some((task) => task.id === id)) return id;
    return $list[0]?.id ?? null;
  });
  const run = $derived(selected ? ($runs.get(selected) ?? null) : null);
  const task = $derived($list.find((entry) => entry.id === selected) ?? null);

  function statusOf(id: string): string {
    if ($running.has(id)) return 'running';
    return $runs.get(id)?.status ?? '';
  }

  /**
   * How a finished run should read: passed, failed, or neither.
   *
   * `status` alone cannot answer it. A process that ran to completion is
   * `exited` whatever it exited *with*, and `failed` means only that it could
   * never be started, so `npm test` returning 1 looked exactly like `npm test`
   * returning 0 until this existed. For a panel whose whole job is running
   * builds, that is the one question it has to answer at a glance.
   */
  function toneOf(id: string): string {
    const run = $runs.get(id);
    if (!run || $running.has(id)) return '';
    if (run.status === 'failed' || run.status === 'cancelled') return 'bad';
    if (run.exitCode === null) return '';
    return run.exitCode === 0 ? 'ok' : 'bad';
  }

  /** Whether this task would ask before running. The service owns the answer. */
  function asks(entry: Task): boolean {
    void $trusted; // Re-read when an approval is given or forgotten.
    return tasks.willAsk(entry);
  }
</script>

<section class="tasks" aria-label="Tasks">
  <header>
    <div class="heading">
      <h2>Tasks</h2>
      <p>{$list.length} defined{$running.size > 0 ? ` · ${$running.size} running` : ''}</p>
    </div>
    <div class="actions">
      {#if $trusted.size > 0}
        <!--
          A grant you cannot see is a grant you cannot withdraw. The spec said
          the panel listed what was approved and it did not: a trusted task was
          indistinguishable from one that never asks. Shaped after the agents
          panel's revoke button, where the count is the disclosure.
        -->
        <button
          class="nox-button small"
          onclick={() => void commands.execute('tasks.forgetTrust')}
          title="Project tasks will ask again before they run"
        >
          Forget {$trusted.size} approved
        </button>
      {/if}
      <button
        class="nox-button small"
        disabled={$running.size === 0}
        onclick={() => void commands.execute('tasks.stop')}
        title="Stop every running task"
      >
        Stop All
      </button>
      <button class="nox-button small" onclick={() => void commands.execute('tasks.edit')}>
        Edit Tasks
      </button>
      <button
        class="nox-button ghost small"
        onclick={() => ui.tasksOpen.set(false)}
        title="Back to the editor (Esc)"
      >
        Close
      </button>
    </div>
  </header>

  {#if !canRun}
    <p class="problem note">
      This build cannot start a process, so nothing here can run. The desktop
      build can.
    </p>
  {/if}

  {#if $error}
    <p class="problem" role="status">{$error}</p>
  {/if}

  {#if $list.length === 0}
    <PanelEmpty action={{ label: 'Edit Tasks', run: () => void commands.execute('tasks.edit') }}>
      No tasks yet. They come from your own <code>tasks.json</code>, or from a
      <code>.nox/tasks.json</code> in the project.
    </PanelEmpty>
  {:else}
    <div class="body">
      <ul class="list">
        {#each $list as entry (entry.id)}
          <li>
            <button
              class="row"
              class:selected={entry.id === selected}
              aria-current={entry.id === selected}
              title={canRun ? 'Double-click to run' : undefined}
              onclick={() => (selectedId = entry.id)}
              ondblclick={() => canRun && void commands.execute('tasks.run', entry.id)}
            >
              <span class="label">{entry.label}</span>
              <span class="cmdline">{taskCommandLine(entry)}</span>
              <span class="tags">
                {#if entry.source === 'project'}
                  <!-- Named on the row rather than only in the dialog, so the
                       provenance is visible before anyone reaches for it. -->
                  <span class="tag project" title="Defined by the repository">project</span>
                {/if}
                {#if asks(entry)}
                  <span class="tag" title="Will ask before running">asks</span>
                {/if}
                {#if statusOf(entry.id)}
                  <span class="tag status {statusOf(entry.id)} {toneOf(entry.id)}"
                    >{statusOf(entry.id)}</span
                  >
                {/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>

      <div class="output">
        {#if task}
          <div class="output-head">
            <code>{taskCommandLine(task)}</code>
            <button
              class="nox-button small"
              disabled={!canRun || $running.has(task.id)}
              title={canRun ? undefined : 'This build cannot start a process'}
              onclick={() => void commands.execute('tasks.run', task.id)}
            >
              Run
            </button>
          </div>
        {/if}
        {#if run}
          {#if run.error}
            <p class="problem">{run.error}</p>
          {/if}
          <div class="lines">
            {#each run.output as entry, index (index)}
              <div class="line" class:stderr={entry.stream === 'stderr'}>{entry.text}</div>
            {/each}
          </div>
          {#if run.status !== 'running'}
            <p class="exit {toneOf(run.taskId)}">
              {run.status}{run.exitCode === null ? '' : ` · exit ${run.exitCode}`}
            </p>
          {/if}
        {:else}
          <p class="idle">Not run yet.</p>
        {/if}
      </div>
    </div>
  {/if}

  {#if $shadowed.length > 0}
    <!--
      Shadowed project tasks are said out loud rather than dropped silently.
      A repository must not be able to take the name of a task you already
      trusted, and finding out by watching your own task stop running is the
      worst way to learn it.
    -->
    <p class="shadowed" role="status">
      Hidden by tasks of your own, from the project's file:
      {$shadowed.map((entry) => entry.id).join(', ')}
    </p>
  {/if}
</section>

<style>
  .tasks {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--nox-bg-editor);
  }

  header {
    display: flex;
    align-items: flex-start;
    gap: var(--nox-sp-4);
    padding: var(--nox-sp-4) var(--nox-sp-5) var(--nox-sp-3);
  }

  h2 {
    font-size: var(--nox-fs-md);
    margin: 0 0 2px;
  }

  .heading p {
    margin: 0;
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-muted);
  }

  .actions {
    display: flex;
    gap: var(--nox-sp-2);
    margin-left: auto;
    flex: none;
  }

  .problem,
  .shadowed {
    margin: 0;
    padding: var(--nox-sp-2) var(--nox-sp-5);
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-muted);
  }

  .problem {
    color: var(--nox-danger-bright);
  }

  .body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(180px, 260px) 1fr;
    gap: var(--nox-sp-4);
    padding: 0 var(--nox-sp-5) var(--nox-sp-4);
    overflow: hidden;
  }

  .list {
    margin: 0;
    /* Room for the focus ring, which `--nox-focus-ring` draws 3px *outside*
       the row's border box. With the row flush to a scrolling container's
       content box, the ring's left and right edges were clipped away on the
       panel's primary keyboard target. */
    padding: 0 3px;
    list-style: none;
    overflow-y: auto;
    min-height: 0;
  }

  .row {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: var(--nox-r-sm);
    padding: var(--nox-sp-2) var(--nox-sp-3);
    color: inherit;
    font: inherit;
    cursor: default;
  }

  .row:hover {
    background: var(--nox-hover);
  }

  .row.selected {
    background: var(--nox-selected);
  }

  .label {
    display: block;
    font-size: var(--nox-fs-sm);
  }

  /*
    `.cmdline`, not `.line`. Both names existed in this block at equal
    specificity, the output line's `white-space: pre-wrap` came second and won,
    and this rule's `nowrap` plus `text-overflow` were dead: a long command
    wrapped and broke mid-word instead of eliding, giving the list ragged row
    heights. Two rules, one selector, in one file, is not visible by eye.
  */
  .cmdline {
    display: block;
    font-family: var(--nox-font-mono);
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tags {
    display: flex;
    gap: var(--nox-sp-2);
    margin-top: 2px;
  }

  .tag {
    font-size: var(--nox-fs-2xs);
    color: var(--nox-text-muted);
    border: 1px solid var(--nox-border-subtle);
    border-radius: var(--nox-r-sm);
    padding: 0 4px;
  }

  .tag.project {
    border-color: var(--nox-border-accent);
  }

  .tag.status.running {
    color: var(--nox-accent);
  }

  /*
    Keyed on the exit code, not on the status word. `exited` covers a build
    that passed and one that failed, which is the distinction this panel exists
    to show. DESIGN.md §2 allows semantic colour in a status context.
  */
  .tag.status.ok {
    color: var(--nox-success);
    border-color: var(--nox-success);
  }

  .tag.status.bad {
    color: var(--nox-danger-bright);
    border-color: var(--nox-danger-bright);
  }

  .output {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }

  .output-head {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-3);
    padding-bottom: var(--nox-sp-2);
  }

  .output-head code {
    font-family: var(--nox-font-mono);
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .output-head button {
    margin-left: auto;
    flex: none;
  }

  .lines {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: var(--nox-sp-3);
    background: var(--nox-bg-inset);
    /* Umbra sets `bg-inset` and `bg-editor` to the same black, so without an
       edge the output well is invisible against the panel behind it. */
    border: 1px solid var(--nox-border-subtle);
    border-radius: var(--nox-r-md);
    font-family: var(--nox-font-mono);
    font-size: var(--nox-fs-xs);
    line-height: var(--nox-lh-tight);
  }

  /* One element per line, so a break is a block boundary rather than a
     newline in the text. `pre-wrap` keeps a compiler's own indentation, which
     is most of what makes its output readable. */
  .line {
    white-space: pre-wrap;
    word-break: break-word;
  }

  .stderr {
    color: var(--nox-danger-bright);
  }

  .exit,
  .idle {
    margin: var(--nox-sp-2) 0 0;
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-muted);
  }

  .exit.ok {
    color: var(--nox-success);
  }

  .exit.bad {
    color: var(--nox-danger-bright);
  }

  .note {
    color: var(--nox-text-muted);
  }

  /* Matches AgentPanel and SettingsPanel, which set the same two properties
     for prose code. Without it this fell back to the UA's own monospace. */
  .tasks :global(code) {
    font-family: var(--nox-font-mono);
    /* One step under the prose around it, which is `--nox-fs-sm`. */
    font-size: var(--nox-fs-xs);
  }
</style>

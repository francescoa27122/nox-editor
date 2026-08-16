<script lang="ts">
  import { relative } from '@core/path';
  import { authorLabel } from '@services/transactions';
  import { useApp } from './context';
  import Icon from './Icon.svelte';

  /**
   * Hunk-level review of a staged change set.
   *
   * Takes over the editor area rather than sitting in the sidebar: a diff
   * needs width, and reviewing a change is not something you do out of the
   * corner of your eye while editing something else.
   *
   * Nothing here mutates a buffer. Every control drives `ReviewService`, and
   * the only thing that writes is Apply, through the same `workspace.apply`
   * every other change goes through.
   */

  const app = useApp();
  const { review, workspace, ui } = app;

  const staged = review.staged;
  const rootPath = workspace.rootPath;

  const counts = $derived.by(() => {
    void $staged;
    return review.acceptedCount();
  });

  const allAccepted = $derived(counts.hunks === counts.total && counts.total > 0);

  function folderFor(path: string | null): string {
    if (!path) return 'untitled';
    const root = $rootPath;
    return root && path.startsWith(root) ? relative(root, path) : path;
  }

  /** Trailing newlines are part of the line data; they are not part of reading it. */
  const display = (line: string) => line.replace(/\n$/, '');

</script>

{#if $staged}
  <section class="review" aria-label="Review changes">
    <header>
      <div class="heading">
        <h2>{$staged.description}</h2>
        <p>
          Proposed by {authorLabel($staged.author)} ·
          {counts.hunks} of {counts.total} kept
        </p>
      </div>

      <div class="actions">
        <button class="ghost" onclick={() => review.setAllAccepted(!allAccepted)}>
          {allAccepted ? 'Reject all' : 'Keep all'}
        </button>
        <button class="ghost" onclick={() => ui.reviewOpen.set(false)} title="Keep the review and go back to the editor (Esc)">
          Close
        </button>
        <button class="ghost" onclick={() => review.discard()}>Discard</button>
        <button class="primary" disabled={counts.hunks === 0} onclick={() => app.applyReview()}>
          Apply {counts.hunks > 0 ? counts.hunks : ''}
        </button>
      </div>
    </header>

    <div class="files nox-scroll">
      {#each $staged.files as file (file.bufferId)}
        {@const kept = file.hunks.filter((hunk) => hunk.accepted).length}
        <article>
          <div class="file-head">
            <Icon name="file" size={13} />
            <span class="name">{file.name}</span>
            <span class="folder">{folderFor(file.path)}</span>
            <span class="spacer"></span>
            <span class="tally">{kept}/{file.hunks.length}</span>
            <button
              class="ghost small"
              onclick={() => review.setFileAccepted(file.bufferId, kept !== file.hunks.length)}
            >
              {kept === file.hunks.length ? 'Reject file' : 'Keep file'}
            </button>
          </div>

          {#each file.hunks as hunk (hunk.id)}
            <div class="hunk" class:rejected={!hunk.accepted}>
              <button
                class="toggle"
                aria-pressed={hunk.accepted}
                title={hunk.accepted ? 'Reject this change' : 'Keep this change'}
                onclick={() => review.toggleHunk(file.bufferId, hunk.id)}
              >
                <Icon name={hunk.accepted ? 'check' : 'close'} size={11} />
                <span>Line {hunk.displayLine}</span>
              </button>
              {#if !hunk.inScope}
                <span class="scope-note">outside your selection</span>
              {/if}

              <div class="lines">
                {#each hunk.removed as line, index (index)}
                  <div class="line removed"><span class="sign">−</span>{display(line)}</div>
                {/each}
                {#each hunk.added as line, index (index)}
                  <div class="line added"><span class="sign">+</span>{display(line)}</div>
                {/each}
              </div>
            </div>
          {/each}
        </article>
      {/each}
    </div>
  </section>
{/if}

<style>
  .review {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--nox-bg-editor);
  }

  header {
    display: flex;
    align-items: flex-start;
    gap: var(--nox-sp-4);
    padding: var(--nox-sp-4) var(--nox-sp-5);
    border-bottom: 1px solid var(--nox-border-subtle);
  }

  .heading {
    min-width: 0;
  }

  h2 {
    margin: 0;
    font-size: var(--nox-fs-md);
    font-weight: 600;
    color: var(--nox-text-bright);
  }

  header p {
    margin: var(--nox-sp-1) 0 0;
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-faint);
  }

  .actions {
    display: flex;
    gap: var(--nox-sp-2);
    margin-left: auto;
    flex-shrink: 0;
  }

  button {
    font: inherit;
    font-size: var(--nox-fs-xs);
    padding: var(--nox-sp-2) var(--nox-sp-3);
    border-radius: var(--nox-r-sm);
    border: 1px solid var(--nox-border);
    background: var(--nox-bg-raised);
    color: var(--nox-text);
    cursor: pointer;
    transition: background var(--nox-dur-fast) var(--nox-ease);
  }

  button:hover:not(:disabled) {
    background: var(--nox-bg-hover);
    color: var(--nox-text-bright);
  }

  button.primary {
    background: var(--nox-accent);
    border-color: var(--nox-accent);
    color: var(--nox-bg-base);
    font-weight: 600;
  }

  button.primary:disabled {
    opacity: 0.4;
    cursor: default;
  }

  button.small {
    padding: 2px var(--nox-sp-2);
  }

  .files {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: var(--nox-sp-4) var(--nox-sp-5) var(--nox-sp-6);
  }

  article {
    margin-bottom: var(--nox-sp-5);
  }

  .file-head {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
    padding-bottom: var(--nox-sp-2);
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-muted);
  }

  .name {
    color: var(--nox-text-bright);
    font-weight: 600;
  }

  .folder {
    color: var(--nox-text-faint);
  }

  .spacer {
    flex: 1;
  }

  .tally {
    color: var(--nox-text-faint);
    font-variant-numeric: tabular-nums;
  }

  .hunk {
    border: 1px solid var(--nox-border-subtle);
    border-radius: var(--nox-r-md);
    overflow: hidden;
    margin-bottom: var(--nox-sp-3);
    transition: opacity var(--nox-dur-fast) var(--nox-ease);
  }

  /* A rejected hunk stays legible — you may be about to change your mind. */
  .hunk.rejected {
    opacity: 0.4;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
    width: 100%;
    border: 0;
    border-radius: 0;
    background: var(--nox-bg-raised);
    color: var(--nox-text-muted);
    font-size: var(--nox-fs-xs);
    padding: var(--nox-sp-2) var(--nox-sp-3);
    text-align: left;
  }

  .toggle[aria-pressed='true'] {
    color: var(--nox-success);
  }

  .scope-note {
    color: var(--nox-text-faint);
    font-size: var(--nox-fs-xs);
    margin-left: var(--nox-sp-2);
  }

  .lines {
    font-family: var(--nox-font-mono);
    font-size: var(--nox-fs-sm);
    line-height: 1.6;
    overflow-x: auto;
  }

  .line {
    padding: 0 var(--nox-sp-3);
    white-space: pre;
  }

  .sign {
    display: inline-block;
    width: 1.2em;
    opacity: 0.6;
  }

  .line.removed {
    background: color-mix(in srgb, var(--nox-danger) 12%, transparent);
    color: var(--nox-text);
  }

  .line.added {
    background: color-mix(in srgb, var(--nox-success) 12%, transparent);
    color: var(--nox-text);
  }
</style>

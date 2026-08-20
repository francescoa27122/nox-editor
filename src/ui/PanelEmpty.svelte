<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * The one empty state.
   *
   * Eight panels each carried a local `.empty` — differently padded,
   * differently toned, and only one of them actionable. This is the shared
   * shape: quiet prose, and when there is a one-click way out of the empty
   * state, a button for it — "run X from the palette" is three keystrokes
   * and a fuzzy search; a button is one click.
   */

  interface Props {
    /** The message. Keep it to a sentence or two; honesty over cheer. */
    children: Snippet;
    /** A one-click way out, when one exists. */
    action?: { label: string; run: () => void };
  }

  let { children, action }: Props = $props();
</script>

<div class="panel-empty">
  <p>{@render children()}</p>
  {#if action}
    <button class="nox-button small" onclick={action.run}>{action.label}</button>
  {/if}
</div>

<style>
  .panel-empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--nox-sp-4);
    padding: var(--nox-sp-4) var(--nox-sp-5);
  }

  p {
    margin: 0;
    font-size: var(--nox-fs-sm);
    line-height: 1.5;
    color: var(--nox-text-muted);
    max-width: 60ch;
  }

  p :global(strong) {
    color: var(--nox-text);
    font-weight: var(--nox-fw-medium);
  }
</style>

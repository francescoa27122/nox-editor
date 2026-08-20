<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * The one sidebar panel header.
   *
   * Before this existed there were three header idioms across the panels —
   * `<h2>` vs `<span>` vs nothing, three title sizes where DESIGN.md §4
   * names one, summaries right-aligned or subtitled or absent. This is the
   * DESIGN.md shape, once: 10px uppercase wide-tracked title in a real
   * heading element (so every panel is a landmark), an optional summary on
   * the right, an optional actions slot after it.
   */

  interface Props {
    title: string;
    /** Right-aligned quiet text: a count, a state, a subject. */
    summary?: string;
    /** Buttons after the summary. Compose with .nox-button.ghost.small. */
    actions?: Snippet;
    children?: Snippet;
  }

  let { title, summary, actions, children }: Props = $props();
</script>

<header class="panel-header">
  <h2>{title}</h2>
  {#if children}{@render children()}{/if}
  {#if summary}<span class="summary">{summary}</span>{/if}
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
</header>

<style>
  .panel-header {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-4);
    height: var(--nox-panelbar-h);
    padding: 0 var(--nox-sp-5);
    border-bottom: 1px solid var(--nox-border);
    flex: none;
    min-width: 0;
  }

  h2 {
    font-size: var(--nox-fs-2xs);
    font-weight: var(--nox-fw-semibold);
    text-transform: uppercase;
    letter-spacing: var(--nox-tracking-wide);
    color: var(--nox-text-muted);
    margin: 0;
    flex: none;
  }

  .summary {
    margin-left: auto;
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-1);
    flex: none;
  }

  /* When there is no summary, actions still sit at the right edge. */
  .actions:first-of-type {
    margin-left: auto;
  }

  .summary + .actions {
    margin-left: 0;
  }
</style>

<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * A labelled grid for stories that show a whole set at once.
   *
   * A story file *can* carry its own styles, so this is not a workaround —
   * it is here because every set-at-a-glance story wants the same grid, and
   * one component is where that shape stays consistent as more are added.
   *
   * One trap worth knowing, learned the hard way while writing this file:
   * Svelte's lexer matches an opening style or script tag even inside a
   * comment, so writing one literally here would silently swallow the rest of
   * the script. Describe the tag; never spell it.
   */
  interface Props {
    items: readonly string[];
    cell: Snippet<[string]>;
  }

  let { items, cell }: Props = $props();
</script>

<ul class="gallery">
  {#each items as item (item)}
    <li>
      {@render cell(item)}
      <code>{item}</code>
    </li>
  {/each}
</ul>

<style>
  .gallery {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: var(--nox-sp-5);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--nox-sp-3);
    padding: var(--nox-sp-5) var(--nox-sp-3);
    border: 1px solid var(--nox-border);
    border-radius: var(--nox-r-md);
    background: var(--nox-bg-panel);
    color: var(--nox-text);
  }

  code {
    color: var(--nox-text-muted);
    font-family: var(--nox-font-mono);
    font-size: var(--nox-fs-2xs);
  }
</style>

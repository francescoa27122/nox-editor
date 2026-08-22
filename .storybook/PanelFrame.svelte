<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * The sidebar-shaped box a panel story renders into.
   *
   * A panel at full canvas width is a layout the app never produces, so a
   * story without this frame is showing something that cannot happen. The
   * default is `workbench.explorerWidth`'s own default (schema.ts:92).
   */
  interface Props {
    width?: number;
    children: Snippet;
  }

  let { width = 248, children }: Props = $props();
</script>

<div class="frame" style:width="{width}px">{@render children()}</div>

<style>
  .frame {
    display: flex;
    flex-direction: column;
    height: 100vh;
    border-right: 1px solid var(--nox-border);
    background: var(--nox-bg-panel);
  }
</style>

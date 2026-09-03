<script lang="ts">
  import { useApp } from './context';
  import Icon from './Icon.svelte';

  /**
   * Full-window affordance for files dragged in from the OS.
   *
   * Purely an indicator: the drop itself is handled by the platform layer,
   * because the webview's own HTML5 drop event yields a sandboxed `File` with
   * no path attached — nothing Nox could actually open.
   */

  const app = useApp();
  const active = app.ui.externalDropActive;
  const hasFolder = app.workspace.rootPath;
</script>

{#if $active}
  <div class="dropzone" aria-hidden="true">
    <div class="card">
      <Icon name="file" size={26} class="glyph" />
      <p class="headline">Drop to open</p>
      <p class="detail">
        {#if $hasFolder}
          Files open as tabs. Drop a single folder to switch workspace.
        {:else}
          Files open as tabs. Drop a folder to open it as a workspace.
        {/if}
      </p>
    </div>
  </div>
{/if}

<style>
  .dropzone {
    position: fixed;
    inset: 0;
    z-index: var(--nox-z-overlay);
    display: grid;
    place-items: center;
    background: var(--nox-scrim);
    /* Prefixed first: Safari shipped the unprefixed property in 18, and this
       app's floor is macOS 13, so 13 through 17 need the -webkit- spelling
       or the scrim loses its blur silently. */
    -webkit-backdrop-filter: blur(2px);
    backdrop-filter: blur(2px);
    /* The OS owns the pointer during a drag; never intercept it. */
    pointer-events: none;
    animation: dropzone-in var(--nox-dur-base) var(--nox-ease);
  }

  @keyframes dropzone-in {
    from {
      opacity: 0;
    }
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--nox-sp-3);
    padding: var(--nox-sp-8) var(--nox-sp-9);
    background: var(--nox-bg-raised);
    border: 1px dashed var(--nox-accent-dim);
    border-radius: var(--nox-r-xl);
    box-shadow: var(--nox-shadow-lg);
    text-align: center;
  }

  .card :global(.glyph) {
    color: var(--nox-accent);
    margin-bottom: var(--nox-sp-2);
  }

  .headline {
    margin: 0;
    font-size: var(--nox-fs-lg);
    font-weight: var(--nox-fw-medium);
    color: var(--nox-text-bright);
    letter-spacing: var(--nox-tracking-tight);
  }

  .detail {
    margin: 0;
    max-width: 34ch;
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-muted);
    line-height: 1.5;
  }
</style>

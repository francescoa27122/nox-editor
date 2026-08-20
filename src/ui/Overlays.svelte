<script lang="ts">
  import { useApp } from './context';
  import CommandPalette from './CommandPalette.svelte';
  import SettingsPanel from './SettingsPanel.svelte';
  import KeybindingsPanel from './KeybindingsPanel.svelte';
  import PromptDialog from './PromptDialog.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';

  /**
   * The single modal layer.
   *
   * Everything that dims the app renders here, so there is exactly one scrim,
   * one z-index, and one answer to "what does Escape close" (UIService).
   */

  const app = useApp();
  const { ui } = app;

  const overlay = ui.overlay;
  const prompt = ui.prompt;
  const confirm = ui.confirm;

  const isPalette = $derived(
    $overlay === 'palette' ||
      $overlay === 'quick-open' ||
      $overlay === 'buffers' ||
      $overlay === 'go-to-line' ||
      $overlay === 'go-to-symbol' ||
      $overlay === 'git-branch',
  );

  function onScrimClick(event: MouseEvent) {
    // Only a click on the scrim itself dismisses, not one that bubbled up.
    if (event.target !== event.currentTarget) return;
    ui.dismissTop();
  }
</script>

{#if $overlay || $prompt || $confirm}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="scrim"
    class:top-aligned={isPalette}
    onclick={onScrimClick}
  >
    {#if $confirm}
      <ConfirmDialog request={$confirm} />
    {:else if $prompt}
      <PromptDialog request={$prompt} />
    {:else if isPalette && $overlay}
      {#key $overlay}
        <CommandPalette mode={$overlay} />
      {/key}
    {:else if $overlay === 'settings'}
      <SettingsPanel />
    {:else if $overlay === 'keybindings'}
      <KeybindingsPanel />
    {/if}
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: var(--nox-z-overlay);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--nox-sp-7);
    background: var(--nox-scrim);
    backdrop-filter: blur(2px);
    animation: scrim-in var(--nox-dur-base) var(--nox-ease);
  }

  /* The palette sits high so results appear where the eye already is. */
  .scrim.top-aligned {
    align-items: flex-start;
    padding-top: 14vh;
  }

  .scrim > :global(*) {
    animation: panel-in var(--nox-dur-slow) var(--nox-ease);
  }

  @keyframes scrim-in {
    from {
      opacity: 0;
    }
  }

  @keyframes panel-in {
    from {
      opacity: 0;
      transform: translateY(-6px) scale(0.994);
    }
  }
</style>

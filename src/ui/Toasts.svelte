<script lang="ts">
  import type { Notification, NotificationKind } from '@services/notifications';
  import { useApp } from './context';
  import Icon, { type IconName } from './Icon.svelte';

  const app = useApp();
  const items = app.notifications.items;

  const ICONS: Record<NotificationKind, IconName> = {
    info: 'info',
    success: 'check',
    warning: 'warning',
    error: 'error',
  };
</script>

<!--
  Two live regions, not one. An error is sticky because it must be read
  (`notifications.ts`), and the markup used to undo that: every kind sat in
  one polite region, so "Could not save" was announced with the politeness
  of "Copied", after whatever the screen reader was already saying. `alert`
  is assertive by definition. Both regions are always in the DOM, because a
  region a screen reader has not seen yet does not announce what it mounts
  with. Errors come first so the sticky ones stay at the top of the stack
  while the transient ones come and go beneath them.
-->
<div class="toasts">
  <div class="region" role="alert">
    {#each $items.filter((item) => item.kind === 'error') as item (item.id)}
      {@render toast(item)}
    {/each}
  </div>
  <div class="region" role="status" aria-live="polite">
    {#each $items.filter((item) => item.kind !== 'error') as item (item.id)}
      {@render toast(item)}
    {/each}
  </div>
</div>

{#snippet toast(item: Notification)}
  <div class="toast {item.kind}">
    <Icon name={ICONS[item.kind]} size={14} class="toast-icon" />
    <div class="text">
      <p class="message">{item.message}</p>
      {#if item.detail}
        <p class="detail">{item.detail}</p>
      {/if}
      {#if item.actions?.length}
        <div class="actions">
          {#each item.actions as action (action.label)}
            <button
              class="nox-button small"
              onclick={() => {
                action.run();
                app.notifications.dismiss(item.id);
              }}
            >
              {action.label}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <button
      class="dismiss"
      aria-label="Dismiss notification"
      onclick={() => app.notifications.dismiss(item.id)}
    >
      <Icon name="close" size={11} />
    </button>
  </div>
{/snippet}

<style>
  .toasts {
    position: fixed;
    right: var(--nox-sp-6);
    bottom: calc(var(--nox-statusbar-h) + var(--nox-sp-5));
    z-index: var(--nox-z-toast);
    display: flex;
    flex-direction: column;
    max-width: 380px;
    pointer-events: none;
  }

  .toast {
    display: flex;
    align-items: flex-start;
    gap: var(--nox-sp-4);
    /* The stack's spacing is a margin on each toast rather than a gap on the
       column, because the column is now two regions and a gap would open
       between them even when one is empty. The first toast's margin only
       extends the bottom-anchored column upward, where nothing is. */
    margin-top: var(--nox-sp-3);
    padding: var(--nox-sp-4) var(--nox-sp-4) var(--nox-sp-4) var(--nox-sp-5);
    background: var(--nox-bg-raised);
    border: 1px solid var(--nox-border-strong);
    border-radius: var(--nox-r-lg);
    box-shadow: var(--nox-shadow-md);
    pointer-events: auto;
    animation: toast-in var(--nox-dur-slow) var(--nox-ease);
  }

  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateX(12px);
    }
  }

  .actions {
    display: flex;
    gap: var(--nox-sp-2);
    margin-top: var(--nox-sp-3);
  }

  .toast :global(.toast-icon) {
    margin-top: 1px;
    flex: none;
  }

  .toast.info :global(.toast-icon) {
    color: var(--nox-info);
  }
  .toast.success :global(.toast-icon) {
    color: var(--nox-success);
  }
  .toast.warning :global(.toast-icon) {
    color: var(--nox-warning);
  }
  .toast.error :global(.toast-icon) {
    color: var(--nox-danger);
  }

  .toast.error {
    border-color: color-mix(in srgb, var(--nox-danger) 36%, transparent);
  }

  .text {
    flex: 1;
    min-width: 0;
  }

  .message {
    overflow-wrap: anywhere;
    margin: 0;
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-bright);
  }

  .detail {
    margin: 3px 0 0;
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-muted);
    line-height: 1.5;
    word-break: break-word;
  }

  .dismiss {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    flex: none;
    border-radius: var(--nox-r-sm);
    color: var(--nox-text-faint);
  }

  .dismiss:hover {
    background: var(--nox-hover);
    color: var(--nox-text-bright);
  }
</style>

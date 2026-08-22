<script lang="ts">
  import type { NotificationKind } from '@services/notifications';
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

<div class="toasts" role="status" aria-live="polite">
  {#each $items as item (item.id)}
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
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    right: var(--nox-sp-6);
    bottom: calc(var(--nox-statusbar-h) + var(--nox-sp-5));
    z-index: var(--nox-z-toast);
    display: flex;
    flex-direction: column;
    gap: var(--nox-sp-3);
    max-width: 380px;
    pointer-events: none;
  }

  .toast {
    display: flex;
    align-items: flex-start;
    gap: var(--nox-sp-4);
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
    border-color: rgba(240, 97, 109, 0.36);
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

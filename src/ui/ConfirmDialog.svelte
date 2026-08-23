<script lang="ts">
  import type { ConfirmRequest } from '@services/ui';

  interface Props {
    request: ConfirmRequest;
  }

  let { request }: Props = $props();

  let container = $state<HTMLElement | null>(null);

  /**
   * The choice Enter picks and the one painted as primary.
   *
   * An explicit `defaultChoiceId` wins over everything. Inference is the
   * fallback, and it is deliberately no longer trusted on its own: the rule
   * "the first choice, or the first *safe* one when any is destructive"
   * assumes the dialog's only destructive answer is the dangerous one, which
   * the permission prompt broke — there `danger` sat on Deny, the *safe*
   * answer, so both the focus and the accent landed on the session-wide
   * grant. Enter must never destroy, and it must never grant a capability.
   */
  const defaultIndex = $derived.by(() => {
    const named = request.choices.findIndex((choice) => choice.id === request.defaultChoiceId);
    if (named >= 0) return named;
    const dangerous = request.choices.some((choice) => choice.danger);
    const safe = request.choices.findIndex((choice) => !choice.danger);
    return dangerous && safe >= 0 ? safe : 0;
  });

  /**
   * Whatever had focus when this dialog opened, so closing it hands the
   * keyboard back.
   *
   * Captured here rather than taken as a prop the way `ContextMenu` does it:
   * every caller of `ui.confirm()` is a service or a command, and none of them has
   * an element to pass. Read during init, before the focus effect below has
   * moved anything.
   *
   * The `isConnected` check is a statement of intent, not a fix: a detached
   * element cannot take focus anyway, so dropping it changes no behaviour.
   * It is here because the case it names is real and non-obvious — the
   * destructive answers close the thing behind the dialog ("Don't Save"
   * removes the pane that had focus) and the pane replacing it focuses
   * itself, so this teardown must stay out of the way rather than compete.
   * Those paths already landed correctly; Escape and Cancel are what needed
   * fixing, where nothing happened and focus went to `<body>` regardless.
   */
  const opener = document.activeElement;

  $effect(() => () => {
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  });

  $effect(() => {
    const buttons = [...(container?.querySelectorAll('button') ?? [])];
    buttons[defaultIndex]?.focus();
  });

  function onKeydown(event: KeyboardEvent) {
    // Left/right cycle the choices so the whole dialog is keyboard-drivable.
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const buttons = [...(event.currentTarget as HTMLElement).querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    buttons[(index + delta + buttons.length) % buttons.length]?.focus();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="confirm"
  role="alertdialog"
  tabindex="-1"
  aria-modal="true"
  aria-label={request.title}
  onkeydown={onKeydown}
  bind:this={container}
>
  <h2>{request.title}</h2>
  <p>{request.message}</p>

  <div class="actions">
    {#each request.choices as choice, index (choice.id)}
      <button
        class="button"
        class:primary={index === defaultIndex}
        class:danger={choice.danger}
        onclick={() => request.resolve(choice.id)}
      >
        {choice.label}
      </button>
    {/each}
  </div>
</div>

<style>
  .confirm {
    width: min(430px, calc(100vw - 64px));
    padding: var(--nox-sp-6);
    background: var(--nox-bg-raised);
    border-radius: var(--nox-r-xl);
    box-shadow: var(--nox-shadow-lg);
  }

  h2 {
    margin: 0;
    font-size: var(--nox-fs-lg);
    font-weight: var(--nox-fw-semibold);
    color: var(--nox-text-bright);
    letter-spacing: var(--nox-tracking-tight);
  }

  p {
    margin: var(--nox-sp-3) 0 0;
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-muted);
    line-height: 1.55;
    /*
     * Line breaks in a message are honoured. A permission prompt puts the
     * path on its own line, and the path is the part you must actually read
     * before answering — running it into the sentence hides it.
     */
    white-space: pre-line;
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    /* Wrap rather than squeeze. Two or three choices sit on one row exactly
       as before; the encoding picker's six were compressed until every label
       broke across three lines. */
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--nox-sp-3);
    margin-top: var(--nox-sp-6);
  }

  /* A choice is as wide as its words. Without this the row shares the width
     out evenly and long labels lose. */
  .actions :global(.button) {
    flex: none;
  }

  .button {
    height: 28px;
    padding: 0 var(--nox-sp-5);
    border-radius: var(--nox-r-md);
    border: 1px solid var(--nox-border-strong);
    font-size: var(--nox-fs-sm);
    color: var(--nox-text);
    transition:
      background var(--nox-dur-fast) var(--nox-ease),
      border-color var(--nox-dur-fast) var(--nox-ease),
      color var(--nox-dur-fast) var(--nox-ease);
  }

  .button:hover {
    background: var(--nox-hover);
  }

  .button.primary {
    background: var(--nox-accent);
    border-color: var(--nox-accent);
    color: var(--nox-text-on-accent);
    font-weight: var(--nox-fw-medium);
  }

  .button.primary:hover {
    background: var(--nox-text-bright);
    border-color: var(--nox-text-bright);
  }

  .button.danger:not(.primary) {
    color: var(--nox-danger);
  }

  .button.danger:not(.primary):hover {
    background: rgba(240, 97, 109, 0.1);
    border-color: var(--nox-danger);
  }

  /* A destructive default must not wear the safe accent colour. Deleting is
     still the focused action — the user chose it from a menu — but it has to
     look like what it is. */
  .button.primary.danger {
    background: var(--nox-danger);
    border-color: var(--nox-danger);
    color: #2a070a;
  }

  .button.primary.danger:hover {
    background: #ff8a93;
    border-color: #ff8a93;
  }
</style>

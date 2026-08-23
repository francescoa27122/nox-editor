<script lang="ts">
  import { untrack } from 'svelte';
  import type { PromptRequest } from '@services/ui';

  interface Props {
    request: PromptRequest;
  }

  let { request }: Props = $props();

  // One-time seed; the dialog is remounted per request, never reused.
  // svelte-ignore state_referenced_locally
  let value = $state(request.initialValue);
  let input = $state<HTMLInputElement | null>(null);
  let touched = $state(false);

  const error = $derived(touched ? (request.validate?.(value) ?? null) : null);

  /**
   * Whatever had focus when this dialog opened, so closing it hands the
   * keyboard back.
   *
   * Captured here rather than taken as a prop the way `ContextMenu` does it:
   * every caller of `ui.prompt()` is a service or a command, and none of them has
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
    const element = input;
    if (!element) return;
    element.focus();

    // `value` is read untracked, and that is the whole point: reading it
    // normally made this effect a dependent of every keystroke, so it
    // re-selected the field after each one and the next character replaced
    // everything typed so far. Every prompt in the app — rename, new file,
    // Save As, an agent instruction — kept only the last character you typed.
    const text = untrack(() => value);
    // Pre-select the stem so typing replaces the name but keeps the extension.
    const end = request.selectTo ?? text.length;
    element.setSelectionRange(0, Math.max(0, Math.min(end, text.length)));
  });

  function submit(event?: Event) {
    event?.preventDefault();
    touched = true;
    if (request.validate?.(value)) return;
    request.resolve(value);
  }

  /**
   * Enter is handled explicitly rather than relying on the browser's implicit
   * form submission, which does not fire reliably for this dialog. Without it
   * every rename and Save As would need a mouse click — unacceptable in an
   * editor that claims to be keyboard-first.
   */
  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    submit();
  }
</script>

<div class="prompt" role="dialog" aria-modal="true" aria-label={request.title}>
  <form onsubmit={submit}>
    <h2>{request.title}</h2>
    {#if request.label}
      <p class="context">{request.label}</p>
    {/if}

    <input
      bind:this={input}
      bind:value
      class="nox-input mono"
      type="text"
      spellcheck="false"
      autocomplete="off"
      aria-label={request.title}
      aria-invalid={Boolean(error)}
      placeholder={request.placeholder ?? ''}
      oninput={() => (touched = true)}
      onkeydown={onKeydown}
    />

    <p class="error" class:visible={Boolean(error)}>{error ?? ''}</p>

    <div class="actions">
      <button type="button" class="button" onclick={() => request.resolve(null)}>Cancel</button>
      <button type="submit" class="button primary" disabled={Boolean(request.validate?.(value))}>
        {request.confirmLabel}
      </button>
    </div>
  </form>
</div>

<style>
  .prompt {
    width: min(460px, calc(100vw - 64px));
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

  /* The same call `.nox-kbd` made in base.css, for the same reason. This line
     is the path the operation lands on — `src/ui` for a new file, the full
     file path for a rename — so it is the one thing in the dialog that must be
     *read* before pressing Enter, not decoration. `--nox-text-faint` is tuned
     for non-text UI at 3:1 and measured 3.46:1 here; `--nox-text-muted` is
     4.91:1 on `--nox-bg-raised`, the dialog's surface and the worst case, and
     still sits a step below the title above it. */
  .context {
    margin: var(--nox-sp-1) 0 0;
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The field is the global .nox-input primitive (mono); only its placement
     is local. Focus and validation borders come from the primitive — the
     chrome disables text selection globally, so re-enable it here. */
  input {
    margin-top: var(--nox-sp-5);
    user-select: text;
  }

  .error {
    margin: var(--nox-sp-2) 0 0;
    min-height: 16px;
    font-size: var(--nox-fs-xs);
    color: var(--nox-danger);
    opacity: 0;
    transition: opacity var(--nox-dur-fast) var(--nox-ease);
  }

  .error.visible {
    opacity: 1;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--nox-sp-3);
    margin-top: var(--nox-sp-5);
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
      border-color var(--nox-dur-fast) var(--nox-ease);
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

  .button:disabled {
    opacity: 0.45;
  }
</style>

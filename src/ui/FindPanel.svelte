<script lang="ts">
  import { useApp } from './context';
  import Icon from './Icon.svelte';

  const app = useApp();
  const { find, ui } = app;

  const query = find.query;
  const replacement = find.replacement;
  const options = find.options;
  const status = find.status;
  const replaceMode = ui.findReplaceMode;

  let queryInput = $state<HTMLInputElement | null>(null);

  $effect(() => {
    // Re-focus whenever the panel is opened or switched into replace mode.
    void $replaceMode;
    queryInput?.focus();
    queryInput?.select();
  });

  const countLabel = $derived.by(() => {
    if ($status.invalidPattern) return 'Bad pattern';
    if ($query.length === 0) return '';
    if ($status.total === 0) return 'No results';
    const total = $status.capped ? `${$status.total}+` : `${$status.total}`;
    return `${$status.current || 1} of ${total}`;
  });

  function onQueryKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) find.previous();
      else find.next();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      find.clear();
      ui.closeFind();
    }
  }

  function onReplaceKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) find.replaceEvery();
      else find.replaceCurrent();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      find.clear();
      ui.closeFind();
    }
  }
</script>

<div class="nox-find" role="search" aria-label="Find in file">
  <button
    class="mode-toggle"
    aria-label={$replaceMode ? 'Hide replace' : 'Show replace'}
    aria-expanded={$replaceMode}
    title={$replaceMode ? 'Hide replace' : 'Show replace'}
    onclick={() => ui.findReplaceMode.set(!$replaceMode)}
  >
    <Icon name={$replaceMode ? 'chevron-down' : 'chevron-right'} size={12} />
  </button>

  <div class="fields">
    <div class="row">
      <div class="field nox-input" aria-invalid={$status.invalidPattern ? 'true' : undefined}>
        <Icon name="search" size={13} class="field-icon" />
        <input
          bind:this={queryInput}
          type="text"
          placeholder="Find"
          aria-label="Find"
          spellcheck="false"
          autocomplete="off"
          value={$query}
          oninput={(event) => find.setQuery(event.currentTarget.value)}
          onkeydown={onQueryKeydown}
        />
        <span class="count" class:none={$status.total === 0 && $query.length > 0}>
          {countLabel}
        </span>

        <div class="toggles">
          <button
            class="toggle"
            class:on={$options.caseSensitive}
            title="Match case"
            aria-label="Match case"
            aria-pressed={$options.caseSensitive}
            onclick={() => find.toggle('caseSensitive')}
          >
            <Icon name="case-sensitive" size={13} />
          </button>
          <button
            class="toggle"
            class:on={$options.wholeWord}
            title="Match whole word"
            aria-label="Match whole word"
            aria-pressed={$options.wholeWord}
            onclick={() => find.toggle('wholeWord')}
          >
            <Icon name="whole-word" size={13} />
          </button>
          <button
            class="toggle"
            class:on={$options.regexp}
            title="Use regular expression"
            aria-label="Use regular expression"
            aria-pressed={$options.regexp}
            onclick={() => find.toggle('regexp')}
          >
            <Icon name="regex" size={13} />
          </button>
          <button
            class="toggle"
            class:on={$options.preserveCase}
            title="Preserve case"
            aria-label="Preserve case"
            aria-pressed={$options.preserveCase}
            onclick={() => find.toggle('preserveCase')}
          >
            <span class="preserve-case-label">AB</span>
          </button>
        </div>
      </div>

      <div class="controls">
        <button
          class="control"
          title="Previous match (⇧Enter)"
          aria-label="Previous match"
          onclick={() => find.previous()}
        >
          <Icon name="arrow-up" size={13} />
        </button>
        <button
          class="control"
          title="Next match (Enter)"
          aria-label="Next match"
          onclick={() => find.next()}
        >
          <Icon name="arrow-down" size={13} />
        </button>
        <button
          class="control"
          title="Select all matches"
          aria-label="Select all matches"
          onclick={() => find.selectAllMatches()}
        >
          <Icon name="command" size={13} />
        </button>
        <button
          class="control"
          title="Close (Esc)"
          aria-label="Close find"
          onclick={() => {
            find.clear();
            ui.closeFind();
          }}
        >
          <Icon name="close" size={13} />
        </button>
      </div>
    </div>

    {#if $replaceMode}
      <div class="row">
        <div class="field nox-input">
          <Icon name="replace" size={13} class="field-icon" />
          <input
            type="text"
            placeholder="Replace"
            aria-label="Replace with"
            spellcheck="false"
            autocomplete="off"
            value={$replacement}
            oninput={(event) => find.setReplacement(event.currentTarget.value)}
            onkeydown={onReplaceKeydown}
          />
        </div>

        <div class="controls">
          <button
            class="control text"
            onclick={() => find.replaceCurrent()}
            disabled={$status.total === 0}
          >
            Replace
          </button>
          <button
            class="control text"
            onclick={() => find.replaceEvery()}
            disabled={$status.total === 0}
          >
            All
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .nox-find {
    display: flex;
    align-items: flex-start;
    gap: var(--nox-sp-1);
    flex: none;
    padding: var(--nox-sp-3) var(--nox-sp-4) var(--nox-sp-3) var(--nox-sp-2);
    background: var(--nox-bg-panel);
    border-bottom: 1px solid var(--nox-border);
    animation: find-in var(--nox-dur-base) var(--nox-ease);
  }

  @keyframes find-in {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }

  .mode-toggle {
    display: grid;
    place-items: center;
    width: 20px;
    height: 26px;
    flex: none;
    color: var(--nox-text-faint);
    border-radius: var(--nox-r-sm);
  }

  .mode-toggle:hover {
    color: var(--nox-text);
    background: var(--nox-hover);
  }

  .fields {
    display: flex;
    flex-direction: column;
    gap: var(--nox-sp-2);
    flex: 1;
    min-width: 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-3);
    min-width: 0;
  }

  /* The well is the global .nox-input primitive, carried on the wrapper so
     the Sublime-style toggles live inside the border. Only the interior
     layout is local; the invalid red comes from the primitive's
     [aria-invalid='true'] rule. */
  .field {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-3);
    flex: 1;
    min-width: 0;
    max-width: 620px;
    /* Toggles sit closer to the edge than the primitive's text padding. */
    padding-right: var(--nox-sp-2);
  }

  /* Focus lives on the inner <input>, which the primitive's :focus cannot
     see from the wrapper — mirror it, but let aria-invalid keep the red
     border while typing a bad pattern. */
  .field:focus-within:not([aria-invalid='true']) {
    border-color: var(--nox-border-accent);
  }

  .field :global(.field-icon) {
    color: var(--nox-text-faint);
    flex: none;
  }

  .field input {
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    outline: none;
    font-family: var(--nox-font-mono);
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-bright);
    user-select: text;
  }

  .field input::placeholder {
    color: var(--nox-text-faint);
    font-family: var(--nox-font-ui);
  }

  .count {
    flex: none;
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .count.none {
    color: var(--nox-danger);
  }

  .toggles {
    display: flex;
    gap: 1px;
    flex: none;
  }

  .toggle {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: var(--nox-r-sm);
    color: var(--nox-text-faint);
    transition:
      background var(--nox-dur-fast) var(--nox-ease),
      color var(--nox-dur-fast) var(--nox-ease);
  }

  .toggle:hover {
    background: var(--nox-hover);
    color: var(--nox-text);
  }

  .toggle.on {
    background: var(--nox-active);
    color: var(--nox-accent);
  }

  .preserve-case-label {
    font-size: var(--nox-fs-2xs);
    font-weight: var(--nox-fw-semibold);
    line-height: 1;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 1px;
    flex: none;
  }

  .control {
    display: grid;
    place-items: center;
    min-width: 24px;
    height: 24px;
    padding: 0 var(--nox-sp-2);
    border-radius: var(--nox-r-sm);
    color: var(--nox-text-muted);
    font-size: var(--nox-fs-xs);
    transition:
      background var(--nox-dur-fast) var(--nox-ease),
      color var(--nox-dur-fast) var(--nox-ease);
  }

  .control:hover:not(:disabled) {
    background: var(--nox-hover);
    color: var(--nox-text-bright);
  }

  .control:disabled {
    opacity: 0.4;
  }

  .control.text {
    padding: 0 var(--nox-sp-4);
  }
</style>

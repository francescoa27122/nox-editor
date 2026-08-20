<script lang="ts">
  import { fuzzyMatch } from '@core/fuzzy';
  import {
    SETTINGS_SCHEMA,
    SETTING_KEYS,
    type SettingCategory,
    type SettingKey,
  } from '@services/config/schema';
  import { useApp } from './context';
  import Icon from './Icon.svelte';

  /**
   * Settings, rendered entirely from the schema.
   *
   * No control is hand-written per preference — add a setting to
   * `config/schema.ts` and it shows up here with the right widget, bounds and
   * reset affordance. This is the payoff for centralising configuration.
   */

  const app = useApp();
  const { config, ui, workspace } = app;
  const settings = config.settings;
  const rootPath = workspace.rootPath;

  /**
   * Which keys the open project sets.
   *
   * Straight off `config.workspaceScope`, not derived from `$settings`: the
   * settings signal stays quiet when a reload changes nothing effective, and
   * a project that sets a key to the value you already had still owns it.
   */
  const workspaceScope = config.workspaceScope;
  const workspaceKeys = $derived($workspaceScope);

  const CATEGORIES: SettingCategory[] = ['Editor', 'Text', 'Files', 'Workbench', 'Terminal'];

  let filter = $state('');
  let activeCategory = $state<SettingCategory | 'All'>('All');
  let searchInput = $state<HTMLInputElement | null>(null);

  $effect(() => {
    searchInput?.focus();
  });

  const visibleKeys = $derived.by(() => {
    const query = filter.trim();
    return SETTING_KEYS.filter((key) => {
      const descriptor = SETTINGS_SCHEMA[key];
      if (descriptor.advanced && query.length === 0) return false;
      if (activeCategory !== 'All' && descriptor.category !== activeCategory) return false;
      if (query.length === 0) return true;
      return Boolean(
        fuzzyMatch(query, descriptor.label) ??
          fuzzyMatch(query, key) ??
          fuzzyMatch(query, descriptor.description),
      );
    });
  });

  const grouped = $derived.by(() => {
    const groups = new Map<SettingCategory, SettingKey[]>();
    for (const key of visibleKeys) {
      const category = SETTINGS_SCHEMA[key].category;
      const list = groups.get(category) ?? [];
      list.push(key);
      groups.set(category, list);
    }
    return [...groups.entries()];
  });

  function update(key: SettingKey, value: unknown) {
    // `inert` on the control is the visible half; this is the load-bearing
    // half. A write that lands in the user layer while the workspace shadows
    // it changes a file and nothing on screen, which is the one outcome this
    // row must not produce — so refuse it here, not only in the DOM.
    if (workspaceKeys.has(key)) return;
    config.set(key, value as never);
  }
</script>

<div class="settings" role="dialog" aria-modal="true" aria-label="Settings">
  <header>
    <div class="heading">
      <h2>Settings</h2>
      <p>
        Stored in <code>settings.json</code>. Only changed values are written.
        {#if workspaceKeys.size > 0}
          <span class="ws-note">
            {workspaceKeys.size}
            {workspaceKeys.size === 1 ? 'setting is' : 'settings are'} set by this project's
            <code>.nox/settings.json</code>.
          </span>
        {/if}
      </p>
    </div>
    <button class="close" aria-label="Close settings" onclick={() => ui.closeOverlay()}>
      <Icon name="close" size={14} />
    </button>
  </header>

  <div class="controls">
    <div class="search nox-input">
      <Icon name="search" size={13} />
      <input
        bind:this={searchInput}
        bind:value={filter}
        type="text"
        placeholder="Search settings…"
        aria-label="Search settings"
        spellcheck="false"
      />
    </div>
    <div class="tabs" role="tablist" aria-label="Setting categories">
      {#each ['All', ...CATEGORIES] as category (category)}
        <button
          class="tab"
          class:active={activeCategory === category}
          role="tab"
          aria-selected={activeCategory === category}
          onclick={() => (activeCategory = category as SettingCategory | 'All')}
        >
          {category}
        </button>
      {/each}
    </div>
  </div>

  <div class="body nox-scroll">
    {#each grouped as [category, keys] (category)}
      <section>
        <h3>{category}</h3>
        {#each keys as key (key)}
          {@const descriptor = SETTINGS_SCHEMA[key]}
          {@const fromWorkspace = workspaceKeys.has(key)}
          <div class="setting" class:locked={fromWorkspace} data-setting={key}>
            <div class="meta">
              <label for="setting-{key}">
                {descriptor.label}
                {#if fromWorkspace}
                  <span class="badge" title="Set by this project's .nox/settings.json">
                    Workspace
                  </span>
                {:else if !config.isDefault(key)}
                  <button
                    class="reset"
                    title="Reset to default"
                    aria-label="Reset {descriptor.label} to default"
                    onclick={() => config.reset(key)}
                  >
                    <Icon name="refresh" size={11} />
                  </button>
                {/if}
              </label>
              <p>{descriptor.description}</p>
            </div>

            <!-- A control that cannot change the effective value is worse than
                 no control: the workspace layer wins, so the row is disabled
                 and the footer points at the file instead. -->
            <div class="control" inert={fromWorkspace}>
              {#if descriptor.kind === 'boolean'}
                <button
                  id="setting-{key}"
                  class="switch"
                  class:on={$settings[key]}
                  role="switch"
                  aria-checked={Boolean($settings[key])}
                  aria-label={descriptor.label}
                  onclick={() => update(key, !$settings[key])}
                >
                  <span class="knob"></span>
                </button>
              {:else if descriptor.kind === 'number'}
                <input
                  id="setting-{key}"
                  class="number nox-input"
                  type="number"
                  min={descriptor.min}
                  max={descriptor.max}
                  step={descriptor.step ?? 1}
                  value={$settings[key]}
                  onchange={(event) => update(key, Number(event.currentTarget.value))}
                />
              {:else if descriptor.kind === 'enum'}
                <select
                  id="setting-{key}"
                  class="nox-input"
                  value={$settings[key]}
                  onchange={(event) => update(key, event.currentTarget.value)}
                >
                  {#each descriptor.options as option (option)}
                    <option value={option}>
                      {descriptor.optionLabels?.[option] ?? option}
                    </option>
                  {/each}
                </select>
              {:else}
                <input
                  id="setting-{key}"
                  class="text nox-input mono"
                  type="text"
                  placeholder={descriptor.placeholder ?? ''}
                  value={$settings[key]}
                  spellcheck="false"
                  onchange={(event) => update(key, event.currentTarget.value)}
                />
              {/if}
            </div>
          </div>
        {/each}
      </section>
    {:else}
      <p class="nox-empty">No settings match “{filter}”.</p>
    {/each}
  </div>

  <footer>
    <button class="link" onclick={() => void app.commands.execute('prefs.reset')}>
      Reset all settings
    </button>
    <button class="link" onclick={() => ui.openOverlay('keybindings')}>
      Keyboard shortcuts
    </button>
    {#if $rootPath}
      <button
        class="link workspace-settings"
        onclick={() => {
          ui.closeOverlay();
          void app.commands.execute('prefs.openWorkspaceSettings');
        }}
      >
        Workspace settings
      </button>
    {/if}
    <span class="version">Nox {__APP_VERSION__}</span>
  </footer>
</div>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    width: min(760px, calc(100vw - 64px));
    height: min(680px, calc(100vh - 120px));
    background: var(--nox-bg-raised);
    border-radius: var(--nox-r-xl);
    box-shadow: var(--nox-shadow-lg);
    overflow: hidden;
  }

  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--nox-sp-5);
    flex: none;
    padding: var(--nox-sp-6) var(--nox-sp-6) var(--nox-sp-5);
  }

  h2 {
    margin: 0;
    font-size: var(--nox-fs-xl);
    font-weight: var(--nox-fw-semibold);
    color: var(--nox-text-bright);
    letter-spacing: var(--nox-tracking-tight);
  }

  .heading p {
    margin: var(--nox-sp-1) 0 0;
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-faint);
  }

  code {
    font-family: var(--nox-font-mono);
    font-size: 0.92em;
    color: var(--nox-text-muted);
  }

  .close {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: var(--nox-r-md);
    color: var(--nox-text-muted);
    flex: none;
  }

  .close:hover {
    background: var(--nox-hover);
    color: var(--nox-text-bright);
  }

  .controls {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-4);
    flex: none;
    padding: 0 var(--nox-sp-6) var(--nox-sp-5);
    border-bottom: 1px solid var(--nox-border);
  }

  /* Well = the global .nox-input primitive on the wrapper, so the icon
     lives inside the border; interior layout and icon colour stay local. */
  .search {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-3);
    flex: 1;
    color: var(--nox-text-faint);
  }

  .search:focus-within {
    border-color: var(--nox-border-accent);
  }

  .search input {
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    outline: none;
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-bright);
    user-select: text;
  }

  .tabs {
    display: flex;
    gap: 1px;
    flex: none;
  }

  .tab {
    height: 30px;
    padding: 0 var(--nox-sp-4);
    border-radius: var(--nox-r-md);
    font-size: var(--nox-fs-sm);
    color: var(--nox-text-muted);
    transition:
      background var(--nox-dur-fast) var(--nox-ease),
      color var(--nox-dur-fast) var(--nox-ease);
  }

  .tab:hover {
    background: var(--nox-hover);
    color: var(--nox-text);
  }

  .tab.active {
    background: var(--nox-active);
    color: var(--nox-accent);
  }

  .body {
    flex: 1;
    padding: var(--nox-sp-2) var(--nox-sp-6) var(--nox-sp-6);
    min-height: 0;
  }

  section {
    padding-top: var(--nox-sp-5);
  }

  h3 {
    margin: 0 0 var(--nox-sp-2);
    font-size: var(--nox-fs-2xs);
    font-weight: var(--nox-fw-semibold);
    text-transform: uppercase;
    letter-spacing: var(--nox-tracking-wide);
    color: var(--nox-text-faint);
  }

  .setting {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-6);
    padding: var(--nox-sp-4) 0;
    border-bottom: 1px solid var(--nox-border);
  }

  .setting:last-child {
    border-bottom: none;
  }

  .meta {
    flex: 1;
    min-width: 0;
  }

  .meta label {
    display: flex;
    align-items: center;
    gap: var(--nox-sp-2);
    font-size: var(--nox-fs-md);
    color: var(--nox-text);
  }

  .meta p {
    margin: 2px 0 0;
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-faint);
    line-height: 1.5;
  }

  .ws-note {
    display: block;
    margin-top: var(--nox-sp-1);
    color: var(--nox-text-muted);
  }

  .badge {
    margin-left: var(--nox-sp-2);
    padding: 1px var(--nox-sp-2);
    border: 1px solid var(--nox-border);
    border-radius: var(--nox-r-sm);
    font-size: var(--nox-fs-2xs);
    font-weight: var(--nox-fw-semibold);
    text-transform: uppercase;
    letter-spacing: var(--nox-tracking-wide);
    color: var(--nox-text-faint);
    vertical-align: middle;
  }

  /* Reads as "not yours to change here", not as broken. */
  .setting.locked .control {
    opacity: 0.45;
  }

  .reset {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border-radius: var(--nox-r-sm);
    color: var(--nox-accent-dim);
  }

  .reset:hover {
    background: var(--nox-hover);
    color: var(--nox-accent);
  }

  .control {
    flex: none;
    display: flex;
    justify-content: flex-end;
    min-width: 132px;
  }

  .switch {
    position: relative;
    width: 34px;
    height: 19px;
    border-radius: var(--nox-r-full);
    background: var(--nox-bg-inset);
    border: 1px solid var(--nox-border-strong);
    transition:
      background var(--nox-dur-base) var(--nox-ease),
      border-color var(--nox-dur-base) var(--nox-ease);
  }

  .switch.on {
    background: rgba(125, 211, 224, 0.18);
    border-color: var(--nox-accent-dim);
  }

  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 13px;
    height: 13px;
    border-radius: var(--nox-r-full);
    background: var(--nox-text-faint);
    transition:
      transform var(--nox-dur-base) var(--nox-ease),
      background var(--nox-dur-base) var(--nox-ease);
  }

  .switch.on .knob {
    transform: translateX(15px);
    background: var(--nox-accent);
  }

  /* The wells are the global .nox-input primitive; only per-widget sizing
     survives here (the primitive is width: 100%; the chrome disables text
     selection globally, so the editable wells re-enable it). */
  .number {
    width: 76px;
    font-variant-numeric: tabular-nums;
    user-select: text;
  }

  .text {
    min-width: 220px;
    font-size: var(--nox-fs-xs);
    user-select: text;
  }

  select {
    width: auto;
    min-width: 132px;
    cursor: default;
  }

  footer {
    display: flex;
    gap: var(--nox-sp-6);
    flex: none;
    padding: var(--nox-sp-4) var(--nox-sp-6);
    border-top: 1px solid var(--nox-border);
    background: var(--nox-bg-base);
  }

  .link {
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-muted);
    transition: color var(--nox-dur-fast) var(--nox-ease);
  }

  .link:hover {
    color: var(--nox-accent);
  }

  .version {
    margin-left: auto;
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-faint);
    font-variant-numeric: tabular-nums;
  }
</style>

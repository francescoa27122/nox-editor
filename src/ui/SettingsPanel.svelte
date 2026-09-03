<script lang="ts">
  import { fuzzyMatch } from '@core/fuzzy';
  import {
    SETTINGS_SCHEMA,
    SETTING_KEYS,
    type SettingCategory,
    type SettingDescriptor,
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
  const { config, ui, workspace, plugins, pluginSettings, themes } = app;
  const settings = config.settings;
  const rootPath = workspace.rootPath;

  /**
   * One control, whatever declared it.
   *
   * Core preferences and a plugin's own options draw the same four widgets,
   * and they were written twice for exactly one release before this. The
   * shapes differ — a core descriptor has a `category` and a plugin's has a
   * `key` — so the snippet takes neither, only what a control needs.
   */
  interface RuntimeOption {
    value: string;
    label: string;
  }

  interface ControlSpec {
    id: string;
    label: string;
    kind: 'boolean' | 'number' | 'string' | 'enum';
    value: boolean | number | string;
    min?: number;
    max?: number;
    step?: number;
    options?: readonly string[];
    optionLabels?: Readonly<Record<string, string>> | undefined;
    placeholder?: string | undefined;
    onChange: (value: unknown) => void;
  }

  /**
   * What plugins declare, and what they are currently set to.
   *
   * Two signals because two things move independently: `plugins.revision`
   * changes when a plugin is loaded or reloaded, `pluginSettings.revision`
   * when a value does.
   */
  const hostRevision = plugins.revision;
  const pluginRevision = pluginSettings.revision;
  const themeRevision = themes.revision;

  /**
   * Options for a descriptor whose set is only known at run time.
   *
   * One entry today, and the table is the point: the alternative was the panel
   * branching on the key `workbench.theme`, which would have been the first
   * hand-written control in a panel whose whole claim is that it has none. A
   * second source adds a line here and a member to the union in `schema.ts`.
   */
  const runtimeOptions = $derived.by(() => {
    void $themeRevision;
    return {
      themes: themes.list().map((theme) => ({ value: theme.id, label: theme.name })),
    } satisfies Record<NonNullable<SettingDescriptor['optionsFrom']>, RuntimeOption[]>;
  });

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

  /**
   * Plugins are a tab, not a sixth `SettingCategory`.
   *
   * That union is closed and this file restates it as a value, so a runtime
   * category could not join it — but the better reason is that it would be
   * the wrong word. "Editor" and "Terminal" say what a setting is *about*;
   * a plugin's name says who owns it.
   */
  type Tab = SettingCategory | 'All' | 'Plugins';

  let filter = $state('');
  let activeCategory = $state<Tab>('All');
  let searchInput = $state<HTMLInputElement | null>(null);
  /**
   * Whether the `advanced` settings are listed while browsing.
   *
   * They used to be reachable *only* by searching, which hid them from every
   * browse path including their own category tab: opening Settings → Terminal
   * showed two rows and no hint that `terminal.height` existed, so the honest
   * conclusion was that Nox could not do it. Off by default — the point of the
   * flag is still to keep the first read of each category short.
   */
  let showAdvanced = $state(false);

  const advancedCount = $derived(
    SETTING_KEYS.filter((key) => SETTINGS_SCHEMA[key].advanced).length,
  );

  $effect(() => {
    searchInput?.focus();
  });

  const visibleKeys = $derived.by(() => {
    const query = filter.trim();
    return SETTING_KEYS.filter((key) => {
      const descriptor = SETTINGS_SCHEMA[key];
      // A search still reaches an advanced key regardless of the toggle:
      // someone who typed its name has already asked for it by name.
      if (descriptor.advanced && !showAdvanced && query.length === 0) return false;
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

  /**
   * Every loaded plugin that declares a setting, filtered by the same search.
   *
   * Read through `plugins.list()` for the label, because the declaration knows
   * the key and not who owns it. A plugin with no settings never appears —
   * which is every plugin until someone ships one that has them, and is why
   * the tab hides itself.
   */
  const pluginGroups = $derived.by(() => {
    void $hostRevision;
    const query = filter.trim();

    return plugins
      .list()
      .map((plugin) => ({
        id: plugin.id,
        label: plugin.label,
        settings: pluginSettings.declarationsFor(plugin.id).filter((setting) => {
          if (query.length === 0) return true;
          return Boolean(
            fuzzyMatch(query, setting.label) ??
              fuzzyMatch(query, setting.key) ??
              fuzzyMatch(query, plugin.label) ??
              (setting.description === undefined
                ? null
                : fuzzyMatch(query, setting.description)),
          );
        }),
      }))
      .filter((group) => group.settings.length > 0);
  });

  /** Whether any loaded plugin declares anything, search aside. */
  const anyPluginSettings = $derived.by(() => {
    void $hostRevision;
    return plugins.list().some((plugin) => pluginSettings.declarationsFor(plugin.id).length > 0);
  });

  const pluginValues = $derived.by(() => {
    void $pluginRevision;
    return new Map(pluginGroups.map((group) => [group.id, pluginSettings.valuesFor(group.id)]));
  });

  const showCore = $derived(activeCategory !== 'Plugins');
  const showPlugins = $derived(activeCategory === 'All' || activeCategory === 'Plugins');
  const nothingMatches = $derived(
    (!showCore || grouped.length === 0) && (!showPlugins || pluginGroups.length === 0),
  );

  function update(key: SettingKey, value: unknown) {
    // `inert` on the control is the visible half; this is the load-bearing
    // half. A write that lands in the user layer while the workspace shadows
    // it changes a file and nothing on screen, which is the one outcome this
    // row must not produce — so refuse it here, not only in the DOM.
    if (workspaceKeys.has(key)) return;
    config.set(key, value as never);
  }
</script>

{#snippet control(spec: ControlSpec)}
  {#if spec.kind === 'boolean'}
    <button
      id={spec.id}
      class="switch"
      class:on={spec.value}
      role="switch"
      aria-checked={Boolean(spec.value)}
      aria-label={spec.label}
      onclick={() => spec.onChange(!spec.value)}
    >
      <span class="knob"></span>
    </button>
  {:else if spec.kind === 'number'}
    <input
      id={spec.id}
      class="number nox-input"
      type="number"
      min={spec.min}
      max={spec.max}
      step={spec.step ?? 1}
      value={spec.value}
      onchange={(event) => spec.onChange(Number(event.currentTarget.value))}
    />
  {:else if spec.kind === 'enum'}
    <select
      id={spec.id}
      class="nox-input"
      value={spec.value}
      onchange={(event) => spec.onChange(event.currentTarget.value)}
    >
      {#each spec.options ?? [] as option (option)}
        <option value={option}>{spec.optionLabels?.[option] ?? option}</option>
      {/each}
    </select>
  {:else}
    <input
      id={spec.id}
      class="text nox-input mono"
      type="text"
      placeholder={spec.placeholder ?? ''}
      value={spec.value}
      spellcheck="false"
      onchange={(event) => spec.onChange(event.currentTarget.value)}
    />
  {/if}
{/snippet}

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
      {#each ['All', ...CATEGORIES, ...(anyPluginSettings ? ['Plugins'] : [])] as category (category)}
        <button
          class="tab"
          class:active={activeCategory === category}
          role="tab"
          aria-selected={activeCategory === category}
          onclick={() => (activeCategory = category as Tab)}
        >
          {category}
        </button>
      {/each}
    </div>
  </div>

  <div class="body nox-scroll">
    {#if showCore}
    {#each grouped as [category, keys] (category)}
      <section>
        <h3>{category}</h3>
        {#each keys as key (key)}
          {@const descriptor = SETTINGS_SCHEMA[key]}
          {@const fromWorkspace = workspaceKeys.has(key)}
          {@const runtime = descriptor.optionsFrom ? runtimeOptions[descriptor.optionsFrom] : null}
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
              {@render control({
                id: `setting-${key}`,
                label: descriptor.label,
                // A descriptor whose options arrive at run time draws a
                // dropdown whatever its stored kind is. `workbench.theme` is a
                // string because the set of themes is open, and a text box for
                // it would be a worse control than the enum it replaced.
                kind: runtime ? 'enum' : descriptor.kind,
                value: $settings[key],
                ...(descriptor.kind === 'number'
                  ? { min: descriptor.min, max: descriptor.max, step: descriptor.step ?? 1 }
                  : {}),
                ...(runtime
                  ? {
                      options: runtime.map((option) => option.value),
                      optionLabels: Object.fromEntries(
                        runtime.map((option) => [option.value, option.label]),
                      ),
                    }
                  : descriptor.kind === 'enum'
                    ? { options: descriptor.options, optionLabels: descriptor.optionLabels }
                    : {}),
                ...(descriptor.kind === 'string' && !runtime
                  ? { placeholder: descriptor.placeholder }
                  : {}),
                onChange: (value) => update(key, value),
              })}
            </div>
          </div>
        {/each}
      </section>
    {/each}
    {/if}

    <!-- One section per plugin, named after the plugin. There is no workspace
         badge here and nothing to put one on: a plugin setting has a single
         layer by construction, because a cloned repository must never be able
         to set a key whose meaning Nox does not know. -->
    {#if showPlugins}
      {#each pluginGroups as group (group.id)}
        <section>
          <h3>{group.label}</h3>
          {#each group.settings as setting (setting.key)}
            {@const id = `plugin-setting-${group.id}-${setting.key}`}
            <!-- Derived from the value on screen rather than asked of the
                 service: `isDefault` is a plain call that reads no signal, so
                 the reset button never appeared when a value moved. The two
                 are the same predicate — the service stores non-defaults
                 only — and this one is reactive. -->
            {@const value = pluginValues.get(group.id)?.[setting.key] ?? setting.default}
            <div class="setting" data-plugin-setting="{group.id}.{setting.key}">
              <div class="meta">
                <label for={id}>
                  {setting.label}
                  {#if value !== setting.default}
                    <button
                      class="reset"
                      title="Reset to default"
                      aria-label="Reset {setting.label} to default"
                      onclick={() => pluginSettings.reset(group.id, setting.key)}
                    >
                      <Icon name="refresh" size={11} />
                    </button>
                  {/if}
                </label>
                {#if setting.description}
                  <p>{setting.description}</p>
                {/if}
              </div>

              <div class="control">
                {@render control({
                  id,
                  label: setting.label,
                  kind: setting.kind,
                  value,
                  ...(setting.kind === 'number' ? { min: setting.min, max: setting.max } : {}),
                  ...(setting.kind === 'enum' ? { options: setting.options } : {}),
                  ...(setting.kind === 'string' ? { placeholder: setting.placeholder } : {}),
                  onChange: (value) => pluginSettings.set(group.id, setting.key, value),
                })}
              </div>
            </div>
          {/each}
        </section>
      {/each}
    {/if}

    {#if nothingMatches}
      <p class="nox-empty">No settings match “{filter}”.</p>
    {/if}
  </div>

  <footer>
    <button class="link" onclick={() => void app.commands.execute('prefs.reset')}>
      Reset all settings
    </button>
    <button class="link" onclick={() => ui.openOverlay('keybindings')}>
      Keyboard shortcuts
    </button>
    <button
      class="link"
      aria-pressed={showAdvanced}
      onclick={() => (showAdvanced = !showAdvanced)}
    >
      {showAdvanced ? 'Hide' : 'Show'} advanced ({advancedCount})
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
    color: var(--nox-text-muted);
  }

  code {
    font-family: var(--nox-font-mono);
    /* One step under the heading paragraph it sits in, `--nox-fs-sm`. */
    font-size: var(--nox-fs-xs);
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
    color: var(--nox-text-muted);
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
    color: var(--nox-text-muted);
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
    color: var(--nox-text-muted);
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
    background: color-mix(in srgb, var(--nox-accent) 18%, transparent);
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

  /* The one control in this row that is a state rather than a destination. */
  .link[aria-pressed='true'] {
    color: var(--nox-accent);
  }

  .version {
    margin-left: auto;
    font-size: var(--nox-fs-xs);
    color: var(--nox-text-muted);
    font-variant-numeric: tabular-nums;
  }
</style>

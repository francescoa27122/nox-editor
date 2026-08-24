import type { StorybookConfig } from '@storybook/svelte-vite';

/**
 * Storybook renders Nox's components outside the app shell, one state at a
 * time. It is a workbench, not a second app: nothing here may become a place
 * where a component behaves differently than it does in `App.svelte`.
 *
 * The Vite builder loads the project's own `vite.config.ts`, so the `@core`
 * and `@services` aliases and the `__APP_VERSION__` define come along without
 * being restated here. If a story ever fails to resolve one of those, the fix
 * belongs in `vite.config.ts` where the app reads it too — never in a
 * Storybook-only override.
 */
const config: StorybookConfig = {
  // `src/ui` only. `core/` and `services/` are headless by design and have no
  // rendered state to show; Vitest already covers them.
  stories: ['../src/ui/**/*.stories.@(ts|svelte)'],
  addons: [
    // Stories as real Svelte markup. Required, not a convenience: several
    // components take snippets (`children`, `actions`) and a snippet cannot be
    // written as a plain args object.
    '@storybook/addon-svelte-csf',
    // axe-core over every story. tokens.css argues its contrast decisions by
    // hand in comments; this is the half a person should not be doing.
    '@storybook/addon-a11y',
    '@storybook/addon-docs',
    // Exposes the running Storybook to agents over MCP, so a component change
    // can be checked against the real rendered story rather than described.
    // Only active while `npm run storybook` is up; it adds nothing to a build.
    '@storybook/addon-mcp',
    // Runs every story as a vitest test: it renders, and axe checks it. The
    // browser project this needs lives in vite.config.ts.
    '@storybook/addon-vitest',
  ],
  framework: '@storybook/svelte-vite',
};

export default config;

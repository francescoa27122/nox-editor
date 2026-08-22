import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    runes: true,
  },
  vitePlugin: {
    /**
     * `runes: true` above is a statement about *Nox's* components, but the
     * compiler applies it to every `.svelte` file it is handed — dependencies
     * included. A package still shipping Svelte 4 source then fails to build
     * with `Cannot use \`export let\` in runes mode`, which is a verdict on
     * their code that we have no business passing.
     *
     * Found via `@storybook/addon-svelte-csf`, whose legacy story runtime is
     * written that way, but it was never specific to Storybook: any Svelte
     * 4-era dependency would have hit it. Returning `undefined` restores the
     * compiler's own per-file detection for `node_modules` only; everything
     * under `src/` stays runes-only, which is the rule this file exists to set.
     */
    dynamicCompileOptions({ filename }) {
      if (filename.includes('node_modules')) return { runes: undefined };
    },
  },
};

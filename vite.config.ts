import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
// @ts-expect-error — a build script, outside the tsconfig graph. Its own
// module so `tests/chunks.test.ts` can hold it to its invariant.
import { chunkFor } from './scripts/chunks.mjs';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const pkg = JSON.parse(readFileSync(r('./package.json'), 'utf8')) as { version: string };

export default defineConfig({
  define: {
    // The one build-time constant: the version the Settings footer shows.
    // package.json is the source; the release gate already refuses a tag
    // whose three version files disagree, so this is the bundle's version.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [svelte()],
  resolve: {
    // Svelte publishes a server build, and under a test run the default
    // conditions resolve to it — `mount()` then throws
    // `lifecycle_function_unavailable`.
    //
    // Spread rather than `conditions: process.env.VITEST ? [...] : []`, which
    // is what shipped and broke `npm run dev`. An empty array does not mean
    // "leave the defaults alone" — it *replaces* them, and Vite's defaults are
    // where `browser` comes from. So outside vitest the dev server resolved
    // svelte to its server build and the app failed to start with the very
    // error this line exists to prevent. The key has to be absent, not empty.
    ...(process.env.VITEST ? { conditions: ['browser'] } : {}),
    alias: {
      '@core': r('./src/core'),
      '@platform': r('./src/platform'),
      '@services': r('./src/services'),
      '@editor': r('./src/editor'),
      '@ui': r('./src/ui'),
    },
  },
  // Tauri expects a fixed port and does not want vite obscuring rust errors.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: false,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Chunk the language grammars so startup only pays for what it uses —
    // one chunk per grammar, which `scripts/chunks.mjs` explains and
    // `tests/chunks.test.ts` enforces. A single chunk for all of them, which
    // is what this was, made that comment false.
    rollupOptions: {
      output: { manualChunks: chunkFor },
    },
  },
  test: {
    // Two projects because they need opposite environments and only one of
    // them is allowed to be slow. `unit` is the suite that has always run
    // here: node, no DOM unless a file asks for jsdom, and it stays the thing
    // `npm test` means. `stories` needs a real browser, so it is a separate
    // project a separate script selects.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          // `tests/browser/` needs a browser, and the glob above would
          // otherwise claim those files for this project as well — `npm test`
          // went from 140 files to 141 the moment they existed. They fail
          // rather than mislead when that happens, which is the good version
          // of the accident, but they belong to the `editor` project.
          exclude: ['tests/browser/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'bench',
          environment: 'node',
          // `include` is deliberately empty: this project carries benchmarks,
          // not tests, so `npm test` must find nothing here. Without it the
          // default `**/*.test.ts` would pull the whole unit suite in a second
          // time under a second name.
          include: [],
          benchmark: { include: ['bench/**/*.bench.ts'] },
        },
      },
      {
        extends: true,
        test: {
          name: 'editor',
          // The typing path, in a browser that has layout. Separate from
          // `stories` because it drives an `EditorView` directly rather than
          // rendering a component through Storybook, and separate from `unit`
          // because jsdom returns zeros for every measurement CodeMirror makes
          // - see `tests/support/jsdom-layout.ts`. A keystroke measured
          // without layout is not a keystroke.
          include: ['tests/browser/**/*.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
      {
        extends: true,
        plugins: [storybookTest({ configDir: r('./.storybook') })],
        test: {
          name: 'stories',
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});

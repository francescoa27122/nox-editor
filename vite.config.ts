import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

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
    // Chunk the language grammars so startup only pays for what it uses.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@codemirror/lang-') || id.includes('@lezer/')) return 'grammars';
          if (id.includes('@codemirror/')) return 'editor-engine';
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});

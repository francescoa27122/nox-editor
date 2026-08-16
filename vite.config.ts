import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    // Svelte publishes a server build, and the default conditions resolve to
    // it — under which `mount()` throws `lifecycle_function_unavailable`.
    // Gated on VITEST so the app's own build resolves exactly as it did.
    conditions: process.env.VITEST ? ['browser'] : [],
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

import { mount } from 'svelte';
import './styles/tokens.css';
import './styles/base.css';
import { NoxApp } from './app';
import App from './ui/App.svelte';

/**
 * Bootstrap.
 *
 * Services come up before the first paint so the shell never renders in a
 * half-configured state — no flash of default theme, no empty explorer that
 * then fills in.
 */
async function start() {
  const root = document.getElementById('nox-root');
  if (!root) throw new Error('Nox: #nox-root is missing from index.html');

  try {
    const app = await NoxApp.create();
    mount(App, { target: root, props: { app } });

    // Expose in dev for poking at services from the console.
    if (import.meta.env.DEV) {
      (globalThis as Record<string, unknown>).nox = app;
    }
  } catch (error) {
    console.error('[nox] failed to start:', error);
    root.innerHTML = `
      <div style="display:grid;place-items:center;height:100%;font:13px system-ui;color:#c8d2e4;gap:8px;text-align:center">
        <div>
          <p style="font-size:15px;margin:0 0 8px">Nox failed to start.</p>
          <p style="color:#7a8699;margin:0">${escapeHtml(String(error))}</p>
        </div>
      </div>`;
  }
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character,
  );
}

void start();

import { getContext, setContext } from 'svelte';
import type { NoxApp } from '../app';

const KEY = Symbol('nox');

export function provideApp(app: NoxApp): void {
  setContext(KEY, app);
}

/** Every component reaches services through this — never by constructing them. */
export function useApp(): NoxApp {
  const app = getContext<NoxApp>(KEY);
  if (!app) throw new Error('Nox context is missing — component rendered outside <App>.');
  return app;
}

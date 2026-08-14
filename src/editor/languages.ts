import { Compartment, type Extension } from '@codemirror/state';

/**
 * Grammar loading.
 *
 * Grammars are imported dynamically and cached. Buffers are created with no
 * grammar attached and get one reconfigured in a moment later, which keeps
 * opening a file off the critical path — a 400 KB parser must never sit
 * between the click and the text appearing.
 */

export const languageCompartment = new Compartment();

type Loader = () => Promise<Extension>;

const LOADERS: Record<string, Loader> = {
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript(),
  jsx: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  typescript: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  tsx: async () =>
    (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true }),
  json: async () => (await import('@codemirror/lang-json')).json(),
  html: async () => (await import('@codemirror/lang-html')).html(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  // Close enough to be useful, honest about being an approximation.
  scss: async () => (await import('@codemirror/lang-css')).css(),
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  python: async () => (await import('@codemirror/lang-python')).python(),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  svelte: async () => (await import('@codemirror/lang-html')).html(),
  vue: async () => (await import('@codemirror/lang-html')).html(),
};

const cache = new Map<string, Extension>();
const inflight = new Map<string, Promise<Extension | null>>();

/** True when Nox can syntax-highlight this language id. */
export function hasGrammar(languageId: string): boolean {
  return languageId in LOADERS;
}

/**
 * Resolve a grammar. Returns null for languages with no parser installed —
 * those files still open, they just render unhighlighted.
 */
export function loadLanguage(languageId: string): Promise<Extension | null> {
  const cached = cache.get(languageId);
  if (cached) return Promise.resolve(cached);

  const pending = inflight.get(languageId);
  if (pending) return pending;

  const loader = LOADERS[languageId];
  if (!loader) return Promise.resolve(null);

  const promise = loader()
    .then((extension) => {
      cache.set(languageId, extension);
      inflight.delete(languageId);
      return extension;
    })
    .catch((error) => {
      console.warn(`[nox] failed to load grammar "${languageId}":`, error);
      inflight.delete(languageId);
      return null;
    });

  inflight.set(languageId, promise);
  return promise;
}

/** Synchronously available grammar, if it was already loaded. */
export function cachedLanguage(languageId: string): Extension | null {
  return cache.get(languageId) ?? null;
}

import { StreamLanguage } from '@codemirror/language';
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
  go: async () => (await import('@codemirror/lang-go')).go(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  // No C grammar exists separately, and the C++ one reads C correctly — what
  // it adds is keywords C does not use, which cost a word the wrong colour
  // rather than a broken parse. The same trade `scss` makes above.
  c: async () => (await import('@codemirror/lang-cpp')).cpp(),
  // Defaults to HTML-with-`<?php`-islands rather than `plain`, which is what
  // a `.php` file on disk almost always is.
  php: async () => (await import('@codemirror/lang-php')).php(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  /**
   * The rest are stream parsers, not Lezer grammars.
   *
   * `@codemirror/legacy-modes` ports CodeMirror 5's tokenizers, and
   * `StreamLanguage` adapts one into a `Language`. They tokenise line by line
   * rather than building a tree, so they colour correctly but carry no
   * structure: **`core/symbols.ts` and folding read a parse tree, so Go to
   * Symbol, sticky scroll and syntax folding stay empty in these.**
   * That is the whole of what is given up, and it is worth it — flat grey was
   * the alternative, and no Lezer grammar for any of them exists to upgrade
   * to yet. `loadLanguage` is the only place that would change.
   */
  shell: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell),
  toml: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/toml')).toml),
  ruby: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/ruby')).ruby),
  csharp: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).csharp),
  kotlin: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).kotlin),
  swift: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/swift')).swift),
  lua: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/lua')).lua),
  powershell: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/powershell')).powerShell),
  ini: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/properties')).properties),
  dockerfile: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile),
};

const cache = new Map<string, Extension>();
const inflight = new Map<string, Promise<Extension | null>>();

/**
 * Languages whose grammar is a stream parser rather than a Lezer one.
 *
 * Kept as a list because the question is asked *before* the grammar loads —
 * the palette needs it to choose a sentence, not to read a tree — so it cannot
 * be answered by looking at the extension. `tests/grammars.test.ts` asserts
 * this list against loaded `StreamLanguage` instances, so it cannot drift
 * away from the loaders below it.
 */
const STREAM_GRAMMARS = new Set([
  'shell',
  'toml',
  'ruby',
  'csharp',
  'kotlin',
  'swift',
  'lua',
  'powershell',
  'ini',
  'dockerfile',
]);

/** True when Nox can syntax-highlight this language id. */
export function hasGrammar(languageId: string): boolean {
  return languageId in LOADERS;
}

/**
 * True when this language's grammar builds a tree symbols can be read from.
 *
 * The distinction exists so the Go to Symbol list can tell "this file has no
 * functions in it" from "this grammar cannot see functions". Without it a
 * Ruby file full of classes reported the first, which is a lie the symbol
 * count alone has no way to avoid telling.
 */
export function hasSymbolStructure(languageId: string): boolean {
  return hasGrammar(languageId) && !STREAM_GRAMMARS.has(languageId);
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

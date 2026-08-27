/**
 * Which output chunk a module belongs in.
 *
 * Its own module so `tests/chunks.test.ts` can hold it to the one rule that
 * matters and the build cannot quietly stop honouring: **two languages never
 * share a chunk.** `vite.config.ts` is the only caller.
 *
 * The rule this replaced returned a single `grammars` name for every parser,
 * which defeated the dynamic imports in `editor/languages.ts` entirely —
 * opening a .json buffer loaded every grammar Nox ships. Nothing checked, so
 * it stayed that way from v0.1 until eleven more languages took the chunk to
 * 640 kB.
 */

/** The parser runtime every grammar shares, rather than any one language's. */
const LEZER_RUNTIME = new Set(['common', 'highlight', 'lr']);

/** The package or mode name directly after `marker` in `id`, or null. */
function nameAfter(id, marker) {
  const at = id.indexOf(marker);
  if (at === -1) return null;

  const rest = id.slice(at + marker.length);
  const stop = rest.search(/[^a-z0-9]/);
  return stop === -1 ? rest : rest.slice(0, stop);
}

/**
 * The chunk name for a module id, or `undefined` to let Rollup decide.
 *
 * Ids arrive with POSIX separators on every platform, Windows included —
 * which is what lets a plain `indexOf` stand in for a path parse.
 */
export function chunkFor(id) {
  const lang = nameAfter(id, '@codemirror/lang-');
  if (lang) return `grammar-${lang}`;

  // One package, one module per mode: the name is in the path, not the
  // package.
  const legacy = nameAfter(id, '@codemirror/legacy-modes/mode/');
  if (legacy) return `grammar-${legacy}`;

  // A language's own Lezer parser travels with that language. The runtime the
  // parsers share does not — `editor/theme.ts` imports `@lezer/highlight`
  // directly on the startup path, so it is engine, not grammar.
  const lezer = nameAfter(id, '@lezer/');
  if (lezer) return LEZER_RUNTIME.has(lezer) ? 'editor-engine' : `grammar-${lezer}`;

  if (id.includes('@codemirror/')) return 'editor-engine';

  return undefined;
}

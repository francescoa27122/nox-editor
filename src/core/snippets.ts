/**
 * The snippets file, as data.
 *
 * Pure, and split from `services/snippets.ts` for the reason the language
 * tables are split: reading a user's JSON has enough wrong shapes in it to be
 * worth testing on its own, and none of them need a filesystem to write down.
 *
 * The governing rule is that **a bad entry is dropped and named, never
 * fatal**. A file where one typo emptied everything looks exactly like having
 * configured nothing, which is the state the author was trying to leave — the
 * same argument `servers.json` makes for saying its parse error out loud.
 */

/** A snippet, once it is known to be usable. */
export interface Snippet {
  /** What the user types to reach it. The key in the file. */
  prefix: string;
  /** The template, in the `${1:label}` / `$0` syntax CodeMirror and LSP share. */
  body: string;
  /** Shown beside the prefix in the picker. */
  description?: string;
}

/** Snippets by language id. `'*'` is the bucket every language also gets. */
export type SnippetFile = Map<string, Snippet[]>;

/** The language key whose snippets apply everywhere. */
export const ANY_LANGUAGE = '*';

/** A top-level key beginning with this is a comment, not a language. */
export const COMMENT_KEY = '//';

export interface ParsedSnippets {
  snippets: SnippetFile;
  /**
   * What was dropped, one sentence each.
   *
   * Named rather than counted, because "3 entries were wrong" cannot be acted
   * on and "go.wrong is not a template" can.
   */
  problems: string[];
}

/** A body may be one string or an array of lines, so JSON need not carry `\n`. */
function bodyOf(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (!Array.isArray(value)) return null;
  if (!value.every((line): line is string => typeof line === 'string')) return null;
  const joined = value.join('\n');
  return joined.length > 0 ? joined : null;
}

/** One entry, in either the short or the long form. */
function snippetOf(prefix: string, value: unknown, problems: string[], language: string): Snippet | null {
  const short = bodyOf(value);
  if (short !== null) return { prefix, body: short };

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problems.push(`${language}.${prefix} is neither a template nor an object`);
    return null;
  }

  const record = value as { body?: unknown; description?: unknown };
  const body = bodyOf(record.body);
  if (body === null) {
    problems.push(`${language}.${prefix} has no body`);
    return null;
  }

  return {
    prefix,
    body,
    ...(typeof record.description === 'string' && record.description.length > 0
      ? { description: record.description }
      : {}),
  };
}

/**
 * Read a parsed `snippets.json` body.
 *
 * Takes the already-`JSON.parse`d value rather than the text: the service owns
 * reading the file and reporting that it is not JSON at all, and this owns
 * everything after that.
 */
export function parseSnippetFile(value: unknown): ParsedSnippets {
  const snippets: SnippetFile = new Map();
  const problems: string[] = [];

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    // An array or a bare string parses as JSON and is still not a snippets
    // file. Only say so for the shapes someone might have meant — `null` and
    // an array read as "nothing here", which needs no complaint.
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      problems.push('snippets.json is not an object of languages');
    }
    return { snippets, problems };
  }

  // Cast at both levels rather than at the use sites: `Object.entries` on an
  // `object` yields `any` values, and `any` flowing into the validators is
  // exactly the thing they exist to stop.
  for (const [language, entries] of Object.entries(value as Record<string, unknown>)) {
    // JSON has no comments and this format has syntax worth explaining, so a
    // key beginning `//` is one — which is also the habit people bring to any
    // JSON config file, and greeting it with an error would punish the
    // instinct. `servers.json` needs no such thing; a command explains itself.
    if (language.startsWith(COMMENT_KEY)) continue;

    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
      problems.push(`${language} is not an object of snippets`);
      continue;
    }

    const forLanguage: Snippet[] = [];
    for (const [prefix, entry] of Object.entries(entries as Record<string, unknown>)) {
      if (prefix.length === 0) {
        problems.push(`${language} has a snippet with no prefix`);
        continue;
      }
      const snippet = snippetOf(prefix, entry, problems, language);
      if (snippet) forLanguage.push(snippet);
    }

    if (forLanguage.length > 0) snippets.set(language, forLanguage);
  }

  return { snippets, problems };
}

/**
 * The snippets a language gets: its own, plus the wildcard's.
 *
 * A language's own entry **shadows** a wildcard of the same prefix rather than
 * joining it. Two rows with one name in the picker is a coin toss over which
 * one you get, and the more specific one is always the one that was meant.
 */
export function snippetsFor(file: SnippetFile, languageId: string): Snippet[] {
  const own = languageId === ANY_LANGUAGE ? [] : (file.get(languageId) ?? []);
  const shared = file.get(ANY_LANGUAGE) ?? [];
  if (own.length === 0) return [...shared];

  const claimed = new Set(own.map((snippet) => snippet.prefix));
  return [...own, ...shared.filter((snippet) => !claimed.has(snippet.prefix))];
}

/**
 * LSP snippet syntax, in the dialect CodeMirror's parser reads.
 *
 * The two are nearly the same and differ in exactly the place that matters:
 * **CodeMirror requires braces**. Its parser matches
 * `/[#$]\{...\}/`, so the bare `$0` and `$1` that every language server
 * emits - and that anyone writing a snippet will copy from a server's docs -
 * are not tab stops to it. They stayed in the buffer as literal text, which
 * is the failure this exists to stop.
 *
 * Three conversions, and nothing else:
 *
 * - `$1` becomes `${1}`, so a bare stop is a stop.
 * - `${1|one,two|}` - the protocol's choice syntax - becomes `${1:one}`.
 *   CodeMirror has no picker to offer the alternatives, so the first is the
 *   default and the rest are dropped. A field the user can type over beats
 *   a literal `|one,two|` in their code.
 * - `\$` becomes `$`. It is the protocol's escape for a literal dollar, and
 *   CodeMirror leaves an unbraced `$` alone anyway, so unescaping is both
 *   safe and necessary - the backslash would otherwise be inserted.
 *
 * **Variables are deliberately not touched.** `$TM_FILENAME` and friends stay
 * exactly as written rather than being resolved or silently deleted: Nox
 * substitutes none of them, and text the author can see and fix beats text
 * that vanished.
 */
export function toCodeMirrorTemplate(template: string): string {
  return template.replace(
    /\\\$|\$\{(\d+)\|([^|]*)\|\}|\$(\d+)/g,
    (
      match,
      choiceField: string | undefined,
      choices: string | undefined,
      bare: string | undefined,
    ) => {
      if (match === '\\$') return '$';
      if (choiceField !== undefined) {
        const first = (choices ?? '').split(',')[0] ?? '';
        return first.length > 0 ? `\${${choiceField}:${first}}` : `\${${choiceField}}`;
      }
      return `\${${bare ?? ''}}`;
    },
  );
}

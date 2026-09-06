/**
 * Pure search primitives.
 *
 * These mirror the Rust implementation in `src-tauri/src/search.rs` so the
 * in-memory platform — the browser dev target and every service test — behaves
 * identically to the desktop build. Where the two must agree (preview
 * windowing, column units, whole-word semantics) the constants and rules are
 * duplicated deliberately and covered by matching tests on both sides.
 */

/** A line longer than this is windowed in the preview. Mirrors the Rust value. */
export const PREVIEW_BUDGET = 320;
/** Context kept before the match when a long line is trimmed. */
export const PREVIEW_LEAD = 60;

export interface MatchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
}

export interface LineMatch {
  line: number;
  column: number;
  length: number;
  preview: string;
  previewOffset: number;
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

export function escapeRegExp(text: string): string {
  return text.replace(REGEX_SPECIALS, '\\$&');
}

/**
 * Build the matcher for a query.
 *
 * Word boundaries wrap the whole pattern rather than each alternative, so
 * `cat|dog` with "whole word" on matches `a cat` but not `concatenate`.
 * Throws on an invalid user-supplied regex; callers surface the message.
 */
export function buildSearchRegex(query: string, options: MatchOptions): RegExp {
  const base = options.regexp ? query : escapeRegExp(query);
  const bounded = options.wholeWord ? `\\b(?:${base})\\b` : base;
  const flags = options.caseSensitive ? 'gu' : 'giu';

  try {
    return new RegExp(bounded, flags);
  } catch {
    // The `u` flag rejects some patterns a user may legitimately want
    // (lone surrogates, `\d` inside classes on old engines); retry without it
    // rather than refusing a query that a plain regex would accept.
    return new RegExp(bounded, options.caseSensitive ? 'g' : 'gi');
  }
}

/** The preview window for one match, mirroring the Rust `preview_for`. */
export function previewFor(
  line: string,
  start: number,
  end: number,
): { preview: string; column: number; length: number; previewOffset: number } {
  const length = end - start;
  if (line.length <= PREVIEW_BUDGET) {
    return { preview: line, column: start, length, previewOffset: 0 };
  }

  // Window around the match: the first 320 characters of a minified file
  // would never contain the hit.
  const lead = Math.max(0, start - PREVIEW_LEAD);
  return {
    preview: line.slice(lead, lead + PREVIEW_BUDGET),
    column: start - lead,
    length,
    previewOffset: lead,
  };
}

/**
 * All matches in `text`, line by line. Zero-width matches are skipped: a
 * pattern like `x*` would otherwise produce an unbounded run of empty hits.
 */
export function findMatches(text: string, matcher: RegExp): LineMatch[] {
  const results: LineMatch[] = [];
  const lines = text.split('\n');

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!;
    // Without its `\r`: the Rust side iterates `lines()`, which strips it,
    // and replace walks this same loop, so a CRLF file has to match the same
    // way here or `$`-anchored patterns disagree between the two.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    // A fresh lastIndex per line; the matcher is reused across files.
    matcher.lastIndex = 0;

    let found: RegExpExecArray | null;
    while ((found = matcher.exec(line)) !== null) {
      const start = found.index;
      const end = start + found[0].length;

      if (found[0].length === 0) {
        matcher.lastIndex++;
        continue;
      }

      results.push({ line: index + 1, ...previewFor(line, start, end) });
    }
  }

  return results;
}

/**
 * Convert a glob to a RegExp matching a workspace-relative path.
 *
 * A pattern with no separator matches at any depth (`*.ts` finds
 * `src/deep/a.ts`), which is what people mean and what ripgrep does.
 */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.includes('/') ? glob : `**/${glob}`;
  let out = '';

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` spans zero or more directories; bare `**` spans anything.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    out += char.replace(REGEX_SPECIALS, '\\$&');
  }

  return new RegExp(`^${out}$`);
}

/**
 * Directories never worth searching, applied even when gitignore is off.
 *
 * Mirrors `ALWAYS_EXCLUDE` in `src-tauri/src/search.rs`. The list is
 * duplicated rather than shared because the two walkers are in two languages;
 * `machine_directories_stay_out_when_nothing_is_asked_for` pins it on both
 * sides, under the same name, so changing one without the other is visibly
 * half a change.
 */
export const ALWAYS_EXCLUDE: readonly string[] = [
  '**/.git/**',
  '**/node_modules/**',
  '**/target/**',
  '**/dist/**',
  '**/.svelte-kit/**',
  '**/.next/**',
  '**/__pycache__/**',
  '**/.venv/**',
];

const ALWAYS_EXCLUDE_PATTERNS = ALWAYS_EXCLUDE.map(globToRegExp);

/**
 * True when `relativePath` should be searched under these glob lists.
 *
 * Three groups, weakest first, matching the precedence `search.rs` documents
 * for `ignore`'s last-match-wins overrides:
 *
 *   1. **`ALWAYS_EXCLUDE`**, weakest. A convenience list, not a rule — an
 *      explicit include naming one of those directories reaches into it,
 *      which is what keeps "No results" honest: every skip the walk makes is
 *      one the user can undo from the panel.
 *   2. The user's **includes**.
 *   3. The user's **excludes**, strongest: "files to exclude" reads as a
 *      narrowing of whatever "files to include" selected.
 *
 * The always-excludes used to be missing here entirely, so the browser target
 * and every service test walked `node_modules` and `.git` while the desktop
 * build pruned them — the fake being wrong in the direction that looks
 * harmless, which is the direction that goes unnoticed.
 */
export function matchesGlobs(
  relativePath: string,
  includes: readonly RegExp[],
  excludes: readonly RegExp[],
): boolean {
  if (excludes.some((pattern) => pattern.test(relativePath))) return false;
  // An include list is the user naming what they want, so it decides on its
  // own — including for a path `ALWAYS_EXCLUDE` would otherwise have pruned.
  if (includes.length > 0) return includes.some((pattern) => pattern.test(relativePath));
  return !ALWAYS_EXCLUDE_PATTERNS.some((pattern) => pattern.test(relativePath));
}

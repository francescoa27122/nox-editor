/**
 * A theme file, as data.
 *
 * `DESIGN.md` §9 has said since v0.1 that a theme is *"a token override, not a
 * fork"* — Umbra is twelve declarations. This is the consequence: if a theme
 * is twelve declarations, someone should be able to write those twelve
 * without building Nox.
 *
 * **Read as strictly as `plugin.json`, and for the same reason.** Nobody
 * writes a theme from nothing; they fetch one someone posted and drop it in a
 * folder. So a theme file is content from a stranger that Nox turns into CSS,
 * and it gets the discipline a manifest gets rather than the discipline
 * `settings.json` gets.
 *
 * Two properties carry that, and neither is a blocklist:
 *
 * - **The file names a token, never a CSS property.** It says `"bg-editor"`
 *   and Nox writes the `--nox-` prefix, so there is no spelling of a theme
 *   file that reaches a property Nox did not choose. A key that already looks
 *   like a property, or that tries to close the declaration and open another,
 *   is simply not a member of `THEME_TOKENS`.
 * - **A value must look like a colour** before it is handed to the DOM. The
 *   browser's own parser is the second line — `setProperty` drops what it
 *   dislikes — but a dropped value is invisible, and the author deserves to
 *   be told which line did nothing.
 *
 * See `docs/superpowers/specs/2026-08-28-custom-themes-design.md`.
 */

/** The themes that ship with Nox. A file layers on top of one of these. */
export const BUILT_IN_THEMES = ['eclipse', 'umbra'] as const;

export type BuiltInTheme = (typeof BUILT_IN_THEMES)[number];

export interface Theme {
  /** The file's stem. A directory already makes this unique; no field does. */
  id: string;
  name: string;
  base: BuiltInTheme;
  /** Allowlisted token names, without the `--nox-` prefix. */
  tokens: Record<string, string>;
}

export type ParsedTheme =
  | { ok: true; theme: Theme; problems: string[] }
  | { ok: false; reason: string };

/**
 * Every token a theme may set: the colours, and nothing else.
 *
 * `tokens.css` defines 110; these are the 61 a theme is *about*. What is
 * missing is missing on purpose — geometry (`--nox-sp-*`, `--nox-r-*`, the
 * `-h` heights) because a colour scheme has no business resizing the tab bar;
 * motion (`--nox-dur-*`, `--nox-ease`) because the stylesheet zeroes those
 * under `prefers-reduced-motion` and a theme overriding them would quietly
 * defeat an accessibility preference set in the OS; stacking (`--nox-z-*`)
 * because wrong values there put the palette behind the editor; and
 * typography, which is already the user's own setting and must not lose to a
 * file.
 *
 * `--nox-shadow-md`, `--nox-shadow-lg` and `--nox-focus-ring` are absent for a
 * duller reason: they are composite `box-shadow` values rather than colours,
 * so they would need their own grammar. `--nox-focus-ring-color` is here, and
 * it is the token that exists precisely so the ring can be recoloured without
 * anyone redefining its geometry.
 *
 * `tests/theme.test.ts` holds every name here to one `tokens.css` actually
 * defines. Without it, a token renamed in the stylesheet would leave a theme
 * key that parses, validates, applies, and sets a property nothing reads.
 */
export const THEME_TOKENS: ReadonlySet<string> = new Set([
  // Surfaces
  'bg-void', 'bg-base', 'bg-panel', 'bg-editor', 'bg-raised', 'bg-inset',
  'scrim', 'scrollbar-hover',
  // Interaction states
  'hover', 'active', 'selected', 'selected-strong',
  // Borders
  'border-subtle', 'border', 'border-strong', 'border-accent',
  // Text
  'text', 'text-bright', 'text-muted', 'text-faint',
  'text-on-accent', 'text-on-danger',
  // Accents and status
  'accent', 'accent-bright', 'accent-dim', 'accent-glow', 'violet', 'violet-dim',
  'success', 'warning', 'danger', 'danger-bright', 'info', 'modified',
  'focus-ring-color',
  // The editor surface
  'cursor', 'selection', 'selection-blur', 'selection-match', 'line-active',
  'match-bracket', 'match-bracket-outline', 'nonmatching-bracket',
  'search-match', 'search-match-outline',
  'search-match-active', 'search-match-active-outline',
  'gutter-fg', 'gutter-active-fg', 'plugin-highlight',
  // Syntax
  'syn-keyword', 'syn-string', 'syn-number', 'syn-comment', 'syn-function',
  'syn-variable', 'syn-type', 'syn-constant', 'syn-operator', 'syn-property',
  'syn-tag', 'syn-attribute', 'syn-punctuation', 'syn-heading', 'syn-link',
  'syn-invalid',
]);

/** The CSS custom property a token name stands for. The only place it is built. */
export function tokenProperty(token: string): string {
  return `--nox-${token}`;
}

/**
 * `#abc`, `#abcd`, `#aabbcc`, `#aabbccdd`.
 *
 * Anchored, so `#fff }` and `#fff; background: red` are not colours. Three or
 * four digits, or six or eight — `#ff` is a typo rather than a short form.
 */
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * `rgb(…)` and `rgba(…)`, with only numbers and separators inside.
 *
 * The inner class is what makes this safe rather than the `rgba?` prefix: a
 * function whose arguments can only be digits, dots, commas, spaces, percent
 * signs and slashes cannot carry a `url()`, a `var()` or a second
 * declaration. Named colours are deliberately not accepted — allowing bare
 * identifiers would reopen the question of whether `inherit` is a colour, and
 * every theme anyone writes uses hex anyway.
 */
const RGB = /^rgba?\(\s*[\d.\s,%/]+\)$/;

function isColour(value: string): boolean {
  const trimmed = value.trim();
  return HEX.test(trimmed) || RGB.test(trimmed);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Read a parsed theme file body.
 *
 * Takes the already-`JSON.parse`d value rather than the text, the way
 * `parseManifest` and `parseSnippetFile` do: the service owns reading the file
 * and reporting that it is not JSON at all, and this owns everything after.
 *
 * The id is the file's stem, passed in. A theme does not name its own id —
 * two files could then claim one, and a directory already makes stems unique.
 */
export function parseTheme(id: string, value: unknown): ParsedTheme {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: `${id}.json is not an object` };
  }

  const record = value as Record<string, unknown>;

  const declaredBase = record.base;
  let base: BuiltInTheme = 'eclipse';
  if (declaredBase !== undefined) {
    // Refused rather than defaulted. The base decides every token the file
    // does *not* set, so a typo'd one is a theme that looks nothing like the
    // one intended — and the blame would land on the tokens it did set.
    if (
      typeof declaredBase !== 'string' ||
      !(BUILT_IN_THEMES as readonly string[]).includes(declaredBase)
    ) {
      const named = typeof declaredBase === 'string' ? ` "${declaredBase}"` : '';
      return {
        ok: false,
        reason: `theme "${id}" has an unknown base${named}; it must be ${BUILT_IN_THEMES.join(' or ')}`,
      };
    }
    base = declaredBase as BuiltInTheme;
  }

  const problems: string[] = [];
  const tokens: Record<string, string> = {};
  const declaredTokens = record.tokens;

  if (declaredTokens !== undefined) {
    if (typeof declaredTokens !== 'object' || declaredTokens === null || Array.isArray(declaredTokens)) {
      problems.push('tokens is not an object');
    } else {
      for (const [token, raw] of Object.entries(declaredTokens as Record<string, unknown>)) {
        if (!THEME_TOKENS.has(token)) {
          problems.push(`"${token}" is not a token a theme may set`);
          continue;
        }
        if (typeof raw !== 'string' || !isColour(raw)) {
          const shown = typeof raw === 'string' ? `"${raw}"` : String(raw);
          problems.push(`"${token}" is ${shown}, which is not a hex or rgb() colour`);
          continue;
        }
        tokens[token] = raw.trim();
      }
    }
  }

  return {
    ok: true,
    theme: { id, name: stringField(record, 'name') ?? id, base, tokens },
    problems,
  };
}

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTheme, THEME_TOKENS, tokenProperty } from '../src/core/theme';

/**
 * A theme file, read.
 *
 * Validated the way `plugin.json` is rather than the way `settings.json` is,
 * and §0 of the design doc says why: nobody writes a theme from nothing. They
 * fetch one someone posted and drop it in a folder, so a theme file is content
 * from a stranger that Nox turns into CSS.
 *
 * Two properties do the work, and neither is a blocklist:
 *
 * - The file names a **token**, never a CSS property. Nox writes the `--nox-`
 *   prefix, so no spelling of a theme file reaches a property Nox did not
 *   choose.
 * - A value is checked against a shape before it is ever handed to the DOM.
 *
 * Mutation checks (each made the named test red, then reverted):
 * - `COLOUR` widened to `/^[^;}]+$/` → "refuses a value that is not a colour".
 * - the `THEME_TOKENS.has` check dropped → "drops a token outside the
 *   allowlist, and says which".
 * - `baseOf` returning `eclipse` for an unknown base instead of refusing →
 *   "refuses a base that is not a built-in theme".
 */

describe('the shape of a theme file', () => {
  it('takes a name, a base and some tokens', () => {
    const parsed = parseTheme('solar', {
      name: 'Solar',
      base: 'umbra',
      tokens: { 'bg-editor': '#101214', accent: '#e0a458' },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.theme.id).toBe('solar');
    expect(parsed.theme.name).toBe('Solar');
    expect(parsed.theme.base).toBe('umbra');
    expect(parsed.theme.tokens).toEqual({ 'bg-editor': '#101214', accent: '#e0a458' });
  });

  it('falls back to the id when the file names no name', () => {
    const parsed = parseTheme('solar', { tokens: { accent: '#fff' } });

    expect(parsed.ok && parsed.theme.name).toBe('solar');
  });

  it('defaults the base to eclipse', () => {
    const parsed = parseTheme('solar', { tokens: { accent: '#fff' } });

    expect(parsed.ok && parsed.theme.base).toBe('eclipse');
  });

  it('refuses a base that is not a built-in theme', () => {
    // Refused rather than defaulted: the base decides every token the file
    // does *not* set, so a typo'd one is a theme that looks nothing like the
    // one intended, and the blame would land on the tokens it did set.
    const parsed = parseTheme('solar', { base: 'solarized', tokens: { accent: '#fff' } });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toMatch(/solarized/);
  });

  it('refuses a file that is not an object', () => {
    expect(parseTheme('solar', ['#fff']).ok).toBe(false);
    expect(parseTheme('solar', null).ok).toBe(false);
    expect(parseTheme('solar', 'a theme').ok).toBe(false);
  });

  it('takes a file with no tokens at all, which is a rename of its base', () => {
    const parsed = parseTheme('plain', { name: 'Plain', base: 'umbra' });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.theme.tokens).toEqual({});
  });
});

describe('what a theme may set', () => {
  it('drops a token outside the allowlist, and says which', () => {
    const parsed = parseTheme('solar', {
      tokens: { accent: '#fff', 'z-overlay': '9999', 'sp-4': '40px' },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.theme.tokens).toEqual({ accent: '#fff' });
    expect(parsed.problems.join(' ')).toMatch(/z-overlay/);
    expect(parsed.problems.join(' ')).toMatch(/sp-4/);
  });

  it('cannot reach a property Nox did not choose, however it is spelled', () => {
    // The file names tokens and Nox writes the prefix, so a key that already
    // looks like a property, or that tries to close the declaration, is
    // simply not a member of the allowlist.
    const parsed = parseTheme('evil', {
      tokens: {
        '--nox-accent': '#f00',
        'accent; background: url(http://example.com/x)': '#f00',
        background: 'red',
      },
    });

    expect(parsed.ok && parsed.theme.tokens).toEqual({});
  });

  it('refuses to let a theme override motion, so reduced-motion still wins', () => {
    const parsed = parseTheme('fast', { tokens: { 'dur-base': '2000ms', ease: 'linear' } });

    expect(parsed.ok && parsed.theme.tokens).toEqual({});
  });

  it('allows the syntax colours, which are most of the point', () => {
    const parsed = parseTheme('solar', {
      tokens: { 'syn-comment': '#7c8595', 'syn-keyword': '#c678dd' },
    });

    expect(parsed.ok && Object.keys(parsed.theme.tokens)).toHaveLength(2);
  });
});

describe('what a token value may be', () => {
  const good = ['#fff', '#FFF', '#0a0c11', '#0a0c11ff', 'rgb(10, 12, 17)', 'rgba(10,12,17,0.5)'];

  it.each(good)('takes %s', (value) => {
    const parsed = parseTheme('t', { tokens: { accent: value } });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.theme.tokens.accent).toBe(value);
  });

  const bad = [
    'url(http://example.com/x.png)',
    'var(--nox-bg-void)',
    'red; background: url(x)',
    '#fff }',
    'expression(alert(1))',
    'image-set("a.png")',
    '',
    '#ggg',
    '#ff',
  ];

  it.each(bad)('refuses a value that is not a colour: %s', (value) => {
    const parsed = parseTheme('t', { tokens: { accent: value } });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.theme.tokens).toEqual({});
    expect(parsed.problems).toHaveLength(1);
  });

  it('refuses a value that is not a string', () => {
    const parsed = parseTheme('t', { tokens: { accent: 16 } });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.theme.tokens).toEqual({});
  });
});

describe('the allowlist against the stylesheet', () => {
  const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const defined = new Set([...css.matchAll(/(--nox-[\w-]+)\s*:/g)].map((match) => match[1]!));

  /**
   * Without this, renaming a token in `tokens.css` would leave a theme key
   * that parses, validates and applies — and sets a property nothing reads.
   * The failure is invisible from both ends: the theme author sees no error
   * and the stylesheet sees no reference.
   */
  it('names only tokens the stylesheet actually defines', () => {
    const missing = [...THEME_TOKENS].filter((token) => !defined.has(tokenProperty(token)));

    expect(missing).toEqual([]);
  });

  it('excludes every token that is not a colour', () => {
    // Matched by prefix rather than listed, so a new `--nox-sp-*` is excluded
    // the day it is added rather than the day someone remembers this test.
    const excluded = /^(sp|r|z|dur|fs|fw|lh|tracking|font)-|^(ease|input-h)$|-h$/;
    const leaked = [...THEME_TOKENS].filter((token) => excluded.test(token));

    expect(leaked).toEqual([]);
  });

  it('excludes the composite shadows, which are not colours either', () => {
    // `0 4px 16px rgba(…)` would need its own grammar, and a theme that could
    // set it could also set a 200px blur. `focus-ring-color` is the token
    // that exists so the ring can be recoloured without that.
    expect(THEME_TOKENS.has('shadow-md')).toBe(false);
    expect(THEME_TOKENS.has('shadow-lg')).toBe(false);
    expect(THEME_TOKENS.has('focus-ring')).toBe(false);
    expect(THEME_TOKENS.has('focus-ring-color')).toBe(true);
  });

  it('covers the surfaces and the syntax colours, which is what a theme is for', () => {
    for (const token of ['bg-editor', 'bg-panel', 'accent', 'text', 'syn-keyword', 'syn-string']) {
      expect(THEME_TOKENS.has(token)).toBe(true);
    }
  });
});

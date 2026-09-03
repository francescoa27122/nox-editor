import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEME_TOKENS } from '../src/core/theme';

/**
 * Every `--nox-*` a stylesheet reads is a `--nox-*` that `tokens.css` declares.
 *
 * **An undefined custom property fails silently.** The browser drops the whole
 * declaration and reports nothing, so a rule that references a token nobody
 * defined is not a broken rule that looks broken, it is a rule that is simply
 * not there. Both times this has happened in Nox it went unnoticed for weeks:
 *
 * - `--nox-border-subtle` was referenced before it existed, and `tokens.css:57`
 *   still carries the note that "every rule using it was silently dropped".
 * - `--nox-accent-bright` was referenced by exactly one rule,
 *   `.nox-button.primary:hover` in `base.css`, and declared nowhere. Its
 *   fallback was `var(--nox-accent)`, which is the *resting* background, so
 *   the four primary buttons in the app (Apply, Commit, Run agent, Rebind)
 *   answered the mouse with no change at all. Found by review on 2026-08-30,
 *   after DESIGN.md §7 had already been written about this exact failure.
 *
 * A fallback is what makes it invisible rather than obvious: `var(--x, red)`
 * still paints. So this suite ignores fallbacks and checks the *name*.
 *
 * Mutation-checked on 2026-08-30: deleting `--nox-accent-bright` from
 * `tokens.css` fails the first test with that name in the message, and adding
 * `var(--nox-nonexistent)` to a component, a stylesheet or `src/editor/` fails
 * it too. The last of those is a later addition: the first version of this
 * file scanned two directories while claiming to scan everything, which is the
 * same species of untrue-comment the suite exists to catch.
 *
 * What it does not catch: a token that is declared and never read (harmless),
 * a value that is wrong rather than missing (that is `token-contrast.test.ts`),
 * and anything built by string concatenation at run time rather than written
 * as `var(--nox-…)` in a stylesheet.
 */

const STYLES = join(process.cwd(), 'src', 'styles');
const UI = join(process.cwd(), 'src', 'ui');
/**
 * `src/editor/` too, and it is not decoration.
 *
 * The first version of this suite scanned `src/styles` and `src/ui` only,
 * while its own docstring claimed it held *every* `var(--nox-*)` in the
 * repository. A review planted `var(--nox-does-not-exist)` in
 * `editor/theme.ts` and the suite passed. That file is CSS-in-JS handed to
 * CodeMirror, so an undefined token there fails exactly as silently as one in
 * a stylesheet, and it is the file that paints the text you are editing.
 */
const EDITOR = join(process.cwd(), 'src', 'editor');

/** Every `--nox-name` this text *declares*, i.e. writes as `--nox-name:`. */
function declarations(source: string): Set<string> {
  return new Set([...source.matchAll(/(--nox-[a-z0-9-]+)\s*:/g)].map((match) => match[1]!));
}

/** Every `--nox-name` this text *reads* through `var()`, fallbacks ignored. */
function references(source: string): Set<string> {
  return new Set([...source.matchAll(/var\(\s*(--nox-[a-z0-9-]+)/g)].map((match) => match[1]!));
}

function stylesheets(): { name: string; source: string }[] {
  const files: { name: string; source: string }[] = [];
  for (const name of readdirSync(STYLES)) {
    if (name.endsWith('.css')) files.push({ name, source: readFileSync(join(STYLES, name), 'utf8') });
  }
  for (const name of readdirSync(UI)) {
    if (name.endsWith('.svelte')) files.push({ name, source: readFileSync(join(UI, name), 'utf8') });
  }
  for (const name of readdirSync(EDITOR)) {
    if (name.endsWith('.ts')) files.push({ name, source: readFileSync(join(EDITOR, name), 'utf8') });
  }
  return files;
}

describe('design tokens', () => {
  it('declares every token any stylesheet reads', () => {
    const declared = declarations(readFileSync(join(STYLES, 'tokens.css'), 'utf8'));

    const missing: string[] = [];
    for (const { name, source } of stylesheets()) {
      // A file may declare a token locally; that counts as defining it.
      const local = declarations(source);
      for (const token of references(source)) {
        if (!declared.has(token) && !local.has(token)) missing.push(`${name} reads ${token}`);
      }
    }

    expect(missing).toEqual([]);
  });

  /**
   * A theme can set a token only if `THEME_TOKENS` names it, and the writer of
   * a theme sees the *effect* of the one they cannot set rather than an error.
   * `accent-bright` is the case that motivated this: a theme may recolour
   * `accent`, so leaving its hover out meant every custom theme kept Nox's own
   * cyan on the one interaction that confirms a button was pressed.
   */
  it('lets a theme set every token it also lets it set the resting form of', () => {
    const pairs: [string, string][] = [
      ['accent', 'accent-bright'],
      ['accent', 'accent-dim'],
      ['danger', 'danger-bright'],
      // The editor's outlines, which joined the vocabulary on 2026-08-31.
      // Each was an `rgba()` literal in `editor/theme.ts` sitting beside a
      // fill that was already themeable, which is the same failure as
      // `accent-bright` and reads worse: a matching bracket whose wash the
      // theme moved and whose border it did not.
      ['match-bracket', 'match-bracket-outline'],
      ['search-match', 'search-match-outline'],
      ['search-match-active', 'search-match-active-outline'],
      // `.cm-nonmatchingBracket` takes its *text* colour from `--nox-danger`,
      // so a theme recolouring danger used to move the glyph and leave the
      // wash behind it red.
      ['danger', 'nonmatching-bracket'],
    ];

    const absent = pairs
      .filter(([resting, derived]) => THEME_TOKENS.has(resting) && !THEME_TOKENS.has(derived))
      .map(([resting, derived]) => `${resting} is themeable but ${derived} is not`);

    expect(absent).toEqual([]);
  });

  /** Every themeable name is a real token, so a theme cannot aim at nothing. */
  it('names only tokens that exist', () => {
    const declared = declarations(readFileSync(join(STYLES, 'tokens.css'), 'utf8'));
    const unknown = [...THEME_TOKENS].filter((token) => !declared.has(`--nox-${token}`));
    expect(unknown).toEqual([]);
  });
});

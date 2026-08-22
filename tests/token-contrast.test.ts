import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The contrast arithmetic DESIGN.md argues by hand.
 *
 * `tokens.css` carries its contrast reasoning in comments — most of it written
 * on 2026-08-20, when `--nox-text-faint` was lifted from `#4c5768` because the
 * token had quietly stopped being decoration and started painting the rail
 * icons, tab glyphs and kbd hints. That pass was done by eye and by
 * calculator, and nothing held the result: the numbers in those comments could
 * drift from the values beside them and no run would notice.
 *
 * One thing it missed is why this file exists. Icons and glyphs are non-text
 * UI, so WCAG 1.4.11 asks 3:1 and `--nox-text-faint` was tuned to clear it.
 * The input placeholder is *text*, which WCAG 1.4.3 puts at 4.5:1, and it was
 * painted with the same token — measuring 3.79:1 on `--nox-bg-inset`, the only
 * ground `.nox-input` ever has. Storybook's axe pass found it; this suite is
 * what would have.
 *
 * Deliberately out of scope: the `--nox-syn-*` syntax colours. Those paint the
 * user's own document rather than Nox's chrome, and a dim comment colour is an
 * editor convention rather than an accessibility failure — `--nox-syn-comment`
 * keeps the original `#4c5768` on purpose. Judging them by 1.4.3 would assert
 * a rule this project has not agreed to.
 */

/**
 * Comments come out first. Both stylesheets argue their numbers in prose, and
 * that prose contains things a CSS parser will happily mistake for
 * declarations — `tokens.css` alone says "asks 3:1;" inside the paragraph
 * explaining why `--nox-text-faint` was lifted. Stripping them also keeps the
 * brace matcher below honest about braces quoted in comments.
 */
const uncommented = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const tokensCss = uncommented(
  readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8'),
);
const baseCss = uncommented(
  readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8'),
);

/** The body of the first rule whose selector list starts a line. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^[ \\t]*${escaped}[^{]*\\{`, 'm').exec(css);
  if (!match) throw new Error(`no rule found for \`${selector}\``);
  const open = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unterminated rule for \`${selector}\``);
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+|[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1]!, match[2]!.trim());
  }
  return out;
}

/** Follow `var(--x)` chains to the literal underneath. */
function resolve(tokens: Map<string, string>, name: string, seen = new Set<string>()): string {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`no such token: ${name}`);
  const indirect = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
  if (!indirect) return value;
  if (seen.has(name)) throw new Error(`circular token reference at ${name}`);
  seen.add(name);
  return resolve(tokens, indirect[1]!, seen);
}

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(colour: string): number {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour.trim());
  if (!hex) throw new Error(`not an opaque hex colour: ${colour}`);
  const digits = hex[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(digits.slice(i, i + 2), 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const eclipse = declarations(ruleBody(tokensCss, ':root,'));
const umbra = new Map([...eclipse, ...declarations(ruleBody(tokensCss, "[data-nox-theme='umbra']"))]);
const themes: [string, Map<string, string>][] = [
  ['eclipse', eclipse],
  ['umbra', umbra],
];

/** Every surface a foreground can land on. Worst case decides. */
const SURFACES = [
  '--nox-bg-void',
  '--nox-bg-base',
  '--nox-bg-panel',
  '--nox-bg-editor',
  '--nox-bg-raised',
  '--nox-bg-inset',
];

/** Tokens that paint chrome *text*, so WCAG 1.4.3 applies at 4.5:1. */
const TEXT_TOKENS = [
  '--nox-text',
  '--nox-text-bright',
  '--nox-text-muted',
  '--nox-accent',
  '--nox-danger',
  '--nox-success',
  '--nox-warning',
  '--nox-info',
];

describe.each(themes)('%s', (_theme, tokens) => {
  it.each(TEXT_TOKENS)('%s is legible as text on every surface', (name) => {
    for (const surface of SURFACES) {
      const ratio = contrast(resolve(tokens, name), resolve(tokens, surface));
      expect(`${surface}: ${ratio.toFixed(2)}`).toBe(`${surface}: ${Math.max(ratio, 4.5).toFixed(2)}`);
    }
  });

  /**
   * `--nox-text-faint` is the one foreground held to the *lower* bar, and that
   * is the whole reason it is dangerous. It clears 1.4.11's 3:1 for icons and
   * glyphs and fails 1.4.3's 4.5:1 for text, so the day it creeps back onto
   * text nothing else will complain. Asserting both halves keeps the ceiling
   * as visible as the floor.
   */
  it('--nox-text-faint clears the non-text bar and only the non-text bar', () => {
    for (const surface of SURFACES) {
      const ratio = contrast(resolve(tokens, '--nox-text-faint'), resolve(tokens, surface));
      expect(ratio).toBeGreaterThanOrEqual(3);
      expect(ratio).toBeLessThan(4.5);
    }
  });

  /**
   * The regression this suite was written for. Read from `base.css` rather
   * than restated, so renaming the token in the stylesheet moves the test with
   * it instead of leaving it asserting a pairing that no longer ships.
   */
  it('the input placeholder is legible on the field it sits in', () => {
    const field = declarations(ruleBody(baseCss, '.nox-input'));
    const placeholder = declarations(ruleBody(baseCss, '.nox-input::placeholder'));

    const background = /var\(\s*(--[\w-]+)\s*\)/.exec(field.get('background') ?? '')?.[1];
    const colour = /var\(\s*(--[\w-]+)\s*\)/.exec(placeholder.get('color') ?? '')?.[1];
    expect(background, '.nox-input must take its background from a token').toBeDefined();
    expect(colour, '.nox-input::placeholder must take its colour from a token').toBeDefined();

    const ratio = contrast(resolve(tokens, colour!), resolve(tokens, background!));
    expect(`${colour} on ${background}: ${ratio.toFixed(2)}`).toBe(
      `${colour} on ${background}: ${Math.max(ratio, 4.5).toFixed(2)}`,
    );
  });
});

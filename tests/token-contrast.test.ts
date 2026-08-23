import { readdirSync, readFileSync } from 'node:fs';
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
 * The `--nox-syn-*` colours were out of scope when this file was written, on
 * the argument that they paint the user's document rather than Nox's chrome
 * and that a dim comment is an editor convention. That exemption was withdrawn
 * on 2026-08-22: syntax is the text a person actually spends the day reading,
 * and "it is conventional" is not a reason it has to be unreadable. Two of the
 * sixteen were under the floor — `--nox-syn-comment` at 2.64:1 and
 * `--nox-syn-punctuation` at 3.95:1 — and both moved.
 *
 * The bar is the same 4.5:1, measured on `--nox-bg-editor`, which is the worst
 * case: Umbra's editor is pure black and reads higher on every token.
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


/**
 * A wash flattened onto the surface under it, because that is the only form
 * anyone ever sees it in. `--nox-hover` is `rgba(...)` by design — one token
 * has to work over six surfaces — so its real colour does not exist until a
 * background is chosen for it.
 */
function composite(fill: string, surface: string): string {
  const parts = /^rgba?\(([^)]+)\)$/.exec(fill.trim());
  if (!parts) throw new Error(`not an rgba fill: ${fill}`);
  const [r, g, b, a] = parts[1]!.split(',').map((n) => Number(n.trim()));
  if ([r, g, b, a].some((n) => n === undefined || Number.isNaN(n))) {
    throw new Error(`not four rgba channels: ${fill}`);
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(surface.trim());
  if (!hex) throw new Error(`not an opaque hex colour: ${surface}`);
  const under = [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16));
  return `#${[r!, g!, b!]
    .map((over, i) => Math.round(a! * over + (1 - a!) * under[i]!))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

/** The four washes that say what the pointer and the keyboard are touching. */
const INTERACTION_FILLS = [
  '--nox-hover',
  '--nox-active',
  '--nox-selected',
  '--nox-selected-strong',
];

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

/**
 * Where `--nox-text-faint` is still allowed, and why each one is not text.
 *
 * The token clears WCAG 1.4.11's 3:1 for non-text UI and fails 1.4.3's 4.5:1
 * for text, so its whole safety argument is that it never paints anything
 * anyone has to read. That held by review and quietly stopped holding: a sweep
 * on 2026-08-22 found it on section headings, breadcrumbs, empty-state copy,
 * status-bar readouts and four placeholders — 44 sites — and moved them to
 * `--nox-text-muted`.
 *
 * An allow-list rather than a per-site comment because a comment cannot fail.
 * Adding a row here is a claim that the thing is a glyph, an icon or an
 * inactive control; if it has words a user is meant to read, it belongs on
 * `--nox-text-muted` instead.
 */
const NON_TEXT_FAINT_USES: Record<string, string> = {
  // Inactive controls are exempt from 1.4.3 by name, and dimming is how this
  // one says so.
  'AnswersPanel.svelte .where:disabled': 'disabled control',

  // Icons and glyph buttons: no words, so 1.4.11's 3:1 is the right bar.
  'CommandPalette.svelte .row :global(.row-icon)': 'row icon',
  'ExplorerPanel.svelte .twisty': 'aria-hidden disclosure chevron',
  'ExplorerPanel.svelte .icon': 'aria-hidden file icon',
  'FindPanel.svelte .mode-toggle': 'icon-only button',
  'FindPanel.svelte .field :global(.field-icon)': 'field icon',
  'FindPanel.svelte .toggle': 'icon-only option buttons',
  'KeybindingsPanel.svelte .search': 'wrapper, paints its search icon',
  'NotesPanel.svelte .icon-button': 'icon-only button',
  'NotesPanel.svelte .filter': 'wrapper, paints its search icon',
  'NotesPanel.svelte .pin-button': 'icon-only button',
  'SearchPanel.svelte .row.file :global(.twisty)': 'disclosure chevron',
  'SearchPanel.svelte .row-action': 'icon-only row buttons',
  'SettingsPanel.svelte .search': 'wrapper, paints its search icon',
  'SettingsPanel.svelte .knob': 'the toggle knob itself, not a label',
  'Sidebar.svelte .rail-button': 'rail icons — the case tokens.css was lifted for',
  'TabBar.svelte .close': 'close glyph',
  'TabBar.svelte .new-tab': 'plus glyph',
  'TitleBar.svelte .divider': 'aria-hidden separator',
  'TitleBar.svelte .crumb-sep': 'aria-hidden breadcrumb separator',
  'Toasts.svelte .dismiss': 'icon-only button',
};

/** Every rule in a component or stylesheet that names a token. */
function rulesUsing(css: string, token: string): string[] {
  const masked = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => ' '.repeat(comment.length));
  const found: string[] = [];
  for (let i = masked.indexOf(token); i !== -1; i = masked.indexOf(token, i + 1)) {
    let depth = 0;
    let open = i;
    for (; open >= 0; open--) {
      if (masked[open] === '}') depth++;
      else if (masked[open] === '{') {
        if (depth === 0) break;
        depth--;
      }
    }
    let start = open - 1;
    while (start >= 0 && masked[start] !== '{' && masked[start] !== '}') start--;
    found.push(masked.slice(start + 1, open).split(/\s+/).filter(Boolean).join(' '));
  }
  return found;
}

describe('--nox-text-faint', () => {
  it('paints only non-text UI', () => {
    const sources = [
      ...readdirSync(new URL('../src/ui/', import.meta.url))
        .filter((name) => name.endsWith('.svelte') && !name.endsWith('.stories.svelte'))
        .map((name) => [name, readFileSync(new URL(`../src/ui/${name}`, import.meta.url), 'utf8')] as const),
      ['base.css', readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8')] as const,
    ];

    const used = sources
      .flatMap(([name, css]) => rulesUsing(css, '--nox-text-faint').map((rule) => `${name} ${rule}`))
      .sort();

    expect(used).toEqual(Object.keys(NON_TEXT_FAINT_USES).sort());
  });
});

describe.each(themes)('%s', (_theme, tokens) => {
  it.each(TEXT_TOKENS)('%s is legible as text on every surface', (name) => {
    for (const surface of SURFACES) {
      const ratio = contrast(resolve(tokens, name), resolve(tokens, surface));
      expect(`${surface}: ${ratio.toFixed(2)}`).toBe(`${surface}: ${Math.max(ratio, 4.5).toFixed(2)}`);
    }
  });

  /**
   * Every syntax colour, discovered rather than listed, so a token added for a
   * new grammar is covered the day it appears instead of the day someone
   * remembers this file.
   */
  it('every syntax colour is legible on the writing surface', () => {
    const editor = resolve(tokens, '--nox-bg-editor');
    const syntax = [...tokens.keys()].filter((name) => name.startsWith('--nox-syn-'));
    expect(syntax.length).toBeGreaterThan(10);

    for (const name of syntax) {
      const ratio = contrast(resolve(tokens, name), editor);
      expect(`${name}: ${ratio.toFixed(2)}`).toBe(`${name}: ${Math.max(ratio, 4.5).toFixed(2)}`);
    }
  });

  /**
   * The inert group keeps its order. DESIGN.md §3 wants comments quietest and
   * operators/punctuation a step above, and raising both to clear the floor
   * compressed that band rather than removing it — so the ordering is worth
   * asserting now that there is far less room between the levels.
   */
  it('comments stay the quietest thing in the buffer', () => {
    const editor = resolve(tokens, '--nox-bg-editor');
    const at = (name: string) => contrast(resolve(tokens, name), editor);

    expect(at('--nox-syn-comment')).toBeLessThan(at('--nox-syn-operator'));
    expect(at('--nox-syn-operator')).toBeLessThan(at('--nox-syn-variable'));
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
  /**
   * A state fill has to be seen to be a state.
   *
   * `--nox-hover` shipped at 5.5% cyan, which composites to 1.06:1 over
   * `--nox-bg-panel` — the sidebar, where for a file row it is the *entire*
   * feedback. Fourteen rules across five panels paired it with no colour
   * change at all, so hovering the explorer tree, the search results, the
   * problems list, the notes list and both dialogs' buttons did nothing a
   * person could see. DESIGN.md §7 argued the token as "a 5.5% cyan wash" and
   * nothing ever measured it, which is the same failure `--nox-text-faint`
   * had and the reason this file exists.
   *
   * WCAG has no clause to borrow: 1.4.11 is about *identifying* a control,
   * not about a transient state on one already on screen. ~1.2:1 is the usual
   * floor for a large flat fill to register at all, so the bar is 1.25:1 —
   * one step clear of it, and measured on every surface because the lightest
   * one flatters a light wash least.
   */
  it.each(INTERACTION_FILLS)('%s is a fill you can actually see', (name) => {
    for (const surface of SURFACES) {
      const ground = resolve(tokens, surface);
      const ratio = contrast(composite(resolve(tokens, name), ground), ground);
      expect(`${surface}: ${ratio.toFixed(2)}`).toBe(
        `${surface}: ${Math.max(ratio, 1.25).toFixed(2)}`,
      );
    }
  });

  /**
   * Raising the floor is what makes this worth asserting. Hover is the one
   * state nobody asked for — it follows the pointer across everything it
   * crosses — so it must stay quieter than the two that record a choice, or
   * a mouse drifting over the explorer out-shouts the row you selected.
   */
  it('hover stays the quietest of the four', () => {
    const ground = resolve(tokens, '--nox-bg-panel');
    const at = (name: string) => contrast(composite(resolve(tokens, name), ground), ground);

    expect(at('--nox-hover')).toBeLessThan(at('--nox-active'));
    expect(at('--nox-hover')).toBeLessThan(at('--nox-selected'));
  });

  /**
   * `ExplorerPanel.svelte` draws `.row.selected.lead` with the strong variant
   * for one reason — the keyboard's position has to stay findable inside a
   * large selection — and that only works while it outranks `.row.selected`.
   */
  it('the lead row stays findable inside a selection', () => {
    const ground = resolve(tokens, '--nox-bg-panel');
    const at = (name: string) => contrast(composite(resolve(tokens, name), ground), ground);

    expect(at('--nox-selected')).toBeLessThan(at('--nox-selected-strong'));
  });
});

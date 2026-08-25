import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The house rule that CSS in `src/ui` is token-only, made checkable.
 *
 * CLAUDE.md states it and CONTRIBUTING.md assumes it, but nothing ran it, so
 * seven literals had accumulated across five components. None of them looked
 * wrong: Umbra overrides backgrounds, borders and text and leaves the accent
 * and semantic families alone, so every one of the seven happened to agree
 * with the token it had been copied from. That is what makes them worth a
 * test rather than a glance. They are pinned, and a theme cannot move them.
 *
 * Four were a token's channels written out by hand to get an alpha a `var()`
 * could not carry — `rgba(240, 97, 109, …)` is `--nox-danger` and
 * `rgba(125, 211, 224, …)` is `--nox-accent`. `color-mix()` had already
 * replaced that trick in ten places across five other components by the time
 * this was written, so these were stragglers rather than a standing
 * exemption. Retune either token and the wash keeps the old hue while the
 * border beside it, still a `var()`, moves.
 *
 * The other three were `ConfirmDialog.svelte`'s destructive button, whose
 * label and hover fill had no token at all. They now have one each.
 *
 * Storybook's theme toggle is the manual version of this test. It is faster
 * to flip, and it only covers the component someone thought to open.
 */

/**
 * Only the style block, and only after comments come out.
 *
 * Markup is left alone deliberately: an inline `style=` attribute with a
 * literal would slip past this, but scanning the whole file means every hex
 * in a script block — a colour a picker offers, a hash in prose — has to be
 * argued about. Comments go first for the reason `token-contrast.test.ts`
 * gives: this codebase discusses its colours in prose, and a paragraph
 * naming `#2a070a` is a paragraph, not a declaration.
 */
const styleBlocks = (source: string): string[] =>
  [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(([, body]) =>
    (body ?? '').replace(/\/\*[\s\S]*?\*\//g, ''),
  );

/** Anything a browser reads as a colour that is not a custom property. */
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;

const componentDir = new URL('../src/ui/', import.meta.url);

const components = readdirSync(componentDir)
  .filter((name) => name.endsWith('.svelte') && !name.endsWith('.stories.svelte'))
  .sort();

describe('component CSS', () => {
  /**
   * The offenders are reported with file, line and the declaration itself
   * rather than counted, because the fix is per-declaration and a bare count
   * sends the next person grepping for what this test already knows.
   */
  it('names no colour a token could name', () => {
    const violations: string[] = [];

    for (const name of components) {
      const source = readFileSync(new URL(name, componentDir), 'utf8');

      for (const block of styleBlocks(source)) {
        // Offsets come from the stripped block, so lines are counted against
        // the original file by matching the declaration text back into it.
        for (const line of block.split('\n')) {
          if (!LITERAL.test(line)) continue;
          const at = source.split('\n').findIndex((l) => l === line);
          violations.push(`${name}:${at + 1}  ${line.trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

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
 * **`src/editor/` too, since 2026-08-31.** The first version scanned `src/ui`
 * only, which is what CLAUDE.md's rule says, and DESIGN.md §9 claims on the
 * back of it that "the editor surface and the app chrome physically cannot
 * drift apart". They could: `editor/theme.ts` is CSS-in-JS handed to
 * CodeMirror and it held five `rgba()` literals, so a theme recolouring
 * `accent` moved a matching bracket's fill and left its outline glacial cyan,
 * and `.cm-selectionMatch` had no token at all. Same failure, same fix, in the
 * file that paints the text you are editing. This is the second suite to
 * discover it was scanning less than its own docstring claimed; the first was
 * `token-definitions.test.ts`, which now scans the same three places.
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

/**
 * A font size that is a number rather than a `--nox-fs-*` step.
 *
 * DESIGN.md's rule names four things a component never hardcodes, and this
 * test held only the first of them. Five sizes had accumulated outside the
 * scale: two `9px`, below the smallest step, and three `0.92em`, which is a
 * size relative to whatever the parent happens to be. Relative units are
 * caught on purpose: `0.92em` of a parent that moves to another step lands
 * somewhere the scale does not name.
 */
const FONT_SIZE_LITERAL = /\bfont-size:\s*[\d.]/;

const componentDir = new URL('../src/ui/', import.meta.url);

const components = readdirSync(componentDir)
  .filter((name) => name.endsWith('.svelte') && !name.endsWith('.stories.svelte'))
  .sort();

const editorDir = new URL('../src/editor/', import.meta.url);

const editorModules = readdirSync(editorDir)
  .filter((name) => name.endsWith('.ts'))
  .sort();

/**
 * A `.ts` file has no `<style>` block to narrow to, so the whole module is
 * scanned with comments blanked out.
 *
 * That is wider than the component rule on purpose and it is affordable here:
 * `src/editor/` is CodeMirror extensions, and a colour appearing anywhere in
 * one of them is a colour being painted, not a hex mentioned in passing.
 * Blanking is what keeps the prose out, and this codebase argues its colours
 * in prose. Line comments too, not just block ones, because these files use
 * both.
 *
 * **Blanked rather than deleted, so line numbers survive.** A multi-line block
 * comment removed outright shifts every line after it, and the first version
 * of this did exactly that: a planted literal on line 95 was reported as line
 * 89, quoting the wrong declaration entirely. A violation report that names
 * the wrong line is worse than a bare count, because it sends the reader to a
 * line that looks fine. Found by mutation-checking this test rather than by
 * trusting that it failed.
 */
const uncommented = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    // Not a bare `//`: `folding.ts` builds SVG with the
    // `http://www.w3.org/2000/svg` namespace, and blanking from there would
    // hide the rest of that line from the scan. Requiring the slashes not to
    // follow a colon covers every URL in the directory without pretending to
    // be a tokeniser.
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

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

  /**
   * Same rule, one directory over. Reported the same way, because the fix is
   * the same: give the value a token and read it with `var()`.
   */
  it('names no colour a token could name, in the editor extensions either', () => {
    const violations: string[] = [];

    for (const name of editorModules) {
      const source = readFileSync(new URL(name, editorDir), 'utf8');
      const lines = source.split('\n');

      uncommented(source)
        .split('\n')
        .forEach((line, index) => {
          if (!LITERAL.test(line)) return;
          violations.push(`${name}:${index + 1}  ${(lines[index] ?? line).trim()}`);
        });
    }

    expect(violations).toEqual([]);
  });

  /**
   * Same sweep, other half of the rule. Kept as its own test so a colour
   * literal and a size literal are reported as the two different mistakes
   * they are.
   */
  it('sets no font size the scale does not name', () => {
    const violations: string[] = [];

    for (const name of components) {
      const source = readFileSync(new URL(name, componentDir), 'utf8');

      for (const block of styleBlocks(source)) {
        for (const line of block.split('\n')) {
          if (!FONT_SIZE_LITERAL.test(line)) continue;
          const at = source.split('\n').findIndex((l) => l === line);
          violations.push(`${name}:${at + 1}  ${line.trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

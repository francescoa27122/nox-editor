import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * What a dirty tab shows in the close button's slot.
 *
 * The 2026-08-20 desktop pass raised this as BUG-2: on a dirty tab, hovering
 * the close button kept showing the dirty dot and the ✕ never appeared. It
 * was recorded as a *candidate* rather than a finding — one of two planned
 * checks, with the confirming batch aborted by the machine contention that
 * ran through that whole walk.
 *
 * It was almost certainly never a defect. The instrumented re-walk that
 * afternoon resolved its sibling BUG-1 as an artifact of the walk harness —
 * an invisible harness window covering screen x≥970, y 53–773 swallowed every
 * click aimed there, and Escape was eaten at the OS level before any app saw
 * it — and `.desktop-pass-report.md` records that the tab's close button sat
 * at ≈x981, *inside the same region*, so the hover moves likely never reached
 * Nox either. It asks for a re-check that never happened. The rules below say
 * the ✕ does appear, which is the third piece of agreeing evidence.
 *
 * "Almost certainly" is why this file exists. BUG-1's real yield was not the
 * bug — there wasn't one — but the hole it exposed: nothing in the suite had
 * ever driven that path, so the walk's claim could not be answered from the
 * repository. This is the same hole one component over. The behaviour is
 * entirely `:hover` and `:focus-visible` over two stacked children, which
 * jsdom cannot evaluate and `tests/support/jsdom-layout.ts` forbids
 * pretending to, so it is pinned the way `cursor-affordance.test.ts` pins its
 * rule — by reading the stylesheet, because a comment cannot fail.
 *
 * The contract, in the order the CSS argues it:
 *
 *   1. A clean tab reveals the ✕ when the pointer is anywhere on the tab.
 *   2. A dirty tab does not — the dot holds the slot, because hiding the only
 *      "unsaved" signal at the moment the user aims at a close that will
 *      prompt is the thing the audit caught.
 *   3. Hovering or focusing the *button itself* reveals the ✕ either way, and
 *      the dot yields to it. Without this a dirty tab would have no ✕ at all.
 *
 * Rule 2 is also what stops the dot and the ✕ painting on top of each other
 * on an active dirty tab, which the pre-2026-08-23 rules allowed.
 *
 * Mutation-checked on 2026-08-23 — see the work log for what each printed.
 */

const SOURCE = readFileSync(new URL('../src/ui/TabBar.svelte', import.meta.url), 'utf8');

/** The `<style>` block, or nothing. Same shape as `cursor-affordance.test.ts`. */
function stylesheet(source: string): string {
  return /<style>([\s\S]*)<\/style>/.exec(source)?.[1] ?? '';
}

/**
 * Comments are blanked rather than dropped, and for the same reason as in
 * `cursor-affordance.test.ts`: this stylesheet argues in prose that contains
 * both braces and things a parser would read as declarations.
 */
function rules(css: string): [selector: string, body: string][] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => ' '.repeat(comment.length));
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => [
    match[1]!.trim().split(/\s+/).join(' '),
    match[2]!,
  ]);
}

/** One rule's selector list, split and trimmed. */
function selectors(rule: string): string[] {
  return rule
    .split(',')
    .map((one) => one.trim())
    .filter((one) => one.length > 0);
}

const TAB_BAR = rules(stylesheet(SOURCE));

/** The rule that makes the close glyph visible. There is exactly one. */
function revealRule(): string[] {
  const matches = TAB_BAR.filter(
    ([selector, body]) =>
      selector.includes('.close') &&
      selector.includes(':global(svg)') &&
      /opacity:\s*1\b/.test(body),
  );
  expect(matches).toHaveLength(1);
  return selectors(matches[0]![0]);
}

describe('the dirty tab close affordance', () => {
  it('reveals the glyph when the button itself is hovered or focused, dirty or not', () => {
    const revealed = revealRule();

    // The two that answer BUG-2. Neither may be narrowed to `:not(.dirty)`:
    // that is precisely the state the walk was in.
    expect(revealed).toContain('.close:hover :global(svg)');
    expect(revealed).toContain('.close:focus-visible :global(svg)');

    for (const selector of revealed) {
      if (selector.startsWith('.close:')) {
        expect(selector).not.toContain(':not(.dirty)');
      }
    }
  });

  it('yields the dot under exactly the conditions that reveal the glyph', () => {
    const yielded = TAB_BAR.filter(
      ([selector, body]) => selector.includes('.dot') && /opacity:\s*0\b/.test(body),
    );
    expect(yielded).toHaveLength(1);

    // Exactly, not merely including: a dot that yields on some third
    // condition would be a dirty tab that can lose its only unsaved signal
    // without the user aiming at the button.
    expect(selectors(yielded[0]![0]).sort()).toEqual([
      '.close:focus-visible .dot',
      '.close:hover .dot',
    ]);
  });

  it('keeps the tab-wide reveal guarded, so the dot and the glyph never paint together', () => {
    const fromTheTab = revealRule().filter((selector) => selector.startsWith('.tab'));

    // Both halves of "hovering anywhere on the tab" — the pointer, and the
    // active tab which reveals it without one.
    expect(fromTheTab).toHaveLength(2);
    for (const selector of fromTheTab) {
      expect(selector).toContain('.close:not(.dirty)');
    }
  });
});

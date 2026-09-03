import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Which things under the pointer say they can be pressed.
 *
 * `base.css` used to set `cursor: default` on `button` as well as on `body`,
 * on the argument at `body` that "the chrome is a native app surface, not a
 * document". That argument is right about text and surfaces and was wrong
 * about controls: a sweep of the running app on 2026-08-23 found 38 of the 39
 * interactive elements in the chrome showing the arrow, the sole exception
 * being a breadcrumb segment that had opted itself out. Five components had
 * done the same thing locally — `.nox-button`, `.head`, `.linkish`,
 * `.toggle`, `.where` — which is what a rule looks like when it is missing
 * from the place that should own it.
 *
 * The line is now between *controls* and *rows*, not between chrome and
 * document. A `<button>` is a thing you press. A list row is a thing you
 * select, and the five that behave that way — the explorer tree, the command
 * palette, search results, problems, references — plus tabs are `<div>`s that
 * also say so in their own CSS.
 *
 * This suite exists because the value is the rule being *uniform*. One
 * `cursor: default` added to a button in six months' time would be invisible
 * in review and would cost nothing to write; here it costs a line in the list
 * below and a sentence saying why the thing is not a control.
 *
 * Mutation-checked on 2026-08-23: adding `cursor: default` to
 * `Sidebar.svelte .rail-button` fails the first test, and adding any
 * `cursor: pointer` to a component fails the second.
 */

/** Every deliberate `cursor: default`, and what makes it not a button. */
const CURSOR_DEFAULT_USES: Record<string, string> = {
  // Rows you select rather than press. Six are `<div>`s carrying a `role`,
  // and all of them are the same decision. `TasksPanel` is the exception that
  // proves the rule rather than one against it: it is a real `<button>`, so
  // the base rule would have given it a pointer, and it opts out because
  // clicking it selects a task rather than running one.
  'CommandPalette.svelte .row': 'palette result row',
  'ExplorerPanel.svelte .row': 'file tree row, and a drag source',
  'ProblemsPanel.svelte .row': 'diagnostic row',
  'ReferencesPanel.svelte .row': 'reference row',
  'SearchPanel.svelte .row': 'search result row',
  'TasksPanel.svelte .row': 'task row: selects, and runs only on double click',
  'TabBar.svelte .tab': 'tab, and a drag source',

  // A native control that opens its own popup; the arrow is what every OS
  // draws over one.
  'SettingsPanel.svelte select': 'native select',

  // The status bar mixes controls and readouts. This is the readout half,
  // and the comment beside it records that the audit found the two
  // indistinguishable until you happened to hover one.
  'StatusBar.svelte .item.static': 'inert readout, not a control',

  // The two halves of the rule itself.
  'base.css body': 'the surface, which is where the native-app argument holds',
  'base.css button:disabled': 'a control that cannot be used must not offer to be',
};

/** The `<style>` block of a component, or the whole file for a stylesheet. */
function stylesheet(name: string, source: string): string {
  if (!name.endsWith('.svelte')) return source;
  return /<style>([\s\S]*)<\/style>/.exec(source)?.[1] ?? '';
}

/**
 * Comments come out first, and are replaced by spaces rather than removed:
 * these stylesheets argue their decisions in prose containing both braces and
 * things a parser would read as declarations.
 */
function rules(css: string): [selector: string, body: string][] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => ' '.repeat(comment.length));
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => [
    match[1]!.trim().split(/\s+/).join(' '),
    match[2]!,
  ]);
}

const sources: [name: string, source: string][] = [
  ...readdirSync(new URL('../src/ui/', import.meta.url))
    .filter((name) => name.endsWith('.svelte') && !name.endsWith('.stories.svelte'))
    .map(
      (name) =>
        [name, readFileSync(new URL(`../src/ui/${name}`, import.meta.url), 'utf8')] as [
          string,
          string,
        ],
    ),
  ['base.css', readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8')],
];

describe('cursor: default', () => {
  it('appears only where something is deliberately not a control', () => {
    const found = sources
      .flatMap(([name, source]) =>
        rules(stylesheet(name, source))
          .filter(([, body]) => /cursor:\s*default\b/.test(body))
          .map(([selector]) => `${name} ${selector}`),
      )
      .sort();

    expect(found).toEqual(Object.keys(CURSOR_DEFAULT_USES).sort());
  });

  /**
   * The other half. Five components had reached for `cursor: pointer`
   * themselves while `button` said otherwise, and every one of them was on a
   * `<button>` — so once the base rule is right, a local one is either
   * redundant or is pointing at something that is not a button and should be
   * explained here rather than in a component.
   */
  it('has no component re-stating the rule that base.css now owns', () => {
    const restated = sources
      .filter(([name]) => name !== 'base.css')
      .flatMap(([name, source]) =>
        rules(stylesheet(name, source))
          .filter(([, body]) => /cursor:\s*pointer\b/.test(body))
          .map(([selector]) => `${name} ${selector}`),
      );

    expect(restated).toEqual([]);
  });
});

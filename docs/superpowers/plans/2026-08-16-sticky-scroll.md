# Sticky Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the enclosing declaration on screen once its header has scrolled out of view.

**Architecture:** A pure function in `core/symbols.ts` decides which symbols pin, from the symbol list `fileSymbols` already produces. A CodeMirror extension in `editor/sticky.ts` renders them into a `showPanel` strip above the scroller, so CodeMirror owns the positioning. The extension is gated by `editor.stickyScroll` through the same compartment machinery `editor.codeFolding` uses.

**Tech Stack:** TypeScript, CodeMirror 6 (`showPanel`, `lineBlockAtHeight`), Lezer, Vitest.

**Spec:** [docs/superpowers/specs/2026-08-16-sticky-scroll-design.md](../specs/2026-08-16-sticky-scroll-design.md) — read it before Task 1. §4 (the rule that is easy to get wrong) and §6 (panel rather than overlay) are the two decisions most likely to look arbitrary without the reasoning.

## How this plan is written

**Interfaces, requirements and failing tests — not finished implementation bodies.** Signatures are given verbatim and later tasks depend on the names; behaviour is given as numbered requirements; tests are given in full and are the specification of record. What is withheld is the body between the signature and the closing brace.

The reason is on the record: a previous feature's plan carried finished code, the tests were written from that same block, and every code-level defect in the feature was already present in the plan. Write the body against the failing test. If you cannot satisfy a test, that is a finding to report — not a reason to edit the test.

## Global Constraints

- **Branch:** `sticky-scroll`. It exists and holds the spec commit 95056e2.
- **No new dependencies.** `package.json` byte-identical. Everything needed ships with `@codemirror/view` and `@codemirror/state`.
- **Do not run prettier.** This repo has no prettier config; running it rewrites files to double quotes against house style. Match by hand: single quotes, 2-space indent, semicolons.
- **No logic in components.** `src/ui/EditorPane.svelte` must not change — it already passes `buildExtensions(settings)` and needs to learn nothing.
- **Declarations only.** Whatever `core/symbols.ts` calls a symbol. Do not add rules, and do not read fold ranges.
- **TypeScript is strict**, including `noUncheckedIndexedAccess`. No `any`; use `unknown` and narrow.
- **Every test comment names the failure it prevents.** House style — see `tests/symbols.test.ts`. A test without that comment is incomplete.
- Run `npm test` and `npm run check` before every commit. Green on this branch's base: **814 tests, 33 files**, and `check` clean at 380.
- Do **not** run `npm run app` — Task 3 uses the browser target.

---

## File Structure

**New:**

| File | Responsibility |
|---|---|
| `src/editor/sticky.ts` | The extension: the panel, its update cycle, and the click handler. All CodeMirror, no rules. |
| `tests/sticky.test.ts` | `stickyRows` against real parses. Headless. |

**Modified:**

| File | Change |
|---|---|
| `src/core/symbols.ts` | `StickyRow` and `stickyRows` — the decision, beside `symbolListState` |
| `src/editor/extensions.ts` | A `sticky` compartment and its setting mapping |
| `src/services/config/schema.ts` | `editor.stickyScroll` |
| `README.md`, `CHANGELOG.md`, `ROADMAP.md`, `ARCHITECTURE.md` | Task 4 |

---

### Task 1: Which symbols pin

**Files:**
- Modify: `src/core/symbols.ts`
- Test: `tests/sticky.test.ts`

**Interfaces:**
- Consumes: `FileSymbol` and `fileSymbols` from `src/core/symbols.ts:22,235`; `Text` from `@codemirror/state`.
- Produces, and Task 2 depends on these exact names:
  - `export interface StickyRow { text: string; depth: number; from: number }`
  - `export function stickyRows(symbols: readonly FileSymbol[], topLine: number, doc: Text, max: number): StickyRow[]`

`topLine` is a **1-based line number**, matching `Text.line()`.

- [ ] **Step 1: Write the failing tests**

Create `tests/sticky.test.ts`:

```ts
import { parser as jsParser } from '@lezer/javascript';
import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { fileSymbols, stickyRows } from '../src/core/symbols';

const ts = jsParser.configure({ dialect: 'ts' });

/**
 * A class holding a method holding a loop. Three levels of source and two
 * levels of *symbol*, because the loop is not a declaration — which is what
 * makes it useful for pinning down that blocks do not pin.
 */
const SOURCE = [
  'class Service {', // 1
  '  async reveal(path) {', // 2
  '    for (const segment of path) {', // 3
  '      load(segment);', // 4
  '    }', // 5
  '  }', // 6
  '}', // 7
  '', // 8
  'function after() {}', // 9
].join('\n');

/** The rows at `topLine`, as "depth:text" strings. */
function rowsAt(source: string, topLine: number, max = 5): string[] {
  const doc = Text.of(source.split('\n'));
  const symbols = fileSymbols(ts.parse(source), doc);
  return stickyRows(symbols, topLine, doc, max).map((row) => `${row.depth}:${row.text}`);
}

describe('what stays pinned while scrolling', () => {
  /**
   * The failure this prevents: a strip that pins nothing, or that pins the
   * innermost thing only. Standing inside a method inside a class, both are
   * what you have lost off the top of the screen, and the order has to read
   * outermost-first so the strip nests the way the code does.
   */
  it('pins every enclosing declaration, outermost first', () => {
    expect(rowsAt(SOURCE, 4)).toEqual([
      '0:class Service {',
      '1:async reveal(path) {',
    ]);
  });

  /**
   * The failure this prevents, and it is the rule the whole feature rests on:
   * a declaration that is *still on screen* must not be pinned. Line 2 is
   * `async reveal(path) {` itself, so pinning it would print that line twice —
   * once in the strip and once in the document directly below — and cost a row
   * of editor height to say nothing.
   *
   * Wrong only at the boundary, which is why the boundary is the test. A rule
   * written as "contains the top line" instead of "starts above it" passes
   * every other case in this file.
   */
  it('does not pin a declaration whose own line is still visible', () => {
    expect(rowsAt(SOURCE, 2)).toEqual(['0:class Service {']);
  });

  /**
   * The line above: at the top of the file nothing has scrolled away yet, so
   * the strip is empty rather than pinning the class you can plainly see.
   */
  it('pins nothing at the first line of the file', () => {
    expect(rowsAt(SOURCE, 1)).toEqual([]);
  });

  /**
   * The failure this prevents: pinning a declaration you have scrolled *past*.
   * Line 9 is after `Service` has closed, so nothing encloses it — a rule that
   * tested only "starts above" and forgot "still open" would pin the class
   * here, naming a scope that ended two lines earlier.
   */
  it('pins nothing once the enclosing declaration has closed', () => {
    expect(rowsAt(SOURCE, 9)).toEqual([]);
  });

  /**
   * The failure this prevents: blocks creeping in. `for` is not a declaration
   * and `core/symbols.ts` does not collect it, so the strip must show two rows
   * here and not three. This is the shared-rule-table decision from the spec's
   * §2, asserted where a future change to the table would break it.
   */
  it('does not pin control blocks', () => {
    expect(rowsAt(SOURCE, 4)).toHaveLength(2);
  });

  /**
   * The failure this prevents: a row carrying the qualified name rather than
   * the source. `Service.reveal` is right for a searchable list; the line the
   * reader was looking at is what they are trying to recover, and it has to
   * arrive without its indentation because the strip supplies its own.
   */
  it('carries the declaration source line, trimmed, and where to jump to', () => {
    const doc = Text.of(SOURCE.split('\n'));
    const rows = stickyRows(fileSymbols(ts.parse(SOURCE), doc), 4, doc, 5);
    expect(rows[1]?.text).toBe('async reveal(path) {');
    // `from` addresses the declaration itself, so clicking a row lands on it.
    expect(doc.lineAt(rows[1]?.from ?? 0).number).toBe(2);
  });

  /**
   * The failure this prevents: an unbounded strip eating the editor on deeply
   * nested code. Truncating from the innermost keeps a contiguous run from the
   * outside in; dropping the outermost instead would leave an inner scope
   * floating with nothing to anchor it.
   */
  it('caps the rows, keeping the outermost', () => {
    const nested = [
      'class A {', // 1
      '  m() {', // 2
      '    function inner() {', // 3
      '      here();', // 4
      '    }', // 5
      '  }', // 6
      '}', // 7
    ].join('\n');
    expect(rowsAt(nested, 4, 3)).toHaveLength(3);
    expect(rowsAt(nested, 4, 2)).toEqual(['0:class A {', '1:m() {']);
  });

  /**
   * The failure this prevents: throwing on a file with no structure, which is
   * every plain-text file and every language with no parser. The strip is
   * empty; it is not an error.
   */
  it('returns nothing for a document with no symbols', () => {
    expect(rowsAt('const a = 1;\nconst b = 2;\n', 2)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/sticky.test.ts`
Expected: FAIL — `stickyRows` is not exported from `src/core/symbols.ts`, so the import throws.

- [ ] **Step 3: Write `StickyRow` and `stickyRows`**

Add to `src/core/symbols.ts`, beside `symbolListState`.

**Requirements:**

1. A symbol pins when its **start line is strictly above** `topLine` **and** its **end line is at or below** `topLine` — i.e. it is still open. Both halves; §4 of the spec and two of the tests above exist because either alone is wrong.
2. Line numbers come from `doc.lineAt(symbol.from).number` and `doc.lineAt(symbol.to).number`.
3. Rows come back outermost-first. `fileSymbols` returns document order, and for nested ranges document order *is* outermost-first — rely on that rather than sorting, and say so in a comment.
4. `depth` is the row's index in the returned list, 0 for the outermost.
5. `text` is `doc.lineAt(symbol.from).text.trim()`.
6. `from` is `symbol.from`.
7. When more than `max` symbols qualify, keep the **first** `max` — the outermost.
8. Pure: no CodeMirror view, no DOM, no `EditorState`. `Text` only, which this module already imports.
9. A doc comment explaining the "still visible" rule, in the voice of `symbolListState`'s. That rule is the thing a future reader will otherwise delete as redundant.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/sticky.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Measure the per-scroll cost**

Spec §11 leaves this open deliberately: the filter is O(symbols) and runs on every scroll frame. `stickyRows` is pure, so this is measurable headlessly — no browser, no guessing.

Add this to `tests/sticky.test.ts`. It parses **this repo's own `src/app.ts`** — 2,669 lines and the largest real file to hand — so the symbol count is realistic rather than invented:

```ts
import { readFileSync } from 'node:fs';

/**
 * Not a threshold test, and deliberately not an assertion about wall clock:
 * spec §11 asks whether the linear filter is worth replacing with a sorted
 * array and a binary search, and that question needs a number rather than an
 * opinion. `src/app.ts` is the largest real file in this repo, so its symbol
 * count is the one the answer should be based on.
 *
 * Prints rather than asserts. A wall-clock assertion here would be the same
 * bet `tests/symbols.test.ts` had to be rewritten to stop making — its comment
 * claimed ~40 chars/ms and a 60x margin against a measured ~2,437 chars/ms and
 * 3.5x.
 */
it('reports what one sticky recompute costs on a real file', () => {
  const source = readFileSync('src/app.ts', 'utf8');
  const doc = Text.of(source.split('\n'));
  const symbols = fileSymbols(ts.parse(source), doc);

  const start = performance.now();
  const ITERATIONS = 1000;
  for (let i = 0; i < ITERATIONS; i++) stickyRows(symbols, 1500, doc, 5);
  const perCall = (performance.now() - start) / ITERATIONS;

  console.log(`sticky: ${symbols.length} symbols, ${perCall.toFixed(4)} ms per recompute`);
  expect(symbols.length).toBeGreaterThan(50);
});
```

Run it and **read the number**: `npx vitest run tests/sticky.test.ts --reporter=verbose`

Then decide, and write the decision into `stickyRows`' doc comment with the measured figure:

- **Well under a frame (16 ms)** — leave the linear filter. Say so, with the number and the symbol count, so nobody optimises it later on a hunch.
- **Anywhere near a frame** — stop and report it before optimising. The sorted-array-plus-binary-search answer is known, but the spec says not to build it until a measurement asks.

- [ ] **Step 6: Verify the suite and types**

Run: `npm test` → expected **823 tests, 34 files** (8 behaviour tests plus the measurement).
Run: `npm run check` → clean, 0 errors, 0 warnings. Test output must be pristine apart from the one deliberate `console.log`.

- [ ] **Step 7: Commit**

```bash
git add src/core/symbols.ts tests/sticky.test.ts
git commit -m "Decide which declarations stay pinned"
```

---

### Task 2: The panel

**Files:**
- Create: `src/editor/sticky.ts`
- Modify: `src/editor/extensions.ts`
- Modify: `src/services/config/schema.ts`

**Interfaces:**
- Consumes: `stickyRows`, `StickyRow` from Task 1; `createSymbolCache` from `src/core/symbols.ts:292`; `syntaxTree` from `@codemirror/language`.
- Produces:
  - `export function stickyScrollExtension(enabled: boolean): Extension`

Mirrors `foldingExtension(enabled)` at `src/editor/folding.ts:71`, including returning `[]` when disabled.

- [ ] **Step 1: Add the setting**

In `src/services/config/schema.ts`, beside `editor.codeFolding` (line 212):

```ts
  'editor.stickyScroll': bool(true, {
    label: 'Sticky Scroll',
    description: 'Keep the enclosing function or class pinned above the editor.',
    category: 'Editor',
  }),
```

Match the surrounding entries' `label`/`description`/`category` shape exactly; read two neighbours before writing it.

- [ ] **Step 2: Write the extension**

Create `src/editor/sticky.ts`.

**Requirements:**

1. `stickyScrollExtension(false)` returns `[]`. Nothing mounts, nothing computes.
2. When enabled, contribute one `showPanel` value whose `PanelConstructor` builds a `Panel` with `{ dom, top: true, update }`.
3. `update(update)` recomputes when `update.docChanged`, `update.viewportMoved`, or `update.geometryChanged`. Anything else must not recompute — scrolling already arrives as one of these, and recomputing on every transaction is the difference between amortised and not.
4. The first visible line is `view.lineBlockAtHeight(view.scrollDOM.scrollTop - view.documentTop)`; its line number comes from `view.state.doc.lineAt(block.from).number`. (Superseded: `documentTop` is a screen coordinate that goes more negative as the document scrolls, so subtracting it double-counts the scroll offset rather than cancelling it; the correct call is `view.lineBlockAtHeight(view.scrollDOM.scrollTop)` — see the design doc's §6. This step's expression was the pre-implementation estimate; it stays as a record of what was believed at the time.)
5. Symbols come from a module-level `createSymbolCache()` over `syntaxTree(view.state)` and `view.state.doc`. **Do not call `ensureSyntaxTree`** — that spends a parse budget, and the palette can afford it on a keystroke while a scroll frame cannot. An unparsed region yields no symbols and an empty strip, which is the honest answer.
6. `MAX_ROWS = 5`, a module constant. Not a setting — spec §7.
7. Each row is a `<button>` carrying the row's text, indented by `depth`. Clicking it dispatches a selection at `row.from` with `EditorView.scrollIntoView(row.from, { y: 'start' })`.
8. With no rows, the panel's DOM is emptied and contributes **no height**. Do not stop providing the constructor — that reconfigures the editor, and this happens on ordinary scrolling.
9. Styling comes from tokens (`--nox-*`), consistent with `editor/theme.ts` and the panels already in the app. No hard-coded colours.
10. The panel must not steal focus. Clicking a row moves the selection; the editor keeps the cursor.

- [ ] **Step 3: Wire it to a compartment**

In `src/editor/extensions.ts`:

1. Add `sticky: new Compartment()` to the `compartments` object (line 43).
2. Add the `'sticky'` case to `compartmentContent`, returning `stickyScrollExtension(s['editor.stickyScroll'])` — mirroring the `'folding'` case at line 150.
3. Add `'editor.stickyScroll': ['sticky']` to `SETTING_TO_COMPARTMENTS` (line 62), so toggling reconfigures the live view rather than rebuilding state.

- [ ] **Step 4: Verify**

Run: `npm test` → expected 823 tests, 34 files. No new tests here; the panel is not testable (spec §10).
Run: `npm run check` → clean.

If `check` reports an unused import or an incompatible `Panel` shape, fix the code — do not widen a type to silence it.

- [ ] **Step 5: Commit**

```bash
git add src/editor/sticky.ts src/editor/extensions.ts src/services/config/schema.ts
git commit -m "Pin the enclosing declaration above the editor"
```

---

### Task 3: Walk it, and measure the thing the spec left unmeasured

**Files:** none changed unless the walk finds something.

The panel has no automated coverage by design. This task is where it is actually verified, and where spec §11's open question is answered.

- [ ] **Step 1: Start the browser target**

Use the `nox-web` dev server (port 1420). Do **not** run `npm run app`.

If port 1420 is already taken by another session's server, that server is serving this same working tree — open `http://localhost:1420` rather than fighting for the port.

- [ ] **Step 2: Walk the feature**

Open a long file from the demo project — one with a class containing methods — and check each of these:

1. Scroll until a method's header leaves the top. Its row appears, under its class's row.
2. Scroll back so the header is visible again. The row disappears. This is §4's rule with your own eyes.
3. Scroll past the end of the class. The strip empties, and the editor's first line sits directly under the tab bar with no reserved gap.
4. Click a row. The editor scrolls to that declaration.
5. Open a plain-text or unparsed file. No strip, no gap.
6. Toggle **Sticky Scroll** in Settings. The strip appears and disappears without the editor losing scroll position or cursor.
7. The last line of a document is reachable and not hidden behind the strip.

- [ ] **Step 3: Record what you saw**

Write the walk's results and the measurement into the task report, including anything that looked wrong. A walk that reports only "it works" is a walk that was not taken.

- [ ] **Step 4: Fix what the walk found**

If steps 2 or 3 turned up a defect, fix it here with a test where one is possible, and note where one is not.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Verify sticky scroll in the browser target"
```

If nothing changed, skip the commit and say so.

---

### Task 4: Documentation

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `ROADMAP.md`, `ARCHITECTURE.md`

- [ ] **Step 1: Changelog**

Under `## [Unreleased]` → `### Added`. Read the neighbouring entries first for voice: a headline sentence, then sub-bullets for the things that surprise. Worth saying: it shows declarations, not blocks; it is off-able; it costs a strip of height rather than floating.

- [ ] **Step 2: Roadmap**

`ROADMAP.md`'s v0.3 table has a **Sticky scroll** row. This repo's convention is to annotate in place — see **Terminal** *(shipped early)* — or to move the row into the "✅ Shipped in v0.3" table beside **Go to symbol**. Match whichever the file is actually doing for a completed v0.3 item; do not invent a third style.

- [ ] **Step 3: README**

Only if the README lists editor features at this level of detail. Check first — if sticky scroll would be the only entry of its size, leave it out and say why in the report.

- [ ] **Step 4: Architecture**

`ARCHITECTURE.md` §4 holds the key design decisions. Add the two worth recording: that the strip is a panel rather than an overlay and why, and that the decision of what pins is a pure function in `core/` for the same reason `symbolListState` is.

Do **not** add a §7 debt row. The untested-panel boundary is already covered by the CodeMirror row added for the component harness; a second row saying the same thing dilutes the table.

- [ ] **Step 5: Verify and commit**

Run `npm test` and `npm run check`.

```bash
git add -A
git commit -m "Write down what sticky scroll shows and why it is a panel"
```

- [ ] **Step 6: Open the PR**

```bash
git push -u origin sticky-scroll
```

Lead the PR body with what §4's rule is and why the boundary test exists, and state plainly that the panel has no automated coverage and was verified by walking it — including the measurement from Task 3.

---

## What this plan does not do, deliberately

- **No control blocks.** Spec §2. Do not add fold-range reading "while you are in there".
- **No depth setting.** Spec §7. `MAX_ROWS` is a constant until someone hits it with a real file.
- **No overlay.** Spec §6. The panel trade was made with its cost stated.
- **No `ensureSyntaxTree`.** Task 2 requirement 5. A scroll frame cannot spend a parse budget.
- **No change to `EditorPane.svelte`.** It already passes `buildExtensions(settings)`.

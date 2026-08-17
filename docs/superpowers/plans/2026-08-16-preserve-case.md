# Preserve Case on Replace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replacing `Scheduler` with `dispatcher` gives `Dispatcher`, in both replace panels.

**Architecture:** One pure function in `core/replace.ts` decides the cased replacement from the matched text. Both replace surfaces then compute through `core/replace.ts` — the project path already does, and the editor path is migrated off `@codemirror/search`'s `replaceNext`/`replaceAll` so the two can no longer diverge.

**Tech Stack:** TypeScript, CodeMirror 6 (`SearchCursor`, `EditorView`), Svelte 5, Vitest.

**Spec:** [docs/superpowers/specs/2026-08-16-preserve-case-design.md](../specs/2026-08-16-preserve-case-design.md) — read it before Task 1. §5 (why both paths share one implementation) and §7 (why the rule applies *after* regex expansion) are the two decisions that look arbitrary without the reasoning.

## How this plan is written

**Interfaces, requirements and failing tests — not finished implementation bodies.** Signatures are verbatim and later tasks depend on the names; behaviour is numbered requirements; tests are given in full and are the specification of record. The body between the signature and the closing brace is yours to write against a failing test.

If you cannot satisfy a test, that is a finding to report — not a reason to edit the test.

## Global Constraints

- **Branch:** `preserve-case`. It exists and holds the spec commit 50d50db.
- **`tests/replace.test.ts` must not be edited.** Its 43 tests are the evidence that the shared path still behaves as it did. If one needs changing, stop and report — that is a finding, not a licence.
- **No new dependencies.** `package.json` byte-identical.
- **Do not run prettier.** Single quotes, 2-space indent, semicolons, matched by hand.
- TypeScript strict, `noUncheckedIndexedAccess`. **No `any`**, no casts.
- **Every test comment names the failure it prevents.** House style — see `tests/symbols.test.ts`.
- Run `npm test` and `npm run check` before every commit. Green on this branch's base: **825 tests, 34 files**, check clean at 382.
- Do **not** run `npm run app`. Task 4 uses the browser target.
- **Replace is destructive.** `core/replace.ts`'s own header says it is "the part that can destroy work". Prefer reporting a doubt over guessing.

---

## File Structure

**New:**

| File | Responsibility |
|---|---|
| `tests/preserve-case.test.ts` | The rule, and the option through `computeReplacements`. Headless. |

**Modified:**

| File | Change |
|---|---|
| `src/core/replace.ts` | `preserveCase`, and a `preserveCase` option on `computeReplacements` |
| `src/services/search.ts` | `preserveCase` on `SearchOptions`, threaded to `computeReplacements` |
| `src/ui/SearchPanel.svelte` | The `AB` toggle |
| `src/editor/find.ts` | Replace commands built on `core/replace.ts`; `preserveCase` on `FindOptions` |
| `src/ui/FindPanel.svelte` | The `AB` toggle |
| `README.md`, `CHANGELOG.md`, `ROADMAP.md`, `ARCHITECTURE.md` | Task 5 |

---

### Task 1: The rule

**Files:**
- Modify: `src/core/replace.ts`
- Test: `tests/preserve-case.test.ts`

**Interfaces:**
- Produces, and Tasks 2–3 depend on these exact names:
  - `export function preserveCase(matched: string, replacement: string): string`
  - `computeReplacements`'s options object gains `preserveCase?: boolean` (default `false`)

- [ ] **Step 1: Write the failing tests**

Create `tests/preserve-case.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeReplacements, preserveCase } from '../src/core/replace';

describe('shaping a replacement to the case it is replacing', () => {
  /**
   * The failure this prevents: the whole feature. A case-insensitive search
   * finds three spellings and replaces them with one, and the user then fixes
   * the capitals by hand — which is the work the search was supposed to save.
   */
  it('follows the three patterns it recognises', () => {
    expect(preserveCase('scheduler', 'dispatcher')).toBe('dispatcher');
    expect(preserveCase('SCHEDULER', 'dispatcher')).toBe('DISPATCHER');
    expect(preserveCase('Scheduler', 'dispatcher')).toBe('Dispatcher');
  });

  /**
   * The failure this prevents: lower-casing the remainder of the replacement,
   * which turns `dispatcherService` into `Dispatcherservice`. Capitalized
   * means "make the first character upper", not "make everything else lower".
   */
  it('leaves the rest of the replacement alone when capitalising', () => {
    expect(preserveCase('Scheduler', 'dispatcherService')).toBe('DispatcherService');
  });

  /**
   * The failure this prevents: guessing at a shape that is not one of the
   * three. Irregular casing is deliberate often enough that rewriting it is
   * worse than leaving it, and there is no rule that would be right.
   */
  it('leaves an irregularly cased match verbatim', () => {
    expect(preserveCase('sChEdUlEr', 'dispatcher')).toBe('dispatcher');
    expect(preserveCase('scheduleR', 'dispatcher')).toBe('dispatcher');
  });

  /**
   * The failure this prevents, and it is the one that reaches real files: a
   * string with no letters equals both its upper- and lower-cased form. A
   * rule written as `matched === matched.toUpperCase()` alone upper-cases
   * every replacement in a numeric or punctuation search.
   */
  it('leaves a match with no letters verbatim', () => {
    expect(preserveCase('123', 'dispatcher')).toBe('dispatcher');
    expect(preserveCase('---', 'Dispatcher')).toBe('Dispatcher');
    expect(preserveCase('', 'dispatcher')).toBe('dispatcher');
  });

  /**
   * The failure this prevents: an ordering bug the spec did not settle. `S`
   * satisfies "all upper" *and* "first upper, rest lower" — its rest is
   * empty, which is trivially lower. Capitalized is checked first, so one
   * capital letter reads as a capitalised word rather than a shout. `SS` has
   * a non-lower remainder and so is unambiguous.
   */
  it('treats a single capital as capitalised, not as all-upper', () => {
    expect(preserveCase('S', 'dispatcher')).toBe('Dispatcher');
    expect(preserveCase('SS', 'dispatcher')).toBe('DISPATCHER');
    expect(preserveCase('s', 'dispatcher')).toBe('dispatcher');
  });

  /** An empty replacement has no case to shape, and must not throw. */
  it('handles an empty replacement', () => {
    expect(preserveCase('SCHEDULER', '')).toBe('');
  });
});

describe('preserve case through a replace run', () => {
  const text = 'scheduler\nScheduler\nSCHEDULER\nsChEdUlEr\n';
  const matcher = () => /scheduler/gi;

  /**
   * The failure this prevents: applying one shape to the whole run instead of
   * one shape per match. The point of the feature is that a single
   * replacement string comes out differently on each line.
   */
  it('shapes each match independently', () => {
    const result = computeReplacements(text, matcher(), 'dispatcher', { preserveCase: true });
    expect(result.text).toBe('dispatcher\nDispatcher\nDISPATCHER\ndispatcher\n');
    expect(result.count).toBe(4);
  });

  /**
   * The failure this prevents: the option changing behaviour when it is off.
   * `tests/replace.test.ts`'s 43 tests all run without it, so this pins that
   * the default path is untouched by the feature's existence.
   */
  it('changes nothing when the option is off', () => {
    const result = computeReplacements(text, matcher(), 'dispatcher');
    expect(result.text).toBe('dispatcher\ndispatcher\ndispatcher\ndispatcher\n');
  });

  /** A mixed-case match is verbatim even when the replacement expands. */
  it('leaves an expanded replacement alone for a mixed-case match', () => {
    const result = computeReplacements('SCHEDULER_service\n', /(\w+)_service/g, '$1_client', {
      expand: true,
      preserveCase: true,
    });
    expect(result.text).toBe('SCHEDULER_client\n');
  });

  /**
   * The failure this prevents: casing the *template* instead of the expanded
   * string — spec §7's order.
   *
   * Worth knowing why this test uses a named group, because the obvious
   * version does not work. For `$1` and `$&` the two orders agree: those
   * tokens survive `toUpperCase()` unchanged, and an ALL-UPPER match has
   * ALL-UPPER captures, so upper-casing before or after expansion lands in
   * the same place. A test built on `$1` would pass against both orders and
   * prove nothing.
   *
   * A named group is where they diverge. Casing the template rewrites
   * `$<word>` to `$<WORD>`, which names a group that does not exist, and
   * `expandReplacement` resolves an unknown name to the empty string — so the
   * captured text vanishes rather than being cased. That is silent data loss
   * in the part of the codebase that can destroy work.
   */
  it('applies the rule to the expanded replacement, not the template', () => {
    const result = computeReplacements('SCHEDULER\n', /(?<word>SCHED)ULER/g, '$<word>_x', {
      expand: true,
      preserveCase: true,
    });
    expect(result.text).toBe('SCHED_X\n');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/preserve-case.test.ts`
Expected: FAIL — `preserveCase` is not exported from `src/core/replace.ts`, so the import throws.

- [ ] **Step 3: Write `preserveCase` and the option**

**Requirements:**

1. Pattern precedence, in this order, and the order is load-bearing: **all lower → Capitalized → ALL UPPER → verbatim.** `S` matches two of them and Capitalized must win; see the test above.
2. "Has letters" is a precondition for every pattern. A match with no letters is verbatim. `/[a-zA-Z]/` is not sufficient for non-ASCII — prefer comparing `toUpperCase()` and `toLowerCase()` forms, which differ only when a string contains a cased letter in any script.
3. all lower: `matched === matched.toLowerCase()` → `replacement.toLowerCase()`.
4. Capitalized: first character equals its own upper-case form, and the remainder equals its own lower-case form → upper-case the replacement's first character and **leave the remainder as typed**.
5. ALL UPPER: `matched === matched.toUpperCase()` → `replacement.toUpperCase()`.
6. Anything else, and an empty `matched` → `replacement` unchanged.
7. `computeReplacements` applies it **after** `expandReplacement`, to the expanded string, with `found[0]` as the matched text. Spec §7.
8. The option defaults to `false` and must not alter any existing behaviour when unset.
9. A doc comment carrying the precedence and the reason for the after-expansion order. Both are things a future reader would otherwise "simplify".

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/preserve-case.test.ts` — expected PASS, 10 tests.

- [ ] **Step 5: Prove the existing suite is untouched**

Run: `npx vitest run tests/replace.test.ts`
Expected: **43 passing, unchanged.** If any fails, stop and report — the shared path has changed behaviour and that is the thing this task must not do.

- [ ] **Step 6: Verify and commit**

Run `npm test` → expected **835 tests, 35 files**. Run `npm run check` → clean.

```bash
git add src/core/replace.ts tests/preserve-case.test.ts
git commit -m "Shape a replacement to the case it is replacing"
```

---

### Task 2: The project path end to end

**Files:**
- Modify: `src/services/search.ts`, `src/ui/SearchPanel.svelte`

**Interfaces:**
- Consumes: `preserveCase` option on `computeReplacements` from Task 1.
- Produces: `preserveCase` on `SearchOptions` (`src/services/search.ts:22`), togglable via the existing `toggle()` method.

This task ends with ⌘⇧F replace working end to end. It is deliberately the easy half, because it needs no new machinery.

- [ ] **Step 1: Add the option**

1. Add `preserveCase: boolean` to `SearchOptions` (`src/services/search.ts:22`), defaulting to `false` where the other options are defaulted (`:54`).
2. Extend the `toggle()` key union (`:100`) to include `'preserveCase'`.
3. Thread it into the `computeReplacements` call so replacement uses it.

- [ ] **Step 2: Add the toggle**

In `src/ui/SearchPanel.svelte`, beside the existing case/word/regex toggles. Follow `src/ui/FindPanel.svelte:89-93` exactly for shape: `class:on`, `aria-pressed`, `onclick={() => …toggle('preserveCase')}`. Label `AB`, with a `title` naming what it does.

Read the surrounding markup before writing — match its structure rather than inventing one.

- [ ] **Step 3: Verify**

Run `npm test` → 835 tests. Run `npm run check` → clean.

No new automated tests here: the option's behaviour is Task 1's, and the toggle is markup. If you find yourself wanting a test for the wiring, that is a signal the wiring has logic in it — report that rather than testing markup.

- [ ] **Step 4: Commit**

```bash
git add src/services/search.ts src/ui/SearchPanel.svelte
git commit -m "Offer preserve case in the project search panel"
```

---

### Task 3: Move the editor path onto the shared implementation

**Files:**
- Modify: `src/editor/find.ts`, `src/ui/FindPanel.svelte`

This is the task the spec exists for, and the risky one. `src/editor/find.ts` has **no tests**. Read spec §5 and §6 before starting.

**Interfaces:**
- Consumes: `computeReplacements` and its `preserveCase` option from Task 1.
- Produces: `preserveCase` on `FindOptions` (`src/editor/find.ts:24`).

- [ ] **Step 1: Understand what you are replacing**

Read `replaceNext` and `replaceAll` in `node_modules/@codemirror/search/dist/index.js` before writing anything. Write down, in your report, what each does about:

- which match is replaced when the selection is already on one, versus when it is not;
- what happens at the end of the document — whether it wraps;
- where the selection lands afterwards;
- whether it scrolls the result into view.

**You are taking over these behaviours.** A list you did not write is a list you will not reproduce.

- [ ] **Step 2: Add the option**

Add `preserveCase: boolean` to `FindOptions` (`:24`), defaulted false alongside the others (`:46-50`), and extend the `toggle()` key union.

- [ ] **Step 3: Replace the commands**

Replace the `replaceNext`/`replaceAll` imports (`:4-5`) with commands built on `core/replace.ts`.

**Requirements:**

1. `replaceEvery()` computes edits for the whole document through `computeReplacements`, honouring `caseSensitive`, `wholeWord`, `regexp` and `preserveCase`, and dispatches them as **one** transaction — so one ⌘Z undoes the whole replace, as it does today.
2. `replaceCurrent()` replaces the match at the selection if there is one, then advances to the next; if the selection is not on a match, it advances first and replaces nothing. Whichever the library does, per Step 1 — match it.
3. Wrapping at the end of the document behaves as it does today.
4. The result is scrolled into view, and the selection lands where it does today.
5. An invalid regex must not throw or destroy anything — `FindStatus.invalidPattern` already exists for this; keep it working.
6. Zero-width matches stay skipped. `core/replace.ts` already does this deliberately; do not add a second rule.

- [ ] **Step 4: Add the toggle**

In `src/ui/FindPanel.svelte`, beside the existing toggles at `:89-99`, same shape as Task 2's.

- [ ] **Step 5: Verify**

Run `npm test` → 835 tests, and **`tests/replace.test.ts`'s 43 must still pass**. Run `npm run check` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/editor/find.ts src/ui/FindPanel.svelte
git commit -m "Compute the editor's replacements where the project's are computed"
```

---

### Task 4: Walk it

Per spec §9 this is **not optional and not a formality**. Task 3 took over destructive behaviour in a file with no automated coverage, and this is the only thing that checks it.

- [ ] **Step 1: Start the browser target**

Use the `nox-web` dev server (port 1420). Do not run `npm run app`. If the port is taken by another session's server, that server serves this same working tree — open `http://localhost:1420` rather than fighting for it.

- [ ] **Step 2: Walk the editor path (⌘F)**

On a file with several matches in mixed case:

1. Replace one match. The right match changes, and only it.
2. Replace again. It advances rather than replacing the same one twice.
3. Replace at the last match — it wraps to the first.
4. Put the cursor on a match, then replace: it replaces *that* one.
5. Replace All: one ⌘Z takes the whole thing back.
6. Turn `AB` on: `scheduler`, `Scheduler` and `SCHEDULER` each come back correctly shaped.
7. Type an invalid regex with regex mode on: it reports rather than throwing, and replaces nothing.

- [ ] **Step 3: Walk the project path (⌘⇧F)**

1. Replace across files with `AB` on — each match keeps its own shape.
2. One ⌘Z takes the project replace back, as it did before.

- [ ] **Step 4: Record and fix**

Write what you saw into the report, including anything that looked wrong. A walk reporting only "it works" is a walk that was not taken. If a step fails, fix it here — with a test where one is possible, and a note where one is not.

- [ ] **Step 5: Commit**

Skip if nothing changed, and say so.

---

### Task 5: Documentation

**Files:** `CHANGELOG.md`, `ROADMAP.md`, `README.md`, `ARCHITECTURE.md`

- [ ] **Step 1: Changelog**

Under `## [Unreleased]` → `### Added`. Read the neighbours for voice. Worth saying: which three shapes it recognises, that irregular casing is left alone deliberately, that it is off by default, and that it now works in both panels.

- [ ] **Step 2: Roadmap**

Move **Preserve case on replace** from v0.3's pending table into `### ✅ Shipped in v0.3`, matching how **Go to symbol** is written there.

- [ ] **Step 3: Architecture**

`ARCHITECTURE.md` §4. Record the decision that matters beyond this feature: **both replace paths now compute through `core/replace.ts`**, so regex expansion, zero-width handling and edit ordering cannot diverge between the two panels. Note what the editor path still owns — which match, wrapping, scrolling — and that it has no automated coverage.

Do **not** add a §7 debt row for that; §7 already records the untested-editor-view boundary.

- [ ] **Step 4: README**

Only if it lists features at this level of detail. Check first; if it would be the odd entry out, leave it and say why in the report.

- [ ] **Step 5: Verify and commit**

`npm test` and `npm run check`. Do **not** push or open a PR — the controller handles that.

---

## What this plan does not do, deliberately

- **No per-segment camel/snake mapping.** Spec §2.
- **No gating of `AB` on `caseSensitive`.** Spec §8 — independent, because a rule to explain is worse than a predictable one.
- **No harness for `editor/find.ts`.** Out of scope; the walk is the coverage, and the spec says so.
- **No edits to `tests/replace.test.ts`.** It is the evidence, not the work.

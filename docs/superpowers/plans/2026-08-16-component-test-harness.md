# Component Test Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mount a Svelte component in a test with a real `NoxApp` in context, and pin the two shipped defects that no test could reach.

**Architecture:** One `VITEST`-gated line in `vite.config.ts` makes Svelte resolve to its client build; a per-file `// @vitest-environment jsdom` docblock opts individual suites into a DOM while `environment: 'node'` stays the default for the other 30. A wrapper component calls the real `provideApp`, so tests reach services through the same door every component uses, and the app they get is a real `NoxApp` over `MemoryPlatform` rather than a stub.

**Tech Stack:** TypeScript, Svelte 5 (runes, `mount`/`flushSync`), Vitest 4, jsdom 29. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-08-16-component-test-harness-design.md](../specs/2026-08-16-component-test-harness-design.md) — read it before Task 1. §5 (why the app is constructed but not booted) and §7 (why `EditorPane` is out of scope) are the two decisions most likely to look wrong without the reasoning.

## How this plan is written, and why it differs from the last one

**This plan carries interfaces, requirements and failing tests — not finished
implementation bodies.** That is deliberate and is the newest lesson in this
repo: every code-level defect in the last feature was present in its plan's
finished code block, and the tests were written from that same block, so TDD
had nothing independent to check against.

So, for each unit you will build:

- The **exact signatures and types** are given. Use them verbatim; later tasks
  depend on the names.
- The **behavioural requirements** are given as a numbered list. Each one is a
  thing the implementation must do.
- The **tests are given in full**, and they are the specification of record.

What is *not* given is the body between the signature and the closing brace.
Write it yourself against the failing test. If you find yourself unable to
satisfy a test, that is a finding to report — not a reason to edit the test.

## Global Constraints

- **Branch:** `component-test-harness`. It exists, is cut from `origin/main`
  at 81e0126, and holds the spec commit 5b710dc.
- **No new dependencies.** `package.json` must be byte-identical at the end.
  jsdom 29.1.1 and svelte 5.56.9 are already installed.
- **Do not run prettier.** This repo has no prettier config, is not a
  dependency, and has no format script; running it rewrites files to double
  quotes against house style. Match surrounding code by hand: single quotes,
  2-space indent, semicolons.
- **Do not modify `src/ui/AnswersPanel.svelte`.** The tests are written against
  the fixed component as it stands. If a test seems to require changing it,
  stop and report — that is a finding, not a licence.
- **TypeScript is strict**, including `noUncheckedIndexedAccess`. No `any`; use
  `unknown` and narrow.
- **Every test comment names the failure it prevents.** This is house style —
  see `tests/symbols.test.ts` throughout. A test without that comment is
  incomplete.
- Run `npm test` and `npm run check` before every commit. Both are green on
  this branch's base: **797 tests, 30 files, 1.04s**, and `check` clean.
- Do **not** run `npm run app`. Nothing in this plan needs the bundled app.

---

## File Structure

**New:**

| File | Responsibility |
|---|---|
| `tests/support/Harness.svelte` | Puts a real `NoxApp` into Svelte context via `provideApp`, then renders the component under test. Nothing else. |
| `tests/support/component.ts` | Builds the app, mounts through the harness, hands back the container and a teardown. The only module a component suite imports for setup. |
| `tests/answers-panel.test.ts` | What `AnswersPanel` renders: ordering, resting states, the empty state, the prose filter. |

Neither support file is collected as a suite — the include glob is
`tests/**/*.test.ts` and neither matches. Do not name them `*.test.ts`.

**Modified:**

| File | Change |
|---|---|
| `vite.config.ts:9` | One gated `resolve.conditions` line |
| `tests/answers.test.ts:476` | One sentence that this work makes false (Task 4) |
| `CONTRIBUTING.md` | §Testing, per spec §9 (Task 4) |
| `ARCHITECTURE.md` | §7, the twenty-first row (Task 4) |
| `CHANGELOG.md` | Task 4 |

`tests/answers.test.ts:476` is **not** in the spec's §11 file list. It was found
while writing this plan: that line claims the runtime's order is "pinned at the
only level this repo can test it", which this work makes false. Task 4 Step 3
corrects it.

---

### Task 1: Make a component mountable

**Files:**
- Create: `tests/support/Harness.svelte`
- Create: `tests/support/component.ts`
- Create: `tests/answers-panel.test.ts`
- Modify: `vite.config.ts:9`

**Interfaces:**
- Consumes: `provideApp` from `src/ui/context.ts:6`; `NoxApp` from `src/app.ts:138` (public constructor taking a `Platform`); `MemoryPlatform` from `src/platform/memory.ts:27`.
- Produces, and Tasks 2–3 depend on these exact names:
  - `export interface Mounted { container: HTMLElement; app: NoxApp; platform: MemoryPlatform; unmount(): void }`
  - `export function mountComponent(Component: Component<Record<string, never>>, options?: { app?: NoxApp }): Mounted`
  - `export function flush(): void`

- [ ] **Step 1: Write the failing test**

Create `tests/answers-panel.test.ts`. The docblock on the first line is what
gives this file a DOM; without it `document` is undefined.

```ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import AnswersPanel from '../src/ui/AnswersPanel.svelte';
import { flush, mountComponent } from './support/component';

describe('the answers panel with nothing in it', () => {
  /**
   * The failure this prevents: the `{#if answers.length === 0}` branch being
   * inverted or dropped by a later edit, so a user who has never asked
   * anything gets an empty box instead of the sentence telling them how to
   * ask. It is also the first thing that proves the harness itself works —
   * a component that mounts at all has reached `useApp()` through real
   * context.
   */
  it('tells you how to ask instead of rendering an empty list', () => {
    const { container, unmount } = mountComponent(AnswersPanel);
    flush();

    expect(container.querySelector('.empty')).not.toBeNull();
    expect(container.querySelector('.list')).toBeNull();
    expect(container.querySelector('.empty')?.textContent).toContain('Explain Selection');

    unmount();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/answers-panel.test.ts`

Expected: FAIL — `tests/support/component.ts` does not exist, so the import
throws.

- [ ] **Step 3: Add the config line**

Modify `vite.config.ts`. The `resolve` block currently opens at line 9 with
`alias`. Add `conditions` as its first key:

```ts
  resolve: {
    // Svelte publishes a server build, and the default conditions resolve to
    // it — under which `mount()` throws `lifecycle_function_unavailable`.
    // Gated on VITEST so the app's own build resolves exactly as it did.
    conditions: process.env.VITEST ? ['browser'] : [],
    alias: {
```

Leave `test.environment` as `'node'`. That is deliberate: the 30 existing
suites keep their environment by construction, and only files carrying the
docblock get a DOM.

- [ ] **Step 4: Write the harness component**

Create `tests/support/Harness.svelte`.

**Requirements:**

1. Takes two props: `app: NoxApp`, and `component: Component<Record<string, never>>` — the component to render.
2. Calls `provideApp(app)` at component init. It must go through `src/ui/context.ts`, **not** by exporting `KEY` and passing a `context` Map to `mount`. `KEY` is module-private on purpose; widening that API for the tests' benefit is the thing this indirection exists to avoid.
3. Renders the passed component with no props.
4. Must not emit the `state_referenced_locally` compiler warning. Reading a `$props()` value directly at init draws it. `npm run check` is clean today and this must not be what changes that. `untrack` from `svelte` is one way; there are others.
5. No markup of its own — no wrapper `<div>`, no styles. Tests query the component's own classes, and a wrapper element would be one more thing between the test and what it is asserting.

- [ ] **Step 5: Write the mount helper**

Create `tests/support/component.ts`.

**The exact interface:**

```ts
import type { Component } from 'svelte';
import type { NoxApp } from '../../src/app';
import type { MemoryPlatform } from '../../src/platform/memory';

export interface Mounted {
  /** The element the component rendered into. Query this, not `document`. */
  container: HTMLElement;
  /** The same app the component is reading through context. */
  app: NoxApp;
  /** The app's platform, for seeding files with `mkdirp` / `seedFile`. */
  platform: MemoryPlatform;
  /** Tears the component down, running its `$effect` cleanups. */
  unmount(): void;
}

/**
 * Mount `Component` with a real app in context.
 *
 * Pass `app` to drive the same app the component is reading from; omit it and
 * one is built. See the spec's §5 — the app is constructed, not booted.
 */
export function mountComponent(
  Component: Component<Record<string, never>>,
  options?: { app?: NoxApp },
): Mounted;

/** Settle Svelte's reactivity. `flushSync`, named for what a test means by it. */
export function flush(): void;
```

**This is narrower than the spec's §4, deliberately.** The spec's signature
carried a `props?: P` option and a `component: Exports` field on `Mounted`.
Neither has a consumer: `AnswersPanel` takes no props, and no test in this plan
reads a component's exports. A generic parameter that is only ever
`Record<string, never>` is a type that documents a capability nobody has asked
for. Both are one line to add the day a component test needs them, against a
real caller rather than an imagined one. If you disagree, the spec's wider
signature is the approved one and this note is the thing to reject.

**Requirements:**

1. When no `app` is given, build `new NoxApp(new MemoryPlatform())`. **Not `NoxApp.create()`** — it calls `createPlatform()` (`src/platform/index.ts:17`), which under jsdom returns `WebPlatform` with no way to substitute, then boots a demo workspace through `pickFolder()`.
2. Create a fresh container element and append it to `document.body`. A detached container works for querying but not for focus, and `AnswersPanel` has a focus effect.
3. Mount `Harness` into the container, passing the app and the component.
4. `unmount()` must call Svelte's `unmount` **and** remove the container from `document.body`. jsdom's `document` persists across tests in a file; a container left behind means the next test's `container.querySelector` can be satisfied by the previous test's DOM.
5. `flush()` is `flushSync` from `svelte`, re-exported under a name that says what a test wants from it.
6. Every exported symbol carries a doc comment. This file is read by everyone who writes the next component test.

**On the `Component<Record<string, never>>` annotation:** it is what a
props-free Svelte 5 component should satisfy, but `npm run check` is the
authority, not this plan. If it rejects the annotation, widen it to what
typechecks and leave a comment saying what you found — do not reach for `any`,
which the Global Constraints rule out.

**Spec §10's two properties are covered by construction, not by extra tests.**
Mounting fails loudly with "Nox context is missing — component rendered outside
`<App>`" if requirement 2 is wrong, which is the recognisable failure §10 asks
for. And every test in Task 2 calls `unmount()`, so `AnswersPanel`'s focus
effect has its teardown run. A separate suite asserting that `mountComponent`
returns a container would restate its implementation, which `CONTRIBUTING.md:106`
rules out.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/answers-panel.test.ts`
Expected: PASS, 1 test.

If you see `Svelte error: lifecycle_function_unavailable — mount(...) is not
available on the server`, Step 3 was skipped or the gate is wrong.

- [ ] **Step 7: Verify nothing else moved**

Run: `npm test`
Expected: 798 tests, 31 files, all passing. The 30 existing files must still
be at 797 between them.

Run: `npm run check`
Expected: clean, and **no** `state_referenced_locally` warning.

- [ ] **Step 8: Commit**

```bash
git add vite.config.ts tests/support tests/answers-panel.test.ts
git commit -m "Let a test mount a component and give it a real app"
```

---

### Task 2: Pin what the panel renders

**Files:**
- Modify: `tests/answers-panel.test.ts`

**Interfaces:**
- Consumes: `mountComponent`, `flush`, `Mounted` from Task 1.
- Produces: nothing later tasks import. Task 3 runs these tests against historical code.

Everything here drives the **real** `AgentRuntime` on the mounted app through
`ScriptedProvider` and `ProviderTransport`, which are real in-repo
implementations rather than mocks — `provider.ts:65` calls `ScriptedProvider`
"the reference implementation of the interface".

Note the chunk shape: **`{ type: 'text', text }`**. It is `type`, not `kind`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/answers-panel.test.ts`, and extend the import at the top of
the file to include what these need:

```ts
import { ScriptedProvider } from '../src/services/agent/provider';
import { ProviderTransport, type AgentSession } from '../src/services/agent/runtime';
```

Then:

```ts
/** A provider that answers with `text` and stops. */
const speaks = (text: string) =>
  new ProviderTransport(new ScriptedProvider(() => [{ type: 'text' as const, text }]));

/** A provider that finishes having said nothing — the resting state that is not "working". */
const silent = () => new ProviderTransport(new ScriptedProvider(() => []));

/** A provider that never finishes, so the session stays running until cancelled. */
const hangs = () =>
  new ProviderTransport(
    new ScriptedProvider(async function* () {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }),
  );

/** Wait for a session to stop running. Mirrors `settle` in tests/answers.test.ts. */
async function settle(session: AgentSession, budgetMs = 10_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (session.status.get() === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The text of every element matching `selector`, in document order. */
const textsOf = (container: HTMLElement, selector: string): (string | null)[] =>
  [...container.querySelectorAll(selector)].map((node) => node.textContent);

describe('the order the answers panel renders in', () => {
  /**
   * The failure this prevents, and it shipped: the panel carried a
   * `.reverse()` whose own comment said it existed to produce newest-first,
   * and which instead produced exactly the oldest-first list it named. Three
   * reviews read past it; a walk against a real model found it.
   *
   * `tests/answers.test.ts` pins that the *runtime* publishes newest-first,
   * and that test passed throughout the bug — the runtime was never wrong.
   * The reversal was in the component, which is why the contract has to be
   * asserted again at the level that consumes it. This is the test that could
   * not exist before there was a harness.
   */
  it('puts the newest answer at the top', async () => {
    const { container, app, unmount } = mountComponent(AnswersPanel);

    const older = app.agents.start(speaks('the older answer'), 'asked first', {
      expects: 'prose',
    });
    await settle(older);
    const newer = app.agents.start(speaks('the newer answer'), 'asked second', {
      expects: 'prose',
    });
    await settle(newer);
    flush();

    expect(textsOf(container, '.question')).toEqual(['asked second', 'asked first']);
    // Asserted on the bodies too, so a change that reorders the questions
    // without their answers cannot pass this.
    expect(textsOf(container, '.body')).toEqual(['the newer answer', 'the older answer']);

    unmount();
  });
});

describe('what the panel says when there is no answer', () => {
  /**
   * The failure this prevents, and it shipped: the template branched on
   * `answer === null`, which is also the resting state of a session that
   * finished and said nothing — reachable when a local model returns only
   * whitespace, or when an out-of-process agent ignores `expects`. Those
   * sessions rendered "Working…" forever, claiming work was going on after it
   * had stopped.
   */
  it('says a finished session said nothing, rather than that it is working', async () => {
    const { container, app, unmount } = mountComponent(AnswersPanel);

    const session = app.agents.start(silent(), 'explain this', { expects: 'prose' });
    await settle(session);
    flush();

    expect(textsOf(container, '.state')).toEqual(['The model finished without saying anything.']);

    unmount();
  });

  /**
   * The second state behind the same branch. A cancelled session also has a
   * null answer, and telling the user it is working is the same lie.
   */
  it('says a cancelled session was cancelled', async () => {
    const { container, app, unmount } = mountComponent(AnswersPanel);

    const session = app.agents.start(hangs(), 'take your time', { expects: 'prose' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    session.cancel();
    await settle(session);
    flush();

    expect(textsOf(container, '.state')).toEqual(['Cancelled before it answered.']);

    unmount();
  });

  /**
   * The true case, kept so that the fix for the two above cannot be "delete
   * the branch". A session that really is running must still say so.
   */
  it('says Working… while the session is actually running', async () => {
    const { container, app, unmount } = mountComponent(AnswersPanel);

    const session = app.agents.start(hangs(), 'take your time', { expects: 'prose' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    flush();

    expect(session.status.get()).toBe('running');
    expect(textsOf(container, '.state')).toEqual(['Working…']);

    session.cancel();
    await settle(session);
    unmount();
  });

  /**
   * The failure this prevents: a resting-state branch broad enough to swallow
   * real answers, which would turn every answered question into a sentence
   * about having said nothing.
   */
  it('renders the answer when there is one', async () => {
    const { container, app, unmount } = mountComponent(AnswersPanel);

    const session = app.agents.start(speaks('It adds two numbers.'), 'what does this do?', {
      expects: 'prose',
    });
    await settle(session);
    flush();

    expect(textsOf(container, '.body')).toEqual(['It adds two numbers.']);
    expect(container.querySelector('.state')).toBeNull();

    unmount();
  });
});

describe('which sessions the answers panel is for', () => {
  /**
   * The failure this prevents: the answers column filling with the agent
   * sessions that belong in the agents panel. The two panels read the same
   * `agents.sessions` list and are separated only by this filter — the panel
   * is for reading prose, and a session that was never asked for prose has no
   * answer to read.
   */
  it('ignores sessions that were not asked for prose', async () => {
    const { container, app, unmount } = mountComponent(AnswersPanel);

    const ordinary = app.agents.start(speaks('some narration'), 'do a thing');
    await settle(ordinary);
    flush();

    expect(container.querySelector('.empty')).not.toBeNull();
    expect(textsOf(container, '.question')).toEqual([]);

    unmount();
  });
});
```

- [ ] **Step 2: Run them**

Run: `npx vitest run tests/answers-panel.test.ts`

Expected: **PASS, 7 tests.** These are written against the fixed component, so
they should pass immediately. This is the one place in this plan where a
passing test on first run is the expected outcome — Task 3 is what proves they
are worth anything.

If any fails, do not edit `AnswersPanel.svelte`. Report it: either the test is
wrong, or you have found a real defect, and both are findings.

- [ ] **Step 3: Verify the suite and the types**

Run: `npm test`
Expected: 804 tests, 31 files, all passing.

Run: `npm run check`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add tests/answers-panel.test.ts
git commit -m "Pin what the answers panel renders, not just what the runtime publishes"
```

---

### Task 3: Prove the tests would have caught the defects

**Files:**
- Modify: `tests/answers-panel.test.ts` (comments only)

This task is the acceptance criterion for the entire design. A harness whose
tests only pass against today's code proves nothing about tomorrow's.

`8abb2ba` is the answers panel's first commit and contains **both** defects:
the `.reverse()` and the `{:else if session.answer === null}` branch.

- [ ] **Step 1: Put the pre-fix component in place**

```bash
git show 8abb2ba:src/ui/AnswersPanel.svelte > /tmp/answers-prefix.svelte
cp src/ui/AnswersPanel.svelte /tmp/answers-current.svelte
cp /tmp/answers-prefix.svelte src/ui/AnswersPanel.svelte
```

- [ ] **Step 2: Run the tests and capture the failures verbatim**

Run: `npx vitest run tests/answers-panel.test.ts`

Expected: **FAIL.** At minimum `puts the newest answer at the top` and `says a
finished session said nothing, rather than that it is working` must fail.
Copy the actual assertion output — the real text, not a paraphrase.

Some other tests may also fail against the old component, and some may error
rather than assert cleanly if the old markup differs. Record what actually
happened for each.

**If either of those two tests passes against `8abb2ba`, stop.** That test does
not catch the defect it claims to, and the design's acceptance criterion is not
met. Report it rather than proceeding.

- [ ] **Step 3: Restore the current component**

```bash
cp /tmp/answers-current.svelte src/ui/AnswersPanel.svelte
git diff --stat src/ui/AnswersPanel.svelte
```

Expected: no output from `git diff` — the file is byte-identical to what it was.
If it is not, restore with `git checkout -- src/ui/AnswersPanel.svelte`.

- [ ] **Step 4: Run again to confirm green**

Run: `npx vitest run tests/answers-panel.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the captured output into the test comments**

Add the verbatim failure to the doc comment of each test that was proven,
after the existing "The failure this prevents" paragraph. House style already
names the failure a test prevents; this makes that naming verified rather than
asserted. Format:

```
   * Verified against 8abb2ba, the commit that shipped it: this assertion
   * fails there with
   *   AssertionError: expected [ 'asked first', 'asked second' ]
   *   to deeply equal [ 'asked second', 'asked first' ]
```

Use the output you actually captured in Step 2. Do not retype it from this
plan — the text above is an illustration of the shape, and the real assertion
output is the thing worth having.

- [ ] **Step 6: Verify and commit**

Run: `npm test` — expected 804 tests, 31 files.
Run: `npm run check` — expected clean.

```bash
git add tests/answers-panel.test.ts
git commit -m "Record that these tests fail against the code that shipped the bugs"
```

---

### Task 4: Write down the boundary and the conventions

**Files:**
- Modify: `ARCHITECTURE.md` §7 (currently 20 rows, ending line 1273)
- Modify: `CONTRIBUTING.md:98-117` (§Testing)
- Modify: `tests/answers.test.ts:476`
- Modify: `CHANGELOG.md`

The spec's §7 argument is that the missing harness was invisible partly because
it was unwritten. Leaving the next boundary unwritten repeats that exactly.

- [ ] **Step 1: Add the §7 row**

Append one row to the `## 7. Known debt` table in `ARCHITECTURE.md`, matching
the voice of the twenty above it — each states the trade and why it was taken.
It must say: jsdom has no layout engine, so `EditorPane` and anything that
measures the document cannot be mounted; geometry-free components are covered;
faking measurements would test invented geometry; the real fix is a
browser-mode runner, which costs a browser download in CI on every push.

- [ ] **Step 2: Amend the testing conventions**

In `CONTRIBUTING.md`:

1. `:100` says "Tests run in Node with no DOM." That is no longer true. It must say that Node with no DOM is the default, and that a suite opts into a DOM with `// @vitest-environment jsdom` on its first line.
2. `:106` says what not to test: "component markup, CSS, or anything whose test would just restate the implementation." **Keep this policy — do not relax it.** Add the distinction the harness needs and no more: rendered behaviour and branch selection, yes; markup and styling, no. Asserting that the newest answer renders first is ordering, not markup. Asserting a `font-weight` is still worthless.
3. Add the grouping convention with its reason: component suites are named after the component and grouped by component, not split per behaviour, because each jsdom file costs ~260–300 ms of environment setup against a suite that currently runs in 1.04s in total.
4. The existing two habits at `:112` and `:115` stay as they are. The `MemoryPlatform` habit is what the harness is built on.

- [ ] **Step 3: Correct the sentence this work makes false**

`tests/answers.test.ts:476` currently ends: "This is the fact the panel now
depends on, pinned at the only level this repo can test it."

That was true when written and is not now. Correct it to say the runtime
contract is pinned here and the panel's honouring of it is pinned in
`tests/answers-panel.test.ts` — and that the runtime test passed throughout the
`.reverse()` bug, which is why both levels are needed. This repo corrects
documents that vouched for something no longer true rather than leaving them
(see commit 551c242).

- [ ] **Step 4: Changelog**

Add an entry in the existing format. It is a testing change with one
inert-outside-tests config line, and no user-visible behaviour change — say so
rather than dressing it up.

- [ ] **Step 5: Verify and commit**

Run: `npm test` — expected 804 tests, 31 files.
Run: `npm run check` — expected clean.

```bash
git add ARCHITECTURE.md CONTRIBUTING.md CHANGELOG.md tests/answers.test.ts
git commit -m "Write down what the harness reaches, and what it does not"
```

- [ ] **Step 6: Open the PR**

```bash
git push -u origin component-test-harness
```

The PR body should lead with the acceptance criterion — that the tests were run
against `8abb2ba` and failed — and quote the captured output from Task 3. That
is the evidence the whole design rests on, and it belongs where a reviewer sees
it first.

---

## What this plan does not do, deliberately

Named here so that nobody reads their absence as an oversight:

- **`EditorPane` is not tested.** jsdom has no layout. Spec §7.
- **The other 25 components get no tests.** The harness is justified by the two defects it provably catches, not by coverage.
- **No `bootForTest()` on `NoxApp`.** The app is constructed, not booted (spec §5). If a later test genuinely needs booted state, that is when to add it — with the argument in front of you, not speculatively now.
- **No permanent pre-fix fixture or checkout script.** The proof is taken once, in Task 3, and recorded in the comments.

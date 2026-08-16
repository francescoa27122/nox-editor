# Component test harness — design

Mount a Svelte component in a test, hand it a real `NoxApp`, and assert on what
it rendered.

Status: approved 2026-08-16. Implementation follows in a separate plan.

There are 27 components in `src/ui/` and no test has ever mounted one. This is
the first piece of work in this repo whose justification is entirely defects
that already shipped, so §1 names them rather than arguing from coverage.

Everything below was measured against this repo on 2026-08-16 — the vitest and
Svelte behaviour by building four throwaway probes, running them, reading the
output, and deleting them. Where a number appears it was read off a run, not
recalled. The one place a probe contradicted the expected design is marked in
§4.

## 1. Why this, and what it is not

Four defects in the last two features reached a human because no test could
reach them first:

| Defect | What it was | How it was found |
|---|---|---|
| Answers listed oldest-first | A `.reverse()` in `AnswersPanel.svelte`, whose own comment said it existed to prevent that | Walking the app |
| A finished session said "Working…" forever | A template branch on `answer === null`, which is also the resting state of a session that said nothing | Writing documentation |
| ⌘R before a grammar loaded claimed the file had no symbols | The window in which `EditorPane`'s dynamic import has not resolved | Walking the app |
| The provenance gutter tooltip answered nothing for a release | Fixed in PR #9 | Driving a browser by hand |

Each cost a build-and-walk cycle to find and another to verify. The first two
are pure component logic — no geometry, no native platform — and a test that
mounted the component would have caught both in a millisecond.

**It is not a browser-mode runner**, not an end-to-end suite, and not a
coverage push across all 27 components. It is the smallest thing that makes a
component's rendered behaviour assertable, plus the two regression tests that
justify it.

**What makes it affordable:** every dependency it needs is already installed,
and the app is already constructible without a real filesystem. §3 is the
whole argument for the size of this.

## 2. Scope

In:

- One gated line in `vite.config.ts` (§4).
- `tests/support/Harness.svelte` and `tests/support/component.ts`.
- `tests/answers-panel.test.ts` — the regression tests for the first two
  defects above, each verified to fail against the pre-fix code.
- The conventions written into `CONTRIBUTING.md`, and the boundary written
  into `ARCHITECTURE.md` §7.

Out, and deliberately:

- **`EditorPane` and anything embedding CodeMirror.** jsdom has no layout
  engine. §7 says what that costs and why the alternatives are worse.
- **A browser-mode runner.** Real geometry means a new heavyweight
  devDependency and a browser download in CI on every push, against a repo
  deliberately lean at ~4 MB. It is the right fix for §7's row when that row
  is worth paying for; it is not worth paying for to test a list that renders
  newest-first.
- **A testing library.** `@testing-library/svelte` would be a new dependency
  for a `render` and a `screen` this design does not need — §4 gets both from
  `svelte` itself.
- **A sweep across the other 25 components.** A harness is justified by the
  tests it makes possible, and two tests that provably catch two shipped
  defects justify it better than twenty that restate markup.
- **Testing markup or CSS.** `CONTRIBUTING.md:106` rules those out today and
  continues to. §9 draws the line this work needs and no more.

## 3. What already exists

Verified, not assumed. This is the reason the harness is four small pieces.

| Seam | Where | What it gives us |
|---|---|---|
| Context injection | `src/ui/context.ts:6` | `provideApp(app)` — the one door every component uses to reach services |
| A constructible app | `src/app.ts:138` | `constructor(platform: Platform)` is public and takes a platform, so no injection seam has to be invented |
| A real in-memory platform | `src/platform/memory.ts:27` | "A real implementation, not a stub — if a service works here it works against a disk." Already the double for every service spec |
| A real model provider double | `src/services/agent/provider.ts:75` | `ScriptedProvider`, with `ProviderTransport` from `agent/runtime` |
| The driving pattern | `tests/answers.test.ts:24-52` | `setup()` builds real services over `MemoryPlatform`; `settle()` waits on a session's status |
| jsdom | `package.json` devDependencies | Already installed at 29.1.1. Nothing to add |
| `mount` with context | `svelte@5.56.9` `MountOptions` | `context?: Map<any, any>`, and `flushSync()` to settle reactivity |

The gap was never a missing tool. It was one line of config and a wrapper
component.

## 4. The four pieces

### The config line

```ts
resolve: {
  conditions: process.env.VITEST ? ['browser'] : [],
  ...
}
```

**This is the one thing a probe contradicted.** The expectation was that
`environment: 'jsdom'` would be sufficient. It is not: with the DOM present and
this line absent, `mount()` throws

```
Svelte error: lifecycle_function_unavailable
`mount(...)` is not available on the server
  ❯ mount node_modules/svelte/src/index-server.js:25:4
```

Svelte publishes a server build and the default conditions resolve to it. The
`VITEST` gate means the app's own build resolves exactly as it does today —
outside a test run the array is empty, so `npm run build` and `npm run app:build`
are provably untouched.

It has to be the Vite-level knob: vitest 4 exposes no `test.resolve`, checked
against the installed config surface.

### The environment, per file

```ts
// @vitest-environment jsdom
```

`environment: 'node'` stays the default in `vite.config.ts`, so all 30 existing
suites keep the environment they have by construction rather than by care.
`environmentMatchGlobs` was removed in vitest 4 — confirmed absent from the
installed build — but the docblock works: measured, a file carrying it got a
DOM, and a file without it still asserted `typeof document === 'undefined'` in
the same run.

### `tests/support/Harness.svelte`

A wrapper that calls `provideApp(app)` and renders the component under test.

`mount()` accepts a `context` Map directly, which would remove the need for a
wrapper — but `KEY` in `context.ts:4` is a module-private `Symbol`. Exporting
it to make tests work would widen a deliberately narrow API for the tests'
benefit. The wrapper goes through the same `provideApp` every component goes
through, so what the tests exercise is the real context path.

**One known wrinkle to resolve, not to ship:** the probe wrapper drew
`state_referenced_locally` from the Svelte compiler for reading a `$props()`
value at init. It is benign — context is set once, at init, which is the only
time `setContext` is legal — but `npm run check` is clean today and this must
not be the thing that changes that.

### `tests/support/component.ts`

The signatures the plan is written against. Bodies are the plan's job, not this
document's:

```ts
interface Mounted<Exports = unknown> {
  container: HTMLElement;
  app: NoxApp;
  platform: MemoryPlatform;
  component: Exports;
  unmount(): void;
}

/** Mount `Component` with a real app in context. Builds one if not given. */
function mountComponent<P extends Record<string, unknown>>(
  Component: unknown,
  options?: { props?: P; app?: NoxApp },
): Mounted;

/** Settle Svelte's reactivity. `flushSync`, named for what a test means by it. */
function flush(): void;
```

Neither support file is collected as a suite: the include glob is
`tests/**/*.test.ts`, and neither matches.

## 5. The app the harness hands you is real, and is not booted

`new NoxApp(new MemoryPlatform())`. Measured: it constructs under jsdom and
`AnswersPanel` mounts against it.

This is `MemoryPlatform`'s precedent applied one layer up. `CONTRIBUTING.md:112`
already requires testing against it "not a mock … so a passing test means the
behaviour works rather than that a stub was configured correctly". A hand-written
`NoxApp` stub would fail that standard on day one and drift from the real one by
the second feature.

**Deliberately not `NoxApp.create()`.** It calls `createPlatform()`
(`src/platform/index.ts:17`), which under jsdom returns `WebPlatform` with no
way to substitute, then boots a demo workspace through `pickFolder()`. Tests
would start from a fixture nobody chose.

**The cost, stated here rather than discovered later:** `#boot()` is private and
does not run. Config load, agent-config load, notes load, session restore, theme
application and window title never happen. The harness gives you a *constructed*
app, not a booted one. Tests needing files seed the platform with
`mkdirp`/`seedFile`, exactly as the 30 existing suites do. A test that needs
booted state must arrange it explicitly, and if that becomes common the honest
answer is a `bootForTest()` on `NoxApp` — not a harness that quietly half-boots.

## 6. What the tests assert, and how they are proven

`tests/answers-panel.test.ts`, driving the real `AgentRuntime` through
`ScriptedProvider` and `ProviderTransport`. Assertions read the DOM through the
classes the component already uses — `.question`, `.state`, `.body`, `.empty`.

| Test | The failure it prevents |
|---|---|
| Newest answer first | The shipped `.reverse()`. Measured today: two sessions render `["question two","question one"]` |
| A session that finished having said nothing says so | The shipped "Working…", which claimed work was still going on after it had stopped |
| A cancelled session says it was cancelled | Same branch, second state |
| "Working…" appears only while a session is running | That the fix for the above did not simply delete the true case |
| An answer with a body renders it | That the resting branch does not swallow real answers |
| No prose sessions renders the empty state | The `{#if answers.length === 0}` branch, which a later edit can silently invert |
| Non-prose sessions are filtered out | The `expects === 'prose'` filter — the agents panel's sessions must not appear here |

### The pre-fix proof

The acceptance criterion for this whole design is that these tests fail against
the code that shipped the defects. Both are recoverable from `8abb2ba`, the
panel's first commit, which contains the `.reverse()` and the
`{:else if session.answer === null}<p class="working">Working…</p>` branch
together.

The proof is taken once, during implementation: check `8abb2ba`'s
`AnswersPanel.svelte` over the current one, run the two tests, capture the
verbatim failure, restore, re-run green. **The captured output goes into each
test's comment.** House style already names the failure a test prevents; this
makes that naming verified rather than asserted:

```
 * Verified against 8abb2ba: this assertion fails with
 *   AssertionError: expected [ 'question one', 'question two' ]
 *   to deeply equal [ 'question two', 'question one' ]
```

No permanent mechanism. Committed pre-fix fixtures would freeze two dead
component versions into the repo to rot against the next refactor of the real
one, and a scripted checkout harness is new tooling with its own failure modes
for a proof that only needs taking once.

## 7. What this does not reach

**Two of §1's four defects, not four.** The grammar-loading defect and the
provenance gutter tooltip both live behind `EditorPane` and the editor layer,
which jsdom cannot mount. This design does not touch them and does not claim to.

The reason is layout: CodeMirror needs real geometry, and jsdom implements none.
The available workaround — stubbing `getBoundingClientRect` and friends — is
rejected. Every measurement would be a number invented here, so the tests would
pass against geometry the real app never has. That is the drifting-stub failure
§5 rejects, one layer down and harder to see.

This becomes a new row in `ARCHITECTURE.md` §7, which today has twenty and
mentions none of this:

> **Components embedding CodeMirror are untested** — jsdom has no layout engine,
> so `EditorPane` and anything that measures the document cannot be mounted in a
> test. Geometry-free components are covered (see `tests/support/`). Faking the
> measurements would test invented geometry, so the real fix is a browser-mode
> runner, which costs a browser download in CI on every push.

That §7 said nothing about any of this is part of why the harness was missing:
the gap was real, load-bearing, and unwritten. `ARCHITECTURE.md:586` and the
go-to-symbol spec's §10 each note in passing that this repo has no harness —
both while explaining why something had to be designed around it. Leaving the
next boundary unwritten would repeat the mistake exactly.

## 8. Cost

Measured, not estimated.

| | |
|---|---|
| Baseline | 797 tests, 30 files, 1.04s |
| jsdom environment setup | ~260–300 ms per file carrying the docblock |
| New dependencies | None |
| Lines of production code changed | One, in `vite.config.ts`, inert outside tests |

The per-file environment cost is the first fixed per-file cost in this suite,
and it is the one thing here that scales badly: twenty component files would
cost more in setup than the entire current suite costs in total. So the
convention is written down now rather than rediscovered at twenty — **component
suites are grouped by component, not split per behaviour**, and a new one is
worth a new file only when it tests a different component.

## 9. The policy this changes

`CONTRIBUTING.md:100` says "Tests run in Node with no DOM." That stops being
true for the files that opt in, and the sentence has to say so.

`CONTRIBUTING.md:106` says what not to test: "component markup, CSS, or anything
whose test would just restate the implementation." **That policy is kept, not
relaxed.** The line it draws is exactly right, and none of §6's tests crosses
it: asserting that the newest answer renders first is not markup, it is
ordering. Asserting that a finished session does not say "Working…" is not CSS,
it is which branch was taken. A test asserting that `.question` is
`font-weight: semibold` would still be worthless, and is still ruled out.

The amendment names the distinction — **rendered behaviour and branch selection,
yes; markup and styling, no** — and adds the two conventions this design
establishes: the `@vitest-environment jsdom` docblock, and grouping component
suites by component.

## 10. Testing the harness itself

The harness is tested by the tests it carries; a separate suite asserting that
`mountComponent` returns a container would restate its implementation.

Two properties are worth pinning inside `tests/answers-panel.test.ts` because
they would otherwise fail confusingly:

- Mounting provides context. Without it `useApp()` throws "Nox context is
  missing", which is the failure mode of a broken harness and should be
  recognisable rather than mysterious.
- `unmount` runs, so a component's `$effect` teardown is exercised at least
  once. `AnswersPanel` has a focus effect; a harness that never unmounts would
  never run its cleanup.

## 11. Files

New:

- `tests/support/Harness.svelte`
- `tests/support/component.ts`
- `tests/answers-panel.test.ts`

Changed:

- `vite.config.ts` — one gated `resolve.conditions` line
- `CONTRIBUTING.md` — §Testing, per §9
- `ARCHITECTURE.md` — §7, the new row per §7 above
- `CHANGELOG.md`

Not changed, and deliberately:

- `src/ui/AnswersPanel.svelte`. The tests are written against the fixed
  component as it stands. If a test requires touching it, that is a finding
  worth reporting, not a licence to edit until green.
- `package.json`. Nothing is added.

## 12. A note for the plan

The plan that follows this carries **interfaces and failing tests, not finished
implementations**. Every code-level defect in the last feature was present in
the plan's finished code block, and the tests were written from that same block,
so TDD had nothing independent to check against. §4's signatures and §6's table
are the contract; the bodies are written against failing tests, in that order.

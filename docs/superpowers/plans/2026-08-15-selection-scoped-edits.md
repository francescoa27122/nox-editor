# Selection-scoped model edits — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command that asks a local model to change the selected text, with the answer landing in the existing review panel and hunks outside the selection starting unkept.

**Architecture:** Composition, not new machinery. The session, audit trail, provenance, permission model, cancellation and the stale-read guard all come from `AgentRuntime`; the result lands in `ReviewService`. Two real additions: the selection reaches the model through `AgentRuntime.brief()`, and a scope makes out-of-selection hunks default to unkept.

**Tech Stack:** TypeScript (strict), Svelte 5 runes, CodeMirror 6, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-15-selection-scoped-edits-design.md`

## Global Constraints

- Branch off `main`. Everything this needs is already there — the stale-read guard and `runnableAgents` both landed with the provider work.
- **Logic in services; components only render.** `app.ts` is the composition root, not a component.
- **Nothing may be added to `src/services/config/schema.ts`.** The size cap is a constant, not a setting.
- **`command.execute` is not in the agent's vocabulary.** Do not add it.
- Comments explain **why**, not what. **Every test carries a comment naming the failure it prevents.**
- Files are UTF-8.
- Verify commands: `npm run check`, `npm test` (703 today), `cargo test --manifest-path src-tauri/Cargo.toml` (38 today).
- Commit after every task. Do not push.

**Merge hazard: resolved.** PR #4 merged and this branch was rebased onto it, so the `baseRevisions` declaration check now sits immediately above the code Task 3 edits. Line references below were re-checked after that rebase. Gates at the rebased base: check clean 367 files, `npm test` 703, `cargo test` 38.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/services/review.ts` | `ReviewScope` type; `stage()` takes an optional scope and defaults out-of-scope hunks to unkept | 2 |
| `src/services/agent/runtime.ts` | `brief()` carries the selection; `SessionOptions.scope`; `scopeFromSelection()`; passes scope to `stage()` | 1, 3 |
| `src/ui/ReviewPanel.svelte` | Renders "outside your selection" on hunks flagged out of scope | 2 |
| `src/app.ts` | The command, the selection→scope capture, and the shared session tail both agent commands use | 4 |
| `tests/review.test.ts` | Scope defaulting and the overlap rule | 2 |
| `tests/agent.test.ts` | `brief()` content; `scopeFromSelection`; scope threaded end to end | 1, 3 |

---

### Task 1: `brief()` carries the selection

**Files:**
- Modify: `src/services/agent/runtime.ts` (the `brief()` method, currently at `:376-386`)
- Test: `tests/agent.test.ts`

**Interfaces:**
- Consumes: `ContextService.selection(id)` → `SelectionInfo | null`, whose `ranges[]` carry `{ from, to, fromLine, toLine, text }` with **1-based** line numbers, and `isEmpty`.
- Produces: nothing later tasks import. Task 4 relies on the behaviour only.

- [ ] **Step 1: Write the failing tests**

Add to `tests/agent.test.ts`. `workspace.setSelection(id, { ranges: [[from, to]], main: 0 })` is how the existing suite makes a selection (see `tests/context.test.ts:90`), and `setup()` already opens `a.txt`, returning its id as `a`.

**First, one harness change:** `setup()` does not currently return `platform`, and the truncation test needs it to seed a large file. Add `platform` to its returned object — it is already a local in that function, so this is one word, and adding a key breaks no existing caller.

```ts
describe('the brief', () => {
  // A model told only "a.txt, 5 lines" cannot act on "make this shorter" —
  // the selection is the whole subject of a selection-scoped edit.
  it('names the selected range and quotes its text', async () => {
    const { runtime, workspace, a } = await setup();
    workspace.setSelection(a, { ranges: [[4, 13]], main: 0 });

    const brief = runtime.brief();
    expect(brief).toContain('Selected in a.txt, lines 2–3:');
    expect(brief).toContain('two\nthree');
  });

  // A bare cursor is not a selection. Quoting the empty string would tell the
  // model it had been given something when it had not.
  it('says nothing about a selection when the cursor is empty', async () => {
    const { runtime, workspace, a } = await setup();
    workspace.setSelection(a, { ranges: [[4, 4]], main: 0 });

    expect(runtime.brief()).not.toContain('Selected in');
  });

  // Silent truncation lets a model answer as though it had the whole
  // selection, and be confidently wrong about the part it never saw.
  it('truncates a selection past the cap and says that it did', async () => {
    const { runtime, workspace, platform } = await setup();
    platform.seedFile('/w/big.txt', 'x\n'.repeat(500));
    const id = (await workspace.open('/w/big.txt'))!;
    workspace.setSelection(id, { ranges: [[0, 1000]], main: 0 });

    const brief = runtime.brief();
    expect(brief).toContain('truncated');
    expect(brief.split('\n').length).toBeLessThan(260);
  });

  // Multi-range semantics are out of scope; sending every range would let the
  // model edit somewhere the primary cursor never was.
  it('carries only the primary range when several are selected', async () => {
    const { runtime, workspace, a } = await setup();
    workspace.setSelection(a, { ranges: [[0, 3], [4, 13]], main: 1 });

    const brief = runtime.brief();
    expect(brief).toContain('two\nthree');
    expect(brief).not.toContain('Selected in a.txt, lines 1–1');
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/agent.test.ts -t 'the brief'`
Expected: FAIL — `brief()` produces no `Selected in` line.

- [ ] **Step 3: Implement**

Add near the top of `src/services/agent/runtime.ts`, beside the other module constants:

```ts
/**
 * How much selected text the brief will carry.
 *
 * Past this a "selection" is a file, and sending it spends context window and
 * local inference time on text nobody asked about. Not a setting: a
 * preference whose wrong value silently degrades model output is a preference
 * that should not exist.
 */
const SELECTION_MAX_LINES = 200;
const SELECTION_MAX_CHARS = 8_000;

/**
 * Clip selected text to the cap, saying so when it clips.
 *
 * The marker is not decoration. A model handed a fragment with no sign that
 * it is a fragment answers as though it had the whole thing.
 */
function clipSelection(text: string): string {
  const lines = text.split('\n');
  let out = text;
  let truncated = false;

  if (lines.length > SELECTION_MAX_LINES) {
    out = lines.slice(0, SELECTION_MAX_LINES).join('\n');
    truncated = true;
  }
  if (out.length > SELECTION_MAX_CHARS) {
    out = out.slice(0, SELECTION_MAX_CHARS);
    truncated = true;
  }
  return truncated ? `${out}\n…truncated: this is only the start of the selection.` : out;
}
```

Then extend `brief()`, inside the existing `if (active) { … }` block, after the viewport line:

```ts
      const selection = this.#context.selection(active.id);
      const range = selection && !selection.isEmpty ? selection.ranges[selection.main] : undefined;
      if (range) {
        lines.push(
          `Selected in ${active.name}, lines ${range.fromLine}–${range.toLine}:`,
          clipSelection(range.text),
        );
      }
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/agent.test.ts -t 'the brief'`
Expected: PASS, 4 tests.

- [ ] **Step 5: Gates and commit**

```bash
npm run check && npm test
git add src/services/agent/runtime.ts tests/agent.test.ts
git commit -m "Tell a session's model what the user has selected"
```

---

### Task 2: `stage()` takes a scope; out-of-scope hunks start unkept

**Files:**
- Modify: `src/services/review.ts` (`ReviewHunk` at `:21-26`, `stage()` at `:70`, the `accepted: true` default at `:102`)
- Modify: `src/ui/ReviewPanel.svelte` (the hunk row at `:86-96`)
- Test: `tests/review.test.ts`

**Interfaces:**
- Produces, and Task 3 consumes:
  - `export interface ReviewScope { bufferId: BufferId; fromLine: number; toLine: number }` — `fromLine`/`toLine` **0-based, inclusive**, the same space as `Hunk.fromLine`.
  - `stage(spec: ChangeSetSpec, scope?: ReviewScope): StagedChangeSet | null`
  - `ReviewHunk` gains `inScope: boolean` — `true` whenever no scope was given.

- [ ] **Step 1: Write the failing tests**

Add to `tests/review.test.ts`. `ORIGINAL` there is `'one\ntwo\nthree\nfour\nfive\n'`.

```ts
describe('a scoped proposal', () => {
  // The point of the feature: an edit outside what you selected must not be
  // pre-accepted, because "everything starts kept" means you stop it only if
  // you happen to notice it.
  it('starts a hunk outside the scope unkept', async () => {
    const { workspace, review, a } = await setup();
    const staged = review.stage(
      { description: 'two edits', author: agent, edits: [
        { bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } },
        { bufferId: a, changes: { from: 14, to: 18, insert: 'FOUR' } },
      ] },
      { bufferId: a, fromLine: 0, toLine: 0 },
    )!;

    const hunks = staged.files[0]!.hunks;
    expect(hunks.map((h) => [h.displayLine, h.accepted, h.inScope])).toEqual([
      [1, true, true],
      [4, false, false],
    ]);
  });

  // Refusing a companion edit would refuse the model for doing the right
  // thing; the fix is a different default, not a rejection.
  it('still stages the out-of-scope edit rather than dropping it', async () => {
    const { review, a } = await setup();
    const staged = review.stage(
      { description: 'far edit', author: agent, edits: [
        { bufferId: a, changes: { from: 19, to: 23, insert: 'FIVE' } },
      ] },
      { bufferId: a, fromLine: 0, toLine: 0 },
    )!;
    expect(staged.files[0]!.hunks).toHaveLength(1);
  });

  // An edit in another file is outside any selection, whatever its line
  // numbers happen to be.
  it('treats a hunk in a different buffer as out of scope', async () => {
    const { review, a, b } = await setup();
    const staged = review.stage(
      { description: 'other file', author: agent, edits: [
        { bufferId: b, changes: { from: 0, to: 5, insert: 'ALPHA' } },
      ] },
      { bufferId: a, fromLine: 0, toLine: 99 },
    )!;
    expect(staged.files[0]!.hunks[0]!.inScope).toBe(false);
  });

  // "Add something at the end of this" is the most ordinary request there is.
  // A pure insertion spans no lines, so without the +1 it would land just
  // past the scope and default to unkept.
  it('counts an insertion one line past the scope as inside it', async () => {
    const { review, a } = await setup();
    const staged = review.stage(
      { description: 'append', author: agent, edits: [
        { bufferId: a, changes: { from: 8, to: 8, insert: 'TWO-AND-A-HALF\n' } },
      ] },
      { bufferId: a, fromLine: 0, toLine: 1 },
    )!;
    expect(staged.files[0]!.hunks[0]!.inScope).toBe(true);
  });

  // Every existing caller passes no scope. If that stopped meaning "keep
  // everything", every agent and every project replace would change
  // behaviour silently.
  it('keeps every hunk when no scope is given', async () => {
    const { review, a } = await setup();
    const staged = review.stage({ description: 'unscoped', author: agent, edits: [
      { bufferId: a, changes: { from: 0, to: 3, insert: 'ONE' } },
      { bufferId: a, changes: { from: 19, to: 23, insert: 'FIVE' } },
    ] })!;
    expect(staged.files[0]!.hunks.every((h) => h.accepted && h.inScope)).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/review.test.ts -t 'a scoped proposal'`
Expected: FAIL — `stage` takes one argument and `inScope` does not exist.

- [ ] **Step 3: Implement**

In `src/services/review.ts`, add the exported type beside `ReviewHunk`:

```ts
/**
 * The line range an edit was asked for.
 *
 * Only ever decides a hunk's default. It never refuses an edit, so a scope
 * that has gone stale can cost a wrong checkbox and nothing else — what
 * protects the text is the runtime's stale-read guard.
 */
export interface ReviewScope {
  bufferId: BufferId;
  /** 0-based and inclusive, matching `Hunk.fromLine`, not `displayLine`. */
  fromLine: number;
  toLine: number;
}
```

Add `inScope: boolean;` to `ReviewHunk`, beside `accepted`.

Add the predicate above the class:

```ts
/**
 * Does this hunk touch the lines the user selected?
 *
 * Lines rather than character offsets: a hunk that overlaps the selection at
 * all counts as inside, which is the forgiving direction.
 */
function touchesScope(hunk: Hunk, bufferId: BufferId, scope: ReviewScope): boolean {
  if (bufferId !== scope.bufferId) return false;
  if (hunk.removed.length === 0) {
    // A pure insertion removes nothing and so spans no lines. Treat it as the
    // line it starts at, and allow one past the end: text inserted right after
    // the last selected line is what "add to the end of this" produces, and
    // defaulting that to unkept would fight the most ordinary request.
    return hunk.fromLine >= scope.fromLine && hunk.fromLine <= scope.toLine + 1;
  }
  const lastRemoved = hunk.fromLine + hunk.removed.length - 1;
  return hunk.fromLine <= scope.toLine && lastRemoved >= scope.fromLine;
}
```

Change the signature to `stage(spec: ChangeSetSpec, scope?: ReviewScope): StagedChangeSet | null`, and replace the whole `hunks:` mapping (`:95-105`) with a body, so the answer is computed once rather than twice for two fields that must never disagree:

```ts
        hunks: hunks.map((hunk) => {
          const inScope = scope ? touchesScope(hunk, bufferId, scope) : true;
          return {
            ...hunk,
            id: `hunk-${this.#nextHunkId++}`,
            displayLine: hunk.fromLine + 1,
            // Accepted by default: review is for catching the wrong ones, and
            // making someone tick every box to get the thing they asked for is
            // how review panels end up being clicked through blind. A scoped
            // proposal inverts that only outside the scope, which is exactly
            // where an unnoticed change would be a surprise.
            inScope,
            accepted: inScope,
          };
        }),
```

Import `Hunk` as a type from `../core/diff` if it is not already imported.

In `src/ui/ReviewPanel.svelte`, inside the hunk row after the `Line {hunk.displayLine}` span:

```svelte
              {#if !hunk.inScope}
                <span class="scope-note">outside your selection</span>
              {/if}
```

and a rule beside the other hunk styles:

```css
  .scope-note {
    color: var(--nox-text-faint);
    font-size: var(--nox-fs-xs);
    margin-left: var(--nox-sp-2);
  }
```

Those three token names were checked against `ReviewPanel.svelte`'s existing rules, which use `--nox-text-faint`, `--nox-fs-xs` and the `--nox-sp-N` spacing scale. Do not introduce a token the file does not already use.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/review.test.ts -t 'a scoped proposal'`
Expected: PASS, 5 tests.

- [ ] **Step 5: Gates and commit**

```bash
npm run check && npm test
git add src/services/review.ts src/ui/ReviewPanel.svelte tests/review.test.ts
git commit -m "Default a hunk outside the asked-for range to unkept"
```

---

### Task 3: Thread a scope through the session

**Files:**
- Modify: `src/services/agent/runtime.ts` (`SessionOptions` at `:113-116`, `start()` at `:201`, the `proposal.stage` handler at `:544`, whose `stage()` call is at `:654`, `#handle`'s signature)
- Test: `tests/agent.test.ts`

**Interfaces:**
- Consumes: `ReviewScope` and `stage(spec, scope?)` from Task 2.
- Produces, and Task 4 consumes:
  - `SessionOptions` gains `scope?: ReviewScope`.
  - `export function scopeFromSelection(bufferId: BufferId, selection: SelectionInfo | null): ReviewScope | null`

- [ ] **Step 1: Write the failing tests**

```ts
describe('a scoped session', () => {
  // The conversion nobody notices until it is wrong: context.selection counts
  // lines from 1 for humans, Hunk.fromLine counts from 0.
  it('converts a 1-based selection into a 0-based scope', async () => {
    const { workspace, context, a } = await setup();
    workspace.setSelection(a, { ranges: [[4, 13]], main: 0 });

    expect(scopeFromSelection(a, context.selection(a))).toEqual({
      bufferId: a,
      fromLine: 1,
      toLine: 2,
    });
  });

  // A bare cursor scopes nothing; returning a zero-width scope would default
  // every real hunk to unkept.
  it('answers null for an empty selection', async () => {
    const { workspace, context, a } = await setup();
    workspace.setSelection(a, { ranges: [[4, 4]], main: 0 });

    expect(scopeFromSelection(a, context.selection(a))).toBeNull();
    expect(scopeFromSelection(a, null)).toBeNull();
  });

  // The scope has to survive the whole session, not just the call that made
  // it — a proposal staged three turns later is still scoped.
  it('defaults an out-of-scope hunk to unkept when the session carries a scope', async () => {
    const { runtime, review, a: id } = await setup();
    const chunks: ModelChunk[] = [
      { type: 'action', request: { method: 'proposal.stage', params: {
        description: 'two edits',
        edits: [
          { bufferId: id, changes: { from: 0, to: 3, insert: 'ONE' } },
          { bufferId: id, changes: { from: 19, to: 23, insert: 'FIVE' } },
        ],
      } } },
    ];
    // `scripted` is the file's own helper at tests/agent.test.ts:76 —
    // `ScriptedProvider` takes a Script *function*, not an array.
    const session = runtime.start(scripted(chunks), 'edit it', {
      label: 'Scripted',
      scope: { bufferId: id, fromLine: 0, toLine: 0 },
    });
    await settle(session);

    const hunks = review.staged.get()!.files[0]!.hunks;
    expect(hunks.map((h) => h.accepted)).toEqual([true, false]);
  });
});
```

`settle(session, budgetMs = 10_000)` already exists at `tests/agent.test.ts:63` and `scripted(chunks)` at `:76` — use both rather than adding a second waiter or a second provider wrapper.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/agent.test.ts -t 'a scoped session'`
Expected: FAIL — `scopeFromSelection` is not exported and `SessionOptions` has no `scope`.

- [ ] **Step 3: Implement**

Import the type and add the exported helper to `src/services/agent/runtime.ts`:

```ts
import type { ReviewScope, ReviewService, StagedChangeSet } from '../review';
import type { SelectionInfo } from '../context';

/**
 * The scope a selection implies, or null when there is no selection.
 *
 * `context.selection` reports 1-based line numbers because it is also read by
 * humans; `Hunk.fromLine` is a 0-based index into the before-document.
 * Converting once, here, is the difference between an off-by-one that is
 * obvious and one that is spread across every comparison.
 */
export function scopeFromSelection(
  bufferId: BufferId,
  selection: SelectionInfo | null,
): ReviewScope | null {
  if (!selection || selection.isEmpty) return null;
  const range = selection.ranges[selection.main] ?? selection.ranges[0];
  if (!range) return null;
  return { bufferId, fromLine: range.fromLine - 1, toLine: range.toLine - 1 };
}
```

Extend `SessionOptions`:

```ts
export interface SessionOptions {
  /** Shown as the agent's name. Defaults to the transport's handshake. */
  label?: string;
  /**
   * The range the user asked about, when the session was started from one.
   * Only ever defaults a hunk; never refuses an edit.
   */
  scope?: ReviewScope;
}
```

In `start()`, capture it beside the other per-session state and thread it to `#handle` the same way `readAt` already is:

```ts
    const scope = options.scope;
```

Add a `scope: ReviewScope | undefined` parameter to `#handle` alongside `readAt`, pass `scope` at the call site in `start()`, and in the `proposal.stage` case change the staging call to:

```ts
          const staged = this.#review.stage(
            {
              description: request.params.description,
              author: principal,
              edits: request.params.edits,
            },
            scope,
          );
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/agent.test.ts -t 'a scoped session'`
Expected: PASS, 3 tests.

- [ ] **Step 5: Gates and commit**

```bash
npm run check && npm test
git add src/services/agent/runtime.ts tests/agent.test.ts
git commit -m "Carry the asked-for range through the session that staged it"
```

---

### Task 4: The command

**Files:**
- Modify: `src/app.ts` (`runAgent`, and the command list near `:1654`)

**Interfaces:**
- Consumes: `scopeFromSelection` and `SessionOptions.scope` from Task 3; `runnableAgents` and `isProcessAgent` from `@services/agent/config`, already imported.

**No unit test, deliberately.** `tests/agent-config.test.ts:194-199` states that `runAgent` needs a fully wired `App` to test directly, and nothing in the suite constructs one. Task 5's walk is this task's gate. Note the precedent honestly: on the provider branch, the one task with no test was also the one that shipped a feature nobody could reach. Everything testable here — the scope conversion, the overlap rule, the brief — was pushed into Tasks 1-3 for exactly that reason; what is left is wiring between tested units.

- [ ] **Step 1: Extract the shared tail**

`runAgent` currently does five things in sequence. Split the middle three out so both commands share one copy. Replace the body of `runAgent` and add three private methods:

```ts
  /** Pick a runnable agent, or explain why there is none. */
  async #chooseAgent(agentId?: string): Promise<AgentConfig | undefined> {
    const configured = this.agentConfig.agents.get();
    const choices = this.#runnableAgents();

    if (choices.length === 0) {
      if (configured.length === 0) {
        this.notifications.info('No agents are configured', 'Run "Configure Agents" to add one.');
      } else {
        this.notifications.warn(
          'None of the configured agents can run here',
          'The browser build can neither start a process nor reach a local model.',
        );
      }
      return undefined;
    }

    const named = agentId ? choices.find((agent) => agent.id === agentId) : undefined;
    if (named) return named;
    if (choices.length === 1) return choices[0];

    const picked = await this.ui.askToConfirm({
      title: 'Which agent?',
      message: 'Pick the agent to run this instruction.',
      choices: choices.map((agent) => ({ id: agent.id, label: agent.label })),
    });
    if (!picked) return undefined;
    return choices.find((agent) => agent.id === picked);
  }

  /**
   * Start a session against a chosen record.
   *
   * Shared by both agent commands so a fix to one cannot miss the other —
   * the reload guard below was written once and is load-bearing for both.
   */
  async #startAgentSession(
    chosen: AgentConfig,
    instruction: string,
    scope?: ReviewScope,
  ): Promise<void> {
    let transport: AgentTransport;
    // Defaults to the record picked from the list; the ollama branch below
    // overrides it with the label of the provider actually looked up, so a
    // rename that lands mid-typing is reflected rather than papered over.
    let label = chosen.label;
    if (isProcessAgent(chosen)) {
      const spec = {
        command: chosen.command,
        ...(chosen.args ? { args: chosen.args } : {}),
        ...(chosen.cwd ? { cwd: chosen.cwd } : {}),
      };
      transport = StdioTransport.spawnedBy(this.platform, spec, { label: chosen.label });
    } else {
      // Looked up now rather than when it was picked: agents.json can be
      // reloaded while the instruction is being typed, and that drops every
      // provider. Starting a session against a deregistered one would run a
      // model the user can no longer see configured.
      const provider = this.#providerFor(chosen.id);
      if (!provider) {
        this.notifications.warn(
          `${chosen.label} is no longer configured`,
          'agents.json was reloaded while you were typing.',
        );
        return;
      }
      transport = new ProviderTransport(provider);
      label = provider.label;
    }

    this.agents.start(transport, instruction.trim(), {
      label,
      ...(scope ? { scope } : {}),
    });
    this.ui.showAgents();
  }

  /** The scope the active editor's selection implies, or null. */
  #selectionScope(): ReviewScope | null {
    const buffer = this.workspace.active();
    if (!buffer) return null;
    return scopeFromSelection(buffer.id, this.context.selection(buffer.id));
  }
```

`runAgent` becomes:

```ts
  async runAgent(agentId?: string): Promise<void> {
    const chosen = await this.#chooseAgent(agentId);
    if (!chosen) return;

    const instruction = await this.ui.askForText({
      title: `Ask ${chosen.label}`,
      label: 'Instruction',
      initialValue: '',
      placeholder: 'Rename Task to Job across the project',
      confirmLabel: 'Run',
      validate: (value) => (value.trim().length === 0 ? 'Say what you want done' : null),
    });
    if (!instruction) return;

    await this.#startAgentSession(chosen, instruction);
  }
```

Add the imports it needs: `type ReviewScope` from `@services/review`, and `scopeFromSelection` from `@services/agent/runtime`.

- [ ] **Step 2: Add the new command's method**

```ts
  /**
   * Ask a model to change the selected text.
   *
   * The scope is captured before the instruction is typed, so it describes
   * what the user was looking at when they ran the command. It only ever
   * defaults a hunk in the review panel, so a scope that goes stale while
   * they type costs a checkbox, not correctness.
   */
  async runAgentOnSelection(): Promise<void> {
    const scope = this.#selectionScope();
    if (!scope) {
      this.notifications.info('Nothing is selected', 'Select the text you want changed, then run this again.');
      return;
    }

    const chosen = await this.#chooseAgent();
    if (!chosen) return;

    const instruction = await this.ui.askForText({
      title: `Ask ${chosen.label} about the selection`,
      label: 'What should it do?',
      initialValue: '',
      placeholder: 'Rewrite this as a single expression',
      confirmLabel: 'Run',
      validate: (value) => (value.trim().length === 0 ? 'Say what you want done' : null),
    });
    if (!instruction) return;

    await this.#startAgentSession(chosen, instruction, scope);
  }
```

- [ ] **Step 3: Register the command**

Immediately after the `agents.run` entry (currently `:1654-1662`):

```ts
      {
        id: 'agents.runOnSelection',
        title: 'Edit Selection with a Model…',
        category: 'Agents',
        keywords: ['ai', 'refactor', 'fix', 'rewrite', 'selection'],
        // Same predicate as agents.run, plus a selection to act on: a command
        // offered and then refused is the drift this predicate was extracted
        // to prevent.
        enabled: () => this.#runnableAgents().length > 0 && this.#selectionScope() !== null,
        run: () => this.runAgentOnSelection(),
      },
```

- [ ] **Step 4: Verify nothing regressed**

Run: `npm run check && npm test`
Expected: check clean, 703 + the tests added by Tasks 1-3, all passing. `runAgent` has no test of its own, so the gate here is that nothing else moved.

- [ ] **Step 5: Commit**

```bash
git add src/app.ts
git commit -m "Add a command that asks a model to change the selection"
```

---

### Task 5: Walk it, then document it

**Files:**
- Modify: `ARCHITECTURE.md`, `CHANGELOG.md`, `README.md`, `ROADMAP.md`

- [ ] **Step 1: Walk it against the real model**

`capabilities.localModels` is false in the browser, so `npm run dev` cannot exercise any of this. Build the bundle and drive the bundled app:

```bash
npm run app:build
open "src-tauri/target/release/bundle/macos/Nox.app"
```

`npm run app:build` has been observed exiting non-zero after `Nox.app` bundles, when the DMG step fails. Check for `src-tauri/target/release/bundle/macos/Nox.app` rather than trusting the exit code. Do not use `npm run app` — `tauri dev`'s binary is not a bundled `.app`, and macOS refuses synthetic keystrokes to it.

Record what you actually observe for each:

1. With nothing selected, **Edit Selection with a Model…** is present but disabled.
2. With text selected it is enabled, and picking a model prompts for an instruction.
3. The session's audit trail shows the read and the staged proposal, as any session does.
4. The staged diff is a real edit to the selected text.
5. Ask for something that needs a companion edit elsewhere — "convert this to an arrow function and add any import it needs". If the model stages a hunk outside the selection, it is **present, marked "outside your selection", and starts unkept**.
6. Apply, and confirm the kept hunks land and the unkept ones do not.
7. Run a plain **Run Agent…** with text selected and confirm every hunk still starts kept — the unscoped path is unchanged.

If a step fails, fix it and re-walk that step.

- [ ] **Step 2: Document it**

`ARCHITECTURE.md` §4, after the section on the model provider — decision, rejected alternative, what it cost. State that the scope only ever defaults a hunk and never refuses an edit, because that is the property that keeps it from interacting with the stale-read guard.

`CHANGELOG.md` under `[Unreleased]` → `Added`, matching the bolded-lead-phrase shape of its neighbours. Say plainly that a selection edit will often be partial — §9 of the spec records the model renaming a declaration and leaving the call site — rather than letting a user read that as a bug.

`README.md`: the "Where this goes next" list says "Explain, generate, refactor, fix — everyday commands over a selection". Half of that has now shipped. Update it to say which half, and do not let it imply explain landed too.

`ROADMAP.md`: same line in the Later — AI section.

- [ ] **Step 3: Final verification**

```bash
npm run check && npm test && cargo test --manifest-path src-tauri/Cargo.toml
```

Report the actual numbers.

- [ ] **Step 4: Commit**

```bash
git add ARCHITECTURE.md CHANGELOG.md README.md ROADMAP.md
git commit -m "Document selection-scoped edits"
```

---

## Notes for the executor

- **Tasks 1 and 2 are independent** and touch different files; either can go first. Task 3 needs Task 2's signature, and Task 4 needs Task 3's.
- **Task 2 changes a shared code path.** `ReviewService.stage` is called by project-wide replace and by every agent. The "keeps every hunk when no scope is given" test is the pin for that; if it ever fails, stop rather than adjusting it.
- **Do not add a setting for the cap.** It is a constant. See Global Constraints.
- **The model under-reaches.** The walk on the provider branch recorded it renaming a declaration and leaving the call site untouched. A partial edit in Task 5's walk is the model's limitation, not a defect in this feature — record it, do not chase it.

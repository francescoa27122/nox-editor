# Explain Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two commands that ask a model about the selected text, answered in a fourth sidebar section, with a provider path where prose is the expected reply rather than a parse failure.

**Architecture:** `ModelRequest` gains an optional `expects` field that travels from `SessionOptions` through `AgentRun` to the provider. The Ollama provider branches on it once: prose mode is a single round trip with no action parsing at all. The runtime refuses non-prose requests in a prose session, accumulates the reply into `answer`, and publishes it on the existing session snapshot — no new service. A new `AnswersPanel` reads that snapshot.

**Tech Stack:** TypeScript, Svelte 5 (runes), Vitest, CodeMirror 6, Tauri 2.

**Spec:** [docs/superpowers/specs/2026-08-15-explain-selection-design.md](../specs/2026-08-15-explain-selection-design.md) — read it before Task 1; §4 is the reason this feature exists in this shape.

## Global Constraints

- **Branch:** `explain-selection`. It exists and holds the spec commit.
- **No component may hardcode a default.** Every preference comes from `config/schema.ts`. This feature adds no preference.
- **No logic in components.** Model it in a service, expose it as a `Signal`, subscribe with `$signal`.
- **Every action is a command**, registered in `app.ts#registerCommands` with a category and keywords, so it appears in the palette automatically.
- **Absent `expects` must behave exactly as today.** Every agent written before this change keeps working, and every existing test must pass unmodified. If an existing test needs editing, stop — that is a signal the change is not backward compatible.
- **`ScriptedProvider` is not a mock**, it is the reference implementation. Do not add prose handling to it; it ignores `expects` and that is correct.
- **Run `npm test` before every commit.** 722 tests pass on `main`; that number only goes up.
- **Type check with `npm run check`** before the final commit. It is clean at 367 files on `main`.
- Do **not** run `npm run app`. The in-app walk (Task 8) uses `npm run app:build` and the bundled `Nox.app`.

---

## File Structure

**New:**

| File | Responsibility |
|---|---|
| `src/ui/AnswersPanel.svelte` | Renders prose sessions: question, target, body, staleness. No logic beyond formatting. |
| `tests/answers.test.ts` | The prose session's runtime behaviour and the sidebar availability rules. |

**Modified:**

| File | Change |
|---|---|
| `src/services/agent/provider.ts` | `ModelRequest.expects` |
| `src/services/agent/protocol.ts` | `AgentRun.expects`, `Outbound`'s `run` message |
| `src/services/agent/stdio.ts` | Send `expects` on the wire |
| `src/services/agent/ollama.ts` | `prosePrompt()` and the prose branch |
| `src/services/agent/runtime.ts` | `SessionOptions.expects`, refusal, answer accumulation, `about` on the snapshot |
| `src/services/ui.ts` | `SidebarView`/`FocusZone` gain `answers`, `focusAnswers`, `dropView` |
| `src/ui/Sidebar.svelte` | Filtered `VIEWS` entry and its branch |
| `src/app.ts` | Three commands, one keybinding, one exported constant |
| `CHANGELOG.md`, `ROADMAP.md`, `ARCHITECTURE.md` | Task 9 |

---

### Task 1: `expects` travels from the session to the provider

Nothing changes behaviour yet. This task only makes the field exist and arrive.

**Files:**
- Modify: `src/services/agent/provider.ts:12-18`
- Modify: `src/services/agent/protocol.ts:119-128` and `:154-157`
- Modify: `src/services/agent/runtime.ts:166-174` (`SessionOptions`), `:335-339` (building `AgentRun`), `:835-841` (`ProviderTransport.run`)
- Modify: `src/services/agent/stdio.ts:103`
- Test: `tests/answers.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: the type `AnswerExpectation = 'actions' | 'prose'`, exported from `src/services/agent/provider.ts`. `ModelRequest.expects?: AnswerExpectation`, `AgentRun.expects?: AnswerExpectation`, `SessionOptions.expects?: AnswerExpectation`.

- [ ] **Step 1: Write the failing test**

Create `tests/answers.test.ts`:

```ts
import { history } from '@codemirror/commands';
import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { ProviderTransport, AgentRuntime, type AgentSession } from '../src/services/agent/runtime';
import { ScriptedProvider, type ModelRequest } from '../src/services/agent/provider';
import { CommandRegistry } from '../src/services/commands';
import { ContextService } from '../src/services/context';
import { FileTreeService } from '../src/services/filetree';
import { JobRunner } from '../src/services/jobs';
import { PermissionService } from '../src/services/permissions';
import { ReviewService } from '../src/services/review';
import { WorkspaceService } from '../src/services/workspace';

const A = 'one\ntwo\nthree\nfour\nfive\n';

async function setup() {
  const platform = new MemoryPlatform();
  platform.mkdirp('/w');
  platform.seedFile('/w/a.txt', A);

  const workspace = new WorkspaceService(platform, () => history());
  const files = new FileTreeService(platform);
  const context = new ContextService(workspace, files);
  const commands = new CommandRegistry();
  const permissions = new PermissionService(() => workspace.rootPath.get());
  const review = new ReviewService(workspace);
  const jobs = new JobRunner();
  const runtime = new AgentRuntime({ workspace, context, commands, permissions, review, jobs });

  await workspace.openFolder('/w');
  await files.setRoot('/w');
  await files.buildIndex();
  const a = (await workspace.open('/w/a.txt'))!;

  return { workspace, context, runtime, a };
}

async function settle(session: AgentSession, budgetMs = 10_000) {
  const deadline = Date.now() + budgetMs;
  while (session.status.get() === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A provider that records the request it was handed and says nothing. */
function watcher() {
  const seen: ModelRequest[] = [];
  const provider = new ScriptedProvider((request) => {
    seen.push(request);
    return [];
  });
  return { seen, transport: new ProviderTransport(provider) };
}

describe('what a session tells its provider to expect', () => {
  /**
   * The failure this prevents: the provider having no way to know prose was
   * wanted, which is the whole reason "explain this" ends in a failed
   * session today.
   */
  it('passes the expectation through to the provider', async () => {
    const { runtime } = await setup();
    const { seen, transport } = watcher();

    const session = runtime.start(transport, 'what does this do?', { expects: 'prose' });
    await settle(session);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.expects).toBe('prose');
  });

  /**
   * The failure this prevents: an ordinary session silently acquiring a new
   * field, which would change what every agent written before this is asked
   * for.
   */
  it('says nothing about expectations for an ordinary session', async () => {
    const { runtime } = await setup();
    const { seen, transport } = watcher();

    const session = runtime.start(transport, 'rename Task to Job');
    await settle(session);

    expect(seen[0]?.expects).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/answers.test.ts`
Expected: FAIL — `expects` is not a property of `SessionOptions`, so TypeScript rejects it and the first assertion cannot pass.

- [ ] **Step 3: Add the type and the field to the provider seam**

In `src/services/agent/provider.ts`, above `ModelRequest`:

```ts
/**
 * What Nox wants back from this request.
 *
 * Describes the *reply Nox is asking for*, never who is answering — the seam
 * stays vendor-neutral. Absent means actions, which is what every agent
 * written before this field expects, so omitting it is not a degraded mode.
 */
export type AnswerExpectation = 'actions' | 'prose';
```

and inside `ModelRequest`:

```ts
  /** What Nox wants back. Absent means actions. */
  expects?: AnswerExpectation;
```

- [ ] **Step 4: Add it to the protocol**

In `src/services/agent/protocol.ts`, import the type and extend `AgentRun`:

```ts
import type { AnswerExpectation } from './provider';
```

```ts
export interface AgentRun {
  instruction: string;
  context: string;
  signal: AbortSignal;
  /** What Nox wants back. Absent means actions. */
  expects?: AnswerExpectation;
}
```

and the wire message, so a child process is told the same thing rather than the wire quietly describing a different session:

```ts
export type Outbound =
  | { type: 'run'; instruction: string; context: string; expects?: AnswerExpectation }
  | { type: 'response'; response: CoreResponse }
  | { type: 'cancel' };
```

- [ ] **Step 5: Thread it through the runtime and both transports**

In `src/services/agent/runtime.ts`, add to `SessionOptions`:

```ts
  /**
   * What this session wants back. Absent means actions.
   *
   * A prose session refuses every request but `session.note` and
   * `session.summary`, so "explain this" cannot edit anything.
   */
  expects?: AnswerExpectation;
```

In `start`, beside `const scope = options.scope;`:

```ts
    const expects = options.expects;
```

and when building the run (`runtime.ts:335-339`):

```ts
        const run: AgentRun = {
          instruction,
          context: briefed.text,
          signal: context.signal,
          ...(expects ? { expects } : {}),
        };
```

In `ProviderTransport.run` (`runtime.ts:837-841`):

```ts
    const stream = this.#provider.complete({
      instruction: run.instruction,
      context: run.context,
      signal: run.signal,
      ...(run.expects ? { expects: run.expects } : {}),
    });
```

In `src/services/agent/stdio.ts:103`:

```ts
      await this.#write({
        type: 'run',
        instruction: run.instruction,
        context: run.context,
        ...(run.expects ? { expects: run.expects } : {}),
      });
```

The spread rather than a plain assignment in all three places: `exactOptionalPropertyTypes` is on, and an explicit `expects: undefined` is not the same type as an absent key.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/answers.test.ts`
Expected: PASS, both tests.

- [ ] **Step 7: Run the whole suite and type check**

Run: `npm test && npm run check`
Expected: all tests pass (722 + 2), check clean.

- [ ] **Step 8: Commit**

```bash
git add src/services/agent/provider.ts src/services/agent/protocol.ts src/services/agent/runtime.ts src/services/agent/stdio.ts tests/answers.test.ts
git commit -m "Let a session say what kind of reply it wants"
```

---

### Task 2: The Ollama provider answers in prose

**Files:**
- Modify: `src/services/agent/ollama.ts:487` (`complete`), and a new `prosePrompt()` beside `systemPrompt()`
- Test: `tests/ollama.test.ts`

**Interfaces:**
- Consumes: `ModelRequest.expects` from Task 1.
- Produces: nothing new for later tasks. `complete` yields exactly one `{ type: 'text' }` chunk and no actions when `expects === 'prose'`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/ollama.test.ts`. `CONFIG`, `fakePlatform` and `framesFor` already exist in that file — do not redefine them.

```ts
describe('answering in prose', () => {
  /** Drive a prose stream to completion. */
  async function drainProse(provider: OllamaProvider, instruction: string) {
    const chunks: ModelChunk[] = [];
    const stream = provider.complete({ instruction, context: '', expects: 'prose' });
    for (let step = await stream.next(); !step.done; step = await stream.next(undefined)) {
      chunks.push(step.value);
    }
    return chunks;
  }

  /**
   * The failure this prevents — and the reason this feature exists. On main,
   * a model that replies with prose and no JSON is told twice it is wrong and
   * the session ends *failed*, with the answer discarded as narration. The
   * loop cannot terminate on prose, so no prompt fixes it.
   */
  it('takes a prose reply as the answer rather than as a failed turn', async () => {
    const { platform, bodies } = fakePlatform(['It adds two numbers and returns the sum.']);
    const provider = new OllamaProvider(platform, CONFIG);

    const chunks = await drainProse(provider, 'what does this do?');

    expect(chunks).toEqual([{ type: 'text', text: 'It adds two numbers and returns the sum.' }]);
    expect(bodies).toHaveLength(1);
  });

  /**
   * The failure this prevents: a prose answer being parsed for actions,
   * which would let an explanation that happens to contain a JSON example
   * turn into a request Nox acts on.
   */
  it('never yields an action, even when the prose contains one', async () => {
    const { platform } = fakePlatform([
      'You could call it like this:\n{"method":"context.openBuffers"}\nand that lists the buffers.',
    ]);
    const provider = new OllamaProvider(platform, CONFIG);

    const chunks = await drainProse(provider, 'how do I list buffers?');

    expect(chunks.every((chunk) => chunk.type === 'text')).toBe(true);
  });

  /**
   * The failure this prevents: a fenced code block being stripped out of an
   * explanation by machinery that exists to find JSON actions. An
   * explanation of code is the prose most likely to contain a fence.
   */
  it('leaves fenced code in the answer untouched', async () => {
    const answer = 'Like so:\n```js\nconst x = 1;\n```\nThat is all.';
    const { platform } = fakePlatform([answer]);
    const provider = new OllamaProvider(platform, CONFIG);

    const chunks = await drainProse(provider, 'show me');

    expect(chunks).toEqual([{ type: 'text', text: answer }]);
  });

  /**
   * The failure this prevents: an empty reply becoming an empty answer card
   * that looks like a rendering bug rather than a model that said nothing.
   */
  it('yields nothing at all when the model returns only whitespace', async () => {
    const { platform } = fakePlatform(['   \n  ']);
    const provider = new OllamaProvider(platform, CONFIG);

    expect(await drainProse(provider, 'say nothing')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/ollama.test.ts -t "answering in prose"`
Expected: FAIL. The first test fails because `complete` ignores `expects` and runs the action loop, which turns a prose reply into a refusal and then throws.

- [ ] **Step 3: Add the prose system prompt**

In `src/services/agent/ollama.ts`, directly after the existing `systemPrompt()`:

```ts
/**
 * The system prompt for a prose answer.
 *
 * Deliberately says nothing about JSON, methods or actions. The action
 * vocabulary is a large prompt and every word of it invites the model to
 * emit one — which is the thing this path exists not to parse.
 */
function prosePrompt(): string {
  return [
    'You are a careful programming assistant answering a question about code.',
    'Answer in prose, directly and briefly. Do not invent code the user did not show you.',
    'If the answer needs code, put it in a fenced block.',
    'Say what you actually know from the code you were given; do not guess at what you were not shown.',
  ].join('\n');
}
```

- [ ] **Step 4: Branch at the top of `complete`**

At the very start of `async *complete(request: ModelRequest): ModelStream {`, before `const messages`:

```ts
    // One round trip, no parsing, no turn loop. The action loop below cannot
    // terminate on a reply that contains no action — it counts one as a
    // failure and throws on the second — so a model asked to explain
    // something would comply and be reported as broken. See the design doc
    // §4; this branch is why that no longer happens.
    if (request.expects === 'prose') {
      const answer = await this.#ask(
        [
          { role: 'system', content: prosePrompt() },
          {
            role: 'user',
            content: `Question: ${request.instruction}\n\n${request.context}`,
          },
        ],
        request.signal,
      );
      // `null` is cancellation, which has nothing to report. Whitespace is a
      // model that said nothing, and an empty answer card reads as a
      // rendering bug rather than as what happened.
      if (answer !== null && answer.trim().length > 0) {
        yield { type: 'text', text: answer.trim() };
      }
      return;
    }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/ollama.test.ts`
Expected: PASS — the four new tests, and every existing test in the file unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/services/agent/ollama.ts tests/ollama.test.ts
git commit -m "Answer a prose request in one turn, without parsing for actions"
```

---

### Task 3: A prose session cannot edit anything

**Files:**
- Modify: `src/services/agent/runtime.ts:342-351` (the `send` callback) and `:509-515` (`#handle`)
- Test: `tests/answers.test.ts`

**Interfaces:**
- Consumes: `expects` from Task 1.
- Produces: `#handle` takes a sixth parameter, `expects: AnswerExpectation | undefined`, positioned last.

- [ ] **Step 1: Write the failing test**

Append to `tests/answers.test.ts`. Add `ScriptedProvider` chunks that try to act:

```ts
describe('what a prose session is allowed to do', () => {
  /**
   * The failure this prevents: "explain this selection" staging an edit.
   * Enforced here rather than in the prompt, so an out-of-process agent that
   * ignores `expects` is refused too.
   */
  it('refuses a proposal', async () => {
    const { runtime, a } = await setup();
    const responses: unknown[] = [];
    const provider = new ScriptedProvider(async function* () {
      const reply = yield {
        type: 'action',
        request: {
          method: 'proposal.stage',
          params: { description: 'nope', edits: [{ bufferId: a.id, from: 0, to: 3, insert: 'ONE' }] },
        },
      };
      responses.push(reply);
    });

    const session = runtime.start(new ProviderTransport(provider), 'explain this', {
      expects: 'prose',
    });
    await settle(session);

    expect(responses[0]).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
  });

  /**
   * The failure this prevents: a prose session reaching the command
   * dispatcher at all. `command.execute` is the only verb with a side
   * effect, so this is the whole of what "cannot edit anything" means.
   */
  it('refuses a command', async () => {
    const { runtime } = await setup();
    const responses: unknown[] = [];
    const provider = new ScriptedProvider(async function* () {
      const reply = yield {
        type: 'action',
        request: { method: 'command.execute', params: { commandId: 'file.save' } },
      };
      responses.push(reply);
    });

    const session = runtime.start(new ProviderTransport(provider), 'explain this', {
      expects: 'prose',
    });
    await settle(session);

    expect(responses[0]).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
  });

  /**
   * The failure this prevents: the refusal being so broad that the session
   * cannot say anything either, which would refuse the answer itself.
   */
  it('still accepts a summary', async () => {
    const { runtime } = await setup();
    const responses: unknown[] = [];
    const provider = new ScriptedProvider(async function* () {
      const reply = yield {
        type: 'action',
        request: { method: 'session.summary', params: { text: 'all done' } },
      };
      responses.push(reply);
    });

    const session = runtime.start(new ProviderTransport(provider), 'explain this', {
      expects: 'prose',
    });
    await settle(session);

    expect(responses[0]).toMatchObject({ ok: true });
  });

  /**
   * The failure this prevents: the refusal leaking into ordinary sessions
   * and breaking every agent already written.
   */
  it('leaves an ordinary session able to read', async () => {
    const { runtime } = await setup();
    const responses: unknown[] = [];
    const provider = new ScriptedProvider(async function* () {
      const reply = yield { type: 'action', request: { method: 'context.openBuffers' } };
      responses.push(reply);
    });

    const session = runtime.start(new ProviderTransport(provider), 'look around');
    await settle(session);

    expect(responses[0]).toMatchObject({ ok: true });
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/answers.test.ts -t "what a prose session is allowed to do"`
Expected: FAIL — the first two return `ok: true` because nothing refuses them yet.

- [ ] **Step 3: Pass `expects` into `#handle` and refuse there**

Change the signature at `runtime.ts:509-515`:

```ts
  async #handle(
    principal: Principal,
    request: AgentRequest,
    record: (action: NewAction) => void,
    readAt: Map<BufferId, number>,
    scope: ReviewScope | undefined,
    expects: AnswerExpectation | undefined,
  ): Promise<CoreResponse> {
```

and insert immediately after the signature, before `const reader = …`:

```ts
    // A prose session has one job and no side effects. Refused here rather
    // than left to the prompt, because an out-of-process agent that ignores
    // `expects` reaches this line too — which is what makes "explain this
    // cannot edit anything" a property rather than an intention.
    if (
      expects === 'prose' &&
      request.method !== 'session.note' &&
      request.method !== 'session.summary'
    ) {
      return failure(
        request.id,
        'invalid-request',
        'This session asked for an explanation. Reply in prose; it cannot read, run or propose.',
      );
    }
```

Update the call site at `runtime.ts:344`:

```ts
          const response = await this.#handle(session.principal, request, record, readAt, scope, expects);
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/answers.test.ts`
Expected: PASS, all six tests in the file so far.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: everything passes. If an existing agent test fails, the refusal is leaking into sessions with no `expects` — check the condition, not the test.

- [ ] **Step 6: Commit**

```bash
git add src/services/agent/runtime.ts tests/answers.test.ts
git commit -m "Refuse anything but prose in a session that asked for prose"
```

---

### Task 4: The answer, and what it was about

**Files:**
- Modify: `src/services/agent/runtime.ts` — `AgentSession`, `AgentSessionSnapshot`, `start`, `#publish`
- Test: `tests/answers.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 3.
- Produces, and later tasks depend on these exact names:
  - `export interface AnswerTarget { bufferId: BufferId; fromLine: number; toLine: number; revision: number }`
  - `export function answerFreshness(about: AnswerTarget, currentRevision: number): 'current' | 'changed' | 'gone'`
  - `AgentSessionSnapshot.expects: AnswerExpectation | undefined`
  - `AgentSessionSnapshot.answer: string | null`
  - `AgentSessionSnapshot.about: AnswerTarget | null`

- [ ] **Step 1: Write the failing test**

Append to `tests/answers.test.ts`:

```ts
describe('the answer a prose session produces', () => {
  const speaks = (text: string) =>
    new ProviderTransport(new ScriptedProvider(() => [{ type: 'text' as const, text }]));

  /**
   * The failure this prevents: an answer arriving only as a `note` action in
   * the audit trail, which is a record of what an agent *did* and is not
   * where anyone looks for an essay.
   */
  it('publishes the answer on the session snapshot', async () => {
    const { runtime } = await setup();
    const session = runtime.start(speaks('It adds two numbers.'), 'what does this do?', {
      expects: 'prose',
    });
    await settle(session);

    const snapshot = runtime.sessions.get().find((entry) => entry.id === session.id);
    expect(snapshot?.answer).toBe('It adds two numbers.');
    expect(snapshot?.expects).toBe('prose');
  });

  /**
   * The failure this prevents: the trail filling with the whole answer,
   * burying the reads it exists to show. Same distinction the `brief` action
   * already makes.
   */
  it('keeps the answer out of the audit trail', async () => {
    const { runtime } = await setup();
    const session = runtime.start(speaks('A paragraph.'), 'explain', { expects: 'prose' });
    await settle(session);

    expect(session.actions.get().some((action) => action.kind === 'note')).toBe(false);
  });

  /**
   * The failure this prevents: a prose session reported as awaiting review
   * when there is nothing to review.
   */
  it('ends done, never awaiting review', async () => {
    const { runtime } = await setup();
    const session = runtime.start(speaks('A paragraph.'), 'explain', { expects: 'prose' });
    await settle(session);

    expect(session.status.get()).toBe('done');
  });

  /**
   * The failure this prevents: an answer with no record of what it was
   * about, which makes both navigation and staleness impossible.
   */
  it('records the buffer, the lines and the revision it was asked about', async () => {
    const { runtime, workspace, a } = await setup();
    const session = runtime.start(speaks('A paragraph.'), 'explain', {
      expects: 'prose',
      scope: { bufferId: a.id, fromLine: 1, toLine: 2 },
    });
    await settle(session);

    const snapshot = runtime.sessions.get().find((entry) => entry.id === session.id);
    expect(snapshot?.about).toEqual({
      bufferId: a.id,
      fromLine: 1,
      toLine: 2,
      revision: workspace.revisionOf(a.id),
    });
  });

  /**
   * The failure this prevents: an ordinary session growing an answer field
   * that is always null but implies one could arrive.
   */
  it('leaves an ordinary session with no answer', async () => {
    const { runtime } = await setup();
    const session = runtime.start(speaks('narration'), 'do a thing');
    await settle(session);

    const snapshot = runtime.sessions.get().find((entry) => entry.id === session.id);
    expect(snapshot?.answer).toBeNull();
    expect(snapshot?.about).toBeNull();
  });
});

describe('whether an answer still describes the code', () => {
  const about = { bufferId: 'b1' as BufferId, fromLine: 0, toLine: 3, revision: 7 };

  it('is current while the buffer has not moved', () => {
    expect(answerFreshness(about, 7)).toBe('current');
  });

  /**
   * The failure this prevents: an explanation of code that has been edited
   * since presenting itself as describing what is on screen.
   */
  it('is changed once the buffer has moved', () => {
    expect(answerFreshness(about, 8)).toBe('changed');
  });

  /**
   * The failure this prevents: a closed buffer reading as an edit. `-1` is
   * also "different", and reporting a file you closed as one you changed is
   * a small lie in the same family as the ones this feature avoids.
   */
  it('is gone when the buffer is closed', () => {
    expect(answerFreshness(about, -1)).toBe('gone');
  });
});
```

Add `answerFreshness` and `type BufferId` to the imports at the top of the file.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/answers.test.ts -t "the answer a prose session produces"`
Expected: FAIL — `answer`, `expects` and `about` are not on the snapshot.

- [ ] **Step 3: Add the target type and the session fields**

In `src/services/agent/runtime.ts`, beside `AgentSession`:

```ts
/**
 * What an answer was about.
 *
 * `revision` is the buffer's revision at the moment the brief was built —
 * the text the model was actually shown. Comparing it against the buffer's
 * revision now is the whole of staleness; it is a label, never a refusal.
 */
export interface AnswerTarget {
  bufferId: BufferId;
  fromLine: number;
  toLine: number;
  revision: number;
}

/**
 * Whether an answer still describes the code it was about.
 *
 * Pure and here rather than in the panel, so the three cases are testable
 * without a component — and because `-1` (the buffer is closed) is *also*
 * "not equal", and collapsing it into "changed" would report a file you
 * closed as one you edited.
 */
export function answerFreshness(
  about: AnswerTarget,
  currentRevision: number,
): 'current' | 'changed' | 'gone' {
  if (currentRevision === -1) return 'gone';
  return currentRevision === about.revision ? 'current' : 'changed';
}
```

Add to `AgentSession`:

```ts
  readonly expects: AnswerExpectation | undefined;
  readonly answer: Signal<string | null>;
  readonly about: Signal<AnswerTarget | null>;
```

Add to `AgentSessionSnapshot`:

```ts
  expects: AnswerExpectation | undefined;
  /** The prose a prose session produced. Null for every other session. */
  answer: string | null;
  /** The buffer and lines the question was about, and their revision then. */
  about: AnswerTarget | null;
```

- [ ] **Step 4: Populate them in `start`**

Beside the existing `const summary = new Signal<string | null>(null);`:

```ts
    const answer = new Signal<string | null>(null);
    const about = new Signal<AnswerTarget | null>(null);
```

Add `expects`, `answer` and `about` to the `session` object literal at `runtime.ts:300-313`.

Immediately after the brief is built (`runtime.ts:333`, after the `brief` action is recorded), capture what the answer is about at the revision the model was shown:

```ts
        // Captured here, not at stage time: this is the revision of the text
        // the brief actually carried. Later is the wrong moment — the user
        // goes on typing while the model thinks.
        if (scope) {
          about.set({ ...scope, revision: this.#workspace.revisionOf(scope.bufferId) });
        }
```

Then intercept prose narration in the `send` callback, before `#handle` (`runtime.ts:342-351`):

```ts
        await transport.run(run, async (request) => {
          if (context.cancelled) return failure(request.id, 'cancelled', 'Session cancelled');
          // The answer is what the agent *said*, not something it did to the
          // workspace, so it is published rather than filed as an action.
          // An essay in the trail would bury the reads the trail is for —
          // the same distinction `brief` already makes.
          if (expects === 'prose' && request.method === 'session.note') {
            const text = request.params.text;
            answer.update((current) => (current === null ? text : `${current}${text}`));
            this.#publish();
            return success(request.id, null);
          }
          const response = await this.#handle(session.principal, request, record, readAt, scope, expects);
          if (request.method === 'proposal.stage' && response.ok) staged = true;
          if (request.method === 'session.summary') {
            summary.set(request.params.text);
            this.#publish();
          }
          return response;
        });
```

Make sure `success` is imported from `./protocol` — check the existing import list and add it if absent.

- [ ] **Step 5: Publish them**

In `#publish` (`runtime.ts:385-397`), add to the mapped object:

```ts
        expects: session.expects,
        answer: session.answer.get(),
        about: session.about.get(),
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/answers.test.ts && npm test`
Expected: PASS throughout.

- [ ] **Step 7: Commit**

```bash
git add src/services/agent/runtime.ts tests/answers.test.ts
git commit -m "Publish a prose session's answer and what it was about"
```

---

### Task 5: The commands

**Files:**
- Modify: `src/app.ts` — `#startAgentSession` (`:610-614`), a new `askAboutSelection`, the command registrations near `agents.runOnSelection` (`:1722-1731`), and the keybinding table (`:2432-2435`)
- Test: `tests/answers.test.ts`

**Interfaces:**
- Consumes: `SessionOptions.expects` (Task 1), `AnswerTarget` (Task 4).
- Produces: `export const EXPLAIN_INSTRUCTION` from `src/services/agent/runtime.ts`; commands `agents.askAboutSelection` and `agents.explainSelection`. (`answers.focus` is Task 6.)

- [ ] **Step 1: Write the failing test**

Append to `tests/answers.test.ts`. This asserts the shipped constant is a real instruction rather than a placeholder, which is the part a test can actually hold:

Add `EXPLAIN_INSTRUCTION` to the existing `../src/services/agent/runtime` import at the top of the file — **not** from `../src/app`, which would pull the whole application module graph into a unit test for one string.

```ts
describe('the built-in explain instruction', () => {
  /**
   * The failure this prevents: a preset that ships as an empty string or a
   * placeholder, which a local model answers with something unrelated.
   */
  it('asks a real question', () => {
    expect(EXPLAIN_INSTRUCTION.trim().length).toBeGreaterThan(20);
    expect(EXPLAIN_INSTRUCTION).toMatch(/explain/i);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/answers.test.ts -t "the built-in explain instruction"`
Expected: FAIL — `EXPLAIN_INSTRUCTION` is not exported from `src/services/agent/runtime.ts`.

- [ ] **Step 3: Export the instruction and widen `#startAgentSession`**

In `src/services/agent/runtime.ts`, beside `SELECTION_MAX_CHARS`:

```ts
/**
 * The instruction **Explain Selection** sends.
 *
 * Here rather than in `app.ts` so a test can assert the string that actually
 * ships without importing the whole application, and so the wording lives in
 * one place rather than inside a command literal.
 */
export const EXPLAIN_INSTRUCTION =
  'Explain what this code does, and anything surprising about how it does it.';
```

Import it in `src/app.ts` from the existing `@services/agent/runtime` import.

Widen the private helper's signature (`app.ts:610-614`):

```ts
  async #startAgentSession(
    chosen: AgentConfig,
    instruction: string,
    scope?: ReviewScope,
    expects?: AnswerExpectation,
  ): Promise<void> {
```

Add `AnswerExpectation` to the existing `@services/agent/provider` import in `src/app.ts`.

Then change the tail of the method (`app.ts:648-652`), which currently starts the session and always opens the agents panel:

```ts
    this.agents.start(transport, instruction.trim(), {
      label,
      ...(scope ? { scope } : {}),
      ...(expects ? { expects } : {}),
    });
    // A prose session has nothing to review and nothing to undo, so the
    // agents panel — which takes over the editor area — is the wrong place to
    // send someone who just asked what their code does. The answer belongs
    // beside the code it is about.
    if (expects === 'prose') this.ui.focusAnswers();
    else this.ui.showAgents();
```

`focusAnswers` arrives in Task 6. Implementing strictly in order, leave the `if` out here and add it in Task 6 Step 7 — do not call a method that does not exist yet.

- [ ] **Step 4: Add the public method**

Beside `runAgentOnSelection` in `src/app.ts`:

```ts
  /**
   * Ask a model about the selected text, in prose.
   *
   * The mirror of `runAgentOnSelection`, and deliberately the same shape: the
   * scope is captured before anything is typed, so it describes where the
   * user was looking rather than where they ended up. Here it records what
   * the answer is *about* rather than defaulting a hunk — a prose session
   * produces none.
   *
   * `instruction` is supplied by **Explain Selection**, which skips the
   * dialog; **Ask About Selection…** leaves it undefined and asks.
   */
  async askAboutSelection(instruction?: string): Promise<void> {
    const scope = this.#selectionScope();
    if (!scope) {
      this.notifications.info(
        'Nothing is selected',
        'Select the code you want explained, then run this again.',
      );
      return;
    }

    const chosen = await this.#chooseAgent();
    if (!chosen) return;

    const question =
      instruction ??
      (await this.ui.askForText({
        title: `Ask ${chosen.label} about the selection`,
        label: 'What do you want to know?',
        initialValue: '',
        placeholder: 'What does this actually do when the list is empty?',
        confirmLabel: 'Ask',
        validate: (value) => (value.trim().length === 0 ? 'Say what you want to know' : null),
      }));
    if (!question) return;

    await this.#startAgentSession(chosen, question, scope, 'prose');
  }
```

- [ ] **Step 5: Register the commands**

Directly after the `agents.runOnSelection` entry (`app.ts:1731`):

```ts
      {
        id: 'agents.askAboutSelection',
        title: 'Ask About Selection…',
        category: 'Agents',
        keywords: ['ai', 'explain', 'what does', 'question', 'selection'],
        // The same predicate as the edit command, for the same reason: a
        // command offered and then refused is the drift it exists to prevent.
        enabled: () => this.#runnableAgents().length > 0 && this.#selectionScope() !== null,
        run: () => this.askAboutSelection(),
      },
      {
        id: 'agents.explainSelection',
        title: 'Explain Selection',
        category: 'Agents',
        keywords: ['ai', 'what does this do', 'describe', 'selection'],
        enabled: () => this.#runnableAgents().length > 0 && this.#selectionScope() !== null,
        run: () => this.askAboutSelection(EXPLAIN_INSTRUCTION),
      },
```

`answers.focus` and its keybinding are **not** registered here — they call
`ui.focusAnswers()`, which Task 6 creates. Registering them now would leave
this task unable to pass `npm run check`. They are Task 6 Step 7.

- [ ] **Step 6: Run the test and the suite**

Run: `npx vitest run tests/answers.test.ts && npm test`
Expected: PASS. The palette picks the two commands up automatically — every action in Nox is a command, and the registry is what the palette reads.

- [ ] **Step 7: Commit**

```bash
git add src/app.ts tests/answers.test.ts
git commit -m "Add the two commands that ask a model about a selection"
```

---

### Task 6: The Answers panel

**Files:**
- Modify: `src/services/ui.ts:13-22` (`SidebarView`), `:44` (`FocusZone`), `:167-193` (`showView`, `focusNotes` neighbours)
- Modify: `src/ui/Sidebar.svelte:22-26` and `:46-52`
- Create: `src/ui/AnswersPanel.svelte`
- Test: `tests/answers.test.ts`

**Interfaces:**
- Consumes: `AgentSessionSnapshot.answer` / `.about` / `.expects` (Task 4), `runnableAgents` from `services/agent/config`.
- Produces: `UIService.focusAnswers()`, `UIService.dropView(view: SidebarView)`, `UIService.focusAnswersRequest`.

- [ ] **Step 1: Write the failing test**

Append to `tests/answers.test.ts`:

```ts
import { UIService } from '../src/services/ui';

describe('the answers sidebar section', () => {
  /**
   * The failure this prevents: the section staying selected after the last
   * agent is removed from agents.json, leaving the rail with no button for
   * the panel that is showing.
   */
  it('falls back to the explorer when its view is dropped', () => {
    const ui = new UIService();
    ui.focusAnswers();
    expect(ui.sidebarView.get()).toBe('answers');

    ui.dropView('answers');

    expect(ui.sidebarView.get()).toBe('explorer');
  });

  /**
   * The failure this prevents: dropping a view yanking the user out of an
   * unrelated panel they are working in.
   */
  it('leaves another view alone', () => {
    const ui = new UIService();
    ui.focusSearch();

    ui.dropView('answers');

    expect(ui.sidebarView.get()).toBe('search');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/answers.test.ts -t "the answers sidebar section"`
Expected: FAIL — `focusAnswers` and `dropView` do not exist.

- [ ] **Step 3: Extend `UIService`**

In `src/services/ui.ts`, add `'answers'` to `SidebarView` and to `FocusZone`, add the focus signal beside `focusNotesRequest`:

```ts
  /** Bumped to ask the answers panel to take focus. */
  readonly focusAnswersRequest = new Signal(0);
```

add the branch in `showView`:

```ts
    else if (view === 'answers') this.focusAnswers();
```

and the two methods beside `focusNotes`:

```ts
  focusAnswers(): void {
    this.sidebarView.set('answers');
    this.focusZone.set('answers');
    this.focusAnswersRequest.update((n) => n + 1);
  }

  /**
   * Stop showing a view that is no longer available.
   *
   * The answers section exists only while an agent does, and agents.json can
   * be edited or reloaded at any time. Falling back to the explorer is the
   * same healing the editor groups do when a pane empties: a layout with a
   * hole where something used to be is worse than one that closes up.
   */
  dropView(view: SidebarView): void {
    if (this.sidebarView.get() === view) this.focusExplorer();
  }
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/answers.test.ts -t "the answers sidebar section"`
Expected: PASS.

- [ ] **Step 5: Create the panel**

Create `src/ui/AnswersPanel.svelte`:

```svelte
<script lang="ts">
  import { answerFreshness, type AgentSessionSnapshot } from '@services/agent/runtime';
  import { useApp } from './context';

  /**
   * What you asked a model, and what it said.
   *
   * Deliberately not the agents panel: that one is a record of what a session
   * read and ran, and says so. This one is for reading prose, which is why it
   * is a column rather than a table of actions.
   *
   * Answers last for the session and no longer. An explanation of code that
   * has since changed is confidently wrong, and persisting one would be the
   * same lie provenance marks refuse to tell.
   */

  const app = useApp();
  const { agents, workspace, ui } = app;

  const sessions = agents.sessions;

  const answers = $derived(
    $sessions.filter((session) => session.expects === 'prose').reverse(),
  );

  /** The label, if any. The decision itself is `answerFreshness`, in the service. */
  function freshness(session: AgentSessionSnapshot): string | null {
    if (!session.about) return null;
    switch (answerFreshness(session.about, workspace.revisionOf(session.about.bufferId))) {
      case 'gone':
        return 'file is closed';
      case 'changed':
        return 'the code has changed since';
      default:
        return null;
    }
  }

  function target(session: AgentSessionSnapshot): string | null {
    if (!session.about) return null;
    const name = workspace.buffers.get().find((b) => b.id === session.about!.bufferId)?.name;
    const from = session.about.fromLine + 1;
    const to = session.about.toLine + 1;
    const lines = from === to ? `line ${from}` : `lines ${from}–${to}`;
    return name ? `${name}, ${lines}` : lines;
  }

  /**
   * Split an answer into prose and fenced code.
   *
   * The whole of the markdown handled, on purpose. A renderer is a dependency
   * and a sanitisation surface for model output; every part below is rendered
   * as text by Svelte, never as markup.
   */
  function parts(text: string): { code: boolean; text: string }[] {
    return text
      .split(/```(?:[a-zA-Z0-9-]*\n?)?/)
      .map((piece, index) => ({ code: index % 2 === 1, text: piece }))
      .filter((piece) => piece.text.trim().length > 0);
  }

  function reveal(session: AgentSessionSnapshot): void {
    if (!session.about || workspace.revisionOf(session.about.bufferId) === -1) return;
    // `setActive`, the method the tab bar and the buffer switcher both use.
    // There is no `activate(id)`.
    workspace.setActive(session.about.bufferId);
    ui.focusEditor();
  }
</script>

<div class="panel">
  <div class="header"><span class="title">Answers</span></div>

  {#if answers.length === 0}
    <p class="empty">
      Select some code and run <strong>Explain Selection</strong>, or
      <strong>Ask About Selection…</strong> to ask something else.
    </p>
  {:else}
    <ol class="list">
      {#each answers as session (session.id)}
        {@const stale = freshness(session)}
        {@const where = target(session)}
        <li class="answer">
          <p class="question">{session.instruction}</p>
          <p class="meta">
            {#if where}
              <button class="where" onclick={() => reveal(session)}>{where}</button>
            {/if}
            <span class="agent">{session.label}</span>
            {#if stale}<span class="stale">{stale}</span>{/if}
          </p>

          {#if session.status === 'failed'}
            <p class="failed">
              {session.actions.findLast((a) => a.kind === 'error')?.message ?? 'Failed.'}
            </p>
          {:else if session.answer === null}
            <p class="working">Working…</p>
          {:else}
            {#each parts(session.answer) as piece}
              {#if piece.code}
                <pre class="code">{piece.text}</pre>
              {:else}
                <p class="body">{piece.text}</p>
              {/if}
            {/each}
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</div>
```

Styling follows `NotesPanel.svelte`: reuse its `.header`, `.title` and `.empty` rules verbatim (uppercase `--nox-fs-2xs` title, `--nox-tabbar-h` header, `--nox-border` bottom rule), give `.list` `overflow-y: auto`, `.question` `--nox-fw-semibold`, `.meta` `--nox-fs-2xs` in `--nox-text-faint`, `.stale` `--nox-warn`, and `.code` `--nox-font-mono` on `--nox-bg-inset` with `overflow-x: auto`. Do not invent colours — every value is an existing token.

- [ ] **Step 6: Wire it into the sidebar**

In `src/ui/Sidebar.svelte`, import `runnableAgents` from `@services/agent/config` and `AnswersPanel`, and widen the destructure — it currently takes `{ ui, keymap }` and now also needs `agentConfig` and `agents`:

```svelte
  const { ui, keymap, agentConfig, agents } = app;
  const configured = agentConfig.agents;
  const providers = agents.providers;
```

Then derive availability with the same predicate `AgentPanel.svelte` uses, so the rail and the panel can never disagree:

```svelte
  const available = $derived(
    runnableAgents($configured, {
      canSpawn: app.platform.capabilities.agentProcesses,
      providerIds: new Set($providers.map((provider) => provider.id)),
    }).length > 0,
  );

  const views = $derived(
    available ? VIEWS : VIEWS.filter((entry) => entry.id !== 'answers'),
  );

  // The section exists only while an agent does. Without this, removing the
  // last agent leaves the panel showing with no button in the rail for it.
  $effect(() => {
    if (!available) ui.dropView('answers');
  });
```

Add `{ id: 'answers', icon: 'info', label: 'Answers', command: 'answers.focus' }` to `VIEWS`, iterate `views` instead of `VIEWS`, and add the branch:

```svelte
  {:else if $view === 'answers' && available}
    <AnswersPanel />
```

placed before the final `{:else}`, so an unavailable answers view falls through to the explorer rather than rendering nothing.

- [ ] **Step 7: Send a prose session to the right panel, and add the command**

In `#startAgentSession`, replace the unconditional `this.ui.showAgents()` with the branch deferred from Task 5 Step 3, now that `focusAnswers` exists:

```ts
    if (expects === 'prose') this.ui.focusAnswers();
    else this.ui.showAgents();
```

Register the command, next to the Notes block at `app.ts:2307-2315`:

```ts
      // --- Answers ------------------------------------------------------------
      {
        id: 'answers.focus',
        title: 'Show Answers',
        category: 'Answers',
        keyHint: 'Mod+Shift+A',
        keywords: ['explain', 'ask', 'ai', 'answer'],
        // The agent half of the selection predicate only: this command and
        // the sidebar rail must never disagree about whether the section
        // exists.
        enabled: () => this.#runnableAgents().length > 0,
        run: () => this.ui.focusAnswers(),
      },
```

and add to the keybinding table beside `'Mod+Shift+N': 'notes.focus'`:

```ts
      'Mod+Shift+A': 'answers.focus',
```

- [ ] **Step 8: Run everything**

Run: `npm test && npm run check`
Expected: all tests pass, check clean. `npm run check` is the only thing that type-checks the Svelte files — a mistyped snapshot property will only surface here.

- [ ] **Step 9: Commit**

```bash
git add src/services/ui.ts src/ui/Sidebar.svelte src/ui/AnswersPanel.svelte src/app.ts tests/answers.test.ts
git commit -m "Add the answers panel, shown only when an agent can answer"
```

---

### Task 7: Verify it in the browser target

Cheap, and it catches the whole class of wiring mistakes no unit test sees. Not a substitute for Task 8.

**Files:** none.

- [ ] **Step 1: Start the browser target**

The `nox-web` configuration already exists in `.claude/launch.json` (port 1420). Start it and open the app.

- [ ] **Step 2: Confirm the section is hidden**

With no `agents.json` configured, the sidebar rail shows three buttons and **Show Answers** is not offered as an enabled command. This is the roadmap principle under test: someone who never turns AI on sees today's Nox.

- [ ] **Step 3: Confirm the commands are absent, not broken**

Open the palette and type "Explain". `Explain Selection` and `Ask About Selection…` are disabled — the browser target can neither spawn a process nor reach a local model, which `#runnableAgents()` already knows.

- [ ] **Step 4: Note the result, and do not fake the rest**

The browser target cannot reach a model, so the answer path itself is unverifiable here. Do not simulate one. Task 8 is where the feature is actually tested.

- [ ] **Step 5: Commit nothing**

Nothing to commit. Record what was observed in the Task 8 notes.

---

### Task 8: The walk against a real model

**This task is not optional.** Both defects this feature is built on — the action-mandatory loop in the spec's §4, and the `name [id]` bug before it — were invisible to every scripted test, because a scripted provider passes correct data by construction. Only a real model can get it wrong in the way that matters.

**Files:** whatever the walk turns up.

- [ ] **Step 1: Build the app**

Run: `npm run app:build`

**The build exits non-zero after `Nox.app` succeeds**, because the DMG step fails. Check for the `.app` bundle rather than the exit code. Do **not** run `npm run app`.

- [ ] **Step 2: Configure a local agent**

Point `agents.json` at a running Ollama with `qwen2.5-coder:7b`, the model the recorded fixtures came from.

- [ ] **Step 3: Drive from the command palette**

A full-screen window overlay can swallow direct clicks, so drive the app from the palette. **Verify the palette actually opened before typing** — typing into the buffer instead has previously replaced a fixture's contents.

- [ ] **Step 4: Walk the four cases**

1. Select a function, run **Explain Selection**. The answer appears in the Answers section; the session ends `done`, not `failed`. This is the case that fails on `main`.
2. Ask something whose answer contains a fenced code block. The fence renders as a monospace block and its content is not mangled.
3. Edit the explained buffer. The entry gains *the code has changed since*.
4. Close the buffer. The entry says *file is closed* and is no longer clickable.
5. Point `agents.json` at a host with nothing listening and ask again. The
   question you asked is still shown, with the failure in place of a body —
   a question must never vanish silently.

- [ ] **Step 5: Record what the model actually did**

Write down the model's real behaviour, including anything it did badly — a partial answer, an ignored question, a wrong file. The changelog entry in Task 9 tells users what to expect, and it is only honest if it comes from this step. The existing entry for **Edit Selection with a Model…** sets the standard: it says plainly that a local model will often do only one of two requested things.

- [ ] **Step 6: Fix what the walk found, then re-walk**

Any fix gets a test first, in the file that covers that layer.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Fix what the walk against a real model found"
```

(Skip the commit if the walk found nothing to fix.)

---

### Task 9: Documentation

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]`), `ROADMAP.md` (the *Later — AI* block), `ARCHITECTURE.md` §4

- [ ] **Step 1: Changelog**

Under `### Added`, in the voice the file already uses — what it does, what it costs, and what to expect from a local model, using what Task 8 actually observed:

```markdown
- **Explain Selection** and **Ask About Selection…** Select some code and ask
  what it does, in your own words or with one keystroke. The answer arrives in
  a new **Answers** section in the sidebar (<kbd>⌘⇧A</kbd>).
  - An answer says which file and lines it was about, and marks itself when
    that code has changed since — an explanation of code that has moved on is
    worse than no explanation.
  - Answers last for the session. They are not written anywhere.
  - **An explain session cannot change anything.** It is refused at the
    runtime, not asked nicely in a prompt, so it holds for an agent in another
    process too.
  - The section is not there at all until you have configured an agent that
    can run.
```

Under `### Fixed`:

```markdown
- **Asking a model to explain something reported the model as broken.** The
  local-model loop required every reply to carry a JSON action, so a model
  that answered a question in prose — the correct thing to do — was told twice
  that it was wrong and the session ended failed, with the explanation
  discarded as narration. Nox now says which kind of reply it wants, and a
  prose answer takes one turn with no parsing at all.
```

- [ ] **Step 2: Roadmap**

In *Later — AI*, the first bullet currently reads that Explain selection "needs a result surface Nox doesn't have yet". Update it to say the surface now exists and both halves have shipped, keeping the file's convention of describing what is true rather than what is planned.

- [ ] **Step 3: Architecture**

Add a §4 subsection after *Selection edits are composition…*, titled **A prose answer is a different question, not a different agent**. Cover, in the file's voice:

- Why the provider needed a branch rather than a better prompt: the action loop cannot terminate on a reply with no action, and the second one throws. Cite the measurement.
- Why the field describes what Nox wants back rather than what the provider is: that is what keeps the seam vendor-neutral.
- Why a prose session refuses everything else, and why that is enforced in the runtime rather than in the prompt.
- Why the answer is published rather than filed as an action — the trail means what the agent *did*, the same distinction `brief` already makes.
- Why answers are session-scoped, tying it to the provenance rule already stated.
- Why rendering stops at fenced code.

- [ ] **Step 4: Verify**

Run: `npm test && npm run check`
Expected: green.

- [ ] **Step 5: Commit and open the PR**

```bash
git add CHANGELOG.md ROADMAP.md ARCHITECTURE.md
git commit -m "Document the answers panel and the prose path"
git push -u origin explain-selection
```

Open a PR describing the §4 finding first — it is the part a reviewer most needs to check, and the part no test on `main` could have caught.

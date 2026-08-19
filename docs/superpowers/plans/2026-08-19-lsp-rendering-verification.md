# LSP Rendering Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove in the vitest suite that diagnostics, completion and hover reach the DOM through the real `EditorPane`, and correct the three places whose words claim more than the code does.

**Architecture:** `MemoryPlatform` gains an injectable language-server factory so the app's own `LspService` can run against an in-memory fake; the fake moves to `tests/support/` and learns to script answers. One new jsdom suite mounts `EditorPane` through the existing component harness and drives each surface to a DOM assertion. A four-line `Range` polyfill fills the one jsdom hole that stops CodeMirror's hover plugin from running.

**Tech Stack:** vitest 4 (`// @vitest-environment jsdom`), Svelte 5 harness in `tests/support/component.ts`, `@codemirror/view` / `@codemirror/autocomplete` / `@codemirror/lint`.

**Spec:** `docs/superpowers/specs/2026-08-19-lsp-rendering-verification-design.md`

## Global Constraints

- No new dependencies. (Spec §5.)
- Files are LF in this checkout (`git ls-files --eol` shows `i/lf w/lf`); write LF. The Windows worktree's CRLF is `core.autocrlf`, not the blob.
- Stage explicit paths. Never `git add -A` — this repo has been bitten by it. Before every commit: `git rev-parse --abbrev-ref HEAD` must print `lsp-render-verify`.
- `npm run check` exits 0 even with errors: grep its output for `0 errors` rather than trusting the exit code (WORKLOG, 2026-08-18).
- Every rendering test is mutation-checked before it counts: temporarily break the production wiring, watch the test fail, restore, watch it pass. Record the mutation in the test's docblock so a reader knows it was done.
- Commit author must be the repo-local identity (`git config user.name` → `francescoa27122`); do not pass `--author`.
- Public repo: no personal identifiers in files or messages.

---

### Task 1: One fake server, startable by the app

**Files:**
- Create: `tests/support/fake-lsp-process.ts`
- Modify: `tests/lsp-service.test.ts:16-64` (delete the class, import it)
- Modify: `src/platform/memory.ts:435-450` (`startLanguageServer`)
- Test: `tests/lsp-platform.test.ts` (append one `describe`)

**Interfaces:**
- Produces: `class FakeLanguageServer implements LanguageServerProcess` with
  `constructor(options?: { capabilities?: Record<string, unknown> })`,
  `readonly written: { id?: number; method?: string; params?: unknown }[]`,
  `handle(method: string, fn: (params: unknown) => unknown): void`,
  `say(message: unknown): void`, `publish(uri, diagnostics, version?)`,
  `die(code?)`. `initialize` is answered with `{ capabilities }` (default
  `{}` — `lsp-service.test.ts` asserts `capabilitiesFor` is `{}`); any other
  request with a `handle`r is answered with its return value; a request with
  no handler is left pending, exactly as today.
- Produces: `MemoryPlatform.languageServers: ((spec: LanguageServerSpec) => LanguageServerProcess) | null`, default `null`.

- [ ] **Step 1: Write the platform test**

Append to `tests/lsp-platform.test.ts` (read its imports first and reuse them; add what is missing):

```ts
import { MemoryPlatform } from '../src/platform/memory';
import { FakeLanguageServer } from './support/fake-lsp-process';

describe('MemoryPlatform.startLanguageServer', () => {
  it('refuses when nothing is installed, as the browser build does', async () => {
    const platform = new MemoryPlatform();
    await expect(platform.startLanguageServer({ command: 'x' })).rejects.toThrow(/cannot start language servers/);
  });

  it('returns what the installed factory makes, and hands it the spec', async () => {
    const platform = new MemoryPlatform();
    const made: FakeLanguageServer[] = [];
    const specs: unknown[] = [];
    platform.languageServers = (spec) => {
      specs.push(spec);
      const server = new FakeLanguageServer();
      made.push(server);
      return server;
    };

    const process = await platform.startLanguageServer({ command: 'tsserver', args: ['--stdio'] });

    expect(process).toBe(made[0]);
    expect(specs).toEqual([{ command: 'tsserver', args: ['--stdio'] }]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/lsp-platform.test.ts`
Expected: FAIL — `Cannot find module './support/fake-lsp-process'`.

- [ ] **Step 3: Extract the fake**

Create `tests/support/fake-lsp-process.ts` from the `FakeServer` class at `tests/lsp-service.test.ts:16-64`, renamed and extended:

```ts
import type { LanguageServerProcess } from '../../src/platform/types';

/**
 * A language server that lives in the test.
 *
 * Speaks whole JSON-RPC messages, as `LanguageServerProcess` does — framing
 * is the platform's job and never reaches here. `initialize` is answered
 * with whatever capabilities the test asked for; any other request is
 * answered by a `handle`r if one is registered, and otherwise left pending,
 * which is what a slow server looks like from the outside.
 *
 * Buffered until a handler is attached, per the contract on
 * `LanguageServerProcess.onMessage`.
 */
export class FakeLanguageServer implements LanguageServerProcess {
  readonly written: { id?: number; method?: string; params?: unknown }[] = [];
  #capabilities: Record<string, unknown>;
  #handlers = new Map<string, (params: unknown) => unknown>();
  #messages: ((message: string) => void)[] = [];
  #stderr: ((line: string) => void)[] = [];
  #exits: ((code: number | null) => void)[] = [];
  #buffered: string[] = [];
  #exited: { code: number | null } | null = null;

  constructor(options: { capabilities?: Record<string, unknown> } = {}) {
    this.#capabilities = options.capabilities ?? {};
  }

  /** Answer `method` requests with `fn(params)`. */
  handle(method: string, fn: (params: unknown) => unknown): void {
    this.#handlers.set(method, fn);
  }

  async send(message: string): Promise<void> {
    const parsed = JSON.parse(message) as { id?: number; method?: string; params?: unknown };
    this.written.push(parsed);
    if (parsed.method === 'initialize') {
      this.say({ jsonrpc: '2.0', id: parsed.id, result: { capabilities: this.#capabilities } });
    } else if (parsed.method === 'shutdown') {
      this.say({ jsonrpc: '2.0', id: parsed.id, result: null });
    } else if (parsed.id !== undefined && parsed.method && this.#handlers.has(parsed.method)) {
      const result = this.#handlers.get(parsed.method)!(parsed.params);
      this.say({ jsonrpc: '2.0', id: parsed.id, result });
    }
  }

  onMessage(handler: (message: string) => void): void {
    this.#messages.push(handler);
    for (const message of this.#buffered.splice(0)) handler(message);
  }
  onStderr(handler: (line: string) => void): void {
    this.#stderr.push(handler);
  }
  onExit(handler: (code: number | null) => void): void {
    this.#exits.push(handler);
    if (this.#exited) handler(this.#exited.code);
  }
  async kill(): Promise<void> {}

  say(message: unknown): void {
    const raw = JSON.stringify(message);
    if (this.#messages.length === 0) this.#buffered.push(raw);
    else for (const handler of this.#messages) handler(raw);
  }

  publish(uri: string, diagnostics: unknown[], version?: number): void {
    this.say({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics, ...(version === undefined ? {} : { version }) },
    });
  }

  die(code: number | null = 1): void {
    this.#exited = { code };
    for (const handler of this.#exits) handler(code);
  }
}
```

In `tests/lsp-service.test.ts`: delete lines 16-64 (the class), add `import { FakeLanguageServer } from './support/fake-lsp-process';`, and replace every `FakeServer` with `FakeLanguageServer` (`new FakeServer()` in `setup`, the `spawned: FakeServer[]` type). Keep the `LanguageServerProcess` type import only if something else still uses it; otherwise remove it so `svelte-check` does not report an unused import.

- [ ] **Step 4: Add the seam to `MemoryPlatform`**

In `src/platform/memory.ts`, replace the `startLanguageServer` method (and its docblock) with:

```ts
  /**
   * Where a language server comes from, when one can.
   *
   * There is no process in memory, so by default this platform refuses —
   * loudly, for the reason `spawnAgent` gives: a server that silently
   * produced nothing would be indistinguishable from one merely slow to
   * start. A test installs a factory here to hand the app an in-memory
   * server (see `tests/support/fake-lsp-process.ts`), which is what lets the
   * real `LspService`, `EditorPane` and CodeMirror be driven end to end
   * without a process. `capabilities.languageServers` stays `false`: that
   * flag says what the build can do for a user, and the browser target
   * still cannot start one.
   */
  languageServers: ((spec: LanguageServerSpec) => LanguageServerProcess) | null = null;

  async startLanguageServer(spec: LanguageServerSpec): Promise<LanguageServerProcess> {
    if (this.languageServers) return this.languageServers(spec);
    throw new PlatformError('this build cannot start language servers', 'unsupported');
  }
```

`LanguageServerProcess` must be in the type import at the top of `memory.ts` (it imports `LanguageServerSpec` from `./types` at line ~8; add `LanguageServerProcess` beside it).

- [ ] **Step 5: Run the affected suites**

Run: `npx vitest run tests/lsp-platform.test.ts tests/lsp-service.test.ts`
Expected: all pass, including `reports the capabilities of the server for a language` (capabilities still `{}`).

Run: `npm run check 2>&1 | tail -3`
Expected: the summary line reads `0 errors`.

- [ ] **Step 6: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # must print lsp-render-verify
git add tests/support/fake-lsp-process.ts tests/lsp-service.test.ts tests/lsp-platform.test.ts src/platform/memory.ts
git commit -m "Let a test hand the memory platform a language server

The fake that lsp-service.test.ts kept to itself moves to tests/support
and learns to answer requests, so the app's own LspService can be run
against it through EditorPane. MemoryPlatform.startLanguageServer returns
what an installed factory makes and otherwise refuses as before."
```

---

### Task 2: The rendering suite

**Files:**
- Create: `tests/support/jsdom-layout.ts`
- Create: `tests/lsp-rendering.test.ts`

**Interfaces:**
- Consumes: `FakeLanguageServer`, `MemoryPlatform.languageServers` (Task 1); `mountComponent`, `flush` from `tests/support/component.ts`; `SERVERS_FILE` from `src/services/lsp/registry.ts`; `pathToUri` from `src/core/uri.ts`; `EditorView.findFromDOM`.
- Produces: `installRangeRects()` from `tests/support/jsdom-layout.ts` — idempotent, no return.

- [ ] **Step 1: The polyfill**

Create `tests/support/jsdom-layout.ts`:

```ts
/**
 * The one piece of layout jsdom lacks that CodeMirror needs to *run*.
 *
 * jsdom has no layout engine. `Element.getBoundingClientRect` exists and
 * returns all zeros; `Range.getClientRects` and
 * `Range.getBoundingClientRect` do not exist at all. CodeMirror's
 * `coordsAtPos` calls the former on a text range, and `HoverPlugin` calls
 * `coordsAtPos` from a bare `setTimeout` — so under jsdom a hover throws
 * `TypeError` before the hover source is ever asked.
 *
 * This fills the missing methods with the same zero rectangle jsdom already
 * returns from every element. **Nothing is invented**: the design that
 * introduced the component harness (2026-08-16, §7) refused to stub
 * measurements because the numbers would be made up here, and that still
 * holds — a test that needs a *particular* rectangle should not exist under
 * jsdom. The consequence to keep in mind when reading a hover test: with
 * all-zero geometry `posAtCoords` resolves to offset 0 for any pointer, so
 * a test can prove hovering asks the server about the pane's document and
 * that the answer reaches the DOM, and cannot prove *which* symbol was
 * under the pointer. That is CodeMirror's arithmetic and needs a browser.
 */
const ZERO_RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON() {
    return this;
  },
} as DOMRect;

export function installRangeRects(): void {
  if (typeof Range === 'undefined') return;
  const proto = Range.prototype as unknown as {
    getClientRects?: () => DOMRect[];
    getBoundingClientRect?: () => DOMRect;
  };
  if (!proto.getClientRects) proto.getClientRects = () => [ZERO_RECT];
  if (!proto.getBoundingClientRect) proto.getBoundingClientRect = () => ZERO_RECT;
}
```

- [ ] **Step 2: Write the suite**

Create `tests/lsp-rendering.test.ts`:

```ts
// @vitest-environment jsdom
import { completionStatus } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EditorPane from '../src/ui/EditorPane.svelte';
import { pathToUri } from '../src/core/uri';
import { SERVERS_FILE } from '../src/services/lsp/registry';
import { flush, mountComponent, type Mounted } from './support/component';
import { FakeLanguageServer } from './support/fake-lsp-process';
import { installRangeRects } from './support/jsdom-layout';

/**
 * What the language server says, on the screen.
 *
 * The wire tests for diagnostics, completion and hover prove what each
 * source returns; `tests/lsp-integration.test.ts` proves a real tsserver
 * says what the fixtures say. Neither proves CodeMirror puts any of it in
 * the DOM, or that the pane's `lspCompartment` delivers the sources into a
 * live view at all — and the work log said so three times. This suite
 * closes that: a real `NoxApp` over a `MemoryPlatform`, its real
 * `LspService` running against an in-memory server, the real `EditorPane`,
 * and assertions on what CodeMirror rendered.
 *
 * What it does not reach — placement, and which symbol was under the
 * pointer — is geometry, and `tests/support/jsdom-layout.ts` says why.
 *
 * Mutation-checked on 2026-08-19, each by breaking `EditorPane.svelte` and
 * watching the test go red before restoring it:
 * - hover: dropping `lspHoverExtension(lspDeps)` from `lspExtensions`;
 * - completion: dropping `lspCompletionExtension(lspDeps)`;
 * - diagnostics: replacing the `applyDiagnostics(view, …)` call with a
 *   no-op.
 */

installRangeRects();

const FILE = '/w/main.ts';
const URI = pathToUri(FILE);
const DOC = 'const answer: number = 42;\nanswer';

/** CodeMirror's hover delay, as `src/editor/hover.ts` names it; waits below allow a few multiples. */
const HOVER_TIME_MS = 300;

let mounted: Mounted | null = null;

afterEach(async () => {
  await mounted?.app.lsp.stop();
  mounted?.unmount();
  mounted = null;
});

/**
 * A pane over `main.ts`, with a server that advertises `capabilities`
 * running behind it. Returns the server so a test can script it, and the
 * live view so a test can drive it.
 */
async function paneWithServer(capabilities: Record<string, unknown>) {
  mounted = mountComponent(EditorPane, { props: { groupId: 'group-1' } });
  const { app, platform, container } = mounted;

  const server = new FakeLanguageServer({ capabilities });
  platform.languageServers = () => server;
  await platform.writeConfigFile(
    SERVERS_FILE,
    JSON.stringify({ servers: [{ languages: ['typescript'], command: 'fake' }] }),
  );
  await app.serverRegistry.load();

  platform.seedFile(FILE, DOC);
  await app.workspace.openFolder('/w');
  await app.lsp.start();
  expect(app.lsp.capabilitiesFor('typescript')).toEqual(capabilities);

  const id = (await app.workspace.open(FILE))!;
  app.workspace.setActive(id);
  flush();

  const view = EditorView.findFromDOM(container)!;
  expect(view).not.toBeNull();
  return { app, server, view, container };
}

function requestsFor(server: FakeLanguageServer, method: string) {
  return server.written.filter((m) => m.method === method);
}

describe('a diagnostic the server publishes', () => {
  it('is drawn under exactly the text its range names, with a gutter mark', async () => {
    const { server, view } = await paneWithServer({});

    // `answer` on the first line: characters 6-12.
    server.publish(URI, [
      {
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
        severity: 1,
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ]);
    flush();

    const squiggles = view.dom.querySelectorAll('.cm-lintRange-error');
    expect(squiggles).toHaveLength(1);
    expect(squiggles[0]!.textContent).toBe('answer');
    expect(view.dom.querySelectorAll('.cm-gutter-lint .cm-lint-marker-error')).toHaveLength(1);
  });

  it('is taken down when the server publishes an empty batch', async () => {
    const { server, view } = await paneWithServer({});
    const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } };

    server.publish(URI, [{ range, severity: 1, message: 'no' }]);
    flush();
    expect(view.dom.querySelectorAll('.cm-lintRange-error')).toHaveLength(1);

    server.publish(URI, []);
    flush();
    expect(view.dom.querySelectorAll('.cm-lintRange-error')).toHaveLength(0);
  });
});

describe('completion', () => {
  const PROVIDER = { completionProvider: { triggerCharacters: ['.'], resolveProvider: true } };

  it('opens the picker with the server\'s items when a trigger character is typed', async () => {
    const { server, view } = await paneWithServer(PROVIDER);
    server.handle('textDocument/completion', () => ({
      isIncomplete: false,
      items: [
        { label: 'length', kind: 10 },
        { label: 'toUpperCase', kind: 2 },
      ],
    }));

    // Type `.` after the trailing `answer`, the way a keystroke does.
    const end = view.state.doc.length;
    view.dispatch({ selection: { anchor: end } });
    view.dispatch({
      changes: { from: end, insert: '.' },
      selection: { anchor: end + 1 },
      userEvent: 'input.type',
    });

    await vi.waitFor(() => expect(completionStatus(view.state)).toBe('active'));
    await vi.waitFor(() =>
      expect(
        Array.from(view.dom.querySelectorAll('.cm-tooltip-autocomplete .cm-completionLabel')).map(
          (label) => label.textContent,
        ),
      ).toEqual(['length', 'toUpperCase']),
    );

    // Asked about this document, at the position after the dot.
    const asked = requestsFor(server, 'textDocument/completion');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.params).toEqual({
      textDocument: { uri: URI },
      position: { line: 1, character: 7 },
    });
  });

  it('fetches and shows documentation for the highlighted item', async () => {
    const { server, view } = await paneWithServer(PROVIDER);
    server.handle('textDocument/completion', () => ({
      isIncomplete: false,
      items: [{ label: 'length', kind: 10 }],
    }));
    server.handle('completionItem/resolve', (item) => ({
      ...(item as object),
      documentation: 'Returns the length of a String object.',
    }));

    const end = view.state.doc.length;
    view.dispatch({ selection: { anchor: end } });
    view.dispatch({
      changes: { from: end, insert: '.' },
      selection: { anchor: end + 1 },
      userEvent: 'input.type',
    });

    await vi.waitFor(() =>
      expect(view.dom.querySelector('.cm-completionInfo .cm-completionInfo-lsp')?.textContent).toBe(
        'Returns the length of a String object.',
      ),
    );
    expect(requestsFor(server, 'completionItem/resolve')).toHaveLength(1);
  });
});

describe('hover', () => {
  const HOVER = { hoverProvider: true };
  const MARKDOWN =
    '```typescript\nconst answer: number\n```\nThe **answer**. <script>alert(1)</script>';

  function rest(view: EditorView): void {
    const line = view.contentDOM.querySelector('.cm-line')!;
    line.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 0, bubbles: true }));
  }

  it('asks the server about this document and shows the answer as text', async () => {
    const { server, view } = await paneWithServer(HOVER);
    server.handle('textDocument/hover', () => ({
      contents: { kind: 'markdown', value: MARKDOWN },
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
    }));

    rest(view);

    await vi.waitFor(
      () => expect(view.dom.querySelector('.cm-tooltip-hover .cm-tooltip-lsp-hover')).not.toBeNull(),
      { timeout: HOVER_TIME_MS * 4 },
    );

    const tooltip = view.dom.querySelector('.cm-tooltip-hover .cm-tooltip-lsp-hover')!;
    expect(tooltip.querySelector('pre')?.textContent).toBe('const answer: number');
    expect(tooltip.querySelector('p')?.textContent).toBe(
      'The **answer**. <script>alert(1)</script>',
    );
    // Text, never markup: the design's whole point, checked on the real DOM.
    expect(tooltip.querySelector('script')).toBeNull();
    expect(tooltip.querySelector('strong')).toBeNull();

    const asked = requestsFor(server, 'textDocument/hover');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.params).toMatchObject({ textDocument: { uri: URI } });
  });

  it('shows nothing when the server has nothing to say', async () => {
    const { server, view } = await paneWithServer(HOVER);
    server.handle('textDocument/hover', () => null);

    rest(view);
    await vi.waitFor(() => expect(requestsFor(server, 'textDocument/hover')).toHaveLength(1), {
      timeout: HOVER_TIME_MS * 4,
    });
    // Give the (absent) tooltip every chance to appear.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(view.dom.querySelector('.cm-tooltip-hover')).toBeNull();
  });

  it('goes away when the pointer leaves the editor', async () => {
    const { server, view } = await paneWithServer(HOVER);
    server.handle('textDocument/hover', () => ({ contents: 'a string, the oldest shape' }));

    rest(view);
    await vi.waitFor(() => expect(view.dom.querySelector('.cm-tooltip-hover')).not.toBeNull(), {
      timeout: HOVER_TIME_MS * 4,
    });

    view.dom.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: document.body }));
    await vi.waitFor(() => expect(view.dom.querySelector('.cm-tooltip-hover')).toBeNull());
  });
});
```

Notes for the implementer, from the probes that produced this file:

- `app.serverRegistry` is public on `NoxApp` (`src/app.ts`); `SERVERS_FILE` is exported from `src/services/lsp/registry.ts`. If `serverRegistry.load()` reads the config file through the platform, writing it before `load()` is what makes `lsp.start()` find the server. Confirm by reading `registry.ts` — do not assume.
- If `EditorView.findFromDOM(container)` returns `null`, the pane has not mounted its view yet; `flush()` after `setActive` is what runs the effect. If it is still null, query `container.querySelector('.cm-editor')` and pass that.
- The completion position `{ line: 1, character: 7 }` is after the `.` typed at the end of `answer` on line 1. If `DOC` changes, recompute it.
- Under jsdom every tooltip carries `style="position: fixed; top: -10000px"` — that is CodeMirror not having measured, and is expected. Do not assert on position.

- [ ] **Step 3: Run it**

Run: `npx vitest run tests/lsp-rendering.test.ts`
Expected: 7 tests pass, and **no `Unhandled Errors` block** in the output. If `TypeError: textRange(...).getClientRects` appears, `installRangeRects()` is not running before the first mount — check it is called at module top level, before any `mountComponent`.

- [ ] **Step 4: Mutation-check each surface**

For each mutation: edit, run `npx vitest run tests/lsp-rendering.test.ts`, confirm the named tests fail and the others pass, restore with `git checkout src/ui/EditorPane.svelte`, rerun, confirm green. Record actual output in your report.

1. In `src/ui/EditorPane.svelte`, `const lspExtensions = [lspCompletionExtension(lspDeps), lspHoverExtension(lspDeps)];` → remove `lspHoverExtension(lspDeps)`. Expected: all three `hover` tests fail (the first two on the tooltip / the request count, the third on the tooltip never appearing).
2. Same line → remove `lspCompletionExtension(lspDeps)`. Expected: both `completion` tests fail (`completionStatus` never `active`, or the labels never appear).
3. `applyDiagnostics(view, path ? lsp.diagnosticsFor(pathToUri(path)) : []);` (around line 161) → comment it out. Expected: both `diagnostic` tests fail on `toHaveLength(1)`.

If a mutation does **not** make its tests fail, the test is not measuring what it claims; stop and fix the test before continuing.

- [ ] **Step 5: Whole suite and type check**

Run: `npm test 2>&1 | tail -6`
Expected: `Test Files 58 passed`, `Tests 10xx passed`, no `Errors` line.

Run: `npm run check 2>&1 | tail -3`
Expected: `0 errors`.

- [ ] **Step 6: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # must print lsp-render-verify
git add tests/support/jsdom-layout.ts tests/lsp-rendering.test.ts
git commit -m "Prove the squiggle, the picker and the tooltip reach the DOM

Mount the real EditorPane over a real NoxApp whose LspService runs
against an in-memory server, and assert on what CodeMirror rendered: a
diagnostic under exactly the text its range names, the picker listing
the server's labels with lazily resolved documentation, and the hover
tooltip carrying the server's markdown as text. Each is mutation-checked
against the pane's wiring.

jsdom lacks Range.getClientRects, which CodeMirror's hover plugin calls
from a timer; tests/support/jsdom-layout.ts fills it with the zero
rectangle jsdom already returns from every element, and says what that
does and does not let a test claim."
```

---

### Task 3: Say what the code does

**Files:**
- Modify: `CHANGELOG.md:11-12`
- Modify: `ROADMAP.md` (v0.4 table, **Hover** row)
- Modify: `src/editor/hover.ts:81-83`
- Modify: `ARCHITECTURE.md:1348`

**Interfaces:** none.

- [ ] **Step 1: CHANGELOG**

At `CHANGELOG.md:11-12` the entry reads:

```
- **Hover.** Rest the pointer on a symbol and Nox shows its type and
  documentation, underlining exactly the span the server is talking about.
```

Replace with:

```
- **Hover.** Rest the pointer on a symbol and Nox shows its type and
  documentation. The tooltip stays while the pointer is anywhere over the
  span the server names, and goes when it leaves.
```

- [ ] **Step 2: ROADMAP**

In the v0.4 table, the **Hover** row begins `Resting the pointer on a symbol shows its type and documentation, highlighting the span the server names rather than the character under the pointer.` Replace that first sentence with:

`Resting the pointer on a symbol shows its type and documentation; the tooltip stays while the pointer is anywhere over the span the server names, not only the character it started on.`

Leave the rest of the row (the no-HTML argument) as it is.

- [ ] **Step 3: hover.ts comment**

`src/editor/hover.ts:81-82`:

```ts
    // The server's own range where it gave one, so the highlight covers the
    // symbol rather than the character the pointer happened to be over.
```

Replace with:

```ts
    // The server's own range where it gave one. CodeMirror draws nothing for
    // it — `pos`/`end` decide when the tooltip *closes*: it stays while the
    // pointer is anywhere over the symbol, not only the character it was
    // over when the timer fired.
```

- [ ] **Step 4: ARCHITECTURE §7 row**

Replace the row at `ARCHITECTURE.md:1348` (`| Components embedding CodeMirror are untested | … |`) with:

```
| Components embedding CodeMirror are tested for wiring and text, not geometry | `EditorPane` mounts under jsdom (`tests/lsp-rendering.test.ts`, `tests/lsp-paint-target.test.ts`): a diagnostic paints under the text its range names, the picker lists what the server sent, the hover tooltip carries the server's markdown as text. jsdom has no layout, so a tooltip's placement and which symbol was under the pointer are not checkable — `tests/support/jsdom-layout.ts` fills the one `Range` method CodeMirror needs to *run* with jsdom's own zero rectangle, and says what that forbids a test from claiming. The first feature whose claim is geometric (a tooltip that must sit beside the pointer, an inlay hint that must not shift the line) is when a browser-mode runner earns its download in CI. |
```

- [ ] **Step 5: Verify the edits landed and nothing else moved**

Run: `git diff --stat` — exactly the four files. Run: `git diff` and read it: no stray CRLF (`^M`), no other hunks.

Run: `npm run check 2>&1 | tail -3` → `0 errors`. Run: `npx vitest run tests/lsp-hover-source.test.ts tests/lsp-rendering.test.ts` → pass (the comment change is in a file both import).

- [ ] **Step 6: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # must print lsp-render-verify
git add CHANGELOG.md ROADMAP.md src/editor/hover.ts ARCHITECTURE.md
git commit -m "Say what hover does: the tooltip follows the span, nothing underlines it

CodeMirror's hoverTooltip draws nothing for a tooltip's range; pos and
end decide when it closes. The changelog, the roadmap and a comment in
hover.ts all promised an underline that never existed, found the moment
the rendering was looked at in a DOM. Corrected to what happens, and
ARCHITECTURE's row on CodeMirror components now states the real
boundary: wiring and text are tested, geometry is not."
```

# Go to Definition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `F12` / **Go to Definition** asks the language server where the symbol under the cursor is defined and moves the cursor there, opening the file first when needed.

**Architecture:** A pure normaliser in `src/core/lsp-definition.ts` reduces the four LSP response shapes to `{ uri, range }[]`. `app.ts` gains a `lsp.goToDefinition` command and a public `revealLocation()` built on `workspace.open` plus `workspace.setSelection`. Tests: node for the normaliser, jsdom (real `EditorPane` + `FakeLanguageServer`, as `tests/lsp-rendering.test.ts` does) for the command, and one case against the real tsserver.

**Tech Stack:** TypeScript, vitest 4 (node + jsdom), Svelte 5 harness, `@codemirror/state`.

**Spec:** `docs/superpowers/specs/2026-08-19-lsp-definition-design.md`

## Global Constraints

- No new dependencies.
- LF line endings (`git ls-files --eol` → `i/lf w/lf`).
- Stage explicit paths; never `git add -A`. Before each commit `git rev-parse --abbrev-ref HEAD` must print `lsp-definition`.
- `npm run check` exits 0 even with errors — grep for `0 errors`.
- Public repo: no personal identifiers in files or messages; do not pass `--author`.
- Every jsdom test that claims a jump is mutation-checked (spec §4) and the mutation recorded in the suite docblock.
- Notification copy, verbatim: `No definition found`; `Go to definition failed`; `${n} definitions — went to the first`; `Definition is not in a file Nox can open`; `Could not open`.
- Command: id `lsp.goToDefinition`, title `Go to Definition`, category `Language`, keywords `['definition', 'declaration', 'jump', 'lsp']`, keymap `F12`.

---

### Task 1: The normaliser

**Files:**
- Create: `src/core/lsp-definition.ts`
- Test: `tests/lsp-definition.test.ts`

**Interfaces:**
- Produces: `export interface LspLocation { uri: string; range: { start: LspPosition; end: LspPosition } }` and `export function definitionTargets(response: unknown): LspLocation[]`. `LspPosition` is imported from `@core/lsp-position` (`{ line: number; character: number }`).

- [ ] **Step 1: Write the failing tests**

`tests/lsp-definition.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { definitionTargets } from '../src/core/lsp-definition';

/**
 * The four shapes a definition response can take, reduced to places to go.
 *
 * Nox does not advertise `linkSupport`, so a conforming server sends
 * `Location | Location[] | null` — but reading `LocationLink[]` too costs one
 * branch and removes one way to be wrong about a server.
 */

const RANGE = { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } };
const WHOLE = { start: { line: 2, character: 0 }, end: { line: 5, character: 1 } };

describe('shapes', () => {
  it('reads a single Location', () => {
    expect(definitionTargets({ uri: 'file:///w/a.ts', range: RANGE })).toEqual([
      { uri: 'file:///w/a.ts', range: RANGE },
    ]);
  });

  it('reads a Location array, in order', () => {
    expect(
      definitionTargets([
        { uri: 'file:///w/a.ts', range: RANGE },
        { uri: 'file:///w/b.ts', range: WHOLE },
      ]),
    ).toEqual([
      { uri: 'file:///w/a.ts', range: RANGE },
      { uri: 'file:///w/b.ts', range: WHOLE },
    ]);
  });

  it('reads LocationLinks, preferring the selection range over the whole declaration', () => {
    expect(
      definitionTargets([
        { targetUri: 'file:///w/a.ts', targetRange: WHOLE, targetSelectionRange: RANGE },
        { targetUri: 'file:///w/b.ts', targetRange: WHOLE },
      ]),
    ).toEqual([
      { uri: 'file:///w/a.ts', range: RANGE },
      { uri: 'file:///w/b.ts', range: WHOLE },
    ]);
  });

  it('reads null, undefined and an empty array as nowhere to go', () => {
    expect(definitionTargets(null)).toEqual([]);
    expect(definitionTargets(undefined)).toEqual([]);
    expect(definitionTargets([])).toEqual([]);
  });
});

describe('what a server can get wrong', () => {
  it('drops an entry with no usable uri or range and keeps the rest', () => {
    expect(
      definitionTargets([
        { uri: 42, range: RANGE },
        { uri: 'file:///w/a.ts', range: { start: { line: 1 } } },
        { uri: 'file:///w/b.ts', range: RANGE },
        'not an object',
      ]),
    ).toEqual([{ uri: 'file:///w/b.ts', range: RANGE }]);
  });

  it('removes duplicates by uri and range', () => {
    expect(
      definitionTargets([
        { uri: 'file:///w/a.ts', range: RANGE },
        { uri: 'file:///w/a.ts', range: { start: { ...RANGE.start }, end: { ...RANGE.end } } },
        { uri: 'file:///w/a.ts', range: WHOLE },
      ]),
    ).toEqual([
      { uri: 'file:///w/a.ts', range: RANGE },
      { uri: 'file:///w/a.ts', range: WHOLE },
    ]);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/lsp-definition.test.ts`
Expected: FAIL — cannot find module `../src/core/lsp-definition`.

- [ ] **Step 3: Implement**

`src/core/lsp-definition.ts`:

```ts
import type { LspPosition } from './lsp-position';

/**
 * Where a definition is, reduced from the four shapes a server may answer in.
 *
 * `textDocument/definition` returns `Location | Location[] | LocationLink[] |
 * null`. Nox does not advertise `linkSupport`, so a conforming server sends
 * the first two — but reading links too costs one branch and removes one way
 * to be wrong about a server. Pure; the app decides what to do with the list.
 */

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

function isPosition(value: unknown): value is LspPosition {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as LspPosition).line === 'number' &&
    typeof (value as LspPosition).character === 'number'
  );
}

function isRange(value: unknown): value is LspRange {
  return (
    typeof value === 'object' &&
    value !== null &&
    isPosition((value as LspRange).start) &&
    isPosition((value as LspRange).end)
  );
}

/** One entry, whichever shape it is, or null when it is neither. */
function locationOf(entry: unknown): LspLocation | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const record = entry as Record<string, unknown>;

  if (typeof record.uri === 'string' && isRange(record.range)) {
    return { uri: record.uri, range: record.range };
  }

  if (typeof record.targetUri === 'string') {
    // The selection range is the identifier; the range is the whole
    // declaration. Landing on the name is what "go to definition" means.
    const range = isRange(record.targetSelectionRange)
      ? record.targetSelectionRange
      : isRange(record.targetRange)
        ? record.targetRange
        : null;
    if (range) return { uri: record.targetUri, range };
  }

  return null;
}

export function definitionTargets(response: unknown): LspLocation[] {
  const entries = Array.isArray(response) ? response : [response];
  const seen = new Set<string>();
  const targets: LspLocation[] = [];

  for (const entry of entries) {
    const location = locationOf(entry);
    if (!location) continue;

    const { start, end } = location.range;
    const key = `${location.uri}:${start.line}:${start.character}-${end.line}:${end.character}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(location);
  }

  return targets;
}
```

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run tests/lsp-definition.test.ts` → 6 passed.
Run: `npm run check 2>&1 | tail -2` → `0 ERRORS`.

- [ ] **Step 5: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # lsp-definition
git add src/core/lsp-definition.ts tests/lsp-definition.test.ts
git commit -m "Reduce a definition response to places to go

Location, Location[], LocationLink[] and null become one list of
uri-and-range, links landing on the identifier rather than the whole
declaration, malformed entries dropped, duplicates removed. Pure, so
the app decides what to do with the list."
```

---

### Task 2: The command and the jump

**Files:**
- Modify: `src/app.ts` — imports near line 19-50; a new command in the `// --- Language` block beside `lsp.reload` (~line 1941-1960); the keymap object (~line 2709, beside `F3`); a new public method `revealLocation` and private `#goToDefinition` near `goToLine` (~line 2801).
- Test: `tests/lsp-go-to-definition.test.ts` (jsdom)

**Interfaces:**
- Consumes: `definitionTargets`, `LspLocation` (Task 1); `offsetAt`, `positionAt` from `@core/lsp-position`; `pathToUri`, `uriToPath` from `@core/uri`; `this.lsp.capabilitiesFor` / `requestFor`; `this.workspace.activeSnapshot()` / `.open(path)`; `this.view.get()`; `this.notifications.info/error`.
- Produces: `NoxApp.revealLocation(location: LspLocation): Promise<void>` (public — find references will call it).

- [ ] **Step 1: Write the failing tests**

`tests/lsp-go-to-definition.test.ts`:

```ts
// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import EditorPane from '../src/ui/EditorPane.svelte';
import { pathToUri } from '../src/core/uri';
import { SERVERS_FILE } from '../src/services/lsp/registry';
import { flush, mountComponent, type Mounted } from './support/component';
import { FakeLanguageServer } from './support/fake-lsp-process';

/**
 * Go to Definition, through the real pane and the real service.
 *
 * The same harness `tests/lsp-rendering.test.ts` uses: a real `NoxApp` over a
 * `MemoryPlatform`, an in-memory language server, the real `EditorPane`. The
 * cursor is real, the request is real, and the landing is read off the view.
 *
 * Mutation-checked on 2026-08-19 against `src/app.ts`: the cross-file test
 * fails when `revealLocation` stops calling `workspace.open`; the same-file
 * test fails when the selection dispatch is removed; the "no definition" test
 * fails when the notification is removed.
 */

const MAIN = '/w/main.ts';
const LIB = '/w/lib.ts';
const MAIN_DOC = 'import { total } from "./lib";\nconsole.log(total);\n';
const LIB_DOC = 'export const total = 42;\n';

let mounted: Mounted | null = null;

afterEach(async () => {
  try {
    await mounted?.app.lsp.stop();
  } finally {
    mounted?.unmount();
    mounted = null;
  }
});

async function paneWithServer(capabilities: Record<string, unknown> = { definitionProvider: true }) {
  mounted = mountComponent(EditorPane, { props: { groupId: 'group-1' } });
  const { app, platform, container } = mounted;

  const server = new FakeLanguageServer({ capabilities });
  platform.languageServerFactory = () => server;
  await platform.writeConfigFile(
    SERVERS_FILE,
    JSON.stringify({ servers: [{ languages: ['typescript'], command: 'fake' }] }),
  );
  await app.serverRegistry.load();

  platform.seedFile(MAIN, MAIN_DOC);
  platform.seedFile(LIB, LIB_DOC);
  await app.workspace.openFolder('/w');
  await app.lsp.start();

  const id = (await app.workspace.open(MAIN))!;
  app.workspace.setActive(id);
  flush();

  const view = EditorView.findFromDOM(container)!;
  // On `total` in `console.log(total)`: line 1, character 14.
  const cursor = MAIN_DOC.indexOf('total', MAIN_DOC.indexOf('\n'));
  view.dispatch({ selection: { anchor: cursor } });
  return { app, server, view, id };
}

function messages(app: Mounted['app']): string[] {
  return app.notifications.items.get().map((n) => n.message);
}

describe('the command', () => {
  it('is disabled when no server for the language offers definitions', async () => {
    const { app } = await paneWithServer({});
    expect(app.commands.isEnabled('lsp.goToDefinition')).toBe(false);
  });

  it('is enabled when the server offers definitions', async () => {
    const { app } = await paneWithServer();
    expect(app.commands.isEnabled('lsp.goToDefinition')).toBe(true);
  });

  it('asks about the symbol under the cursor', async () => {
    const { app, server } = await paneWithServer();
    server.handle('textDocument/definition', () => null);

    await app.commands.execute('lsp.goToDefinition');

    const asked = server.written.filter((m) => m.method === 'textDocument/definition');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.params).toEqual({
      textDocument: { uri: pathToUri(MAIN) },
      position: { line: 1, character: 12 },
    });
  });
});

describe('the jump', () => {
  it('opens the other file and selects the definition', async () => {
    const { app, server, view } = await paneWithServer();
    server.handle('textDocument/definition', () => [
      {
        uri: pathToUri(LIB),
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } },
      },
    ]);

    await app.commands.execute('lsp.goToDefinition');
    flush();

    expect(app.workspace.activeSnapshot()?.path).toBe(LIB);
    const { from, to } = view.state.selection.main;
    expect(view.state.doc.sliceString(from, to)).toBe('total');
    expect(from).toBe(LIB_DOC.indexOf('total'));
  });

  it('moves within the same file without reopening it', async () => {
    const { app, server, view, id } = await paneWithServer();
    // Pretend the import binding is the definition.
    server.handle('textDocument/definition', () => ({
      uri: pathToUri(MAIN),
      range: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } },
    }));

    await app.commands.execute('lsp.goToDefinition');
    flush();

    expect(app.workspace.activeId.get()).toBe(id);
    const { from, to } = view.state.selection.main;
    expect(from).toBe(9);
    expect(view.state.doc.sliceString(from, to)).toBe('total');
  });

  it('says so and stays put when there is nothing to go to', async () => {
    const { app, server, view } = await paneWithServer();
    server.handle('textDocument/definition', () => null);
    const before = view.state.selection.main.head;

    await app.commands.execute('lsp.goToDefinition');

    expect(messages(app)).toContain('No definition found');
    expect(view.state.selection.main.head).toBe(before);
    expect(app.workspace.activeSnapshot()?.path).toBe(MAIN);
  });

  it('takes the first of many and says how many there were', async () => {
    const { app, server } = await paneWithServer();
    server.handle('textDocument/definition', () => [
      { uri: pathToUri(LIB), range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } } },
      { uri: pathToUri(MAIN), range: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } } },
    ]);

    await app.commands.execute('lsp.goToDefinition');
    flush();

    expect(app.workspace.activeSnapshot()?.path).toBe(LIB);
    expect(messages(app)).toContain('2 definitions — went to the first');
  });

  it('reports a definition it cannot open rather than throwing', async () => {
    const { app, server } = await paneWithServer();
    server.handle('textDocument/definition', () => ({
      uri: 'untitled:scratch',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    }));

    await app.commands.execute('lsp.goToDefinition');

    expect(messages(app)).toContain('Definition is not in a file Nox can open');
    expect(app.workspace.activeSnapshot()?.path).toBe(MAIN);
  });
});
```

Notes for the implementer:
- `MAIN_DOC` line 1 is `console.log(total);` — `total` starts at character 12. The `cursor` computed above lands on that `t`; `positionAt` will report `{ line: 1, character: 12 }`. If you change `MAIN_DOC`, recompute both.
- The `paneWithServer` comment says "character 14" — that is wrong; it is 12. Fix the comment when you write the file.
- `app.commands.execute` resolves after the command's `run` promise, so `await` it and then `flush()` before reading the view (the pane swaps state in an effect after `workspace.open`).
- If `EditorView.findFromDOM(container)` returns null, `flush()` after `setActive` first (the plan does).

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/lsp-go-to-definition.test.ts`
Expected: the two `enabled` tests fail (`isEnabled` of an unknown command returns false, so "is enabled" fails; "is disabled" may pass vacuously — that is why "is enabled" exists), and every jump test fails because `execute` returns false for an unknown command.

- [ ] **Step 3: Implement in `src/app.ts`**

Imports (add to the existing `@core` imports; keep alphabetical order with neighbours):

```ts
import { definitionTargets, type LspLocation } from '@core/lsp-definition';
import { offsetAt, positionAt } from '@core/lsp-position';
import { pathToUri, uriToPath } from '@core/uri';
```

(`pathToUri` may already be imported — check and extend the existing line rather than duplicating.)

The command, in the `// --- Language` block after `lsp.reload`:

```ts
      {
        id: 'lsp.goToDefinition',
        title: 'Go to Definition',
        category: 'Language',
        keywords: ['definition', 'declaration', 'jump', 'lsp'],
        enabled: () => {
          const snapshot = this.workspace.activeSnapshot();
          if (!snapshot?.path) return false;
          return Boolean(this.lsp.capabilitiesFor(snapshot.languageId)?.definitionProvider);
        },
        run: () => this.#goToDefinition(),
      },
```

Keymap, beside `F3`:

```ts
      F12: 'lsp.goToDefinition',
```

Methods, after `goToLine`:

```ts
  async #goToDefinition(): Promise<void> {
    const view = this.view.get();
    const snapshot = this.workspace.activeSnapshot();
    if (!view || !snapshot?.path) return;

    const text = view.state.doc.toString();
    let response: unknown;
    try {
      response = await this.lsp.requestFor(snapshot.languageId, 'textDocument/definition', {
        textDocument: { uri: pathToUri(snapshot.path) },
        position: positionAt(text, view.state.selection.main.head),
      });
    } catch (error) {
      this.notifications.error('Go to definition failed', errorMessage(error));
      return;
    }

    const targets = definitionTargets(response);
    if (targets.length === 0) {
      this.notifications.info('No definition found');
      return;
    }

    await this.revealLocation(targets[0]!);
    if (targets.length > 1) {
      // One picker for many is a list UI; find references brings it, and
      // this command will use it. Until then, say what was skipped.
      this.notifications.info(`${targets.length} definitions — went to the first`);
    }
  }

  /**
   * Open the file a location names, if it is not the active one, and select
   * the range. Public because find references lands the same way.
   */
  async revealLocation(location: LspLocation): Promise<void> {
    let path: string;
    try {
      path = uriToPath(location.uri);
    } catch {
      this.notifications.info('Definition is not in a file Nox can open', location.uri);
      return;
    }

    if (this.workspace.activeSnapshot()?.path !== path) {
      const id = await this.workspace.open(path);
      if (!id) {
        this.notifications.error('Could not open', path);
        return;
      }
    }

    // Through the workspace, not the view: the pane swaps the view's state
    // in an effect that has not run yet when `open` resolves, so a dispatch
    // on the view here would land on the *previous* buffer. `setSelection`
    // dispatches to the view when it is showing the buffer and updates the
    // buffer's own state when it is not — the pane then swaps that state
    // in, cursor included. It is the path session restore uses.
    const text = this.workspace.textOf(id) ?? '';
    const from = Math.min(offsetAt(text, location.range.start), text.length);
    const to = Math.min(Math.max(from, offsetAt(text, location.range.end)), text.length);
    this.workspace.setSelection(id, { ranges: [[from, to]], main: 0 });
    this.view.get()?.focus();
  }
```

where `id` is the active buffer's id when the path matched, else the id `open` returned — restructure the top of the method as:

```ts
    const active = this.workspace.activeSnapshot();
    let id = active?.path === path ? active.id : null;
    if (!id) {
      id = await this.workspace.open(path);
      if (!id) {
        this.notifications.error('Could not open', path);
        return;
      }
    }
```

(and drop the earlier `if (this.workspace.activeSnapshot()?.path !== path) {...}` block — this replaces it.)

`workspace.textOf(id)` and `workspace.setSelection(id, { ranges, main })` exist (`src/services/workspace.ts` ~lines 320 and 887). `SelectionRecord` is `{ ranges: [anchor, head][]; main: number }`.

For `errorMessage`: there is no helper in `app.ts`; the file uses `error instanceof Error ? error.message : String(error)` inline (e.g. line ~829). Do the same.

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run tests/lsp-go-to-definition.test.ts` → 8 passed, no Unhandled Errors.

- [ ] **Step 5: Mutation-check**

Each: edit `src/app.ts`, run the file, confirm the named tests fail, `git checkout src/app.ts`... **no** — `git checkout` would discard your implementation. Instead re-apply the line by hand, or stash-free: make the mutation, run, revert the mutation by editing back, run again green. Record outputs.

1. In `revealLocation`, skip the `workspace.open` call (comment out the `if (...path !== path) { ... }` block). Expected: "opens the other file and selects the definition" and "takes the first of many" fail.
2. Remove the `view.dispatch(...)` line. Expected: "moves within the same file" fails on `from`, and "opens the other file" fails on the selection.
3. Remove `this.notifications.info('No definition found')`. Expected: "says so and stays put" fails.

- [ ] **Step 6: Whole suite, check**

Run: `npm test 2>&1 | tail -6` → all pass. `npm run check 2>&1 | tail -2` → `0 ERRORS`.

- [ ] **Step 7: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # lsp-definition
git add src/app.ts tests/lsp-go-to-definition.test.ts
git commit -m "Go to Definition, through the door completion and hover use

F12 asks the server serving the active buffer where the symbol under
the cursor is defined, opens that file if it is another one, and
selects the range. Nothing to go to says so; several says how many and
takes the first, until find references brings the list that both need.
Driven end to end under jsdom through the real pane and service, each
jump mutation-checked."
```

---

### Task 3: Against the real server, and the words

**Files:**
- Modify: `tests/lsp-integration.test.ts` (append one `describe`)
- Modify: `CHANGELOG.md` `[Unreleased]` → `### Added` (new first bullet)
- Modify: `ROADMAP.md` v0.4 table: the row `| **Go to definition, find references** | |`

**Interfaces:** consumes `definitionTargets`.

- [ ] **Step 1: The integration case**

Append to `tests/lsp-integration.test.ts`, mirroring the hover `describe` (same session construction, same `didOpen`, same `90_000` timeout):

```ts
describe('definition from a real typescript-language-server', () => {
  it('resolves a use to its declaration, and says which shape it sends', async () => {
    const session = new LspSession(
      () => spawnLanguageServer(SERVER, SERVER_ARGS, { cwd: workspace }),
      { name: 'typescript-language-server', rootUri: pathToUri(workspace), timeoutMs: 30_000 },
    );

    await session.start();
    expect(session.status.get(), `stderr: ${session.stderr.join(' | ')}`).toBe('running');

    const source = 'const answer: number = 42;\nexport default answer;\n';
    await session.notify('textDocument/didOpen', {
      textDocument: { uri: pathToUri(filePath), languageId: 'typescript', version: 1, text: source },
    });

    const response = await session.request<unknown>('textDocument/definition', {
      textDocument: { uri: pathToUri(filePath) },
      // On the `answer` in `export default answer`.
      position: { line: 1, character: 17 },
    });
    await session.stop();

    // Nox does not advertise linkSupport, so a conforming server sends
    // Location(s). Asserted, like hover's contents shape: if this ever
    // changes, someone reads a failing test rather than a bug report.
    expect(Array.isArray(response)).toBe(true);
    const first = (response as unknown[])[0] as Record<string, unknown>;
    expect(typeof first.uri).toBe('string');
    expect(first.targetUri).toBeUndefined();

    const targets = definitionTargets(response);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.uri).toBe(pathToUri(filePath));
    // The declaration's identifier: line 0, `answer` at characters 6-12.
    expect(targets[0]!.range).toEqual({
      start: { line: 0, character: 6 },
      end: { line: 0, character: 12 },
    });
  }, 90_000);
});
```

Add `import { definitionTargets } from '../src/core/lsp-definition';` beside the other `../src/core` imports.

Run: `npx vitest run tests/lsp-integration.test.ts` → the new case passes (this drives a real Node child; ~10 s). If tsserver's range differs from `6-12`, **read what it sent** and decide: if it points at the identifier, update the expected numbers and say so in the report; if it points at the whole declaration, the assertion is wrong about tsserver, not tsserver about us — record the actual shape as the assertion, as the hover shape test does.

- [ ] **Step 2: CHANGELOG**

Insert as the first bullet under `## [Unreleased]` → `### Added` (before the **Hover** bullet):

```
- **Go to Definition.** `F12`, or the command from the palette, asks the
  language server where the symbol under the cursor is defined and takes you
  there — opening the file first if it is another one, and selecting the
  name so the landing is visible on a line you have never seen. When the
  server offers several places, Nox goes to the first and says how many
  there were; a list to choose from arrives with find references, which
  needs the same one.

```

- [ ] **Step 3: ROADMAP**

Replace `| **Go to definition, find references** | |` with:

```
| **Go to definition** ✅ | `F12`. The same door as hover: `LspService.requestFor` for the question, `workspace.open` and a selection dispatch for the answer — the pair the Problems panel already jumps with. Several results take the first and say so; the picker is find references' list, built once for both. |
| **Find references** | Needs a results list; go to definition's "several" case will use it too. |
```

- [ ] **Step 4: Verify and commit**

Run: `git diff --stat` → exactly the three files. `npm run check 2>&1 | tail -2` → `0 ERRORS`. `npx vitest run tests/lsp-integration.test.ts` → pass.

```bash
git rev-parse --abbrev-ref HEAD   # lsp-definition
git add tests/lsp-integration.test.ts CHANGELOG.md ROADMAP.md
git commit -m "Confirm tsserver's definition shape, and say the feature shipped

The real server sends Location[], not links, and points at the
identifier; asserted so a change is a failing test. The changelog and
the roadmap say what F12 does and what waits for find references."
```

# LSP Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typing `console.` offers `log`, `warn`, `error` from the language server.

**Architecture:** `LspService` grows a request door (`requestFor` / `capabilitiesFor`) — the first use of the LSP client's request direction, and the one hover and go-to-definition will reuse. Conversion from LSP items to CodeMirror completions is a pure module; the completion source is thin glue over it.

**Tech Stack:** TypeScript, CodeMirror 6 (`@codemirror/autocomplete` 6.20.3), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-lsp-completion-design.md`

## Global Constraints

- **Line endings are CRLF.** Multi-line `sed`/`perl`/`python` replacements against `\n` silently no-op. Verify every edit landed.
- **`ui/` may never import `@tauri-apps/*`.** UI talks to services; services talk to `Platform`.
- **Baseline to beat:** `npm test` 988 tests / 51 files, `npm run check` 411 files 0 errors.
- **Commit author** is configured per-repo: `francescoa27122 <42079355+frncescoa27122@users.noreply.github.com>` (the address is deliberately misspelled to match the repo's convention).
- **No real name in commit messages or code.** The repo is public.
- **Do not push, open a PR, or merge without asking.**
- **Measured server behaviour** (typescript-language-server 5.3.0): `triggerCharacters: [".", "\"", "'", "/", "@", "<"]`, `resolveProvider: true`, and no `documentation` in the initial list.

---

### Task 1: The request door on `LspService`

**Files:**
- Modify: `src/services/lsp/index.ts`
- Test: `tests/lsp-service.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `LspSession` (`status`, `capabilities`, `request`), `ServerConfig.languages`.
- Produces: `LspService.capabilitiesFor(languageId: string): ServerCapabilities | null` and `LspService.requestFor<T>(languageId: string, method: string, params: unknown): Promise<T>`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/lsp-service.test.ts`:

```ts
describe('the request door', () => {
  it('asks the server that serves the language', async () => {
    const { service, spawned } = await setup();
    await service.start();

    const pending = service.requestFor('typescript', 'textDocument/completion', { a: 1 });
    await vi.waitFor(() =>
      expect(spawned[0]!.written.some((m) => m.method === 'textDocument/completion')).toBe(true),
    );

    const sent = spawned[0]!.written.find((m) => m.method === 'textDocument/completion')!;
    spawned[0]!.say({ jsonrpc: '2.0', id: sent.id, result: { items: [] } });
    await expect(pending).resolves.toEqual({ items: [] });
  });

  it('rejects when no server serves the language', async () => {
    // Distinct from an empty result: "no server" and "no suggestions" mean
    // very different things to someone staring at an empty picker.
    const { service } = await setup();
    await service.start();

    await expect(service.requestFor('rust', 'textDocument/completion', {})).rejects.toThrow(
      /no language server/i,
    );
  });

  it('reports the capabilities of the server for a language', async () => {
    const { service } = await setup();
    await service.start();

    expect(service.capabilitiesFor('typescript')).toEqual({});
    expect(service.capabilitiesFor('rust')).toBeNull();
  });

  it('does not treat a failed server as available', async () => {
    // Queuing a request behind a dead session would resolve long after the
    // keystroke that asked for it, if ever.
    const { service, spawned } = await setup();
    await service.start();
    spawned[0]!.die(1);

    expect(service.capabilitiesFor('typescript')).toBeNull();
    await expect(service.requestFor('typescript', 'x', {})).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/lsp-service.test.ts -t "request door"`
Expected: FAIL — `service.requestFor is not a function`.

- [ ] **Step 3: Implement**

In `src/services/lsp/index.ts`, add to the class:

```ts
  /** The running session serving this language, if there is one. */
  #sessionFor(languageId: string): LspSession | null {
    const entry = this.#running.find(
      (candidate) =>
        candidate.config.languages.includes(languageId) &&
        candidate.session.status.get() === 'running',
    );
    return entry?.session ?? null;
  }

  /** What the server serving this language can do, or null when none is. */
  capabilitiesFor(languageId: string): ServerCapabilities | null {
    return this.#sessionFor(languageId)?.capabilities.get() ?? null;
  }

  /**
   * Ask the server serving `languageId`.
   *
   * Rejects rather than resolving empty when no server is running: a caller
   * that cannot tell "nothing configured" from "nothing to suggest" will show
   * the user an empty picker for both.
   */
  async requestFor<T>(languageId: string, method: string, params: unknown): Promise<T> {
    const session = this.#sessionFor(languageId);
    if (!session) throw new Error(`lsp: no language server for ${languageId}`);
    return session.request<T>(method, params);
  }
```

Import `ServerCapabilities` from `./session` alongside `LspSession`.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run tests/lsp-service.test.ts`
Expected: PASS, all of them.

- [ ] **Step 5: Verify and commit**

```bash
npm run check && npm test
git add src/services/lsp/index.ts tests/lsp-service.test.ts
git commit -m "Open a request door on the LSP service"
```

---

### Task 2: Converting LSP items to CodeMirror completions

**Files:**
- Create: `src/core/lsp-completion.ts`
- Test: `tests/lsp-completion.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface LspCompletionItem { label: string; kind?: number; detail?: string; documentation?: string | { value: string }; sortText?: string; filterText?: string; insertText?: string; insertTextFormat?: 1 | 2; textEdit?: { range: { start: LspPosition; end: LspPosition }; newText: string }; data?: unknown }`
  - `completionKind(kind: number | undefined): string`
  - `stripSnippet(text: string): string`
  - `toCodeMirrorCompletions(text: string, items: readonly LspCompletionItem[], options?: { resolve?: (item: LspCompletionItem) => Promise<string | null> }): Completion[]`

- [ ] **Step 1: Write the failing tests**

`tests/lsp-completion.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  completionKind,
  stripSnippet,
  toCodeMirrorCompletions,
  type LspCompletionItem,
} from '../src/core/lsp-completion';

const DOC = 'console.\n';

function item(overrides: Partial<LspCompletionItem> = {}): LspCompletionItem {
  return { label: 'log', ...overrides };
}

describe('kinds', () => {
  it('maps the ones people actually see', () => {
    expect(completionKind(3)).toBe('function');
    expect(completionKind(2)).toBe('method');
    expect(completionKind(6)).toBe('variable');
    expect(completionKind(7)).toBe('class');
    expect(completionKind(8)).toBe('interface');
    expect(completionKind(14)).toBe('keyword');
    expect(completionKind(21)).toBe('constant');
  });

  it('falls back to variable for an unknown or missing kind', () => {
    // An unrecognised kind is a rendering question, not an error — an
    // untyped completion renders without an icon and looks broken.
    expect(completionKind(99)).toBe('variable');
    expect(completionKind(undefined)).toBe('variable');
  });

  it('has a mapping for every kind the protocol defines', () => {
    for (let kind = 1; kind <= 25; kind++) {
      expect(typeof completionKind(kind)).toBe('string');
    }
  });
});

describe('what gets inserted', () => {
  it('prefers a textEdit, which names the exact range to replace', () => {
    // Ignoring it is how `console.log` becomes `console.console.log`.
    const [c] = toCodeMirrorCompletions(DOC, [
      item({
        textEdit: {
          range: { start: { line: 0, character: 8 }, end: { line: 0, character: 8 } },
          newText: 'log',
        },
      }),
    ]);

    expect(c).toMatchObject({ apply: 'log', from: 8, to: 8 });
  });

  it('uses insertText when there is no textEdit', () => {
    expect(toCodeMirrorCompletions(DOC, [item({ insertText: 'logged' })])[0]?.apply).toBe('logged');
  });

  it('falls back to the label when there is neither', () => {
    const [c] = toCodeMirrorCompletions(DOC, [item()]);
    expect(c?.label).toBe('log');
    expect(c?.apply).toBeUndefined();
  });
});

describe('snippets', () => {
  it('strips placeholders to their default text', () => {
    // `foo(${1:arg})` inserted verbatim is the failure a user notices.
    expect(stripSnippet('foo(${1:arg})')).toBe('foo(arg)');
    expect(stripSnippet('foo($1)')).toBe('foo()');
    expect(stripSnippet('done$0')).toBe('done');
  });

  it('leaves a plain string alone', () => {
    expect(stripSnippet('log')).toBe('log');
  });

  it('applies stripping only to snippet-format items', () => {
    const snippet = toCodeMirrorCompletions(DOC, [
      item({ insertText: 'foo(${1:arg})', insertTextFormat: 2 }),
    ]);
    const plain = toCodeMirrorCompletions(DOC, [
      item({ insertText: 'foo(${1:arg})', insertTextFormat: 1 }),
    ]);

    expect(snippet[0]?.apply).toBe('foo(arg)');
    expect(plain[0]?.apply).toBe('foo(${1:arg})');
  });
});

describe('the rest of the item', () => {
  it('passes detail and sort order through', () => {
    const [c] = toCodeMirrorCompletions(DOC, [item({ detail: '(method) log', sortText: '00' })]);
    expect(c?.detail).toBe('(method) log');
    expect(c?.sortText).toBe('00');
  });

  it('uses filterText for matching when the label is decorated', () => {
    const [c] = toCodeMirrorCompletions(DOC, [item({ label: '● log', filterText: 'log' })]);
    expect(c?.label).toBe('log');
    expect(c?.displayLabel).toBe('● log');
  });

  it('shows documentation that came with the item', () => {
    const [c] = toCodeMirrorCompletions(DOC, [item({ documentation: 'Logs a message' })]);
    expect(c?.info).toBe('Logs a message');
  });

  it('unwraps markup-content documentation', () => {
    const [c] = toCodeMirrorCompletions(DOC, [item({ documentation: { value: 'Logs it' } })]);
    expect(c?.info).toBe('Logs it');
  });

  it('converts an empty list to an empty list', () => {
    expect(toCodeMirrorCompletions(DOC, [])).toEqual([]);
  });
});

describe('lazy documentation', () => {
  it('asks the resolver only when the item has none of its own', async () => {
    const asked: string[] = [];
    const [c] = toCodeMirrorCompletions(DOC, [item()], {
      resolve: async (i) => {
        asked.push(i.label);
        return 'Resolved docs';
      },
    });

    expect(typeof c?.info).toBe('function');
    expect(asked).toEqual([]); // Nothing fetched until it is shown.

    const info = await (c!.info as (c: unknown) => Promise<string | null>)(c);
    expect(info).toBe('Resolved docs');
    expect(asked).toEqual(['log']);
  });

  it('shows the item without documentation when resolving fails', async () => {
    // A missing tooltip is a small loss; an exception inside the picker is not.
    const [c] = toCodeMirrorCompletions(DOC, [item()], {
      resolve: async () => {
        throw new Error('server said no');
      },
    });

    await expect((c!.info as (c: unknown) => Promise<string | null>)(c)).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/lsp-completion.test.ts`
Expected: FAIL — cannot resolve `../src/core/lsp-completion`.

- [ ] **Step 3: Implement `src/core/lsp-completion.ts`**

```ts
import type { Completion } from '@codemirror/autocomplete';
import { offsetAt, type LspPosition } from './lsp-position';

/**
 * LSP completion items to CodeMirror completions.
 *
 * Its own module, with its own tests, for the reason `toCodeMirrorDiagnostics`
 * is: this is where being wrong is invisible. A mis-mapped kind is a wrong
 * icon, but a mishandled `textEdit` silently corrupts the line the user is
 * typing on.
 */

export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { value: string };
  sortText?: string;
  filterText?: string;
  insertText?: string;
  /** 1 plain text, 2 snippet. */
  insertTextFormat?: 1 | 2;
  textEdit?: { range: { start: LspPosition; end: LspPosition }; newText: string };
  /** Opaque; handed back verbatim on `completionItem/resolve`. */
  data?: unknown;
}

/**
 * The protocol's 25 kinds, to the strings CodeMirror renders icons from.
 * Anything unrecognised is a `variable`: an untyped completion renders
 * without an icon, which looks broken rather than unknown.
 */
const KINDS: Record<number, string> = {
  1: 'text',
  2: 'method',
  3: 'function',
  4: 'function', // Constructor
  5: 'property', // Field
  6: 'variable',
  7: 'class',
  8: 'interface',
  9: 'namespace', // Module
  10: 'property',
  11: 'keyword', // Unit
  12: 'constant', // Value
  13: 'enum',
  14: 'keyword',
  15: 'text', // Snippet
  16: 'constant', // Color
  17: 'text', // File
  18: 'text', // Reference
  19: 'text', // Folder
  20: 'constant', // EnumMember
  21: 'constant',
  22: 'class', // Struct
  23: 'keyword', // Event
  24: 'keyword', // Operator
  25: 'type', // TypeParameter
};

export function completionKind(kind: number | undefined): string {
  return (kind !== undefined && KINDS[kind]) || 'variable';
}

/**
 * Reduce snippet syntax to the text it would insert.
 *
 * `${1:arg}` becomes `arg`, `$1` and `$0` vanish. Not snippet *support* —
 * that needs CodeMirror's own snippet lifecycle — but it keeps `${1:arg}`
 * out of the user's buffer, which is the failure they would have to undo.
 */
export function stripSnippet(text: string): string {
  return text
    .replace(/\$\{(\d+):([^}]*)\}/g, '$2')
    .replace(/\$\{(\d+)\}/g, '')
    .replace(/\$(\d+)/g, '')
    .replace(/\\\$/g, '$');
}

function documentationOf(item: LspCompletionItem): string | null {
  if (item.documentation === undefined) return null;
  return typeof item.documentation === 'string' ? item.documentation : item.documentation.value;
}

export interface ConvertOptions {
  /** Fetches documentation for one item, when it arrives without any. */
  resolve?: (item: LspCompletionItem) => Promise<string | null>;
}

export function toCodeMirrorCompletions(
  text: string,
  items: readonly LspCompletionItem[],
  options: ConvertOptions = {},
): Completion[] {
  return items.map((item) => {
    const snippet = item.insertTextFormat === 2;

    let apply: string | undefined;
    let range: { from: number; to: number } | undefined;

    if (item.textEdit) {
      // The server naming the exact range it wants replaced.
      apply = snippet ? stripSnippet(item.textEdit.newText) : item.textEdit.newText;
      range = {
        from: offsetAt(text, item.textEdit.range.start),
        to: offsetAt(text, item.textEdit.range.end),
      };
    } else if (item.insertText !== undefined) {
      apply = snippet ? stripSnippet(item.insertText) : item.insertText;
    }

    const documentation = documentationOf(item);
    const label = item.filterText ?? item.label;

    const completion: Completion = {
      label,
      type: completionKind(item.kind),
      ...(label !== item.label ? { displayLabel: item.label } : {}),
      ...(item.detail ? { detail: item.detail } : {}),
      ...(item.sortText ? { sortText: item.sortText } : {}),
      ...(apply !== undefined ? { apply } : {}),
      ...(range ?? {}),
    };

    if (documentation) {
      completion.info = documentation;
    } else if (options.resolve) {
      // A function, so CodeMirror calls it only for the highlighted item.
      // Resolving the whole list would be hundreds of round trips to render
      // one tooltip.
      completion.info = async () => {
        try {
          return await options.resolve!(item);
        } catch {
          // A missing tooltip is a small loss; an exception inside the
          // picker is not.
          return null;
        }
      };
    }

    return completion;
  });
}
```

Note: `from`/`to` are not part of CodeMirror's `Completion`; they are carried here for the source in Task 3 to read, so declare the return as `(Completion & { from?: number; to?: number })[]` and adjust the test's `toMatchObject` accordingly if the type check complains.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run tests/lsp-completion.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
npm run check && npm test
git add src/core/lsp-completion.ts tests/lsp-completion.test.ts
git commit -m "Convert LSP completion items, text edits winning over labels"
```

---

### Task 3: The completion source

**Files:**
- Create: `src/editor/completion.ts`
- Test: `tests/lsp-completion-source.test.ts`

**Interfaces:**
- Consumes: `toCodeMirrorCompletions` (Task 2), `LspService.requestFor` / `capabilitiesFor` (Task 1), `positionAt` from `@core/lsp-position`, `pathToUri` from `@core/uri`.
- Produces: `createLspCompletionSource(deps: CompletionDeps): CompletionSource` and `lspCompletionExtension(deps: CompletionDeps): Extension`, where `CompletionDeps` is `{ lsp: Pick<LspService, 'requestFor' | 'capabilitiesFor'>; documentOf: () => { uri: string; languageId: string } | null }`.

- [ ] **Step 1: Write the failing tests**

`tests/lsp-completion-source.test.ts` — cover, one `it` each:

1. Fires on an explicit request and returns the server's items.
2. Fires after one of the server's own trigger characters (`.` for tsserver).
3. Returns `null` when the character before the cursor is neither a word character nor a trigger character and the request is not explicit — an idle keystroke must not become a round trip.
4. Returns `null` when `capabilitiesFor` gives `null` (no server) — and the request is never made.
5. Returns `null` when `requestFor` rejects.
6. Returns `null` when `context.aborted` is true after the await — build the context, start the request, set aborted, then resolve.
7. Sets `validFor` when the list is complete, and omits it when `isIncomplete: true`.
8. Accepts both response shapes: a bare array, and `{ items: [...] }`.

Build a `CompletionContext` with `new CompletionContext(state, pos, explicit)` from `@codemirror/autocomplete`, and an `EditorState.create({ doc })` from `@codemirror/state`. The `lsp` dependency is a hand-written object literal — no service, no process.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/lsp-completion-source.test.ts`
Expected: FAIL — cannot resolve `../src/editor/completion`.

- [ ] **Step 3: Implement `src/editor/completion.ts`**

The source:

```ts
const source: CompletionSource = async (context) => {
  const document = deps.documentOf();
  if (!document) return null;

  const capabilities = deps.lsp.capabilitiesFor(document.languageId);
  const provider = capabilities?.completionProvider as
    | { triggerCharacters?: string[]; resolveProvider?: boolean }
    | undefined;
  if (!provider) return null;

  const text = context.state.doc.toString();
  const before = text.slice(Math.max(0, context.pos - 1), context.pos);
  const word = context.matchBefore(/[\w$]+/);
  const triggered = (provider.triggerCharacters ?? []).includes(before);

  if (!context.explicit && !word && !triggered) return null;

  let response: unknown;
  try {
    response = await deps.lsp.requestFor(document.languageId, 'textDocument/completion', {
      textDocument: { uri: document.uri },
      position: positionAt(text, context.pos),
    });
  } catch {
    return null;
  }

  // Checked after the await: CodeMirror cancels stale requests as the user
  // keeps typing, and a result that outlives its keystroke describes text
  // that is no longer there.
  if (context.aborted) return null;

  const list = Array.isArray(response)
    ? { items: response as LspCompletionItem[], isIncomplete: false }
    : (response as { items?: LspCompletionItem[]; isIncomplete?: boolean }) ?? {};
  const items = list.items ?? [];

  return {
    from: word?.from ?? context.pos,
    options: toCodeMirrorCompletions(text, items, {
      resolve: provider.resolveProvider
        ? async (item) => {
            const resolved = await deps.lsp.requestFor<LspCompletionItem>(
              document.languageId,
              'completionItem/resolve',
              item,
            );
            return typeof resolved.documentation === 'string'
              ? resolved.documentation
              : (resolved.documentation?.value ?? null);
          }
        : undefined,
    }),
    // An incomplete list is the server saying "ask again on the next
    // character"; caching it shows suggestions for a prefix already left.
    ...(list.isIncomplete ? {} : { validFor: /^[\w$]*$/ }),
  };
};
```

`lspCompletionExtension(deps)` returns `autocompletion({ override: [createLspCompletionSource(deps)] })`.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run tests/lsp-completion-source.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
npm run check && npm test
git add src/editor/completion.ts tests/lsp-completion-source.test.ts
git commit -m "Ask the server for completions, and drop the stale answers"
```

---

### Task 4: Wiring it into the editor

**Files:**
- Modify: `src/editor/extensions.ts`, `src/ui/EditorPane.svelte`
- Test: `tests/lsp-completion-source.test.ts` (one added case)

**Interfaces:**
- Consumes: `lspCompletionExtension` (Task 3).
- Produces: nothing new.

- [ ] **Step 1: Decide where the dependency comes from**

The source needs the *current* buffer's URI and language, which is the pane's
question, not the app's — the same lesson as the diagnostics paint. So the
extension is built in `EditorPane` where `currentId` is authoritative, and
`documentOf` closes over it:

```ts
const completion = lspCompletionExtension({
  lsp,
  documentOf: () => {
    if (!currentId) return null;
    const buffer = workspace.buffers.get().find((b) => b.id === currentId);
    if (!buffer?.path) return null;
    return { uri: pathToUri(buffer.path), languageId: buffer.languageId };
  },
});
```

Add it to the state through a compartment in `buildExtensions`, or dispatch it
as an effect after `view.setState`. Prefer the compartment.

- [ ] **Step 2: Add a test that the dependency reads the shown buffer**

Assert `documentOf` returns the URI of the buffer the pane is showing after a
tab switch, not the app-wide active one.

- [ ] **Step 3: Run the suite**

Run: `npm run check && npm test`
Expected: 0 errors, all pass.

- [ ] **Step 4: Commit**

```bash
git add src/editor src/ui/EditorPane.svelte tests/lsp-completion-source.test.ts
git commit -m "Wire completion to the buffer the pane is showing"
```

---

### Task 5: Against the real server

**Files:**
- Modify: `tests/lsp-integration.test.ts`

**Interfaces:**
- Consumes: `LspSession` and `spawnLanguageServer` already in that file.

- [ ] **Step 1: Write the failing test**

Add a case that opens a real TypeScript document containing `console.` and
issues `textDocument/completion` at the end of that line, asserting:

- the response is non-empty
- `log` is among the labels
- that item carries a `kind` (tsserver sends 2, method)

This is the test that would have caught the diagnostics `version` assumption;
the equivalent assumption here is that tsserver returns anything useful for a
bare member access.

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/lsp-integration.test.ts`
Expected: PASS. If `log` is absent, read what *was* returned before changing
the assertion — the answer is evidence about the server, not a test to bend.

- [ ] **Step 3: Commit**

```bash
npm test
git add tests/lsp-integration.test.ts
git commit -m "Ask a real server for completions"
```

---

### Task 6: Documentation

**Files:**
- Modify: `ROADMAP.md`, `CHANGELOG.md`, `WORKLOG.md`

- [ ] **Step 1: Update each**

`ROADMAP.md`: mark **Completion** shipped in the v0.4 table, in the form `#24` established, and say what it does and does not do — snippets are out.
`CHANGELOG.md`: an Unreleased entry leading with what someone can do.
`WORKLOG.md`: a new entry on top, in the Shipped / Verified / Next / Blocked / Confidence format.

- [ ] **Step 2: Verify and commit**

```bash
npm run check && npm test
git add ROADMAP.md CHANGELOG.md WORKLOG.md
git commit -m "Write down completion, snippets excepted"
```

---

## Done when

- `npm test` passes with every new test, and the count is stated.
- `npm run check` reports 0 errors.
- The real-server test passes, and what it found is reported.
- Nothing is pushed, no PR is opened.
- The picker itself is **declared unverified** — it needs a build and a human, as the squiggle did.

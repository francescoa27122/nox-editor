# Go to Symbol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Type `@` in the command palette and jump to a function, class or heading in the file you are looking at.

**Architecture:** A pure scan (`core/symbols.ts`) walks the Lezer tree CodeMirror has already parsed for folding, matching node names against one shared table rather than per-language config. The palette gains a fourth prefix mode that renders the result through the `Row` shape its other three modes already use.

**Tech Stack:** TypeScript, Svelte 5 (runes), CodeMirror 6, Lezer, Vitest.

**Spec:** [docs/superpowers/specs/2026-08-16-go-to-symbol-design.md](../specs/2026-08-16-go-to-symbol-design.md) — read it before Task 1. §5 explains why the table is shared rather than per-language, and it is the decision most likely to look wrong without the reasoning.

## Global Constraints

- **Branch:** `go-to-symbol`. It exists and holds the spec commit.
- **No logic in components.** Model it in a service or a `core/` module; components render. The scan is pure and lives in `core/` for exactly this reason.
- **Every action is a command**, registered in `app.ts#registerCommands` with a category and keywords, so it appears in the palette automatically.
- **No component may hardcode a default.** This feature adds no preference.
- **Structure only.** Functions, classes, methods, interfaces, types, enums, modules, CSS rule sets, Markdown headings. **Not** variables, constants, imports, or call sites.
- **JSON and HTML collect nothing**, deliberately. Do not add rules for them.
- **The icon is `dot` for every symbol.** `IconName` has no function/class/heading glyph and this feature does not add one.
- **Do not run prettier.** This repo has no prettier config, is not a dependency, and has no format script; running it rewrites the file to double quotes against house style. Match the surrounding code by hand: single quotes, 2-space indent.
- Run `npm test` and `npm run check` before every commit. Both are green on this branch's base.
- Do **not** run `npm run app`. Task 4 uses the browser target.

---

## File Structure

**New:**

| File | Responsibility |
|---|---|
| `src/core/symbols.ts` | The rule table and the pure tree walk. No CodeMirror view, no DOM. |
| `tests/symbols.test.ts` | The walk against real parses, one case per grammar. |

**Modified:**

| File | Change |
|---|---|
| `src/ui/CommandPalette.svelte` | The `@` mode, its rows, its placeholder, its prefix hint |
| `src/app.ts` | `nav.goToSymbol` and its `Mod+R` binding |
| `README.md`, `CHANGELOG.md`, `ROADMAP.md`, `ARCHITECTURE.md` | Task 5 |

---

### Task 1: The scan

**Files:**
- Create: `src/core/symbols.ts`
- Test: `tests/symbols.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, and Tasks 2–3 depend on these exact names:
  - `export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'module' | 'rule' | 'heading'`
  - `export interface FileSymbol { name: string; qualified: string; kind: SymbolKind; from: number; to: number }`
  - `export function fileSymbols(tree: Tree, doc: Text): FileSymbol[]` — document order.

- [ ] **Step 1: Write the failing tests**

Create `tests/symbols.test.ts`. The parsers are already dependencies; `configure({ dialect: 'ts' })` is what gives TypeScript nodes.

```ts
import { htmlLanguage } from '@codemirror/lang-html';
import { parser as cssParser } from '@lezer/css';
import { parser as jsParser } from '@lezer/javascript';
import { parser as pythonParser } from '@lezer/python';
import { parser as rustParser } from '@lezer/rust';
import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { fileSymbols } from '../src/core/symbols';

const ts = jsParser.configure({ dialect: 'ts' });

/** Parse with `parser` and return the symbols as "qualified:kind" strings. */
function scan(parser: { parse: (input: string) => never }, source: string): string[] {
  const doc = Text.of(source.split('\n'));
  return fileSymbols(parser.parse(source), doc).map((s) => `${s.qualified}:${s.kind}`);
}

describe('the symbols in a file', () => {
  /**
   * The failure this prevents: a method listed as `bar`, so a file with four
   * classes each having a `render` gives four identical rows and no way to
   * tell them apart. Fuzzy matching runs over the title, so the enclosing
   * name has to be in it.
   */
  it('qualifies a method with its class', () => {
    expect(scan(ts, 'class Foo {\n  bar() {}\n}\n')).toEqual(['Foo:class', 'Foo.bar:function']);
  });

  /**
   * The failure this prevents: collecting every named node, which turns the
   * list into an outline of the parse tree rather than of the code.
   */
  it('ignores variables, imports and call sites', () => {
    const source = "import { x } from 'y';\nconst a = 1;\nfunction real() {}\nreal();\n";
    expect(scan(ts, source)).toEqual(['real:function']);
  });

  it('reads TypeScript interfaces, type aliases and enums', () => {
    const source = 'interface I {}\ntype T = string;\nenum E { A }\n';
    expect(scan(ts, source)).toEqual(['I:interface', 'T:type', 'E:enum']);
  });

  it('reads Python classes and defs', () => {
    const source = 'class Foo:\n    def bar(self):\n        pass\n';
    expect(scan(pythonParser, source)).toEqual(['Foo:class', 'Foo.bar:function']);
  });

  /**
   * Rust names items with two different node types — `BoundIdentifier` for
   * functions and modules, `TypeIdentifier` for structs, enums, traits, impls
   * and type aliases. Reading only one of them silently loses half of Rust.
   */
  it('reads Rust items named by either identifier node', () => {
    const source = 'struct S {}\ntrait T {}\nmod m {}\nimpl S {\n    fn f() {}\n}\n';
    expect(scan(rustParser, source)).toEqual([
      'S:class',
      'T:interface',
      'm:module',
      'S:class',
      'S.f:function',
    ]);
  });

  /**
   * A CSS rule set has no name child: the selector is the text from the node
   * to its `Block`. Taking the whole node's text would put the declarations
   * in the title.
   */
  it('names a CSS rule set by its selector', () => {
    expect(scan(cssParser, '.foo, .bar {\n  color: red;\n}\n')).toEqual(['.foo, .bar:rule']);
  });

  /**
   * The failure this prevents: an empty list where the file plainly has
   * structure, because the walk only ever looked at top-level nodes.
   */
  it('finds a nested function inside another function', () => {
    expect(scan(ts, 'function outer() {\n  function inner() {}\n}\n')).toEqual([
      'outer:function',
      'outer.inner:function',
    ]);
  });

  it('returns nothing for a file with no structure', () => {
    expect(scan(ts, 'const a = 1;\nconst b = 2;\n')).toEqual([]);
  });

  /**
   * The design's central argument, and the case that regresses silently under
   * a per-language table: `@codemirror/lang-html` nests the CSS and
   * JavaScript grammars, so one `.html` tree holds `RuleSet` *and*
   * `FunctionDeclaration`. Rules keyed by the file's language would look up
   * "html", find the rules for a grammar that deliberately collects nothing,
   * and return an empty list for a file plainly full of structure.
   *
   * Uses `htmlLanguage.parser`, not `@lezer/html` — the bare grammar does not
   * nest, and testing against it would prove nothing.
   */
  it('finds symbols from every grammar in a mixed-language file', () => {
    const source = '<style>.a { color: red }</style>\n<script>function f() {}</script>\n';
    expect(scan(htmlLanguage.parser, source)).toEqual(['.a:rule', 'f:function']);
  });

  /**
   * `from`/`to` are what the palette jumps to, so they must be the node's own
   * range rather than the name child's.
   */
  it('reports the range of the whole declaration', () => {
    const doc = Text.of(['function f() {}']);
    const [symbol] = fileSymbols(ts.parse('function f() {}'), doc);
    expect([symbol?.from, symbol?.to]).toEqual([0, 15]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/symbols.test.ts`
Expected: FAIL — `src/core/symbols.ts` does not exist, so the import throws.

- [ ] **Step 3: Write the module**

Create `src/core/symbols.ts`:

```ts
import type { Text } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';

/**
 * The named things you navigate *to* in a file, from the parse CodeMirror
 * already keeps for folding.
 *
 * Pure and view-free so it can be tested against a real parse headlessly,
 * exactly as `foldRangesAtLevel` is.
 */

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'module'
  | 'rule'
  | 'heading';

export interface FileSymbol {
  /** The symbol's own name, as written. */
  name: string;
  /** Its path by tree containment: `Foo.bar`. What the palette matches on. */
  qualified: string;
  kind: SymbolKind;
  from: number;
  to: number;
}

interface Rule {
  kind: SymbolKind;
  /**
   * Direct-child node types holding the name, tried in order. Rust needs two:
   * `BoundIdentifier` names functions and modules, `TypeIdentifier` names
   * structs, enums, traits, impls and type aliases.
   */
  nameFrom?: readonly string[];
  /** Take the node's own text up to `stopAt`, for nodes with no name child. */
  ownTextUntil?: string | true;
  /** Strip this from the front of the text, for Markdown's `##`. */
  strip?: RegExp;
  /** Never contributes to a descendant's qualified path. */
  flat?: boolean;
}

/**
 * One table for every grammar, keyed by Lezer node name.
 *
 * Not one table per language, and the deciding case is mixed-language files:
 * a Svelte or Vue tree holds HTML, JavaScript and CSS nodes at once, so rules
 * keyed by the *file's* language would find symbols from one of the three and
 * silently miss the rest. Node names do not collide across grammars —
 * `FunctionDeclaration`, `FunctionDefinition` and `FunctionItem` are three
 * spellings of one idea — so matching on the name alone has nothing to get
 * wrong. See the design doc §5.
 *
 * Every name below was read out of `parser.nodeSet.types` and confirmed
 * against a real parse, not remembered.
 */
const RULES: Record<string, Rule> = {
  // JavaScript / TypeScript / JSX / TSX
  FunctionDeclaration: { kind: 'function', nameFrom: ['VariableDefinition'] },
  ClassDeclaration: { kind: 'class', nameFrom: ['VariableDefinition'] },
  MethodDeclaration: { kind: 'function', nameFrom: ['PropertyDefinition', 'PropertyName'] },
  InterfaceDeclaration: { kind: 'interface', nameFrom: ['TypeDefinition'] },
  TypeAliasDeclaration: { kind: 'type', nameFrom: ['TypeDefinition'] },
  EnumDeclaration: { kind: 'enum', nameFrom: ['TypeDefinition'] },
  NamespaceDeclaration: { kind: 'module', nameFrom: ['VariableDefinition'] },

  // Python
  FunctionDefinition: { kind: 'function', nameFrom: ['VariableName'] },
  ClassDefinition: { kind: 'class', nameFrom: ['VariableName'] },

  // Rust
  FunctionItem: { kind: 'function', nameFrom: ['BoundIdentifier'] },
  ModItem: { kind: 'module', nameFrom: ['BoundIdentifier'] },
  StructItem: { kind: 'class', nameFrom: ['TypeIdentifier'] },
  EnumItem: { kind: 'enum', nameFrom: ['TypeIdentifier'] },
  TraitItem: { kind: 'interface', nameFrom: ['TypeIdentifier'] },
  ImplItem: { kind: 'class', nameFrom: ['TypeIdentifier'] },
  TypeItem: { kind: 'type', nameFrom: ['TypeIdentifier'] },

  // CSS / SCSS. The selector is the text before the block, not a child.
  RuleSet: { kind: 'rule', ownTextUntil: 'Block' },

  // Markdown. Flat: these nest by *level*, not by containment, so an H2 is a
  // sibling of its H1 in the tree and inferring a hierarchy would mean a
  // second algorithm over the numbers.
  ATXHeading1: { kind: 'heading', ownTextUntil: true, strip: /^#+\s*/, flat: true },
  ATXHeading2: { kind: 'heading', ownTextUntil: true, strip: /^#+\s*/, flat: true },
  ATXHeading3: { kind: 'heading', ownTextUntil: true, strip: /^#+\s*/, flat: true },
  ATXHeading4: { kind: 'heading', ownTextUntil: true, strip: /^#+\s*/, flat: true },
  ATXHeading5: { kind: 'heading', ownTextUntil: true, strip: /^#+\s*/, flat: true },
  ATXHeading6: { kind: 'heading', ownTextUntil: true, strip: /^#+\s*/, flat: true },
  SetextHeading1: { kind: 'heading', ownTextUntil: true, flat: true },
  SetextHeading2: { kind: 'heading', ownTextUntil: true, flat: true },
};

/** The name for one matched node, or null when the grammar gave us none. */
function nameOf(node: SyntaxNode, rule: Rule, doc: Text): string | null {
  if (rule.ownTextUntil) {
    const stop =
      rule.ownTextUntil === true ? node.to : (node.getChild(rule.ownTextUntil)?.from ?? node.to);
    let text = doc.sliceString(node.from, stop).trim();
    if (rule.strip) text = text.replace(rule.strip, '').trim();
    return text.length > 0 ? text : null;
  }
  for (const type of rule.nameFrom ?? []) {
    const child = node.getChild(type);
    if (child) return doc.sliceString(child.from, child.to);
  }
  return null;
}

/**
 * Every symbol in `tree`, in document order.
 *
 * One walk, keeping a stack of enclosing names for the qualified path — the
 * same shape `foldRangesAtLevel` uses to get depth without re-walking per
 * line. An anonymous match (a default-exported class, say) still pushes onto
 * the stack, because its *children* are still inside it; it just contributes
 * nothing to their path.
 */
export function fileSymbols(tree: Tree, doc: Text): FileSymbol[] {
  const found: FileSymbol[] = [];
  const enclosing: string[] = [];

  tree.iterate({
    enter(nodeRef) {
      const rule = RULES[nodeRef.name];
      if (!rule) return true;

      const name = nameOf(nodeRef.node, rule, doc);
      if (name === null) return true;

      const qualified = enclosing.length > 0 ? `${enclosing.join('.')}.${name}` : name;
      found.push({ name, qualified, kind: rule.kind, from: nodeRef.from, to: nodeRef.to });
      if (!rule.flat) enclosing.push(name);
      return true;
    },
    leave(nodeRef) {
      const rule = RULES[nodeRef.name];
      if (!rule || rule.flat) return;
      // Only pop for a node that actually pushed: a matched node whose name
      // could not be read never went on the stack, and popping for it would
      // unwind an ancestor and mis-qualify everything after it.
      if (nameOf(nodeRef.node, rule, doc) !== null) enclosing.pop();
    },
  });

  return found;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/symbols.test.ts`
Expected: PASS, all nine.

- [ ] **Step 5: Run the suite and type check**

Run: `npm test && npm run check`
Expected: everything green.

- [ ] **Step 6: Commit**

```bash
git add src/core/symbols.ts tests/symbols.test.ts
git commit -m "Read a file's symbols from the parse we already have"
```

---

### Task 2: The palette mode and the command

**Files:**
- Modify: `src/ui/CommandPalette.svelte` — `initialText`, `effectiveMode`, `placeholder`, `modeIcon`, `rows`, a new `symbolRows`, and the prefix hints near the foot of the component
- Modify: `src/app.ts` — one command and one keybinding
- Test: `tests/symbols.test.ts` (the instruction constant only)

**Interfaces:**
- Consumes: `fileSymbols`, `FileSymbol`, `SymbolKind` from Task 1.
- Produces: the command id `nav.goToSymbol`.

- [ ] **Step 1: Add the mode to the palette**

In `src/ui/CommandPalette.svelte`, import the scan and CodeMirror's tree accessor:

```ts
  import { syntaxTree } from '@codemirror/language';
  import { fileSymbols, type SymbolKind } from '@core/symbols';
```

Extend `effectiveMode`'s union and its body — the union type is written out at its declaration, so both need the new member:

```ts
  const effectiveMode = $derived.by<'commands' | 'files' | 'buffers' | 'line' | 'symbols'>(() => {
    if (text.startsWith('>')) return 'commands';
    if (text.startsWith('~')) return 'buffers';
    if (text.startsWith(':')) return 'line';
    if (text.startsWith('@')) return 'symbols';
    return 'files';
  });
```

Add the placeholder and icon arms:

```ts
      case 'symbols':
        return 'Go to a symbol in this file…';
```

```ts
      case 'symbols':
        return 'dot';
```

And the `rows` arm, above the `fileRows` fallback:

```ts
    if (effectiveMode === 'symbols') return symbolRows(term);
```

- [ ] **Step 2: Add `symbolRows`**

Beside `lineRows` in the same component:

```ts
  /** One word per kind, shown in the row's detail. */
  const KIND_LABEL: Record<SymbolKind, string> = {
    function: 'function',
    class: 'class',
    interface: 'interface',
    type: 'type',
    enum: 'enum',
    module: 'module',
    rule: 'rule',
    heading: 'heading',
  };

  /** A single disabled row, the shape `lineRows` uses to explain an empty list. */
  function hintRow(title: string, detail: string): Row[] {
    return [
      { key: 'symbol-hint', title, positions: [], detail, disabled: true, icon: 'info', accept: () => {} },
    ];
  }

  function symbolRows(query: string): Row[] {
    const view = app.view.get();
    if (!view) return hintRow('No file is open', 'Open a file to list its symbols');

    const buffer = workspace.active();
    const symbols = fileSymbols(syntaxTree(view.state), view.state.doc);

    if (symbols.length === 0) {
      // Two different empty states, because they call for different actions:
      // nothing to find, versus nothing that *can* be found here.
      const language = buffer ? languageById(buffer.languageId).name : null;
      return language && !PARSED_LANGUAGES.has(buffer!.languageId)
        ? hintRow(`Nox has no parser for ${language}`, 'Symbols need a grammar; syntax highlighting does too')
        : hintRow('No functions or classes in this file', 'Only structure is listed, not variables');
    }

    const scored = query
      ? fuzzyFilter(query, symbols, (s) => s.qualified, 200)
      : symbols.slice(0, 200).map((item) => ({ item, score: 0, positions: [] as number[] }));

    return scored.map(({ item, positions }) => ({
      key: `${item.from}:${item.qualified}`,
      title: item.qualified,
      positions,
      detail: KIND_LABEL[item.kind],
      icon: 'dot' as const,
      accept: () => {
        ui.closeOverlay();
        app.goToLine(view.state.doc.lineAt(item.from).number, 1);
      },
    }));
  }
```

`fuzzyFilter` and `languageById` need importing if the component does not already have them:

```ts
  import { fuzzyFilter } from '@core/fuzzy';
  import { languageById } from '@core/languages';
```

`PARSED_LANGUAGES` is the set of ids a grammar ships for. Define it beside `KIND_LABEL`, from the list in `ARCHITECTURE.md` §4:

```ts
  /**
   * The language ids a parser ships for. `core/languages.ts` registers 25
   * languages for detection and the status bar; only these nine families are
   * parsed, which is why the others get a different empty state rather than a
   * misleading "no symbols".
   */
  const PARSED_LANGUAGES = new Set([
    'typescript', 'tsx', 'javascript', 'jsx', 'json',
    'html', 'css', 'scss', 'markdown', 'python', 'rust',
  ]);
```

- [ ] **Step 3: Add the prefix hint**

The palette lists its prefixes at the foot. Beside the existing three:

```svelte
    <span class="hint-group prefix"><kbd class="nox-kbd">@</kbd> symbol</span>
```

- [ ] **Step 4: Register the command and its chord**

In `src/app.ts#registerCommands`, in the navigation block beside `nav.focusExplorer`:

```ts
      {
        id: 'nav.goToSymbol',
        title: 'Go to Symbol in File…',
        category: 'Go',
        keyHint: 'Mod+R',
        keywords: ['symbol', 'outline', 'function', 'class', 'method', 'definition'],
        run: () => this.ui.openOverlay('go-to-symbol'),
      },
```

`UIService` has **no** `paletteSeed` — checked. Use the pattern `go-to-line` already uses: `initialText(mode)` keys off the `OverlayKind`, so add a new kind rather than inventing a seed channel. Replace the `run` above with `run: () => this.ui.openOverlay('go-to-symbol')` and make these three changes:

```ts
  // services/ui.ts
  export type OverlayKind = 'palette' | 'quick-open' | 'buffers' | 'go-to-line' | 'go-to-symbol' | 'settings' | 'keybindings';
```

```ts
  // CommandPalette.svelte, in initialText
  if (kind === 'go-to-symbol') return '@';
```

Check `Overlays.svelte` renders `CommandPalette` for the new kind the way it does for `go-to-line`, and that `hasDismissible`/`dismissTop` in `services/ui.ts` need no change (they act on `overlay` being non-null, not on which kind it is).

Add the binding beside the others:

```ts
      'Mod+R': 'nav.goToSymbol',
```

`Mod+R` is free; `Mod+Shift+O`, the chord VS Code uses, is already `file.openFolder` here.

- [ ] **Step 5: Verify**

Run: `npm test && npm run check`
Expected: green. `npm run check` is the only thing that type-checks the Svelte file, so a wrong `IconName` or a missing union member surfaces only here.

- [ ] **Step 6: Commit**

```bash
git add src/ui/CommandPalette.svelte src/app.ts src/services/ui.ts
git commit -m "Add the @ palette mode and Go to Symbol in File"
```

---

### Task 3: The parse budget for large files

**Files:**
- Modify: `src/ui/CommandPalette.svelte` — `symbolRows`
- Test: `tests/symbols.test.ts`

**Interfaces:**
- Consumes: Task 2's `symbolRows`.
- Produces: nothing new.

- [ ] **Step 1: Measure first, then write the code**

`syntaxTree(state)` returns only what has been parsed so far. Before changing anything, find out whether that bites here. In the browser target (`npm run dev`, port 1420, `nox-web` in `.claude/launch.json`), open a large file and compare:

```js
// In the browser console, against the running app:
const view = window.nox.view.get();
const { syntaxTree } = await import('@codemirror/language');
console.log('doc length', view.state.doc.length, 'parsed to', syntaxTree(view.state).length);
```

**Record the numbers in your report.** If `parsed to` equals the document length on the largest file in the repo, say so — the guard below is still worth having, but you will have established it is not reachable in practice today.

- [ ] **Step 2: Use the budget**

Replace the `syntaxTree` call in `symbolRows` with:

```ts
    // `syntaxTree` returns only what has been parsed so far, so on a large
    // file a plain read silently stops partway and the list *looks* complete.
    // `ensureSyntaxTree` forces the rest with a deadline and returns null when
    // it cannot finish in it.
    const tree = ensureSyntaxTree(view.state, view.state.doc.length, PARSE_BUDGET_MS);
    const partial = tree === null;
    const symbols = fileSymbols(tree ?? syntaxTree(view.state), view.state.doc);
```

with, beside `PARSED_LANGUAGES`:

```ts
  /**
   * How long to spend parsing before listing what we have.
   *
   * The palette is a keystroke-latency surface, so this is a budget rather
   * than a wait. Past it the list is honest about being partial instead of
   * looking complete.
   */
  const PARSE_BUDGET_MS = 100;
```

and the import:

```ts
  import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
```

- [ ] **Step 3: Say when the list is partial**

Append a disabled row rather than silently truncating. At the end of `symbolRows`, after building `rows`:

```ts
    return partial
      ? [...built, { key: 'symbol-partial', title: 'Still parsing this file', positions: [], detail: 'More symbols may appear', disabled: true, icon: 'info' as const, accept: () => {} }]
      : built;
```

naming the mapped array `built` rather than returning it directly.

- [ ] **Step 4: Verify**

Run: `npm test && npm run check`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/ui/CommandPalette.svelte
git commit -m "Say when the symbol list is only as far as the parse got"
```

---

### Task 4: Verify it in the browser target

The palette has no automated coverage — this repo has no Svelte component harness, which is the work queued directly behind this feature. Until it exists, this is the check.

**Files:** whatever the walk turns up.

- [ ] **Step 1: Start the browser target**

`nox-web` is already in `.claude/launch.json` on port 1420. Start it and open the app. Do **not** run `npm run app`.

- [ ] **Step 2: Walk the modes**

1. Open `README.md` from the demo project, press <kbd>⌘R</kbd>. The palette opens with `@` already in it and lists the file's headings.
2. Type part of a heading. The list narrows and the matched characters are highlighted.
3. Press Enter. The editor scrolls to that heading and the cursor lands on its line.
4. Open the palette with <kbd>⌘⇧P</kbd> and type `@` manually. The same list appears without reopening — that is the prefix switch working.
5. Open `src/index.ts` (or any `.ts` file in the demo project) and confirm functions and classes appear, with a method shown as `Class.method`.
6. Open `package.json`. The hint row says there is nothing to list rather than showing an empty panel.

- [ ] **Step 3: Record what you saw**

Screenshot the symbol list and note anything that reads wrong — a truncated title, a kind label that does not match, an ordering that surprises you. The changelog in Task 5 is written from this, not from the spec.

- [ ] **Step 4: Fix what the walk found**

Any fix gets a test first, in the file covering that layer. A rendering-only fix that no test can reach is stated as such in the report.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Fix what the browser walk found"
```

(Skip if the walk found nothing.)

---

### Task 5: Documentation

**Files:**
- Modify: `CHANGELOG.md`, `ROADMAP.md`, `README.md`, `ARCHITECTURE.md`

- [ ] **Step 1: Changelog**

Under `## [Unreleased]` → `### Added`, in the file's voice — what it does, what it costs, and what it will not do:

```markdown
- **Go to Symbol.** <kbd>⌘R</kbd>, or `@` in the command palette, lists the
  functions, classes, methods and headings in the file you are looking at.
  Type to narrow, Enter to jump.
  - A method reads as `Class.method`, so you can type either half to find it.
  - Structure only: functions, classes, methods, interfaces, types, enums,
    CSS rule sets and Markdown headings. Not variables, not imports — a list
    you have to scroll is a list that failed.
  - It reads the same grammar syntax highlighting uses, so a language Nox has
    no parser for says so rather than showing an empty list.
```

- [ ] **Step 2: Roadmap**

In **v0.3 — Navigation at scale**, the **Go to symbol** row currently reads "Lezer syntax tree scan per file — a real outline without a language server." Move it into a `### ✅ Shipped in v0.3` table above the remaining rows, matching the `### ✅ Shipped in v0.2` block's two-column form, and rewrite the cell as what it does rather than what it would need. Leave the Terminal row where it is: its `*(shipped early)*` marker exists because it landed out of order, which this did not.

- [ ] **Step 3: README**

In the palette's `The basics` table, add the chord beside the existing five:

```markdown
| <kbd>Mod R</kbd> | Jump to a symbol in this file |
```

Also update the "Also in the box" sentence, which lists what ships and does not yet mention symbols.

- [ ] **Step 4: Architecture**

Add a §4 subsection, **Symbols come from one table, not one per language**, covering:

- Why the rules are keyed by Lezer node name rather than by the file's language: mixed-language files, where a Svelte tree holds HTML, JS and CSS nodes at once.
- Why the names do not collide (`FunctionDeclaration` / `FunctionDefinition` / `FunctionItem`), and that they were read from `parser.nodeSet.types` rather than remembered.
- Why Markdown headings are flat when everything else nests.
- Why structure only, and why JSON and HTML collect nothing.
- The parse-budget rule from Task 3, with the number you measured.

- [ ] **Step 5: Verify and open the PR**

Run: `npm test && npm run check`

```bash
git add CHANGELOG.md ROADMAP.md README.md ARCHITECTURE.md
git commit -m "Document Go to Symbol"
git push -u origin go-to-symbol
```

Open a PR leading with §5's argument — the shared table and the mixed-language case — because that is the decision a reviewer most needs to check and the one that looks arbitrary without it.

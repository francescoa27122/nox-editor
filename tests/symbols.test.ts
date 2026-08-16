import { htmlLanguage } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { parser as cssParser } from '@lezer/css';
import { parser as jsParser } from '@lezer/javascript';
import { parser as pythonParser } from '@lezer/python';
import { parser as rustParser } from '@lezer/rust';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorState, Text } from '@codemirror/state';
import type { Tree } from '@lezer/common';
import { describe, expect, it } from 'vitest';
import { fileSymbols } from '../src/core/symbols';

const ts = jsParser.configure({ dialect: 'ts' });

/** Parse with `parser` and return the symbols as "qualified:kind" strings. */
function scan(parser: { parse(input: string): Tree }, source: string): string[] {
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

  it('reads TypeScript interfaces, type aliases, enums and namespaces', () => {
    const source = 'interface I {}\ntype T = string;\nenum E { A }\nnamespace N {}\n';
    expect(scan(ts, source)).toEqual(['I:interface', 'T:type', 'E:enum', 'N:module']);
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
    const source =
      'struct S {}\ntrait T {}\nmod m {}\nenum E { A }\ntype Id = u32;\nimpl S {\n    fn f() {}\n}\n';
    expect(scan(rustParser, source)).toEqual([
      'S:class',
      'T:interface',
      'm:module',
      'E:enum',
      'Id:type',
      'S:class',
      'S.f:function',
    ]);
  });

  /**
   * `ImplItem` has two `TypeIdentifier` children for a trait impl — the trait
   * first, then the target type — and only the second is what the impl's
   * methods belong to. `impl S` has a single `TypeIdentifier`, so taking the
   * last one leaves it unaffected; `impl Display for Foo` would wrongly
   * qualify its methods as `Display.fmt` if the rule took the first one
   * instead.
   */
  it('names a trait impl by the type, not the trait', () => {
    const source = 'impl S {}\nimpl Display for Foo {\n    fn fmt() {}\n}\n';
    expect(scan(rustParser, source)).toEqual(['S:class', 'Foo:class', 'Foo.fmt:function']);
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
   * A characterisation test, not a branch test: headings come back
   * unqualified because an ATX or Setext heading node spans only its own
   * line(s) and is a sibling of what follows it, never an ancestor — the
   * generic walk already leaves the enclosing stack empty by the time the
   * next heading is entered. Worth pinning regardless, since a change to how
   * the grammar nests headings would silently produce `Title.Subtitle`.
   */
  it('names Markdown headings without qualifying them to one another', () => {
    const source = '# Title\n\n## Subtitle\n\ntext\n';
    expect(scan(markdownLanguage.parser, source)).toEqual(['Title:heading', 'Subtitle:heading']);
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

/**
 * `syntaxTree(state)` returns only what CodeMirror has parsed so far, not the
 * whole document. `fileSymbols` above is tested against a `Tree` built by
 * `parser.parse(source)`, which is always complete and so never exercises
 * that gap. These tests use a real `EditorState` — the only thing that has a
 * parse frontier — to pin the size at which the gap opens, and to confirm
 * `ensureSyntaxTree` closes it (or honestly gives up) exactly as
 * `symbolRows` in CommandPalette.svelte relies on it doing.
 */
describe('the parse budget for large files', () => {
  /** `n` top-level functions, source enough to push a document past the parse frontier. */
  function manyFunctions(n: number): string {
    let source = '';
    for (let i = 0; i < n; i++) {
      source += `function f${i}(x) {\n  return x + ${i};\n}\n\n`;
    }
    return source;
  }

  /**
   * A freshly created `EditorState` has had no idle time to keep parsing in
   * the background — the same state the palette sees the instant it opens.
   * 200 functions (~11.5KB) is comfortably past the ~3KB a fresh state parses
   * synchronously, so this is not a boundary case: on any file with real
   * structure, a plain `syntaxTree` read is provably incomplete.
   */
  it('leaves a fresh EditorState only partially parsed', () => {
    const state = EditorState.create({ doc: manyFunctions(200), extensions: [javascript()] });
    expect(syntaxTree(state).length).toBeLessThan(state.doc.length);
  });

  /**
   * Given the time to finish, `ensureSyntaxTree` does — the same document
   * that defeats a plain `syntaxTree` read parses fully once forced, and the
   * symbols found through it are the complete set rather than whatever fell
   * inside the frontier.
   */
  it('ensureSyntaxTree finds every symbol once forced, not just the ones inside the frontier', () => {
    const state = EditorState.create({ doc: manyFunctions(200), extensions: [javascript()] });
    const partialCount = fileSymbols(syntaxTree(state), state.doc).length;

    const tree = ensureSyntaxTree(state, state.doc.length, 5000);
    expect(tree).not.toBeNull();
    expect(tree?.length).toBe(state.doc.length);
    expect(fileSymbols(tree as Tree, state.doc).length).toBe(200);
    expect(partialCount).toBeLessThan(200);
  });

  /**
   * The budget `symbolRows` actually uses (`PARSE_BUDGET_MS = 100` in
   * CommandPalette.svelte) is a real deadline, not a formality: a document
   * too large to finish in it makes `ensureSyntaxTree` give up and return
   * null rather than block the palette. 20,000 functions (~1.2MB) parses at
   * roughly 40 chars/ms in this environment, so 100ms is nowhere near enough
   * — the margin holds even on a machine several times faster than the one
   * this was measured on.
   */
  it('ensureSyntaxTree gives up within the palette budget on a document too large to finish', () => {
    const state = EditorState.create({ doc: manyFunctions(20000), extensions: [javascript()] });
    expect(ensureSyntaxTree(state, state.doc.length, 100)).toBeNull();
  });
});

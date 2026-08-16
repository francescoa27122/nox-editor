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
import { fileSymbols, symbolListState, type SymbolListFacts } from '../src/core/symbols';

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

  /**
   * The failure this prevents, and it shipped: `#foo() {}` names its method
   * with `PrivatePropertyDefinition`, not `PropertyDefinition`, so a rule that
   * only reads the latter drops every private method without a trace — 26 of
   * `src/app.ts`'s own 63 methods, 6 of `src/services/watcher.ts`'s 11.
   * `static`, `get` and `set` all keep `PropertyDefinition`, so they are here
   * to pin that the modifiers change nothing.
   */
  it('reads private, static and accessor methods', () => {
    const source =
      'class A {\n  #hidden() {}\n  static make() {}\n  get value() { return 1 }\n  set value(v) {}\n}\n';
    expect(scan(ts, source)).toEqual([
      'A:class',
      'A.#hidden:function',
      'A.make:function',
      'A.value:function',
      'A.value:function',
    ]);
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
   * The failure this prevents, and it shipped: in `impl Foo<T>` the type is
   * wrapped in a `GenericType` node, so it is not a direct child of the
   * `ImplItem` at all. Reading direct `TypeIdentifier` children found nothing
   * for the inherent impl — no row, and its methods unqualified — and for the
   * trait impl found only the *trait*, which is worse: `Display.fmt` sends you
   * looking for a type that does not have that method. Both are ordinary Rust.
   */
  it('names a generic impl by its type, through the wrapper node', () => {
    const source =
      'impl<T> Wrapper<T> {\n    fn get() {}\n}\nimpl<T> Display for Inner<T> {\n    fn fmt() {}\n}\n';
    expect(scan(rustParser, source)).toEqual([
      'Wrapper:class',
      'Wrapper.get:function',
      'Inner:class',
      'Inner.fmt:function',
    ]);
  });

  /**
   * The failure this prevents, and this pass introduced it: `node.cursor()`
   * is not confined to its own subtree, so the search for the impl's type
   * climbed out and took the next `TypeIdentifier` anywhere below. An `impl`
   * for the unit type has none of its own — `UnitType` holds no identifier —
   * so it was named after a struct declared later in another module, its
   * method was qualified `Elsewhere.default`, and two `Elsewhere` rows
   * pointed at unrelated ranges.
   *
   * The declaration after the impl is the whole point of the case: without
   * something for an unbounded walk to reach, the bug leaves no trace.
   *
   * A target with no identifier is left unlisted rather than named after the
   * trait, which would put `Default` in the list twice over — once for the
   * trait and once for a block that is not it.
   */
  it('does not reach past an impl whose target type has no identifier', () => {
    const source =
      'impl Default for () {\n    fn default() {}\n}\nmod later {\n    struct Elsewhere;\n}\n';
    expect(scan(rustParser, source)).toEqual([
      'default:function',
      'later:module',
      'later.Elsewhere:class',
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
   * A selector may span lines. Its text carries the newline and the next
   * line's indent into the title, where it wrecks a single-line row and gives
   * fuzzy matching whitespace to match on.
   */
  it('normalises the whitespace in a selector that spans lines', () => {
    expect(scan(cssParser, '.a,\n  .b > .c {\n  color: red;\n}\n')).toEqual(['.a, .b > .c:rule']);
  });

  /**
   * Qualification joins with a dot, and a class selector already starts with
   * one: `.card { .title {} }` came out as `.card..title`.
   */
  it('does not double the dot when qualifying a nested rule', () => {
    const source = '.card {\n  .title { color: red }\n  span { color: blue }\n}\n';
    expect(scan(cssParser, source)).toEqual(['.card:rule', '.card.title:rule', '.card.span:rule']);
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
   * The failure this prevents, and it shipped: a `SetextHeading` node spans
   * the text line *and* the `=====` under it, so its own text came back as
   * `"Title\n====="`. The underline is a `HeaderMark` child, which is where
   * the title has to stop.
   */
  it('names a Setext heading without its underline', () => {
    const source = 'Title\n=====\n\nSub\n---\n\ntext\n';
    expect(scan(markdownLanguage.parser, source)).toEqual(['Title:heading', 'Sub:heading']);
  });

  /**
   * An ATX heading may close with a second run of hashes, which is a mark and
   * not part of the title. Stopping at the last `HeaderMark` that is not the
   * opening one drops it without guessing at CommonMark's rule for when a
   * trailing run counts: the grammar has already decided. `### Kept#` is the
   * proof — no space before the hash, so it is not a closing sequence, the
   * grammar emits no second mark, and the hash stays in the title.
   */
  it("drops an ATX heading's closing hashes but not a trailing hash in its text", () => {
    const source = '# Title #\n\n## Deep ##########\n\n### Kept#\n';
    expect(scan(markdownLanguage.parser, source)).toEqual([
      'Title:heading',
      'Deep:heading',
      'Kept#:heading',
    ]);
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
 * The states were §10's last untested item, and the reason is worth keeping:
 * the decision was inline in `symbolRows`, and this repo has no Svelte
 * component harness, so it was untestable where it lived. It is a pure
 * function of four facts, so lifting it into `core/` is all it took.
 */
describe('what the symbol list has to say', () => {
  /** A file with a loaded grammar and a finished parse, unless overridden. */
  function facts(over: Partial<SymbolListFacts> = {}): SymbolListFacts {
    return {
      language: 'TypeScript',
      hasGrammar: true,
      grammarLoaded: true,
      parsed: true,
      count: 3,
      ...over,
    };
  }

  it('lists symbols when there are some and the parse finished', () => {
    expect(symbolListState(facts())).toEqual({ kind: 'symbols', partial: false });
  });

  it('marks the list partial when the parse budget ran out', () => {
    expect(symbolListState(facts({ parsed: false }))).toEqual({ kind: 'symbols', partial: true });
  });

  it('says the file has no symbols only when a finished parse found none', () => {
    expect(symbolListState(facts({ count: 0 }))).toEqual({ kind: 'no-symbols' });
  });

  /**
   * The distinction the sentence exists for: nothing was found *yet*. Saying
   * "no functions or classes in this file" here tells the reader the symbol
   * is not there, which is worse than telling them nothing.
   */
  it('says the file is still parsing when the budget ran out before anything was found', () => {
    expect(symbolListState(facts({ count: 0, parsed: false }))).toEqual({ kind: 'still-parsing' });
  });

  it('names the language when no parser ships for it', () => {
    expect(symbolListState(facts({ hasGrammar: false, language: 'Ruby', count: 0 }))).toEqual({
      kind: 'no-grammar',
      language: 'Ruby',
    });
  });

  /**
   * The one that bit in the running app: `EditorPane` attaches a grammar
   * through a dynamic import that resolves after the buffer is on screen, so
   * for a moment there is a language id and no parser.
   */
  it('says the grammar is loading rather than that the file has nothing in it', () => {
    expect(symbolListState(facts({ grammarLoaded: false, count: 0 }))).toEqual({
      kind: 'loading-grammar',
    });
  });

  /**
   * Order, not just outcome. A document with no parser attached also comes
   * back with no symbols and an unfinished parse, so if the grammar facts
   * were read after the parse ones, every one of these would come out as
   * "still parsing" or "no functions or classes" — which is exactly the bug
   * the two grammar states were added to fix.
   */
  it('reads the grammar facts before the parse facts', () => {
    const unparsed = { count: 0, parsed: false } as const;
    expect(symbolListState(facts({ ...unparsed, hasGrammar: false, language: 'Ruby' })).kind).toBe(
      'no-grammar',
    );
    expect(symbolListState(facts({ ...unparsed, grammarLoaded: false })).kind).toBe(
      'loading-grammar',
    );
  });

  /**
   * With no buffer to ask, there is no language to check a grammar for, and
   * the palette still has a view whose symbols it can list — which is what
   * the component's `buffer &&` guards did before this moved out of it.
   */
  it('skips the grammar questions when there is no buffer to ask about', () => {
    expect(
      symbolListState(facts({ language: null, hasGrammar: false, grammarLoaded: false })),
    ).toEqual({ kind: 'symbols', partial: false });
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
  /** The budget `symbolRows` spends, mirrored from CommandPalette.svelte. */
  const PARSE_BUDGET_MS = 100;

  /** `n` top-level functions, source enough to push a document past the parse frontier. */
  function manyFunctions(n: number): string {
    let source = '';
    for (let i = 0; i < n; i++) {
      source += `function f${i}(x) {\n  return x + ${i};\n}\n\n`;
    }
    return source;
  }

  /**
   * Characters of this source per millisecond, measured on the machine
   * running the test rather than the one that wrote it.
   *
   * The parse is forced with a budget far past what it needs, so what is
   * being timed is the parse finishing, not the deadline expiring.
   */
  function measureParseRate(): number {
    const state = EditorState.create({ doc: manyFunctions(2000), extensions: [javascript()] });
    const start = performance.now();
    const tree = ensureSyntaxTree(state, state.doc.length, 60_000);
    const elapsed = performance.now() - start;
    expect(tree?.length).toBe(state.doc.length);
    return state.doc.length / Math.max(elapsed, 0.001);
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
   * The budget `symbolRows` spends is a real deadline, not a formality: a
   * document too large to finish inside it makes `ensureSyntaxTree` give up
   * and return null rather than block the palette on a keystroke.
   *
   * The document is sized from a rate measured a moment earlier, because the
   * fixed one here before was a bet on wall-clock that a faster machine
   * wins. It used 20,000 functions and a comment claiming ~40 chars/ms and a
   * margin of "several times faster". Measured: that document is 857,780
   * characters, it parses at ~2,437 chars/ms, and it finishes in ~352ms —
   * against a 100ms budget, a margin of 3.5×, not 60×. A machine four times
   * quicker than this one would have flipped the assertion.
   *
   * Sizing it here needs only enough margin to cover measurement noise and a
   * warmer JIT on the second parse, so the multiplier is small and the
   * document stays a tenth of the size.
   */
  it('ensureSyntaxTree gives up within the palette budget on a document too large to finish', () => {
    const MARGIN = 10;
    const rate = measureParseRate();
    const perFunction = manyFunctions(100).length / 100;
    const functions = Math.ceil((rate * PARSE_BUDGET_MS * MARGIN) / perFunction);

    const state = EditorState.create({ doc: manyFunctions(functions), extensions: [javascript()] });
    expect(ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS)).toBeNull();
    // And what the palette falls back to is still a usable partial tree.
    expect(syntaxTree(state).length).toBeLessThan(state.doc.length);
  });
});

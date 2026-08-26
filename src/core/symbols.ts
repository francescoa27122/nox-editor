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
   * structs, enums, traits and type aliases. JavaScript needs two as well:
   * a method is named by a `PropertyDefinition` unless it is private, and
   * `#foo() {}` is named by a `PrivatePropertyDefinition`.
   */
  nameFrom?: readonly string[];
  /**
   * Take the node's own text, stopping at the last child of this type that is
   * not the node's own opening mark — for nodes with no name child. See
   * `ownTextEnd`.
   */
  ownTextUntil?: string;
  /** Strip this from the front of the text, for Markdown's `##`. */
  strip?: RegExp;
  /**
   * Take the name from the type sitting immediately before this child, for
   * Rust's `impl`. See `targetTypeOf`.
   */
  targetTypeBefore?: string;
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
 * Every name below is now read out of a real parse of the construct it
 * claims to match, which is not how the first version was written: it named
 * `PropertyName` as a method's name child, a node the JavaScript grammar only
 * ever produces for `a.b`, and left out the `PrivatePropertyDefinition` that
 * actually names `#foo() {}` — so every private method in the file was
 * dropped, silently, and the tests were written from the same table.
 */
const RULES: Record<string, Rule> = {
  // JavaScript / TypeScript / JSX / TSX
  FunctionDeclaration: { kind: 'function', nameFrom: ['VariableDefinition'] },
  ClassDeclaration: { kind: 'class', nameFrom: ['VariableDefinition'] },
  MethodDeclaration: {
    kind: 'function',
    nameFrom: ['PropertyDefinition', 'PrivatePropertyDefinition'],
  },
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
  ImplItem: { kind: 'class', targetTypeBefore: 'DeclarationList' },
  TypeItem: { kind: 'type', nameFrom: ['TypeIdentifier'] },

  // CSS / SCSS. The selector is the text before the block, not a child.
  RuleSet: { kind: 'rule', ownTextUntil: 'Block' },

  // Markdown. No exception needed for nesting: an ATX or Setext heading node
  // spans only its own line(s) and is a sibling of whatever follows it, never
  // an ancestor — so the generic walk already gives headings unqualified
  // names, the same way a top-level function does.
  //
  // Both heading forms stop at a `HeaderMark`, for two different marks: an
  // ATX heading's optional closing `#` run, and a Setext heading's `=====`
  // underline, which the node spans along with its text line. The opening
  // `#` run is a `HeaderMark` too, but it sits at the node's own start, and
  // `ownTextEnd` ignores it; `strip` takes it off the front of the text.
  ATXHeading1: { kind: 'heading', ownTextUntil: 'HeaderMark', strip: /^#+\s*/ },
  ATXHeading2: { kind: 'heading', ownTextUntil: 'HeaderMark', strip: /^#+\s*/ },
  ATXHeading3: { kind: 'heading', ownTextUntil: 'HeaderMark', strip: /^#+\s*/ },
  ATXHeading4: { kind: 'heading', ownTextUntil: 'HeaderMark', strip: /^#+\s*/ },
  ATXHeading5: { kind: 'heading', ownTextUntil: 'HeaderMark', strip: /^#+\s*/ },
  ATXHeading6: { kind: 'heading', ownTextUntil: 'HeaderMark', strip: /^#+\s*/ },
  SetextHeading1: { kind: 'heading', ownTextUntil: 'HeaderMark' },
  SetextHeading2: { kind: 'heading', ownTextUntil: 'HeaderMark' },
};

/**
 * Where a node's own text ends: at the last child of `type` that starts after
 * the node does, or at the node's end when there is none.
 *
 * The "after the node does" is what lets one rule serve three shapes. A CSS
 * `RuleSet` stops at its `Block`. A Setext heading stops at the `HeaderMark`
 * holding its `=====` underline, which the node spans along with its text. An
 * ATX heading stops at the `HeaderMark` holding its *closing* `#` run when it
 * has one — and its opening run is a `HeaderMark` at the node's own start,
 * which would otherwise make every ATX heading's text empty.
 *
 * Taking it from the grammar rather than a regex also means CommonMark's rule
 * for what counts as a closing run is not re-derived here: `# Title #` gets a
 * second mark and `# Title#` does not, and the difference is already decided.
 */
function ownTextEnd(node: SyntaxNode, type: string): number {
  const after = node.getChildren(type).filter((child) => child.from > node.from);
  const last = after[after.length - 1];
  return last ? last.from : node.to;
}

/**
 * The type a Rust `impl` block's methods belong to: whatever sits immediately
 * before the block, skipping a `where` clause.
 *
 * Reading direct `TypeIdentifier` children instead is wrong twice over. In
 * `impl Foo<T>` the type is wrapped in a `GenericType` and is not a direct
 * child at all, so the impl went unnamed and its methods came out unqualified.
 * In `impl<T> Display for Inner<T>` the only direct `TypeIdentifier` is the
 * *trait*, so the methods came out as `Display.fmt` — a name that sends you
 * looking in the wrong place, which is worse than none.
 *
 * Position settles it where child type cannot: `impl Foo`, `impl Trait for
 * Foo`, `impl<T> Wrapper<T>` and `impl Trait for &Foo` all put the target type
 * last. Its head name is then the first `TypeIdentifier` inside it —
 * `Wrapper` in `Wrapper<T>`, `Foo` in `&Foo`, `Foo` in `crate::Foo`.
 *
 * **The search stays inside that type**, which `node.cursor()` does not do on
 * its own: its `next()` climbs out of the subtree and carries on through the
 * rest of the file. A target with no identifier in it at all — `impl Default
 * for ()`, whose `UnitType` holds none, or `impl Trait for !` — then found the
 * next `TypeIdentifier` anywhere below, so an impl for the unit type took the
 * name of a struct declared later in another module and its methods were
 * qualified with it. `cursor.from < type.to` bounds the walk: everything
 * reachable after `type` in cursor order either lies inside it or starts at or
 * after its end.
 *
 * **A target with no identifier returns null**, which leaves the impl
 * unlisted and its methods unqualified. Naming it after the trait instead
 * would be the mistake this function exists to fix, one step removed: `impl
 * Default for ()` would list as `Default` and collide with the `trait Default`
 * row in the same file, and `Default::default` is not where the reader would
 * find that code. `fileSymbols` already treats an unreadable name this way,
 * for the anonymous default-exported class.
 */
function targetTypeOf(node: SyntaxNode, body: string): SyntaxNode | null {
  let type = node.getChild(body)?.prevSibling ?? node.lastChild;
  while (type && type.name === 'WhereClause') type = type.prevSibling;
  if (!type) return null;

  const cursor = type.cursor();
  do {
    if (cursor.name === 'TypeIdentifier') return cursor.node;
  } while (cursor.next() && cursor.from < type.to);
  return null;
}

/** The name for one matched node, or null when the grammar gave us none. */
function nameOf(node: SyntaxNode, rule: Rule, doc: Text): string | null {
  if (rule.ownTextUntil) {
    const stop = ownTextEnd(node, rule.ownTextUntil);
    // A selector may span lines, and its newline and the next line's indent
    // would go into the title, where they wreck a one-line row and give fuzzy
    // matching whitespace to match on.
    let text = doc.sliceString(node.from, stop).replace(/\s+/g, ' ').trim();
    if (rule.strip) text = text.replace(rule.strip, '').trim();
    return text.length > 0 ? text : null;
  }
  if (rule.targetTypeBefore) {
    const type = targetTypeOf(node, rule.targetTypeBefore);
    return type ? doc.sliceString(type.from, type.to) : null;
  }
  for (const type of rule.nameFrom ?? []) {
    const child = node.getChild(type);
    if (child) return doc.sliceString(child.from, child.to);
  }
  return null;
}

/**
 * A name appended to its enclosing path: `Foo` inside `PackRow` is
 * `PackRow.Foo`.
 *
 * The dot is left out when the name brings its own, which CSS names do:
 * `.card` nesting `.title` is `.card.title`, not `.card..title`.
 */
function qualify(prefix: string | undefined, name: string): string {
  if (prefix === undefined) return name;
  return name.startsWith('.') ? prefix + name : `${prefix}.${name}`;
}

/**
 * Every symbol in `tree`, in document order.
 *
 * One walk, keeping a stack of enclosing names for the qualified path — the
 * same shape `foldRangesAtLevel` uses to get depth without re-walking per
 * line. A matched node whose name couldn't be read (an anonymous
 * default-exported class, say) is skipped entirely and never goes on the
 * stack: nothing can qualify against a name that doesn't exist, and pushing
 * an empty string would produce `.foo` for anything nested inside it.
 */
export function fileSymbols(tree: Tree, doc: Text): FileSymbol[] {
  const found: FileSymbol[] = [];
  // The qualified path of each enclosing symbol, not its bare name, so that
  // `qualify`'s rule about names that bring their own dot applies at every
  // depth rather than only the first.
  const enclosing: string[] = [];
  // One entry per *matched* node entered, saying whether it pushed a name.
  // `leave` needs to know that and nothing else, and asking `nameOf` again to
  // find out ran the whole name resolution twice for every symbol in the file.
  // Recording it is exact where re-deriving is merely usually right: a matched
  // node whose name could not be read never went on the stack, and popping for
  // it would unwind an ancestor and mis-qualify everything after it.
  const contributed: boolean[] = [];

  tree.iterate({
    enter(nodeRef) {
      const rule = RULES[nodeRef.name];
      if (!rule) return true;

      const name = nameOf(nodeRef.node, rule, doc);
      if (name === null) {
        contributed.push(false);
        return true;
      }

      const qualified = qualify(enclosing[enclosing.length - 1], name);
      found.push({ name, qualified, kind: rule.kind, from: nodeRef.from, to: nodeRef.to });
      enclosing.push(qualified);
      contributed.push(true);
      return true;
    },
    leave(nodeRef) {
      if (!RULES[nodeRef.name]) return;
      if (contributed.pop()) enclosing.pop();
    },
  });

  return found;
}

/**
 * A `fileSymbols` that skips the walk when nothing has changed.
 *
 * The palette recomputes on every keystroke, but the tree only moves when the
 * document does. The parse underneath amortises — each `ensureSyntaxTree` call
 * resumes the cached `ParseContext` and later ones return immediately — while
 * the walk repeats in full every time, which on a large file leaves it as the
 * cost that never goes away.
 *
 * A factory rather than a module-level cache, because this module's whole
 * claim is that it is pure and testable headlessly. State that belongs to one
 * caller lives with that caller: the palette holds one of these, and a test
 * can hold its own without the two interfering.
 *
 * One slot, not a map. The palette only ever asks about the file you are
 * looking at, and a miss costs exactly what every call used to cost.
 */
export function createSymbolCache(): (tree: Tree, doc: Text) => FileSymbol[] {
  let lastTree: Tree | null = null;
  let lastDoc: Text | null = null;
  let last: FileSymbol[] = [];

  return (tree, doc) => {
    // Both, because a tree outlives the document it was parsed from: holding
    // the tree alone would hand back the right symbols against the wrong text.
    if (tree === lastTree && doc === lastDoc) return last;
    lastTree = tree;
    lastDoc = doc;
    last = fileSymbols(tree, doc);
    return last;
  };
}

/** One line of the sticky strip: what it says, how deep, and where a click lands. */
export interface StickyRow {
  /** The declaration's source line, trimmed — what the reader was looking at. */
  text: string;
  /** Index in the returned list; 0 is the outermost. */
  depth: number;
  /** The symbol's own start, for jumping to the declaration. */
  from: number;
}

/**
 * Which enclosing declarations have scrolled out of view above `topLine`,
 * outermost first.
 *
 * A symbol pins on two conditions, and both matter: its start line must be
 * strictly above `topLine` — a declaration whose own line is still on screen
 * pins nothing, since printing it in the strip *and* in the document right
 * below would waste a row saying what the reader can already see — and its
 * end line must be at or below `topLine`, so a declaration already closed
 * above the fold does not linger, naming a scope that isn't open anymore.
 * Drop either half and the rule looks right until you hit its boundary line.
 *
 * `symbols` is already document order, and for nested ranges document order
 * *is* outermost-first — `fileSymbols`'s own walk relies on the same fact to
 * build `qualified` names, so sorting again here would be redundant. Filtering
 * in place therefore keeps outermost-first for free.
 *
 * Linear in the symbol count. The consumer (Task 2) recomputes this from
 * `Panel.update` on `viewportMoved`, not on every animation frame, so the
 * true call rate is lower than a frame budget implies — but the cost is worth
 * knowing regardless. Measured against `src/app.ts` (2,690 lines, 67
 * symbols): ~0.011–0.014 ms per call against a 16 ms frame budget — roughly
 * three orders of magnitude of headroom. The linear filter stays; do not
 * reach for a sorted array and binary search without a new measurement to
 * justify it.
 */
export function stickyRows(
  symbols: readonly FileSymbol[],
  topLine: number,
  doc: Text,
  max: number,
): StickyRow[] {
  const rows: StickyRow[] = [];
  for (const symbol of symbols) {
    if (rows.length >= max) break;
    const startLine = doc.lineAt(symbol.from).number;
    const endLine = doc.lineAt(symbol.to).number;
    if (startLine < topLine && endLine >= topLine) {
      const text = doc.lineAt(symbol.from).text.trim();
      rows.push({ text, depth: rows.length, from: symbol.from });
    }
  }
  return rows;
}

/**
 * What the symbol list has to say, once every reason it might be empty is told
 * apart from the others.
 *
 * `symbols` is the only one of these that lists anything; the rest are the
 * hint row the palette shows in place of an empty list, and they exist
 * separately because they call for different actions from the reader. A file
 * whose grammar is still loading has not been looked at yet, and saying "no
 * functions or classes in this file" about it is a lie the reader has no way
 * to catch.
 */
export type SymbolListState =
  | { kind: 'no-grammar'; language: string }
  | { kind: 'loading-grammar' }
  | { kind: 'still-parsing' }
  | { kind: 'no-structure'; language: string }
  | { kind: 'no-symbols' }
  | { kind: 'symbols'; partial: boolean };

/** What the palette knows when it has to choose between those. */
export interface SymbolListFacts {
  /** The active buffer's language name, or null when there is no buffer. */
  language: string | null;
  /** Whether a grammar exists for that language. */
  hasGrammar: boolean;
  /** Whether that grammar has finished loading. */
  grammarLoaded: boolean;
  /**
   * Whether that grammar builds a tree, rather than only colouring tokens.
   *
   * A stream parser has no structure to scan, so its symbol count is always
   * zero for reasons that have nothing to do with the file.
   */
  structuredGrammar: boolean;
  /** Whether the forced parse came back inside the palette's budget. */
  parsed: boolean;
  /** How many symbols the scan found. */
  count: number;
}

/**
 * Which of those the palette is looking at.
 *
 * Pure, and out of the component on purpose: this is the branching the feature
 * actually got wrong twice, and inline in a Svelte file it was untestable —
 * this repo has no component harness, so a decision living there is a decision
 * nothing checks.
 *
 * The order is the whole content of the function. A missing grammar and an
 * unloaded one are both checked before anything the parse says, because a
 * document with no parser attached also comes back with no symbols, and read
 * in the wrong order that shows up as "no functions or classes in this file"
 * — which is how the unloaded-grammar case shipped.
 *
 * "No file open" is not one of these. It is settled before there is anything
 * to parse or a language to ask about, so the palette answers it where it
 * looks for the editor.
 */
export function symbolListState(facts: SymbolListFacts): SymbolListState {
  if (facts.language !== null) {
    if (!facts.hasGrammar) return { kind: 'no-grammar', language: facts.language };
    if (!facts.grammarLoaded) return { kind: 'loading-grammar' };
    // Also a grammar fact, and for the same reason as the two above it: a
    // stream parser's scan comes back empty whatever the file contains, so
    // reading the count first reports the file as bare.
    if (!facts.structuredGrammar) return { kind: 'no-structure', language: facts.language };
  }
  if (facts.count === 0) return facts.parsed ? { kind: 'no-symbols' } : { kind: 'still-parsing' };
  return { kind: 'symbols', partial: !facts.parsed };
}

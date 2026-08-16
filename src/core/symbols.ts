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
 */
function targetTypeOf(node: SyntaxNode, body: string): SyntaxNode | null {
  let type = node.getChild(body)?.prevSibling ?? node.lastChild;
  while (type && type.name === 'WhereClause') type = type.prevSibling;
  if (!type) return null;

  const cursor = type.cursor();
  do {
    if (cursor.name === 'TypeIdentifier') return cursor.node;
  } while (cursor.next());
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

  tree.iterate({
    enter(nodeRef) {
      const rule = RULES[nodeRef.name];
      if (!rule) return true;

      const name = nameOf(nodeRef.node, rule, doc);
      if (name === null) return true;

      const qualified = qualify(enclosing[enclosing.length - 1], name);
      found.push({ name, qualified, kind: rule.kind, from: nodeRef.from, to: nodeRef.to });
      enclosing.push(qualified);
      return true;
    },
    leave(nodeRef) {
      const rule = RULES[nodeRef.name];
      if (!rule) return;
      // Only pop for a node that actually pushed: a matched node whose name
      // could not be read never went on the stack, and popping for it would
      // unwind an ancestor and mis-qualify everything after it.
      if (nameOf(nodeRef.node, rule, doc) !== null) enclosing.pop();
    },
  });

  return found;
}

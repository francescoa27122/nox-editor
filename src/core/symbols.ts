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
  /**
   * Take the last matching child instead of the first, for `ImplItem`:
   * `impl Foo` has one `TypeIdentifier` child (the type), but
   * `impl Display for Foo` has two (the trait, then the type) and the type
   * — what the impl's methods actually belong to — is the second one.
   * `impl Foo` is unaffected, since first and last coincide there.
   */
  lastNameFrom?: boolean;
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
  ImplItem: { kind: 'class', nameFrom: ['TypeIdentifier'], lastNameFrom: true },
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
    const children = node.getChildren(type);
    const child = rule.lastNameFrom ? children[children.length - 1] : children[0];
    if (child) return doc.sliceString(child.from, child.to);
  }
  return null;
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

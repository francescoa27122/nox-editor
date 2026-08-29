/**
 * Deterministic fixtures for the benchmarks and the complexity guard.
 *
 * Here rather than in `bench/` because both need the same shapes: a growth
 * ratio measured over one corpus and a wall-clock number measured over another
 * are two facts about two different programs. `tests/complexity.test.ts` and
 * `bench/*.bench.ts` import from this file so a number in the bench output and
 * a threshold in the guard are talking about the same input.
 *
 * Deterministic because a benchmark whose input changes between runs cannot be
 * compared with its own previous result, which is the only comparison a
 * benchmark on a shared runner can honestly make. `Math.random` is therefore
 * not used anywhere here — the generator below is a plain LCG seeded by the
 * caller.
 */

/**
 * Numeric Recipes' LCG constants. Any decent generator would do; what matters
 * is that it is *ours*, so the corpus does not shift when a runtime changes
 * its `Math.random` implementation.
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const WORDS = [
  'buffer',
  'session',
  'workspace',
  'platform',
  'diagnostic',
  'transaction',
  'anchor',
  'gutter',
  'palette',
  'keymap',
  'watcher',
  'registry',
  'provider',
  'capability',
  'selection',
  'viewport',
];

/**
 * `lines` of plausible TypeScript.
 *
 * Plausible rather than real, because the shapes that matter to the functions
 * under measurement are the ones a generator can hit deliberately: identifiers
 * of varying length for fuzzy matching, repeated tokens for search, nesting
 * for the symbol walk. A real file would be one arbitrary sample of all three.
 */
export function sourceFile(lines: number, seed = 1): string {
  const next = lcg(seed);
  const pick = () => WORDS[Math.floor(next() * WORDS.length)]!;
  const out: string[] = [];

  while (out.length < lines) {
    const name = `${pick()}${pick().charAt(0).toUpperCase()}${pick().slice(1)}`;
    out.push(`export class ${name} {`);
    const methods = 1 + Math.floor(next() * 4);
    for (let m = 0; m < methods && out.length < lines - 2; m++) {
      out.push(`  ${pick()}(${pick()}: string): number {`);
      out.push(`    const ${pick()} = this.${pick()} ?? ${Math.floor(next() * 1000)};`);
      out.push(`    return ${pick()}.length;`);
      out.push('  }');
    }
    out.push('}');
    out.push('');
  }

  return out.slice(0, lines).join('\n');
}

/**
 * A source file with one line changed in the middle.
 *
 * This is the shape the diff engine actually meets — `diffLines` trims the
 * common head and tail before running Myers precisely so that a large file
 * with a small edit costs about what reading the file costs. A corpus of two
 * *unrelated* files would measure Myers' worst case instead, which is
 * quadratic by construction and says nothing about whether the trimming still
 * works.
 */
export function editedInTheMiddle(text: string, marker = 'CHANGED'): string {
  const lines = text.split('\n');
  const middle = Math.floor(lines.length / 2);
  lines[middle] = `  // ${marker}`;
  return lines.join('\n');
}

/**
 * `count` workspace-relative paths, as the quick-open index holds them.
 *
 * Directory depth varies, because `fuzzyMatchPath` scores a hit in the
 * filename above one in a directory and therefore does more work on a deep
 * path than a shallow one.
 */
export function projectPaths(count: number, seed = 7): string[] {
  const next = lcg(seed);
  const pick = () => WORDS[Math.floor(next() * WORDS.length)]!;
  const paths: string[] = [];

  for (let i = 0; i < count; i++) {
    const depth = 1 + Math.floor(next() * 4);
    const segments: string[] = ['src'];
    for (let d = 0; d < depth; d++) segments.push(pick());
    segments.push(`${pick()}-${i}.ts`);
    paths.push(segments.join('/'));
  }

  return paths;
}

/** A model reply with `braces` balanced objects in its prose, then an action. */
export function modelReply(braces: number, seed = 11): string {
  const next = lcg(seed);
  const parts: string[] = [];
  for (let i = 0; i < braces; i++) {
    // Prose containing structure, which is the input `objectSpans` exists to
    // survive: a brace in narration is not an action, and a quote in narration
    // must not flip the scanner for the rest of the reply.
    parts.push(`Consider the { ${WORDS[Math.floor(next() * WORDS.length)]!} } here; it's fine.`);
  }
  parts.push('{"method":"context.openBuffers","id":1}');
  return parts.join('\n');
}

/**
 * `git blame --porcelain` output for a file of `lines` lines whose history
 * has 20 commits in it, cycling — which puts a fresh group on every line and
 * so states each commit once and reduces the other 19 appearances of it to a
 * bare header. That asymmetry is the shape the parser has to survive, so a
 * corpus without it would measure the easy half.
 */
export function blamePorcelain(lines: number, commits = 20): string {
  const rows: string[] = [];
  const stated = new Set<string>();
  for (let i = 0; i < lines; i++) {
    const which = i % commits;
    const hash = which.toString(16).padStart(40, '0');
    rows.push(`${hash} ${i + 1} ${i + 1} 1`);
    if (!stated.has(hash)) {
      stated.add(hash);
      rows.push(
        `author Author ${which}`,
        `author-mail <author${which}@example.com>`,
        'author-time 1700000000',
        'author-tz +0000',
        `committer Author ${which}`,
        `committer-mail <author${which}@example.com>`,
        'committer-time 1700000000',
        'committer-tz +0000',
        `summary Commit number ${which}`,
        'filename src/app.ts',
      );
    }
    rows.push(`\tconst value${i} = ${i};`);
  }
  return rows.join('\n') + '\n';
}

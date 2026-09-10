import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every `file:line` citation in the agent-facing docs is held to the symbol it
 * claims to point at.
 *
 * The failure this prevents has happened twice, and the second time it was
 * twenty-eight citations at once. Line numbers in `.claude/skills/` and
 * `CLAUDE.md` rot on roughly every pull request that touches `src/app.ts` or
 * `src-tauri/src/git.rs`, and nothing re-derived them: `app.ts:3044` for the
 * `bindAll` table was 1,490 lines short of it, `commands.ts:158` for `execute`
 * landed on `isEnabled`, and `agent.rs:245` for `fn poisoned` landed on a
 * blank line. A skill that points an agent at the wrong function is worse than
 * one that cites nothing, because it reads as verified.
 *
 * The obvious cheap check is worthless here and was rejected on that basis: a
 * test that only asks whether the line is inside the file would have passed
 * against every one of those twenty-eight, the blank line included. So a
 * citation has to carry a claim a machine can falsify, which is the symbol the
 * sentence around it names.
 *
 * Two shapes are accepted, because prose and table cells want different word
 * order, and both bind the claim to the anchor with a parenthesis rather than
 * by adjacency. Adjacency breaks in a table, where the row's subject and its
 * citation sit in different cells:
 *
 *     `#registerCommands` (`src/app.ts:2715`)
 *     `src/app.ts:2715` (`#registerCommands`)
 *
 * Paths are repo-relative, which is a rule this test gets for free by opening
 * them. The old citations were written against an unstated root: `app.ts:16`
 * meant `src/app.ts`, `workspace.ts:247` meant `src/services/workspace.ts`,
 * and `component.ts:25-28` meant `tests/support/component.ts`. A reader had to
 * know the tree to follow one, and `workspace.ts` is ambiguous even then,
 * since `tests/workspace.test.ts` exists.
 *
 * Mutation-checked on 2026-08-31, because a scanner that finds nothing is
 * green: shifting `src/app.ts:2715` by a single line fails with the line it
 * actually landed on, and deleting the claim span while leaving the anchor
 * fails as uncited. The `checked` floor at the bottom is the third of those
 * guards, and it earned its place during this test's own development, when a
 * mangled escape turned both bound-shape regexes into ones that matched
 * nothing and every citation in the repository reported as uncited.
 *
 * What this does not catch: a citation that names a real symbol on a real line
 * and is still the wrong place to send someone. The claim is only as good as
 * the token chosen, and a token common enough to appear on many lines proves
 * little. It also says nothing about the prose around the anchor, which is
 * where #174 put its errors.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The docs an agent reads as instructions, and only those.
 *
 * `WORKLOG.md`, `CHANGELOG.md` and the dated specs under `docs/superpowers/`
 * are deliberately outside this. They are records of what was true when they
 * were written, and several of them quote a citation precisely because it was
 * wrong. Correcting those to today's line numbers would make the record lie
 * about its own subject.
 */
const docs = (): string[] => {
  const found: string[] = ['CLAUDE.md'];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.md')) found.push(path);
    }
  };

  walk('.claude/skills');
  return found.sort();
};

const PATH = String.raw`[A-Za-z0-9_./@-]+\.(?:ts|tsx|rs|svelte|json|mjs|js|yml|yaml|md|toml)`;
const ANCHOR = String.raw`\`(${PATH}):(\d+)(?:-(\d+))?\``;
const CLAIM = String.raw`\`([^\`\n]+)\``;

// Bold is the one thing allowed to sit between the two spans, because the
// docs' "read this first" lists put the anchor in `**…**` and the claim
// outside it. They are still adjacent, which is all the binding relies on.
const OPEN = String.raw`[ *]*\(`;
const CLOSE = String.raw`\)`;

const CLAIM_FIRST = new RegExp(CLAIM + OPEN + ANCHOR + CLOSE, 'g');
const ANCHOR_FIRST = new RegExp(ANCHOR + OPEN + CLAIM + CLOSE, 'g');
const BARE = new RegExp(ANCHOR, 'g');

interface Citation {
  doc: string;
  docLine: number;
  path: string;
  from: number;
  to: number;
  claim: string;
}

const lineOf = (source: string, offset: number): number =>
  source.slice(0, offset).split('\n').length;

/**
 * Bound citations are collected and then blanked out of a working copy, so
 * whatever `BARE` still finds afterwards is an anchor nothing verifies.
 *
 * The blanking is space of the same length rather than deletion, because the
 * offsets are what report the line a violation is on.
 */
const citationsIn = (doc: string, source: string): { cited: Citation[]; uncited: string[] } => {
  const cited: Citation[] = [];
  let residue = source;

  const take = (docLine: number, path: string, from: string, to: string | undefined, claim: string): void => {
    cited.push({
      doc,
      docLine,
      path,
      from: Number(from),
      to: Number(to ?? from),
      claim,
    });
  };

  residue = residue.replace(CLAIM_FIRST, (match, claim: string, path: string, from: string, to: string | undefined, offset: number) => {
    take(lineOf(source, offset), path, from, to, claim);
    return ' '.repeat(match.length);
  });

  residue = residue.replace(ANCHOR_FIRST, (match, path: string, from: string, to: string | undefined, claim: string, offset: number) => {
    take(lineOf(source, offset), path, from, to, claim);
    return ' '.repeat(match.length);
  });

  const uncited: string[] = [];
  for (const match of residue.matchAll(BARE)) {
    uncited.push(`${doc}:${lineOf(source, match.index)}  ${match[0]} names no symbol`);
  }

  return { cited, uncited };
};

const read = (path: string): string[] | null => {
  try {
    if (!statSync(join(ROOT, path)).isFile()) return null;
  } catch {
    return null;
  }
  return readFileSync(join(ROOT, path), 'utf8').split('\n');
};

describe('source citations in the agent-facing docs', () => {
  /**
   * Reported with the document, the line the citation is on, and the line the
   * cited file actually holds, because the fix is per-citation and re-deriving
   * one by hand is the slow part. A bare count would send the next person
   * grepping for what this test already knows.
   */
  it('point at the symbol they name', () => {
    const violations: string[] = [];
    let checked = 0;

    for (const doc of docs()) {
      const source = readFileSync(join(ROOT, doc), 'utf8');
      const { cited, uncited } = citationsIn(doc, source);
      violations.push(...uncited);

      for (const c of cited) {
        checked += 1;
        const where = `${c.doc}:${c.docLine}  ${c.path}:${c.from}`;
        const lines = read(c.path);

        if (lines === null) {
          violations.push(`${where}  no such file`);
          continue;
        }
        if (c.from < 1 || c.to > lines.length || c.to < c.from) {
          violations.push(`${where}-${c.to}  outside a file of ${lines.length} lines`);
          continue;
        }

        // The claim is held to the range's *first* line. Anywhere-in-range
        // would pass on `src/app.ts:2719-4528`, which is 1,800 lines wide, and
        // that is the shape of citation most likely to be stale.
        const line = lines[c.from - 1] ?? '';
        if (!line.includes(c.claim)) {
          violations.push(`${where}  wants ${JSON.stringify(c.claim)}, line reads ${JSON.stringify(line.trim())}`);
        }
      }
    }

    expect(violations).toEqual([]);
    // A regex that silently stopped matching would leave this suite green over
    // nothing, which is the failure mode of every test that scans for its own
    // input.
    expect(checked).toBeGreaterThan(60);
  });
});

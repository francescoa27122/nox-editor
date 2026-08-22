/**
 * What a collapsed folder says about the files inside it.
 *
 * The tree has marked changed and unsaved *files* since v0.4; collapsing a
 * folder hid every one of them, so `src/` over forty changes read exactly
 * like `src/` over none. This module turns the two per-file facts the panel
 * already holds — `GitService.status` and the dirty set from
 * `workspace.buffers` — into per-folder ones.
 *
 * The roll-up is derived from those *lists*, never by walking the tree. That
 * is the property that matters: `FileTreeService` loads directories lazily,
 * so a folder that has never been expanded has no entries to walk, and a
 * tree-walking roll-up would answer "nothing in here" for exactly the folders
 * the user has not looked inside. Git and the buffer list know about paths
 * whether or not the tree does.
 *
 * Kept out of `FlatNode` for the reason `ExplorerPanel`'s `gitLetters` block
 * records: publishing a new `nodes` array on every status refresh would churn
 * the windowing slice, the `#each` key and every selection derived, for a
 * fact none of them read.
 */

import type { GitStatusLetter } from './git-status';
import { contains, dirname } from './path';

/**
 * Which letter a folder shows when it holds several — lower is worse.
 *
 * Only the two ends carry an argument. **C first**, because an unresolved
 * conflict is the one state where acting on the folder is actively harmful,
 * and it is why `core/git-status.ts` spends a scarce letter on it at all.
 * **U last**, because a folder of untracked build output would otherwise
 * shout over a real change somewhere above it. The middle is a ranking of
 * how easily each is missed rather than a claim about severity, and is
 * pinned by test so it cannot reshuffle without someone deciding to.
 */
const SEVERITY: Record<GitStatusLetter, number> = { C: 0, D: 1, M: 2, R: 3, A: 4, U: 5 };

/**
 * What a folder's letter means, in the vocabulary of `GIT_STATUS_LABEL` next
 * door. The character and its colour are the file vocabulary exactly — one
 * visual language, not two — so the accessible name is the only place the
 * difference between "this file is modified" and "something under here is"
 * can live, which is also what keeps the distinction off colour alone
 * (WCAG 1.4.1).
 *
 * `U` reads "contains untracked files" even on the folder git named directly
 * with a `? lib/` record, where "is untracked" would be the sharper phrase.
 * One rule that is always true beats two rules and a branch to choose between
 * them, and everything inside such a folder is untracked anyway.
 */
export const FOLDER_STATUS_LABEL: Record<GitStatusLetter, string> = {
  M: 'Contains modified files',
  A: 'Contains added files',
  D: 'Contains deleted files',
  R: 'Contains renamed files',
  U: 'Contains untracked files',
  C: 'Contains conflicted files',
};

/**
 * Every folder between each changed path and the root, carrying the worst
 * letter beneath it. The root itself is never included — it is the tree, not
 * a row — and neither is any path git named directly, which the caller
 * answers by exact match first.
 *
 * **The climb stops early, and compares severity rather than presence.** Once
 * an ancestor already holds a letter at least as severe, everything above it
 * was set to at least that severity by the walk that put it there, so there
 * is nothing left to raise. That makes the whole pass cost one visit per
 * distinct ancestor instead of one per file per level — which is what keeps
 * a forty-thousand-file status refresh from turning into four hundred
 * thousand map writes. Stopping on mere presence would be the bug: a
 * conflict arriving after an ordinary edit had already claimed the folder
 * above it would never reach the rows above that.
 */
export function rollUpLetters(
  letters: ReadonlyMap<string, GitStatusLetter>,
  root: string,
): Map<string, GitStatusLetter> {
  const rolled = new Map<string, GitStatusLetter>();
  for (const [path, letter] of letters) {
    const severity = SEVERITY[letter];
    let parent = dirname(path);
    while (parent !== root && contains(root, parent)) {
      const held = rolled.get(parent);
      if (held !== undefined && SEVERITY[held] <= severity) break;
      rolled.set(parent, letter);
      parent = dirname(parent);
    }
  }
  return rolled;
}

/**
 * The same climb without a severity to fold — "something in here", for the
 * unsaved dot. Separate from `rollUpLetters` rather than a letterless mode of
 * it because the two ride different triggers: git status republishes off the
 * typing path, the buffer list republishes on it.
 */
export function rollUpPaths(paths: Iterable<string>, root: string): Set<string> {
  const rolled = new Set<string>();
  for (const path of paths) {
    let parent = dirname(path);
    // Same early exit, and sound for the same reason: an ancestor already in
    // the set had everything above it added by the walk that added it.
    while (parent !== root && contains(root, parent) && !rolled.has(parent)) {
      rolled.add(parent);
      parent = dirname(parent);
    }
  }
  return rolled;
}

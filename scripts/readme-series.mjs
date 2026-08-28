#!/usr/bin/env node
/**
 * Prints the release series `README.md`'s Status section claims to describe.
 *
 * The version files can agree with each other and with the tag while the
 * README still describes the release before it — that happened: plugins
 * landed on main while §Status still ended *"Not there yet: plugins"*, and
 * nothing in the repo would have caught it at the tag.
 *
 * Prose cannot be checked. The one machine-readable thing in the same
 * paragraph as the prose can be: the `**v0.10.**` the section opens with.
 * Getting past the gate means someone opened that paragraph, which is where
 * the stale sentence lives.
 *
 * A CLI rather than a module for the reason `release-notes.mjs` is one: that
 * is what a workflow can call, and `tests/release-readme.test.ts` drives this
 * same entry point as a child process, because the exit code and stdout are
 * all the workflow can see. It is also why the pattern lives here rather than
 * as a `sed` expression in YAML — one that has to survive YAML, then the
 * shell, then `sed` is a regex nobody can read, and the first attempt at it
 * turned a `\1` backreference into a literal control byte.
 *
 *   node scripts/readme-series.mjs [README.md]
 *
 * Exits 1 with a diagnostic on stderr when the line is missing.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The `**v0.10.**` the Status section opens with. */
const HEADING = /^\*\*v(\d+\.\d+)\.\*\*/m;

const path = process.argv[2] ?? fileURLToPath(new URL('../README.md', import.meta.url));

let text;
try {
  text = readFileSync(path, 'utf8');
} catch (error) {
  console.error(`Could not read ${path}: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const series = HEADING.exec(text)?.[1];

if (series === undefined) {
  console.error(`${path} has no "**vX.Y.**" line in its Status section.`);
  console.error('That line is what the release gate checks. If the section was');
  console.error('reworded, reword this script with it rather than dropping the check.');
  process.exit(1);
}

console.log(series);

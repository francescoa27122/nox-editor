#!/usr/bin/env node
/**
 * Prints one version's section of `CHANGELOG.md`, for the release body.
 *
 * `release.yml` hardcoded its `releaseBody` from the first tag onwards, so
 * every release page carried the same Install blurb and **no release ever
 * said what changed in it**. The changelog already said, in prose written for
 * the person downloading rather than for the person who wrote the commit.
 * This is the two lines of glue between them.
 *
 * A CLI rather than a module because that is what a workflow can call, and
 * `tests/release-notes.test.ts` drives this same entry point as a child
 * process. The contract under test is the exit code and the stdout, which is
 * all the workflow can see.
 *
 *   node scripts/release-notes.mjs <version> [changelog.md]
 *
 * Exits 1 with a diagnostic on stderr when the section is missing or empty,
 * which is what makes the gate refuse a tag whose changelog was forgotten.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The version a `## ` heading names, or null if the line is not one.
 *
 * Written to read the format rather than one spelling of it: Keep a Changelog
 * brackets the version and this file separates the date with an em dash, but
 * `## 0.4.1 - 2026-08-17` names the same release and a parser that only knew
 * the one spelling would fail a release for a typographic reason.
 *
 * `### Added` does not match, because `^##\s` needs whitespace after two hashes, and
 * a third hash is not whitespace.
 */
function headingVersion(line) {
  const match = /^##\s+(.*)$/.exec(line);
  if (!match) return null;
  const token = match[1].trim().split(/\s+[—–-]\s+/)[0] ?? '';
  return token.trim().replace(/^\[/, '').replace(/\]$/, '');
}

/** A Keep a Changelog link-reference definition: `[0.9.1]: https://…`. */
function isLinkDefinition(line) {
  return /^\[[^\]]+\]:\s+\S/.test(line);
}

/**
 * Everything under one version's heading, up to the next one.
 *
 * The heading itself is dropped: GitHub already titles the page `Nox v0.10.0`,
 * and repeating the version under it reads like a mistake. The trailing
 * link-reference block is dropped too. It sits at the bottom of the file, so
 * it falls inside the *last* section's range without belonging to it, and
 * definitions nothing references render as literal text.
 */
function sectionFor(changelog, version) {
  const lines = changelog.split('\n').map((line) => line.replace(/\r$/, ''));

  const start = lines.findIndex((line) => headingVersion(line) === version);
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (headingVersion(lines[i]) !== null) {
      end = i;
      break;
    }
  }

  const body = lines.slice(start + 1, end);
  while (body.length > 0 && (body[0] ?? '').trim() === '') body.shift();
  while (body.length > 0) {
    const last = body[body.length - 1] ?? '';
    if (last.trim() === '' || isLinkDefinition(last)) body.pop();
    else break;
  }

  return body.join('\n');
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const version = process.argv[2];
if (!version) {
  fail('Usage: node scripts/release-notes.mjs <version> [changelog.md]');
}

const path = process.argv[3] ?? fileURLToPath(new URL('../CHANGELOG.md', import.meta.url));

let changelog;
try {
  changelog = readFileSync(path, 'utf8');
} catch (error) {
  fail(`Cannot read ${path}: ${error.message}`);
}

const section = sectionFor(changelog, version);

if (section === null) {
  fail(
    `CHANGELOG.md has no section for ${version}.\n` +
      `\n` +
      `A release page that does not say what changed is worse than no release page.\n` +
      `Rename the '## [Unreleased]' heading to '## [${version}] - <date>', add the\n` +
      `matching link-reference definition at the bottom of the file, then retag.`,
  );
}

if (section.trim() === '') {
  fail(
    `CHANGELOG.md has a heading for ${version} with nothing under it.\n` +
      `\n` +
      `Write what changed. The release body is this text, and an empty one ships a\n` +
      `page that says nothing.`,
  );
}

process.stdout.write(`${section}\n`);

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';

/**
 * Every hidden command is dispatched by something.
 *
 * A hidden command is out of the palette, the menu and the keybinding
 * editor by definition, so the only way it runs is a line of code that
 * names it: a keybinding with an argument, a context-menu item, a button.
 * Without that line it is a title and a `run` nothing ever reaches.
 *
 * Guards A1-010: `edit.foldLevel` sat hidden with no dispatcher from the
 * day it was added. This reads the source rather than instrumenting the
 * registry because the failure is static: the dispatcher either exists in
 * the tree or it does not. Does not catch a dispatcher that exists but is
 * unreachable in the UI, or a hidden command dispatched only by a plugin.
 */

const SRC = join(__dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(ts|svelte)$/.test(entry) && !/\.stories\.svelte$/.test(entry)) files.push(path);
  }
  return files;
}

/** Lines that name `id` in single quotes, other than the command's own `id:` line. */
function dispatchSites(id: string, files: readonly string[]): string[] {
  const sites: string[] = [];
  const quoted = `'${id}'`;
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!line.includes(quoted)) return;
      if (/^\s*id:\s*'[^']+',?\s*$/.test(line) && file.endsWith('app.ts')) return;
      sites.push(`${relative(SRC, file)}:${index + 1}`);
    });
  }
  return sites;
}

describe('hidden commands', () => {
  const app = new NoxApp(new MemoryPlatform());
  const hidden = app.commands.all().filter((command) => command.hidden);
  const files = sourceFiles(SRC);

  it('exist, so this cannot pass vacuously', () => {
    expect(hidden.length).toBeGreaterThan(0);
  });

  for (const command of hidden) {
    it(`${command.id} is dispatched from somewhere in src/`, () => {
      expect(dispatchSites(command.id, files)).not.toEqual([]);
    });
  }
});

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';

/**
 * Every command is named by at least one test.
 *
 * Guards A1-012: fourteen commands had no test that so much as mentioned
 * them, so a broken `run`, a wrong `enabled` or a mis-shaped argument would
 * have failed nothing. "Named" is the audit's own rule: the full id, or the
 * id's verb as a whole word, because most commands are one-line delegations
 * to a service method of the same name (`file.openFolder` runs
 * `workspace.openFolder`) and that method's test is what pins the behaviour.
 * This is the floor, not the ceiling: it proves someone looked, not that the
 * wiring is right. Does not catch a test that names a verb and asserts
 * nothing about the command that delegates to it.
 */

const TESTS = join(__dirname);

function testSources(): string {
  return readdirSync(TESTS)
    .filter((name) => /\.test\.ts$/.test(name) && name !== 'command-coverage.test.ts')
    .map((name) => readFileSync(join(TESTS, name), 'utf8'))
    .join('\n');
}

describe('command coverage', () => {
  const app = new NoxApp(new MemoryPlatform());
  const corpus = testSources();

  it('has commands to check, so a broken fixture cannot pass vacuously', () => {
    expect(app.commands.all().length).toBeGreaterThan(100);
  });

  it('names every command, by id or by verb, in at least one test file', () => {
    const named = (id: string) => {
      if (corpus.includes(id)) return true;
      const verb = id.slice(id.lastIndexOf('.') + 1);
      return new RegExp(`\\b${verb}\\b`).test(corpus);
    };
    const unnamed = app.commands
      .all()
      .map((command) => command.id)
      .filter((id) => !named(id));
    expect(unnamed).toEqual([]);
  });
});

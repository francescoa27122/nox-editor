import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { SNIPPETS_FILE, SNIPPETS_TEMPLATE, SnippetService } from '../src/services/snippets';

/**
 * The snippets file, loaded.
 *
 * The shapes are `core/snippets.ts`'s problem; this is about the file itself —
 * missing, empty, not JSON — and about the one rule that matters when it goes
 * wrong: **the snippets that were working stay working.** A typo saved
 * mid-edit must not disarm the set the author already had, because the file is
 * edited *in Nox*, with the watcher live, so a half-written file is the normal
 * state rather than the exceptional one.
 */

function setup() {
  const platform = new MemoryPlatform();
  return { platform, service: new SnippetService(platform) };
}

describe('loading', () => {
  it('finds nothing when the file does not exist', async () => {
    const { service } = setup();
    await service.load();

    expect(service.forLanguage('typescript')).toEqual([]);
    expect(service.error.get()).toBeNull();
  });

  it('treats an empty file as no snippets, not as an error', async () => {
    const { platform, service } = setup();
    await platform.writeConfigFile(SNIPPETS_FILE, '   \n');
    await service.load();

    expect(service.error.get()).toBeNull();
  });

  it('reads snippets for a language, and the wildcard with them', async () => {
    const { platform, service } = setup();
    await platform.writeConfigFile(
      SNIPPETS_FILE,
      JSON.stringify({ '*': { todo: 'TODO: $0' }, go: { pl: 'fmt.Println($0)' } }),
    );
    await service.load();

    expect(service.forLanguage('go').map((s) => s.prefix).sort()).toEqual(['pl', 'todo']);
    expect(service.forLanguage('ruby').map((s) => s.prefix)).toEqual(['todo']);
  });

  it('says so when the file is not JSON', async () => {
    const { platform, service } = setup();
    await platform.writeConfigFile(SNIPPETS_FILE, '{ oops');
    await service.load();

    expect(service.error.get()).not.toBeNull();
  });

  it('keeps the snippets that were working when a later save is broken', async () => {
    const { platform, service } = setup();
    await platform.writeConfigFile(SNIPPETS_FILE, JSON.stringify({ go: { pl: 'fmt.Println($0)' } }));
    await service.load();

    await platform.writeConfigFile(SNIPPETS_FILE, '{ half-writ');
    await service.load();

    // The file is edited inside Nox with the watcher live, so a broken parse
    // is what a half-typed keystroke looks like. Dropping the set on every
    // one of those would make the file impossible to edit in place.
    expect(service.forLanguage('go').map((s) => s.prefix)).toEqual(['pl']);
    expect(service.error.get()).not.toBeNull();
  });

  it('clears the error once the file parses again', async () => {
    const { platform, service } = setup();
    await platform.writeConfigFile(SNIPPETS_FILE, '{ oops');
    await service.load();
    await platform.writeConfigFile(SNIPPETS_FILE, JSON.stringify({ go: { pl: '$0' } }));
    await service.load();

    expect(service.error.get()).toBeNull();
  });

  it('reports the entries it dropped without failing the rest', async () => {
    const { platform, service } = setup();
    await platform.writeConfigFile(
      SNIPPETS_FILE,
      JSON.stringify({ go: { good: 'ok $0', bad: 42 } }),
    );
    await service.load();

    expect(service.forLanguage('go').map((s) => s.prefix)).toEqual(['good']);
    expect(service.error.get()).toContain('bad');
  });
});

describe('the starter file', () => {
  it('is written only when there is nothing there', async () => {
    const { platform, service } = setup();
    await service.ensureFile();
    expect(await platform.readConfigFile(SNIPPETS_FILE)).toBe(SNIPPETS_TEMPLATE);

    await platform.writeConfigFile(SNIPPETS_FILE, '{"go":{"x":"$0"}}');
    await service.ensureFile();
    expect(await platform.readConfigFile(SNIPPETS_FILE)).toBe('{"go":{"x":"$0"}}');
  });

  it('is itself a valid snippets file', async () => {
    const { service } = setup();
    await service.ensureFile();
    await service.load();

    // A starter file that did not parse would teach the format wrong and
    // greet a first-time user with an error they did not cause.
    expect(service.error.get()).toBeNull();
    expect(service.forLanguage('typescript').length).toBeGreaterThan(0);
  });
});

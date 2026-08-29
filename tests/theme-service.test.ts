import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { ThemeService, THEMES_DIRECTORY } from '../src/services/themes';

/**
 * Finding the user's themes.
 *
 * Discovery mirrors `discoverPlugins` rather than `SnippetService`, and §4 of
 * the design doc says why: a theme is a *unit of sharing*. People post them
 * and download them, and a file is that unit — a fragment to paste into a map
 * is not. It also means a broken theme costs one theme rather than all of
 * them, which is the same leniency argument the plugin loader makes.
 *
 * Mutation checks (each made the named test red, then reverted):
 * - `.json` extension filter dropped → "ignores a file that is not JSON".
 * - `load` clearing `#themes` before the walk removed → "a reload drops a
 *   theme whose file has gone".
 * - the `.sort` in `list` removed → "sorts by the displayed name, not by the
 *   file name". That order was not designed; it was found by a cycle test
 *   whose expectation had been written in file-creation order.
 */

const CONFIG = '/config';

/**
 * A `MemoryPlatform` with a config directory, the way
 * `tests/plugin-integration.test.ts` does it. The base fake returns null from
 * `configDir()` — the browser build genuinely has no such folder — so a
 * subclass is how a test gets one.
 */
class ThemePlatform extends MemoryPlatform {
  override async configDir(): Promise<string | null> {
    return CONFIG;
  }
}

async function seedTheme(platform: ThemePlatform, file: string, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  platform.mkdirp(`${CONFIG}/${THEMES_DIRECTORY}`);
  await platform.writeTextFile(`${CONFIG}/${THEMES_DIRECTORY}/${file}`, text);
}

describe('finding themes on disk', () => {
  let platform: ThemePlatform;

  beforeEach(() => {
    platform = new ThemePlatform();
  });

  it('has only the built-ins when the folder does not exist', async () => {
    const themes = new ThemeService(platform);
    await themes.load();

    expect(themes.list().map((theme) => theme.id)).toEqual(['eclipse', 'umbra']);
    expect(themes.problems()).toEqual([]);
  });

  it('lists a theme file after the built-ins', async () => {
    await seedTheme(platform, 'solar.json', { name: 'Solar', tokens: { accent: '#e0a458' } });

    const themes = new ThemeService(platform);
    await themes.load();

    expect(themes.list().map((theme) => theme.id)).toEqual(['eclipse', 'umbra', 'solar']);
    expect(themes.list().map((theme) => theme.name)).toContain('Solar');
  });

  it('takes the id from the file name, not from a field', async () => {
    // A field would let two files claim one id and would need a collision
    // rule. A directory already makes stems unique.
    await seedTheme(platform, 'solar.json', { id: 'something-else', name: 'Solar' });

    const themes = new ThemeService(platform);
    await themes.load();

    expect(themes.list().map((theme) => theme.id)).toContain('solar');
    expect(themes.list().map((theme) => theme.id)).not.toContain('something-else');
  });

  it('ignores a file that is not JSON', async () => {
    await seedTheme(platform, 'notes.txt', 'not a theme');

    const themes = new ThemeService(platform);
    await themes.load();

    expect(themes.list()).toHaveLength(2);
    expect(themes.problems()).toEqual([]);
  });

  it('names a file it could not parse, and keeps the others', async () => {
    await seedTheme(platform, 'broken.json', '{ "name": ');
    await seedTheme(platform, 'solar.json', { name: 'Solar' });

    const themes = new ThemeService(platform);
    await themes.load();

    expect(themes.list().map((theme) => theme.id)).toContain('solar');
    expect(themes.list().map((theme) => theme.id)).not.toContain('broken');
    expect(themes.problems().join(' ')).toMatch(/broken/);
  });

  it('names a theme refused for its base, and keeps the others', async () => {
    await seedTheme(platform, 'wrong.json', { base: 'solarized' });
    await seedTheme(platform, 'solar.json', { name: 'Solar' });

    const themes = new ThemeService(platform);
    await themes.load();

    expect(themes.list().map((theme) => theme.id)).toEqual(['eclipse', 'umbra', 'solar']);
    expect(themes.problems().join(' ')).toMatch(/solarized/);
  });

  it('reports a dropped token without refusing the theme', async () => {
    await seedTheme(platform, 'solar.json', {
      tokens: { accent: '#e0a458', 'z-overlay': '9' },
    });

    const themes = new ThemeService(platform);
    await themes.load();

    expect(themes.list().map((theme) => theme.id)).toContain('solar');
    expect(themes.problems().join(' ')).toMatch(/z-overlay/);
  });

  it('a reload drops a theme whose file has gone', async () => {
    await seedTheme(platform, 'solar.json', { name: 'Solar' });
    const themes = new ThemeService(platform);
    await themes.load();
    expect(themes.list()).toHaveLength(3);

    await platform.trash(`${CONFIG}/${THEMES_DIRECTORY}/solar.json`);
    await themes.load();

    expect(themes.list().map((theme) => theme.id)).toEqual(['eclipse', 'umbra']);
  });

  /**
   * Found by a cycle test whose expectation was written in file-creation
   * order. `readDir` does not specify an order and it differs between
   * platforms, so the picker's rows — and **Switch Theme**, which walks this
   * same list — would move between launches.
   */
  it('sorts the user’s themes rather than trusting the directory order', async () => {
    await seedTheme(platform, 'zebra.json', { name: 'Zebra' });
    await seedTheme(platform, 'apple.json', { name: 'Apple' });
    await seedTheme(platform, 'moss.json', { name: 'Moss' });

    const themes = new ThemeService(platform);
    await themes.load();

    // Built-ins first — the two that always work head the list — then the
    // rest by name.
    expect(themes.list().map((theme) => theme.id)).toEqual([
      'eclipse',
      'umbra',
      'apple',
      'moss',
      'zebra',
    ]);
  });

  it('sorts by the displayed name, not by the file name', async () => {
    await seedTheme(platform, 'aaa.json', { name: 'Zulu' });
    await seedTheme(platform, 'zzz.json', { name: 'Alpha' });

    const themes = new ThemeService(platform);
    await themes.load();

    expect(themes.list().slice(2).map((theme) => theme.name)).toEqual(['Alpha', 'Zulu']);
  });

  it('bumps its revision so the settings picker re-reads', async () => {
    const themes = new ThemeService(platform);
    const before = themes.revision.get();

    await themes.load();

    expect(themes.revision.get()).toBeGreaterThan(before);
  });
});

describe('resolving a theme to what the DOM needs', () => {
  let platform: ThemePlatform;

  beforeEach(() => {
    platform = new ThemePlatform();
  });

  it('resolves a built-in to itself, with nothing to override', async () => {
    const themes = new ThemeService(platform);
    await themes.load();

    expect(themes.resolve('umbra')).toEqual({ base: 'umbra', tokens: {} });
  });

  it('resolves a custom theme to its base and its tokens', async () => {
    await seedTheme(platform, 'solar.json', {
      base: 'umbra',
      tokens: { 'bg-editor': '#101214' },
    });

    const themes = new ThemeService(platform);
    await themes.load();

    // The base is what `data-nox-theme` becomes, so the cascade fills in
    // everything the file did not mention; the tokens go on top.
    expect(themes.resolve('solar')).toEqual({
      base: 'umbra',
      tokens: { 'bg-editor': '#101214' },
    });
  });

  /**
   * The degradation that matters. A theme id can outlive its file — the user
   * deletes it, or opens their settings on another machine. Falling back to
   * the default *base* rather than rewriting the setting means reinstalling
   * the file brings the choice back rather than requiring it to be made again.
   */
  it('resolves an unknown id to the default theme without forgetting it', async () => {
    const themes = new ThemeService(platform);
    await themes.load();

    expect(themes.resolve('deleted-last-week')).toEqual({ base: 'eclipse', tokens: {} });
  });

  it('knows whether an id is one it can honour', async () => {
    await seedTheme(platform, 'solar.json', {});
    const themes = new ThemeService(platform);
    await themes.load();

    expect(themes.has('solar')).toBe(true);
    expect(themes.has('eclipse')).toBe(true);
    expect(themes.has('nope')).toBe(false);
  });
});

describe('the folder itself', () => {
  it('is created with an example when asked, and the example is a valid theme', async () => {
    const platform = new ThemePlatform();
    const themes = new ThemeService(platform);

    const path = await themes.ensureFolder();

    expect(path).toContain(THEMES_DIRECTORY);
    await themes.load();
    // The example has to load, or the first thing a new theme author sees is
    // an error in a file they did not write.
    expect(themes.problems()).toEqual([]);
    expect(themes.list().length).toBeGreaterThan(2);
  });

  it('does not overwrite an example the user has edited', async () => {
    const platform = new ThemePlatform();
    const themes = new ThemeService(platform);

    await themes.ensureFolder();
    await themes.load();
    const [id] = themes.list().filter((theme) => theme.id !== 'eclipse' && theme.id !== 'umbra');
    const file = `${CONFIG}/${THEMES_DIRECTORY}/${id?.id}.json`;
    await platform.writeTextFile(file, JSON.stringify({ name: 'Mine', tokens: {} }));

    await themes.ensureFolder();

    expect(await platform.readTextFile(file)).toContain('Mine');
  });
});

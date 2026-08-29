// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import { THEMES_DIRECTORY } from '../src/services/themes';

/**
 * A theme reaching the document.
 *
 * The seam between `ThemeService` and the DOM, and the one place the design's
 * two halves have to line up: `data-nox-theme` carries the **base**, so
 * `tokens.css`'s cascade fills in everything a file did not mention, and the
 * file's own tokens go on as inline custom properties, which outrank a
 * `[data-nox-theme]` rule.
 *
 * The rule that needs a test rather than an argument is the *removal*.
 * Switching away from a custom theme has to take its properties back, and the
 * old theme's token list is unreachable by then — the setting has already
 * changed — which is why `#themeProperties` is tracked rather than recomputed.
 *
 * Mutation checks (each made the named test red, then reverted):
 * - the `removeProperty` loop dropped → "switching to a built-in theme takes
 *   the custom properties back".
 * - `setAttribute` given the theme id rather than `base` → "puts the base on
 *   the document, not the theme's own id".
 */

const CONFIG = '/config';

class ThemePlatform extends MemoryPlatform {
  override async configDir(): Promise<string | null> {
    return CONFIG;
  }
}

let app: NoxApp | null = null;

beforeEach(() => {
  document.documentElement.removeAttribute('data-nox-theme');
  document.documentElement.removeAttribute('style');
});

afterEach(() => {
  app = null;
  document.documentElement.removeAttribute('data-nox-theme');
  document.documentElement.removeAttribute('style');
});

async function setup(themes: Record<string, unknown> = {}) {
  const platform = new ThemePlatform();
  platform.mkdirp(`${CONFIG}/${THEMES_DIRECTORY}`);
  for (const [name, body] of Object.entries(themes)) {
    await platform.writeTextFile(
      `${CONFIG}/${THEMES_DIRECTORY}/${name}.json`,
      JSON.stringify(body),
    );
  }

  app = new NoxApp(platform);
  await app.loadThemes();
  return app;
}

const root = () => document.documentElement;
const property = (name: string) => root().style.getPropertyValue(name).trim();

describe('applying a theme', () => {
  it('puts a built-in theme straight on the attribute', async () => {
    const nox = await setup();

    nox.config.set('workbench.theme', 'umbra');

    expect(root().getAttribute('data-nox-theme')).toBe('umbra');
    expect(root().getAttribute('style')).toBeNull();
  });

  it('puts the base on the document, not the theme’s own id', async () => {
    // The whole reason a twelve-line theme works: everything the file does not
    // mention has to come from a base the stylesheet actually defines, and
    // `[data-nox-theme='solar']` matches no rule in `tokens.css`.
    const nox = await setup({ solar: { base: 'umbra', tokens: { 'bg-editor': '#101214' } } });

    nox.config.set('workbench.theme', 'solar');

    expect(root().getAttribute('data-nox-theme')).toBe('umbra');
  });

  it('sets the file’s tokens as custom properties over that base', async () => {
    const nox = await setup({
      solar: { base: 'umbra', tokens: { 'bg-editor': '#101214', accent: '#e0a458' } },
    });

    nox.config.set('workbench.theme', 'solar');

    expect(property('--nox-bg-editor')).toBe('#101214');
    expect(property('--nox-accent')).toBe('#e0a458');
  });

  it('switching to a built-in theme takes the custom properties back', async () => {
    const nox = await setup({ solar: { tokens: { accent: '#e0a458' } } });
    nox.config.set('workbench.theme', 'solar');
    expect(property('--nox-accent')).toBe('#e0a458');

    nox.config.set('workbench.theme', 'umbra');

    expect(property('--nox-accent')).toBe('');
    expect(root().getAttribute('data-nox-theme')).toBe('umbra');
  });

  it('switching between two custom themes leaves none of the first behind', async () => {
    const nox = await setup({
      solar: { tokens: { accent: '#e0a458', 'syn-string': '#98c379' } },
      moss: { tokens: { accent: '#7cb87c' } },
    });
    nox.config.set('workbench.theme', 'solar');

    nox.config.set('workbench.theme', 'moss');

    expect(property('--nox-accent')).toBe('#7cb87c');
    // The token the second theme does not mention has to come from the base
    // again, not linger from the first.
    expect(property('--nox-syn-string')).toBe('');
  });

  /**
   * A theme id outlives its file whenever someone deletes it or opens their
   * settings on another machine. The setting is deliberately *not* rewritten,
   * so putting the file back brings the choice back.
   */
  it('falls back to the default base when the chosen theme is gone', async () => {
    const nox = await setup();

    nox.config.set('workbench.theme', 'deleted-last-week');

    expect(root().getAttribute('data-nox-theme')).toBe('eclipse');
    expect(root().getAttribute('style')).toBeNull();
    expect(nox.config.get('workbench.theme')).toBe('deleted-last-week');
  });

  it('applies a theme that arrives on a reload of an already-chosen id', async () => {
    // The order a real install takes: choose it (or restore a session that
    // names it), then the file appears, then Reload Themes.
    const nox = await setup();
    nox.config.set('workbench.theme', 'solar');
    expect(property('--nox-accent')).toBe('');

    await nox.platform.writeTextFile(
      `${CONFIG}/${THEMES_DIRECTORY}/solar.json`,
      JSON.stringify({ tokens: { accent: '#e0a458' } }),
    );
    await nox.loadThemes();

    expect(property('--nox-accent')).toBe('#e0a458');
  });
});

describe('Switch Theme', () => {
  it('cycles through the custom themes too, not just the two built-ins', async () => {
    const nox = await setup({ solar: {}, moss: {} });

    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      await nox.commands.execute('view.toggleTheme');
      seen.push(nox.config.get('workbench.theme'));
    }

    // Four steps from eclipse walks the whole list and returns to it, which is
    // what "cycles" has to mean once there are more than two.
    //
    // `moss` before `solar` is the sort, not the order the files were written:
    // neither declares a name, so both fall back to their id and the list is
    // alphabetical. Writing this expectation in creation order is what caught
    // that `list()` was returning whatever `readDir` gave it.
    expect(seen).toEqual(['umbra', 'moss', 'solar', 'eclipse']);
  });
});

import { describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';

/**
 * Invariants over the whole command table.
 *
 * The palette renders every row as `"${category}: ${title}"`. Six Search
 * commands carried their own category inside the title as well, so the palette
 * showed `Search: Search: Toggle Match Case` — the first thing a user saw on
 * typing "search", and it read as a bug in the app rather than a typo in a
 * string. Nothing caught it because nothing had ever looked at the table as a
 * whole; each title is individually plausible.
 *
 * These are table-wide assertions for exactly that reason: they fail on the
 * next command that lands with the same shape, which review demonstrably does
 * not.
 */
describe('the command table', () => {
  const app = new NoxApp(new MemoryPlatform());
  const commands = app.commands.all();

  it('has commands to check, so a broken fixture cannot pass vacuously', () => {
    expect(commands.length).toBeGreaterThan(100);
  });

  it('never restates its own category inside a title', () => {
    const doubled = commands
      .filter((command) => command.category)
      .filter((command) =>
        command.title.toLowerCase().startsWith(`${command.category!.toLowerCase()}:`),
      )
      .map((command) => `${command.id} → "${command.category}: ${command.title}"`);

    expect(doubled).toEqual([]);
  });

  it('gives every command a non-empty title that is not just its id', () => {
    const bad = commands
      .filter((command) => command.title.trim() === '' || command.title === command.id)
      .map((command) => command.id);

    expect(bad).toEqual([]);
  });

  /**
   * "Zoom" is the word every other editor uses for font size, and the palette
   * returned literally nothing for it — a dead end rather than a wrong answer,
   * which is harder to recover from because it reads as "Nox cannot do this".
   */
  it('reaches the font-size commands by the word users actually type', () => {
    const zoomable = commands
      .filter((command) => command.keywords?.some((keyword) => keyword.includes('zoom')))
      .map((command) => command.id)
      .sort();

    expect(zoomable).toEqual([
      'view.decreaseFontSize',
      'view.increaseFontSize',
      'view.resetFontSize',
    ]);
  });
});

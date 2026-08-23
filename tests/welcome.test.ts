// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import App from '../src/ui/App.svelte';
import { MemoryPlatform } from '../src/platform/memory';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * Getting back to the welcome screen.
 *
 * The gap this covers: `Welcome.svelte` is the only place Nox explains
 * itself — the essential chords, the Start list, recent folders — and it
 * rendered *only* when no buffer was open. Open one file and it was gone
 * until you closed every tab, and no command brought it back. Off macOS that
 * mattered more than it sounds: `predefined('about')` and its neighbours are
 * native menu items the in-window bar cannot draw, so the Nox menu there held
 * six settings-and-updates entries, and an app with 148 commands offered
 * nothing in its chrome that answered "where do I start".
 *
 * The screen is now both the empty state *and* a layer you can ask for, which
 * is the thing worth pinning: the two have to agree about when it shows, and
 * the layer has to get out of the way the moment you go somewhere.
 */

let panel: Mounted | null = null;

afterEach(() => {
  panel?.unmount();
  panel = null;
});

const FILE = '/w/notes.txt';

/** The full shell, with one file open and the editor showing. */
async function setupWithFile() {
  const app = new NoxApp(new MemoryPlatform());
  panel = mountComponent(App, { app, props: { app } });
  panel.platform.seedFile(FILE, 'hello');
  await app.workspace.openFolder('/w');
  const id = (await app.workspace.open(FILE))!;
  app.workspace.setActive(id);
  await Promise.resolve();
  flush();

  // The editor is showing, which is the state the whole feature is about.
  expect(panel.container.querySelector('.welcome')).toBeNull();
  return { app, id };
}

const welcome = () => panel!.container.querySelector('.welcome');

describe('the welcome screen', () => {
  it('is the empty state when nothing is open, without being asked for', async () => {
    const app = new NoxApp(new MemoryPlatform());
    panel = mountComponent(App, { app, props: { app } });
    flush();

    expect(welcome()).not.toBeNull();
    // Not "open" — it is what this slot shows when there is nothing to edit.
    // A signal set here would make Escape appear to close something.
    expect(app.ui.welcomeOpen.get()).toBe(false);
  });

  it('comes back on command while a file is open', async () => {
    const { app } = await setupWithFile();

    await app.commands.execute('app.showWelcome');
    flush();

    expect(welcome()).not.toBeNull();
    expect(panel!.container.querySelector('.editor-area')).toBeNull();
  });

  /**
   * **The case the first draft got wrong**, and the reason
   * `buffer-activated` exists at all.
   *
   * Re-selecting the file you are *already* on is the likely way back: the
   * tab strip belongs to `EditorArea` and is not on screen while this is, so
   * the route is the explorer, and clicking a file that is already open
   * activates it without changing anything. `setActive` is called with the id
   * that is already active, `Signal.set` no-ops because the value is equal,
   * and the `activeId` subscription never fires. Hooked to that signal the
   * screen sat there ignoring the click; hooked to the event, which
   * `setActive` emits unconditionally, it gets out of the way.
   *
   * Driven in the browser build on 2026-08-23 as well as here: clicking the
   * already-open README in the explorer restored the editor and its tab.
   *
   * Note the id: it is the one already active. A different buffer would pass
   * under either implementation and prove nothing.
   */
  it('gets out of the way when the file already open is chosen again', async () => {
    const { app, id } = await setupWithFile();
    expect(app.workspace.activeId.get()).toBe(id);

    await app.commands.execute('app.showWelcome');
    flush();
    expect(welcome()).not.toBeNull();

    // Exactly what choosing that file in the explorer does — no more.
    app.workspace.setActive(id);
    await Promise.resolve();
    flush();

    expect(welcome()).toBeNull();
    expect(panel!.container.querySelector('.editor-area')).not.toBeNull();
  });

  it('is dismissed by Escape, below everything else in its slot', async () => {
    const { app } = await setupWithFile();
    await app.commands.execute('app.showWelcome');
    flush();

    expect(app.ui.hasDismissible()).toBe(true);
    expect(app.ui.dismissTop()).toBe(true);
    flush();

    expect(app.ui.welcomeOpen.get()).toBe(false);
    expect(welcome()).toBeNull();
  });

  /**
   * With nothing open, Escape must not claim to have closed the empty state —
   * but the signal still clears, so the next file opened is not covered by a
   * screen asked for several minutes ago.
   */
  it('clears its signal without pretending to close the empty state', async () => {
    const app = new NoxApp(new MemoryPlatform());
    panel = mountComponent(App, { app, props: { app } });
    await app.commands.execute('app.showWelcome');
    flush();

    expect(app.ui.dismissTop()).toBe(true);
    flush();

    expect(app.ui.welcomeOpen.get()).toBe(false);
    // Still on screen, because nothing else can be: there is no file.
    expect(welcome()).not.toBeNull();
  });

  /**
   * It shares the editor slot with review, agents and diff, and asking for it
   * is explicit — so it clears them rather than hiding behind them.
   */
  it('takes the slot from whatever else was using it', async () => {
    const { app } = await setupWithFile();
    app.ui.showDiff();
    flush();
    expect(app.ui.diffOpen.get()).toBe(true);

    await app.commands.execute('app.showWelcome');
    flush();

    expect(app.ui.diffOpen.get()).toBe(false);
    expect(welcome()).not.toBeNull();
  });

  it('is findable by the words someone would actually search for', () => {
    const app = new NoxApp(new MemoryPlatform());
    panel = mountComponent(App, { app, props: { app } });
    const command = app.commands.get('app.showWelcome');

    expect(command).toBeDefined();
    // The reason this command exists off macOS is that there is no Help menu
    // and no About, so those two words have to lead somewhere.
    expect(command!.keywords).toContain('help');
    expect(command!.keywords).toContain('about');
  });
});

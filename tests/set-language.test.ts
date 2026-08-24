import { describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';
import { WorkspaceService } from '../src/services/workspace';

/**
 * Choosing what a buffer is edited as.
 *
 * The gap this covers: the language was whatever `detectLanguage` inferred
 * from the file name at open time, and **nothing could disagree with it**.
 * No command set it, so an untitled buffer stayed plaintext until its first
 * save and a `.conf` full of JSON stayed unhighlighted for good. The status
 * bar named the language and was the one inert item in a row of live ones —
 * a control labelled with a language that refused to change it.
 *
 * The interesting part is not the assignment but what has to follow it: the
 * grammar and the language the LSP document was opened under both change, and
 * `buffer-reset` is what makes the view pick up either. `saveAs` already had
 * to solve exactly this when a rename changes the extension, so this reuses
 * its answer rather than inventing a second one.
 */

const FILE = '/w/notes.txt';

async function workspaceWithFile() {
  const platform = new MemoryPlatform();
  platform.seedFile(FILE, 'hello');
  const workspace = new WorkspaceService(platform, () => []);
  const id = (await workspace.open(FILE))!;
  return { workspace, id };
}

describe('setting a buffer language', () => {
  it('changes what the buffer reports', async () => {
    const { workspace, id } = await workspaceWithFile();
    expect(workspace.buffers.get().find((b) => b.id === id)?.languageId).toBe('plaintext');

    expect(workspace.setLanguage(id, 'markdown')).toBe(true);

    const buffer = workspace.buffers.get().find((b) => b.id === id);
    expect(buffer?.languageId).toBe('markdown');
    // The name too: it is what the status bar renders, and a stale one there
    // is the whole symptom this feature exists to remove.
    expect(buffer?.languageName).toBe('Markdown');
  });

  /**
   * The view holds the grammar and the LSP document identity, and neither is
   * derivable from the document — so nothing re-reads them on its own. Without
   * this event the language changed everywhere except on screen.
   */
  it('tells the view to re-sync, which is what reloads the grammar', async () => {
    const { workspace, id } = await workspaceWithFile();
    const reset: string[] = [];
    workspace.events.on('buffer-reset', (event) => reset.push(event.id));

    workspace.setLanguage(id, 'markdown');

    expect(reset).toEqual([id]);
  });

  /**
   * A no-op must stay silent. The event costs the scroll position — the view
   * re-syncs from the buffer's state — so firing it for a choice that changed
   * nothing would punish someone for picking the language they already had.
   */
  it('does nothing, and says so, when the language is already that', async () => {
    const { workspace, id } = await workspaceWithFile();
    workspace.setLanguage(id, 'markdown');

    const reset: string[] = [];
    workspace.events.on('buffer-reset', (event) => reset.push(event.id));

    expect(workspace.setLanguage(id, 'markdown')).toBe(false);
    expect(reset).toEqual([]);
  });

  it('refuses a buffer that is not there', async () => {
    const { workspace } = await workspaceWithFile();
    expect(workspace.setLanguage('nope', 'markdown')).toBe(false);
  });

  /**
   * `languageById` falls back to plaintext rather than throwing, and that
   * matters beyond this call: a session restored with an id from a future
   * version must not stop the buffer opening.
   */
  it('falls back to plaintext for an id it does not know', async () => {
    const { workspace, id } = await workspaceWithFile();
    workspace.setLanguage(id, 'markdown');

    expect(workspace.setLanguage(id, 'klingon')).toBe(true);
    expect(workspace.buffers.get().find((b) => b.id === id)?.languageId).toBe('plaintext');
  });
});

describe('the command', () => {
  async function appWithFile() {
    // The concrete platform is kept rather than reached for through
    // `app.platform`, which is typed as the interface and has no `seedFile`.
    const platform = new MemoryPlatform();
    platform.seedFile(FILE, 'hello');
    const app = new NoxApp(platform);
    const id = (await app.workspace.open(FILE))!;
    app.workspace.setActive(id);
    return { app, id };
  }

  it('sets the language when handed one', async () => {
    const { app, id } = await appWithFile();

    await app.commands.execute('lang.setLanguage', 'rust');

    expect(app.workspace.buffers.get().find((b) => b.id === id)?.languageId).toBe('rust');
  });

  /**
   * One command, two jobs, so the palette lists a single row and the picker's
   * own rows dispatch the same id the status bar and the Code menu do.
   */
  it('opens the picker when handed nothing', async () => {
    const { app } = await appWithFile();

    await app.commands.execute('lang.setLanguage');

    expect(app.ui.overlay.get()).toBe('language');
  });

  it('is disabled with no file open', () => {
    const app = new NoxApp(new MemoryPlatform());
    const command = app.commands.get('lang.setLanguage');

    expect(command).toBeDefined();
    expect(command!.enabled?.()).toBe(false);
  });

  /**
   * `Language` is the Code menu. A category `LAYOUT` does not name is a
   * command that reaches no menu at all, which is the trap `menu.ts` exists
   * to close — and the one a `Help` category fell into once already.
   */
  it('lands in a menu', () => {
    const app = new NoxApp(new MemoryPlatform());
    expect(app.commands.get('lang.setLanguage')?.category).toBe('Language');
  });
});

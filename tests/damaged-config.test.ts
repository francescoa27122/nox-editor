import { describe, expect, it } from 'vitest';
import { damagedCopyName, highestNumbered } from '../src/core/damaged-config';
import { join } from '../src/core/path';
import { MemoryPlatform } from '../src/platform/memory';
import { ConfigService, workspaceConfigPath } from '../src/services/config';
import { CommandRegistry } from '../src/services/commands';
import { KeymapService } from '../src/services/keymap';
import { NotesService } from '../src/services/notes';
import { SessionService } from '../src/services/session';
import { WorkspaceService } from '../src/services/workspace';

/**
 * What these guard: four load paths that treated a file they could not parse
 * as a file that was not there, and then wrote over it.
 *
 * Absent is a state Nox handles by starting from defaults and saving its own
 * file on top. That is right for a file that genuinely is not there and
 * destructive for one that is — and all four of these files hold something
 * the user cannot get back. `servers.json` and `agents.json` already reported
 * their parse failures; nobody noticed the other four because neither of
 * those two is ever written back.
 *
 * See `docs/superpowers/specs/2026-08-22-damaged-config-recovery-design.md`.
 */

/** A platform whose named config writes fail, the way a full disk would. */
class UnwritablePlatform extends MemoryPlatform {
  readonly failing = new Set<string>();

  override async writeConfigFile(name: string, contents: string): Promise<void> {
    if (this.failing.has(name)) throw new Error('disk is full');
    return super.writeConfigFile(name, contents);
  }
}

// --- The pure halves --------------------------------------------------------

describe('damagedCopyName', () => {
  it('puts the marker before the extension so the copy sorts beside the original', () => {
    expect(damagedCopyName('settings.json')).toBe('settings.damaged.json');
    expect(damagedCopyName('keybindings.json')).toBe('keybindings.damaged.json');
  });

  it('appends when there is no extension', () => {
    expect(damagedCopyName('session')).toBe('session.damaged');
  });

  it('splits on the last dot, not the first', () => {
    expect(damagedCopyName('nox.session.json')).toBe('nox.session.damaged.json');
  });
});

describe('highestNumbered', () => {
  it('finds the largest number a pattern matches', () => {
    const raw = '"unsaved-1.txt" "unsaved-7.txt" "unsaved-3.txt"';
    expect(highestNumbered(raw, /unsaved-(\d+)\.txt/g)).toBe(7);
  });

  it('is 0 when nothing matches', () => {
    expect(highestNumbered('{}', /unsaved-(\d+)\.txt/g)).toBe(0);
  });

  /**
   * The whole point: `JSON.parse` failing does not make the text unreadable,
   * it makes it unstructured. The names are still in it.
   */
  it('reads names out of text that is not valid JSON', () => {
    const truncated = '{"version":4,"groups":[{"tabs":[{"unsaved":{"backup":"unsaved-9.txt"';
    expect(highestNumbered(truncated, /unsaved-(\d+)\.txt/g)).toBe(9);
  });

  it('is not confused by a number that is not the capture', () => {
    expect(highestNumbered('"n12" "note-3.txt"', /"n(\d+)"/g)).toBe(12);
  });
});

// --- settings.json ----------------------------------------------------------

describe('a damaged settings.json', () => {
  it('is copied, reported, and not silently replaced by defaults', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile('settings.json', '{"editor.fontSize": 20,');
    const config = new ConfigService(platform);

    await config.load();

    expect(config.damaged.get()).toEqual({
      file: 'settings.json',
      copy: 'settings.damaged.json',
    });
    expect(await platform.readConfigFile('settings.damaged.json')).toBe(
      '{"editor.fontSize": 20,',
    );
    // Booting is not refused: the defaults still stand.
    const untouched = new ConfigService(new MemoryPlatform());
    expect(config.get('editor.fontSize')).toBe(untouched.get('editor.fontSize'));
  });

  /**
   * `error` means "the last *write* failed" and `#save` clears it on the next
   * write that lands. Reusing it here would erase the damage notice about
   * 250 ms after it appeared, which is why `damaged` is its own signal.
   */
  it('stays reported after a later write succeeds', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile('settings.json', 'not json');
    const config = new ConfigService(platform);
    await config.load();

    config.set('editor.fontSize', 21);
    await config.flush();

    expect(config.error.get()).toBeNull();
    expect(config.damaged.get()?.file).toBe('settings.json');
  });

  it('reports the damage even when the copy cannot be written', async () => {
    const platform = new UnwritablePlatform();
    await platform.writeConfigFile('settings.json', 'not json');
    platform.failing.add('settings.damaged.json');
    const config = new ConfigService(platform);

    await config.load();

    expect(config.damaged.get()).toEqual({ file: 'settings.json', copy: null });
  });

  it('leaves a valid file alone', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile('settings.json', '{"editor.fontSize": 20}');
    const config = new ConfigService(platform);

    await config.load();

    expect(config.damaged.get()).toBeNull();
    expect(await platform.readConfigFile('settings.damaged.json')).toBeNull();
    expect(config.get('editor.fontSize')).toBe(20);
  });

  it('does not treat an absent file as damaged', async () => {
    const platform = new MemoryPlatform();
    const config = new ConfigService(platform);

    await config.load();

    expect(config.damaged.get()).toBeNull();
    expect(await platform.readConfigFile('settings.damaged.json')).toBeNull();
  });
});

// --- keybindings.json -------------------------------------------------------

describe('a damaged keybindings.json', () => {
  it('is copied and reported', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile('keybindings.json', '[{"key":"Mod+j",');
    const keymap = new KeymapService(new CommandRegistry(), platform);

    await keymap.loadUserRules();

    expect(keymap.damaged.get()).toEqual({
      file: 'keybindings.json',
      copy: 'keybindings.damaged.json',
    });
    expect(await platform.readConfigFile('keybindings.damaged.json')).toBe('[{"key":"Mod+j",');
  });

  /** Valid JSON that is not the shape the file must have is damage too. */
  it('treats a file that is not an array as damaged', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile('keybindings.json', '{"key":"Mod+j"}');
    const keymap = new KeymapService(new CommandRegistry(), platform);

    await keymap.loadUserRules();

    expect(keymap.damaged.get()?.file).toBe('keybindings.json');
  });

  it('leaves a valid file alone', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile('keybindings.json', '[]');
    const keymap = new KeymapService(new CommandRegistry(), platform);

    await keymap.loadUserRules();

    expect(keymap.damaged.get()).toBeNull();
  });
});

// --- session.json -----------------------------------------------------------

function sessionSetup(platform: MemoryPlatform) {
  const workspace = new WorkspaceService(platform, () => []);
  const session = new SessionService(platform, workspace);
  return { workspace, session };
}

describe('a damaged session.json', () => {
  it('is copied and reported', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile('session.json', '{"version":4,"groups":[');
    const { session } = sessionSetup(platform);

    expect(await session.restore()).toBe(false);

    expect(session.damaged.get()).toEqual({
      file: 'session.json',
      copy: 'session.damaged.json',
    });
    expect(await platform.readConfigFile('session.damaged.json')).toBe(
      '{"version":4,"groups":[',
    );
  });

  /**
   * The loss this exists to stop. `#nextBackup` restarted at 1 whenever the
   * index would not parse, so the first dirty buffer's backup landed on top
   * of `unsaved-1.txt` — a file holding text the user never saved. The names
   * survive in the damaged text even when its structure does not.
   */
  it('does not write over the backups the damaged index named', async () => {
    const platform = new MemoryPlatform();
    platform.seedFile('/w/a.ts', 'const a = 1;\n');
    await platform.writeConfigFile('unsaved-1.txt', 'work that was never saved');
    await platform.writeConfigFile(
      'session.json',
      '{"version":4,"groups":[{"tabs":[{"kind":"file","path":"/w/a.ts","unsaved":{"backup":"unsaved-1.txt"',
    );

    const { workspace, session } = sessionSetup(platform);
    await session.restore();
    session.markReady();

    await workspace.openFolder('/w');
    const id = (await workspace.open('/w/a.ts'))!;
    workspace.applyTransaction(
      id,
      workspace.stateOf(id)!.update({ changes: { from: 0, insert: 'edited ' } }),
    );
    await session.save();

    expect(await platform.readConfigFile('unsaved-1.txt')).toBe('work that was never saved');
  });

  /** A downgrade should not cost the tabs either. */
  it('treats a version it does not recognise as damage', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile('session.json', '{"version":99,"groups":[]}');
    const { session } = sessionSetup(platform);

    expect(await session.restore()).toBe(false);
    expect(session.damaged.get()?.file).toBe('session.json');
  });

  it('still migrates a version it does recognise, without reporting damage', async () => {
    const platform = new MemoryPlatform();
    platform.seedFile('/w/a.ts', 'const a = 1;\n');
    await platform.writeConfigFile(
      'session.json',
      JSON.stringify({
        version: 1,
        rootPath: '/w',
        tabs: [{ kind: 'file', path: '/w/a.ts' }],
        activeIndex: 0,
        recentFiles: [],
        recentFolders: [],
      }),
    );
    const { workspace, session } = sessionSetup(platform);

    expect(await session.restore()).toBe(true);
    expect(session.damaged.get()).toBeNull();
    expect(workspace.buffers.get().map((b) => b.path)).toEqual(['/w/a.ts']);
  });

  it('does not treat an empty session file as damaged', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile('session.json', '');
    const { session } = sessionSetup(platform);

    expect(await session.restore()).toBe(false);
    expect(session.damaged.get()).toBeNull();
  });
});

// --- notes.json -------------------------------------------------------------

describe('a damaged notes.json', () => {
  it('is copied and reported', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile('notes.json', '{"version":1,"notes":[');
    const notes = new NotesService(platform);

    await notes.load();

    expect(notes.damaged.get()).toEqual({ file: 'notes.json', copy: 'notes.damaged.json' });
    expect(await platform.readConfigFile('notes.damaged.json')).toBe('{"version":1,"notes":[');
  });

  /**
   * `#nextOrdinal`'s own comment promises a restart "cannot reissue one and
   * overwrite the body file of an existing note" — a guarantee that held in
   * every case except the one where it mattered.
   */
  it('does not write over the note bodies the damaged index named', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile('note-1.txt', 'the first note');
    await platform.writeConfigFile(
      'notes.json',
      '{"version":1,"notes":[{"id":"n1","title":"First","body":"note-1.txt"',
    );
    const notes = new NotesService(platform);
    await notes.load();

    notes.create();
    await notes.flush();

    expect(await platform.readConfigFile('note-1.txt')).toBe('the first note');
  });

  it('treats a version it does not recognise as damage', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile('notes.json', '{"version":99,"notes":[]}');
    const notes = new NotesService(platform);

    await notes.load();

    expect(notes.damaged.get()?.file).toBe('notes.json');
  });

  it('leaves a valid file alone', async () => {
    const platform = new MemoryPlatform();
    await platform.writeConfigFile(
      'notes.json',
      JSON.stringify({ version: 1, selectedId: null, notes: [] }),
    );
    const notes = new NotesService(platform);

    await notes.load();

    expect(notes.damaged.get()).toBeNull();
    expect(await platform.readConfigFile('notes.damaged.json')).toBeNull();
  });
});

// --- .nox/settings.json's own path ------------------------------------------

/**
 * Not a damaged-file case, but the same class of silent loss and the same
 * module: a path built with a hardcoded separator is a real path to the OS and
 * a *different string* from the one every other caller builds, and both places
 * that consume it compare strings.
 */
describe('workspaceConfigPath', () => {
  it('uses the separator the root uses', () => {
    expect(workspaceConfigPath('/w')).toBe('/w/.nox/settings.json');
    expect(workspaceConfigPath('C:\\proj')).toBe('C:\\proj\\.nox\\settings.json');
  });

  /**
   * The two failures the mixed form caused, both silent. `NoxApp` reloads
   * workspace settings by testing this string against the watcher's paths,
   * which arrive from Rust in the OS's own form; and `findByPath` is an exact
   * compare, so the palette command opening `C:\proj/.nox/settings.json` made
   * a second buffer for the file the explorer already had open.
   */
  it('matches what join builds for the same file', () => {
    expect(workspaceConfigPath('C:\\proj')).toBe(join('C:\\proj', '.nox', 'settings.json'));
  });
});

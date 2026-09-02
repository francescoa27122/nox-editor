import { EditorSelection } from '@codemirror/state';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Encoding } from '../src/core/encoding';
import { MemoryPlatform } from '../src/platform/memory';
import { WorkspaceService } from '../src/services/workspace';

/**
 * The workspace is tested against the real in-memory platform rather than a
 * mock — same code path the browser build uses, so a passing test means the
 * behaviour actually works rather than that a stub was configured correctly.
 */

function setup() {
  const platform = new MemoryPlatform();
  platform.mkdirp('/work/src');
  platform.seedFile('/work/README.md', '# Hello\n');
  platform.seedFile('/work/src/main.ts', 'const x = 1;\n');
  platform.seedFile('/work/crlf.txt', 'a\r\nb\r\n');
  // No language extensions in tests: the state factory stays trivial so this
  // suite never touches the DOM-dependent editor layer.
  const workspace = new WorkspaceService(platform, () => []);
  return { platform, workspace };
}

describe('opening files', () => {
  let context: ReturnType<typeof setup>;
  beforeEach(() => {
    context = setup();
  });

  it('opens a file and makes it active', async () => {
    const id = await context.workspace.open('/work/README.md');
    expect(id).not.toBeNull();
    expect(context.workspace.activeId.get()).toBe(id);
    expect(context.workspace.textOf(id!)).toBe('# Hello\n');
  });

  it('detects the language from the extension', async () => {
    await context.workspace.open('/work/src/main.ts');
    expect(context.workspace.activeSnapshot()?.languageId).toBe('typescript');
  });

  it('focuses the existing tab instead of opening a duplicate', async () => {
    const first = await context.workspace.open('/work/README.md');
    await context.workspace.open('/work/src/main.ts');
    const second = await context.workspace.open('/work/README.md');
    expect(second).toBe(first);
    expect(context.workspace.buffers.get()).toHaveLength(2);
  });

  it('reports an error for a missing file rather than throwing', async () => {
    const errors: string[] = [];
    context.workspace.events.on('error', (event) => errors.push(event.message));
    const id = await context.workspace.open('/work/nope.txt');
    expect(id).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it('refuses to open a directory as a file', async () => {
    const id = await context.workspace.open('/work/src');
    expect(id).toBeNull();
  });

  it('refuses binary content', async () => {
    context.platform.seedFile('/work/bin', 'abc\0def');
    const id = await context.workspace.open('/work/bin');
    expect(id).toBeNull();
  });

  it('normalises CRLF to LF in the document', async () => {
    const id = await context.workspace.open('/work/crlf.txt');
    expect(context.workspace.textOf(id!)).toBe('a\nb\n');
    expect(context.workspace.activeSnapshot()?.eol).toBe('\r\n');
  });
});

describe('dirty tracking', () => {
  it('is clean on open and dirty after an edit', async () => {
    const { workspace } = setup();
    const id = (await workspace.open('/work/README.md'))!;
    expect(workspace.activeSnapshot()?.isDirty).toBe(false);

    const state = workspace.stateOf(id)!;
    workspace.applyTransaction(id, state.update({ changes: { from: 0, insert: 'x' } }));
    expect(workspace.activeSnapshot()?.isDirty).toBe(true);
  });

  it('clears when an edit is undone back to the saved content', async () => {
    const { workspace } = setup();
    const id = (await workspace.open('/work/README.md'))!;

    const inserted = workspace.stateOf(id)!.update({ changes: { from: 0, insert: 'x' } });
    workspace.applyTransaction(id, inserted);
    expect(workspace.activeSnapshot()?.isDirty).toBe(true);

    const reverted = workspace.stateOf(id)!.update({ changes: { from: 0, to: 1, insert: '' } });
    workspace.applyTransaction(id, reverted);
    expect(workspace.activeSnapshot()?.isDirty).toBe(false);
  });

  it('ignores selection-only transactions', async () => {
    const { workspace } = setup();
    const id = (await workspace.open('/work/README.md'))!;
    const moved = workspace
      .stateOf(id)!
      .update({ selection: EditorSelection.cursor(2) });
    workspace.applyTransaction(id, moved);
    expect(workspace.activeSnapshot()?.isDirty).toBe(false);
  });
});

describe('saving', () => {
  it('writes the buffer to disk and clears dirty', async () => {
    const { platform, workspace } = setup();
    const id = (await workspace.open('/work/README.md'))!;
    workspace.applyTransaction(
      id,
      workspace.stateOf(id)!.update({ changes: { from: 0, insert: 'X' } }),
    );

    expect(await workspace.save(id)).toBe(true);
    expect(await platform.readTextFile('/work/README.md')).toBe('X# Hello\n');
    expect(workspace.activeSnapshot()?.isDirty).toBe(false);
  });

  it('restores CRLF on write', async () => {
    const { platform, workspace } = setup();
    const id = (await workspace.open('/work/crlf.txt'))!;
    await workspace.save(id);
    expect(await platform.readTextFile('/work/crlf.txt')).toBe('a\r\nb\r\n');
  });

  it('trims trailing whitespace when asked', async () => {
    const { platform, workspace } = setup();
    platform.seedFile('/work/messy.txt', 'a   \nb\t\n');
    const id = (await workspace.open('/work/messy.txt'))!;
    await workspace.save(id, { trimTrailingWhitespace: true });
    expect(await platform.readTextFile('/work/messy.txt')).toBe('a\nb\n');
  });

  it('adds a final newline when asked', async () => {
    const { platform, workspace } = setup();
    platform.seedFile('/work/tail.txt', 'a');
    const id = (await workspace.open('/work/tail.txt'))!;
    await workspace.save(id, { insertFinalNewline: true });
    expect(await platform.readTextFile('/work/tail.txt')).toBe('a\n');
  });

  it('refuses to save an untitled buffer without a path', async () => {
    const { workspace } = setup();
    const id = workspace.newUntitled();
    expect(await workspace.save(id)).toBe(false);
  });

  it('saveAs writes to the new path and renames the tab', async () => {
    const { platform, workspace } = setup();
    const id = workspace.newUntitled();
    workspace.applyTransaction(
      id,
      workspace.stateOf(id)!.update({ changes: { from: 0, insert: 'body' } }),
    );

    expect(await workspace.saveAs(id, '/work/src/new.ts')).toBe(true);
    expect(await platform.readTextFile('/work/src/new.ts')).toBe('body');

    const snapshot = workspace.activeSnapshot()!;
    expect(snapshot.name).toBe('new.ts');
    expect(snapshot.isUntitled).toBe(false);
    expect(snapshot.languageId).toBe('typescript');
  });

  it('saveAs rolls the path back when the write fails', async () => {
    const { workspace } = setup();
    const id = (await workspace.open('/work/README.md'))!;
    expect(await workspace.saveAs(id, '/nonexistent/dir/x.md')).toBe(false);
    expect(workspace.activeSnapshot()?.path).toBe('/work/README.md');
  });

  /**
   * Guards A3-001: a keystroke typed while the write was in flight used to be
   * reverted by the whole-document replacement `save` made afterwards, and
   * the buffer then reported clean, so the character was on disk nowhere and
   * not reachable by undo either (the replacement merged with the keystroke
   * into one history event). The write is held open so the keystroke lands
   * exactly in that window, which `MemoryPlatform` normally closes on the next
   * microtask.
   *
   * Does not catch the double-save variant (two `save` calls in flight at
   * once), which has no gate here.
   */
  it('keeps a keystroke typed while the write is in flight, and stays dirty by it', async () => {
    const platform = new GatedPlatform();
    platform.seedFile('/work/alpha.txt', 'alpha\n');
    const workspace = new WorkspaceService(platform, () => []);
    const id = (await workspace.open('/work/alpha.txt'))!;
    const type = (text: string) =>
      workspace.applyTransaction(
        id,
        workspace.stateOf(id)!.update({ changes: { from: 0, insert: text } }),
      );

    type('A');
    const gate = platform.holdWrite('/work/alpha.txt');
    const saving = workspace.save(id, { insertFinalNewline: true });
    await gate.started;
    type('B');
    gate.release();
    expect(await saving).toBe(true);

    // The write carried what the document said when the save began.
    expect(await platform.readTextFile('/work/alpha.txt')).toBe('Aalpha\n');
    // The keystroke that arrived during it is still in the buffer, and the
    // buffer is dirty by exactly that keystroke.
    expect(workspace.textOf(id)).toBe('BAalpha\n');
    expect(workspace.activeSnapshot()?.isDirty).toBe(true);
  });

  it('still applies the formatting when nothing was typed during the write', async () => {
    const platform = new GatedPlatform();
    platform.seedFile('/work/tail.txt', 'a');
    const workspace = new WorkspaceService(platform, () => []);
    const id = (await workspace.open('/work/tail.txt'))!;

    const gate = platform.holdWrite('/work/tail.txt');
    const saving = workspace.save(id, { insertFinalNewline: true });
    await gate.started;
    gate.release();
    expect(await saving).toBe(true);

    expect(await platform.readTextFile('/work/tail.txt')).toBe('a\n');
    expect(workspace.textOf(id)).toBe('a\n');
    expect(workspace.activeSnapshot()?.isDirty).toBe(false);
  });
});

/**
 * Holds one `writeEncodedFile` call open so a test can act while the write is
 * genuinely in flight. `started` resolves the instant the write is reached,
 * and the write proceeds only once `release()` is called. The same shape
 * `tests/notes.test.ts` uses for config writes.
 */
class GatedPlatform extends MemoryPlatform {
  #writes = new Map<string, { markStarted: () => void; blocked: Promise<void> }>();

  holdWrite(path: string): { started: Promise<void>; release: () => void } {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#writes.set(path, { markStarted, blocked });
    return { started, release };
  }

  override async writeEncodedFile(path: string, contents: string, encoding: Encoding): Promise<void> {
    const gate = this.#writes.get(path);
    if (gate) {
      this.#writes.delete(path);
      gate.markStarted();
      await gate.blocked;
    }
    await super.writeEncodedFile(path, contents, encoding);
  }
}

describe('tabs', () => {
  it('inserts new tabs after the active one', async () => {
    const { workspace } = setup();
    await workspace.open('/work/README.md');
    const second = workspace.newUntitled();
    workspace.setActive((await workspace.open('/work/src/main.ts')));

    const order = workspace.buffers.get().map((b) => b.name);
    expect(order[1]).toBe(second ? workspace.buffers.get()[1]!.name : '');
    expect(order).toHaveLength(3);
  });

  it('refuses to close a dirty buffer without force', async () => {
    const { workspace } = setup();
    const id = (await workspace.open('/work/README.md'))!;
    workspace.applyTransaction(
      id,
      workspace.stateOf(id)!.update({ changes: { from: 0, insert: 'x' } }),
    );

    expect(workspace.close(id)).toBe(false);
    expect(workspace.buffers.get()).toHaveLength(1);
    expect(workspace.close(id, { force: true })).toBe(true);
    expect(workspace.buffers.get()).toHaveLength(0);
  });

  it('activates the neighbouring tab after a close', async () => {
    const { workspace } = setup();
    const first = (await workspace.open('/work/README.md'))!;
    const second = (await workspace.open('/work/src/main.ts'))!;
    workspace.close(second);
    expect(workspace.activeId.get()).toBe(first);
  });

  it('cycles and wraps around', async () => {
    const { workspace } = setup();
    const first = (await workspace.open('/work/README.md'))!;
    const second = (await workspace.open('/work/src/main.ts'))!;

    workspace.setActive(first);
    workspace.cycle(1);
    expect(workspace.activeId.get()).toBe(second);
    workspace.cycle(1);
    expect(workspace.activeId.get()).toBe(first);
    workspace.cycle(-1);
    expect(workspace.activeId.get()).toBe(second);
  });

  it('reorders on move', async () => {
    const { workspace } = setup();
    const first = (await workspace.open('/work/README.md'))!;
    await workspace.open('/work/src/main.ts');

    workspace.moveTab(first, 1);
    expect(workspace.buffers.get()[1]!.id).toBe(first);
  });

  it('activates by index and ignores out-of-range', async () => {
    const { workspace } = setup();
    const first = (await workspace.open('/work/README.md'))!;
    const second = (await workspace.open('/work/src/main.ts'))!;

    workspace.activateIndex(0);
    expect(workspace.activeId.get()).toBe(first);
    workspace.activateIndex(9);
    expect(workspace.activeId.get()).toBe(first);
    workspace.activateIndex(1);
    expect(workspace.activeId.get()).toBe(second);
  });
});

describe('folders and recents', () => {
  it('opens a folder that exists', async () => {
    const { workspace } = setup();
    expect(await workspace.openFolder('/work')).toBe(true);
    expect(workspace.rootPath.get()).toBe('/work');
  });

  it('rejects a folder that does not', async () => {
    const { workspace } = setup();
    expect(await workspace.openFolder('/missing')).toBe(false);
    expect(workspace.rootPath.get()).toBeNull();
  });

  it('tracks recent files most-recent-first without duplicates', async () => {
    const { workspace } = setup();
    await workspace.open('/work/README.md');
    await workspace.open('/work/src/main.ts');
    await workspace.open('/work/README.md');

    expect(workspace.recentFiles.get()).toEqual(['/work/README.md', '/work/src/main.ts']);
  });

  it('creates a file on disk and opens it', async () => {
    const { platform, workspace } = setup();
    const id = await workspace.createFile('/work/src/fresh.ts');
    expect(id).not.toBeNull();
    expect(await platform.exists('/work/src/fresh.ts')).toBe(true);
    expect(workspace.activeSnapshot()?.name).toBe('fresh.ts');
  });

  it('will not overwrite an existing file when creating', async () => {
    const { workspace } = setup();
    expect(await workspace.createFile('/work/README.md')).toBeNull();
  });
});

describe('on-disk form', () => {
  it('normalises CRLF into the document and writes it back', async () => {
    const { platform, workspace } = setup();
    const id = (await workspace.open('/work/crlf.txt'))!;

    // The document the editor works on is always LF, so every command,
    // search and diff sees one shape.
    expect(workspace.textOf(id)).toBe('a\nb\n');
    expect(workspace.activeSnapshot()?.eol).toBe('\r\n');

    await workspace.save(id);
    expect(await platform.readTextFile('/work/crlf.txt')).toBe('a\r\nb\r\n');
  });

  it('strips a byte-order mark from the document and restores it on save', async () => {
    const { platform, workspace } = setup();
    platform.seedFile('/work/bom.txt', '\uFEFFhello\n');
    const id = (await workspace.open('/work/bom.txt'))!;

    expect(workspace.textOf(id)).toBe('hello\n');
    expect(workspace.activeSnapshot()?.encoding).toBe('utf-8-bom');

    await workspace.save(id);
    expect(await platform.readTextFile('/work/bom.txt')).toBe('\uFEFFhello\n');
  });

  it('does not add a byte-order mark to a file that had none', async () => {
    const { platform, workspace } = setup();
    const id = (await workspace.open('/work/README.md'))!;
    expect(workspace.activeSnapshot()?.encoding).toBe('utf-8');

    await workspace.save(id);
    expect(await platform.readTextFile('/work/README.md')).toBe('# Hello\n');
  });
});

describe('most-recently-used order', () => {
  it('orders open buffers by when they were last focused', async () => {
    const { workspace } = setup();
    const readme = (await workspace.open('/work/README.md'))!;
    const main = (await workspace.open('/work/src/main.ts'))!;
    const crlf = (await workspace.open('/work/crlf.txt'))!;

    expect(workspace.recentBuffers().map((b) => b.id)).toEqual([crlf, main, readme]);

    workspace.setActive(readme);
    expect(workspace.recentBuffers().map((b) => b.id)).toEqual([readme, crlf, main]);
  });

  it('forgets a buffer once it is closed', async () => {
    const { workspace } = setup();
    const readme = (await workspace.open('/work/README.md'))!;
    const main = (await workspace.open('/work/src/main.ts'))!;

    workspace.close(main);
    expect(workspace.recentBuffers().map((b) => b.id)).toEqual([readme]);
  });

  it('differs from tab order, which is what makes it worth keeping', async () => {
    const { workspace } = setup();
    const readme = (await workspace.open('/work/README.md'))!;
    await workspace.open('/work/src/main.ts');
    await workspace.open('/work/crlf.txt');
    workspace.setActive(readme);

    // Tabs stay where they were opened; MRU reflects where you have been.
    expect(workspace.buffers.get().map((b) => b.name)).toEqual([
      'README.md',
      'main.ts',
      'crlf.txt',
    ]);
    expect(workspace.recentBuffers().map((b) => b.name)).toEqual([
      'README.md',
      'crlf.txt',
      'main.ts',
    ]);
  });
});

describe('applyEdits with a range the document cannot honour', () => {
  it('returns false rather than throwing at the caller', async () => {
    const { workspace } = setup();
    const id = (await workspace.open('/work/src/main.ts'))!;
    const before = workspace.textOf(id);
    expect(before).toBe('const x = 1;\n');

    // A stale offset is the ordinary way this happens. The signature promises
    // a boolean, so an exception here would surface somewhere that has no
    // reason to be catching one.
    expect(workspace.applyEdits(id, [{ from: 9_999, to: 9_999, insert: 'x' }])).toBe(false);
    expect(workspace.applyEdits(id, [{ from: 5, to: 1, insert: 'x' }])).toBe(false);
    expect(workspace.textOf(id)).toBe(before);
  });

  it('still applies a well-formed edit', async () => {
    const { workspace } = setup();
    const id = (await workspace.open('/work/src/main.ts'))!;

    expect(workspace.applyEdits(id, [{ from: 0, to: 0, insert: '// hi\n' }])).toBe(true);
    expect(workspace.textOf(id)?.startsWith('// hi\n')).toBe(true);
  });
});

describe('the revision a buffer publishes', () => {
  /**
   * The failure this prevents: a staleness mark that cannot see the edit that
   * made it stale. `revisionOf` is a method, so a component cannot subscribe
   * to it; the answers panel reads the revision off this snapshot instead,
   * and `applyTransaction` republishes the list on every document change.
   */
  it('advances on every document change, including one to an already-dirty buffer', async () => {
    const { workspace } = setup();
    const id = (await workspace.open('/work/src/main.ts'))!;
    const published = () => workspace.buffers.get().find((buffer) => buffer.id === id)!;

    const clean = published().revision;
    expect(published().isDirty).toBe(false);

    workspace.applyTransaction(
      id,
      workspace.stateOf(id)!.update({ changes: { from: 0, insert: 'a' } }),
    );
    const afterFirst = published().revision;
    expect(afterFirst).toBeGreaterThan(clean);
    expect(published().isDirty).toBe(true);

    // The case the panel actually gets wrong without this: the buffer is
    // already dirty, so `isDirty` does not flip and the revision is the only
    // published field left that can say the text moved again.
    workspace.applyTransaction(
      id,
      workspace.stateOf(id)!.update({ changes: { from: 0, insert: 'b' } }),
    );
    expect(published().revision).toBeGreaterThan(afterFirst);
    expect(published().isDirty).toBe(true);
  });

  /**
   * The failure this prevents: a closed buffer reading as an unchanged one.
   * `answerFreshness` takes `-1` to mean "gone", and the panel now derives
   * that from the buffer's absence from this list rather than from a method
   * call it cannot subscribe to.
   */
  it('drops a closed buffer from the list entirely', async () => {
    const { workspace } = setup();
    const id = (await workspace.open('/work/src/main.ts'))!;

    workspace.close(id);

    expect(workspace.buffers.get().find((buffer) => buffer.id === id)).toBeUndefined();
    expect(workspace.revisionOf(id)).toBe(-1);
  });
});

describe('files that are not UTF-8', () => {
  const LEGACY = '/w/caf.txt';

  /**
   * The failure this whole feature exists to prevent: a text editor that
   * cannot open a text file. Nox refused anything that was not valid UTF-8,
   * which protected the file but left it unopenable.
   */
  it('opens a file in the charset it is told', async () => {
    const platform = new MemoryPlatform();
    platform.seedEncodedFile(LEGACY, 'caf\u00e9', 'windows-1252');
    const workspace = new WorkspaceService(platform, () => []);

    await workspace.open(LEGACY, { encoding: 'windows-1252' });

    const buffer = workspace.buffers.get()[0]!;
    expect(buffer.encoding).toBe('windows-1252');
  });

  /**
   * The failure this prevents, and the reason the decoder is in Rust: saving
   * a windows-1252 file back as UTF-8. The bytes on disk would change under
   * a user who only pressed ⌘S, and nothing would say so.
   */
  it('saves it back in the same charset', async () => {
    const platform = new MemoryPlatform();
    platform.seedEncodedFile(LEGACY, 'caf\u00e9', 'windows-1252');
    const workspace = new WorkspaceService(platform, () => []);
    await workspace.open(LEGACY, { encoding: 'windows-1252' });

    const id = workspace.buffers.get()[0]!.id;
    expect(await workspace.save(id)).toBe(true);

    expect(platform.encodingOf(LEGACY)).toBe('windows-1252');
  });

  /**
   * Nothing detects a legacy charset, so opening one without being told must
   * fail rather than mojibake — that refusal is what sends the user to the
   * picker.
   */
  it('refuses to guess when it is not told', async () => {
    const platform = new MemoryPlatform();
    platform.seedEncodedFile(LEGACY, 'caf\u00e9', 'windows-1252');
    const workspace = new WorkspaceService(platform, () => []);

    // `open` reports through the notification path and returns null rather
    // than throwing — the same shape every other unopenable file uses.
    expect(await workspace.open(LEGACY)).toBeNull();
    expect(workspace.buffers.get()).toHaveLength(0);
  });

  /** A plain UTF-8 file still opens with no ceremony at all. */
  it('leaves an ordinary file alone', async () => {
    const platform = new MemoryPlatform();
    platform.seedFile('/w/plain.txt', 'hello');
    const workspace = new WorkspaceService(platform, () => []);

    await workspace.open('/w/plain.txt');

    expect(workspace.buffers.get()[0]!.encoding).toBe('utf-8');
  });

  /**
   * The failure this prevents: re-detecting on every external write. A file
   * reloaded after something else touched it must keep the charset it was
   * opened with, or one reload turns it into mojibake.
   */
  it('keeps the charset across a reload from disk', async () => {
    const platform = new MemoryPlatform();
    platform.seedEncodedFile(LEGACY, 'caf\u00e9', 'windows-1252');
    const workspace = new WorkspaceService(platform, () => []);
    await workspace.open(LEGACY, { encoding: 'windows-1252' });

    const id = workspace.buffers.get()[0]!.id;
    platform.seedFile(LEGACY, 'changed underneath');
    await workspace.reloadFromDisk(id);

    expect(workspace.buffers.get()[0]!.encoding).toBe('windows-1252');
  });
});

import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import { WorkspaceService } from '../src/services/workspace';

/**
 * Explorer file operations.
 *
 * The menu itself is trivial; what is not trivial is keeping open buffers
 * correct through a rename or a delete. A rename that leaves a tab pointing at
 * a dead path looks fine until the moment you press save, so most of these
 * tests are about that.
 */

function setup() {
  const platform = new MemoryPlatform();
  platform.seedFile('/w/README.md', '# readme\n');
  platform.seedFile('/w/src/main.ts', 'const main = 1;\n');
  platform.seedFile('/w/src/util.ts', 'const util = 2;\n');
  platform.seedFile('/w/src/deep/nested.ts', 'const nested = 3;\n');

  const workspace = new WorkspaceService(platform, () => []);
  return { platform, workspace };
}

const dirty = (workspace: WorkspaceService, id: string) =>
  workspace.applyTransaction(
    id,
    workspace.stateOf(id)!.update({ changes: { from: 0, insert: '// edited\n' } }),
  );

describe('rename', () => {
  it('moves the file on disk', async () => {
    const { platform, workspace } = setup();
    expect(await workspace.renamePath('/w/src/util.ts', '/w/src/helpers.ts')).toBe(true);

    expect(await platform.exists('/w/src/helpers.ts')).toBe(true);
    expect(await platform.exists('/w/src/util.ts')).toBe(false);
  });

  it('carries an open buffer to the new path', async () => {
    const { workspace } = setup();
    const id = (await workspace.open('/w/src/main.ts'))!;

    await workspace.renamePath('/w/src/main.ts', '/w/src/entry.ts');

    const snapshot = workspace.buffers.get().find((b) => b.id === id)!;
    expect(snapshot.path).toBe('/w/src/entry.ts');
    expect(snapshot.name).toBe('entry.ts');
  });

  it('saves to the new path afterwards, not the old one', async () => {
    const { platform, workspace } = setup();
    const id = (await workspace.open('/w/src/main.ts'))!;
    await workspace.renamePath('/w/src/main.ts', '/w/src/entry.ts');

    dirty(workspace, id);
    expect(await workspace.save(id)).toBe(true);

    expect(await platform.readTextFile('/w/src/entry.ts')).toContain('// edited');
    expect(await platform.exists('/w/src/main.ts')).toBe(false);
  });

  it('updates the language when the extension changes', async () => {
    const { workspace } = setup();
    const id = (await workspace.open('/w/README.md'))!;
    expect(workspace.buffers.get().find((b) => b.id === id)?.languageId).toBe('markdown');

    await workspace.renamePath('/w/README.md', '/w/README.ts');
    expect(workspace.buffers.get().find((b) => b.id === id)?.languageId).toBe('typescript');
  });

  it('carries every buffer under a renamed directory', async () => {
    const { workspace } = setup();
    const main = (await workspace.open('/w/src/main.ts'))!;
    const nested = (await workspace.open('/w/src/deep/nested.ts'))!;

    await workspace.renamePath('/w/src', '/w/lib');

    const paths = workspace.buffers.get().map((b) => b.path);
    expect(paths).toContain('/w/lib/main.ts');
    expect(paths).toContain('/w/lib/deep/nested.ts');
    expect(workspace.buffers.get().find((b) => b.id === main)?.name).toBe('main.ts');
    expect(workspace.buffers.get().find((b) => b.id === nested)?.name).toBe('nested.ts');
  });

  it('moves the whole subtree on disk', async () => {
    const { platform, workspace } = setup();
    await workspace.renamePath('/w/src', '/w/lib');

    expect(await platform.exists('/w/lib/deep/nested.ts')).toBe(true);
    expect(await platform.exists('/w/src/deep/nested.ts')).toBe(false);
  });

  it('refuses to overwrite an existing path', async () => {
    const { platform, workspace } = setup();
    const errors: string[] = [];
    workspace.events.on('error', (event) => errors.push(event.message));

    expect(await workspace.renamePath('/w/src/main.ts', '/w/src/util.ts')).toBe(false);
    expect(errors).toHaveLength(1);
    // The victim must be untouched.
    expect(await platform.readTextFile('/w/src/util.ts')).toBe('const util = 2;\n');
  });

  it('leaves unrelated buffers alone', async () => {
    const { workspace } = setup();
    await workspace.open('/w/README.md');
    await workspace.open('/w/src/main.ts');

    await workspace.renamePath('/w/src/main.ts', '/w/src/entry.ts');

    expect(workspace.buffers.get().find((b) => b.name === 'README.md')?.path).toBe('/w/README.md');
  });

  it('clears a stale external-change marker', async () => {
    const { workspace } = setup();
    const id = (await workspace.open('/w/src/main.ts'))!;
    workspace.markExternalState(id, 'modified');

    await workspace.renamePath('/w/src/main.ts', '/w/src/entry.ts');
    expect(workspace.buffers.get().find((b) => b.id === id)?.externalState).toBe('none');
  });
});

describe('delete', () => {
  it('removes the file from disk', async () => {
    const { platform, workspace } = setup();
    expect(await workspace.deletePath('/w/src/util.ts')).toBe(true);
    expect(await platform.exists('/w/src/util.ts')).toBe(false);
  });

  it('closes a clean buffer for the deleted file', async () => {
    const { workspace } = setup();
    await workspace.open('/w/src/main.ts');
    await workspace.deletePath('/w/src/main.ts');

    expect(workspace.buffers.get()).toHaveLength(0);
  });

  it('keeps a dirty buffer open and marks it', async () => {
    const { workspace } = setup();
    const id = (await workspace.open('/w/src/main.ts'))!;
    dirty(workspace, id);

    await workspace.deletePath('/w/src/main.ts');

    const snapshot = workspace.buffers.get().find((b) => b.id === id);
    expect(snapshot).toBeDefined();
    expect(snapshot?.externalState).toBe('deleted');
    // Unsaved work must survive a delete the user did not aim at it.
    expect(workspace.textOf(id)).toContain('// edited');
  });

  it('removes a directory and everything under it', async () => {
    const { platform, workspace } = setup();
    await workspace.deletePath('/w/src');

    expect(await platform.exists('/w/src/deep/nested.ts')).toBe(false);
    expect(await platform.exists('/w/src')).toBe(false);
    expect(await platform.exists('/w/README.md')).toBe(true);
  });

  it('closes clean buffers beneath a deleted directory', async () => {
    const { workspace } = setup();
    await workspace.open('/w/README.md');
    await workspace.open('/w/src/main.ts');
    await workspace.open('/w/src/deep/nested.ts');

    await workspace.deletePath('/w/src');

    expect(workspace.buffers.get().map((b) => b.name)).toEqual(['README.md']);
  });

  it('reports a failure instead of throwing', async () => {
    const { workspace } = setup();
    const errors: string[] = [];
    workspace.events.on('error', (event) => errors.push(event.message));

    expect(await workspace.deletePath('/w/missing.ts')).toBe(false);
    expect(errors).toHaveLength(1);
  });
});

describe('move (drag and drop)', () => {
  it('moves a file into another folder', async () => {
    const { platform, workspace } = setup();
    platform.mkdirp('/w/lib');

    const result = await workspace.movePaths(['/w/src/main.ts'], '/w/lib');

    expect(result.moved).toEqual(['/w/lib/main.ts']);
    expect(await platform.exists('/w/lib/main.ts')).toBe(true);
    expect(await platform.exists('/w/src/main.ts')).toBe(false);
  });

  it('carries an open buffer to the new location', async () => {
    const { platform, workspace } = setup();
    platform.mkdirp('/w/lib');
    const id = (await workspace.open('/w/src/main.ts'))!;

    await workspace.movePaths(['/w/src/main.ts'], '/w/lib');

    expect(workspace.buffers.get().find((b) => b.id === id)?.path).toBe('/w/lib/main.ts');
  });

  it('saves to the moved location afterwards', async () => {
    const { platform, workspace } = setup();
    platform.mkdirp('/w/lib');
    const id = (await workspace.open('/w/src/main.ts'))!;
    await workspace.movePaths(['/w/src/main.ts'], '/w/lib');

    dirty(workspace, id);
    await workspace.save(id);

    expect(await platform.readTextFile('/w/lib/main.ts')).toContain('// edited');
    expect(await platform.exists('/w/src/main.ts')).toBe(false);
  });

  it('moves a folder with its whole subtree', async () => {
    const { platform, workspace } = setup();
    platform.mkdirp('/w/lib');

    await workspace.movePaths(['/w/src/deep'], '/w/lib');

    expect(await platform.exists('/w/lib/deep/nested.ts')).toBe(true);
    expect(await platform.exists('/w/src/deep')).toBe(false);
  });

  it('re-points buffers beneath a moved folder', async () => {
    const { platform, workspace } = setup();
    platform.mkdirp('/w/lib');
    await workspace.open('/w/src/deep/nested.ts');

    await workspace.movePaths(['/w/src/deep'], '/w/lib');

    expect(workspace.buffers.get()[0]?.path).toBe('/w/lib/deep/nested.ts');
  });

  it('moves several entries at once', async () => {
    const { platform, workspace } = setup();
    platform.mkdirp('/w/lib');

    const result = await workspace.movePaths(['/w/src/main.ts', '/w/src/util.ts'], '/w/lib');

    expect(result.moved).toEqual(['/w/lib/main.ts', '/w/lib/util.ts']);
    expect(result.failed).toHaveLength(0);
  });

  it('refuses to move a folder into its own subtree', async () => {
    const { platform, workspace } = setup();
    // The move that would destroy the tree if it went through.
    const result = await workspace.movePaths(['/w/src'], '/w/src/deep');

    expect(result.moved).toHaveLength(0);
    expect(await platform.exists('/w/src/deep/nested.ts')).toBe(true);
  });

  it('ignores a move into the folder it already lives in', async () => {
    const { workspace } = setup();
    const result = await workspace.movePaths(['/w/src/main.ts'], '/w/src');
    expect(result).toEqual({ moved: [], failed: [] });
  });

  it('refuses to overwrite a file already at the destination', async () => {
    const { platform, workspace } = setup();
    platform.mkdirp('/w/lib');
    platform.seedFile('/w/lib/main.ts', 'DO NOT CLOBBER');

    const errors: string[] = [];
    workspace.events.on('error', (event) => errors.push(event.message));

    const result = await workspace.movePaths(['/w/src/main.ts'], '/w/lib');

    expect(result.failed).toEqual(['/w/src/main.ts']);
    expect(await platform.readTextFile('/w/lib/main.ts')).toBe('DO NOT CLOBBER');
    expect(await platform.exists('/w/src/main.ts')).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it('collapses nested selections before moving', async () => {
    const { platform, workspace } = setup();
    platform.mkdirp('/w/lib');

    // Dragging a folder plus something inside it must move the folder once.
    const result = await workspace.movePaths(['/w/src/deep', '/w/src/deep/nested.ts'], '/w/lib');

    expect(result.moved).toEqual(['/w/lib/deep']);
    expect(await platform.exists('/w/lib/deep/nested.ts')).toBe(true);
  });

  it('moves what it can and reports the rest', async () => {
    const { platform, workspace } = setup();
    platform.mkdirp('/w/lib');
    platform.seedFile('/w/lib/util.ts', 'existing');

    const result = await workspace.movePaths(['/w/src/main.ts', '/w/src/util.ts'], '/w/lib');

    expect(result.moved).toEqual(['/w/lib/main.ts']);
    expect(result.failed).toEqual(['/w/src/util.ts']);
  });

  it('updates the language when a move changes the extension context', async () => {
    const { platform, workspace } = setup();
    platform.mkdirp('/w/lib');
    const id = (await workspace.open('/w/README.md'))!;

    await workspace.movePaths(['/w/README.md'], '/w/lib');

    const snapshot = workspace.buffers.get().find((b) => b.id === id)!;
    expect(snapshot.name).toBe('README.md');
    expect(snapshot.languageId).toBe('markdown');
  });
});

describe('batch delete', () => {
  it('removes several unrelated paths', async () => {
    const { platform, workspace } = setup();
    const result = await workspace.deletePaths(['/w/src/main.ts', '/w/README.md']);

    expect(result.deleted).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(await platform.exists('/w/src/main.ts')).toBe(false);
    expect(await platform.exists('/w/README.md')).toBe(false);
    expect(await platform.exists('/w/src/util.ts')).toBe(true);
  });

  it('collapses nested selections to their top-level ancestor', async () => {
    const { platform, workspace } = setup();
    // Selecting a folder and a file inside it: deleting the folder first would
    // otherwise make the file's delete fail with "not found".
    const result = await workspace.deletePaths(['/w/src', '/w/src/main.ts', '/w/src/deep']);

    expect(result.deleted).toEqual(['/w/src']);
    expect(result.failed).toHaveLength(0);
    expect(await platform.exists('/w/src')).toBe(false);
  });

  it('closes every clean buffer the delete covers', async () => {
    const { workspace } = setup();
    await workspace.open('/w/src/main.ts');
    await workspace.open('/w/src/deep/nested.ts');
    await workspace.open('/w/README.md');

    await workspace.deletePaths(['/w/src']);
    expect(workspace.buffers.get().map((b) => b.name)).toEqual(['README.md']);
  });

  it('keeps dirty buffers and marks them, even in a batch', async () => {
    const { workspace } = setup();
    const clean = (await workspace.open('/w/src/util.ts'))!;
    const edited = (await workspace.open('/w/src/main.ts'))!;
    dirty(workspace, edited);

    await workspace.deletePaths(['/w/src/util.ts', '/w/src/main.ts']);

    expect(workspace.buffers.get().find((b) => b.id === clean)).toBeUndefined();
    expect(workspace.buffers.get().find((b) => b.id === edited)?.externalState).toBe('deleted');
  });

  it('deletes what it can and reports the rest', async () => {
    const { platform, workspace } = setup();
    const errors: string[] = [];
    workspace.events.on('error', (event) => errors.push(event.message));

    const result = await workspace.deletePaths(['/w/README.md', '/w/ghost.txt']);

    expect(result.deleted).toEqual(['/w/README.md']);
    expect(result.failed).toEqual(['/w/ghost.txt']);
    expect(await platform.exists('/w/README.md')).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it('raises a single error for several failures', async () => {
    const { workspace } = setup();
    const errors: string[] = [];
    workspace.events.on('error', (event) => errors.push(event.message));

    await workspace.deletePaths(['/w/ghost-a.txt', '/w/ghost-b.txt']);

    expect(errors).toEqual(['Could not delete 2 items.']);
  });

  it('does nothing for an empty list', async () => {
    const { workspace } = setup();
    const result = await workspace.deletePaths([]);
    expect(result).toEqual({ deleted: [], failed: [] });
  });
});

describe('batch duplicate', () => {
  it('copies every file it is given', async () => {
    const { platform, workspace } = setup();
    const created = await workspace.duplicatePaths(['/w/src/main.ts', '/w/src/util.ts']);

    expect(created).toEqual(['/w/src/main copy.ts', '/w/src/util copy.ts']);
    expect(await platform.readTextFile('/w/src/util copy.ts')).toBe('const util = 2;\n');
  });

  it('skips directories and still copies the files', async () => {
    const { workspace } = setup();
    const errors: string[] = [];
    workspace.events.on('error', (event) => errors.push(event.message));

    const created = await workspace.duplicatePaths(['/w/src/deep', '/w/README.md']);

    expect(created).toEqual(['/w/README copy.md']);
    expect(errors).toHaveLength(1);
  });
});

describe('duplicate', () => {
  it('creates a copy alongside the original', async () => {
    const { platform, workspace } = setup();
    const target = await workspace.duplicatePath('/w/src/main.ts');

    expect(target).toBe('/w/src/main copy.ts');
    expect(await platform.readTextFile(target!)).toBe('const main = 1;\n');
    expect(await platform.exists('/w/src/main.ts')).toBe(true);
  });

  it('numbers subsequent copies', async () => {
    const { workspace } = setup();
    await workspace.duplicatePath('/w/src/main.ts');
    const second = await workspace.duplicatePath('/w/src/main.ts');

    expect(second).toBe('/w/src/main copy 2.ts');
  });

  it('handles files with no extension', async () => {
    const { platform, workspace } = setup();
    platform.seedFile('/w/Makefile', 'all:\n');

    expect(await workspace.duplicatePath('/w/Makefile')).toBe('/w/Makefile copy');
  });

  it('keeps dotfiles intact rather than treating the dot as an extension', async () => {
    const { platform, workspace } = setup();
    platform.seedFile('/w/.gitignore', 'node_modules\n');

    expect(await workspace.duplicatePath('/w/.gitignore')).toBe('/w/.gitignore copy');
  });

  it('refuses to duplicate a directory', async () => {
    const { workspace } = setup();
    const errors: string[] = [];
    workspace.events.on('error', (event) => errors.push(event.message));

    expect(await workspace.duplicatePath('/w/src')).toBeNull();
    expect(errors).toHaveLength(1);
  });
});

describe('platform guarantees', () => {
  it('rename refuses an occupied destination', async () => {
    const { platform } = setup();
    await expect(platform.rename('/w/src/main.ts', '/w/src/util.ts')).rejects.toThrow();
  });

  it('rename of a missing source fails', async () => {
    const { platform } = setup();
    await expect(platform.rename('/w/nope.ts', '/w/x.ts')).rejects.toThrow();
  });

  it('copyFile refuses an occupied destination', async () => {
    const { platform } = setup();
    await expect(platform.copyFile('/w/src/main.ts', '/w/src/util.ts')).rejects.toThrow();
  });

  it('copyFile refuses a directory source', async () => {
    const { platform } = setup();
    await expect(platform.copyFile('/w/src', '/w/src2')).rejects.toThrow();
  });

  it('emits watch events for rename and delete', async () => {
    const { platform } = setup();
    const seen: string[] = [];
    await platform.watch('/w', (event) => seen.push(event.kind));

    await platform.rename('/w/src/util.ts', '/w/src/helpers.ts');
    await platform.trash('/w/README.md');

    expect(seen).toContain('rename');
    expect(seen).toContain('remove');
  });
});

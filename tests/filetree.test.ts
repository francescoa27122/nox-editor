import { describe, expect, it, vi } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
import type { DirEntry } from '../src/platform/types';
import { FileTreeService } from '../src/services/filetree';

function setup() {
  const platform = new MemoryPlatform();
  platform.seedFile('/w/README.md', '#');
  platform.seedFile('/w/src/main.ts', '');
  platform.seedFile('/w/src/deep/nested.ts', '');
  platform.seedFile('/w/node_modules/pkg/index.js', '');
  platform.mkdirp('/w/empty');

  const tree = new FileTreeService(platform);
  return { platform, tree };
}

describe('FileTreeService', () => {
  it('lists the root, directories first', async () => {
    const { tree } = setup();
    await tree.setRoot('/w');

    expect(tree.nodes.get().map((n) => n.name)).toEqual([
      'empty',
      'node_modules',
      'src',
      'README.md',
    ]);
  });

  it('expands lazily and flattens with depth', async () => {
    const { tree } = setup();
    await tree.setRoot('/w');
    await tree.toggle('/w/src');

    const names = tree.nodes.get().map((n) => `${n.depth}:${n.name}`);
    expect(names).toContain('1:main.ts');
    expect(names).toContain('1:deep');
    // A collapsed grandchild must not appear.
    expect(names.some((n) => n.endsWith('nested.ts'))).toBe(false);
  });

  it('collapses on a second toggle', async () => {
    const { tree } = setup();
    await tree.setRoot('/w');
    await tree.toggle('/w/src');
    await tree.toggle('/w/src');

    expect(tree.nodes.get().some((n) => n.name === 'main.ts')).toBe(false);
  });

  it('applies excludes to the tree and the index', async () => {
    const { tree } = setup();
    tree.setExcludes('node_modules, .git');
    await tree.setRoot('/w');
    await tree.buildIndex();

    expect(tree.nodes.get().some((n) => n.name === 'node_modules')).toBe(false);
    expect(tree.fileIndex.get().some((p) => p.includes('node_modules'))).toBe(false);
  });

  /**
   * The bound that keeps quick-open inside a frame, and until now nothing
   * asserted the walk stopped at all.
   *
   * It is not about memory — the index is a list of strings. It is about what
   * `CommandPalette.fileRows` has to score between a keystroke and the next
   * frame, which is linear in this number. `filetree.ts` carries the
   * measurement behind the value; this only pins that the walk honours it,
   * which is the half a refactor can quietly break while every other index
   * test still passes.
   */
  it('stops walking at the file cap', async () => {
    const platform = new MemoryPlatform();
    // Comfortably past the cap, and spread over directories so the breadth-first
    // walk has to stop mid-tree rather than at a convenient boundary.
    for (let dir = 0; dir < 40; dir++) {
      for (let file = 0; file < 500; file++) {
        platform.seedFile(`/w/d${dir}/f${file}.ts`, '');
      }
    }

    const tree = new FileTreeService(platform);
    await tree.setRoot('/w');
    await tree.buildIndex();

    const indexed = tree.fileIndex.get();
    expect(indexed.length).toBeLessThanOrEqual(14_000);
    // And it really did stop rather than fail: a cap that returned nothing
    // would also satisfy the line above.
    expect(indexed.length).toBeGreaterThan(13_000);
  });

  it('indexes files recursively', async () => {
    const { tree } = setup();
    await tree.setRoot('/w');
    await tree.buildIndex();

    expect(tree.fileIndex.get()).toContain('/w/src/deep/nested.ts');
    expect(tree.fileIndex.get()).toContain('/w/README.md');
  });

  it('reveals a nested file by expanding its ancestors', async () => {
    const { tree } = setup();
    await tree.setRoot('/w');
    await tree.reveal('/w/src/deep/nested.ts');

    expect(tree.isExpanded('/w/src')).toBe(true);
    expect(tree.isExpanded('/w/src/deep')).toBe(true);
    expect(tree.nodes.get().some((n) => n.name === 'nested.ts')).toBe(true);
  });

  it('marks an expanded empty directory', async () => {
    const { tree } = setup();
    await tree.setRoot('/w');
    await tree.toggle('/w/empty');

    expect(tree.nodes.get().find((n) => n.name === 'empty')?.empty).toBe(true);
  });

  it('collapses everything but the root', async () => {
    const { tree } = setup();
    await tree.setRoot('/w');
    await tree.toggle('/w/src');
    tree.collapseAll();

    expect(tree.isExpanded('/w/src')).toBe(false);
    expect(tree.nodes.get().map((n) => n.depth).every((d) => d === 0)).toBe(true);
  });

  it('clears when the root is closed', async () => {
    const { tree } = setup();
    await tree.setRoot('/w');
    await tree.setRoot(null);

    expect(tree.nodes.get()).toEqual([]);
    expect(tree.fileIndex.get()).toEqual([]);
  });

  it('survives an unreadable directory', async () => {
    const { platform, tree } = setup();
    // A file where a directory is expected: readDir will reject.
    await tree.setRoot('/w');
    await expect(platform.readDir('/w/README.md')).rejects.toThrow();
    await tree.toggle('/w/README.md');

    expect(tree.nodes.get().length).toBeGreaterThan(0);
  });
});

/**
 * A disk on which one directory refuses to be read.
 *
 * `MemoryPlatform` only rejects for "not found" and "not a directory", so a
 * permission denial — the case the explorer actually has to survive on a real
 * machine — has to be arranged. Everything else is the real implementation.
 */
class DeniedPlatform extends MemoryPlatform {
  denied = '';

  override async readDir(path: string): Promise<DirEntry[]> {
    if (path === this.denied) throw new Error('EACCES: permission denied');
    return super.readDir(path);
  }
}

/**
 * Guards the bug these tests were written for: `#load` had recorded the read
 * failure since the tree was written, but `FlatNode` had nowhere to put it and
 * `#flatten` never looked — and because the catch stores `entries: []`, an
 * unreadable directory expanded into exactly the same silent nothing as an
 * empty one. Which of the two it is, is the only thing the user needs.
 */
describe('FileTreeService and directories it cannot read', () => {
  function denied(path: string) {
    const platform = new DeniedPlatform();
    platform.seedFile('/w/README.md', '#');
    platform.seedFile('/w/secret/inside.ts', '');
    platform.mkdirp('/w/empty');
    platform.denied = path;
    return { platform, tree: new FileTreeService(platform) };
  }

  it('says why a directory is empty when it is not empty but unreadable', async () => {
    const { tree } = denied('/w/secret');
    await tree.setRoot('/w');
    await tree.toggle('/w/secret');

    const node = tree.nodes.get().find((n) => n.name === 'secret');
    expect(node?.error).toContain('permission denied');
  });

  it('leaves a genuinely empty directory distinguishable from that', async () => {
    const { tree } = denied('/w/secret');
    await tree.setRoot('/w');
    await tree.toggle('/w/empty');

    const node = tree.nodes.get().find((n) => n.name === 'empty');
    expect(node?.empty).toBe(true);
    expect(node?.error).toBeNull();
  });

  it('carries no error on a directory that read fine', async () => {
    const { tree } = denied('/w/nothing-is-denied');
    await tree.setRoot('/w');
    await tree.toggle('/w/secret');

    expect(tree.nodes.get().every((n) => n.error === null)).toBe(true);
  });

  it('reports an unreadable root separately — it has no row to hang it on', async () => {
    const { tree } = denied('/w');
    await tree.setRoot('/w');

    expect(tree.nodes.get()).toEqual([]);
    expect(tree.rootError.get()).toContain('permission denied');
  });

  it('clears the root error when the folder is closed', async () => {
    const { tree } = denied('/w');
    await tree.setRoot('/w');
    await tree.setRoot(null);

    expect(tree.rootError.get()).toBeNull();
  });
});

/** Counts `readDir` per directory, so a test can see how many walks ran. */
class CountingPlatform extends MemoryPlatform {
  readonly reads = new Map<string, number>();

  override async readDir(path: string): Promise<DirEntry[]> {
    this.reads.set(path, (this.reads.get(path) ?? 0) + 1);
    return super.readDir(path);
  }
}

describe('overlapping walks', () => {
  /**
   * The failure this prevents: two `setRoot` calls for the same root each
   * running a full index walk. The only abort check was a root *change*,
   * which two walks of one root both pass, so boot's duplicate call doubled
   * every launch's directory reads. Of two overlapping walks only the newest
   * may run to the end.
   */
  it('lets only the newest of two overlapping setRoot calls walk the tree', async () => {
    const platform = new CountingPlatform();
    platform.seedFile('/w/src/main.ts', '');
    platform.seedFile('/w/src/deep/nested.ts', '');
    const tree = new FileTreeService(platform);

    await Promise.all([tree.setRoot('/w'), tree.setRoot('/w')]);
    await vi.waitFor(() => expect(tree.fileIndex.get()).toContain('/w/src/deep/nested.ts'));

    expect(platform.reads.get('/w/src')).toBe(1);
    expect(platform.reads.get('/w/src/deep')).toBe(1);
  });
});

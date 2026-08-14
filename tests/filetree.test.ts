import { describe, expect, it } from 'vitest';
import { MemoryPlatform } from '../src/platform/memory';
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

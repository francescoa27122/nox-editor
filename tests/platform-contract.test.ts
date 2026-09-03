import { describe, expect, it } from 'vitest';
import { join } from '../src/core/path';
import { MemoryPlatform } from '../src/platform/memory';
import type { Platform } from '../src/platform/types';

/**
 * The behaviour every `Platform` implementation must share.
 *
 * `MemoryPlatform` and `TauriPlatform` each implement the 72-method interface
 * by hand, and TypeScript holds the two to the same *shape*. Nothing held
 * them to the same *behaviour*: an error code, a listing order, an
 * overwrite refusal could differ and only a Rust test quoting the fake would
 * notice. That is how the browser search came to walk `node_modules` while
 * the desktop one skipped it (Known debt).
 *
 * This suite is written against a factory rather than a platform, so the
 * desktop implementation can be plugged in from the e2e job later: hand it a
 * `TauriPlatform` and a scratch directory it may write into. Every case uses
 * only the interface, and only paths under `scratch`.
 *
 * What it does not catch: anything only one platform can do (git, processes,
 * watching), and the desktop platform itself until that job exists. The
 * cases are the observable file contract `platform/types.ts` documents.
 */
interface Fixture {
  platform: Platform;
  /** A directory the suite may create, rename and trash things under. */
  scratch: string;
}

export function describePlatformContract(name: string, fixture: () => Promise<Fixture>): void {
  describe(`Platform contract: ${name}`, () => {
    it('reads back what it wrote', async () => {
      const { platform, scratch } = await fixture();
      const path = join(scratch, 'note.txt');

      await platform.writeTextFile(path, 'first');
      await platform.writeTextFile(path, 'second');

      expect(await platform.readTextFile(path)).toBe('second');
      expect(await platform.exists(path)).toBe(true);
    });

    it('rename carries the content and leaves nothing behind', async () => {
      const { platform, scratch } = await fixture();
      const from = join(scratch, 'a.txt');
      const to = join(scratch, 'b.txt');
      await platform.writeTextFile(from, 'moved');

      await platform.rename(from, to);

      expect(await platform.readTextFile(to)).toBe('moved');
      expect(await platform.exists(from)).toBe(false);
    });

    // `types.ts`: "Must fail rather than overwrite an existing destination".
    it('rename refuses to overwrite, and the destination is untouched', async () => {
      const { platform, scratch } = await fixture();
      const from = join(scratch, 'a.txt');
      const to = join(scratch, 'b.txt');
      await platform.writeTextFile(from, 'source');
      await platform.writeTextFile(to, 'target');

      await expect(platform.rename(from, to)).rejects.toBeInstanceOf(Error);

      expect(await platform.readTextFile(to)).toBe('target');
      expect(await platform.readTextFile(from)).toBe('source');
    });

    // `not-found` is one of the six codes `platform/tauri.ts` maps from Rust
    // and the one the explorer and the watcher branch on.
    it('stat on a missing path rejects with not-found', async () => {
      const { platform, scratch } = await fixture();

      await expect(platform.stat(join(scratch, 'missing.txt'))).rejects.toMatchObject({
        code: 'not-found',
      });
    });

    // `types.ts`: "Must fail if something already exists at `path`".
    it('createFile refuses an existing path and keeps its content', async () => {
      const { platform, scratch } = await fixture();
      const path = join(scratch, 'keep.txt');
      await platform.writeTextFile(path, 'keep me');

      await expect(platform.createFile(path)).rejects.toBeInstanceOf(Error);

      expect(await platform.readTextFile(path)).toBe('keep me');
    });

    it('trash removes the file', async () => {
      const { platform, scratch } = await fixture();
      const path = join(scratch, 'gone.txt');
      await platform.writeTextFile(path, 'x');

      await platform.trash(path);

      expect(await platform.exists(path)).toBe(false);
      await expect(platform.stat(path)).rejects.toMatchObject({ code: 'not-found' });
    });

    // `types.ts`: "Directory children, already sorted: directories first,
    // then by name."
    it('readDir lists directories first, then by name', async () => {
      const { platform, scratch } = await fixture();
      await platform.writeTextFile(join(scratch, 'b.txt'), '');
      await platform.writeTextFile(join(scratch, 'a.txt'), '');
      await platform.createDir(join(scratch, 'z-dir'));
      await platform.createDir(join(scratch, 'y-dir'));

      const names = (await platform.readDir(scratch)).map((entry) => entry.name);

      expect(names).toEqual(['y-dir', 'z-dir', 'a.txt', 'b.txt']);
    });

    // `types.ts`: "Copy a single file. Must fail if the destination exists."
    it('copyFile duplicates content and refuses an existing destination', async () => {
      const { platform, scratch } = await fixture();
      const from = join(scratch, 'orig.txt');
      const to = join(scratch, 'copy.txt');
      await platform.writeTextFile(from, 'dup');

      await platform.copyFile(from, to);
      expect(await platform.readTextFile(to)).toBe('dup');
      expect(await platform.readTextFile(from)).toBe('dup');

      await expect(platform.copyFile(from, to)).rejects.toBeInstanceOf(Error);
    });
  });
}

describePlatformContract('MemoryPlatform', async () => {
  const platform = new MemoryPlatform();
  platform.mkdirp('/scratch');
  return { platform, scratch: '/scratch' };
});

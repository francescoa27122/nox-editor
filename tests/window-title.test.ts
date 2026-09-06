import { describe, expect, it, vi } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';

/**
 * A4-009: `#updateWindowTitle` runs on every `workspace.buffers` publish,
 * which is every keystroke (`applyTransaction` calls `#sync` on every
 * `docChanged`), but the title text itself moves on far rarer events: the
 * dirty marker, the active file, or the root. Before this fix every publish
 * reached `platform.setWindowTitle` regardless — on the desktop build, an
 * IPC round trip and a native `SetWindowText` per character typed.
 */
describe('the window title', () => {
  it('is not re-sent to the platform when the text has not changed', async () => {
    const platform = new MemoryPlatform();
    platform.mkdirp('/w');
    platform.seedFile('/w/a.ts', 'const a = 1;\n');
    const app = new NoxApp(platform);
    await app.workspace.openFolder('/w');
    const id = (await app.workspace.open('/w/a.ts'))!;

    const setWindowTitle = vi.spyOn(platform, 'setWindowTitle');
    setWindowTitle.mockClear();

    // Two edits, each a `docChanged` transaction and so each a
    // `workspace.buffers` republish. Only the first moves the title text
    // (clean to dirty); the second leaves the buffer dirty and the same
    // file active, so the string `#updateWindowTitle` builds is identical.
    const first = app.workspace.stateOf(id)!;
    app.workspace.applyTransaction(id, first.update({ changes: { from: 0, insert: 'x' } }));
    const second = app.workspace.stateOf(id)!;
    app.workspace.applyTransaction(id, second.update({ changes: { from: 0, insert: 'y' } }));

    expect(setWindowTitle).toHaveBeenCalledTimes(1);
  });

  it('is re-sent once when the active file changes', async () => {
    const platform = new MemoryPlatform();
    platform.mkdirp('/w');
    platform.seedFile('/w/a.ts', 'a\n');
    platform.seedFile('/w/b.md', 'b\n');
    const app = new NoxApp(platform);
    await app.workspace.openFolder('/w');
    await app.workspace.open('/w/a.ts');

    const setWindowTitle = vi.spyOn(platform, 'setWindowTitle');
    setWindowTitle.mockClear();

    await app.workspace.open('/w/b.md');

    expect(setWindowTitle).toHaveBeenCalledTimes(1);
    expect(setWindowTitle).toHaveBeenCalledWith(expect.stringContaining('b.md'));
  });
});

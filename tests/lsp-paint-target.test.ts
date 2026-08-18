// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import EditorPane from '../src/ui/EditorPane.svelte';
import { pathToUri } from '../src/core/uri';
import type { LspDiagnostic } from '../src/services/lsp';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * Diagnostics land on the buffer they describe, and on no other.
 *
 * **This does not reproduce the bug it was written for**, and that is worth
 * saying plainly rather than leaving someone to assume otherwise. Restoring
 * the original racy paint in `app.ts` leaves both tests below passing: the
 * harness drives effects through `flushSync`, so the window the bug lived in
 * — `activeId` updated, pane effect not yet run — does not exist here. What
 * these tests do check is the invariant the fix establishes: the view shows
 * the diagnostics of the buffer it holds, and none for a buffer that has
 * none. That is worth having; it is not proof against a regression of the
 * race, and only a real build is.
 *
 * The bug: the squiggle for `x.ts` appeared inside `servers.json` in a real
 * desktop build.
 *
 * The mechanism is worth stating, because nothing about it is obvious from
 * either file involved. `EditorPane` holds ONE CodeMirror view and re-points
 * it at a different `EditorState` per tab, and its `dispatchTransactions`
 * routes every transaction to `workspace.applyTransaction(currentId, ...)` —
 * where `currentId` is the pane's own record of what it is showing. The app
 * used to paint diagnostics from a `workspace.activeId` subscription, which
 * fires *synchronously*, while the pane swaps state in an `$effect`, which
 * runs *later*. In that window the app looked up the newly-active buffer's
 * diagnostics and dispatched them while the old buffer's state was still
 * loaded, so they were recorded against the old buffer — permanently.
 */

const ERROR: LspDiagnostic = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
  severity: 1,
  message: 'Type error in the TypeScript file',
};

/** Count the lint marks CodeMirror is currently rendering. */
function squiggles(container: HTMLElement): number {
  return container.querySelectorAll('.cm-lintRange, .cm-lint-marker-error').length;
}

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe('which buffer a diagnostic is painted on', () => {
  it('paints the TypeScript file, not the JSON file that was open before it', async () => {
    mounted = mountComponent(EditorPane, { props: { groupId: 'group-1' } });
    const { app, platform, container } = mounted;

    platform.seedFile('/w/servers.json', '{ "servers": [] }\n');
    platform.seedFile('/w/x.ts', 'const answer: number = "no";\n');
    await app.workspace.openFolder('/w');

    const jsonId = (await app.workspace.open('/w/servers.json'))!;
    const tsId = (await app.workspace.open('/w/x.ts'))!;
    flush();

    // Sit on the JSON file, so it is the state the view is holding.
    app.workspace.setActive(jsonId);
    flush();

    // The server reports on the TypeScript file only. Nothing is drawn yet:
    // the view is showing the JSON, which has no diagnostics of its own.
    app.lsp.diagnostics.set(new Map([[pathToUri('/w/x.ts'), [ERROR]]]));
    flush();
    expect(squiggles(container)).toBe(0);

    // Now switch TO the TypeScript file — and deliberately do not flush.
    // This is the window the bug lived in: `activeId` has changed, so any
    // synchronous subscriber sees x.ts, while the pane still holds the JSON's
    // state because its effect has not run. A paint here is recorded against
    // the JSON buffer and stays there.
    app.workspace.setActive(tsId);
    flush();

    expect(app.workspace.activeId.get()).toBe(tsId);
    expect(squiggles(container)).toBeGreaterThan(0);

    // Back to the JSON. It never had a diagnostic, so it must show none.
    app.workspace.setActive(jsonId);
    flush();

    expect(squiggles(container)).toBe(0);
  });

  it('leaves nothing behind when a file with diagnostics is switched away from', async () => {
    mounted = mountComponent(EditorPane, { props: { groupId: 'group-1' } });
    const { app, platform, container } = mounted;

    platform.seedFile('/w/a.ts', 'const a: number = "no";\n');
    platform.seedFile('/w/notes.md', '# notes\n');
    await app.workspace.openFolder('/w');

    const aId = (await app.workspace.open('/w/a.ts'))!;
    const notesId = (await app.workspace.open('/w/notes.md'))!;
    flush();

    app.lsp.diagnostics.set(new Map([[pathToUri('/w/a.ts'), [ERROR]]]));
    flush();

    app.workspace.setActive(aId);
    flush();
    expect(squiggles(container)).toBeGreaterThan(0);

    app.workspace.setActive(notesId);
    flush();
    expect(squiggles(container)).toBe(0);
  });
});

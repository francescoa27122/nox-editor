// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import EditorPane from '../src/ui/EditorPane.svelte';
import { flush, mountComponent, type Mounted } from './support/component';

/**
 * Whose cursor a pane hands to the session.
 *
 * The workspace half of this is in `tests/pane-fidelity.test.ts`, driven
 * against a fake channel. This is the other half, and it needs the real
 * component: `readSelection` takes a buffer id, but a callback that ignores a
 * parameter still satisfies the type, so nothing but a mounted `EditorPane`
 * can show that it actually consults the id.
 *
 * The bug: a view's live selection is its **active** tab's, and the pane
 * answered with it whatever it was asked about. So every background tab in
 * every pane was written to `session.json` with the foreground tab's cursor —
 * read `a.ts` at line 400, switch to `b.ts` and type at line 3, quit, and
 * `a.ts` comes back at line 3.
 */

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe('the cursor a mounted pane reports', () => {
  it('declines for a tab it is not showing, so that tab keeps its own', async () => {
    mounted = mountComponent(EditorPane, { props: { groupId: 'group-1' } });
    const { app, platform } = mounted;

    platform.seedFile('/w/long.ts', 'one\ntwo\nthree\nfour\nfive\n');
    platform.seedFile('/w/short.ts', 'alpha\n');
    await app.workspace.openFolder('/w');

    const background = (await app.workspace.open('/w/long.ts'))!;
    const foreground = (await app.workspace.open('/w/short.ts'))!;
    flush();

    const groupId = app.workspace.groups.get()[0]!.id;

    // Where the user was in the tab they are no longer looking at.
    app.workspace.setSelection(background, { ranges: [[14, 14]], main: 0 });
    // And where they are now. `short.ts` is six characters long, so this
    // offset exists in it and says nothing about `long.ts`.
    app.workspace.setActive(foreground);
    flush();
    app.workspace.setSelection(foreground, { ranges: [[2, 2]], main: 0 });
    flush();

    // The question the session asks at save time, once per tab in this pane.
    expect(app.workspace.selectionOf(foreground, groupId)?.ranges).toEqual([[2, 2]]);
    expect(app.workspace.selectionOf(background, groupId)?.ranges).toEqual([[14, 14]]);
  });
});

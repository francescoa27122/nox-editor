import { describe, expect, it } from 'vitest';
import { NoxApp } from '../src/app';
import { MemoryPlatform } from '../src/platform/memory';

/**
 * Every command that can do something a permission would gate declares it.
 *
 * **The bug this exists for.** `commands.ts:200` gates on
 * `command.capabilities?.length`, two lines under a comment promising "no
 * second path to forget about", so a command that declares nothing is never
 * guarded for any principal. On 2026-08-30 a security review found six that
 * should have: `plugins.reload` and `lsp.reload` start processes,
 * `terminal.toggle` and `terminal.restart` start a shell, and `notes.new` and
 * `notes.rename` write files. Reading the whole table to fix them turned up
 * six more of the same kind: `terminal.focus` (which *opens* the panel before
 * it focuses it, so it starts a shell too), `notes.delete`,
 * `notes.newFromSelection`, `prefs.reset`, `search.undoReplace`, and
 * `agents.undoLastSession`.
 *
 * `view.reloadWindow` was the sharp one. `PermissionService.decisions` and
 * `.grants` live in memory and nowhere else, so a plugin could dispatch it and
 * erase the entire audit trail `AGENT-PLATFORM.md` presents as the record of
 * what it was allowed to do, leaving no entry for the erasure either. It
 * declares `permissions.revoke` now, which policy denies outright.
 *
 * **Why the list below, and also a rule.** There is no way to ask a `run`
 * function whether it reaches the OS. What is checkable is the *set*: this
 * pins every command that declares nothing, so a new one joins it only by a
 * hand edit that a reviewer sees, under a heading saying what the list means.
 * The same shape as `classifyConfigChange`'s pinned omissions, and for the
 * same reason: the failure mode is not a wrong declaration, it is a missing
 * one that nobody looked for.
 *
 * This paragraph used to argue the list *instead of* a rule, and the audit
 * that followed showed why that was half an answer: the list fixed the twelve
 * instances and left the class open, and the audit's own feature work then
 * added four more undeclared commands that end or hide the window. Since
 * 2026-09-03 the dispatcher also refuses an undeclared command to any non-user
 * principal (A7-001, `tests/agent-undeclared-commands.test.ts`). They are not
 * alternatives: the rule makes a forgotten declaration fail closed, and the
 * list keeps the set it fails on visible.
 *
 * Mutation-checked on 2026-08-31 by removing `capabilities` from
 * `view.reloadWindow`: the set assertion names it.
 */

/**
 * Commands that declare nothing, grouped by why they need nothing.
 *
 * The bar is `Capability`'s own vocabulary: reaching a file, a process, the
 * network, an open buffer's text, the workspace root, or the permission
 * ledger. Moving focus, opening an overlay, changing a selection and folding
 * code reach none of those.
 *
 * **What the list means changed on 2026-09-03.** It used to read "these are
 * ungated": a plugin or an agent ran every id below with no check and no
 * decision-log entry. It now reads "these are refused to a plugin or an
 * agent", because the dispatcher declines a command that declares nothing for
 * any non-user principal. Nothing about the *user* changed: a person still
 * runs all of them, and is still not logged doing it. Each group's reasoning
 * is still about why the command needs no capability, which is still the
 * question the list answers; two of them also argued for reachability, and
 * those say what became of that argument.
 */
const NEEDS_NOTHING: Record<string, readonly string[]> = {
  /** Close a tab or the folder. Unsaved work is in the session either way. */
  'closing what is open': [
    'file.close',
    'file.closeAll',
    'file.closeFolder',
    'file.closeOthers',
    'file.closeSaved',
    'file.closeToRight',
    'view.closeGroup',
  ],

  /**
   * Stopping is not starting, and none of these reaches a file, a process it
   * did not already own, or the ledger, so none of them needs a capability.
   *
   * That used to carry a second claim: gating a stop would mean a principal
   * that may not run a thing may not stop one either, which is the wrong way
   * round. The dispatcher rule refuses these to a non-user principal anyway,
   * so the claim no longer describes what happens. It was never the strong
   * half: `agents.cancel` and `jobs.cancel` stop *another* session's or the
   * user's work, which the audit listed among the things an agent should not
   * be able to do unasked. If an agent needs to stop its own session, the
   * answer is a scoped way to do that, not a command anyone may reach.
   */
  'stopping something already running': ['agents.cancel', 'jobs.cancel', 'tasks.stop'],

  /**
   * Reading the selection out to the clipboard. `edit.cut` and `edit.paste`
   * are not here: both write the buffer and declare `buffer.edit`. Copy takes
   * nothing and changes nothing, and there is no clipboard capability to
   * declare, which is worth knowing rather than reading as an omission.
   */
  'copying the selection': ['edit.copy'],

  /**
   * Ending the session. Filed here rather than declared because the
   * vocabulary has no capability for the app's own lifecycle: the nearest,
   * `shell.exec`, would be a lie about what this does. Unsaved work survives
   * in the session exactly as it does for the closing group above, so the
   * cost of an unwanted quit is interruption rather than loss. **A capability
   * for lifecycle is a real gap**, and this row is the place it shows.
   */
  'ending the session': ['app.quit'],

  /**
   * The window's own chrome. Minimise, maximise and close move or hide a
   * window; none of them reaches the file system, a process or the network,
   * so none has a capability to declare. `window.close` ends the session like
   * `app.quit` does, and the same reasoning applies: unsaved work is in the
   * session.
   *
   * The sentence that used to close this comment, that the OS offers all three
   * next to them so gating them gates nothing a user cannot already do with
   * the title bar, was about the *user*, and it stays true of the user. It was
   * never true of an agent, which has no title bar, and these four commands
   * landed after the twelve declarations did: they are the clearest case for
   * the dispatcher rule refusing them rather than the list catching them.
   */
  'moving the window': ['window.close', 'window.minimize', 'window.toggleMaximize'],

  /** Move focus, open an overlay, show a panel. */
  'showing something': [
    'agents.show',
    'answers.focus',
    'app.about',
    'app.showWelcome',
    'file.openRecent',
    'explorer.collapseAll',
    'explorer.selectAll',
    'git.focus',
    'git.showDiff',
    'git.toggleBlame',
    'menubar.focus',
    'nav.commandPalette',
    'nav.documentEnd',
    'nav.documentStart',
    'nav.focusEditor',
    'nav.focusExplorer',
    'nav.goToLine',
    'nav.goToSymbol',
    'nav.goToTab',
    'nav.nextTab',
    'nav.previousTab',
    'nav.quickOpen',
    'nav.switchBuffer',
    'notes.focus',
    'notes.open',
    'prefs.keybindings',
    'prefs.open',
    'view.toggleFullscreen',
    'problems.focus',
    'references.focus',
    'review.show',
    'tasks.show',
    'view.dismiss',
  ],

  /** Rearrange panes over files that are already open. */
  'moving panes around': [
    'view.focusNextGroup',
    'view.focusPreviousGroup',
    'view.moveEditorToNextGroup',
    'view.moveEditorToPreviousGroup',
    'view.openCopyToSide',
    'view.splitEditor',
    'view.toggleSplitOrientation',
  ],

  /** Selection, folding and find. Nothing changes the document. */
  'reading the buffer that is open': [
    'edit.addCursorAbove',
    'edit.addCursorBelow',
    'edit.find',
    'edit.findNext',
    'edit.findPrevious',
    'edit.fold',
    'edit.foldAll',
    'edit.foldLevel1',
    'edit.foldLevel2',
    'edit.foldLevel3',
    'edit.foldLevel4',
    'edit.foldLevel5',
    'edit.selectAll',
    'edit.selectAllMatches',
    'edit.selectNextOccurrence',
    'edit.unfold',
    'edit.unfoldAll',
    'file.reopenWithEncoding',
    'lang.setLanguage',
    'lsp.findReferences',
    'lsp.goToDefinition',
    'provenance.clear',
    'provenance.nextChange',
    'provenance.previousChange',
  ],

  /** The search panel's own state. `search.replaceAll` is the one that writes. */
  'driving the search panel': [
    'explorer.refresh',
    'git.refreshGutter',
    'search.clear',
    'search.collapseAll',
    'search.dismissResult',
    'search.focus',
    'search.rerun',
    'search.toggleCase',
    'search.toggleGitIgnore',
    'search.togglePreserveCase',
    'search.toggleRegexp',
    'search.toggleWholeWord',
  ],

  /**
   * What is staged for review, which is in memory until `review.apply`, and
   * that one declares `buffer.edit`.
   */
  'deciding about a staged review': ['review.discard', 'review.keepAll', 'review.rejectAll'],

  /**
   * Re-read one of Nox's own config files. Nothing is written and no process
   * starts, which is what separates these from `plugins.reload` and
   * `lsp.reload`, which are next to them in the table and declare `shell.exec`.
   */
  're-reading Nox config': ['agents.reloadConfig', 'snippets.reload', 'themes.reload'],

  /**
   * Put something on the clipboard that the user is already looking at.
   * `file.revealInExplorer` reveals in **Nox's** explorer, not the OS file
   * manager, so it reaches nothing outside the window either.
   *
   * `agents.copyTrail` is here for the same reason `app.copyDiagnostics` is:
   * it copies out Nox's own record of what an agent already did, which the
   * Agents panel is displaying at the time. It reads no file and sends
   * nothing.
   */
  'copying what is already on screen': [
    'agents.copyTrail',
    'app.copyDiagnostics',
    'explorer.copyPath',
    'explorer.copyRelativePath',
    'file.revealInExplorer',
  ],

  /**
   * These write `settings.json` through `ConfigService.set`, and the Known
   * debt table carries a row for it. They are here rather than declaring
   * `fs.write` because every one of them sets a **literal** cosmetic key to
   * the other value, so what they can reach is eight known preferences and not
   * a path; describing that to a user as "wants to change files on disk" would
   * be accurate and wildly out of proportion. `prefs.reset` is not here: it
   * rewrites the whole file, which is what `fs.write` actually sounds like.
   * The honest fix is a `settings.write` capability, which is a change to the
   * vocabulary rather than to this table.
   */
  'changing one cosmetic preference': [
    'view.decreaseFontSize',
    'view.increaseFontSize',
    'view.resetFontSize',
    'view.toggleExplorer',
    'view.toggleIndentType',
    'view.toggleLineNumbers',
    'view.toggleRelativeLineNumbers',
    'view.toggleStatusBar',
    'view.toggleTheme',
    'view.toggleWordWrap',
  ],
};

/** Commands whose declaration is the point of the fix, named so a drop is loud. */
const MUST_DECLARE: Record<string, readonly string[]> = {
  'shell.exec': ['plugins.reload', 'lsp.reload', 'terminal.toggle', 'terminal.focus', 'terminal.restart'],
  'permissions.revoke': ['view.reloadWindow', 'agents.undoLastSession'],
  'fs.create': ['notes.new', 'notes.newFromSelection'],
  'fs.write': ['notes.rename', 'prefs.reset', 'search.undoReplace'],
  'fs.delete': ['notes.delete'],
  'buffer.edit': ['agents.undoLastSession', 'search.undoReplace'],
};

function commands() {
  return new NoxApp(new MemoryPlatform()).commands.all();
}

describe('a command with no capabilities', () => {
  it('is one of the ones written down here', () => {
    const bare = commands()
      .filter((command) => !command.capabilities?.length)
      .map((command) => command.id)
      .sort();

    const expected = Object.values(NEEDS_NOTHING).flat().sort();
    expect(bare).toEqual(expected);
  });

  /**
   * The list is only worth anything if every id in it is real. A typo would
   * quietly excuse a command that is still undeclared, by holding a place for
   * one that does not exist.
   */
  it('is named by an id that exists', () => {
    const registered = new Set(commands().map((command) => command.id));
    const unknown = Object.values(NEEDS_NOTHING)
      .flat()
      .filter((id) => !registered.has(id));
    expect(unknown).toEqual([]);
  });
});

describe('a command that reaches the OS', () => {
  it.each(Object.entries(MUST_DECLARE))('declares %s', (capability, ids) => {
    const all = commands();
    for (const id of ids) {
      const command = all.find((entry) => entry.id === id);
      expect(command, `${id} is not registered`).toBeDefined();
      expect(command?.capabilities ?? [], `${id} lost ${capability}`).toContain(capability);
    }
  });
});

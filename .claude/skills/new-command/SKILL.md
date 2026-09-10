---
name: new-command
description: Use when adding a new user action to Nox: a palette entry, a menu item, a default keybinding, a toolbar or panel button, or anything a plugin or agent should be able to invoke. Also when an existing action needs a capability, an enablement predicate, or a default chord.
---

# Adding a command

Every user action in Nox is a `Command`. The palette, the menu bar, the
keybinding editor and the permission model all read one registry, which is why
adding a command gets all four for free and why a feature without one is not
finished.

This skill is the procedure. `nox-architecture` owns the reasoning behind the
layers a command reaches into; go there when the question is *why*.

## The one array

Descriptors are registered in `#registerCommands` (`src/app.ts:2961`), in a
single array under banner comments that group it by category:
`const commands: Command[] = [` (`src/app.ts:2965-4774`). Add yours under the
banner it belongs to rather than at the end.

Shape: `{ id, title, category, keywords?, capabilities?, hidden?, enabled?, run }`.

A real entry, `id: 'git.showDiff'` (`src/app.ts:3852-3861`):

```ts
{
  id: 'git.showDiff',
  title: 'Show Changes',
  category: 'Git',
  keywords: ['diff', 'changes', 'compare', 'git'],
  // On the service, not the platform flag: the service only starts
  // where the capability holds, and tests start it over a memory
  // platform, the language-server pattern.
  enabled: () => this.git.started && Boolean(this.workspace.activeSnapshot()?.path),
  run: () => this.ui.showDiff(),
}
```

## The four things that are easy to get wrong

**`id` is `area.verbNoun`, and `register` refuses a duplicate.** It throws
rather than shadowing: `Duplicate command id:` (`src/services/commands.ts:126`).
`category` is what groups the palette, and the existing values are Language,
Review, Git, Editor, Edit, Agents and the rest of the banner comments.

**`enabled` gates on service state, not a platform capability flag.** Write
`() => this.git.started`, not `() => this.platform.capabilities.git`. The
service only starts where the capability holds, and jsdom tests construct it
over `MemoryPlatform`, where a capability gate reads false and the command
becomes untestable. This repo learned it twice, on the LSP commands and then on
`git.showDiff` itself. The exception is a capability with no service behind it,
which is three commands and no more.

**A side effect without `capabilities` is a hole.** The declaration is the
entire basis of permission enforcement, which happens in one place:
`this.commands.setGuard(` (`src/app.ts:274-283`). A command that edits a buffer
declares `capabilities: ['buffer.edit']`; one that writes a file declares
`fs.write`. The user principal skips the guard, so the hole only opens for a
plugin or an agent, which is exactly who it matters for.

**`run` stays thin.** Delegate to a service method: `() => this.ui.showDiff()`
is a whole body. Long work in the descriptor is work on the caller's thread.

## The default key, if it wants one

One line in the `bindAll` table, which is `this.keymap.bindAll({` (`src/app.ts:5191`), for example
`F12: 'lsp.goToDefinition'` (`src/app.ts:5284`). Nothing else to wire: the
palette reads the binding back, and the keybinding editor gives it a row
whether it is bound or not. Use `keyHint` on the descriptor instead when
CodeMirror owns the chord rather than `services/keymap.ts`.

## Verify

`npm test && npm run check && npm run lint`. `tests/command-titles.test.ts`
holds titles and ids to the house shape, so a malformed one fails there rather
than in review.

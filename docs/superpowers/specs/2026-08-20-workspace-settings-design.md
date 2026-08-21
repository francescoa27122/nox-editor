# Workspace settings — design

`.nox/settings.json` layered over the user's own. The second row of v0.6 and
a named 1.0 gate — the half of *"a keyboard-first editor lets you change the
keys"* that says a **project** can carry its own conventions.

Status: decided 2026-08-20. Every path, type and function named below was
read in the file it names before being written down.

## 0. The envelope

Read this before adding a key to the scope list.

- **A workspace file is untrusted input.** It arrives with a cloned
  repository, written by whoever wrote the repository. This is the single
  fact the whole design turns on: it is why the scope is an **allowlist on
  the schema**, opt-in per setting, and not "everything except a denylist".
  A denylist is wrong by default the moment a new setting is added.
- **The name that makes it concrete: `terminal.shell`.** A workspace file
  that could set it would run a binary of the repository author's choosing
  the first time you opened a terminal in a project you had merely cloned.
  It is not in the list, and nothing that names a program, a path or a
  network address ever will be.
- **The test for a new key is "project or person?"** — a fact about the code
  in this repository (its indentation, what it excludes, whether it is
  formatted on save), not a fact about the person reading it (their theme,
  their font, their save habits, their window). When in doubt it is a
  person's, and it stays out.
- **A workspace cannot make Nox worse to use.** The layer only supplies
  values for keys already in `SETTINGS_SCHEMA`, already coerced and clamped
  by `coerce`. There is no new value space and no new key space.
- **The workspace layer is read-only from the UI.** See §4 — this is a
  deliberate omission, not a missing piece.

## 1. The layers

Three, lowest first:

1. `SETTINGS_SCHEMA[key].default`
2. the user's `settings.json` — every key
3. the workspace's `.nox/settings.json` — **scoped keys only**

`ConfigService` holds the second and third as separate `Partial<Settings>`
maps and recomputes the effective `Settings` from all three. `get()`,
`settings` and `changed` keep their current meaning: the effective value.
`set()`, `patch()`, `reset()` and `resetAll()` continue to write the **user**
layer, which is the only layer they have ever written — the difference is
that a write to a key the workspace overrides now changes the file and not
the effective value, and §4 is how the UI stops that from being a surprise.

Two new readers and one new signal:

```ts
scopeOf(key: SettingKey): 'default' | 'user' | 'workspace'
workspaceKeys(): readonly SettingKey[]   // what the current workspace sets
readonly workspaceScope: Signal<ReadonlySet<SettingKey>>
```

**`workspaceScope` is not derivable from `settings`, and that is the point.**
`#recompute` stays quiet when nothing *moved*, so a project that sets a key to
the value the reader already had changes ownership without changing any value.
A UI watching `settings` would never notice. Found by a mutation check that
survived — the first version of the panel read `$settings` and the test still
passed with that read deleted, which is exactly what a surviving mutation is
for.

`isDefault(key)` keeps its current meaning — "the effective value is the
schema's default" — because that is the question the reset affordance asks.

## 2. The scope list

`Common` in `config/schema.ts` gains one optional flag:

```ts
/** May be set per project in `.nox/settings.json`. See the design's §0. */
workspace?: true;
```

Eight keys carry it, and the reason is the same for each — it describes the
repository, not the reader:

| Key | Why it is the project's |
|---|---|
| `editor.tabSize` | The file's own indentation. |
| `editor.insertSpaces` | Same. |
| `editor.autoIndent` | Same. |
| `editor.wordWrap` | A prose repository and a code repository want different answers. |
| `files.trimTrailingWhitespace` | A property of the diffs this repository accepts. |
| `files.insertFinalNewline` | Same. |
| `files.formatOnSave` | Same. |
| `files.excludeFromExplorer` | Which build directories this project has. |

Everything else is the person's: the theme, every font and cursor setting,
the terminal, session restore, update checking, autosave, and the panel
widths. `terminal.shell` is out for the reason in §0.

## 3. Reading it

`ConfigService.loadWorkspace(root: string | null)`:

- null root → clears the layer and recomputes. Closing a folder must not
  leave its indentation behind.
- reads `<root>/.nox/settings.json` through `Platform.readTextFile` — no new
  `Platform` method: this file lives in the project, not the config directory
- missing, unreadable, unparseable or not an object → **empty layer**, no
  error, no toast. The same rule `load()` follows for `settings.json`, and
  for the same reason.
- keys not in the schema, and keys in the schema without `workspace: true`,
  are **dropped silently at the boundary** — not coerced, not warned about.
  A warning would train people to ignore it, and the file is frequently
  written by someone who is not the reader.
- surviving values go through `coerce`, so a bad type falls back to the
  default rather than escaping.

Wiring, both in `app.ts`:

- the existing `workspace.rootPath.subscribe` block gains
  `void this.config.loadWorkspace(root)` — one line, next to
  `files.setRoot` and `watcher.start`.
- `FileWatcherService` gains a `onPathsChanged(fn)` hook, called from
  `#flush()` with the coalesced path set **before** its early return for
  "no open buffers" — because that return is about reconciling buffers and
  this is not one. `app.ts` subscribes and reloads the layer when the set
  contains the workspace settings path. Editing the file in Nox itself is
  covered by the same route: a save is a file change.

## 4. The surface

**The workspace layer is read-only from the Settings panel, on purpose.**
The alternative is VS Code's User/Workspace tab pair, which is a second write
path, a second "which file am I editing" question, and a way to commit a
personal preference into a shared repository by accident. Nox is a text
editor; the file is a file, and the panel points at it.

- A setting the workspace overrides shows a **"Workspace" badge** beside its
  label and its control is **`inert`**, because moving a control that cannot
  change the effective value is worse than not offering it. `update()`
  refuses the write on its own as well: `inert` is a browser feature, and the
  guard that matters must not be one.
- The reset affordance is hidden on those rows for the same reason.
- The panel's footer gains **Workspace settings**, which runs the command
  below. The header line names the file when a workspace sets anything.
- New command `prefs.openWorkspaceSettings` — *"Open Workspace Settings"*,
  category Preferences, enabled only with a folder open. It creates
  `<root>/.nox/settings.json` containing `{}` when it does not exist, then
  opens it as an ordinary buffer. Creating it is a write, so the command
  declares `fs.write` like every other command that writes.

## 5. What is tested, and how

`tests/workspace-settings.test.ts` — the service over `MemoryPlatform`:

- a scoped key in `.nox/settings.json` wins over the user's value, and over
  the default
- an **unscoped** key in the file is ignored — `terminal.shell` by name, so
  the test fails loudly if someone widens the list without thinking
- a key that is not in the schema at all is ignored
- a bad type is coerced, not escaped (`editor.tabSize: "eight"` → default)
- closing the folder drops the layer and the user's value comes back
- a corrupt or missing file leaves the user layer standing
- `scopeOf` reports `default` / `user` / `workspace` correctly
- `set()` on a workspace-overridden key writes the user layer without
  changing the effective value, and the value appears when the folder closes
- `changed` fires with exactly the keys whose **effective** value moved

`tests/settings-panel-workspace.test.ts` — the panel over `mountComponent`:

- an overridden row shows the badge and an inert control
- the badge appears even when the project sets the value you already had —
  the ownership-without-a-value-change case `workspaceScope` exists for
- an ordinary row does not
- a change event that reaches the handler anyway is refused: `inert` is the
  visible half of the guard and `update()`'s own check is the load-bearing
  half, because a write landing in a shadowed layer changes a file and
  nothing on screen
- an unscoped key named in the file gets no badge — it was never applied
- the footer's Workspace settings action is present with a folder open

`tests/workspace-settings.test.ts` also drives the **watch** over a real
service graph — `FileWatcherService` → `onPathsChanged` → `loadWorkspace` —
including the case with no buffer open at all, which is what the listener's
position before `#flush`'s early return is there for.

Mutation checks recorded in each suite's docblock.

## 6. Not in this

- **Writing the workspace layer from the UI.** §4.
- **`.nox/keybindings.json`.** The rule format from the keybinding editor is
  already layerable, but a repository supplying keystrokes is a trust
  question of its own — a chord bound to a command you did not choose — and
  it wants its own read of §0 rather than a ride on this one.
- **Multi-root workspaces.** Nox has one root.
- **A `.nox/` directory for anything else.** One file, this shape.

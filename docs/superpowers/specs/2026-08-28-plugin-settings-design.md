# Plugin settings

*2026-08-28. The row the plugin API pass deliberately left out.*

All four surfaces the v0.6 roadmap row named are built — commands, status
items, panels, editor decorations. A plugin can now do things and still has
nowhere to put an option. Anything configurable has to be baked into its source
or read from a file the plugin owns behind Nox's back, which is a second
settings system per plugin and none of them discoverable.

This adds one: a plugin declares its options in `plugin.json`, Nox renders them
in the Settings panel with the same controls its own preferences get, and the
plugin reads the values over the protocol.

---

## §0 The workspace layer is refused, and that is the whole security decision

`.nox/settings.json` arrives with a cloned repository, written by whoever wrote
the repository. `services/config/schema.ts:20-30` answers that with an
**allowlist**: eight keys wide, only facts about the *code* — indentation,
trimming, what to hide — and never anything naming a program, a path or an
address. `terminal.shell` is the reason the list exists.

That allowlist cannot be extended to plugin settings, because Nox does not know
what a plugin's keys mean. A plugin may declare `formatter.path`,
`server.command` or `api.endpoint`, and to Nox all three are a string with a
label. There is no property of the declaration that distinguishes "the width of
a margin" from "the program to run", and inventing one — a `workspace: true`
flag the *plugin author* sets — would put the allowlist's decision in the hands
of the party it exists to constrain.

**So plugin settings live in the user layer only.** A repository cannot set
them, and `.nox/settings.json` continues to mean what it means. The cost is
that a project cannot ship a lint plugin's configuration with itself; that is a
real loss and it is the correct side to lose on.

This is also why the values do not go in `settings.json`. Not only for the type
reasons in §2 — putting them there would make one file that the workspace layer
partially covers, and "which half of this file can a repository set" is a
question no one should have to hold.

## §1 Declared in the manifest, not registered at runtime

The same decision panels made, for the same reason. A setting has to be visible
in the Settings panel *before* the plugin runs — otherwise seeing what a plugin
can be configured to do would mean starting it, and every plugin would start at
launch to populate a panel the user may never open. That is the trade status
items had to make, and the one panels avoided by being declared.

```json
{
  "id": "todos",
  "label": "Todos",
  "worker": "main.js",
  "settings": [
    {
      "key": "markers",
      "kind": "string",
      "default": "TODO, FIXME",
      "label": "Markers",
      "description": "Comma-separated words to look for."
    },
    { "key": "maxPerFile", "kind": "number", "default": 50, "min": 1, "max": 500 }
  ]
}
```

**A malformed setting is dropped and named; it never refuses the manifest.**
The split `parseManifest` already draws holds: capabilities are all-or-nothing
because the thing being mismatched is permission, and everything else is
lenient because losing one contribution beats losing the plugin. A setting is
not a permission — the worst a bad one does is fail to appear.

## §2 Four kinds, and they are the schema's own

`boolean`, `number`, `string`, `enum` — the same four `SettingDescriptor` has,
because the Settings panel can render exactly those and a plugin declaring a
fifth would be declaring a control that does not exist. A plugin's descriptor
is therefore structurally the core one minus `category` (its category is the
plugin) and minus `workspace` (§0), plus a `key`.

`coerce` in `config/schema.ts` took a `SettingKey` and looked the descriptor up
in `SETTINGS_SCHEMA`. It is split: **`coerceTo(descriptor, value)`** is the
pure half and `coerce(key, value)` is the lookup in front of it. Plugin
settings call `coerceTo` directly, so "what is a valid number setting" has one
definition rather than two that drift.

The reason plugin settings cannot simply join `SETTINGS_SCHEMA` is that they
are not known at compile time. `SettingKey` is `keyof typeof SETTINGS_SCHEMA`
and `Settings` is derived from it — that derivation is what makes
`config.get('editor.fontSize')` typed, and it only works because the object is
closed. A runtime key would widen `Settings` to `Record<string, unknown>` and
take every core setting's type with it.

## §3 One file, namespaced by plugin id, and unknown namespaces are kept

`plugin-settings.json` in the config directory, beside `settings.json`,
`keybindings.json`, `snippets.json` and `servers.json`. The house pattern is
already one file per subsystem, and `SnippetService` is the shape this follows.

```json
{
  "todos": { "markers": "TODO, FIXME, XXX" },
  "ruff": { "lineLength": 100 }
}
```

The plugin id is the namespace, which is the namespace commands and policy keys
already use, so a plugin's settings cannot collide with another's for the same
reason its commands cannot.

**A namespace belonging to no currently-loaded plugin is written back
untouched.** `ConfigService.serialize` drops unknown keys, and is right to:
its schema is complete, so an unknown key is a stale one. Here the set of known
keys is whatever discovery found *this launch*. A plugin that failed to parse
its manifest this morning, or a folder temporarily renamed, or one being
upgraded, must not have its configuration silently erased by the next write.
Dropping would make an unrelated transient failure destructive.

Only non-default values are written, matching `ConfigService`.

## §4 The plugin reads its own namespace, and hears when it changes

Two protocol additions.

**`settings.get`** (plugin → Nox) returns that plugin's values, defaults filled
in, so a plugin never handles a missing key. It is scoped to the caller's own
id and takes no plugin argument — there is no spelling of this request that
reads another plugin's settings, or Nox's own. The editor's preferences are not
a plugin's business; `context.*` is the read API and settings are not in it.

**`settings.changed`** (Nox → plugin) carries the new values with it. This
departs from `document.changed`, which is deliberately coarse, and the
difference is the reason: a document is large and the rule is that a plugin
must never be woken per keystroke, so the notification says only *that*
something changed. A settings object is a handful of scalars that change at
human speed, and a bare "they changed" would buy nothing but a round trip.

**It is sent only to running plugins.** Changing a setting does not start one —
that would undo the lazy activation §1 exists to protect. An idle plugin reads
the current values with `settings.get` when it starts, which is the same answer
by a different route.

## §5 In the panel, under the plugin's own name

A `Plugins` tab beside the five categories, with one section per plugin
carrying its label. Not a sixth `SettingCategory`: that union is closed and
`SettingsPanel.svelte` restates it as a value, and more to the point a plugin's
settings are not a *category* of preference — "Editor" and "Terminal" describe
what a setting is about, and "Todos" describes who owns it.

Rows reuse the existing controls and the existing search. There is no workspace
badge, because §0 means there is nothing to badge.

The tab is hidden when no loaded plugin declares a setting, which is every
install until someone adds a plugin that has one.

---

## What this does not do

**No per-plugin enable/disable.** That is an install-flow question and it wants
its own envelope read; `plugins.reload` and moving a folder are the current
answers.

**No secrets.** A plugin wanting an API key gets a string setting in a
plaintext JSON file, exactly as `servers.json` and `agents.json` already do.
Nox has no keychain seam and adding one for this would be the whole feature.
Recorded in the debt table rather than implied.

**No validation beyond the descriptor.** A number is clamped to its bounds and
a string is any string. A plugin that needs a path to exist checks it itself,
because Nox checking would mean Nox knowing what the key means, which is the
same thing §0 says it cannot.

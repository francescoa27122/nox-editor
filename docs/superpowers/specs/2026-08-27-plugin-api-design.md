# Plugin API — design

*2026-08-27. Covers the first pass: host, lifecycle, and contributed commands.*

## Why this shape

`ROADMAP.md` v0.6 asked for "commands, panels, status items, editor
extensions" behind one design gate: **plugins must not be able to block the
typing path.** The 1.0 section then excluded plugins on purpose, because "a
plugin API is a compatibility promise, and 1.0 should not make one it has not
lived with".

Most of what a plugin API needs already existed, built for agents and unused:

| Piece | Where | Already did |
|---|---|---|
| Dynamic contribution | `services/commands.ts` | `register()` returns a disposer |
| Enforcement | `services/commands.ts` | the dispatcher is the *only* check |
| Identity | `services/permissions.ts`, `transactions.ts` | `{ kind: 'plugin', pluginId }` |
| A pipe | `platform/types.ts` | `AgentProcess` — "this moves lines" |
| Reads | `services/context.ts` | serialisable, per-principal, logged |

So the work was mostly *choosing what to promise*.

## Out-of-process, not in-process JS

`AGENT-PLATFORM.md` §6 had already rejected "in-process JS plugins with direct
API access" for agents: external "buys a crash boundary, real capability
enforcement, and language independence — none of which are retrofittable."
The same reasoning applies here, and one more does:

**The typing-path gate is only enforceable out-of-process.** An in-process
plugin handed a CodeMirror extension runs on the user's keystrokes, and no
amount of documentation prevents it. Out-of-process, there is no seam through
which a plugin *could* run per keystroke — the gate becomes a property rather
than a request.

The cost is real and is paid: **a plugin cannot hand Nox a CodeMirror object.**
The roadmap's "editor extensions" therefore becomes a declarative surface —
the plugin sends ranges, Nox owns the render loop — and it is not built yet.
The protocol reserves the namespace; nothing implements it.

## Two transports, one connection

A plugin is anything that moves lines, so `PluginConnection` is `AgentProcess`'s
shape and the host branches on nothing:

- **worker** — a `.js` file, run in a Web Worker. The low bar: writing a plugin
  is writing a file, not shipping an executable.
- **process** — any language, over stdio, reusing `Platform.spawnAgent`
  verbatim. It was already documented as protocol-agnostic, which is why this
  pass needed **no Rust change at all.**

The worker required one CSP line — `worker-src 'self' blob:`. That is the only
security boundary this change moves, and it permits same-origin-derived blobs,
never a remote script.

## Contributions live in the manifest, not the handshake

The decision with the most consequences. `plugin.json` declares the commands,
so they are registered **before anything runs**, and a plugin starts on the
first invoke of one of its commands.

The alternative — a handshake that reports contributions — would mean starting
every installed plugin at launch to find out what they offer, on an editor
whose thesis is starting fast. Lazy activation falls straight out of writing
the contributions down.

## The manifest is read stricter than any other config

Every other file Nox parses is the user describing their own preferences. A
manifest arrives with **code someone else wrote**, and its fields are that
author's claims about what it may do. So the two halves differ deliberately:

- **Capabilities are all-or-nothing.** One unrecognised word refuses the whole
  manifest. Trimming would leave a plugin whose declaration the user read and
  whose behaviour does not match it — and the mismatched thing is permission.
- **Commands are lenient.** A malformed command grants nothing, so dropping one
  is a smaller harm than refusing a plugin whose others are fine.

Ids and command names are `^[a-z0-9][a-z0-9-]*$` — narrower than a valid folder
name, because the id becomes a *segment* of a command id and a policy key, and
is read back as a folder name. A dot would split the namespace; a slash or `..`
would aim the entry file outside the plugin's folder.

## Namespacing makes collisions unrepresentable

A contribution registers as `plugin.<pluginId>.<name>`. Three segments, a fixed
first one, and no dots allowed in either of the others — so a contributed id
can never equal a core id, and two plugins can never collide. The palette needs
no conflict resolution because there are no conflicts.

## Failure is a first-class state

`idle → starting → running`, and `failed` or `disabled` when it is not.

One crash is an accident: the plugin is marked `failed`, reported once, and its
commands **stay** — a command that vanished on the first crash could not be
retried after the author fixed it. Three consecutive failures is a pattern:
the plugin is `disabled` and its commands are withdrawn, because a command
certain to fail is a row in the palette that lies about what the editor can do.
Same shape as the agent runner's `max_failures`.

Two deadlines, both learned from `services/agent/stdio.ts`: a handshake
timeout, and an invoke timeout. The failure they prevent is the one recorded
there — with no deadline, a plugin that stops writing leaves the caller waiting
for the life of the app. The invoke deadline is a minute rather than the agent
runtime's five: an agent's silence is a model thinking, a plugin's is code that
has stopped.

## Two bugs the tests found, both about arriving early

A plugin writes its greeting in the tick it starts — earlier than anyone can
listen.

1. **The connection must buffer.** `AgentProcess.onLine` already requires this
   in those words. A fake that dropped pre-subscription lines failed every
   handshake, which is what a real transport would have done too.
2. **The host must record the greeting, not merely await it.** The buffered
   line is replayed the moment a handler attaches, which is one statement
   before `#awaitHello` installs its waiter. `helloVersion` closes it.

## Deliberately not in this pass

Status items, sidebar panels, declarative editor decorations, plugin settings,
and any install flow. `SidebarView` is a closed union and `Sidebar.svelte`'s
`VIEWS` is a hardcoded table; opening those up is its own work. Promising the
whole roadmap row in one pass is exactly the compatibility promise 1.0 was
warned about.

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

## Status items *(added the same day)*

Runtime, not declared: an item's *content* is only known to running code. That
forced the one new manifest field, `"activation": "startup" | "command"`.
`command` stays the default and the one to want — the plugin sleeps until one
of its commands is invoked — but a plugin that puts something on the bar cannot
be woken by a command, because it has to already be running to have put
anything there. Written down rather than inferred, so the cost is visible to
whoever installs it.

**Every limit on the store is about the bar being a shared row with no
scrollbar.** Three items per plugin, forty characters each, and plugin items
always drawn *after* Nox's own — a plugin appearing mid-session must not slide
the Save-all button out from under the pointer. An unchanged `set` does not
emit, so a plugin that polls and reports the same thing costs nothing.

Items are taken back on every path that stops a plugin: exit, disable, and
`stopAll`. A crashed plugin otherwise leaves a readout asserting something that
stopped being true, with nothing running to correct it.

**Nox pushes no events to plugins, and this is where that first bites.** There
is no "the buffer changed" message — a plugin woken per keystroke is exactly
what the out-of-process architecture exists to prevent — so an item changes
only when the plugin does something: at startup, when one of its commands runs,
or on a timer it owns. A readout that tracks the editor live is not something
this API can do, and `examples/plugins/counter/` says so rather than implying
otherwise.

## Panels *(added 2026-08-27)*

**Declared, unlike status items** — and that difference is the whole design.
The rail button comes from `plugin.json`, so it exists before the plugin does,
and *opening it* is what starts the plugin. A plugin with a panel therefore
keeps the lazy activation a plugin with only commands has; had panels been
registered by running code, every plugin with one would start at launch, which
is the trade status items had to make and this did not.

That is also the one push Nox makes: `panel.show`. It is demand-driven — sent
when someone opens the panel, never when anything in the editor changes — so it
stays on the right side of the gate.

**Rows, not markup.** A plugin is in another process and cannot ship a
component; a way to describe arbitrary DOM would be a way to reach the render
loop. Rows are also what Nox's own panels already are — Problems, References
and Search are each a list of "here is a thing, click it to go there". A row
carries text, an optional detail, and optionally a command and its argument.

**`SidebarView` stayed a real type.** The obvious move was to widen it to
`string`, which would have silently deleted every check it was doing. Instead
``type PluginSidebarView = `plugin.${string}` `` — every plugin view id has that
shape by construction, so the union still says what a view *is* and a typo in a
core name is still a compile error.

**One collision would have been fatal rather than confusing.** A panel's focus
command is registered under the same `plugin.<id>.<name>` id a contributed
command gets, and `CommandRegistry.register` *throws* on a duplicate — so a
plugin declaring a panel and a command of one name would have taken the window
down at load. `parseManifest` drops the panel and says so.

## Editor decorations *(added 2026-08-27)*

The last of the four, and the only one where the typing path was actually at
stake.

**Marks live in a `StateField`, mapped forward through every change.** The test
`provenance.ts` applies decides it: is this *derivable* from the document? It
is not — nothing in the text remembers that a plugin thought line 40 was
suspicious. And carrying them forward is not a nicety: a plugin is in another
process and cannot be asked to re-decorate between one keystroke and the next,
so without mapping every mark would vanish the moment anyone typed.

**That mapping is the entire per-keystroke cost, and it is measured.** With the
cap of 2,000 marks in the document: **0.82x for 8x the document** — 0.387 ms at
2,000 lines against 0.320 ms at 16,000. So the marks cost about 0.08 ms over
the 0.31 ms baseline, and that cost does not move with the document.
`tests/browser/typing-path.test.ts` pins it at the same 3x budget the
undecorated case uses, because the claim is precisely that decorations cost by
their own count and not by the file.

**Ranges are clamped, not trusted.** CodeMirror throws on a range outside the
document, *from inside a view update* — which is not a missing decoration, it
is a dead editor. `core/plugin-decorations.ts` clamps, drops inverted and empty
ranges, floors fractions, and sorts, because `RangeSet.of` throws on unsorted
input and a linter reporting by rule emits out of order as a matter of course.
`editor/lsp.ts` already learned this from language servers; a plugin has less
excuse and no specification.

**A closed vocabulary, not a class.** `error`, `warning`, `info`, `highlight` —
the plugin names what it means, Nox decides how that is drawn. The three that
report something underline; `highlight` fills, because that is what asking for
a highlight means, and it is weaker than both the selection and a search match
so a plugin's opinion cannot outrank what the user is doing.

### The one event a plugin gets

Decorations forced the push channel the status-item pass recorded as debt, and
it is deliberately the narrowest version that works:

- **Debounced** (400 ms), so a burst of typing is one wake-up after it stops.
- **Coarse** — "this buffer changed", never what changed.
- **Only for buffers the plugin has already decorated.** A plugin that never
  showed an interest in a file is not woken by someone typing in it, which is
  what stops this becoming an ambient event feed.

Per edit it costs one map lookup, one `clearTimeout` and one `setTimeout`, and
nothing at all for anyone with no plugins installed.

## Deliberately not in this pass

Plugin settings and any install flow. **All four surfaces the roadmap row
named are now built.** `SidebarView` is a closed union and `Sidebar.svelte`'s
`VIEWS` is a hardcoded table; opening those up is its own work. Promising the
whole roadmap row in one pass is exactly the compatibility promise 1.0 was
warned about.

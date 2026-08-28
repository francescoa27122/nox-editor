# Watching the config directory

*2026-08-28. Three debt rows, one cause.*

`snippets.json`, `plugin-settings.json` and a theme file all say the same thing
in the Known debt table: **edit it outside Nox and nothing happens until you run
a Reload command.** All three name the same cause — `FileWatcherService` has one
root and it is the workspace — and the snippets row has said since it was
written that this is *"the same machinery `keybindings.json` and `servers.json`
would want"*.

---

## §0 The debt row's premise was wrong, and that changes the shape

Every one of those rows implies a renderer-side fix: watch a second root. It is
not one. `nox_watch` holds `Mutex<Option<RecommendedWatcher>>` — **one**
watcher — and its own doc comment says *"replacing any previous watcher"*, with
`*guard = None` before it installs the new one. Calling it for the config
directory would silently stop watching the workspace: no external-change
detection, no tree refresh, no save-overwrite dialog. The feature would trade
three small gaps for one large one.

So this needs Rust, and the shape is already in the file. `watchGitMeta` is a
*second* concurrent watch and it did not extend `nox_watch` into a registry —
it added `GitMetaWatcherState`, its own command pair, and its own event
channel. That is the house pattern for "another thing to watch", and this
follows it rather than refactoring the workspace watcher, which is the one path
where being wrong costs unsaved work.

**`cargo` is not installed on this machine.** The Rust tests below are written
and unrun locally; CI executes them on all three platforms.

## §1 A third watcher, not a registry

`ConfigWatcherState`, `nox_config_watch(path)`, `nox_config_unwatch()`,
`nox://config-change`. Recursive, because `themes/` and `plugins/` are
subdirectories of the config folder and a theme file is the whole point.

Recursive is safe here in a way it would not be for a home directory: the
config folder is small, Nox's own, and holds nothing that churns.

**The payload carries paths**, unlike `nox://git-meta-change` which carries
nothing. The git watcher has one subject and any event means "refetch"; this
one has several files with different consequences, and a subscriber that had to
re-read all of them on any change would make every theme edit reload the
snippets too.

## §2 Self-writes are excluded by content, not by a timer

This is the decision that matters. Nox *writes* two of these files itself —
`plugin-settings.json` on a 250 ms debounce, and `settings.json` constantly. A
watcher that reloads on Nox's own write is at best wasted work and at worst a
loop: reload → recompute → save → event → reload.

The workspace watcher solves this with mtimes, because it has buffers to hang
them on. There are no buffers here. The obvious substitute is a time window —
"ignore events for a second after we write" — and it is the wrong one: it is a
race written down as a constant, and it fails in exactly the case that matters
(a real external edit landing inside the window is silently dropped).

**Instead the reload is idempotent and compares content.** A service re-reads
its file and, if the bytes are what it would have written, does nothing —
emits no change, bumps no revision, notifies no plugin. That is deterministic,
has no timer, and is *correct under a real external edit inside the window*
because such an edit changes the bytes.

The cost is one file read per event, of files that are a few kilobytes.

## §3 What reloads, and what deliberately does not

| File | On change | Why |
|---|---|---|
| `snippets.json` | Reload | Already has a reload path; the set is read on demand. |
| `themes/*.json` | Reload, then re-apply | The chosen theme may be the one edited. Re-applying is idempotent. |
| `plugin-settings.json` | Reload, then tell running plugins | Same push a Settings-panel change makes. Needs §2, because Nox writes this file. |
| `settings.json` | **No** | Nox writes it every 250 ms while a preference is being dragged. The value is real but the risk is a feedback loop through the layer that owns every preference, and it wants its own envelope read. |
| `keybindings.json` | **No** | Same: Nox writes it, and a rebinding mid-edit is a keymap that disagrees with the panel that is open. |
| `servers.json`, `agents.json` | **No** | Reloading these *restarts processes*. That is a decision a user should make, which is what **Reload Language Servers** already is. |

The "no" rows are the interesting half. This is a watcher, not a policy that
everything must live-reload; three of the six files have consequences beyond
re-reading, and the debt rows this closes named the other three.

## §4 Where it lives

A separate `ConfigWatcherService`, not an extension of `FileWatcherService`.
That service's whole body is workspace policy — reload clean buffers, protect
dirty ones, refresh the tree, re-index for quick-open, warn once per buffer.
None of it applies to a config file, and threading a second root through it
would mean a conditional at every one of those steps.

What the new service does is small enough to state completely: watch, coalesce
into a set of changed names, hand that set to subscribers. Every decision about
what a change *means* stays with the service that owns the file.

## §5 The fake diverges here, and the tests say so

`MemoryPlatform` keeps config files in a `Map<string, string>` keyed by name,
while `readDir`/`readTextFile` read a separate in-memory filesystem. So in the
browser target and in most tests, writing `snippets.json` through
`writeConfigFile` produces **no path an event could name**.

That is pre-existing and not worth changing — making the fake path-backed would
require `configDir()` to be non-null everywhere and would touch every config
test. What it means for this feature is that the seam is tested in two halves:
the watcher against `platform.watch` and `externalWrite`, which are path-based
and work; and each consumer's reload directly. The joined path is covered by
the Rust test and by a desktop walk, not by the browser target.

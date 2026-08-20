# Keybinding editor — design

Change any application key from inside Nox, and keep the change. The first
row of v0.6 and a named 1.0 gate: *"a keyboard-first editor lets you change
the keys."*

Status: decided 2026-08-20. Every path, type and function named below was
read in the file it names before being written down.

## 0. The envelope

Read this before writing any code that touches the keymap.

- **Application keys only.** `services/keymap.ts` says it in its header and
  it stays true: undo, multi-cursor, comment toggling and the rest belong to
  CodeMirror's keymap, and binding them twice would mean two sources of
  truth and a race over `preventDefault`. The panel already lists those keys
  under an **Editor** heading; that section stays **read-only**, and says so
  on screen rather than by omission.
- **The defaults are not edited.** `#registerKeybindings` in `app.ts` stays
  the single default table. A user customisation is a *rule applied over*
  it, never a mutation of it — which is what makes "reset" a deletion rather
  than a remembered original.
- **A broken keybindings file never stops the editor.** Same rule
  `ConfigService.load` already follows: unreadable or unparseable means the
  defaults stand, silently. Losing your rebinds is recoverable; failing to
  boot is not.
- **No new `Platform` method.** `readConfigFile` / `writeConfigFile` already
  take a bare filename, which is exactly this file's need.

## 1. The model — rules over defaults

```ts
export interface KeybindingRule {
  chord: string;          // normalised on the way in
  command: string;
  arg?: unknown;
  remove?: boolean;       // true = delete a default, rather than add
}
```

`KeymapService` records every `bind()` made before the user layer is applied
as its **defaults** (`#defaults: Keybinding[]`). `setUserRules(rules)` then
rebuilds the live map from scratch:

1. Replay each default whose `(chord, commandId)` pair is not named by a
   `remove` rule.
2. Apply each additive rule, in file order.

Because `bind()` unshifts — "later bindings take precedence" — additions land
in front of defaults on a shared chord, so a user binding wins without any
extra precedence machinery.

**`(chord, commandId)` is the identity of a binding.** It is unique across
the default table today (`nav.commandPalette` has two chords; `nav.goToTab`
has nine, one per `arg`), and every rule addresses a binding by that pair.

**`when` and `arg` are inherited, not written.** `when` is a live predicate
and cannot be serialised; `arg` can be, but a rule written by hand will
usually omit it. Both are taken from the command's **first default binding**
when the rule does not carry an `arg` of its own. The panel always writes the
`arg` explicitly for a row that has one, so inheritance only decides what a
hand-edited file means — and it means the obvious thing.

Consequence, stated rather than discovered later: rebinding `Escape`
(`view.dismiss`, guarded by `when: () => ui.hasDismissible()`) keeps the
guard, so the new key still falls through when there is nothing to dismiss.

## 2. Persistence — `keybindings.json`

A JSON array of rules, in the config directory beside `settings.json`:

```json
[
  { "chord": "ctrl+alt+s", "command": "file.save" },
  { "chord": "ctrl+s", "command": "file.save", "remove": true }
]
```

Written whole on every change (these are rare and deliberate — no debounce
to reason about), read once at boot. Ordering is not a hazard: `NoxApp`'s
constructor calls `#registerKeybindings`, and `#boot()` runs after the
constructor returns, so the defaults are already recorded when
`keymap.loadUserRules()` joins the `#boot()` sequence beside `config.load()`.
An empty rule list writes an **empty file** rather than `[]` — `Platform`
has no delete, and an empty file already reads back as "no
customisations" through the same `if (!raw) return` the corrupt case uses.

Chords are normalised through `normalizeChord` on the way in, so a
hand-written `"Cmd+Shift+P"` and a recorded `"meta+shift+p"` are the same
rule.

## 3. Capture — reading a chord while the keymap is listening

`KeymapService.attach` listens on the **capture** phase at the window, which
means a recording input inside the panel can never see a claimed chord
first — the service already `preventDefault`ed it and ran the command. So
recording is a mode *of the service*, not a listener beside it:

```ts
beginCapture(handler: (chord: Chord) => void): void
endCapture(): void
```

While a capture handler is set, the global keydown handler swallows every
key — `preventDefault`, `stopPropagation`, no `resolve()`, no command — and
hands the chord to the handler. Keydowns whose key token is a bare modifier
(`shift`, `control`, `alt`, `meta`, `capslock`) are ignored, so holding ⇧
before pressing the real key does not record `⇧`.

Escape is delivered like any other key; **the panel** treats a bare `escape`
as cancel. The cost is honest and small: you cannot record a bare Escape from
the UI. Hand-editing the file still can.

## 4. The surface — `ui/KeybindingsPanel.svelte`

The read-only reference grows an editor. What changes:

- **Every command gets a row**, not only the bound ones — rows are
  `keymap.bindings()` plus one row per command with no binding, whose chord
  cell reads "Unassigned". Adding a key to an unbound command is half of
  what "change the keys" means, and the current list cannot express it.
- **Per row, on hover or focus:** an edit button (`Change key` / `Add key`),
  a clear button on a bound row, and a reset button **only when that row
  differs from the defaults**. Reset deletes the rules touching it.
- **Recording** replaces the row's chord cell with a live well:
  "Press a key…", then the chord as pressed, `↵` to accept, `Esc` to cancel.
  Accepting writes the rules and re-renders from the rebuilt keymap — the
  panel never keeps its own copy of the map.
- **Conflicts are shown before they are accepted.** If the recorded chord is
  already bound to a different command, the well says so by name, and the
  accept action reads *"Rebind, and unassign <that command>"*: accepting
  writes a `remove` rule for the conflicting pair as well. Silently shadowing
  a binding would work — additions win — but it would leave a key whose
  listed owner is not the one that runs.
- A chord already bound to **the same command** is not a conflict; it is a
  no-op, and the well says so.
- The header gains **Reset all** when any rule exists, and a count of what is
  customised. Both disappear when nothing is.
- The **Editor** section keeps its rows and gains one line of prose: those
  keys are CodeMirror's and are not editable here.

## 5. What is tested, and how

`tests/keymap-user-bindings.test.ts` — the service, no DOM:

- a rule rebinds a command, and the old chord stops resolving
- a `remove` rule alone unbinds, and the key falls through (`resolve` → null)
- an addition wins over a default on the same chord
- `arg` and `when` are inherited from the command's first default
  (`nav.goToTab` keeps its index; a `when`-guarded command keeps its guard)
- rules are normalised: `"Cmd+Shift+P"` and `"meta+shift+p"` are one rule
- round-trip: `setUserRules` → `serializeUserRules` → `loadUserRules` is
  fixed-point, and a corrupt file leaves the defaults standing
- capture: while capturing, no command runs and every chord reaches the
  handler; bare modifiers do not

`tests/keybindings-panel.test.ts` — the component over `mountComponent`:

- every command appears, unbound ones reading "Unassigned"
- recording a chord and accepting rebinds the live keymap
- a conflicting chord names the command it would displace, and accepting
  unassigns it
- reset restores the default and hides itself
- the Editor section has no edit affordance

Mutation checks recorded in each suite's docblock, as the house rule asks.

## 6. Not in this

- **Chord sequences** (`⌘K ⌘S`). The map is keyed by a single chord and
  `resolve` answers per event; sequences want a pending-prefix state machine,
  which is a different feature and not a 1.0 gate.
- **`when`-clause editing.** Predicates are functions in `app.ts`; exposing
  them means a context-key language, which is VS Code's answer to a problem
  Nox does not have yet.
- **Rebinding CodeMirror's keys.** §0.
- **Workspace-level keybindings.** `.nox/settings.json` is its own row and
  arrives with the settings layering; the file format here is already
  layerable when it does.

# Custom themes from JSON

*2026-08-28. The last open row in the v0.6 table.*

`DESIGN.md` §9 has said since v0.1 that a theme is *"a token override, not a
fork"* — Umbra is about twelve declarations. The row asks for the obvious
consequence: if a theme is twelve declarations, a user should be able to write
those twelve themselves without building Nox.

---

## §0 A theme file is downloaded, so treat it as third-party

This is the decision everything else follows from. Nobody writes a theme
from nothing — they will fetch one someone posted and drop it in a folder,
exactly as they would a plugin. So a theme file is **content from a stranger
that Nox turns into CSS**, and it gets the discipline `plugin.json` gets rather
than the discipline `settings.json` gets.

Two structural consequences, neither of them a blocklist:

- **The user never writes a CSS property name.** The file says `"bg-editor"`,
  not `"--nox-bg-editor"`, and Nox writes the prefix. A key outside the
  allowlist is dropped and named. There is no spelling of a theme file that
  reaches a property Nox did not choose.
- **Nox never builds a CSS rule out of the file.** Values go in through
  `CSSStyleDeclaration.setProperty` on the root element, so the *browser's*
  parser is what reads them and a value it dislikes is dropped by the same
  code that reads every other stylesheet. Generating
  `[data-nox-theme='<id>'] { … }` as text would mean escaping an id and a
  value into a selector and a declaration, which is two injection points
  invented for no gain.

Values are still validated before they get there, because a dropped value is
invisible and the author deserves to be told which line did nothing.

## §1 The allowlist is the colour tokens, and only those

`tokens.css` defines 109 tokens; most are not colours. A theme may not set:

| Excluded | Why |
|---|---|
| `--nox-sp-*`, `--nox-r-*`, `--nox-*-h`, `--nox-input-h` | Geometry. A theme that could set these could break the layout, and "the tab bar is 200px tall" is not a colour scheme. |
| `--nox-dur-*`, `--nox-ease` | Motion. `tokens.css` zeroes these under `prefers-reduced-motion`; a theme overriding them would quietly defeat an accessibility preference the user set in their OS. |
| `--nox-z-*` | Stacking. Wrong values here put the palette behind the editor. |
| `--nox-font-*`, `--nox-fs-*`, `--nox-fw-*`, `--nox-lh-*`, `--nox-tracking-*` | Typography, and `editor.fontFamily` and `editor.fontSize` are already the user's own settings. A theme silently outranking them would be a preference losing to a file. |

What remains is surfaces, interaction states, borders, text, accents, editor
colours and the sixteen `--nox-syn-*` — the things a theme is *about*.

The list lives in `core/theme.ts` as data, and a test asserts every name in it
is defined in `tokens.css`. Without that, a token renamed in the stylesheet
would leave a theme key that silently sets nothing.

## §2 A theme names a base, and overrides it

```json
{
  "name": "Solar",
  "base": "umbra",
  "tokens": { "bg-editor": "#101214", "accent": "#e0a458", "syn-string": "#98c379" }
}
```

`base` is `eclipse` or `umbra` and defaults to `eclipse`. This is the whole
reason a twelve-declaration theme works: `data-nox-theme` is set to the *base*,
so the cascade fills in everything the file does not mention, and the file's
own tokens are applied on top as inline custom properties on the root element.
Inline properties beat a `[data-nox-theme]` rule, which is exactly the
precedence wanted.

It also means switching back to a built-in theme is "remove the inline
properties", not "reload the stylesheet".

## §3 `workbench.theme` stops being an enum, because it stopped being closed

`pick(['eclipse', 'umbra'], …)` makes `Settings['workbench.theme']` the union
`'eclipse' | 'umbra'`. That type was *true* while the set of themes was fixed
at build time. Custom themes make it false, and `coerce` would enforce the
falsehood: an enum coerces an unrecognised value back to its default, so a
custom theme id stored in `settings.json` would be silently rewritten to
`eclipse` on the next load.

So the setting becomes a `str`, and the type widens to `string`. That is the
type catching up with reality rather than a loss — the union bought exactly two
things, an attribute value and a two-way toggle, and both survive.

**The Settings panel must still show a dropdown**, so `Common` gains
`optionsFrom?: 'themes'`: a *closed* union naming a runtime source, not an open
string, so adding a second source is a compile-time decision someone makes on
purpose. A descriptor carrying it renders a `<select>` whose options come from
the named service. It is one entry in one table today and it is written down as
the seam, because the alternative — the panel special-casing the key
`workbench.theme` — would be the first hand-written control in a panel whose
whole claim is that it has none.

**A theme id naming nothing degrades to the base.** An uninstalled theme leaves
`data-nox-theme` on a value matching no rule, `:root` supplies Eclipse, and no
overrides are applied. Nothing throws and nothing is reset, so reinstalling the
theme file brings the choice back.

## §4 Discovery mirrors plugins, not snippets

A folder — `<config>/themes/`, one `.json` per theme — rather than one
`themes.json` map. A theme is a *unit of sharing*: people post them, download
them, and drop them somewhere. A file is that unit; a fragment to paste into a
map is not. It also means a broken theme costs one theme rather than all of
them, which is the same leniency argument `discoverPlugins` makes.

The id is the file's stem (`solar.json` → `solar`), not a field. A field would
let two files claim one id and would need a collision rule; a stem cannot,
because a directory already enforces uniqueness.

## §5 What this deliberately does not do

**No contrast enforcement.** `tests/token-contrast.test.ts` holds Nox's own
tokens to WCAG ratios and will keep doing so. A user's own theme is theirs, and
refusing to load one because a comment colour measures 4.2:1 would be Nox
overruling a person about their own screen. The cost is that the guarantee that
suite provides covers built-in themes only, and that is now written in the debt
table rather than implied by silence.

**No live reload.** Editing a theme file needs **Reload Themes**, the same gap
`snippets.json` and `plugin-settings.json` have and for the same reason:
`FileWatcherService` has one root and it is the workspace. Three features now
want a watcher on the config directory; that is a feature of its own and this
is the third row asking for it.

**No syntax-theme-only files, no light themes.** A theme sets whichever tokens
it likes, including none of the syntax ones. Nox is a dark editor and the
tokens assume it: a light theme is expressible and nothing stops one, but
`--nox-shadow-*` and the scrim are tuned for dark grounds and are not in the
allowlist, so it would not look finished. Saying so beats pretending otherwise.

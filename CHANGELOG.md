# Changelog

All notable changes to Nox are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Accepting a completion that adds an import no longer leaves the cursor in
  the import.** When a language server sends the import alongside the
  suggestion — rust-analyzer, gopls and pyright do; tsserver sends it a moment
  later and was never affected — both landed in one undoable step, correctly,
  but the caret was placed as though the import were not there. It ended up
  part-way through the new line at the top of the file, and the next thing
  typed went in there.
- **Opening any file no longer loads every grammar Nox ships.** The build put
  all the parsers in one chunk, so opening a .json buffer downloaded and
  parsed the JavaScript, HTML, CSS, Markdown, Python and Rust grammars too —
  327 kB of them, and 640 kB once the eleven new ones landed. Each grammar is
  now its own chunk: a .json file costs 2 kB and a .go file 31 kB.
- **Completion now works in files with no language server, and in the three
  languages that ship their own suggestions.** The completion extension was
  installed with CodeMirror's `override` option, which *replaces* the sources a
  language contributes rather than adding to them. Nox bundles
  `@codemirror/lang-html`, `lang-css` and `lang-javascript`, each of which
  registers its own — HTML tags and attributes, CSS properties and values,
  JavaScript locals — and all three were switched off from the day the LSP
  client landed. In any other language, with no server configured, there were
  no suggestions at all. Both are fixed: the server's suggestions are now
  registered alongside a language's own rather than in place of them.

### Added

- **Config files edited outside Nox now apply on their own.** Change
  `snippets.json`, `plugin-settings.json` or a theme file in another editor and
  Nox picks it up — no **Reload** command, and for a theme you are already
  using, the colours change as you save.

  Four files deliberately still wait for their command. `settings.json` and
  `keybindings.json` are ones Nox writes constantly itself, and `servers.json`
  and `agents.json` start *processes*, which is a decision worth making on
  purpose — **Reload Language Servers** is still how you make it.

- **Custom themes.** Drop a `.json` file into the `themes` folder in your Nox
  config directory and it appears in Settings under Theme. **Edit Themes**
  creates the folder with a worked example to start from; **Reload Themes**
  picks up your edits, and **Switch Theme** now cycles through everything you
  have rather than flipping between the two Nox ships.

  A theme names a `base` — Eclipse or Umbra — and overrides colours on top of
  it, so a real theme can be three lines: everything you leave out comes from
  the base. Sixty tokens are settable, and they are the colours — the surfaces,
  text, borders, accents, the editor and all sixteen syntax colours. Sizes,
  animation timings and fonts are not themeable on purpose: a colour scheme
  should not be able to resize the tab bar, and animation timings are switched
  off entirely when your system asks for reduced motion, which a theme must not
  be able to undo.

  Themes are files people share, so a theme file is read as carefully as a
  plugin: it names Nox's own tokens rather than raw CSS, values have to be a
  hex or `rgb()` colour, and anything else is skipped and named rather than
  applied. A theme whose file is missing leaves your choice alone rather than
  resetting it, so putting the file back brings it back.

- **Plugins.** Nox can now be extended by code you did not write. A folder in
  the plugins directory with a `plugin.json` gets its commands into the
  palette, the menus and the keybinding editor — **Open Plugins Folder** and
  **Reload Plugins** are the two commands that manage it, and a reference
  plugin ships in `examples/plugins/`.

  A plugin is either a `.js` file run in a worker, or a program in any language
  speaking one JSON object per line over stdio. Either way it runs **outside
  the editor's thread**, which is not a detail: it is what makes "a plugin
  cannot block your typing" a property of the design rather than a promise in a
  document. It is also a crash boundary — a plugin that dies takes nothing with
  it, and one that keeps dying is disabled rather than retried forever.

  What a plugin may do is what its `plugin.json` declares, checked in the same
  place every menu item and keystroke is checked. It has no way to write a file
  directly: it can run a command, which is permission-checked, or offer an edit
  to the review panel, which you apply yourself. Its commands are namespaced,
  so a plugin cannot replace **Save**.

  A plugin can also put a readout on the **status bar** — a linter's last
  result, a toolchain version, a toggle — and make it clickable to run one of
  its own commands. Three per plugin, capped in length, and always drawn after
  Nox's own items, so a plugin arriving mid-session cannot slide a control out
  from under your pointer. They disappear with the plugin, including when it
  crashes: a readout nothing is left to correct is worse than none.

  A plugin that shows one declares `"activation": "startup"`, because a status
  item needs the plugin running to have any content. Everything else stays
  lazy — a plugin whose commands you never run is never started. Nox pushes no
  events to plugins, so an item changes when the plugin does something rather
  than tracking the editor live.

  A plugin can also contribute a **sidebar panel**. It declares the panel in
  its manifest, so the button appears in the rail before the plugin has run —
  opening it is what starts the plugin, which is then asked to fill it. The
  contents are rows: text, an optional detail, and optionally a command to run
  when you pick one, which is what turns a list of findings into a list of
  places to go. A plugin cannot send markup; Nox draws every pixel.

  Finally, a plugin can **mark up the editor** — a linter's findings, a
  spell-checker's doubts, anything worth pointing at. It names ranges and one
  of four kinds (error, warning, info, highlight) and Nox draws them; it does
  not get to pick colours or ship a stylesheet. Marks follow the text as you
  type rather than vanishing on the first keystroke, and the whole cost of that
  is flat in file size: with the maximum two thousand marks in a document, a
  keystroke measured the same at 16,000 lines as at 2,000.

  Decorating a buffer is also the one thing that gets a plugin told about
  changes to it — once, after you stop typing, and only for files it has
  already marked up. There is deliberately no way for a plugin to watch you
  type.

  A plugin can also declare **settings** you can change. They appear in
  Settings under a **Plugins** tab, in a section named after the plugin, with
  the same switches, number boxes and dropdowns Nox's own preferences get —
  and the same reset arrow beside anything you have moved. A plugin is told
  when you change one, but only if it is already running: touching a control
  never starts a plugin that was idle.

  They are kept in `plugin-settings.json`, separately from `settings.json`, and
  they are **yours alone** — a project's `.nox/settings.json` cannot set one.
  That is deliberate and it is the one thing this refuses: Nox knows what its
  own eight project-settable keys mean, and it cannot know whether a plugin's
  `path` setting names a margin or a program to run. Settings belonging to a
  plugin that is not installed right now are left alone rather than deleted, so
  removing a plugin for an afternoon does not lose how you had it configured.

  The reasoning behind all of it is written down in
  `docs/superpowers/specs/2026-08-27-plugin-api-design.md` and
  `docs/superpowers/specs/2026-08-28-plugin-settings-design.md`.

- **Snippets.** Write your own in `snippets.json` — keyed by language, with a
  `*` bucket that applies everywhere — and they appear in the same picker as
  everything else. `Tab` and `Shift+Tab` move between the fields, `Escape`
  leaves. A body can be one string or an array of lines, so multi-line snippets
  need no escaping, and a `//` key is a comment. **Edit Snippets** opens the
  file with examples in it; saving it in Nox applies it immediately.
- **Language servers can send snippets now, and they expand.** Nox claims
  `snippetSupport` in the handshake, so tsserver, rust-analyzer and gopls
  answer with `console.log($1)` rather than flat text. Until now their
  placeholders were stripped to the default text on arrival — `${1:value}`
  became `value`, with nothing to tab between.

- **Syntax highlighting for the eleven languages Nox named and rendered flat.**
  Go, Java, C, C++, PHP, SQL, XML, YAML, shell, TOML and Ruby have been in the
  language list — in the status bar, in the language picker, matched by file
  extension — since v0.1, and every one of them opened in plain grey. All
  eleven now highlight. Shell, TOML and Ruby use stream parsers, which colour
  the file without building a parse tree, so **Go to Symbol, sticky scroll and
  folding stay empty in those three** — and Go to Symbol now says that, rather
  than reporting a Ruby file full of classes as having nothing in it.
- **Suggestions from the words already in the file**, as the floor under
  everything else. A language with no server — Go, YAML, shell, a plain text
  file, an untitled buffer — now completes from what you have already typed
  in it. It stands down where something better is answering: a language server
  that offers completion takes the question outright, and in a file over 1 MB
  the fallback declines rather than scan it, because at that size the scan
  costs more per keystroke than the list is worth.

## [0.10.0] — 2026-08-26

Language servers stop guessing. This release is mostly about the three things
Nox never said back to them: the settings you wrote, the commands only they can
run, and — the other way round — telling you when one is busy rather than
broken. Quick open also got quicker on large projects, and the file cap that
keeps it that way came down.

### Added

- **Language servers can now read the settings you write for them.** A
  `servers.json` entry takes a `settings` object, and a server that asks
  `workspace/configuration` gets it — pyright reads `python.analysis.*`, gopls
  reads `gopls.*`, rust-analyzer reads `rust-analyzer.*`. All three ask as they
  start, and until now all three silently fell back to their own defaults with
  nothing anywhere saying so. Distinct from `initializationOptions`, which is
  sent once before the server can do anything; this is asked for, whenever the
  server likes. A server with no `settings` block behaves exactly as before.
- **A server that is indexing now says so.** rust-analyzer spends the first
  half-minute on a cold project building its index, during which it is running
  and answers nothing — no hover, no go-to-definition — and the only available
  reading was that it was broken. The status bar now shows what it is doing and
  how far in ("rust-analyzer — Indexing 3/840 20%"). Servers that report no
  progress, tsserver among them, are unchanged.
- **Code actions that are server commands now run.** `Organize Imports`,
  rust-analyzer's refactors and anything else a server carries out itself were
  listed and disabled with the reason "Nox cannot run an action that is a server
  command yet". Nox now sends `workspace/executeCommand` and applies the edit
  the server asks for in reply, by the same rule code actions already used:
  a change to the file at your caret lands directly, one that reaches further
  stages in review.

### Changed

- **Quick open is two to five times faster on a large project.** On a
  16,000-file index a keystroke cost more than a frame — the list was the
  thing making the window feel slow. Typing one character now costs about a
  quarter of what it did, a whole word about half, and a search that matches
  nothing about a fifth. Nothing about the ranking changed: the same files come
  back in the same order.
- **Quick open indexes 14,000 files rather than 20,000.** The number was never
  measured; now it is. At 20,000 the scan took 80–85% of a frame on the machine
  it was measured on, which leaves nothing for a slower one, and the curve is
  flat between 12,000 and 14,000 — those two thousand files are free. **On a
  workspace larger than the cap, files past it will not appear in quick open**,
  which is the cost of the guarantee. `files.excludeFromExplorer` keeps
  `node_modules`, `.git`, `target` and `dist` out of the count, so the cap is
  further away than a directory listing suggests.

## [0.9.1] — 2026-08-24

### Fixed

- **A fresh install no longer opens with an error that isn't one.** 0.9.0
  added a backstop so a crash in the interface could not pass in silence, and
  it was too eager: the browser raises a `ResizeObserver loop` notice when a
  panel measuring itself needs a second pass, which is normal, expected, and
  precisely what start-up does. Nox reported it as *"Something went wrong"* —
  a red message, on first launch, as the first thing a new user saw. Nothing
  was ever wrong. A real failure inside one of those callbacks is still
  reported.

## [0.9.0] — 2026-08-24

Nox could not tell you what went wrong. It can now — and three other things
that were harder than they should have been are not any more: getting back to
the screen that explains the editor, telling Nox what language a file is, and
opening the Git panel from the keyboard.

### Added

- **Nox can tell you what went wrong.** A failure used to leave nothing
  behind: the release window has no console to open, and a toast is gone once
  it is dismissed, so a bug report could only ever be prose. Failures are now
  written to `diagnostics.log` beside your settings, and *Copy Diagnostics*
  puts the version, the platform and the recent failures on the clipboard,
  ready to paste into an issue. Paths are stripped of your home directory
  before anything is written.
- **A way back to the welcome screen.** It has always listed the shortcuts
  worth knowing and the folders you were last in, and it disappeared the
  moment you opened a file — with no way to see it again short of closing
  every tab. *Welcome*, in the Nox menu and the palette, brings it back.
- **Choose what a file is edited as.** The language was guessed from the file
  name when it opened and nothing could disagree, so an unnamed buffer stayed
  plain text until you saved it and an unusual extension stayed unhighlighted
  for good. Click the language in the status bar — or *Change Language Mode*,
  in the Code menu — and pick from the list.

- **The release build is ready to sign for macOS.** Nothing changes for now —
  builds are still ad-hoc signed and a fresh download still needs the `xattr`
  command — but the workflow reads the six Apple secrets when they exist, and
  refuses to build a half-configured one rather than shipping an installer
  whose notes promise a clean first launch it cannot deliver.

- **Quick fixes.** Nox could show you an error and not fix it. `Ctrl+.` (`⌘.`)
  now asks the language server what it can do where you are — add the missing
  import, remove the unused variable, whatever it offers — and lists the
  answers. Choosing one applies it: straight into the file when that is all it
  touches, and through the review panel, hunk by hunk, when it reaches files
  you have not opened. Anything Nox cannot yet run is still listed, greyed,
  with the reason, so the list says what your server actually offered.
- **Take one match out of a replace.** Search results have always been
  dismissable a whole file at a time, which is no help when thirty-eight of
  forty matches are the ones you want. Each match row now has its own `×`, and
  the replace that follows leaves it alone. If the file has changed underneath
  such that the match you protected is no longer where you protected it, Nox
  refuses that file rather than guessing which text you meant.
- **Replace a single match** from its row, without touching the rest of the
  file. Undoes with the same one-step undo a project replace has.
- **Both from the keyboard**, as *Dismiss Search Result* and *Replace Search
  Result*, acting on the focused row. The results list is arrow-key navigable
  and its `×` was mouse-only.

### Changed

- **`Ctrl+Shift+G` (`⌘⇧G`) opens the Git panel.** Every other sidebar panel
  had a shortcut on that pattern and Git was the one that did not, which left
  it the only icon in the rail whose tooltip named no key. The chord used to
  be *Find Previous*, which keeps `Shift+F3` — and one line in
  `keybindings.json` takes the old binding back if you want it.

### Fixed

- **A crash in the interface no longer passes in silence.** Nox listened for
  one of the two ways JavaScript reports a failure and not the other, so a
  whole class of error produced nothing at all — no message, no log, just a
  window that had quietly stopped responding to something. Both are reported
  now.
- **A completion could leave part of what it replaced behind.** When the
  language server asked to replace more than the last word — a path inside a
  string, a longer expression — Nox inserted at the start of the word instead,
  so completing `'src/ut'` gave you `'src/src/utils'`. It now replaces what the
  server named, and falls back to its own judgement only when the text has
  moved since the server answered.
- **A completion list from a server using the newer edit format could vanish
  silently.** One item in the 3.16 `InsertReplaceEdit` shape threw, and took
  every completion for that language with it.

- **The menu bar kept offering a shortcut you had changed.** On Windows and
  Linux, where Nox draws its own menu, rebinding a key left the menu showing
  the old chord — while macOS's native menu, which reloads on exactly that
  event, showed the new one. The bar reads the same table the native menu
  does; it just was not listening for the half that moved.
- **The browser build searched `node_modules`.** The desktop build has always
  pruned machine directories — `.git`, `node_modules`, `target`, `dist` and
  friends — and the in-memory workspace the dev target and every test run
  against did not, so the two disagreed about what a project contains. They
  now share one list and one precedence rule.
- **Auto-import completions inserted the symbol and not the import.** Accepting
  `readFileSync` from the list gave you `readFileSync` and no `import` line —
  code that does not compile, from the feature whose job is to write code that
  does. The import the language server had already worked out was being thrown
  away. It now lands with the completion, in one step that one ⌘Z takes back;
  where the server only computes it on request, the completion appears
  immediately and the import follows, so accepting one never waits on a server.

- **Saving a UTF-16 file wrote a UTF-8 one.** The bytes went out as UTF-8 while
  the status bar still said UTF-16 LE, so a file that had to stay UTF-16 — a
  PowerShell script, a `.reg` file, XML that declares it — quietly stopped
  being one the first time you pressed ⌘S. Nox now writes real UTF-16, with its
  byte-order mark, in the byte order you opened it in. A UTF-16 file you opened
  by picking the charset by hand gains a mark on save, because that mark is the
  only thing that makes it openable again.

- **A settings, shortcuts, notes or session file Nox could not read was
  quietly replaced.** If one of those four files would not parse — a stray
  comma, a half-written save, a disk that lost a block — Nox treated it as
  though it were not there, started from its defaults, and then wrote its own
  file over the top. Every preference, every rebinding, every note in the
  list, gone without a word. Now Nox keeps the old file as
  `settings.damaged.json` (and so on) beside it, and tells you where it went
  and what it means.
- **Unsaved work could be overwritten after a damaged session file.** Text you
  never saved lives in `unsaved-1.txt`, `unsaved-2.txt` and friends, and the
  numbering restarted from 1 whenever the session index would not load — so
  the first file you typed in landed on top of work from the session before.
  The same was true of note bodies. Nox now reads the numbering out of the
  damaged file itself, which still contains it, and carries on above it.
- **A session written by a newer Nox no longer costs you your tabs.** Running
  an older build once used to discard the session outright. It is now kept and
  reported like any other file that could not be read.
- **Windows: editing `.nox/settings.json` had no effect until you reopened the
  folder**, and opening it from the command palette while it was already open
  from the explorer gave you the same file twice, in two tabs, with two undo
  histories and two dirty flags. The path was built with a forward slash on a
  platform that uses backslashes, so two strings that named one file never
  matched.
- **A file open in two panes could be corrupted, marked saved, and written to
  disk.** When anything outside the editor changed such a file — a `git
  checkout`, a formatter, another program — the reload was applied to the
  second pane twice, and a file that had grown came back with a chunk of
  itself repeated. Nox then considered that text saved, so the next ⌘S wrote
  it out. A file that had shrunk failed to reload at all.
- **Every background tab came back on the wrong line.** A pane reported the
  cursor of whatever tab it was *showing* for every tab it held, so the file
  you were reading at line 400 reopened wherever you happened to be typing in
  the tab beside it.
- **Split layouts scrambled a little more on every launch.** If the first pane
  held more than one tab, restoring the session moved its second tab into the
  next pane.
- **Closing a tab in the second pane closed the first one.** ⌘W, the ✕ and
  middle-click all acted on whichever pane came first rather than the one you
  were in, so "close the copy" closed the original — and took the pane with
  it. *Close All Files* left a mirrored file open in the other pane while
  reporting that it was done.
- **A file that is not UTF-8 no longer disappears on restart.** The session
  did not record which charset the file had been read as, so it was reopened
  as UTF-8, refused, and dropped — along with any unsaved work in it.
- **Reopening with a different encoding no longer discards unsaved edits
  without asking.** The command is reachable by clicking the encoding label in
  the status bar, which reads as inspecting a setting rather than throwing
  work away; it now asks first, the way *Reload File from Disk* always has.

## [0.8.3] — 2026-08-22

### Added

- **A collapsed folder now says what changed inside it.** The tree marked
  changed and unsaved files, so folding `src/` over forty changes read exactly
  like folding one over none. A collapsed folder carries the worst git letter
  beneath it — a conflict outranks everything, untracked ranks last — and the
  unsaved dot when a file under it has unsaved edits. Expanding hands the
  summary back to the rows themselves. A gitignored folder is exempt from the
  letter, because git never reports what is inside it.
- **The one folder git names directly is marked at last.** git collapses an
  untracked directory into a single `? lib/` record, and the tree skipped
  markers for every folder — so the one folder git *had* named was the one
  folder that showed nothing.

## [0.8.2] — 2026-08-21

### Fixed

- **Both panes showing the same file reopened on the same line.** Each pane
  now comes back where you left its cursor, so a file you were reading at the
  top and editing at the bottom is still that way after a restart.

## [0.8.1] — 2026-08-21

### Fixed

- **A file you had open in two panes came back in one.** *Open Copy to the
  Side* survived until you quit; on the next launch the second pane was gone,
  with nothing to say so. It comes back now, and both panes are still the one
  file — type in either and the other follows.

## [0.8.0] — 2026-08-21

Three things Nox could not do: show a menu on Windows or Linux, open a file
that is not UTF-8, and put one file in two panes.

### Added

- **Windows and Linux have a menu bar.** There was none at all — every command
  was reachable by palette or keyboard, but nothing was *discoverable*. It
  reads the same table macOS's native menu does, so the two cannot drift, and
  it greys out what you cannot currently do, which the native menu has never
  been able to. F10 focuses it. macOS keeps its own menu, unchanged.
- **Files that are not UTF-8 open.** Nox used to refuse them outright — safer
  than mangling them, but it meant a text editor that could not open a text
  file. UTF-16 with a byte-order mark now opens on its own; for anything else,
  click the encoding in the status bar and say what it is. The file is written
  back in the encoding it came in, and a save that cannot be done faithfully —
  an emoji in a Shift JIS file — stops and tells you instead of quietly
  mangling the text.
- **One file, two panes.** *Open Copy to the Side* shows the file you are in
  beside itself, so you can watch one part while editing another. Both panes
  stay in step as you type, and it is still one file: one set of unsaved
  changes, one undo history, saved once.

### Fixed

- **Notes commands did nothing visible when the sidebar was closed.** Creating
  a note, or pressing ⇧⌘N, chose the notes panel without opening the sidebar to
  show it.
- Dialogs with several choices no longer squeeze them until the labels break
  across three lines.

## [0.7.0] — 2026-08-21

Notes stop being a scratchpad you cannot search and start being somewhere you
can keep things: findable, pinnable, tied to the code they are about, and
readable outside Nox as Markdown.

### Fixed

- **Search could not find your dotfiles.** `.github/workflows/*`,
  `.eslintrc.json` and Nox's own `.nox/settings.json` were skipped by the
  walker, and the panel reported "No results" — which was untrue rather than
  unhelpful. Search now reads them.
- **"Files to exclude" was ignored** whenever "files to include" had already
  matched a file. Excluding `*.test.ts` while including `*.ts` still returned
  the test files.
- **One stray byte from an agent froze the session.** A single character an
  agent's output could not encode ended the reader, and Nox sat on "Working…"
  for the rest of the run — with no way back except quitting. The same byte
  truncated a language server's diagnostics at the point they mattered most.
- **An agent that stops answering now gives up** instead of waiting forever.
- **The file watcher was silently dead** if your project lived under a folder
  called `dist`, `node_modules` or `target` — no reload prompts, no tree
  updates, no warning. Search kept working, so the failure looked arbitrary.
- **A long stream of writes** — a code generator, `tsc --watch` — froze the
  tree, the file index and change detection for as long as it lasted.
- **A conflicted file lost its change marks**, and the diff view blamed it on
  being untracked or outside a repository. Mid-merge Nox now compares against
  your side of the merge and says so.
- **Cancelling a crashed agent, or typing into a terminal whose shell had
  exited, raised a "Something went wrong" toast** for what is an ordinary race.
- Submodules and new folders no longer offer Open and Show Changes in the Git
  panel, where they could only fail. Staging them still works, because it is
  the one action that makes sense.

### Added

- **Notes are searchable, and they can be pinned.** The list showed titles
  only, so a note whose subject was in its body could not be found at all —
  and it got worse with every note you kept. There is now a filter over titles
  *and* bodies that shows you the line it matched on, a pin for the notes you
  keep coming back to, and ⌥⌘N to jump straight to one by name.
- **A note can point at the code it is about.** Select something and *New Note
  from Selection* makes a note holding that code, tied to where it came from;
  the link under the title takes you back. It survives editing — when lines are
  inserted above, the link follows its code instead of quietly pointing at the
  wrong place — and a note whose file belongs to a different folder says so
  rather than disappearing.
- **Notes go in and out as Markdown.** They lived as `note-7.txt` behind an
  index in a config folder, which is a quiet reason not to trust them with
  anything that matters. Export writes one readable `.md` per note into a
  folder you choose and import reads a folder back in. Importing always adds,
  so bringing in your own backup cannot overwrite what is already there.
- **You can see what you granted an agent, and take it back.** Everything
  "Allow for this session" remembered was previously invisible, and the only
  way to revoke it was to undo the agent's work — so in practice grants stood
  until Nox restarted. The Agents panel now lists them, and revoking leaves
  every line the agent wrote in place.
- **The file tree shows what changed and what is unsaved.** Modified,
  untracked and conflicted files carry their git letter; a file with unsaved
  edits carries a dot. Previously you had to open the Git panel to learn
  anything had changed and look at the tab strip to learn what was unsaved.

### Fixed

- **Notes commands did nothing visible when the sidebar was closed.** Creating
  a note, or pressing ⇧⌘N, chose the notes panel without opening the sidebar to
  show it — which reads as a broken command rather than a hidden panel.
- **The status bar no longer names a language server that has nothing to do
  with your file.** Opening `main.py` with a TypeScript server running left it
  reading `typescript-language-server`. It now names the server for the file
  in front of you, and says `Python — no language server configured` when
  there is none, with somewhere to click.

## [0.6.0] — 2026-08-21

A pass over how discoverable Nox is, driven by an audit of the packaged app
rather than the browser dev target — where more than half the UI is switched
off and so had never been looked at.

### Added

- **A native menu bar on macOS**, generated from the command table rather than
  hand-listed, so a command cannot be registered and then be missing from it.
  Until now the menu was Tauri's default and carried none of Nox's ~140
  commands, which left the palette as the only index of what the app can do.
- **An editor context menu.** Right-clicking in the code surface showed
  WebKit's own menu — Reload, Services, Look Up. It now offers Go to
  Definition, Find References, Rename Symbol, Format Document, comment
  toggling, Select All Occurrences and Show Changes, each showing its chord.
- **Visible ways into the terminal and the agents panel.** Both were reachable
  only by a shortcut you had to already know, and the terminal shipped a Hide
  button with no corresponding Show.
- **Nox remembers your window size and position**, clamped to the display it
  actually opens on.
- **Merge conflicts are named.** A conflicted file used to render exactly like
  one you had edited yourself, with a live stage button; staging it staged the
  conflict markers. Conflicts now get their own section and refuse to stage.
- **Advanced settings can be browsed**, not only found by typing the right word.

### Fixed

- **The command palette ran the wrong command.** Results were scored on the
  rendered `"Category: Title"` string and sorted on score alone, so ties fell
  to registration order. Typing `undo` and pressing Enter ran *Undo the Last
  Agent Session* — which reverts an agent's edits across several files with no
  confirmation — instead of *Edit: Undo*.
- **The permission prompt defaulted to granting.** `danger` sat on *Deny*, so
  both the safe-choice focus rule and the primary styling landed on *Allow for
  this session*. Pressing Enter on reflex granted a session-wide capability.
- **Unsaved work could be abandoned silently.** A failed backup write was
  recorded as if it had succeeded, after which that buffer's unsaved text was
  never written again.
- **A failed command said nothing at all** — no toast, no dialog, console only,
  in a build with no devtools. Settings, keybinding and session write failures
  were equally silent.
- **The terminal opened 32px tall** regardless of the configured 260px, and its
  edge was not draggable.
- **The Welcome screen clipped the shortcuts it exists to teach**, and led with
  the action a new user is least likely to want.
- **Search results rendered all at once** — up to 5000 matches — so the panel
  slowed down exactly while results were arriving.
- **The focus ring was effectively invisible** at 1.62:1, on a keyboard-first
  editor. Shortcut hints sat below the legibility threshold too.
- **Fullscreen left a dead gap** on macOS where the traffic lights had been.
- Diff added/removed lines no longer rely on colour alone, and the tab strip
  answers arrow keys.


## [0.5.1] — 2026-08-20

The first signed release. No feature changes: this exists so that updates can
be verified, which nothing before it could do.

### Changed

- **Nox can now verify an update before installing it.** The operator's
  signing key ceremony is done, so releases from here on carry a signed
  `latest.json` and every download is checked against the public key built
  into the app. Until now the updater ran and found nothing, because there
  was nothing signed to find.
- **This is the first build that can verify anything.** The public key is
  compiled into the binary, and every build before this one carries an empty
  one — so **0.5.0 and earlier cannot auto-update, ever.** Install this
  release by hand, once; from here on *Check for Updates…* works, and an
  update installed through it skips the macOS quarantine ritual that a fresh
  download still needs.

## [0.5.0] — 2026-08-20

### Added

- **The explorer stays fast in a big project.** It now renders only the rows
  on screen, so a folder with tens of thousands of entries scrolls like one
  with thirty. Nothing about using it changes: the same rows, the same
  keyboard, the same drag and drop, and the scrollbar still describes the
  whole tree. Small folders are rendered whole exactly as before — below a
  couple of hundred rows the bookkeeping would cost more than it saves.
  - Arrowing to a row that is off screen scrolls to it by arithmetic rather
    than by asking the browser to scroll an element into view, which is what
    lets it work for a row that is not currently drawn at all.
  - Screen readers are told the size of the *tree*, not the size of the
    window — every row now carries its true position in the whole list.

- **A project can carry its own conventions.** Nox now reads
  `.nox/settings.json` from the folder you have open and layers it over your
  own settings, so a repository that indents with four spaces indents with
  four spaces for everyone who opens it — without touching what you prefer
  everywhere else. Close the folder and your own values are back.
  - **Only eight settings can come from a project**, and they are the eight
    that describe the *code*: tab size, spaces-vs-tabs, auto indent, word
    wrap, trim trailing whitespace, insert final newline, format on save, and
    what to hide in the explorer. Everything else — your theme, your fonts,
    your terminal, your save habits — is yours and cannot be set by a folder.
  - **This is an allowlist, not a blocklist, and `terminal.shell` is the
    reason.** A settings file arrives with a cloned repository, written by
    whoever wrote the repository. Nothing that names a program, a path or an
    address will ever be settable from one.
  - A setting a project owns is shown in Settings with a **Workspace** badge
    and its control switched off, because a switch that cannot change
    anything is worse than no switch. The footer offers **Workspace
    settings**, and the new **Open Workspace Settings** command creates the
    file if it is not there and opens it as an ordinary tab.
  - The file is watched: editing it — in Nox or anywhere else — applies
    straight away, with no reload and nothing to press.
  - A missing, unreadable or corrupt file means "no project settings",
    silently. It is often written by someone who is not you, and a warning
    you cannot act on is worse than nothing.

- **You can change the keys.** *Keyboard Shortcuts* (⌘⌥K) is no longer a
  reference — it is an editor. Every command has a row, including the ones
  with no key at all, which read *Unassigned* until you give them one. Hover
  a row and press the keyboard button, then press the chord you want: the
  panel shows it back to you, `↵` accepts, `Esc` cancels.
  - **A key already in use is named before you take it.** The well says
    which command holds it, and the button reads *Rebind, and unassign* —
    accepting takes the key away from the old owner rather than quietly
    shadowing it, so what the list shows is always what runs.
  - **Reset is per command, and only appears where something changed.**
    *Reset all* shows in the header once anything is customised and
    disappears when nothing is.
  - Customisations live in **`keybindings.json`** beside `settings.json`, as
    rules layered over the defaults rather than a copy of them — so a Nox
    that ships a new default key picks it up, and a corrupt file costs your
    rebinds rather than the editor's boot. The file is hand-editable:
    `{ "chord": "…", "command": "…" }` adds one, `"remove": true` takes a
    default away.
  - The **Editor** section — undo, cut, paste, multi-cursor — stays
    read-only and now says why: those keys are CodeMirror's, and binding
    them in two places would mean two owners racing for the same keystroke.

- **Stage, commit, branch.** A Git panel in the sidebar — a focused view, not
  a full client. Files you have touched are listed staged and unstaged, each
  with a stage/unstage button (+/−); write a commit message and **Commit**
  lands it; the command palette gets a branch picker with no prefix of its
  own, listing local branches and offering **Create branch…** first. Open it
  from the palette (**Show Git**) or the rail.
  - Six git commands underneath, all argv-fixed — `status`, `branch`, `add`,
    `reset`, `commit`, `switch` — never a shell, and a refusal comes back in
    git's own words rather than a translated one.
  - **Unstage runs `git reset -- <pathspec>`**, not `restore --staged`: the
    latter fails on a repository with no commits yet ("could not resolve
    HEAD"), found by running both against a real repo. The working tree is
    never touched either way.
  - **The commit message goes over stdin**, never argv, so quotes, a lone
    `--`, or a second paragraph are all safe.
  - **Switching or creating a branch validates the name first**
    (`git check-ref-format`), and switching over a file a target branch would
    overwrite is refused — git's decision, shown as git makes it.
  - **`.git`'s `HEAD` and index are now watched directly** — targeted,
    non-recursive, debounced — closing the blind spot the git gutter has
    documented since it shipped: a stage, unstage or commit made in a
    terminal now reaches the panel and the gutter on their own, no
    **Refresh Git Gutter** required.
  - What this is deliberately not: no push, pull, fetch, rebase, amend or
    force, and no discard, stash or `checkout --` — the working tree stays
    untouchable by construction of the commands chosen. Hunk-level staging is
    its own later step.


- **Nox can update itself.** Ten seconds after launch (behind a new
  Workbench setting), or on *Check for Updates…*, Nox asks the newest
  published release whether a newer build exists and offers it in a
  toast. Nothing downloads or installs without the click — which also
  restarts into the new version with your tabs and unsaved work
  restored. Updates skip the macOS quarantine ritual; first installs
  still need it until code signing arrives. Settings now shows the
  running version in its footer. Requires the operator's one-time key
  ceremony before releases carry update artifacts.
- **The conveniences your hands expect.** Right-click a tab: Close Others,
  Close to the Right, Close Saved, Copy Path, Reveal in Explorer, Split —
  and closing never discards silently; dirty tabs get their save prompt.
  Two files with the same name now tell themselves apart by their folder.
  A scrolled tab strip shows edge fades and a slim scrollbar on hover. The
  status bar counts errors and warnings and clicking it opens Problems;
  clicking the line-endings item switches LF/CRLF, and the file honestly
  reads as unsaved until you save it. The Problems rail icon carries the
  error count; clicking the active rail icon collapses the sidebar (⌘B
  brings it back); References has its own icon at last. The palette floats
  your recently used commands to the top, shows which keyword matched when
  the title didn't, and stops reporting a capped list as the total. Toasts
  can carry a button now — "changed on disk" offers *Reload from Disk*.


- **Show Changes.** The active file against its git base, side by side or
  inline — pick in the view or in Settings under *Diff Layout*. Open it
  from the palette or by clicking any mark in the git gutter. Long
  unchanged stretches fold to a count; click one to see the whole file.
  The view follows you between tabs, and it is read-only on purpose:
  editing belongs in the editor, and putting hunks back belongs to
  staging, which is next.


- **Git gutter.** Lines that differ from what git holds are marked beside
  the code: green for a new line, amber for a changed one, a red tick where
  lines were deleted. The comparison is against the index — what `git add`
  would leave alone — and the marks follow your typing between refreshes.
  Nothing watches `.git` yet, so after a commit or stage made in a terminal
  the gutter catches up when you switch back to the file, or on **Refresh
  Git Gutter** from the palette. Turn it off with *Git Gutter* in Settings.
  No repository, an untracked file, or no git installed simply means no
  marks — never an error.

### Changed

- **One visual language across the panels.** The sidebar panels now share
  one header (a real heading, sized and tracked the way the design system
  always said) and one empty-state shape — and an empty state that has a
  one-click way out now shows the button: Problems offers *Configure
  Language Servers*, Search offers *Open Folder*, Notes offers *New Note*.
  Buttons and text fields across the review panel, diff view, agent panel,
  terminal bar, find, settings and prompts share one style each instead of
  nine hand-rolled variants. The status bar's activity pulse and the
  explorer's refresh spinner now respect reduced-motion settings.

### Fixed

- A round of paper cuts from a full UI audit: review hunk cards and the
  diff table get their borders back (two design tokens had never been
  defined, so those rules were silently dropped); the diff view's header
  buttons are buttons again instead of bare text; the Problems and
  References lists can be reached by keyboard (`⌘⇧M` now opens Problems)
  and show hover states; long paths no longer push counts off-screen, and
  every row carries its full text as a tooltip; hovering a tab with unsaved
  changes keeps its dot until the pointer is on the close button itself;
  dragging a tab past the end of the strip now shows the drop indicator;
  confirm dialogs focus the safe choice whenever a destructive one is
  present, so Enter never deletes by default; and a burst of routine toasts
  can no longer push an unread error off the screen.

## [0.4.3] — 2026-08-19

### Added

- **Find References.** `Shift+F12`, or the command from the palette, lists
  every place the symbol under the cursor is used — in a **References** view
  in the sidebar, one row per file and one per use showing the line it is
  on. Click a row, or arrow to it and press Enter, and Nox goes there,
  opening the file if it has to. The declaration is in the list too, so you
  never need Go to Definition to complete it. The cursor stays where it was
  when the list opens: twenty places is a choice, and the editor should not
  make it for you.

- **Rename Symbol.** `F2`, or the command from the palette, asks for a new
  name and then shows you every edit the language server proposes — in
  every file, as a diff in the review panel — before a single one is
  written. Apply, and it lands as one change: one undo takes the whole
  rename back across every file, and a file you typed in while reviewing is
  refused rather than overwritten. Where the server can say so, a keyword or
  a library symbol gets "nothing to rename here" instead of a prompt. The
  files it touched are opened and left unsaved, like every reviewed change;
  **Save All** writes them.

- **Format Document**, and **Format on Save.** `Shift+Alt+F` asks the
  language server to format the file and applies the answer as one change —
  one undo takes it back. Turn on *Format on Save* in Settings and the same
  happens just before each save, with the editor's own tab size and spaces
  setting. The save never waits more than two seconds for the formatter and
  never fails because of it: a slow server means a saved file and a note
  saying it was saved unformatted; a keystroke while the server is thinking
  wins over the format. Not run under after-delay Auto Save, which would
  reformat under your cursor.

### Changed

- **Go to Definition with several answers** now goes to the first and lists
  them all in the References view, instead of going to the first and saying
  how many there were. Same jump, no more guessing which of the others you
  wanted.

## [0.4.2] — 2026-08-19

### Added

- **Go to Definition.** `F12`, or the command from the palette, asks the
  language server where the symbol under the cursor is defined and takes you
  there — opening the file first if it is another one, and selecting the
  name so the landing is visible on a line you have never seen. When the
  server offers several places, Nox goes to the first and says how many
  there were; a list to choose from arrives with find references, which
  needs the same one.

- **Hover.** Rest the pointer on a symbol and Nox shows its type and
  documentation. The tooltip stays while the pointer is anywhere over the
  span the server names, and goes when it leaves.

  The server's markdown is shown as text rather than rendered as HTML. A
  language server is a program you configured Nox to run, and what it says
  about your code is derived from that code — which you may well have cloned
  from someone else. Turning that into live HTML inside an editor with
  filesystem access is not a trade worth making for italics, so `**bold**`
  appears as you see it here.

- **Completion from the language server.** Type `console.` and the members
  appear, with the kind icon and the signature the server reports. It triggers
  on the characters the server itself asks for, and documentation is fetched
  for whichever suggestion you have highlighted — `typescript-language-server`
  sends none up front, so fetching it lazily is the only way to see it at all.

  **Tab** accepts the highlighted suggestion. With no picker open it still
  indents, as it always did — one key, two jobs, no mode to remember.

  Snippets are not supported yet. A server offering `foo(${1:arg})` gets
  inserted as `foo(arg)` rather than with the placeholder syntax intact,
  because the alternative is `${1:arg}` appearing in your file.

- **Language server support.** Nox can run a language server and show what it
  says about your code: squiggles under the problems, marks in the gutter, and
  the server's own name in the status bar. Run **Configure Language Servers**
  from the palette to create `servers.json` — it arrives with a working
  `typescript-language-server` entry — then **Reload Language Servers**.

  Nothing starts on its own. Nox does not go looking for a server on your
  `PATH`, because starting a process is the most powerful thing it does on your
  behalf and it should be something you asked for. A server that fails to start
  says so twice over — a notification carrying the server's own explanation,
  and a yellow marker in the status bar whose tooltip keeps it — rather than
  leaving you wondering why nothing is underlined.

  Two things worth knowing about `typescript-language-server` specifically. It
  does not bundle TypeScript — it looks for the `typescript` package in your
  workspace or beside its own install. And it needs `lib/tsserver.js`, which
  **TypeScript 7 no longer ships**, so a global install wants
  `npm install -g typescript@6` rather than plain `typescript`. Either way the
  server refuses to start and explains why, which Nox now passes straight
  through to you.

  If you would rather not touch your global TypeScript, an entry in
  `servers.json` can point the server at one directly:

  ```json
  { "languages": ["typescript"], "command": "typescript-language-server",
    "args": ["--stdio"],
    "initializationOptions": { "tsserver": { "path": "/path/to/typescript/lib/tsserver.js" } } }
  ```

  The **Problems** panel in the sidebar lists everything at once, grouped by
  file and driven with the arrow keys. It includes files you never opened —
  which is usually where a project's real errors are.

## [0.4.1] — 2026-08-17

### Added

- **Windows builds.** The release now produces a Windows installer alongside
  the macOS and Linux packages, so Windows is a platform you can download
  rather than one you have to compile. It is ad-hoc built rather than signed,
  so SmartScreen warns on first run — the same trade already made on macOS,
  where the app is ad-hoc signed and has to be un-quarantined by hand.
  - The first Windows installer was attached to 0.4.0 by hand, built from
    that release's source once there was a runner to build it. From 0.4.1 it
    is produced by the release build like every other package.

### Fixed

- **Windows no longer shows two title bars.** The window kept its native bar
  above Nox's own, so the top of the app was a grey strip belonging to the OS.
  `titleBarStyle` and `hiddenTitle` — the settings that hide it — are macOS-only
  and Windows ignores them, which is why it survived into the first Windows
  build. The decorations are now switched off there, and the Nox title bar
  carries minimise, maximise/restore and close itself.
  - The maximise button follows the *window*, not its own last click, so it
    still reads correctly after the keyboard shortcut, a double-click on the
    bar, or a Windows snap layout.
  - Close runs the same shutdown path the OS button did, so unsaved work is
    still written to the session on the way out.
  - macOS is untouched: its traffic lights sit over an overlay title bar, and a
    second set of buttons beside them would be duplicate chrome.

## [0.4.0] — 2026-08-17

### Added

- **The breadcrumb navigates.** The trail in the title bar has shown where you
  are since v0.1; now clicking a folder in it opens the explorer, expands that
  folder, and scrolls to it. Clicking the file at the end reveals the file,
  which is what **Reveal in Explorer** already did.
  - Segments of a file outside the workspace are not clickable. There is
    nothing to reveal into — the explorer watches one root — and a button that
    takes the click and does nothing is worse than plain text.
- **Sticky scroll keeps the enclosing declaration on screen.** Scroll into the
  body of a long class or function and its header stays pinned above the
  editor instead of scrolling out of view. Click a pinned row to jump to it.
  Off with `editor.stickyScroll`.
  - Declarations only — classes, functions, methods, interfaces, CSS rule
    sets. Never `if`, `for` or other control blocks: it reads the same rule
    table ⌘R (Go to Symbol) uses, so the two can never disagree about what
    counts as structure.
  - It is a strip above the editor, not an overlay on top of it, so it costs a
    row of height rather than covering the last line of the document.
  - **Markdown headings never pin, so sticky scroll shows nothing in `.md`
    files.** A symbol pins only when its declaration is above the top visible
    line and it still encloses that line; a heading spans only its own line,
    so it never encloses anything below it. CSS rule sets are unaffected,
    since a rule set spans its whole block.
- **Replace can keep the case it is replacing.** Turn on the `AB` toggle and a
  single replacement string comes back shaped to each match it lands on:
  searching `scheduler` case-insensitively and replacing with `dispatcher`
  writes `dispatcher`, `Dispatcher` and `DISPATCHER` on the three lines that
  spelled it three ways. Off by default, and in both ⌘F and ⌘⇧F.
  - **Three shapes, and no fourth.** all lower, Capitalized, ALL UPPER. A match
    that is none of them — `sChEdUlEr`, `scheduleR` — is written verbatim
    rather than guessed at. Irregular casing is deliberate often enough that
    rewriting it is worse than leaving it, and there is no rule that would be
    right.
  - Capitalising touches the first character only, so `dispatcherService` stays
    `DispatcherService`. A lone capital reads as capitalised rather than as a
    shout — `S` gives `Dispatcher`, `SS` gives `DISPATCHER` — and a match with
    no letters in it at all, like `123` or `---`, is left alone.
  - **Independent of Match case**, deliberately. The two are about different
    things, and a toggle that silently disables another is worse than a
    predictable one.
  - Under regex the shape is read from the *expanded* replacement, never the
    template. Casing the template would rewrite `$<word>` to `$<WORD>`, which
    names no group and resolves to nothing — silent data loss in the one part
    of the editor that can destroy work.

### Changed

- **Reveal in Explorer now selects what it reveals.** It expanded the tree to
  the file and left the selection alone, which was only invisible because the
  explorer follows the active tab by itself. A folder revealed from the
  breadcrumb has no such effect behind it, and one that expands without being
  selected can open entirely off-screen.

### Fixed

- **The window can be dragged by its title bar.** It never could — not since
  v0.1. Two things were wrong at once, and either alone was enough: the app
  never requested `core:window:allow-start-dragging`, so the backend refused
  every drag the front end asked for; and the drag regions were declared bare,
  which in Tauri means "drag only when this exact element was clicked", so even
  once permitted only the empty slivers between the logo, the breadcrumb and
  the buttons would have worked.
  - Dragging by the traffic-light corner always worked, because macOS moves the
    window itself there without asking the app. That is why this survived
    unnoticed for two releases.
  - The buttons in the bar still take their clicks rather than starting a drag.
- **Enter in the find fields no longer types into your file.** Pressing Enter
  in the Find field steps to the next match, and it used to hand keyboard
  focus to the document at the same time — so the *second* press, the one
  that should have gone to the second match, inserted a newline into the file
  instead. Enter in the Replace field did the same thing, one keystroke after
  editing the document, which is the worst possible moment to lose the caret.
  Both now leave focus where you are typing, so Enter repeats.
  - The editor still gets focus back where you would expect it: Escape closes
    the panel and returns it, and **Select All Occurrences** takes it
    deliberately, because it exists to hand you a cursor per match.
  - The match you are on stays legible while the editor is unfocused — it
    carries its own highlight, and the theme has always had a separate,
    dimmer selection colour for exactly this.

## [0.3.0] — 2026-08-16

### Added

- **Go to Symbol.** <kbd>⌘R</kbd>, or `@` in the command palette, lists the
  functions, classes, methods and headings in the file you are looking at.
  Type to narrow, Enter to jump.
  - A method reads as `Class.method`, so you can type either half to find it.
    Four classes with a `render` each give four rows you can tell apart.
  - Structure only: functions, classes, methods, interfaces, type aliases,
    enums, modules, CSS rule sets and Markdown headings. Not variables, not
    imports — a list you have to scroll is a list that failed.
  - It reads the same grammar syntax highlighting uses. A file in a language
    Nox has no parser for says so rather than coming back empty, and one
    whose grammar is still loading — the moment just after a file opens —
    says that instead. Neither is the same answer as "there is nothing in
    this file".
  - On a large file the list is only as far as the parse has reached. Nox
    spends up to 100 ms finishing the parse first, and when that is not
    enough it says the file is still parsing rather than presenting a short
    list as the whole file. Ask again once it has had time and you get the
    rest.

- **Local models.** Point Nox at an Ollama server in `agents.json` and an
  agent can read your workspace and propose a change set, reviewed hunk by
  hunk before anything is written.
  - It runs entirely on your machine. No account, no telemetry, and the HTTP
    client refuses anything that is not loopback.
  - The agent can read and propose. It cannot run commands.
  - Edits are quoted, not positional: the model names the text to replace and
    Nox finds it in what the model read, refusing anything ambiguous rather
    than guessing. If you edit the file after the agent read it, the proposal
    is refused rather than applied at offsets that have moved.
  - When the server is unreachable or rejects the request, the session ends
    failed and says which — naming the host, or repeating the server's own
    message. A model you have not pulled says so.
  - A session that runs out of turns says so; one whose model cannot follow
    the format, or whose edits are refused twice over, ends failed with the
    reason. None of them report success.

- **A terminal.** A real pty rather than piped stdio, so programs see a
  terminal and behave like it: colour, line editing, job control, and `vim` or
  `less` actually run. <kbd>⌃`</kbd> toggles it, or **Toggle Terminal** in the
  palette.
  - It sits *below* the editor rather than taking it over — watching a build
    fail next to the code that failed is the entire point.
  - Hiding the panel does not kill the shell, and the scrollback survives:
    closing a terminal to glance at a file should not lose a build log.
  - Colours come from the same token file as everything else, so it follows
    Eclipse and Umbra without a second palette to maintain.
  - `terminal.shell`, `terminal.fontSize`, `terminal.scrollback` and
    `terminal.height` are in Settings. Empty shell means your login shell.
  - The browser build says it has no terminal rather than showing a dead one.

- **Notes.** A third sidebar section for your own notes — a list, and an
  editor for the one you pick. <kbd>⌘⇧N</kbd>, or **Show Notes** in the
  palette.
  - They are not workspace files and are stored outside any project, so
    opening a different folder never changes or hides them.
  - Always saved, a moment after you stop typing. There is no save button and
    no setting: a preference that stops saving your notes is a preference that
    loses them.

- **Change marks.** Lines changed by a project replace, an agent or a plugin
  carry a quiet bar in the gutter, and hovering says who changed them and why.
  **Go to Next Change** walks them.
  - Typing in a marked region clears the mark there, so the gutter decays as
    you review rather than accumulating all session.
  - Marks last for the session. Persisting them would mean attribution that a
    `git checkout` could silently make wrong.
  - **Show Change Marks** turns the gutter off for anyone who finds it noisy.

- **An agent can say which revision it computed an edit against.**
  `proposal.stage` takes an optional `baseRevisions` — buffer id to the
  revision `context.openBuffers` reported — and any entry the buffer has since
  moved past refuses the whole proposal instead of applying it at offsets that
  have shifted.
  - It closes two cases Nox could not otherwise see: an agent that stages
    against a length it read from a listing, and one that keeps offsets from an
    earlier read after re-reading the file.
  - A declared revision for a file the edits do not touch is checked too. An
    agent that read a file and decided from it not to change that file has a
    decision that goes stale when the file does.
  - It is checked in addition to the existing freshness check, never instead
    of it, and a malformed declaration refuses the proposal rather than being
    quietly ignored.
  - It is optional. Agents written before this still work and are exactly as
    covered as they were; `examples/uppercase-agent.mjs` shows the field in
    use.

- **Edit Selection with a Model…** A command for a two-line change: select
  text, say what to do with it in your own words, and the answer comes back
  through the same review panel a full agent session uses. Enabled only when
  there is a selection and a runnable agent is configured.
  - The selection reaches the model as part of the session's context, so it
    knows what you were looking at without a round trip to ask. A plain **Run
    Agent…** benefits too — any session with text selected now tells the
    model where the user is looking.
  - Hunks outside the selection are still proposed, never refused, but start
    **unkept** and labelled *outside your selection* — a companion edit
    elsewhere in the file is often the right one, and this only changes which
    box starts checked. A plain **Run Agent…** session is unaffected: every
    hunk there still starts kept.
  - **Expect a partial edit.** Asked to do two things in one instruction, a
    local model will often do only one and stop — confirmed walking the
    feature against a real one, which rewrote the selected code correctly and
    left a second, explicitly requested change untouched. Read the diff
    rather than assuming the instruction was carried out in full.

- **Explain Selection** and **Ask About Selection…** Select some code and ask
  what it does: **Explain Selection** asks for you and skips the dialog,
  **Ask About Selection…** takes your own question. The answer comes back as
  prose in a new **Answers** section in the sidebar (<kbd>⌘⇧A</kbd>) — not as
  a diff, and not through the review panel.
  - An answer says which file and lines it was about, and marks itself *the
    code has changed since* when that text has been edited, or *file is
    closed* when the buffer is gone. An explanation of code that has moved on
    is worse than no explanation, and a file you closed is not the same thing
    as one you edited. It is a label and never a refusal: the answer is still
    the answer, and you decide what it is worth.
  - **An explain session cannot change anything.** Everything but prose is
    refused by the runtime, not discouraged in the prompt — so it holds for an
    agent running in another process too. Such a session cannot read a file,
    run a command or propose an edit.
  - Answers last for the session and are not written anywhere, for the reason
    change marks are not: an explanation kept past the code it described is
    attribution that has quietly gone wrong.
  - **The answer arrives all at once**, not word by word. There is no partial
    text to watch: for however long the model takes, the entry says only that
    it is working, and the whole answer appears when it lands.
  - **Expect a partial answer**, for the reason to expect a partial edit.
    Asked to explain some code *and anything surprising about how it does it*,
    qwen2.5-coder:7b gave a correct account of what the function does and
    never addressed the second half. Same shape as the partial edit above, on
    a command that hands you no diff to check it against.
  - Prose is rendered as text with its line breaks kept, plus triple-backtick
    fenced runs as monospace blocks. Nothing else: no headings, no emphasis,
    no links, no HTML, and no new dependency to sanitise model output with.
    Other markdown arrives as the characters the model typed. An opening fence
    whose info string has a space in it (`js title=foo` rather than `js`)
    leaves that string in the block rather than dropping it — the splitter
    would rather show you a stray line than eat one.
  - Clicking the file and lines an answer was about opens that buffer, unless
    it has been closed. Reopening the file does not revive the link: buffer
    ids come from a counter rather than a path, so the reopened file is a
    different buffer and the entry goes on saying *file is closed*.
  - The section is not there at all until you have configured an agent that
    can run. Remove the last one and it goes away again, and the sidebar falls
    back to the explorer rather than showing a panel the rail no longer has a
    button for.

### Fixed

- **What a session handed the model was missing from its own record.** The
  opening brief embeds your selected code — up to 8,000 characters — and
  reached the context service directly, so none of it appeared in the read log
  or in the session's trail in the Agents panel. It now reads through the same
  recorded path everything else does, and a session shows what its brief
  carried before the agent asked for anything.

- **A project-wide replace marked whole files as changed, not just the lines
  it touched.** Replace collapsed every match in a file into one edit spanning
  the whole document, so provenance — which marks whatever a change set
  actually inserted — saw one insertion covering the entire file. Replace now
  emits one edit per match, at the positions it already computed, so only the
  matched spans carry a mark.
- The reference-agent test and two documentation links pointed at
  `examples/agents/uppercase.mjs`, which has been
  `examples/uppercase-agent.mjs` since v0.2 was tagged. The test spawned a
  path that did not exist and had been failing since the release commit.
- Config files are written atomically, so a crash part-way through a save can
  no longer truncate your settings, session or notes.
- **A session's brief named a buffer but never gave its id.** Every
  `context.*` method addresses a buffer by `bufferId`, and the brief showed
  only a file's name — so a model that used the name it was shown got
  *"Buffer shapes.js not found."* back, and kept retrying it. Walking **Edit
  Selection with a Model…** against a real one, it did that eleven times and
  stopped at the turn cap having staged nothing. The brief now renders
  `name [id]` everywhere it names a file.

- **Asking a model to explain something reported the model as broken.** The
  local-model loop required every reply to carry a JSON action, so a model
  that answered a question in prose — the correct thing to do — was told twice
  that it was wrong, and the session ended failed with the explanation filed
  in the trail as narration, where nobody would look for an essay. Nox now
  says which kind of reply it wants, and a prose answer takes one round trip
  with no parsing at all. No scripted test could have found this: a test
  provider yields the actions its test wrote, so none of them can reach a turn
  that produced none.

### Changed

- CI builds and tests on every push, and a tag now produces macOS (Apple
  Silicon and Intel) and Linux binaries rather than Apple Silicon alone.
- Linux ships a `.deb` and an `.rpm`, both around 3 MB. The AppImage is gone:
  it bundles its own GTK and WebKit and came to 77 MB, which is not an
  editor that claims to be about 4 MB.
- A tag that disagrees with the version in `tauri.conf.json` is now refused.
  The bundler names assets from the config rather than the tag, so the two
  drifting apart shipped binaries labelled with the wrong release.
- The `run` message an out-of-process agent receives may now carry `expects`,
  which is `"prose"` when Nox wants an answer rather than actions. It is
  optional and every agent written before it behaves exactly as it did. An
  agent that ignores it is not a hazard — its non-prose requests are refused
  with `invalid-request`, and each refusal is recorded in the session's trail —
  but it may produce a session holding nothing except those refusals, which is
  a limitation rather than a guarantee to rely on.
- A buffer's revision is published on its snapshot rather than only through
  `revisionOf(id)`. The method answers the same question, but a method call is
  not something a component can subscribe to, so anything that has to notice
  an edit as it happens — the staleness mark on an answer is the first — needs
  the number in a list it is already watching. Purely additive.
- Component tests can now mount a real Svelte component. `tests/support/`
  mounts one with a real `NoxApp` in context and tears it down through
  Svelte's own unmount, and a suite opts into a DOM with
  `// @vitest-environment jsdom` on its first line — Node with no DOM stays
  the default everywhere else. `AnswersPanel` is the first component covered,
  pinning the newest-first ordering that `tests/answers.test.ts` could not
  reach on its own — see `ARCHITECTURE.md` §7 for what the harness still
  cannot reach. One line in `vite.config.ts`, gated on `VITEST` and inert
  outside tests. No user-visible change.

## [0.2.0] — 2026-08-13

### Added

- **An agent runtime, and a record of everything it does.** Agents connect over
  a defined protocol and can only change things the way you can: through
  commands, under the permission model, as a change set you review first.
  - The **Agents** panel lists every session with what it read, what it ran,
    what it was refused, and what it proposed — and one button that takes back
    everything a session landed, across every file.
  - A refused action stays in the record. What an agent *tried* is as worth
    seeing as what it managed.
  - Two agents on the same file cannot corrupt it: whichever is working from a
    version that has moved is refused, rather than being locked out or queued.
  - **No model provider ships with Nox.** The interface is vendor-neutral by
    design and the core names no vendor; a provider plugs into it. Until one
    does, the panel says so instead of pretending.

- **Saving can no longer truncate a file.** Writes go to a temp file beside
  the target, are flushed to the disk, and are then renamed into place — so a
  crash, a power cut or a full disk part-way through leaves the previous
  version intact rather than an empty file. Permissions are preserved, and a
  symlink is written *through* rather than replaced.

- **Agents can run as separate programs.** An agent is any executable that
  reads and writes one JSON object per line on stdin and stdout — a shell
  script, a Python file, whatever you like. Nox starts it, supervises it, and
  shows what it did in the Agents panel like any other session.
  - [`examples/uppercase-agent.mjs`](examples/uppercase-agent.mjs) is a
    complete working agent in about eighty lines, meant to be copied.
  - A crash, a hang at startup, or garbage on the wire fails the session with
    the agent's own error message rather than leaving it stuck.
  - An agent cannot start another agent. Only you can.

- **Review changes before they touch your files.** A proposed change set is
  staged rather than applied: the editor area shows it as a diff, file by file
  and hunk by hunk, and you keep or reject each one.
  - Nothing is written until you press Apply, so discarding costs nothing and
    there is never a moment where half a change is in your files.
  - What you keep lands as a **single** change, so one <kbd>⌘Z</kbd> takes the
    whole reviewed result back.
  - If a file changes while you are reviewing, Apply refuses rather than
    overwriting it — and the review stays open, so your decisions are not lost.
  - Everything starts kept. Review is for catching the wrong ones.

- **Two flaky tests.** The folding suite asserted against however far
  CodeMirror's time-budgeted parser had got, and two agent helpers counted
  loop iterations instead of measuring elapsed time — so both failed under CPU
  load and passed on an idle machine. The suite now runs clean repeatedly with
  the machine saturated.

- **An agent could only be run once per window.** The desktop shell kept a
  finished agent registered under its process id forever, so after a window
  reload the next one was refused with *"an agent with id proc-1 is already
  running"*. Ids are now released when the process exits, are unique to each
  load of the window, and any agent still running is stopped when the window
  goes away rather than orphaned.

- **A finished agent session said "Awaiting review" forever.** It now says
  **Applied** once you keep any of its changes, or **Dismissed** if you turn
  the proposal down.

- **Reload Window** (from the palette). The desktop shell wires no reload of
  its own, so there was no way to get a clean slate short of quitting. Unsaved
  work survives it; agent sessions and the transaction log do not, which is
  why it is deliberately not on the keyboard.

- **Typing in a dialog kept only the last character.** Rename, New File, Save
  As and agent instructions all pre-select their text, and the code that did
  the selecting re-ran on every keystroke — so each character replaced
  everything typed before it. Renaming `README.md` to `GUIDEBOOK.md` produced
  `K.md`.

- **A finished agent left its process running.** The child process was only
  shut down when a session was cancelled, so every completed run leaked one for
  as long as the editor stayed open.

- **Agents can actually be run.** **Configure Agents** writes an `agents.json`
  beside your settings; **Run Agent…** asks which one and what you want done,
  and starts it. Everything the runtime, permission model and review flow were
  built for is now reachable without writing code.
  - The Agents panel moved out of the sidebar into the editor area, where an
    audit trail of what a session read, ran and was refused fits on one line
    per entry instead of wrapping to four.
  - A syntax error in `agents.json` is reported rather than looking like
    having configured nothing.

- **Saving no longer rewrites your whole session on every keystroke.** Unsaved
  work is kept in per-buffer backup files rewritten only when that buffer
  changes, so `session.json` stays a few hundred bytes instead of growing to
  the size of the file you are editing. Typing in a large modified file was
  writing megabytes every few hundred milliseconds.

- **A read API for programmatic callers.** Structured access to what is open,
  what is selected, what is on screen, the project tree and what has recently
  changed — the half of the platform an agent reads from, with the permission
  model governing the half that writes.
  - Everything it returns is plain data. Nothing that could be used to change
    a file behind the permission check ever leaves it.
  - Reads are not gated — context cannot go anywhere on its own — but every
    read a non-human makes is recorded alongside its edits, so what it looked
    at is as answerable as what it did.
  - Still nothing using it but its own tests, one of which drives a fake agent
    the whole way: read the file, propose a change, get refused, get allowed,
    get undone in one step.

- **A permission model for anything that is not you.** Every command that
  writes, creates, deletes, shells out or opens a folder now declares what it
  needs. A plugin or an agent asking for one of those is checked against a
  policy; you are not.
  - **You never see a permission prompt.** Pressing <kbd>⌘S</kbd> is not
    something Nox asks you to approve, whatever the policy says.
  - Prompts are per-file, so allowing a write to one file does not quietly
    allow one to another. *Allow for this session* remembers; *Allow once*
    does not.
  - A path outside the open folder is always asked about, even when policy
    would allow it.
  - Refusals are errors, not silence, so a caller cannot mistake "not
    permitted" for "nothing to do".
  - Nothing uses this yet except its own tests. It is built now because a
    permission model added after the thing it governs is a permission model
    with holes in it.

- **Background work is visible and cancellable.** A running search or replace
  shows in the status bar with its progress and what it is currently reading.
  Click it — or run **Cancel Background Task** from the palette — to stop it.
  - **Cancelling a search leaves nothing behind.** The walk stops on the Rust
    side rather than running on with its results discarded, and the panel
    returns to how it looked before the search started, instead of showing
    however far it happened to get.
  - **Cancelling a replace changes nothing at all.** The walk computes what to
    write and writes none of it until it has finished, so there is nothing to
    unwind.
  - **A replace will no longer overwrite something you typed while it ran.**
    Reading a whole project takes long enough to type into a file partway
    through; that is now caught and the replace refuses for that file, rather
    than writing text it computed before the keystroke.

- **A project-wide replace is one undo.** <kbd>⌘Z</kbd> now takes the whole
  replace back across every open file at once, rather than needing one press
  per file, and says what it undid: *Undid Replace "Task" across 2 files*.
  <kbd>⌘⇧Z</kbd> puts it back the same way.
  - A file you have edited since the replace is **left alone** and reported,
    rather than having your work taken back with it.
  - Underneath is a transaction model: every programmatic edit is a *change
    set* with a description and an author, applied to all its buffers or none.
    The whole set is validated before anything is written, so a partly-applied
    change cannot happen — there is no rollback path because there is nothing
    to roll back.
  - Applied change sets are recorded in a transaction log with who made them.

- **Unsaved work survives quitting.** Edits you have not saved — to real files,
  not just scratch buffers — are recorded in the session and restored on next
  launch, still marked unsaved, with <kbd>⌘Z</kbd> reaching the content that is
  on disk.
  - There is deliberately no "save before quitting?" dialog. A dialog can be
    answered wrong; persistence cannot lose work however you dismiss the window.
  - If the file changed while Nox was closed, the tab is flagged as modified
    externally, so saving goes through the existing conflict path instead of
    overwriting whatever arrived.
  - The window now waits for the final session write and settings flush before
    closing. Previously nothing ran on quit at all.

- **Cursor positions are restored.** Every cursor in every tab, not just the
  primary one, clamped to the document in case the file changed while Nox was
  closed. Switching tabs now scrolls the cursor into view rather than jumping
  to the top of the file.

- **Buffer switcher** (<kbd>⌘E</kbd>, or `~` in the palette). Lists what is
  already open, ordered by when you last looked at each file and starting on
  the previous one, so bouncing between two files is two keystrokes. Distinct
  from <kbd>⌘P</kbd>, which searches the whole project.

- **Byte-order marks are preserved.** A file that had one keeps it; a file that
  did not never gains one. The status bar shows `UTF-8` or `UTF-8 BOM`.

- **Code folding.** Fold arrows in the gutter, driven by the language grammar.
  - <kbd>⌘⌥[</kbd> / <kbd>⌘⌥]</kbd> fold and unfold at the cursor;
    <kbd>⌘⌥⇧[</kbd> / <kbd>⌘⌥⇧]</kbd> fold and unfold everything.
  - **Fold Level 1–5** collapses one nesting depth at a time, turning a file
    into an outline.
  - Folds live in the buffer, so they survive switching tabs.
  - Arrows stay hidden until you hover the gutter; a *closed* fold always shows,
    because it marks content you cannot see. Turn the whole thing off with
    `editor.codeFolding`.

- **Split editor panes** (<kbd>⌘\\</kbd>). The editor area now holds several
  panes, each with its own tabs, active file, scroll position and undo history.
  - Side by side or stacked, toggled from the palette or Settings, with
    draggable dividers that keep their proportions when the window resizes.
  - <kbd>⌘⌥←</kbd>/<kbd>⌘⌥→</kbd> move focus between panes,
    <kbd>⌘⌥⇧←</kbd>/<kbd>⌘⌥⇧→</kbd> send the current file to the next one,
    and <kbd>⌘⇧\\</kbd> closes a pane — folding its tabs into the neighbour
    rather than closing them.
  - Tabs drag between panes. A pane emptied by a drag or a close folds away;
    the focused pane is marked so it is never ambiguous where typing will go.
  - Sessions remember the full layout. Version 1 sessions are migrated rather
    than discarded.

- **Replace across files.** The search panel gains a replacement field, a live
  diff preview on every match row, per-file replace, and Replace All.
  - **Nothing is written blind.** Replace All states the scale
    ("Replace 13 occurrences?" across N files) before touching anything.
  - **Open files change through the editor**, so ⌘Z undoes a project replace
    like any other edit, and a file with unsaved work never gets written
    underneath it — the replacement is computed against the buffer instead.
  - **A one-shot undo** restores every file the replace changed. A file edited
    since is left alone and reported, rather than being clobbered.
  - Regex capture groups (`$1`, `$&`, `$<name>`) expand in the replacement;
    a literal search treats `$` verbatim.

- **Project-wide search** (<kbd>⇧⌘F</kbd>). A parallel, gitignore-aware walk in
  Rust, streaming results into a sidebar panel as they are found.
  - Match case, whole word and regular expressions; include/exclude globs
    (`*.ts`, `src/**`) and a toggle for respecting `.gitignore`.
  - Results group by file with line previews and highlighted matches. Clicking
    or pressing <kbd>↵</kbd> opens the file with the cursor **on the match**,
    not merely on the line.
  - Fully keyboard-driven: arrows walk files and matches alike, <kbd>←</kbd>/
    <kbd>→</kbd> collapse and expand groups, <kbd>Esc</kbd> steps back to the
    query field.
  - The sidebar now hosts two views — Explorer and Search — switched by a rail,
    <kbd>⇧⌘E</kbd>, or <kbd>⇧⌘F</kbd>.
  - Search works in the browser target too: the in-memory platform implements
    it for real rather than stubbing it.

- **Drag and drop.**
  - **Within the explorer**, drag entries onto a folder to move them. Dropping
    onto a file targets its containing folder; dropping below the tree targets
    the workspace root. Multi-select drags the whole selection.
  - Moving **carries open tabs with it**, including every buffer beneath a
    moved folder, and leaves the moved entries selected.
  - Illegal drops are refused before they happen: a folder cannot be dropped
    into itself or its own subtree, and an existing file at the destination is
    never overwritten.
  - **From the OS**, drop files onto the window to open them as tabs, or a
    single folder to open it as the workspace. A full-window affordance appears
    while files hover.

- **Multi-select in the explorer.** Cmd/Ctrl-click toggles, Shift-click selects
  a range, Cmd+Shift-click adds a range, <kbd>⌘A</kbd> selects everything
  visible, <kbd>Space</kbd> toggles the focused row, and Shift+Arrow extends
  from a fixed anchor — so the range shrinks as well as grows.
  - Delete, Duplicate, Open and both Copy Path commands act on the whole
    selection; the menu labels count what they will affect
    ("Delete 4 Items…"), and the confirmation names the files rather than
    showing a bare number.
  - Nested selections reduce to their top-level ancestor before deleting, so
    picking a folder *and* a file inside it does not fail halfway through.
  - Collapsing a folder drops the selection inside it — Delete never acts on
    rows you cannot see.
  - Right-clicking inside the selection keeps it; right-clicking outside
    replaces it, matching every file manager.
  - <kbd>Esc</kbd> narrows before it leaves: it collapses a multi-selection
    first, and returns focus to the editor on a second press.

- **Explorer context menu.** Right-click any file or folder — or press the
  Menu key / <kbd>⇧F10</kbd> — for New File, New Folder, Rename, Duplicate,
  Delete, Copy Path, Copy Relative Path and Reveal in File Manager.
  - **Deleting moves to the OS trash**, not `unlink`. The confirmation says
    "Move to Trash" where that is true and "deleted permanently" where it is
    not, driven by a platform capability rather than a guess.
  - **Renaming carries open buffers with it** — including every buffer beneath
    a renamed directory — updating path, tab label, and syntax highlighting
    when the extension changes.
  - Deleting closes clean buffers and *keeps* dirty ones, marked, so unsaved
    work is never lost to a menu click.
  - <kbd>F2</kbd> renames and <kbd>⌫</kbd> deletes while the explorer has
    focus. The menu itself is fully keyboard-operable: arrows, Home/End,
    type-ahead, Enter, Escape, and focus returns to the tree on close.
- Every explorer operation is also a command, so all of it works from the
  palette without touching the mouse.

- **File watching.** Nox now notices changes made outside the editor.
  - A **clean** buffer reloads silently — the file on disk is the truth.
  - A **dirty** buffer is never overwritten. It is marked in the tab and status
    bar, you are told once, and the conflict is resolved when you save with an
    explicit Overwrite / Discard & Reload / Cancel choice.
  - A **deleted** file keeps its tab, struck through; the content is still in
    memory and saving recreates the file.
  - The explorer and quick-open index follow files created, deleted and renamed
    by other programs.
- `File: Reload File from Disk` (formerly `Revert File`), which now confirms
  before discarding unsaved changes.
- `MemoryPlatform.externalWrite` / `externalRemove` / `externalRename`, which
  simulate another program writing to the same disk — real events, real mtimes.

### Changed

- Reloading a file is applied as a transaction rather than a state reset, so
  scroll position, selection and undo history survive it. A surprise reload is
  recoverable with ⌘Z.
- `Platform` gained `watch()` and a `fileWatching` capability; `MemoryPlatform`
  now keeps per-file modification times.

### Fixed

- **In a split, only one pane received programmatic edits.** Every pane
  overwrote a single app-wide dispatcher slot on mount, so a project replace
  aimed at a file open in the other pane changed the buffer but left that
  pane's view showing the old text. Panes now each register their own.

- **A programmatic edit with a bad offset could half-apply.** A change set
  spanning two files where the second had an out-of-range range wrote the
  first, then threw — leaving the files inconsistent and nothing in the log to
  undo it with. Every file's change is now built before any is written, so the
  set applies completely or not at all. Overlapping edits within one file are
  refused too, rather than being merged into text nobody asked for.

- **A review could not be put down.** The diff panel covers the editor, and
  Apply and Discard were the only ways out — so there was no way to look at the
  file you were reviewing. Escape now closes it, going to any file closes it,
  and the status bar shows what is waiting.

- **The sidebar could not show a third view.** Anything that was not Search
  fell through to focusing the explorer, which switched the view straight back.

- **Session restore focused the wrong tab.** It applied the active tab for each
  group, then chose the focused tab from a snapshot taken *before* that — so
  focus always landed on whichever file was opened last rather than the one you
  left active. The existing test could not catch it: its fixture made the
  intended tab and the last-opened tab the same file.

- Saving no longer risks silently destroying another program's changes to the
  same file.
- **Prompt dialogs could not be confirmed with <kbd>Enter</kbd>.** Rename, New
  File and Save As all required a mouse click — a serious flaw in an editor
  that claims to be keyboard-first. Enter is now handled explicitly rather than
  relying on the browser's implicit form submission.
- A destructive confirmation button no longer renders in the safe accent
  colour; Delete is red.
- Deleting on macOS no longer routes through Finder over AppleScript, which
  blocked for two minutes and then failed when Finder was busy or unavailable.
  Nox uses `NSFileManager` directly: the same operation now completes in
  milliseconds. Guarded by an integration test that fails if it ever takes
  longer than five seconds.

## [0.1.0] — 2026-08-12

First milestone. Nox is a usable editor.

### Added

**Architecture**
- Tauri 2 desktop shell (Rust) with a Svelte 5 + CodeMirror 6 renderer
- `Platform` boundary with three implementations: Tauri (disk), memory
  (tests), web (browser dev with an in-memory demo workspace)
- Command registry — every user action is a command, so the palette and the
  shortcut reference are generated rather than maintained
- Two-layer keymap: application chords resolved on capture, editing chords
  owned by CodeMirror
- Schema-driven configuration; `Settings` type, validator and Settings UI all
  derived from one object

**Editor**
- Syntax highlighting for TypeScript, JavaScript, JSX/TSX, JSON, HTML,
  CSS/SCSS, Markdown, Python and Rust — grammars loaded on demand
- Multiple cursors: add above/below, add-to-next-match, Alt+click,
  select-all-occurrences
- Undo/redo per buffer, bracket matching, auto-close brackets, auto-indent,
  configurable tabs/spaces, word wrap, whitespace rendering
- Line numbers with an optional relative mode
- Configurable cursor style (line, block, underline) and blink

**Files**
- Open, save, save as, new, close, revert; folder opening; recent files
- File explorer with lazy loading, keyboard navigation and auto-reveal
- Tabs with dirty indicators, middle-click close and drag reordering
- CRLF detection preserved on save; optional trailing-whitespace trim and
  final-newline insertion
- Binary and oversized files refused with a clear message rather than a hang
- Session restore for the open folder, tabs and unsaved scratch buffers

**Interaction**
- Command palette, quick open and go-to-line in one prefix-switched surface
  (`>` for commands, `:` for lines)
- Optimal fuzzy ranking with filename weighting and match highlighting
- Find and replace with regex, case sensitivity, whole-word and
  select-all-matches; live match counting
- Settings panel generated from the schema, with per-setting reset
- Keyboard shortcut reference covering both keymap layers

**Design**
- Eclipse theme (blue-black night) and Umbra (OLED true-black)
- Complete design token layer; no component hardcodes a visual value
- Crescent identity mark, rendered to app icons by a dependency-free generator

**Quality**
- 132 unit tests across path handling, fuzzy ranking, workspace, config,
  commands, keymap, file tree and session
- Clean `svelte-check`: zero errors, zero warnings

### Known limitations

Recorded in [ARCHITECTURE.md](ARCHITECTURE.md) §7. The notable ones: no file
watching, so external edits go undetected; the dirty flag is approximate above
2 MB; keybindings are read-only; and the explorer has no context menu.

[Unreleased]: https://github.com/francescoa27122/nox-editor/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/francescoa27122/nox-editor/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/francescoa27122/nox-editor/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/francescoa27122/nox-editor/compare/v0.8.3...v0.9.0
[0.8.3]: https://github.com/francescoa27122/nox-editor/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/francescoa27122/nox-editor/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/francescoa27122/nox-editor/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/francescoa27122/nox-editor/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/francescoa27122/nox-editor/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/francescoa27122/nox-editor/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/francescoa27122/nox-editor/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/francescoa27122/nox-editor/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/francescoa27122/nox-editor/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/francescoa27122/nox-editor/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/francescoa27122/nox-editor/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/francescoa27122/nox-editor/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/francescoa27122/nox-editor/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/francescoa27122/nox-editor/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/francescoa27122/nox-editor/releases/tag/v0.1.0

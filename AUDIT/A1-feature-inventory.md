# A1 Feature Inventory

Audited at commit `54cece6e`. Read-only. `npm test` was run once as a baseline: 169 files, 2439 tests, all passing, 17.7 s.

## Summary

Nox has the full core of a public text editor, and nearly all of it is wired the way the architecture promises: 160 commands in `src/app.ts`, every non-hidden one placed in a menu by construction (`tests/menu.test.ts:63`), a default chord for the ones that deserve one, and a status bar, tab bar, explorer and welcome screen that all dispatch through the same registry. Open, save, save as, revert, close variants, recent files, in-file find and replace with regex, case and whole word, project search and replace with undo, multi-cursor, per-tab undo, 24 languages, tree operations including drag-to-move and trash, splits, settings and keybinding editors, six encodings, LF/CRLF switching, a 64 MB size guard, three autosave modes, trailing-whitespace and final-newline handling, bracket matching, folding, go to line:column, word wrap, zoom, OS file drop and open-folder-as-workspace are all present and work in the code I read. The strongest finding is that there is no way to open a file *from* the OS: no command-line argument handling, no file associations, no macOS `Opened` event, no single-instance plugin, so "Open with Nox", a double-clicked file and `nox file.txt` all do nothing (A1-001). Behind that, the after-delay autosave silently skips a buffer you leave before the delay elapses (A1-002), the Windows and Linux menu bar lacks Cut, Copy, Paste and Exit (A1-003), there is no per-file indentation detection (A1-004), and grammar breadth stops short of C#, Kotlin, Swift, Lua, Dockerfile and Makefile (A1-005). Sub-score 15 / 20: nothing core is broken, but a stranger who installs it meets the open-from-OS gap in the first minute.

## Sub-score

15 / 20

Justification: rubric band 14 to 17, "a few expected features missing or half-built; nothing core broken". A1-001 (no open-from-OS path) and A1-003 (menu without clipboard or Exit off macOS) are the two a downloaded editor is expected to have and cost most of the points. A1-002 is a real defect in a core feature but has a workaround (manual save, and the session restores the dirty text), so it holds the score in band rather than dropping it. A1-004 and A1-005 are expectation gaps rather than breakage.

## Findings

```
ID:          A1-001
Lane:        Feature inventory
Severity:    P1
Title:       Nox cannot receive a file from the OS: no argv path, no file associations, no Opened event, no single instance
Location:    src-tauri/src/lib.rs:44-60; src-tauri/tauri.conf.json:45-62; src-tauri/Cargo.toml:16-55
Evidence:    The only read of the process arguments is for the test flag:
             lib.rs:57-58 `geometry::decide_launch(geometry::geometry_from_args(std::env::args()), ...)`,
             and the comment at lib.rs:46 says why it is a test affordance: "a Finder-launched .app
             gets no argv". Nothing else in `src-tauri/src/` or `src/platform/tauri.ts` reads argv,
             handles `RunEvent::Opened`, or registers `tauri-plugin-cli`, `tauri-plugin-single-instance`
             or `tauri-plugin-deep-link` (grep over both trees: zero matches for `getMatches`,
             `single_instance`, `deep_link`, `Opened`). The `bundle` block of tauri.conf.json:45-62
             declares targets, icons and a macOS minimum version and no `fileAssociations`. README,
             ARCHITECTURE and ROADMAP do not mention a command line, "Open with", or file
             associations at all (grep: zero matches), so this is an omission rather than a decision.
Impact:      A user who right-clicks a `.md` and picks Nox, sets Nox as the default for `.txt`, or
             types `nox notes.txt` in a terminal gets a window showing the previous session and not
             the file. On Windows and Linux a second launch opens a second, independent process
             whose `session.json` write races the first (Speculative on the race; Confirmed that
             nothing prevents the second instance).
Fix sketch:  Add `bundle.fileAssociations` for the extensions in `core/languages.ts`, read
             `std::env::args()` for non-flag paths in `setup` and emit them to the renderer as an
             "open these" event on the same door `openDroppedPaths` already uses, handle
             `RunEvent::Opened` on macOS, and add `tauri-plugin-single-instance` so a second launch
             forwards its argv to the running window instead of starting another.
Confidence:  Confirmed
Risk class:  Gated
```

```
ID:          A1-002
Lane:        Feature inventory
Severity:    P2
Title:       After-delay autosave saves whichever buffer is current when the timer fires, not the one that was edited
Location:    src/ui/EditorPane.svelte:147-149, 315, 387-398
Evidence:    Every doc change calls `scheduleAutosave()` (line 149). The timer body reads the pane's
             *current* buffer at fire time, not the one edited:
               391  autosaveTimer = setTimeout(() => {
               392    autosaveTimer = null;
               393    const id = currentId;
               394    const buffer = id ? workspace.buffers.get().find((b) => b.id === id) : null;
               396    if (id && buffer?.isDirty && !buffer.isUntitled) void app.save(id);
             `currentId` is reassigned on every tab switch (line 315) and the timer is cleared only
             on component destroy (line 228), never on a switch.
Impact:      With `files.autoSave = afterDelay` (default delay 1000 ms): type in A, press Mod+Tab or
             click tab B within a second. The timer fires, sees B, and A stays dirty until it is
             edited again. The tab shows the dirty dot so nothing is lost, and the session restores
             the text, but the feature's promise ("write modified buffers back to disk") is not
             kept for exactly the buffer the user just left. `onFocusChange` (line 400) does not
             cover it either, because a tab click inside the same pane keeps editor focus.
Fix sketch:  Capture the buffer id when scheduling (`const id = currentId;` before `setTimeout`) and
             save that id; or keep one timer per buffer in the pane. Add a test in
             `tests/workspace.test.ts` or a pane test that edits A, switches to B, advances fake
             timers and asserts A was written.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A1-003
Lane:        Feature inventory
Severity:    P2
Title:       On Windows and Linux the menu bar has no Cut, Copy, Paste, Exit, About or Full Screen, and the Known-debt row says "every platform has a menu"
Location:    src/services/menu.ts:73-76, 103-113, 121, 130-133, 254-255; ARCHITECTURE.md §7 row "No *native* menu off macOS"
Evidence:    The Edit group's clipboard entries are predefined items only (menu.ts:109-111
             `predefined('cut'), predefined('copy'), predefined('paste')`), Quit is
             `predefined('quit', 'Quit Nox')` (line 92), Full Screen is `predefined('fullscreen')`
             (line 121) and the Window menu is `leading: [predefined('minimize'),
             predefined('maximize')]` with `categories: []` (lines 130-133). `buildMenu` drops every
             predefined node when the platform draws its own bar: line 254-255
             `(nodes ?? []).filter((node) => options.systemItems || node.kind !== 'predefined')`,
             and `MenuService.describe()` passes `systemItems: this.#platform.capabilities.applicationMenu`,
             which is false everywhere but macOS. No `edit.cut`, `edit.copy`, `edit.paste` or
             `app.quit` command exists in `src/app.ts` (grep: zero matches), and `MenuBar.svelte`
             adds none (grep for exit, quit, about, cut, paste: only the generic dispatch at line 235).
             `tests/menu.test.ts:167-177` pins the behaviour as intended for `predefined` nodes; the
             companion test at 153-160 only covers Undo, Redo and Select All
             (`COVERED_BY_SYSTEM_ITEMS`, menu.ts:73-76).
             The Known-debt row states "Windows and Linux now draw an in-window menu bar instead,
             so every platform has a menu. What is still missing is a native one". That describes
             the frame and omits that the drawn menu is missing the items above.
Impact:      A mouse-driven Windows or Linux user cannot paste, copy or cut from the Edit menu, has
             no File > Exit (the title-bar close button and Alt+F4 work), no About to read the
             version from (Copy Diagnostics exists, About does not), and no View > Full Screen.
             Keyboard users are unaffected.
Fix sketch:  Add `edit.cut`, `edit.copy`, `edit.paste` commands that run CodeMirror's clipboard
             path when the editor has focus and `document.execCommand` otherwise, an `app.quit`
             command over `platform.closeWindow()`, an `app.about` command that shows the version
             (the `app.showWelcome` route is the natural home), and a `view.toggleFullscreen`
             command over a new Platform method; extend `COVERED_BY_SYSTEM_ITEMS` so macOS keeps
             its responder-chain items. Correct the Known-debt row to say what the drawn menu lacks.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A1-004
Lane:        Feature inventory
Severity:    P2
Title:       No per-file indentation detection and no .editorconfig: Tab always inserts the configured unit
Location:    src/editor/extensions.ts:131, 162-164; src/services/workspace.ts:471-528; src/ui/StatusBar.svelte:116, 308-310
Evidence:    The indent unit is a pure function of settings: extensions.ts:131
             `return indentUnit.of(s['editor.insertSpaces'] ? ' '.repeat(s['editor.tabSize']) : '\t');`
             and `EditorState.tabSize.of(s['editor.tabSize'])` at 163. `WorkspaceService.open`
             (471-528) detects language, EOL and encoding from the file and nothing about its
             indentation. Grep over `src/` for `detectIndent`, `guessIndent`, `editorconfig`: zero
             matches; the same grep over README, ARCHITECTURE, ROADMAP and docs: zero, so it is
             neither built nor recorded as a decision. The status bar's indent item (StatusBar.svelte:116,
             308-310) shows and toggles the *setting*, so it reads "Spaces: 2" over a tab-indented file.
Impact:      Open a tab-indented Makefile, Go file or any file from a tabs project with the default
             `editor.insertSpaces = true`; press Enter or Tab and the new line is space-indented,
             producing mixed indentation the user did not ask for. Workspace settings
             (`.nox/settings.json`) cover a whole project but not a file that disagrees with it,
             and the default for a freshly cloned repository is still "spaces, 2".
Fix sketch:  On open, sample the first N lines for leading tabs versus space runs (the usual
             heuristic is small and pure, and belongs in `core/`), store the result on the Buffer
             beside `eol`, and feed it to the `indentUnit`/`tabSize` compartments per buffer, with
             the status bar showing the detected value and the setting as the fallback for files
             with no indentation to read. `.editorconfig` can follow through the same seam.
Confidence:  Confirmed
Risk class:  Gated
```

```
ID:          A1-005
Lane:        Feature inventory
Severity:    P2
Title:       Grammar breadth stops at 24 languages; Dockerfile and Makefile are named as the reason for filename matching and are not in the table
Location:    src/core/languages.ts:17, 23-71; src/editor/languages.ts:17-63
Evidence:    `LANGUAGES` (core/languages.ts:23-71) lists TypeScript, TSX, JavaScript, JSX, JSON,
             HTML, CSS, SCSS, Markdown, Python, Rust, Shell, YAML, TOML, XML, SQL, Go, C, C++,
             Java, Ruby, PHP, Svelte, Vue and Plain Text, and `LOADERS` (editor/languages.ts:17-63)
             has one entry per id, three of them stream parsers. The `filenames` field is documented
             at core/languages.ts:17 as `/** Exact filenames, for things like `Dockerfile` or
             `Makefile`. */`, and neither name appears anywhere in the table; the only `filenames`
             entries are `.bashrc`, `.zshrc`, `.profile` and `Cargo.lock`. Absent entirely: C#,
             Kotlin, Swift, Lua, Dart, Scala, Haskell, Perl, R, PowerShell, Batch, INI/`.env`,
             Dockerfile, Makefile, GraphQL, Protobuf, Nix, Zig, LaTeX. `@codemirror/legacy-modes`
             is already a dependency and ships modes for most of these.
Impact:      A `.cs`, `.kt`, `.swift`, `.lua`, `.ps1`, `.ini`, `Dockerfile` or `Makefile` opens as
             Plain Text with no highlighting, no comment toggling (`lineComment` is per entry) and
             no fold gutter. A Windows user's first PowerShell script and a containerised project's
             first file are both in that set. `lang.setLanguage` cannot help because there is no
             entry to pick. Not a bug; a breadth gap a public editor is judged on.
Fix sketch:  Add the common set through `StreamLanguage` loaders (one line each, the shape
             `shell`/`toml`/`ruby` already use), give `Dockerfile` and `Makefile` their `filenames`
             entries, and note in the Known-debt row on stream grammars that the count of
             colour-only languages grew. `tests/grammars.test.ts` already pins LOADERS to LANGUAGES.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A1-006
Lane:        Feature inventory
Severity:    P3
Title:       Recent files are recorded but have no surface beyond quick-open ordering; recent folders reach only the Welcome screen
Location:    src/services/workspace.ts:314-315, 1625, 1867-1869, 1891; src/ui/CommandPalette.svelte:718-722; src/ui/Welcome.svelte:92-103; src/services/session.ts:104-105, 362-363
Evidence:    `recentFiles` (24 entries, workspace.ts:1891) and `recentFolders` (12, line 1625) are
             kept and persisted (session.ts:362-363). The only reader of `recentFiles` outside the
             service is `recentFirst()` in the palette, which orders the empty quick-open query
             (CommandPalette.svelte:718-722). `recentFolders` is read only by `Welcome.svelte:92-103`,
             which shows five of the twelve and only while no tab is open. There is no
             `file.openRecent` command, so the File menu, the palette and the keybinding editor
             have no "Open Recent" entry (grep over `src/app.ts` for `recent`: keywords only, at
             3713 and 4507).
Impact:      With a folder open and a tab showing, the recent-folders list is unreachable; a user
             who wants to switch projects goes through the OS folder dialog every time. Recent
             files are discoverable only by knowing that an empty Mod+P query is ordered by recency.
Fix sketch:  Add `file.openRecent` (a picker over `recentFolders` then `recentFiles`, using the
             overlay pattern `notes.open` already uses) and place it under File; the Welcome screen
             can keep its shortlist.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A1-007
Lane:        Feature inventory
Severity:    P3
Title:       Go to Line is Alt+G on Windows and Linux, and the comment's reason is Nox's own choice rather than a platform convention
Location:    src/app.ts:4639-4641, 4588-4589
Evidence:    4639  // Go to Line: ⌃G matches macOS convention without colliding with ⌘G
             4640  // (Find Next). On Windows and Linux ⌃G is already Find Next, so use ⌥G.
             4641  this.keymap.bind(platformIsMac ? 'Ctrl+G' : 'Alt+G', 'nav.goToLine');
             `Mod+G` is bound to `edit.findNext` at 4588, alongside `F3` at 4589. On Windows and
             Linux, Ctrl+G is Go to Line in VS Code, Sublime, Notepad++, gedit and Kate, and Find
             Next is F3 there; Ctrl+G as Find Next is the macOS Cmd+G convention carried across
             by the `Mod` prefix.
Impact:      A Windows user who presses Ctrl+G expecting Go to Line gets Find Next (a no-op with
             the find panel closed) and has to discover Alt+G from the Go menu or the status bar.
             One line in `keybindings.json` fixes it per user; the default is what a stranger meets.
Fix sketch:  Off macOS, bind `Ctrl+G` to `nav.goToLine` and leave Find Next on `F3`/`Shift+F3`
             (already bound); keep `Cmd+G` as Find Next on macOS. Update the comment. This changes
             a default chord, so it is Gated.
Confidence:  Confirmed
Risk class:  Gated
```

```
ID:          A1-008
Lane:        Feature inventory
Severity:    P3
Title:       The File menu lists two near-duplicate pairs that resolve their target folder by different rules
Location:    src/app.ts:2735-2755 (file.newInFolder, file.newFolder), 3038-3060 (explorer.newFile, explorer.newFolder), 1985-1989, 2623-2631; src/services/menu.ts:100
Evidence:    `file.newInFolder` "New File in Folder…" and `file.newFolder` "New Folder…" call
             `contextDirectory()` (1985-1989: the active file's directory, else the root).
             `explorer.newFile` "New File Here…" and `explorer.newFolder` "New Folder Here…" call
             `#targetDirectory(arg)` (2623-2631: the explorer selection, else the root). Both
             categories share the File menu (menu.ts:100 `categories: ['File', 'Explorer']`), so
             it shows "New File in Folder…", "New Folder…", then "New File Here…", "New Folder Here…".
Impact:      Four rows for two actions, whose difference (active-file directory versus explorer
             selection) is not stated in either title. With a file open and a different folder
             selected in the tree, the two "new folder" items create in different places.
Fix sketch:  Keep the explorer pair (they take a context-menu argument) and either drop the File
             pair or retitle them "New File Beside Current…"/"New Folder Beside Current…" so the
             rule is in the name. `tests/menu.test.ts` will hold the menu to the change.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A1-009
Lane:        Feature inventory
Severity:    P3
Title:       Two agent commands carry category View and land in the View menu away from the rest of Agents
Location:    src/app.ts:3236-3241, 3599-3603; src/services/menu.ts:119-128
Evidence:    `agents.show` is `category: 'View'` (3238) and `agents.undoLastSession` is
             `category: 'View'` (3601), while `agents.run`, `agents.runOnSelection`,
             `agents.askAboutSelection`, `agents.explainSelection`, `agents.configure`,
             `agents.reloadConfig` and `agents.cancel` are `category: 'Agents'` and are placed under
             Tools (menu.ts:128). `themes.openFolder`/`themes.reload` are View by intent (they are
             appearance); the two agent items are not.
Impact:      "Show Agents" and "Undo the Last Agent Session" appear in View between "Toggle Sidebar"
             and "Increase Font Size"; a user looking under Tools > Agents does not find them, and
             the palette prefixes them "View:".
Fix sketch:  Change both to `category: 'Agents'`. `tests/menu-placement.test.ts` is the place to
             pin it.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A1-010
Lane:        Feature inventory
Severity:    P3
Title:       edit.foldLevel is a hidden command nothing dispatches
Location:    src/app.ts:3925-3934, 3942-3949
Evidence:    3925  id: 'edit.foldLevel',
             3927  hidden: true,
             3929  run: (arg) => { const level = Number(arg); if (...) this.#runEditor(foldToLevel(level)); }
             Grep for `'edit.foldLevel'` across `src/` and `tests/`: the definition only. The five
             visible `edit.foldLevel1` to `edit.foldLevel5` (3942-3949) cover the same operation
             without an argument.
Impact:      Dead path: reachable only by hand-writing a `keybindings.json` rule with an `arg`,
             which the Keybindings panel cannot produce (it records chords, not args). Harmless,
             but it is a command with a title and a `run` that no test and no UI ever exercises.
Fix sketch:  Delete it, or keep it and have the five visible commands dispatch through it so the
             fold-to-level logic exists once.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A1-011
Lane:        Feature inventory
Severity:    P3
Title:       No print command and no recorded decision not to have one
Location:    src/app.ts:2720-4522 (the command table); ROADMAP.md "Not planned"; ARCHITECTURE.md §4
Evidence:    Grep over `src/` for `window.print`, `print(` in a command context, or a `file.print`
             id: none. Grep over README, ROADMAP, ARCHITECTURE and DESIGN for "print" or
             "printing": zero matches. ROADMAP's "Not planned" list names a light theme,
             collaboration and a hosted Nox, and its preamble says "Anything not listed is not
             planned", which makes the absence a decision only by omission.
Impact:      A user who expects File > Print (every OS text editor has one; the WebView already
             supports `window.print()`) finds nothing and no explanation. Low severity because the
             audience is developers and the workaround is any other program.
Fix sketch:  Either a `file.print` command over `window.print()` with a print stylesheet (a
             half-day), or one line under ROADMAP "Not planned" saying Nox does not print and why.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A1-012
Lane:        Feature inventory
Severity:    P3
Title:       Fourteen commands and two open-time guards have no test that names them, and keymap-defaults.test.ts covers only the notes chords
Location:    tests/ (absence); tests/keymap-defaults.test.ts:47; src/services/workspace.ts:490-493
Evidence:    Grep of `tests/` for each command's identifier finds no file for: `file.closeToRight`,
             `file.closeSaved`, `edit.moveLineUp`, `edit.moveLineDown`, `edit.duplicateLine`,
             `edit.deleteLine`, `edit.foldAll`, `edit.unfoldAll`, `nav.nextTab`, `nav.previousTab`,
             `nav.switchBuffer`, `explorer.revealInFileManager`, `view.toggleStatusBar`,
             `view.reloadWindow`. The `workbench.restoreSession = false` boot path (app.ts:404-406)
             has no test (`restoreSession` appears in no test file), and the 64 MB refusal at
             workspace.ts:490-493 is untested (`tests/workspace.test.ts:63` covers the binary
             refusal; nothing covers `MAX_FILE_BYTES`). `tests/keymap-defaults.test.ts` opens with a
             header about "the default chords, asserted against the real table" and contains one
             `describe('the notes chords')` (line 47); the duplicate-chord collapse it warns about is
             caught for the object literal by ESLint `no-dupe-keys` (`js.configs.recommended`,
             eslint.config.js:82) but not for the three `bind()` calls after it (app.ts:4641-4650).
Impact:      Most of the untested commands are one-line delegations to CodeMirror or to a
             workspace method that is tested on its own, so the practical exposure is the wiring
             (title, enablement, argument shape), which `tests/command-titles.test.ts` and
             `tests/menu.test.ts` cover generically. The two guards are the real gap: a regression
             in the size check would open a 500 MB file into the renderer with nothing failing.
Fix sketch:  One table-driven test over `app.commands.all()` that executes each editor command
             against a small document and asserts the document or selection changed as titled;
             a `MemoryPlatform` stat stub over `MAX_FILE_BYTES` asserting the refusal toast; and
             either extend `keymap-defaults.test.ts` to walk every default or retitle its header.
Confidence:  Confirmed
Risk class:  Safe
```

## Inventory

What exists, whether it works in the code as read, how it is reached, and whether a test names it. "Palette" means the command is visible there; every non-hidden command is also in a menu by construction (`tests/menu.test.ts:63`, `:179`).

| Feature | State | Reached by | Tested |
|---|---|---|---|
| New, Open, Open Folder, Close Folder | Works | Palette, File menu, Mod+N/O/Shift+O, Welcome, explorer empty state | `workspace.test.ts`, `welcome.test.ts` |
| Save, Save As, Save All | Works, atomic temp-and-rename in Rust | Mod+S, Mod+Shift+S, Mod+Alt+S, status bar (Save All) | `workspace.test.ts`, `write-failures.test.ts` |
| Revert ("Reload File from Disk") | Works, confirms when dirty | Palette, status bar warning chip | `watcher.test.ts` (21 files mention revert) |
| Close, Close All, Close Others, Close to Right, Close Saved | Works, each dirty tab prompts | Mod+W, tab context menu | Close All yes; Others/Right/Saved no (A1-012) |
| Recent files and folders | Recorded and persisted; weak surface | Empty Mod+P query; Welcome (folders only) | `palette-mru.test.ts`, `session.test.ts` (A1-006) |
| In-file find and replace: regex, case, whole word, replace one/all, seed from selection | Works | Mod+F, Mod+Alt+F, F3/Shift+F3, panel buttons | `find-focus.test.ts`, `selection.test.ts` |
| Project search and replace: regex, case, whole word, preserve case, .gitignore, include/exclude globs, per-match dismiss, undo last replace | Works, as cancellable jobs; 5000-match cap | Mod+Shift+F, Find menu, panel | `search.test.ts`, `replace.test.ts`, `replace-single-matches.test.ts`, `preserve-case.test.ts` |
| Multi-cursor: add above/below, next occurrence, all occurrences | Works (CodeMirror) | Mod+D, Mod+Alt+Up/Down, Mod+Shift+L, Edit menu | `selection.test.ts` |
| Undo/redo per tab, grouped undo for programmatic edits | Works, one `EditorState` per buffer | Mod+Z, menu, palette | `workspace.test.ts`, `transactions.test.ts` |
| Syntax highlighting | 24 languages, 3 colour-only | Automatic, `lang.setLanguage` from status bar | `grammars.test.ts`, `set-language.test.ts` (A1-005) |
| Explorer: new, rename, duplicate, delete to trash, copy path, move by drag, multi-select, reveal in OS, virtualised | Works | Context menu, File menu, keyboard | `fileops.test.ts`, `explorer-*.test.ts` |
| Tabs: reorder by drag, MRU switcher, Mod+1..9, next/previous | Works | Tab bar, Mod+E, Mod+Shift+[ ] | `tab-*.test.ts`; next/prev and switcher not named (A1-012) |
| Splits: split, close pane, move editor, orientation, same file twice | Works, flat row or column only (Known debt, accurate) | Mod+\, Mod+Shift+\, Mod+Alt+arrows, View menu | `groups.test.ts`, `pane-*.test.ts` |
| Settings: 38 keys, schema-generated UI, workspace layer, plugin layer, live reload | Works, every key has a reader (grep per key: none orphaned) | Mod+, and menu | `config.test.ts`, `settings-panel-*.test.ts`, `workspace-settings.test.ts` |
| Keybinding editor, `keybindings.json` rules | Works | Mod+Alt+K | `keybindings-panel.test.ts`, `keymap-user-bindings.test.ts` |
| Encoding: UTF-8, UTF-8 BOM, UTF-16 LE/BE, Windows-1252, Shift_JIS; reopen with encoding | Works; legacy charsets are choice-only (Known debt, accurate) | Status bar item, palette | `encoding-round-trip.test.ts` |
| Line endings: detect, show, switch | Works, switching dirties the buffer | Status bar item, palette | `workspace.test.ts` (1 file) |
| Large files | Refused above 64 MB with a toast; binary refused; word completion off above 1 MB | Automatic | Binary yes; 64 MB no (A1-012) |
| Autosave: off, after delay, on focus change | Works with the defect in A1-002 | Settings | `config.test.ts` reads the key only |
| Trim trailing whitespace, insert final newline | Works at save time | Settings, workspace-scoped | `workspace.test.ts` (`insertFinalNewline`, `trimTrailing`) |
| Indentation | Configured only; no detection | Status bar toggle | (A1-004) |
| Bracket matching, auto-close, auto-indent, fold gutter, fold/unfold/all/level | Works | Mod+Alt+[ ], Edit menu | `folding.test.ts` |
| Go to line:column, go to symbol, go to file | Works | Ctrl+G (mac) / Alt+G, Mod+R, Mod+P | `overlay-routing.test.ts`, `symbols.test.ts` (A1-007) |
| Word wrap, zoom in/out/reset, line numbers, relative numbers, status bar toggle, theme cycle | Works | Alt+Z, Mod+= / - / 0, View menu | `command-titles.test.ts` pins zoom keywords; status bar toggle not named |
| Drag files or a folder from the OS onto the window | Works on desktop (files become tabs, a lone folder becomes the workspace) | Automatic, `DropZone` overlay | `openDroppedPaths` in no test |
| Open a file from the OS at launch | Missing | (A1-001) | none |
| Printing | Missing | (A1-011) | none |
| Session restore: tabs, dirty text, untitled buffers, cursors, window geometry | Works | Automatic | `session.test.ts`, `session-backups.test.ts` |
| Terminal, Git (gutter, diff, stage, commit, branch, blame), LSP (diagnostics, completion, hover, definition, references, rename, format, code actions), Notes, Agents, Plugins, Snippets, Themes, Updater | Present and tested; outside this lane's core-editor rubric | Tools and Code menus | extensive |

Dead code check: every `Platform` method has at least one caller outside `src/platform/` (grep per method), every schema key has at least one reader, every Svelte component in `src/ui/` is imported by something other than a story, and every hidden command except `edit.foldLevel` has a dispatcher (`explorer.moveTo` from `ExplorerPanel.svelte:406`, `permissions.revokeSessionGrants` from `AgentPanel.svelte:251`, `nav.goToTab` from the Mod+1..9 chords, `view.dismiss` from Escape).

## What is good

- The menu is derived from the command table and a test holds it to "every visible command exactly once" on both the native and drawn variants: `src/services/menu.ts:222-292`, `tests/menu.test.ts:63`, `:179`. Discoverability is structural, not curated.
- Every user-visible surface dispatches through `commands.execute`: status bar (`src/ui/StatusBar.svelte:149-375`), tab bar (`TabBar.svelte:138-153`), title bar, explorer, editor context menu, Welcome. There is no second path to a side effect.
- The command table has its own invariants: no category restated in a title, non-empty titles, "zoom" reaches font size, every sidebar panel reachable by "panel" or "sidebar" (`tests/command-titles.test.ts`).
- Opening a file is defensive in the right order: directory, size, encoding proof, binary sniff (`src/services/workspace.ts:484-509`), and the failure toast names the file.
- The session promise is real: dirty text is backed up per buffer and restored dirty with undo reaching the on-disk content, empty scratch tabs are dropped, and a moved file is flagged (`tests/session.test.ts:45-130`).
- File drop follows the rule users expect without being told, files win over folders in a mixed drop, and the wiring failing does not stop boot (`src/app.ts:2159-2197`, `:445-460`).
- Keybinding customisation is a rule layer over an immutable default table, so reset is deletion (`src/services/keymap.ts:243-330`), with a conflict check before a chord is taken.
- Settings that arrive with a cloned repository are an eight-key allowlist, so a project cannot set a shell or a font (`src/services/config/schema.ts:22-33`).

## Not checked

- `npm run test:editor` (real Chromium) and the WebdriverIO e2e specs were not run; the unit suite was.
- Behaviour on a real desktop (native dialogs, the macOS native menu, the Windows drawn menu bar, the terminal) was read from code, not driven. A1-003 is a code-derived claim about the menu tree, confirmed by `tests/menu.test.ts:167-177`, and not a screenshot.
- The single-instance race in A1-001 is stated as speculative: nothing prevents a second process, but I did not reproduce two instances writing `session.json`.
- Multi-window and multi-root workspaces are absent; neither is expected of an editor at this size, so neither is a finding.
- Git, LSP, terminal, notes, agents, plugins, snippets and themes are inventoried as present and tested but were not exercised feature by feature; they belong to other lanes.
- Accessibility of the affordances (focus order, screen-reader names) was not assessed here.

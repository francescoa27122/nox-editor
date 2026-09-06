# A5 UI and UX

Audited at `54cece6e`. Walked in the browser build (`npm run dev`, `WebPlatform`, in-memory demo workspace "aurora") at 1280x720 and at the configured 640x420 minimum, with the accessibility tree read at every step. Desktop-only surfaces (native dialogs, terminal, LSP, git, agents, updater, window controls) were assessed from code and from `docs/screenshots/`.

## Summary

Nox looks and behaves like one product. The token layer is real and is held by tests (`tests/component-css-tokens.test.ts`, `tests/token-contrast.test.ts`, `tests/cursor-affordance.test.ts`), every icon-only button in `src/ui` carries an `aria-label`, the explorer, tab strip, palette, menu bar and context menu use the right ARIA patterns, focus is visible on every stop of a 23-stop tab walk, and empty and error states are written in sentences with a way out. The strongest findings are a corrupted glyph that prefixes every plugin status item with a literal "2" (`src/ui/StatusBar.svelte:426`), line numbers painted at 2.03:1 while `DESIGN.md` §3 promises 4.5:1 for anything a person reads and the contrast suite does not cover the token, and an in-window menu bar on Windows and Linux that Alt does not open. Sub-score 11 / 14: coherent and largely accessible, with a handful of real but contained a11y and platform-convention gaps.

## Sub-score

11 / 14

Justification: A5-001 is a visible defect in a shipped feature, A5-002 puts the one column every user reads under the project's own floor, and A5-003 is the platform-convention gap a Windows user hits in the first minute. The rest are polish. Nothing found makes the app feel like a demo, and nothing is an accessibility failure that blocks a keyboard user.

## Findings

```
ID:          A5-001
Lane:        UI and UX
Severity:    P2
Title:       Plugin status-bar items are prefixed with a literal "2" because the leading mark is a corrupted glyph
Location:    src/ui/StatusBar.svelte:425-429
Evidence:    The rule reads
               .item.plugin::before {
                 content: '' + '2';   (bytes C2 82 32 on disk)
                 color: var(--nox-accent-dim);
                 font-size: 9px;
               }
             Verified two ways: python reports the code points of that line as
             [..., 0x27, 0x82, 0x32, 0x27, ...], and Chromium's parsed stylesheet
             in the running app serialises the rule as
             `.item.plugin.svelte-1h7dsph::before { content: "2"; ... }`.
             U+0082 is a C1 control character and renders as nothing, so what
             paints is the "2". The same bytes are in the commit that introduced
             the rule (c82aa9d, "Let plugins put a readout on the status bar"),
             so the intended mark never shipped. The comment above it says the
             mark is "the smallest thing that says whose it is".
Impact:      Every plugin status item reads as "2 <text>" in accent-dim 9px, on
             every platform. `tests/plugin-status.test.ts` checks the service,
             not the paint, so nothing catches it.
Fix sketch:  Replace the content with the intended glyph (a small bullet or the
             plugin icon path), write it as a CSS escape (`content: '\2022'`)
             so the file cannot carry an invisible byte again, and add a line
             to `tests/component-css-tokens.test.ts` or a sibling that rejects
             C0/C1 control characters inside `<style>` blocks.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A5-002
Lane:        UI and UX
Severity:    P2
Title:       Line numbers are painted at 2.03:1 and the contrast suite does not hold the gutter token
Location:    src/styles/tokens.css:125, src/editor/theme.ts:102, tests/token-contrast.test.ts:150-159
Evidence:    `--nox-gutter-fg: #3d4657;` and `theme.ts:102` paints
             `.cm-gutters` / `.cm-lineNumbers` with it. Computed with the same
             WCAG formula the suite uses: #3d4657 on `--nox-bg-editor` #0b0e14
             is 2.03:1, and on Umbra's #000000 editor 2.21:1. `TEXT_TOKENS` in
             the suite lists `--nox-text`, `--nox-text-bright`,
             `--nox-text-muted`, the accent and the four semantics; the gutter
             tokens are in neither `TEXT_TOKENS` nor the `--nox-syn-*` sweep, so
             no test sees the value. `DESIGN.md` §3 states the floor as "Not
             below 4.5:1. Syntax is the text a person spends the day reading,
             so WCAG 1.4.3 applies to it exactly as it applies to the chrome",
             and `tokens.css:70-95` records that `--nox-text-faint` was lifted
             from #4c5768 (2.60:1) for exactly this reason. #3d4657 is darker
             than the value that was judged unacceptable for icons.
Impact:      Line numbers are what "Go to Line", diagnostics, blame and every
             stack trace point at. At 2:1 they are unreadable on a bright
             screen and fail 1.4.3 (4.5:1) and even 1.4.11 (3:1). The active
             line's number (`--nox-gutter-active-fg`, 7.47:1) is fine, which
             makes the other nineteen on screen the odd ones out.
Fix sketch:  Lift `--nox-gutter-fg` to at least a 4.5:1 value that keeps the
             hue (something near #6d7d94 as `--nox-syn-comment` already is),
             and add `--nox-gutter-fg` to `TEXT_TOKENS` measured against
             `--nox-bg-editor` only, so the suite fails the next time it drifts.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A5-003
Lane:        UI and UX
Severity:    P2
Title:       Alt does not open the in-window menu bar on Windows and Linux, and there are no mnemonics
Location:    src/ui/MenuBar.svelte:110-149, src/app.ts:4570-4573
Evidence:    `onBarKeydown` handles ArrowLeft/Right, ArrowDown, Enter, Space,
             Escape, Home and End, and only while the bar already has focus.
             The single route into the bar from the editor is
             `'F10': 'menubar.focus'` (app.ts:4573), whose comment says
             "Alt-mnemonics were the alternative and collide". Nothing in
             `src/` listens for a bare Alt press or Alt+letter. Tested in the
             browser build with the editor focused: pressing Alt leaves
             `document.activeElement` on the CodeMirror textbox and
             `.menu-bar.showing` absent; F10 moves focus to the "File" title.
             No title carries an underlined access key.
Impact:      Every Windows application, and GTK on Linux, opens its menu with
             Alt or Alt+F. A stranger who presses Alt gets nothing, and the
             only discoverable path to the menu is the mouse or knowing F10.
             This is the platform's own convention, not a Nox one, and Nox
             draws this bar precisely because it hid the native frame.
Fix sketch:  Treat a lone Alt keyup with no other key in between as
             `menubar.focus` off macOS (the standard Windows gesture), and
             offer Alt+<first letter> for the eight titles where it does not
             collide (`Alt+G` is taken by Go to Line, and the comment already
             knows it). Keep F10 as the documented fallback.
Confidence:  Confirmed
Risk class:  Gated
```

```
ID:          A5-004
Lane:        UI and UX
Severity:    P3
Title:       The contrast suite measures tokens on flat surfaces only, so text on the interaction washes is unheld and two shipped pairs are under the floor
Location:    tests/token-contrast.test.ts:125-131, 150-159 and 332-340, src/ui/CommandPalette.svelte:1174-1183 and 1199-1201, src/ui/ExplorerPanel.svelte (rows using --nox-text-faint on .row.selected)
Evidence:    The suite tests each text token against six opaque surfaces and
             composites the four washes only to ask whether the wash itself is
             visible (1.25:1). It never asks what happens to text painted on
             top of a wash. Computed the same way the suite composites:
               `--nox-text-muted` on `--nox-selected` over `--nox-bg-raised`
                 = 3.34:1. That is the quick-open selected row's path
                 (`.detail`) and the selected row's chord (`.row.selected .hint
                 { color: var(--nox-text-muted) }`).
               `--nox-text-faint` on `--nox-selected` over `--nox-bg-panel`
                 = 2.52:1, under the 3:1 the token is licensed for; that is
                 the explorer's twisty and file icon on a selected row.
             `DESIGN.md` §3 already admits the same effect for syntax under a
             selection (3.21:1) and argues it. The chrome cases are not argued
             anywhere.
Impact:      The one row the keyboard user is looking at in quick open shows
             its file path and chord at 3.3:1, and the selected explorer row's
             icons drop below the non-text bar. Small, but exactly the class
             the suite exists to catch, and the next wash retune will not be
             noticed.
Fix sketch:  Add a table of (foreground token, wash token, surface token)
             triples the components actually use and hold each to the bar for
             its kind; set `.row.selected .hint` and `.row.selected .detail` to
             `--nox-text` rather than muted.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A5-005
Lane:        UI and UX
Severity:    P3
Title:       Key labels use macOS glyphs on every platform, and the explorer's Delete hint is hardcoded to one
Location:    src/services/keymap.ts:198-211 and 214-233, src/ui/ExplorerPanel.svelte:493
Evidence:    `KEY_LABELS` maps `backspace: '⌫'`, `delete: '⌦'`, `enter: '↵'`,
             `tab: '⇥'` and the arrows to symbols, and `formatChord` applies
             `KEY_LABELS[key]` before it branches on `isMac` (line 219), so a
             Windows chord renders as `Ctrl+⌫`. The explorer context menu does
             not even go through the keymap: `hint: '⌫'` is a literal. Seen in
             the browser walk on this Windows machine: the explorer's context
             menu shows "Rename… F2" beside "Delete… ⌫", and the tab bar and
             menus otherwise spell chords as `Ctrl+Shift+P`.
Impact:      Inconsistent within one menu, and ⌫ means nothing to a Windows
             user, who would press Delete (which the tree does handle,
             ExplorerPanel.svelte:644-649, so the hint under-advertises).
Fix sketch:  Give `KEY_LABELS` a per-platform half (Backspace, Del, Enter, Tab,
             Up/Down on non-mac) and derive the explorer hint from
             `formatChord('Delete')` or from the keymap.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A5-006
Lane:        UI and UX
Severity:    P3
Title:       At the 640px minimum the menu bar clips its last title behind a hidden scrollbar
Location:    src/ui/MenuBar.svelte:246-275
Evidence:    `.menu-bar { min-width: 0; overflow-x: auto; scrollbar-width:
             none; }` plus `::-webkit-scrollbar { display: none }`. Measured
             in the browser at 640x420: `scrollWidth` 281 vs `clientWidth`
             261, and the screenshot shows "Nox File Edit Find Go View Code To".
             The comment above the rule records the trade ("a 23px strip
             cannot host one") and that on Windows the three window controls
             push it further right at the same minimum.
Impact:      A mouse user at a small window sees a truncated "To" with no
             affordance that anything is scrollable; the Tools menu is reachable
             only by trackpad scroll, arrows, or the palette.
Fix sketch:  Collapse the trailing titles into a single overflow menu ("…")
             when the bar cannot fit them, the way toolbars do, or drop the
             title-bar breadcrumb before dropping menu titles.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A5-007
Lane:        UI and UX
Severity:    P3
Title:       Error toasts are announced politely, in the same live region as successes
Location:    src/ui/Toasts.svelte:17, src/services/notifications.ts:29-35
Evidence:    `<div class="toasts" role="status" aria-live="polite">` wraps
             every notification kind. `notifications.ts` distinguishes errors
             (sticky, timeout 0) from the auto-dismissing kinds, but the
             markup does not: "Could not save notes.md." is announced with the
             same politeness as "Copied diagnostics", and only after the screen
             reader finishes whatever it was saying.
Impact:      A blind user who just pressed Ctrl+S may hear the failure late or
             not at all if speech is busy; sighted users are unaffected.
Fix sketch:  Render `kind === 'error'` toasts inside a sibling
             `role="alert"` container (assertive by default) and keep the
             polite region for the rest.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A5-008
Lane:        UI and UX
Severity:    P3
Title:       The editor textbox has no accessible name, and the palette is named "Command palette" in all nine modes
Location:    src/ui/EditorPane.svelte:505-516, src/editor/ (no aria-label anywhere but folding.ts:33), src/ui/CommandPalette.svelte:971 and 988-991
Evidence:    The `<section aria-label="Editor">` wraps CodeMirror, but the
             focusable element is CodeMirror's `contentDOM`
             (`role="textbox"`), and nothing in `src/editor/` sets
             `contentAttributes` with a label, so the tab walk reported the
             editor stop as `DIV[textbox] '# Engineering notes## Scheduli'`:
             its name is its own first line. The palette root is
             `role="dialog" aria-label="Command palette"` whether the mode is
             quick-open, go-to-line, encoding, language or branch, and the
             live result count is a bare `<span class="result-count">158</span>`
             with no label, so a screen reader hears "158".
Impact:      A screen-reader user cannot tell which file the focused editor
             holds, nor which picker just opened; both are the two most used
             surfaces.
Fix sketch:  Pass `EditorView.contentAttributes.of({ 'aria-label': `${name}
             editor` })` from `EditorPane`; derive the dialog label from the
             mode's placeholder; give the count an `aria-label` of "N results".
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A5-009
Lane:        UI and UX
Severity:    P3
Title:       The editor is a keyboard trap with no documented exit and the status bar is unreachable by Tab
Location:    src/ui/Welcome.svelte:53-60, src/app.ts:3742-3755 (nav.focusEditor / nav.focusExplorer), src/ui/StatusBar.svelte:131-382
Evidence:    Tab inside CodeMirror indents and Shift+Tab dedents; tested in the
             browser: after focusing the editor, Shift+Tab leaves
             `document.activeElement` on the textbox. The 23-stop tab walk from
             the top of the window ends at the editor, and the status bar's
             seven buttons come after it in DOM order, so no Tab sequence ever
             reaches them. The only exits are chords (`Mod+Shift+E`, `F10`,
             `Mod+Shift+P`), and the Welcome screen's Keyboard list names
             Palette, Go to File, Open Folder, New File, Find and Toggle
             Explorer, none of which is "leave the editor with the keyboard".
             There is no "toggle Tab moves focus" command (grep for
             tabFocus/Ctrl+M finds nothing).
Impact:      WCAG 2.1.2 permits a trap only when the way out is told to the
             user. Every status-bar action does have a palette command, so
             function is not lost, but a keyboard-only stranger will not find
             that out from the UI.
Fix sketch:  Add `nav.focusStatusBar` and a `view.toggleTabFocus` (the Ctrl+M
             convention), and put "Command Palette" plus one "leave the editor"
             chord in the Welcome Keyboard list.
Confidence:  Confirmed
Risk class:  Gated
```

```
ID:          A5-010
Lane:        UI and UX
Severity:    P3
Title:       Five font sizes are hardcoded outside the type scale, which the token test cannot see
Location:    src/ui/Sidebar.svelte:239, src/ui/StatusBar.svelte:428, src/ui/AgentPanel.svelte:360 and 478, src/ui/SettingsPanel.svelte:499
Evidence:    `font-size: 9px` (rail badge), `font-size: 9px` (plugin mark),
             and `font-size: 0.92em` three times. `--nox-fs-2xs` is the
             smallest step at 10px. `DESIGN.md` opens with "components never
             hardcode a colour, radius, duration or font", and
             `tests/component-css-tokens.test.ts` enforces only the colour
             half (`LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/`).
Impact:      Two glyphs render below the smallest size the scale allows, and
             the rule the docs state is not the rule the test holds.
Fix sketch:  Add `--nox-fs-3xs: 9px` if 9px is wanted, use it, and extend the
             literal regex to `font-size:\s*\d`.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A5-011
Lane:        UI and UX
Severity:    P3
Title:       The README hero screenshots show a rail with two views; the product has seven
Location:    docs/screenshots/editor.png, docs/screenshots/review.png, README.md:15-16
Evidence:    `git log -1 --format=%ad -- docs/screenshots/editor.png` is
             2026-08-13. `NotesPanel.svelte`, `GitPanel.svelte` and
             `ProblemsPanel.svelte` were added 2026-08-14, 08-17 and 08-20,
             and `Sidebar.svelte:54-68` lists seven views. Both images show
             only Explorer and Search in the rail, no References or Git, and a
             narrower status bar than the current one.
Impact:      The first thing a stranger sees is a picture of an older product;
             the README's own "What makes it different" then names panels the
             picture does not have.
Fix sketch:  Retake both with the recipe in `docs/screenshots/README.md`, and
             note in that file which release they show.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A5-012
Lane:        UI and UX
Severity:    P3
Title:       Known debt row "The menu has no Close Window item" is accurate but overstates the reach off macOS
Location:    ARCHITECTURE.md §7 (row "The menu has no Close Window item"), src/ui/TitleBar.svelte:252-279, src-tauri/src/window_state.rs:104-108
Evidence:    The row says "the traffic light and ⌘Q are the ways out". On
             Windows `capabilities.customWindowControls` is true
             (`platform/tauri.ts:95`) and `TitleBar.svelte:270-277` draws a
             labelled "Close window" button; the Rust side handles
             `WindowEvent::CloseRequested` so Alt+F4 goes through the same
             geometry write. So the missing item costs a menu row on every
             platform but a way out only where there is neither a native menu
             nor drawn controls, which is Linux with decorations on. The
             description and severity are right; the scope line is
             macOS-shaped.
Impact:      None functional. A reader of the table would conclude Windows has
             one fewer way to close than it does.
Fix sketch:  Amend the row to "the traffic light (macOS), the drawn Close
             control (Windows) and ⌘Q / Alt+F4".
Confidence:  Confirmed (code); the Linux behaviour is read, not run
Risk class:  Safe
```

## What is good

- The token layer is enforced, not aspirational: `tests/component-css-tokens.test.ts` rejects any colour literal in a component's `<style>`, `tests/token-contrast.test.ts` holds every text token to 4.5:1 on every surface in both themes and lists the 21 permitted non-text uses of `--nox-text-faint` by selector, and `tests/cursor-affordance.test.ts` holds the pointer-versus-arrow rule to a named list. Each test carries the regression that motivated it.
- Every icon-only `<button>` in `src/ui/*.svelte` has an `aria-label` (a scripted sweep over 84 `<Icon>` uses found zero exceptions), and stateful ones carry `aria-pressed` (`TitleBar.svelte:226-235`, `Sidebar.svelte:127-132`, `StatusBar.svelte:144-152`).
- Correct ARIA patterns where they matter: virtualised `role="tree"` with `aria-setsize` / `aria-posinset` so a screen reader is told the real length (`ExplorerPanel.svelte:744-776`), `role="tablist"` with roving tabindex (`TabBar.svelte:249-280`), `role="menubar"` as one tab stop with arrow tracking (`MenuBar.svelte`, held by `tests/menu-bar.test.ts`), `role="listbox"` with `aria-activedescendant` in the palette (`CommandPalette.svelte:973-1000`), `role="alertdialog"` on confirmations (`ConfirmDialog.svelte:74-81`), `role="separator"` splitters with keyboard resize and an explanation for each `svelte-ignore` (`App.svelte:118-136`, `EditorArea.svelte:95-110`).
- Focus is visible on every one of the 23 tab stops walked, through one `:focus-visible` ring (`base.css:83-87`) argued for at 3:1 in the comment above `tokens.css:258-259`; the splitter deliberately paints its own (`App.svelte:228-245`).
- Focus returns where it came from: `ContextMenu.svelte:44-47`, `ConfirmDialog.svelte:49-52`, and `UIService.closeOverlay` refocusing the editor (`services/ui.ts:239-242`).
- Reduced motion is honoured completely: all five duration tokens including the two ambient loops go to 0 under `prefers-reduced-motion` (`tokens.css:288-296`), every `transition` and `animation` in `src/ui` and `src/editor` reads a token, and a user theme is refused the motion keys (`core/theme.ts`, `tests/theme.test.ts:110`).
- Dark is set at every layer a stranger could hit: `<meta name="color-scheme" content="dark">` (`index.html:6`), `"theme": "Dark"` and a matching `backgroundColor` on the Tauri window so the first frame is not white (`tauri.conf.json`), `accent-color` and scrollbar colours from tokens (`base.css`).
- Error copy is written for the person reading it: the damaged-config family says what is in force, what will be overwritten, and where the copy went (`app.ts:690-740`); a dead language server is reported in its own words with the last stderr lines as fallback (`app.ts:1465-1478`); the browser build says plainly why "Edit Themes" has nowhere to go (walked). `ConfirmDialog` refuses to let Enter land on a destructive or capability-granting choice (`ConfirmDialog.svelte:23-30`).
- Empty states are one component with an action (`PanelEmpty.svelte`), and each panel's copy says the next step: Problems offers "Configure Language Servers", References "Find References", Notes "New Note", Search explains Enter. The empty split pane offers "Open a file" and "Close this pane" (walked).
- The Welcome screen is state-aware (`Welcome.svelte:38-51`): with a folder open its first action is "Go to file in <project>", and it lists six chords a new user needs. The status bar's language item is "never nothing" (`StatusBar.svelte:101-113`), and the encoding item opens a real picker (walked).
- Discoverability is tested: `tests/command-titles.test.ts` holds that no title repeats its category, that "zoom" reaches the font-size commands, and that every sidebar panel is reachable by the words "panel" and "sidebar".

## Not checked

- The packaged desktop app was not run: macOS traffic-light inset, the Windows drawn window controls, native open/save dialogs, the terminal, a live language-server crash, an agent process dying, and the updater's failure toast were assessed from code (`TitleBar.svelte`, `updates.ts:206-232`, `lsp/session.ts:346-354`, `agent/stdio.ts:226-230`) and from `docs/screenshots/`, not observed.
- `npm run test:editor` (real Chromium geometry) was not run; the browser walk used the dev build instead. Storybook's axe pass was not run.
- No screen reader was driven; ARIA claims rest on the accessibility tree the browser exposed.
- Ctrl+A inside chrome text fields could not be verified: the browser pane's synthesised Ctrl+A did not select in the project-search field, but the keydown reached the input un-prevented in both capture and bubble phases, which points at the automation (CDP editing commands) rather than Nox. Not reported as a finding.
- The Umbra theme and a user theme were not walked visually; contrast for Umbra is from the suite's arithmetic.

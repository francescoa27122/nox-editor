# Work log

State between sessions. Newest entry on top, roughly ten kept.

Durable knowledge — decisions, gotchas, the reasons behind a design — belongs
in `docs/superpowers/specs/` and in commit messages. **This file is state; those
are knowledge.**

---

## 2026-08-23 (PC, later still) — Two lifecycle bugs the walk turned up

Third pass, same brief. The first two found things you could see; this one
found things that only show up if you drive the app rather than look at it.
Both are the same shape — a panel closing without taking its state with it —
and both were reproduced in the browser build before a line was written.

- **`c2e4e16`** — the find panel had two exits that did different things. The
  close button ran `find.clear()`; Escape left all 8 matches still boxed in a
  document with no find bar on screen. `FindPanel` called `clear()` from three
  places and only the button's could ever run: `keymap.ts:627` installs the
  global handler with `capture: true`, so Escape reached `view.dismiss` first
  and `dismissTop` unmounted the component before its own keydown fired. The
  highlight now hangs off `ui.findOpen`. That exposed the mirror-image bug —
  `find.query` outlives a close on purpose, and nothing carried it back to the
  view, so a reopened panel showed the remembered text over "No results" and
  an unmarked document. `reapply()` is the counterpart to `clear()`; it is
  deliberately not `refresh()`, which is taken by the typing-path recount.
- **`75c2061`** — every confirm and prompt dialog dropped focus to `<body>` on
  the way out. ⌘W on a dirty file, Escape, and the next keystroke goes
  nowhere. The destructive answers were fine by accident (closing the buffer
  makes the replacement pane focus itself), so the one path that left you
  unable to type was the path where *nothing happened*. `ContextMenu` has had
  the take-it-and-give-it-back shape since it was written; these two never got
  it.

**Checked and found healthy**, so nobody re-walks them: every panel's empty
state has a one-click way out and reads well with no folder open; no
unlabelled buttons anywhere in the chrome; the reveal-on-hover actions in five
panels all handle `:focus-within`; the sidebar splitter already has a 9px hit
area, arrow-key resize and its own focus indicator; the confirm dialog is a
proper `alertdialog` that focuses the safe choice; Escape returns focus
correctly from the palette, Settings, Search and the context menu.

**Not a bug, for the record.** "Could not copy to the clipboard" in the browser
target is the preview environment lacking clipboard permission, not Nox. It
also does not reproduce in the desktop build, which is where Copy Path is
meant to run.

A fourth landed after that: at a 560px window the title bar pushed Commands,
the sidebar toggle and Settings clean out of the viewport with nothing to
scroll them back. `.menu-bar` is `flex: 0 1 auto` and so nominally
shrinkable, but it is a flex container and `min-width: auto` on one resolves
to min-content — its eight titles side by side, 294px — which it will not go
below. `min-width: 0` plus `overflow-x` makes it yield instead. Reachable in
the browser build at any width, and on Windows at the 640px `minWidth` the
desktop app already allows, where three window controls sit further right
still. No test: jsdom has no layout, and `tests/menu-bar.test.ts` says in its
header that nothing geometric may be claimed there.

---

## 2026-08-23 (PC, later) — Hover, and what the pointer could not reach

Follow-up pass with the same brief as the entry below — day-to-day workflows,
"little things" — but starting from the operator's own observation that the
top bar of menus did not react to the mouse. It does react. The reaction was
1.06:1.

Three findings, all measured in the browser build at 1280x720 rather than read
off the source, and all shipped:

- **`b93455c`** — the interaction tokens were all under the threshold at which
  a flat fill registers. `--nox-hover` at 5.5% cyan composites to 1.06:1 over
  bg-panel, and fourteen rules across five panels used it as their *only*
  hover feedback, so the explorer tree, search results, problems, references,
  notes and both dialogs' buttons were inert under the pointer. All four moved
  together because the order between them is load-bearing; the ladder over
  bg-panel is now hover 1.34 < selected 1.44 < active 1.62 < selected-strong
  1.89. `token-contrast.test.ts` gained a `composite()` and a 1.25:1 floor
  measured on Umbra's pure-black editor. Same shape of failure as
  `--nox-text-faint` in August: argued in prose, never measured, quietly
  load-bearing.
- **`7389643`** — the menu bar could not be reached while one of its menus was
  open. `MenuBar`'s `onmouseenter` has claimed since it was written to be "the
  reason a bar feels like a bar" and had never once run: `ContextMenu`'s
  click-away layer is `inset: 0` at `--nox-z-dropdown` and covers the titles.
  Fixed by raising the bar to the popup's own z-index while open (a tie, so
  DOM order still puts the menu on top) **and** by `placeMenu` refusing to
  cover its anchor — the 2026-08-23 clamp gave a too-tall menu the whole
  viewport, and the File menu at 30 items opened at y=8 over a bar ending at
  y=29.
- **`057ac62`** — the breadcrumb sits inside the header's drag region with no
  `no-drag`, unlike `.actions` and `.menu-bar`. Unverified locally: no drag
  regions in the browser and macOS uses `data-tauri-drag-region`. For the
  Windows and Linux shells.

**Raised as the operator's call, then made.** 38 of the 39 interactive
controls in the chrome showed the arrow cursor; only a breadcrumb segment
pointed, and five components had reached for `cursor: pointer` locally while
`base.css` said otherwise — which is what a rule looks like when it is missing
from the place that should own it. Flipped in a follow-up PR: `button` points,
`button:disabled` does not, and list rows keep the arrow because they are
things you select. The six local declarations came out; the exceptions live in
`tests/cursor-affordance.test.ts` because a comment cannot fail.

---

## 2026-08-23 (PC) - UI passthrough: thirteen findings from walking the app, twelve fixed

The operator asked for a pass over the whole editor for intuitiveness and
cleanliness. Walked the browser target under Playwright at 1440x900 rather
than reading the code, which is why these are measurements and not opinions.

The design system itself is in good shape - tokens, empty-state copy, tooltips
and aria labels are consistent and well argued. Everything below is navigation
naming, or a place that outgrew its container.

Shipped, in three commits:

- **`9aff916`** - the three that cost you what you were doing. Menus taller
  than the window were clipped with no scroll: the placement rule only ever
  flipped, which cannot rescue a menu taller than the viewport, and View
  measured **903px in a 900px window** with `overflow-y: visible`. Placement is
  now `core/menu-placement.ts`, pure, because jsdom has no layout and
  `tests/support/jsdom-layout.ts` forbids inventing rectangles there. Eleven
  explorer commands (Rename, Delete, Duplicate, Copy Path) moved out of **View**
  into File; the three real tree operations stay. And the menu bar stopped
  taking the keyboard on mount - its focus effect used the shape every panel
  uses, but a panel mounts because you opened it while the bar mounts with the
  window.
- **`babbe23`** - findability. `titleForArg` so a parameterised command names
  its own bound rows (nine rows read "Go to Tab by Number"; the panel could not
  derive the number because the arg is 0-based and the chord is 1-based). The
  palette no longer lists the command that opens the palette. All seven sidebar
  panels carry `panel`/`sidebar` keywords, with a table-wide test.
- **`13fdf35`** - Search got the `PanelHeader` and the two `PanelEmpty` states
  the consolidation had missed, preserve-case moved inside the replace
  disclosure, `Wrap` moved inside `{#if active}` so an empty pane no longer
  leaves the status bar reading as one word, and the demo README stopped
  teaching Mac chords on Windows (host check now shared in `platform/host.ts`).

Verified:

- `npm test` 1905 (130 files), `npm run check` 968 files 0 errors, `npm run
  build` green.
- Every behavioural fix mutation-checked: reverting the boot-focus guard, the
  `Wrap` move and the Search `PanelHeader` each turned the named test red.
- Re-measured in the running app after each change - View menu now 884px tall
  inside a 900px viewport with `overflow-y: auto`; boot focus lands on
  `.cm-content` and a typed character reaches the buffer; F10 still reaches the
  bar; Tools menu reads "Open Git Panel"/"Open Notes Panel" rather than three
  identical "Show Panel" entries.

Decisions worth not re-litigating:

- **Re-clicking the active rail icon no longer collapses the sidebar.** The
  convention it followed assumes a persistent activity bar; this rail lives
  *inside* the aside it was collapsing, so the click deleted its own affordance
  and the other six with it. Ctrl+B and the title-bar button still collapse,
  and both now say "Sidebar", which is what they hide.
- **The stutter (`Git: Show Git`) is fixed by renaming to `Open Git Panel`, not
  by trimming to `Show Panel`.** Menus render the title *without* its category,
  so the shorter name would have put three identical entries in Tools. A
  table-wide invariant test for the stutter was written and then deleted: it
  also flagged `Terminal: Toggle Terminal` and `File: Close File`, which are
  correct in the menu and only mildly redundant in the palette.
- **No new keybindings.** References keeps no chord of its own by an argued
  decision at `app.ts:3882` - Shift+F12 already fills and shows it - so the
  fix was the rail tooltip, which now names that chord. Git genuinely has none
  and the mnemonic letters are taken; freeing Ctrl+Shift+G from Find Previous
  is a trade worth the operator's call, not mine.

Not fixed, deliberately: the remaining duplicate rows in the keybinding editor
(`Edit: Find Next` twice, for Ctrl+G and F3). Each binding must stay separately
removable, which is what a row per binding buys, and sorting already places the
alternatives adjacent.

Next: **the desktop build is unverified for all of this.** Everything changed
is chrome the browser target renders identically, but `--geometry`, the macOS
overlay title bar and the native menu are exactly what a browser session cannot
see - and the menu-placement change touches the popup the in-window menu bar
uses on Windows and Linux. A desktop walk is the check.

Blocked: nothing. Unpushed by design - the repo is public and a push is
publication.

Confidence: high on the twelve fixes, each measured before and after in the
running app and held by a test. Medium on the desktop build, which no test and
no browser session can reach.

## 2026-08-22 (PC, later) — Code actions, and four fixes that led to them

Second half of the same day. The operator asked what should be built next,
then said build it — so this entry is one feature and the four bugs that came
before it, all merged.

Shipped:

- **#103 code actions**, the feature. `⌘.` asks the server what it can do at
  the caret and lists the answers. The decision worth remembering is **where
  an action lands, and that it is not the server's `kind`** — servers disagree
  about `quickfix` versus `refactor`, so branching on it inherits their
  disagreement. It is how far the change reaches: one file applied directly
  (a fix at your own caret is not a proposal), more than one staged in review
  (which is what review is for, and the shape rename already produces).
  Actions that are a server *command* are listed and disabled with the reason
  rather than hidden, because a picker that hid them would blame the server
  for something Nox has not built.
- **#97** the menu bar rebuilding on a rebinding, **#98** the fake pruning
  machine directories like the real walker, **#99** auto-imports arriving with
  their completion, **#101** the server's own `textEdit` range being applied,
  **#96** UTF-16 actually being written as UTF-16.

Verified:

- `npm test` 1885 (128 files), `npm run check` 964 files 0 errors, build
  green, 7/7 CI on every PR including the three Rust jobs.
- Every fix mutation-checked. Two mutation checks earned their keep by
  catching tests that passed for the wrong reason — #97's first draft
  asserted on `menu.describe()` rather than the rendered popup, and #99's
  "one transaction" test counted transactions instead of the changes inside
  one, which a version that dropped the import entirely also satisfies.
- Code actions were driven in the running app for the part the browser can
  show: no language server there, so the command is correctly disabled while
  the palette still lists it with its chord. The new lightbulb path was
  *rendered* and measured rather than eyeballed, because a malformed `d` draws
  nothing and raises no error.

Next: **`JsonRpcTransport.onRequest` has a definition and zero callers**, so
every server→client request is refused. That one seam is what four separate
things wait on — running a code action that is a command
(`workspace/executeCommand` → `workspace/applyEdit` back),
`workspace/configuration` (pyright, gopls and rust-analyzer fall back to
defaults without it), `client/registerCapability` (dynamic registration, which
is how rust-analyzer and gopls ask to watch files), and work-done progress. It
is the highest-leverage piece of LSP work left, and code actions made the case
for it concrete rather than theoretical.

Blocked: the desktop keyboard pass needs a real Mac keyboard, and the
certificate is a purchase. Both are still the whole of 1.0 — but the
certificate half moved:

- **Apple only, Windows deferred** (operator's decision, same day). The
  workflow is wired and merged in #105: six secrets beside the updater's two,
  and a guard that refuses a *half*-present configuration. Signing without
  notarizing is the trap it exists for — Gatekeeper still stops the app, so
  the release notes would promise a clean first launch that never happens.
- Nothing here could be tested by CI: the release workflow fires only on a
  tag. The guard was **extracted from the YAML and run** over its four states
  instead, empty-string secrets included, since that is what an unset GitHub
  secret becomes. The first tagged release with real secrets is still the
  first real test — which is why the runbook makes it a `-rc` prerelease.
- The human half is `docs/superpowers/specs/2026-08-22-apple-signing-design.md`:
  enrolment, CSR, export, the six secrets, and what to verify with `codesign`,
  `spctl` and `stapler` rather than trusting the absence of a dialog. It flags
  once that an *individual* Developer ID puts a legal name in every shipped
  binary, readable with `codesign -dv` — decided at enrolment, awkward after.
- Install docs left alone deliberately: `README.md:38-53`, the workflow's
  `releaseBody` and the roadmap row are accurate until a signed release
  exists. The spec lists all three, the way 0.5.1 did for the updater.

Confidence:

- High on all six. Every claim has a command behind it.
- Medium on one thing in code actions, and it is the same limit every LSP
  feature here has: the tests replace `requestFor`, so they prove Nox's half
  of the conversation. Whether tsserver's quick fixes arrive in the shape this
  reads is a desktop-walk item, and no test on this machine can settle it.

## 2026-08-22 (PC) — Three PRs: damaged config, split panes, single-match replace

The work log stops at v0.5.1 and the repo is at 0.8.3. **This entry does not
try to fill that gap** — 0.6, 0.7 and 0.8.0–0.8.3 went unlogged and inventing
entries for sessions nobody recorded would be worse than the hole. It records
this session only.

Started from "find the three most substantial things and do them". Research
went out in parallel over the roadmap, the code, and a bug hunt in everything
0.6–0.8.2 shipped. The roadmap answer was that **every 1.0 code row is
already done** (`ROADMAP.md:202`) and what is left is a real-keyboard pass and
two certificates — a ritual and a purchase, neither of them code. So the three
came from the bug hunt and the debt table instead, which is what the priority
function says anyway: things that make existing claims untrustworthy first.

Shipped, as three PRs, all merged to `main` with CI green on all seven jobs:

- **#92 `fix/damaged-config-files`** — four load paths treated a config file
  they could not parse as a file that was not there, then wrote over it:
  `settings.json` (`services/config/index.ts:229`), `keybindings.json`
  (`services/keymap.ts:415`), `session.json` (`services/session.ts:396`),
  `notes.json` (`services/notes.ts:153`). `servers.json` and `agents.json`
  always reported theirs — neither is ever written back, which is why the
  asymmetry survived. New `core/damaged-config.ts` + `services/damaged-config.ts`;
  a `damaged` signal per service, deliberately not `error` (which `#save`
  clears ~250 ms later); and a salvage that reads the `unsaved-N.txt` /
  `note-N.txt` high-water mark out of the *unparseable* text, because a
  restarted counter is what turned a damaged index into a destroyed body file.
  Also `workspaceConfigPath`, which built `.nox/settings.json` with a hardcoded
  `/` — on Windows a different *string* from what `join` and the watcher
  produce, so the file never hot-reloaded and opening it twice made two buffers.
- **#93 `fix/pane-and-session-fidelity`** — six defects in the panes feature
  shipped 0.8.0–0.8.2. The bad one: `#dispatchToView` broadcast a
  workspace-originated change to every pane while each pane's route back
  through `applyTransaction` had already mirrored it, so the second pane
  applied it twice. A grown file came back as itself plus a slice of itself,
  and `reloadFromDisk` then marked that **clean** — next save writes the
  corruption to disk. Now first-acceptor for delivery, `#mirrorToOtherViews`
  (annotated, so nothing re-enters) for the forward. Plus: `selectionOf`
  handed every background tab the foreground tab's cursor; restore's
  `splitEditor()` moved a tab every launch; no production caller passed a group
  to `close`, so ⌘W in the second pane closed the first; `Close All Files`
  iterated deduplicated `buffers`; the session recorded no charset so non-UTF-8
  tabs vanished; Reopen with Encoding discarded unsaved edits without asking.
- **#96 `fix/utf16-encode`** — the bug the first pass left, taken up on
  request. See the Blocked section below for what it was and how it was
  verified without a local toolchain.
- **#94 `feat/replace-single-matches`** — the v0.3 roadmap row.
  `computeReplacements` had accepted a `skip` set since it was written and no
  caller ever passed one. An exclusion is an *identity* (path, line, absolute
  column), never an index, because `#replacePaths` recomputes from current
  text; an identity that cannot be relocated refuses the file rather than
  guessing. Both actions are commands, so the results list stops being
  mouse-only.

Verified:

- `npm test`: 1803 on #92, 1795 on #93, 1790 on #94, all green from a 1777
  baseline. `npm run check` 951–953 files, 0 errors. `npm run build` green.
- CI green on all three, seven jobs each: web on ubuntu and windows under
  node 20 and 22, and rust on ubuntu, windows and macOS. #93 and #94 were
  rebased onto main and re-run after the merges ahead of them, rather than
  merged on a stale green.
- The three branches conflicted only in `CHANGELOG.md`'s `[Unreleased]` block
  and `ARCHITECTURE.md`'s decision log and debt table — every conflict was two
  independent additions, resolved by keeping both, and `npm test` was re-run
  after each resolution (1821, then 1834).
- **Every fix mutation-checked** — reverting it fails the test that names it,
  with the reported symptom (duplicated text; `RangeError: Invalid change
  range 0 to 4 (in doc of length 2)`; `[['a.ts'],['b.ts','c.ts']]` instead of
  `[['a.ts','b.ts'],['c.ts']]`; a background tab reporting `[[2,2]]` for
  `[[14,14]]`).
- #94 driven in the running app, not only under Vitest: dismiss took the row
  out *and* dropped the file's count badge, a one-match replace landed with
  its toast, and the row height was **measured** at 22px because
  `SearchPanel.svelte:81` says the windowing arithmetic breaks otherwise.

~~Left on the table: a completion's own `textEdit` range, computed and never
used.~~ **Fixed on request in #101**, and it turned out to carry a latent
crash with it: `InsertReplaceEdit` has no `range` field, so
`item.textEdit.range.start` threw a `TypeError` out of the completion source
and killed completions for that server silently.

The range's **start** is applied and its **end** deliberately is not — the end
is replace mode, which LSP gates behind `insertReplaceSupport`, a capability
`session.ts` does not advertise, and insert mode is every editor's default.
That is now a debt row phrased as a decision rather than an omission.

**Three in three days of one shape** — the `skip` set on
`computeReplacements`, `additionalTextEdits`, and this range: a value
converted carefully, *tested at the conversion*, and never consumed. The
conversion being covered is precisely what hides it, because the test passes
while exercising a function whose output goes nowhere. Worth a grep next time
something looks well-tested: who reads this?

Next: **the desktop keyboard pass.** `.desktop-pass-report.md` has 12 of 17
items UNSEEN, and it is one of only two things between here and 1.0. It needs
a real keyboard on macOS and it is not doable from this machine. Everything
that *is* code on the 1.0 bar is done.

Blocked:

- ~~`src-tauri/src/encoding.rs` writes UTF-8 when asked for UTF-16.~~ **Fixed
  the same day, in #96**, after the operator asked for it. `encoding_rs`
  implements the WHATWG standard, in which UTF-16 is decode-only, so
  `UTF_16LE.encode` used `output_encoding()` — UTF-8 — and reported no
  unmappable characters while doing it. UTF-16 is encoded in this module now,
  with its byte-order mark, which is also what makes the file detectable
  again. Still no Rust toolchain here, so the algorithm and every test vector
  were checked against Python's `codecs` over 4020 strings first, and the
  compile-and-run half is CI's on all three platforms rather than a local
  claim.
- ~~Smaller, unfixed: stale menu accelerators, the fake's missing
  always-exclude list, `additionalTextEdits`.~~ **All three fixed the same
  day, on request** — #97, #98 and #99. Nothing from this session's findings
  is left open.
  - **#97** `MenuBar` derived from `commands.version` alone while its own
    comment claimed it rebuilt when "the command table *or a keybinding*"
    moved. One line, plus the comment saying why it is not optional. The
    first draft of its test asserted on `menu.describe()` and passed against
    the bug; the shipped one reads the rendered popup.
  - **#98** `core/search-match.ts` exists to mirror `search.rs` and had no
    `ALWAYS_EXCLUDE`, so the browser target and every service test walked
    `node_modules`. The three-group precedence was copied with the list,
    because it is the whole policy: always-excludes are the *weakest* group,
    so an explicit include reaches into them.
  - **#99** the substantial one. Auto-import completions inserted the symbol
    and dropped the import — silent wrong output from the most-used LSP path.
    The completion is inserted synchronously and the import joins it in the
    same transaction when known, a second one when the server only computes
    it on resolve. `info`'s existing lazy resolve is cached and read by
    `apply`, which is what makes the atomic path the common one rather than
    the exception.

Confidence:

- High on all three PRs: every claim has a command behind it and every fix has
  a mutation check, which is a stronger bar than "the tests pass".
- High that the pane corruption was real — traced line by line through
  `applyTransaction` and reproduced before it was fixed.
- Medium on the Windows separator bug *manifesting*: the string mismatch is
  certain and now tested, but I could not run a Windows Tauri build to confirm
  the folder dialog returns backslash paths.
- High on the UTF-16 fix's *behaviour* — the encoder agrees with an
  independent implementation across 4020 strings including astral characters,
  and CI compiled and ran the Rust. Nothing about it was verified by reading
  alone.

## 2026-08-20 (PC, release) — The key ceremony, and v0.5.1

The ceremony (spec §8, "human hands only") ran on Francesco's keyboard; my
half was everything around it. Key id `A40CD806C398B1A7`.

What went wrong first, and is now in §8 so it does not happen twice:

- **`~` is not expanded for native executables in PowerShell.** I handed over
  bash commands for a PowerShell prompt, so `tauri signer generate -w
  ~/.tauri/...` created a **literal `~` directory inside the repository** —
  the one place §8 says a private key must not go, in a public repo.
  Assessed before touching anything: untracked, in no commit, never pushed,
  and `%USERPROFILE%\Desktop` is not OneDrive-redirected, so not synced.
  **Nothing was exposed and no regeneration was needed.** Moved the pair to
  `$HOME/.tauri/` and removed the directory, without reading the private
  half.
- **PowerShell has no `<` redirection**, so `gh secret set NAME < file` is a
  parser error rather than a secret. `Get-Content -Raw |` is the form.

- The key is password-protected, **proven rather than assumed**: signing a
  throwaway file with `-p ""` returned "Wrong password for that key", which
  is what made `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` a required step and not
  an optional one.
- One false alarm I raised and corrected: a checklist line reported the
  private-key secret `MISSING` because the grep anchored `$` against lines
  that end in a timestamp. The tool was wrong, not the state — the same
  "check the tool before believing the measurement" trap as ever.

Shipped:

- **The public key** into `plugins.updater.pubkey` (#55). It landed *before*
  the secrets could bite: `release.yml`'s guard deliberately fails any build
  where the private key is set and the pubkey is empty, so between 02:02
  (secret set) and the merge, a tag would have produced a **failed** release
  rather than an unsigned one.
- **v0.5.1** — five version files, the changelog section, and `releaseBody`'s
  macOS paragraph, which the spec said to soften once a signed release
  exists: a fresh download still needs `xattr -dr`, an update installed from
  inside Nox does not, and the notes now say so instead of teaching the
  ritual as the only path.

**0.5.1 has no feature changes on purpose.** `pubkey` is baked into the
binary at build time, so every build up to and including 0.5.0 carries an
empty one and can verify nothing, ever. 0.5.1 exists to be the first build
that is both signed and able to verify. Everyone on 0.5.0 installs it by
hand, once.

Verified:

- `npm test` 1421/1421, `npm run check` 473 files 0 errors, build green.
- The gate's four comparisons run by hand: all five version files read
  0.5.1.
- `release.yml` still parses as YAML (both jobs present) and is clean UTF-8
  with no replacement characters — worth checking, because the console
  renders its em-dashes as `?` and that looks exactly like corruption.
- The real proof is the release itself: `latest.json` present on the release
  and the endpoint returning 200 instead of 404. Nothing before that moment
  demonstrates the chain works end to end.

Next:

- The 1.0 keyboard pass on the Mac, and the two OS certificates. Those are
  the last three 1.0 bar rows and none of them is code.

Confidence:

- High on the mechanics; the one thing no local check can establish is
  whether CI's signing step actually produces a valid signature, since the
  private key never comes near this machine's build. The release run is the
  first and only test of that.

## 2026-08-20 (PC, release) — Cut v0.5.0

PR #53 merged first (`bd14716`, CI green on all five jobs). Then the release,
on branch `release-0.5.0`, following the shape `release-0.4.3` (#44) set.

**Tagging alone would have failed.** `release.yml`'s gate reads
`src-tauri/tauri.conf.json`'s version and cross-checks `package.json` and
`src-tauri/Cargo.toml` against it *and* against the tag, before spending
twenty minutes on binaries. All three said `0.4.3`, so `v0.5.0` would have
been rejected at the first step. The bump is the release; the tag only
records it.

Shipped:

- **Five version files** to 0.5.0: `package.json`, `package-lock.json` (both
  the top-level and the `packages[""]` entry), `src-tauri/tauri.conf.json`,
  `src-tauri/Cargo.toml`, and the `nox` entry in `src-tauri/Cargo.lock`.
  **`Cargo.lock` is edited by hand** because there is no Rust toolchain on
  this PC — the same thing 0.4.3 did, and safe for the same reason: the gate
  cross-checks the versions and the three Rust CI jobs build with this
  lockfile, so a lie here fails there rather than shipping.
- **CHANGELOG `[Unreleased]` → `## [0.5.0] — 2026-08-20`**, plus a fresh
  empty `[Unreleased]` and the compare links. The section was **consolidated
  on the way**: it had accumulated **four separate `### Added` blocks** with
  `### Changed` and `### Fixed` interleaved between them, because four
  features each appended their own. Now one Added, one Changed, one Fixed, in
  Keep a Changelog's order. No wording changed — only which heading the
  entries sit under.
- **README's Status section**, which is the file's one version-bearing claim:
  v0.4 → v0.5, 1162 → 1421 tests, and a paragraph naming what 0.5.0 actually
  is — git, changing the keys, `.nox/settings.json`, a fast explorer, self
  update — with "not there yet" corrected to plugins **and blame**.
- **ROADMAP's release annotations.** That file's whole premise is that
  milestones and releases have never lined up and each shipped row says which
  release carried it. v0.5's table, v0.6's two 1.0-gate rows and v0.2's
  explorer row now say 0.5.0.

Verified:

- `npm test` 1421/1421, `npm run check` 473 files 0 errors, `npm run build`
  green — on the bumped tree, not the pre-bump one.
- The gate's own arithmetic, run by hand before pushing anything: all three
  version files read `0.5.0`, and `v0.5.0` minus its `v` matches.

Next:

- Watch the release run. Per `nox-windows-test-builds`: `releaseDraft: true`,
  so it lands as a **draft**, and **assets upload per job** — the Windows
  `.exe` appears while other platforms are still building, so poll for the
  asset rather than the run. ~8 minutes historically, and the Linux job has
  hung once on apt for 30 (transient; `fail-fast: false` means the others
  still upload).
- Then the 1.0 keyboard pass on the Mac, and the certificates.

Blocked:

- Nothing. The draft release is Francesco's to publish — that is a
  publication, not a build.

Confidence:

- High that the gate passes: its check is four string comparisons and I ran
  them.
- The binaries themselves are unverified by construction — this PC cannot
  build them, which is the whole reason the tag exists.

## 2026-08-20 (PC, 1.0 bar) — The browser pass over all three

Not a feature. The three commits below each closed with "not verified on a
screen", and `npm run dev` runs the browser target on this PC — so the claim
was cheaper to close than to keep writing down. Chromium via the preview
tools, driven through `window.nox` and real `KeyboardEvent`s at the window,
which is the same door `KeymapService.attach` listens on.

What is now verified in a real engine, not jsdom:

- **The keybinding editor, end to end.** ⌃⌥K opened it: **151 application
  rows, 92 of them Unassigned, 18 read-only Editor rows with zero edit
  buttons**. Recorded F9 onto *Toggle Explorer*, accepted — the row redrew as
  F9, the customised dot and both resets appeared. Then, with the overlay
  closed: **F9 toggled the explorer and Ctrl+B did nothing**, which is the
  only assertion that actually matters. `localStorage` held exactly the two
  rules the design says it should — one `remove`, one addition. `resetAll()`
  emptied the file and Ctrl+B came back.
- **`inert` reflects to an attribute** (`inertReflects: true`,
  `'inert' in HTMLElement.prototype`). That was the one claim the workspace-
  settings entry called *reasoned rather than exercised*, because jsdom does
  not implement `inert` at all. It is now exercised.
- **The row-height contract holds in the real engine**: the tree's
  `--nox-tree-row-h` computes to `23px` and a row's painted height is `23px`.
  That is the whole point of moving the number into TS, and it had never been
  checked against an actual layout.
- **Windowing, on 609 nodes** (600 files written into the demo workspace
  through `platform.writeTextFile`): **42 rows rendered**, spacers of
  2116px + 10925px, and `42 × 23 + 13041 = 14007 = 609 × 23` **exactly**. At
  `scrollTop = 6900` the first rendered row was index **292** — `floor(6900/23)
  − OVERSCAN` — carrying `aria-posinset="293"` and `aria-setsize="609"`. The
  keyboard path put a lead 200 rows above the window back on screen and
  rendered it.
- Zero console errors across the whole session.

**One trap worth naming, because it looks exactly like a bug.** Setting
`tree.scrollTop` programmatically did *not* update the window at first, and a
scroll listener installed for the test counted **zero** events. The cause is
the harness, not the app: the Browser pane was not displayed, so the page
composites no frames, and **scroll events are frame-driven**. Dispatching one
by hand produced the exactly-correct window above. This is the same class of
artifact as the desktop pass's BUG-1 (an invisible harness window eating
clicks) — if a future pass sees a "dead" scroll handler, display the pane
before filing anything.

Still unverified, and now the honest remainder: everything a keyboard and a
pair of eyes decide rather than a DOM query — whether overscan 8 avoids a
flash on a fast flick, whether "Rebind, and unassign" fits beside a long
command name, and every Tauri-only surface (the terminal, the dialogs, the
title bar, the git panel against a real repo).

Verified: the numbers above, plus `npm test` 1421/1421, `npm run check` 473
files 0 errors, `npm run build` green at the tree these three commits stand on.

Next: unchanged — the real-keyboard desktop pass on a Mac, then the tag.

Confidence: high, and higher than it was three entries ago on exactly the
things a browser can settle.

## 2026-08-20 (PC, 1.0 bar) — Explorer virtualisation

Branch `keybinding-editor`, third commit. The last **code** row of the 1.0
bar; what remains of 1.0 after this is a real-keyboard pass and two
certificates. Spec:
`docs/superpowers/specs/2026-08-20-explorer-virtualisation-design.md`.

Shipped:

- **The panel renders a window; the model never noticed.** `FlatNode`,
  `#flatten`, `FileTreeService` and every service test are untouched —
  the flat list has said since v0.1 that it exists to make this possible,
  and this is the whole of collecting on it. The rendered slice sits
  between two `role="presentation"` spacers, so the scrollbar still
  describes the whole tree and every row keeps its true offset.
- **Spacers rather than a transform**, deliberately: the container is also
  the drop target and the keyboard surface, and a transformed child changes
  what `contains()` and `getBoundingClientRect()` mean for both.
- **The row height has one home.** It was `height: 23px` in the stylesheet;
  it is now a TS constant the CSS reads through `--nox-tree-row-h`.
  Windowing by index fails silently if the painted height and the
  arithmetic disagree, so they cannot be two numbers.
- **What cannot be measured is not windowed.** Viewport height 0 — before
  layout, and jsdom, which has no layout at all — renders every row.
  Windowing an unmeasured viewport renders *nothing*, which is a much worse
  failure than rendering too much; it also keeps every other jsdom suite
  seeing the tree it always saw.
- **`scrollIntoView` is gone, and its replacement is strictly better.**
  `scrollSelectionIntoView` used to query `.row.lead` and call
  `scrollIntoView` on it — impossible once the lead can be outside the
  window, which is exactly when it matters. It is now arithmetic on the
  lead's index: no row required in the DOM, and no `scrollIntoView`, which
  jsdom does not implement and which the old line had to guard with `?.`
  for that reason.
- **`aria-setsize` / `aria-posinset` arrived with the change, not after.**
  Rows leaving the DOM makes them mandatory: without them a screen reader
  would be told the tree is exactly as long as the window.
- Shift+F10's menu still measures a real row, because a menu needs real
  coordinates — it reveals the lead, `await tick()`, then measures, and
  keeps its old fixed fallback.

Verified:

- `npm test` — **1421 passed, 88 files** (1412/87 at the previous commit;
  +9). `npm run check` — 473 files, 0 errors. `npm run build` — green.
- **Eight mutation checks, all red after one round of re-aiming.** Two
  survived the first pass and both were *test* faults rather than code
  faults, which is the useful part:
  1. Killing `revealLead`'s scroll-**up** branch survived, because the only
     keyboard test at the time arrowed **down**. The suite had one
     direction; the code had two. Added "arrowing above the top edge
     scrolls back up", and both branches now have a killer.
  2. Slicing from `0` instead of `firstIndex` survived against the
     initial-render test, because at scroll offset 0 those are the same
     expression. Re-aimed at the scrolled test, where it dies.
- At the time of this commit: jsdom over a stubbed `clientHeight` only.
  Closed the same day against Chromium and 609 real nodes — see the
  browser-pass entry above. What a browser still cannot settle from a DOM
  query: whether overscan 8 avoids a flash of blank rows on a fast flick.

Next:

- **The 1.0 keyboard pass**, on a real machine — the bar's own last row
  ("nothing in the release notes says unverified"). It now covers a full
  cycle's worth of surfaces: UI phases A-C, the git panel and branch picker,
  the keybinding editor's recording flow, a project's `.nox/settings.json`,
  and a large folder in the explorer.
- Then the 1.0 tag, once the certificates are a decision.

Blocked:

- Not pushed, no PR — the standing rule. Three commits sit on
  `keybinding-editor`.
- Code signing is a purchase; the desktop pass wants a Mac. Neither is this
  machine's to close.

Confidence:

- High on the arithmetic: eight mutations, and the two survivors were caught
  and converted rather than explained away.
- Medium on the feel. Overscan, scroll smoothness and the drag-over
  behaviour near a window edge have been reasoned about and not seen.

## 2026-08-20 (PC, v0.6) — Workspace settings

Branch `keybinding-editor`, second commit. Chosen because the 1.0 bar's own
order puts it next, and because it was the last remaining 1.0 gate that is
pure code — explorer virtualisation aside, what is left is a Mac and two
certificates. Spec first:
`docs/superpowers/specs/2026-08-20-workspace-settings-design.md`.

Shipped:

- **`ConfigService` is three layers**, lowest first: the schema's defaults,
  the user's `settings.json`, the project's `.nox/settings.json`. Every
  write still lands in the *user* layer — that never changed — but `set()`
  now compares against the user layer rather than the effective value, or a
  write to a shadowed key would vanish the moment the folder closed.
  `serialize()` writes the user layer only, so a project's conventions can
  never bleed into a reader's own file.
- **The scope is an allowlist on the schema** (`workspace: true`), eight
  keys wide: tab size, insert spaces, auto indent, word wrap, trim trailing
  whitespace, insert final newline, format on save, exclude from explorer.
  The reasoning is in §0 and is the reason the feature is shaped this way at
  all — a workspace file arrives with a **cloned repository**. `terminal.shell`
  is the name that makes it concrete: a repository able to set it would run
  a binary of its author's choosing the first time you opened a terminal. A
  denylist would be wrong by default the day someone adds a setting.
  There is a test that names those keys and fails if the list grows to
  include one.
- **`loadWorkspace(root)`**, wired to `rootPath.subscribe` and to a new
  `FileWatcherService.onPathsChanged` hook, so an edit to the file — in Nox
  or in another program — applies with nothing to press. The hook fires
  *before* `#flush`'s "no open buffers" early return, because that return is
  about reconciling buffers and this listener is not one. A null root clears
  the layer: closing a folder must not leave its indentation behind.
- **The panel is read-only over that layer, on purpose.** VS Code's
  User/Workspace tab pair is a second write path and a way to commit a
  personal preference into a shared repository by accident. Instead an
  overridden row wears a **Workspace** badge, its control is `inert`, its
  reset is hidden, the header counts what the project set, and the footer
  offers **Workspace settings** → the new `prefs.openWorkspaceSettings`
  command, which creates `{}` and opens the file as an ordinary tab.
  `update()` also refuses the write itself — `inert` is a browser feature and
  the guard that matters must not be one.

Verified:

- `npm test` — **1412 passed, 87 files** (1383/85 at the previous commit;
  +20 `workspace-settings`, +9 `settings-panel-workspace`). `npm run check`
  — 472 files, 0 errors. `npm run build` — green.
- **Ten mutation checks, all confirmed red then reverted** — including two
  that had to be *rewritten because the first version survived*, which is
  the part worth keeping:
  1. **A surviving mutation found a real design defect.** The panel first
     derived its badge set through `$settings`; deleting that read left the
     test green. The reason is that `#recompute` deliberately stays quiet
     when nothing *moved*, and a project that sets a key to the value the
     reader already had changes **ownership without changing any value** —
     a row could become project-owned with nothing on screen noticing. Fixed
     with a dedicated `config.workspaceScope` signal, and a new test covers
     exactly that case.
  2. The second survivor was a test defect: `new Event('change')` does not
     bubble, and Svelte 5 delegates `change` at the container, so the
     handler never ran and the guard looked stronger than it was. Fixed with
     `{ bubbles: true }`, and the mutation then went red.
- jsdom does not implement `inert`, so Svelte sets it as an IDL property that
  never reflects to an attribute — the test asserts the property and says why.
  A real browser reflects it.

Next:

- **Explorer virtualisation** — the last pure-code 1.0 gate, and the 1.0
  bar's own words: "the only trust-row item whose absence a larger project
  would feel every day".
- Then the real-keyboard desktop pass, then the tag.

Blocked:

- Not pushed, no PR — the standing rule.
- Code signing (a purchase) and the desktop pass (a Mac) are the two 1.0
  gates this machine cannot close.

Confidence:

- High on the layering and the scope boundary: ten mutations, and the scope
  list has a test that names the keys that must stay out of it.
- Medium on the panel at the time of writing; the `inert` half was closed
  the same day in Chromium (see the browser-pass entry above), the badge
  and footer still want eyes.
- One thing deliberately not built: `.nox/keybindings.json`. The rule format
  is already layerable, but a repository supplying keystrokes is its own
  trust question and wants its own §0.

## 2026-08-20 (PC, v0.6) — The keybinding editor

Branch `keybinding-editor`, off `main` at `8453ab5` (pulled this session:
main had moved four commits past `ca44580` with the auto-updater and the
BUG-1 postmortem). Chosen by the 1.0 bar's own order — *find references →
rename → format on save → git → stage/commit → **keybinding editor** →
workspace settings → explorer virtualisation → keyboard pass → tag* — and
because it was the only remaining 1.0 gate that was pure code rather than
a purchase or a ritual. Spec first:
`docs/superpowers/specs/2026-08-20-keybinding-editor-design.md`.

Shipped:

- **The keymap grew a second tier.** `bind()` now builds a recorded
  **default table**; a `KeybindingRule` from `keybindings.json` is applied
  *over* it and never edits it — which is exactly what makes reset a
  deletion rather than a remembered original. `#rebuild()` replays the
  defaults minus each `(chord, command)` pair a `remove` rule names, then
  applies additions; additions land last and `#add` unshifts, so a user
  binding beats a default on the same chord with no new precedence
  machinery. One version bump per rebuild, not one per replayed default.
- **`when` and `arg` are inherited, not serialised.** A predicate cannot be
  written to JSON, so an addition takes the guard from the command's own
  default: rebinding Escape keeps `hasDismissible()`, and a rebound
  `nav.goToTab` keeps its index. Stated in the spec and tested rather than
  left to be discovered.
- **Recording is a mode of the service** (`beginCapture`/`endCapture`), not
  a listener in the panel. It has to be: `attach` resolves on the window's
  **capture** phase, so a claimed chord is already `preventDefault`ed and
  executed before any element inside the panel could see it. While
  capturing, every key is swallowed and handed to the recorder — bare
  modifiers ignored, so reaching for ⇧ first records nothing.
- **`handleKey(event)` split out of `attach`**, so both the tests and the
  capture branch have one door instead of two.
- **The panel is an editor.** Every command gets a row — bound *or not*,
  reading "Unassigned", because adding a key to a command that has none is
  half of what "change the keys" means and the old list could not express
  it. Per row: change, clear, and a reset that appears only where something
  differs. Header: a customised count and **Reset all**, both absent when
  nothing is. A conflicting chord **names the command it would displace**
  and the accept button says *Rebind, and unassign* — accepting takes the
  key away rather than shadowing it, because an addition would win anyway
  and a key whose listed owner is not the one that runs is the confusion
  this panel exists to remove. Re-recording a row's existing chord is a
  no-op, not a customisation. The **Editor** section stays read-only and
  now says why on screen.
- **`keybindings.json`** beside `settings.json`, through the existing
  `readConfigFile`/`writeConfigFile` — no new `Platform` method. Corrupt or
  unreadable leaves the defaults standing (`ConfigService.load`'s rule); a
  non-rule entry is dropped and the rules around it kept. Loaded in
  `#boot()` next to `config.load()`, which is safe because the constructor
  has already run `#registerKeybindings`.

Verified:

- `npm test` — **1383 passed, 85 files** (1346/83 at the branch point;
  +24 `keymap-user-bindings`, +13 `keybindings-panel`). `npm run check` —
  470 files, 0 errors. `npm run build` — green.
- **Eight mutation checks, all confirmed red then reverted**: the
  removed-pair skip deleted from `#rebuild`; `#add` pushing instead of
  unshifting; the inherited-`arg` lookup forced to `undefined`; the capture
  branch falling through to `resolve()`; `accept()`'s unassign-conflicts
  loop deleted; the rows derivation not reading `$keymapVersion`;
  `stopRecording()` not calling `endCapture`; the unbound-command rows
  dropped from the derivation.
- One real defect found and fixed on the way: a **literal NUL byte** had
  been written into `keymap.ts` as the pair-key separator, which made
  `grep` treat the file as binary. Replaced with a `\u0000` escape (same
  value, visible in source) and commented.
- `npm install` was needed before `npm run check` would pass at all: main's
  auto-updater merge added `@tauri-apps/plugin-process` and
  `plugin-updater` to `package.json`, and this PC's `node_modules`
  predated it. Not a repo defect — but the 3 errors look exactly like one.
- Verified in a real browser afterwards — see the browser-pass entry above.
  At the time of this commit it was jsdom only.

Next:

- **Workspace settings** (`.nox/settings.json` layered over user settings) —
  the last pure-code 1.0 gate after this one, and the keybinding rule file
  is already shaped to layer when it arrives.
- Then explorer virtualisation, then the keyboard pass, then the tag.

Blocked:

- Not pushed, no PR — the standing rule. Code signing and the desktop pass
  remain the two 1.0 gates this machine cannot close (a purchase and a
  Mac).

Confidence:

- High on the service: eight mutations, and `resolve()` — not "the map
  contains a binding" — is the assertion of record throughout.
- Medium on the panel's *feel*. The behaviour is tested; the hover
  affordances, the recording well's width and whether "Rebind, and
  unassign" fits beside a long command name have been seen by nothing with
  eyes.
- One edge accepted and documented: a bare `Escape` cannot be recorded from
  the UI (it is the cancel key), only hand-written into the file.

## 2026-08-20 (PC, v0.5) — Stage, commit, branch

Branch `git-stage-commit`, off `main` at `ca44580`, ten tasks per
`docs/superpowers/specs/2026-08-19-git-stage-commit-design.md`. No
subagents this session — every task built and verified directly. This
entry is the doc pass (task 10) and the only WORKLOG entry the branch
gets; tasks 1-9 shipped without one.

Shipped:

- **The panel.** A **Git** view in the sidebar (`GitPanel.svelte`): a
  branch line, staged and unstaged file lists each with a stage/unstage
  button (+/−), a commit message box, **Commit**. Reads only
  `GitService.status` — nothing in the view asks git directly. **Show Git**
  in the palette and a rail icon open it.
- **The read.** `core/git-status.ts` parses `git status --porcelain=v2
  --branch -z` (NUL-terminated, so a rename's original path is the next
  token, not a delimiter inside this one); porcelain's `C` (copied) maps
  to `R`, an unmerged `u` record lands in unstaged as `M` rather than
  vanishing.
- **The six writes and reads** in `git.rs`, all argv-fixed, `-C <root>`,
  `--literal-pathspecs`, no shell: `status`, `branches`, `stage`,
  `unstage`, `commit`, `switch`. A refusal is git's own stderr (or stdout,
  where git prints "nothing to commit" there) verbatim, `io:`-prefixed,
  never translated.
- **Unstage is `git reset -- <pathspec>`, not `restore --staged`** — the
  deviation from the spec's first instinct, kept because it is provably
  the safer choice rather than merely the one that shipped. Verified
  live against a real repo: `restore --staged` fails on an unborn branch
  (right after `git init`, no commits yet) with "could not resolve HEAD";
  pathspec-limited `reset` does not, and it costs nothing against the
  envelope's "no discard" promise despite `reset`'s reputation elsewhere —
  limited to a pathspec it takes no `--hard`/`--soft` and is index-only by
  construction, never touching HEAD or the working tree.
- **The commit message travels over stdin** (`--file=-`), never argv.
  **Branch names are validated with `git check-ref-format` before any
  write** reaches them, and switching over a file the target would
  overwrite is refused rather than forced.
- **`GitService`**: a coalesced `refreshStatus` (one call in flight, any
  number arriving meanwhile collapse to one queued follow-up, not N), and
  a **branch picker with no prefix of its own** in the command palette —
  `mode === 'git-branch'` locks `effectiveMode`, so `>` or `~` typed while
  filtering branch names cannot switch the picker into another mode.
  **Create branch…** is pinned first.
- **`.git`'s `HEAD` and index are now watched directly** — a second,
  targeted, non-recursive watch on `<root>/.git`, filtered to `HEAD`,
  `index` and their `.lock` shadows, debounced. This closes the blind
  spot the gutter's own docs have named since it shipped: a stage,
  unstage, commit or switch made in a terminal now reaches both the panel
  and the gutter unasked. The recursive workspace watch keeps its
  `.git` DENY unchanged — this is a second watcher, not a hole in the
  first one's filter.
- `platform/memory.ts` grew a small honest fake repository — stage copies
  working text into the index, commit snapshots it and refuses on a clean
  index or a blank message, switch refuses over a dirty conflict — rather
  than scripted replies, so the TS service tests exercise real sequences.
  Refusal wording mirrors git's own and is cross-checked against the Rust
  tests, which run the phrases against real git.
- Mutation checks recorded in the relevant docblocks, as the previous two
  rows did: `core/git-status.ts` (a rename's original path read without
  advancing past it), `services/git.ts` (the queued-refresh flag
  disabled), `platform/memory.ts` (the switch-refusal guard disabled) —
  each turned its test red during this task's verification, then
  reverted.
- CHANGELOG `[Unreleased]`, ROADMAP's v0.5 row, this ARCHITECTURE.md
  entry (module map: `core/git-status.ts`, `git.rs`, the grown
  `watcher.rs`; the envelope's headline — six fixed commands, no generic
  git seam, refusals verbatim — stated once so a future reader does not
  quietly build a seventh).

Deferred, stated rather than dropped silently:

- **Hunk-level staging.** Phase 2, its own PR and its own envelope read —
  it is the one place this feature would construct input for git
  (`apply --cached`) rather than name files, which is a materially
  different trust boundary than the six commands here.
- **The status-bar branch indicator.** Phase C (2026-08-19) named this as
  waiting on the stage/commit row's status read; that read exists now
  (`GitService.status`), so the indicator is a five-line follow-up, not a
  redesign — a signal subscription and a status-bar item, the same shape
  the problems indicator already uses. Not built here because the spec
  names only the panel's branch line, and this task stayed inside it.

Verified:

- `npm test` — 1306 passed, 79 files, on the run this commit stands on
  (was 1257/76 at the start of this branch). `npm run check` — 460 files,
  0 errors. `folding.test.ts` flaked twice across five full-suite runs
  this session (1305/1306, one file failing on `foldLinesAtLevel`'s
  budget-dependent assertion) and passed on the other three — the same
  CPU-load sensitivity CHANGELOG's 0.2.0 entry names, not a regression:
  neither `folding.ts` nor its test has changed since that release. Run
  in isolation twice (`npx vitest run tests/folding.test.ts`), it was
  10/10 green both times — the flake needs the full suite's load to show
  at all.
- `cargo test`, run locally in `src-tauri/` (not just declared unrun) —
  **61 passed**, 0 failed, across the lib suite plus the two integration
  files. CI's three-platform run is still the authority this claims
  none of: this PC is one platform, and the `#[cfg(windows)]` paths in
  `git.rs` and `watcher.rs` are unexercised here by construction.
- Three mutation checks this task, each confirmed red then reverted (see
  Shipped above for exactly which line and which test).
- **Not verified: the panel on a screen.** Every git surface in this
  branch — the panel, the branch picker, the commit flow, the `.git`
  watch actually reaching a live app — has been seen in jsdom
  (`tests/git-panel.test.ts`) and nowhere else. The desktop pass this
  cycle keeps growing (Phases A-C, the gutter, the diff view, now this)
  and still has not happened.

Next:

- **The desktop pass.** Everything UI-phase-C through this row, on a real
  keyboard: the tab menu, EOL switch, the four primitives' look, the git
  panel, the branch picker, a real stage/commit/switch cycle against a
  real repo.
- The status-bar branch indicator, now a small follow-up rather
  than blocked on anything.
- Blame — the last unchecked v0.5 row.

Blocked:

- Nothing technical. Not pushed, no PR, no subagents — by instruction.

Confidence:

- High on the TS and Rust layers: mutation-checked (this task's three
  plus the ones tasks 1-9 recorded in their own docblocks), and `reset`
  vs `restore --staged` was settled by running both against a real repo
  rather than by reading git's docs.
- Medium-low on the panel's look and the branch picker's ergonomics —
  unseen outside jsdom, same gap as every LSP and UI surface before it.

## 2026-08-20 (PC, updater) — The auto-updater, seven tasks in

Branch `auto-updater`, worktree `nox-worktrees/auto-updater`. Built the
free half of the 1.0 "Installs like software" row end to end: platform
boundary, service, app wiring, Settings footer, plugin registration, a
conditional-signing release workflow, and this write-up.

Shipped:

- `platform/types.ts` — `UpdateInfo`, `UpdateProgress`, `checkForUpdate`,
  `installUpdate` on `Platform`. Web and memory targets report updates
  unavailable; only `tauri.ts` talks to the plugin.
- `services/updates.ts` — `UpdateService`: a signal the UI reads, a
  10-second post-launch check gated on `workbench.checkForUpdates`, a
  manual `checkNow`, and `installUpdate` flushing dirty buffers before it
  restarts.
- App wiring and the *Check for Updates…* command; a toast with an
  Install and Restart action.
- The Settings footer now shows the running version.
- `src-tauri` — the updater and process plugins registered, capabilities
  granted, `updater.conf.json` set for `createUpdaterArtifacts` (the
  public key itself lives in `tauri.conf.json`'s `bundle.updater.pubkey`,
  not there) and no private key committed anywhere.
  `cargo check` run locally: clean, exit 0. (The plan's Global
  Constraints section says no cargo was on this machine — that was
  stale by the time Task 5 landed; what's still CI-only is the
  three-platform build and the workflow itself, not the type-check.)
- `.github/workflows/release.yml` — builds and uploads installers on
  every tag; signs and attaches `latest.json` only when
  `TAURI_SIGNING_PRIVATE_KEY` is present as a secret, so a repo without
  the key still ships unsigned installers instead of failing the build.
- `ROADMAP.md`, `ARCHITECTURE.md`, `CHANGELOG.md` updated for all of the
  above.

Verified:

- `npm run check` — 463 files, 0 errors.
- `npm test` — 1280 passed, 80 files, one clean run (no `folding.test.ts`
  flake this time).
- Not verified here: the Rust actually compiling on CI, and the release
  workflow itself — neither has run once, on any commit, on any
  platform. The first tag is the first time either executes.

Next:

- The operator's key ceremony (spec §8): `tauri signer generate`, the
  two secrets in GitHub Actions. Human-only, out of scope for any task.
- The first signed tag. One open risk left to watch on that run, not
  executed anywhere yet: `tauri-action`'s cross-matrix `latest.json`
  assembly — each matrix leg's platform entry merging into one
  `latest.json` on the release, asserted from the action's
  `uploadUpdaterJson` docs but never run. The first signed tag is the
  real test of it.
- **Closed** since this entry was first written: the empty updater
  pubkey at plugin init. Task 5 flagged it and feared it might throw
  before the app boots rather than degrade to "no update available" —
  and named the fix as a guard in `tauri.ts`'s plugin registration,
  which was wrong twice over: registration happens in `lib.rs`, not
  `tauri.ts`, and no guard turns out to be needed. Verified against the
  `tauri-plugin-updater` 2.10.1 source: `Builder::build()`'s setup hook
  only clones the pubkey string into the plugin's managed config —
  no parsing, no early exit either way. It is first decoded in
  `verify_signature`, called from `Update::download`, i.e. the download
  half of `downloadAndInstall`, not `check()`. So an empty pubkey lets
  `check()` report an update same as always; `PublicKey::decode` on the
  empty string then fails there, `?`-propagated as `Error::Minisign` —
  never a panic — which `installUpdate()` normalizes into the same
  `PlatformError` any other install failure produces. Fails closed,
  never an unverified install.

Blocked:

- Nothing technical. The private key was never generated, printed, or
  committed by any step here — §8 stays a human runbook. Nothing
  pushed, no PR opened, by instruction.

Confidence:

- High on the TypeScript and Svelte surface: tested, type-checked, and
  the platform boundary keeps every non-desktop target untouched.
- Unverified on purpose on the Rust and CI surface — that's what CI is
  for, and no task here claims otherwise.

---

## 2026-08-19 (PC, UI 3) — Phase C: the conventions

Branch `ui-phase-c`. Three-way split: tabs agent (context menu, overflow,
name disambiguation), palette agent (MRU, keyword chips, true counts), me
(status bar, EOL model, toast actions, rail).

Shipped:

- **Tabs**: house ContextMenu on every tab (7 items, keybinding hints,
  Shift+F10); Close Others / to the Right / Saved as `file.*` commands —
  the agent refused to copy `workspace.closeOthers`' silent dirty-discard
  and routed sweeps through `closeBuffer` prompts, stop-on-cancel; edge
  fades + 4px hover scrollbar (Firefox keeps fades only — can't render
  4px; Tauri's webviews both can); `core/tab-labels.ts` walk-up
  disambiguation ("index.ts — ui" vs "index.ts — core").
- **Palette**: session-scoped 8-deep command MRU floated at empty query
  (disabled ones not floated); non-empty query stays pure fuzzy — decided
  and documented, predictability over blending; keyword-won matches show
  the matched keyword as a chip instead of looking like mis-hits; counts
  say "first M of N" when capped instead of lying.
- **Status bar**: ⊗n ⚠n problems indicator (only when nonzero) opening
  Problems; **EOL is a real switch** backed by `workspace.setEol` and a
  `savedEol` on the buffer — isDirty now honestly includes "what a save
  writes changed", save records it, reload resets it; inert items
  (encoding/language) visibly fainter than clickable ones.
- **Toasts**: `actions` on notifications (run = dismiss); first adoption:
  the watcher's "changed on disk" warning offers **Reload from Disk**.
- **Rail**: error-count badge on Problems; re-click active view collapses
  the sidebar; References gets its own dotted-list glyph, ending the
  double-`search` confusion.

Deferred, stated: status-bar **git branch** (arrives with the stage/
commit row's status read — no branch plumbing exists yet and building a
throwaway read now would duplicate `nox_git_status`); encoding/language
pickers (need a quick-pick surface + service-level conversion — Phase D
material); rail collapse-survival (layout redesign; wants pixels first);
notification center.

Verified: 1257/1257 (76 files; +5 mine, +9 tab-labels, +4 palette/
commands), svelte-check 455 files 0/0, build green. Live: the 7-item tab
menu with hints, EOL flip grows the tab's dirty dot (the honest-dirty
model visible end to end), zero console errors. Mutations: 4 mine + 3
agents', all red, all recorded. One agent self-reported wiping its own
uncommitted work with a careless `git checkout --` mid-mutation and
redoing it — worth knowing the failure mode exists.

Next: the desktop pass (A+B+C all changed pixels), then Francesco picks:
Phase D oddments or v0.5 stage/commit.

Confidence: high on behavior; look still wants eyes.

---

## 2026-08-19 (PC, UI 2) — Phase B: the primitives

Branch `ui-phase-b`. The extraction phase of the audit: two adoption
agents (inputs; buttons + takeover panels) over disjoint files while I
built the primitives, converted the sidebar panels and swept tokens.

Shipped:

- `base.css`: **`.nox-button`** (default/small/ghost/primary/danger/on)
  and **`.nox-input`** (+`.mono`, `aria-invalid` styling, `--nox-input-h`).
  Primary text now uses `--nox-text-on-accent` (two panels had spelled it
  `--nox-bg-base`). `.ghost` is a real variant at last.
- **`PanelHeader.svelte`** (real `h2` landmark, DESIGN §4 type, summary +
  actions slots, `--nox-panelbar-h`) and **`PanelEmpty.svelte`** (one tone,
  optional one-click action) — adopted in Problems, References, Notes,
  Answers; Search's no-folder state gained an **Open Folder** button,
  Problems' empty gained **Configure Language Servers**, Notes' gained
  **New Note**.
- Adoption by agents: Find/Settings/Keybindings/Prompt on `.nox-input`
  (five wells at four heights → one, ~70 lines of local CSS deleted);
  DiffView/Review/Agent/Terminal on `.nox-button` (~137 lines deleted;
  DiffView's toggle binding `active`→`on`).
- Token sweep: dead tokens deleted (sidebar ×3, z-editor, shadow-sm);
  `--nox-border-subtle` documented; `--nox-scrollbar-hover` replaces the
  two raw hexes in base.css; `--nox-panelbar-h`/`--nox-railbar-h` name the
  two previously hardcoded chrome heights; **`--nox-dur-pulse`/`-spin`**
  route the app's two infinite animations through the reduced-motion
  block; Welcome's raw violet → `color-mix` on the token; tokens.css's
  motion comment now agrees with DESIGN.md (190 ms); Icon doc says the
  1.4 px the code always defaulted to and TabBar's lone 1.6 override is
  gone; DESIGN.md's crescent count is now honest (three, and why).
- Problems/References/Terminal layout px → tokens; the two result panels
  use `.nox-scroll` like their siblings.

Deliberately NOT done, stated: chrome-height *values* stay 36/35/28/24 —
now all tokenized, but collapsing them to a rhythm changes pixels nobody
has eyeballed on a desktop yet; `code { 0.92em }` stays (relative inline
code is legitimate; the audit's "11.96px" was its computed value);
`--nox-lh-tight` left in tokens though unused (harmless, may earn use).

Verified: `npm test` 1233/1233 → +2 primitives tests = 72 files green
after fixing the one seam my own conversion broke (answers test queried
`.empty`; the agent proved the breakage was mine by stash-bisect before I
saw it). svelte-check 450 files 0/0. Build green. Live: PanelHeader h2 at
10px uppercase, empty-action button rendered and styled, `.nox-input` at
28px token border, rail on the token, zero console errors. Mutations:
span-for-h2 and dropped action button, both red.

Next: Phase C (status-bar problems/branch/pickers, tab context menu +
overflow, rail badges + collapse-survival, palette MRU, toast actions) on
Francesco's go — or v0.5 stage/commit. The desktop pass keeps growing in
value: A+B changed real pixels.

Confidence: high on structure (tests+checks), medium on look until seen.

---

## 2026-08-19 (PC, UI) — Audit, then Phase A

Two pieces. First, a **full UI audit** (three parallel source auditors +
live computed-style measurement), published as an artifact for Francesco:
verdict "strong foundation, drifting consistency", ~40 findings, a 4-phase
plan. The audit's method paid off: it found four genuine rendering bugs,
two of them in code this very session had shipped (DiffView referenced
`--nox-border-subtle`, which never existed, and styled none of its
buttons).

Then **Phase A on branch `ui-phase-a`** — the bug fixes:

- `--nox-border-subtle` defined for real (both themes); `--nox-bg-hover`
  call sites renamed to the real `--nox-hover`. Seven silently-dropped
  rules now render — ReviewPanel's hunk borders had never been seen.
- DiffView's header buttons styled (ReviewPanel's shape, knowingly
  duplicated until Phase B's `.nox-button` extraction).
- Problems/References joined the focus model: `FocusZone` members, focus
  request signals, `showView` routing, panel `$effect`s, `⌘⇧M` for
  Problems (References rides Shift+F12, which already opens it). Plus
  hover states, `--nox-selected` instead of the editor-selection token,
  guarded `scrollIntoView`, path truncation, and `title` on rows.
- TabBar: dirty dot survives tab hover (swaps only on the close button
  itself — and the old rules could draw dot and ✕ on top of each other on
  active dirty tabs); the end-of-strip drop indicator exists.
- ConfirmDialog focuses the first safe choice when any choice is danger.
- Notifications: sticky (error) toasts can no longer be evicted by a
  burst of transients; transients still cap at 4; toast messages wrap.
- Swept four pre-existing unguarded `scrollIntoView` calls (jsdom throws).

Verified: `npm test` 1233/1233 (72 files, +9+2 in-suite), `npm run check`
448 files 0 errors, build green, browser boots clean, `--nox-border-subtle`
resolves live. Mutations: slice(-4) revert, unconditional focus, drop-end
binding removal, focus-effect removal — all red. One claim was withdrawn
honestly: the evicted-timer cleanup is unobservable (dismiss self-heals),
so it is documented as hygiene and no test pretends otherwise.

Next: Phase B (the four primitives + token sweep) when Francesco says go —
or back to v0.5 stage/commit; his call which thread runs first.

Confidence: high on behavior (mutation-checked); the visual half of these
fixes still wants the desktop pass like everything else this cycle.

---

## 2026-08-19 (PC, spec) — Stage/commit/branch, specified

On branch `git-stage-spec`, off `main` at `fa2caaf`. Spec only, no code:
`docs/superpowers/specs/2026-08-19-git-stage-commit-design.md`. It is the
first write-path git work, so the spec leads with the envelope — the six
things the feature will never do — and that section (§0) is the part
worth Francesco's read before step 1 of the build order starts. Merged as
a spec so the MacBook session can read it in-repo; building has not
begun, and the ROADMAP row stays unchecked.

The decisions someone might re-litigate, and why they went this way:

- **No discard, no stash** — the README's first promise is "It does not
  lose your work. Ever.", and `checkout -- file` is the canonical way to
  lose it. Discard waits for a recovery story, as its own decision.
- **Unstage is `restore --staged`, not `reset`** — the working tree is
  untouchable by construction of the command chosen.
- **Commit message via stdin** (`--file=-`), never argv.
- **Branch names validated by `git check-ref-format` before any write.**
- **MemoryPlatform grows a small honest repo model**, not scripted
  replies — service tests then exercise sequences, and the refusal texts
  are asserted against real git in the Rust tests so fake and real
  cannot drift silently.
- **`.git` meta-watch lands here** (targeted, non-recursive, HEAD+index
  only), closing the gutter's documented blind spot; the recursive
  workspace watch keeps its DENY.
- **Hunk staging is phase 2**, separate PR and its own envelope read —
  it is the one place the feature would construct input for git
  (`apply --cached`) rather than naming files.

Next:

- Francesco reads §0. Then build order §7, step 1: the porcelain v2
  parser, the status read, the read-only panel.

Blocked:

- Nothing — building can start on the standing authority; the §0 read is
  requested, not required, and the envelope is enforced by the spec
  either way.

Confidence:

- High that the envelope is the right shape; medium on porcelain v2
  parsing edge cases until the fixtures exist.

---

## 2026-08-19 (PC, later) — Diff view

On branch `git-diff-view`, off `main` at `d888bbd`. Design in
`docs/superpowers/specs/2026-08-19-git-diff-view-design.md`. Same split as
the gutter: one Explore agent mapped ReviewPanel/editor-area conventions,
one build agent wrote the pure row model, I built the surface.

Shipped:

- `src/core/diff-view.ts` (agent-built, 17 tests): one paired-row model —
  context / paired change rows / folds with counts — serving both layouts;
  after-side numbers by running offset; folds only when at least 2 lines
  hide; the change-rows-separated invariant the inline regrouping leans on.
- `src/ui/DiffView.svelte` — **Show Changes**: side-by-side and inline
  (regrouped from the same rows, no second differ), layout toggle writing
  `workbench.diffLayout` (new setting), fold click = expand all, honest
  empty states (no file / untitled / asking git / no base / too large /
  no changes). Read-only on purpose.
- `ui.diffOpen`, layered **below** review and agents: staging over an open
  diff shows the review, Escape uncovers the diff. Survives tab switches —
  the deliberate deviation from review/agents, which close on activeId.
- `GitService.baseFor(path)` plus a `baseRevision` signal (a clean file's
  base arrival is otherwise invisible — hunks stay silent when nothing
  changed); the bump is pinned at the service after a survived mutation
  showed the folder-open reset was masking it in the UI test.
- `onGitGutterClick` facet: gutter mousedown opens Show Changes. The first
  draft used pane-level `EditorView.domEventHandlers` and never fired —
  those listen on the content element and gutters are siblings; the jsdom
  suite caught it, plus the pre-existing jsdom `Range.getClientRects` gap
  the gutter's measure path trips (installRangeRects, as lsp-format does).
- `git.showDiff` and `git.refreshGutter` both category **Git**; enabled on
  `git.started` (the service, not the capability — the LSP pattern; the
  capability gate was untestable and wrong for the same reason).

Verified:

- `npm test` 1224/1224, 71 files (+17 core, +10 view, +1 service).
  `npm run check` 447 files 0 errors 0 warnings. Build green. Browser
  build boots with all five gutters registered, no console errors.
- Mutations: core x2 (agent's own), view x5 — two survivors did real
  work: the gutter-click one exposed the sibling-element bug above, and
  the baseRevision one exposed that the UI test was passing because of
  the folder-open reset bump (now isolated at the service and red under
  mutation).
- NOT verified on a screen: everything (jsdom only). The desktop-pass
  checklist now carries the gutter and this view.

Next:

- **Stage, commit, branch** (v0.5 row 3): a focused panel. Wants the
  `.git` watching the gutter deferred, hunk staging with the revert/stage
  confirmation shape, and the first write-path git commands — a real
  capability step, so the spec comes first and should be short-listed for
  a human read before building.

Blocked:

- Nothing technical.

Confidence:

- High on the row model and the surface (mutation-checked); medium on the
  visuals until a human sees them.

---

## 2026-08-19 (PC, v0.5 begins) — Git gutter

On branch `git-gutter`, off `main` at `1000921`. Design in
`docs/superpowers/specs/2026-08-19-git-gutter-design.md`. Built with three
Explore agents mapping the seams in parallel, then two build agents
(`git.rs`, the pure core) alongside my own middle layer — the first
multi-agent feature in this repo, and the split held: no file conflicts.

Shipped:

- `src-tauri/src/git.rs` — `nox_git_file_base(path)`: repo root via
  `rev-parse --show-toplevel`, index content via `--literal-pathspecs show
  :0:<relpath>`, `CREATE_NO_WINDOW` on Windows, **None for everything that
  is not content** (no repo / untracked / no git / binary). The codebase's
  first `Command::output()` capture. Inline tests against a real temp repo
  (staged-vs-working divergence, untracked, no-repo, subdirectory).
  **Reviewed by eye, never compiled here — no cargo on this PC; CI is
  where it first builds.** My review caught one real hazard in the agent's
  draft: the textual repo-root prefix match breaks under macOS's
  `/var → /private/var` symlink and Windows runners' 8.3 short paths;
  fixed by canonicalizing the file and stripping the `\?\` prefix.
- Platform: `capabilities.gitState` (4 literals) + `gitFileBase(path)`;
  MemoryPlatform fakes it as a seedable lookup (`seedGitBase`).
- `src/core/git-gutter.ts` (agent-built, mutation-checked by its builder):
  `gutterLines(hunks)` maps before-space hunks to current-space 1-based
  marks with cumulative offsets; `normalizeGitBase` mirrors `decode`
  (BOM/CRLF), else a CRLF repo marks every line.
- `src/services/git.ts` — per-buffer hunks signal, 300 ms per-buffer
  debounce off `workspace.buffers`, base refetch on open/save/reset/
  external-change/activation (2 s throttle)/`refreshAll`, 2 MB size guard.
- `src/editor/git-gutter.ts` + wiring: StateField (static — survives the
  settings toggle) mapping marks through keystrokes; gutter rendering in a
  `gitGutter` compartment behind **`editor.gitGutter`** (on by default);
  theme bars green/amber + red deletion tick; pane paints keyed off
  `currentId` and after every state swap.
- `git.refreshGutter` — **Refresh Git Gutter**, palette-only.
- CHANGELOG `[Unreleased]`, ROADMAP row ✅.

Verified:

- `npm test` 1196/1196, 69 files (was 1162/66: +20 core, +8 service,
  +6 render). `npm run check` 443 files 0 errors. Build green.
- Mutations seen red: core offset (agent's own), service ×5 (normalize,
  debounce, close-drop, size guard, save-refetch), render ×4 — including
  one that **survived and taught something**: removing the repaint after
  the state swap passed the original swap test because marks persist in
  each buffer's own EditorState; the killer is hunks that change while
  the buffer is in the background (stage in terminal, swap back), and
  that test now exists.
- NOT verified: the Rust module has never compiled (no cargo here) and no
  real repo has been diffed end-to-end — MemoryPlatform seeds stand in.
  CI's three-platform `cargo test` is the compile and the real-git proof;
  the desktop pass sees the pixels.

Done after this entry was first written: PR #45 CI green on the first
compile — all three platforms, real-git tests included — and merged.

Next:

- (was: push and watch CI — no iteration was needed).
  Then the **diff view** (v0.5 row 2): the hunk-review panel and line diff
  already exist; it is git wiring plus a second layout.
- The v0.4.3 desktop pass on the MacBook still stands, now with the gutter
  added to the checklist.

Blocked:

- Nothing technical.

Confidence:

- High on the TS layers (mutation-checked locally). Medium on git.rs until
  CI compiles it — the risk is concentrated in the `#[cfg(windows)]` lines
  and path canonicalization, and the tests there are the ones that would
  catch it.

---

## 2026-08-19 (PC, release) — Cut v0.4.3

On branch `release-0.4.3`, off `main` at `f3de46c`. The section this tags:
find references, the definitions list, rename symbol, Format Document and
Format on Save — the release whose point is that language intelligence is
finished.

Shipped:

- The three version files (`package.json`, `src-tauri/tauri.conf.json`,
  `src-tauri/Cargo.toml`) and both lockfiles at 0.4.3. `Cargo.lock` edited
  by hand — the `nox` entry's version line only — because this PC has no
  Rust toolchain; the gate job cross-checks all three and the Rust CI job
  builds with the lockfile, so a hand edit that lied would fail there.
- CHANGELOG: `[Unreleased]` → `[0.4.3] — 2026-08-19`, compare links.
- README: 1092 → 1162 tests; the status paragraph now says language
  servers *finished* in 0.4.3 and names all seven surfaces.

Verified:

- `npm test` 1162/1162 (66 files), `npm run check` 437 files 0 errors,
  `npm run build` green, versions agree (checked with the gate's own
  commands locally).

Done after the entry above was first written: #44 merged (`87d4d48`),
tag `v0.4.3` pushed, Release run 32312237740 green on all four builders —
**draft release up with all seven installers.**

Next:

- The thing this tag exists for: **the desktop pass** — references list,
  definitions list, rename prompt + review, Shift+Alt+F, format-on-save,
  F12 / Shift+F12 / F2 on a real keyboard — recorded here. The MacBook has
  the toolchain; `git pull`, install the dmg from the draft (or
  `npm run app`), ten minutes. Then publish (human), and Git gutter starts.
- The **v0.4.2 draft** is superseded; delete it rather than publish both
  (Francesco's call).

Blocked:

- Publishing the release is his; the tag build was not, and is done.

Confidence:

- High; the release procedure was re-derived from 8b622d3 and the gate
  re-run locally.

---

## 2026-08-19 (PC, night) — Formatting: on demand and on save

On branch `lsp-format`, stacked on `lsp-rename` (#42). Design in
`docs/superpowers/specs/2026-08-19-lsp-format-design.md`. The LSP half of
the roadmap row; the external-command half is deliberately a separate row
(spec §1) — **scope narrowed on purpose, say so**: a formatter binary wants
a process seam and a per-language table, neither of which belongs inside a
save path.

Shipped:

- `src/core/lsp-text-edit.ts` — `TextEdit`, `textEditsOf`, `changesOf`;
  the reading rename had privately, moved out so rename and formatting
  share one. `lsp-rename.ts` and `#renameSymbol` now use it.
- `NoxApp.formatBuffer(id, { timeoutMs? })` → `formatted | unchanged |
  unavailable | stale | failed | timeout`. `textDocument/formatting` with
  `editor.tabSize` / `editor.insertSpaces`; applied via `workspace.apply`
  with `baseRevisions`, so one undo takes it back and a keystroke during the
  request is refused, not formatted over. The timeout race lives **inside**,
  before the apply, so a late answer is never applied.
- `lsp.formatDocument` — **Format Document**, `Shift+Alt+F`, enabled on
  `documentFormattingProvider`. Reports `failed` and `unavailable`; says
  nothing otherwise.
- `files.formatOnSave` (bool, off) and `#formatBeforeSave` in `save` and
  `saveAs`: skipped when off or under `afterDelay` autosave; 2 s bound;
  timeout/failed → saved anyway with a warning; stale → saved as typed,
  silently. **The save always happens.**
- `tests/support/fake-lsp-process.ts` awaits a handler that returns a
  promise — "answers late / never" is now stageable.
- CHANGELOG `[Unreleased]`, ROADMAP row ✅ (LSP half), README.

Verified:

- `npm test` — 1162 passed, 66 files (was 1144/64). `npm run check` — 437
  files, 0 errors. `npm run build` green.
- `tests/lsp-text-edit.test.ts` (6), `tests/lsp-format.test.ts` (jsdom, 11:
  real pane, real save path, in-memory disk read back). Six mutations seen
  red: options not from config; `#formatBeforeSave` not awaited; setting
  unchecked; autosave unchecked; `baseRevisions` dropped; the race removed.
  **The late-answer test caught the first design**: racing the whole
  `formatBuffer` from the save path and checking a flag afterwards let the
  edit land before the flag was read, so the buffer went dirty right after
  the save. The race moved inside, before the apply; the spec was rewritten
  to match.
- Real `typescript-language-server`: advertises formatting; its edits turn
  `const  x=1` / `let   y = 2` into `const x = 1` / `let y = 2` (it does
  not add semicolons). Asserted.
- Browser build: *Format on Save* in Settings with its description;
  "Language: Format Document Alt+Shift+F" in the palette; no console
  errors. The format itself needs a server, so: seen in jsdom, not on a
  screen.

Next:

- **A tag build.** Five LSP surfaces since 0.4.2 — references, the
  definitions list, rename, format, format-on-save — none seen on a
  display. `v0.4.3` and ten minutes with the desktop app before Git
  starts.
- Then the v0.5 table: Git gutter first.

Blocked:

- Nothing technical.

Confidence:

- High on the save invariant — it is the thing the suite tries hardest to
  break, and the one mutation that survived the first draft was the one
  that mattered.
- Medium on the 2 s bound as a number: it is a guess at "fast enough not
  to notice, slow enough for tsserver on a big file". Tune from use.

---

## 2026-08-19 (PC, evening) — Rename symbol

On branch `lsp-rename`, off `main` at `cfe3db4` (#39, #40, #41 merged).
Design in `docs/superpowers/specs/2026-08-19-lsp-rename-design.md`.

Shipped:

- `src/core/lsp-rename.ts` — `renameEdits(WorkspaceEdit)` reads `changes`
  or `documentChanges` (the latter wins when both are present), merges
  entries per URI, drops malformed edits, and lists resource operations as
  `unsupported`; `prepareRenameSeed` reduces the four prepare shapes to a
  prompt seed or null.
- `lsp.renameSymbol` — **Rename Symbol**, `F2`, category Language, enabled
  on `renameProvider`. `prepareRename` first when offered (null → "Nothing
  to rename here", no prompt); the prompt is seeded from the
  placeholder / range / word; the rename is sent with `newName`; every
  touched file is opened (one unopenable file stops the whole rename before
  anything is staged; a resource op refuses it whole); the edits are
  converted against each buffer's current text and staged as **one change
  set** through `review.stage`, so the review panel shows every hunk and
  `review.apply` lands it as one transaction — one undo across all files,
  stale buffers refused. The file the command was run from is made active
  again afterwards, since opening activates. Applied buffers stay dirty,
  by design (spec §4).
- `session.ts` now declares `textDocument.rename.prepareSupport: true` —
  without it tsserver advertises `renameProvider: true` and the prepare
  path would never have fired against the server the feature was built for.
  Found by the integration test, which asserts the shape it now sends: a
  bare `Range`, no placeholder.
- CHANGELOG `[Unreleased]`, ROADMAP row ✅, README's "not there yet".

Verified:

- `npm test` — 1144 passed, 64 files (was 1119/62). `npm run check` — 434
  files, 0 errors. `npm run build` green.
- `tests/lsp-rename.test.ts` (node, 10), `tests/lsp-rename-symbol.test.ts`
  (jsdom, 14: real pane, real review service, prompt resolved through
  `ui.prompt`). Mutations seen red: prepare skipped, `unsupported` check
  removed, rename sent on cancel, `setActive` not restored, unopenable file
  `continue`d instead of stopping. **One mutation survived and changed the
  code**: dropping the `baseRevisions` the command passed to `stage` changed
  nothing, because `ReviewService.stage` records revisions itself and
  `apply` refuses a moved buffer. The dead argument was removed and the
  stale test now documents whose guard it is.
- Against the real `typescript-language-server`: `renameProvider` is
  `{ prepareProvider: true }` once asked, `prepareRename` returns the
  identifier's range, `rename` returns a `WorkspaceEdit` editing 0:6-12 and
  1:15-21 to `result`. Asserted.
- Browser build: "Language: Rename Symbol F2" in the palette (disabled,
  rightly — no server there), no console errors. The prompt, the review
  panel full of a rename, and F2 on a keyboard: not seen on a screen. Same
  gap as the rest of the LSP surfaces; a desktop build closes it.

Next:

- **Formatting on save** — the last v0.4 row before Git on the 1.0 order.
  `textDocument/formatting` → `TextEdit[]` → one change set applied before
  the write; a configured external command as the alternative the row
  names. Decide whether it goes through review (no — a format is not a
  proposal) and how `documents.ts`'s didSave interacts.
- A tag build (`v0.4.3`?) so the four LSP surfaces since 0.4.2 are seen on
  a screen before anything else stacks on them.

Blocked:

- Nothing technical.

Confidence:

- High on the wire, the normaliser and the review path; the real server
  agreed and each claim was mutation-checked.
- Medium on the prompt ergonomics (seed selected whole, validation text) —
  unseen.

---

## 2026-08-19 (PC, later) — Find references

On branch `lsp-references`, stacked on `v1-bar` (#39) — it continues that
branch's WORKLOG entry, so merge #39 first. Design in
`docs/superpowers/specs/2026-08-19-lsp-references-design.md`.

Shipped:

- `src/core/lsp-references.ts` — `referenceTargets` (the definition
  normaliser under the name of the question asked; `Location[] | null` is a
  subset of what it reads) and `locationRows(locations, texts, root)`: file
  rows over location rows, files by label, locations by position, the
  location row's label the trimmed line text, a non-file URI dropped.
- `NoxApp.locations: Signal<LocationList | null>` and
  `showLocations(title, subject, locations)` — reads each file's text once
  (open buffer from the workspace, otherwise `platform.readTextFile`, a
  failure becoming an empty line), builds the rows, shows the view.
- `lsp.findReferences` — **Find References**, `Shift+F12`, category
  Language, enabled on `referencesProvider`. Sends
  `context: { includeDeclaration: true }`. Empty → "No references found"
  and the previous list is left alone. The cursor does **not** move.
- `references.focus` — **Show References**, reopens the view without
  re-asking.
- `src/ui/ReferencesPanel.svelte`, the `references` sidebar view (rail icon
  `search`), rows/focused keyboard shape copied from `ProblemsPanel`; a
  location row lands through `revealLocation`, a file row opens the file.
- `lsp.goToDefinition` with several results now reveals the first **and**
  lists them all as "Definitions" in the same view; the "went to the first"
  notification is gone.
- CHANGELOG `[Unreleased]`, the ROADMAP row, README's "not there yet".

Verified:

- `npm test` — 1119 passed, 62 files (was 1095/60). `npm run check` — 431
  files, 0 errors. `npm run build` green.
- `tests/lsp-references.test.ts` (node, 11) and
  `tests/lsp-find-references.test.ts` (jsdom, 11: real pane + real
  `ReferencesPanel` over one app + fake server). Five mutations recorded in
  the docblock, each seen red: `includeDeclaration` dropped, `showView`
  removed, the panel landing through `workspace.open` instead of
  `revealLocation`, the no-result notification removed, the platform read
  replaced by ''.
- Against the real `typescript-language-server`: references to `answer`
  come back as `Location[]` naming the declaration (0:6-12) and the use
  (1:15-21). Asserted.
- Browser build (`npm run dev`): the References rail button renders and
  activates, the empty state reads as written, both commands appear in the
  palette with `Shift+F12`, no console errors. The list itself cannot show
  in the browser — no language server there — so, like every LSP surface
  before it, the populated panel has been seen in jsdom and not on a screen.

Next:

- **Rename symbol.** `textDocument/rename` → a `WorkspaceEdit` → one change
  set through the review panel (M6), so every edit is seen before it is
  written. `prepareRename` first where the server offers it.
- Merge #39 then this; the populated References view wants a tag build and
  a human.

Blocked:

- Nothing technical.

Confidence:

- High on the wire and the rows; the real server agreed with the fixtures
  and each test was made to fail.
- Unverified: the panel's look with real rows, and `Shift+F12` on a real
  keyboard (`Shift+F3` is bound and used, same parser).

---

## 2026-08-19 (PC) — The 1.0 bar, and the Problems-panel race closed

On branch `v1-bar`, on the Windows PC, after pulling #36–#38 (main at
`39d3999`, tag `v0.4.2`). The v0.4.2 GitHub release is still a **draft** with
all seven assets attached — publishing it is a human act, not done here.

Shipped:

- `ROADMAP.md` — a **1.0** section: what the number means (installs without a
  workaround and self-updates; find references / rename / format on save;
  Git gutter, diff, stage-and-commit; keybinding editor + workspace settings;
  explorer virtualisation; a recorded real-keyboard pass), what is 1.x on
  purpose (plugins, modal editing, Tree-sitter, the rest), and the order of
  work. Written as a proposal to edit, not a decree.
- `tests/problems-panel-open.test.ts` — the follow-up the previous entry left
  open ("if the pane's swap can ever run after `open()`'s continuation, the
  cursor lands on the previous buffer") is now **measured, not argued**: a
  real `ProblemsPanel` over the same app as a real `EditorPane`, a diagnostic
  in a file never opened, a click on the row. Cursor lands in the named file
  on both the fresh-open and the already-open branches, and the showing
  buffer is untouched. Mutation-checked: moving `goToLine` ahead of the
  `await` turns all three red.
- `README.md` — `npm test` comment said 779 tests (Status said 1092); now
  points at Status. The Status paragraph now says *how* `servers.json` comes
  to exist (**Configure Language Servers** writes a working template,
  **Reload Language Servers** picks up edits) and that Nox starts no server
  you did not list.
- This repo's local `user.email` read `frncescoa27122` — one letter short of
  the noreply address, so a commit from this PC would not have attributed to
  the account. Fixed in `.git/config`; nothing in history carries it.

Verified:

- `npm ci` then `npm test` — 1092 passed before the new file; 1095 after,
  60 files. `npm run check` — 427 files, 0 errors, 0 warnings. Windows,
  Node 24.15.0.

Next:

- **Find references.** First on the 1.0 order, and go to definition's
  "several results" case is waiting on its picker. Same door as definition:
  `requestFor('textDocument/references')`, a results list, `revealLocation`.
- Publish the v0.4.2 draft (human). Decide on signing — a purchase.

Blocked:

- Nothing technical. Not pushed, no PR — by instruction.

Confidence:

- High on the test and the doc fixes; each claim in the 1.0 table was checked
  against the file it describes, and the "Git next" line was traced to 0.2.0.
- The 1.0 bar itself is a judgement call, labelled as one.

---

## 2026-08-19 (later) — Go to definition

On branch `lsp-definition`, stacked on `lsp-render-verify` (it needs the
fake-server seam and the jsdom harness that branch adds). Same worktree,
`../nox-verify`. Pushed as #37, on top of #36; the 0.4.2 bump is #38 on top
of that. Merge in order, then tag `v0.4.2`.

Shipped:

- `src/core/lsp-definition.ts` — `Location | Location[] | LocationLink[] |
  null` reduced to `{ uri, range }[]`; links land on `targetSelectionRange`
  (the identifier) over `targetRange` (the declaration); malformed entries
  dropped, negative positions refused, duplicates removed.
- `lsp.goToDefinition` — **Go to Definition**, `F12`, category Language.
  Enabled only when the active buffer has a path and its server advertises
  `definitionProvider`, so a server still initializing greys the command
  rather than erroring. `NoxApp.revealLocation(location)` is public because
  find references will land the same way: `workspace.open(path)` (returns
  the existing id when already open) then `workspace.setSelection`, which
  dispatches to the pane showing the buffer and otherwise updates the
  buffer's own state so the pane's swap carries the cursor. Several results
  take the first and say how many; a picker is find references' list.
- CHANGELOG `[Unreleased]` and the ROADMAP row.

Verified:

- `npm test` — 1092 passed, 59 files. `npm run check` — 426 files, 0 errors.
- `tests/lsp-go-to-definition.test.ts` (jsdom, real pane + real app + fake
  server): enabled/disabled, the request's uri and position, cross-file
  jump, same-file jump, no result, many results, unopenable URI, a server
  error, and a count message that must not follow a failed reveal. Four
  mutations recorded in the docblock, each seen red.
- Against the real `typescript-language-server`: it sends `Location[]`, not
  links, and points at the identifier (line 0, 6-12). Asserted, so a change
  is a failing test.

Two things worth carrying forward:

- **`workspace.open` on an open path returns the existing id and re-reports
  nothing**, and every `null` it returns has already gone through `#fail` →
  `notifications.error`. A caller that checks "is it already active" first,
  or toasts on `null`, is doing something already done. The first version
  here did both; the review caught it.
- **`FakeLanguageServer` now answers a throwing handler with a JSON-RPC
  error**, which is what makes a request's failure path testable through
  the real service. Hover, completion and rename can use the same trick.

Follow-up worth a look, not a bug claim: `ProblemsPanel.open()` does
`await workspace.open(path)` then `app.goToLine(...)` on `this.view.get()`.
If the pane's state swap can ever run after that continuation, the cursor
lands on the previous buffer. Svelte flushes effects in a microtask queued
before `open()`'s continuation, so it is probably fine — but nothing proves
it, and `revealLocation` deliberately went through `setSelection` so as not
to depend on the answer.

Next:

- Merge #36 → #37 → #38, push the tag `v0.4.2`, publish the draft.
- Find references — the results list, and the "several definitions" picker
  with it. Then rename symbol.

Confidence:

- High on the command and the normaliser; each test was made to fail first,
  and the real server agreed with the fixtures.
- Unverified: F12 on a real keyboard in the desktop build. The keymap parses
  it exactly as it parses F3, which is bound and used, so the risk is small
  and named.

---

## 2026-08-19 — The three unseen surfaces, seen in a DOM

On branch `lsp-render-verify`, in a **worktree** at `../nox-verify` (own
`npm ci` — the shared `node_modules` predated the desktop's
`typescript-language-server` devDependency, and the integration suite failed
9/9 until it was reinstalled). Pushed as #36.

The gap: diagnostics, completion and hover each had a wire test and no
rendering test — the sources were exercised against `{ state } as
EditorView`, and nothing proved the pane's `lspCompartment` delivered them
into a live view. Closed by measuring what jsdom can drive rather than
arguing about it; the measurements and the decision are in
`docs/superpowers/specs/2026-08-19-lsp-rendering-verification-design.md`.

Shipped:

- `tests/lsp-rendering.test.ts` — the real `EditorPane` over a real `NoxApp`
  whose real `LspService` runs against an in-memory server. Seven tests: a
  published diagnostic paints `.cm-lintRange-error` under exactly `total`
  plus a gutter mark, and clears on an empty batch; typing `.` sends
  `textDocument/completion` for the pane's URI and the picker lists the
  server's labels, with `completionItem/resolve` documentation shown for the
  highlighted item; resting the pointer sends `textDocument/hover` and the
  tooltip carries the code block and prose as text — `<script>` in the
  server's markdown is characters, not an element — and leaves with the
  pointer.
- `tests/support/fake-lsp-process.ts` — the fake that `lsp-service.test.ts`
  kept privately, extracted and taught `handle(method, fn)`.
- `MemoryPlatform.languageServerFactory` — a test installs a server there;
  `capabilities.languageServers` stays false because the browser build still
  cannot start one.
- `tests/support/jsdom-layout.ts` — jsdom's `Range` has no `getClientRects`,
  and CodeMirror's `HoverPlugin` calls `coordsAtPos` from a bare `setTimeout`,
  so hover threw before the source was asked. Filled with one all-zero
  rectangle. **The rectangle's existence is invented; its numbers are
  jsdom's.** Consequence, written where the polyfill lives: `posAtCoords` is
  always 0, so the suite proves the request and the DOM, never which symbol
  was under the pointer.

Verified:

- `npm test` — 1074 passed, 57 files. `npm run check` — 423 files, 0 errors.
- Every rendering test mutation-checked against `EditorPane.svelte`: dropping
  `lspHoverExtension` reddens all three hover tests, dropping
  `lspCompletionExtension` both completion tests, no-op'ing
  `applyDiagnostics` both diagnostic tests. Recorded in the suite's docblock.

Found by looking, before a line was written:

- **CodeMirror's `hoverTooltip` underlines nothing.** `pos`/`end` on the
  returned tooltip decide when it *closes*; no decoration is applied.
  `CHANGELOG.md` `[Unreleased]` said "underlining exactly the span the server
  is talking about", `ROADMAP.md` said "highlighting the span", and
  `hover.ts` said "the highlight covers the symbol". All three corrected to
  what happens (the tooltip stays while the pointer is anywhere over the
  span), and the 2026-08-18 hover design note marked superseded on that
  point. Nobody had seen the tooltip, so nobody had seen that it did not.

Decided, and why (short form; the spec has the long one):

- **jsdom, not Playwright.** Two of three surfaces render under jsdom with no
  polyfill and the third with a one-rectangle one; zero new dependencies.
  Playwright against `npm run dev` would need a fake server injected into
  the web build, a browser download on every CI push, and still would not
  reach the WebView where both real rendering bugs lived. The next four v0.4
  features are wiring and text, which this harness reaches. Revisit —
  as vitest browser mode, which reuses the new seam — at the first feature
  whose *claim* is geometric.
- `ARCHITECTURE.md` §7's "Components embedding CodeMirror are untested" row
  was already false (`lsp-paint-target.test.ts` mounted `EditorPane`) and now
  states the real boundary. `CONTRIBUTING.md` allows a second jsdom file over
  the same component for a distinct named concern.

Next:

- Merge this, then the release ([Unreleased] holds hover, completion and the
  language-server support). Both need a push, which needs a human.
- Go to definition on the same door; then find references, rename.

Blocked:

- Nothing technical. Not pushed, no PR — by instruction.

Confidence:

- High on what the suite proves, because each test was made to fail first.
- Unverified, and now written down as such rather than as a gap: tooltip
  placement, and pointer→symbol mapping. Both are CodeMirror's.

---


## 2026-08-18 (later still) — Hover, and a shared-checkout collision

Shipped, on branch `lsp-hover`, in a **worktree** at `../nox-hover`:

- `src/core/lsp-hover.ts` — the three shapes of LSP `contents` reduced to
  ordered code/prose blocks. Pure.
- `src/editor/hover.ts` — the `hoverTooltip` source and its DOM.
- `completionCompartment` renamed `lspCompartment` and widened to hold both
  editor extensions, so the next feature is an array entry.

Verified:

- `npm test` — 1063 passed, 55 files. `npm run check` — 419 files, 0 errors.
- The no-HTML guard was checked by breaking it: swapping one `textContent`
  for `innerHTML` produces a live `<img onerror>` and a `<script>` element,
  and two tests fail. That is the assertion the design's §4 rests on.
- The language-tagged `MarkedString` branch was checked the same way; two
  tests fail, which is what renders a type signature as a paragraph.
- Against the real server: tsserver sends `MarkupContent` markdown **and**
  names a range. Both design assumptions held — unlike diagnostics, where the
  equivalent test found no `version` and turned a safeguard into dead code.

**Two sessions shared this checkout, and it went wrong three times.** Worth
writing down properly, because the lesson sharpened at each step:

1. My commit landed on the other session's branch, and `git add -A` swept its
   uncommitted work into mine.
2. It happened again with `git add <named files>` — nothing of theirs was
   captured, but it caught them with work *staged*.
3. Then the real lesson: **`git add <file>` scopes what you add; `git commit`
   commits the whole index.** A commit of mine carried four of their files
   purely because they were staged when I ran it. Found by auditing
   `git show --name-only` over every commit on the branch, and fixed by
   rebuilding it from the last clean commit — nothing had been pushed.

The fix that actually works: `git worktree add ../nox-hover lsp-hover`, plus
a **directory junction** for `node_modules` so there is no second install
(`New-Item -ItemType Junction`). The suite runs unchanged in it. Do this the
moment a second session starts, not after the third incident.

Next:

- **The tooltip has never been seen.** Same gap as the picker and the squiggle.
  A tag build and a human.
- Then go-to-definition, which is the same door and needs no new rendering.

Blocked:

- Nothing. Not pushed.

Confidence:

- High on the conversion and the source, both mutation-checked.
- Unverified: the tooltip rendering on a real hover.

---

## 2026-08-18 (later still) — The apt step that hangs

On branch `ci-apt-mirror-stall`, merged to `main` as #34. The
`rust (ubuntu-22.04)` job's dependency install hung five times in one day,
10-26 minutes against ~1.8 minutes healthy, each time needing a human to
cancel and `gh run rerun`.

What it actually is, from the run logs rather than from the symptom:

- `apt-get update` is **not** the problem. It finishes in 3-8s even on the bad
  runs (32s on the worst). The whole stall is inside `apt-get install`.
- Nothing fails, times out, or errors. apt just crawls: run 32163740199
  reported `Fetched 55.6 MB in 22min 12s (41.7 kB/s)` against `in 9s` on a
  healthy run of the same commit.
- Time per package is **uncorrelated with package size** — 14.2 kB took 17.9s,
  356 kB took 5.0s. So it is per-request latency across 137 serial requests,
  not bandwidth. That is why `Acquire::Retries` and `Acquire::http::Timeout`
  are both no-ops here: there is no error to retry and no idle socket to time
  out. A plain retry is also weak, because the degradation is sustained for
  the whole 22 minutes rather than bursty.

So the fix is to stop asking the mirror at all, and to bound what is left:

- `.github/actions/linux-build-deps/` — new composite action, used by both
  `ci.yml` and `release.yml` (which carried the identical block plus
  `patchelf`). One copy, because the retry shell is subtle enough that two
  copies would drift.
- `actions/cache@v6` over `~/apt-archives`, seeded into
  `/var/cache/apt/archives` **after** `apt-get update`. On a warm cache apt
  downloads nothing, so the mirror cannot affect the step at all.
- Download and install are split. A `timeout` can then only ever interrupt the
  network half; dpkg is never killed part-way through unpacking. Completed
  `.debs` survive the kill, so the three attempts accumulate progress rather
  than restarting.
- `--no-install-recommends` drops 42 packages of gstreamer, pipewire, pulse,
  polkit and codecs that a compile-only job never uses.
- `Acquire::ForceIPv4` — the one unproven piece, see Blocked.

Verified, locally in Docker against a runner-like image:

- Cold cache: 239 packages, exit 0, 48s, `pkg-config --modversion
  webkit2gtk-4.1` → 2.50.4.
- Warm cache: `Seeded 239 package(s)` → `Need to get 0 B/124 MB`. Zero
  archives fetched. With `extra-packages: patchelf`, exactly `72.1 kB`.
- Resume is real, not assumed: a download killed at 3s kept 55 of 281 `.debs`
  and the retry fetched only `115 MB/133 MB`.
- The retry function against a hang → three attempts then `::error::` and
  nonzero, in 21s; against a twice-failing command → recovers on attempt 3;
  `set -e` does not abort the script on a failed attempt.
- `bash -n` clean, shellcheck clean, all three YAML files parse, CRLF intact.

Then confirmed on the real runners, two `workflow_dispatch` runs on the pushed
branch (32184094506 cold, 32184425793 warm), all ten jobs green:

- Cold: `Cache not found`, `Seeded 0`, `Fetched 52.8 MB in 51s`, then
  `Need to get 0 B/52.8 MB` for the install half. Step took 1m52s.
- Warm: `Cache hit`, `Seeded 122 package(s)`, `Need to get 0 B/52.8 MB`.
  **Nothing was fetched from the mirror at all.** Step took 1m09s.
- `--no-install-recommends` is worth more on the runner than in the container:
  137 packages and 55.6 MB become 122 and 52.8 MB. Fewer serial requests is
  the axis that matters, since the stall is per-request.
- **A PR run reads caches from its base branch, not from a sibling.** PR #34's
  own check therefore ran cold; the cache only starts serving PRs once `main`
  has run once and saved it. Confirmed afterwards on PR #35: `Cache hit`,
  `Seeded 122`, `Need to get 0 B/52.8 MB` on someone else's branch.
- The repo was at 9.8 GB of its 10 GB Actions cache limit, 7.71 GB of it stale
  `v0.4.1-*-test` tag caches. Cleared — a 50 MB apt cache was otherwise a
  plausible eviction, which would have quietly undone all of this.
- actionlint clean over both workflows — which, until the tag run below, was
  the only check `release.yml` got.

And `release.yml`, which had never run, exercised by a throwaway tag
`v0.4.1-apt-test1` off `main` (run 32207771888, since deleted along with its
draft and caches). All four platforms built:

- The `extra-packages: patchelf` input reaches the action — `EXTRA_PACKAGES:
  patchelf` — and takes its own cache key, `apt-jammy-patchelf-`, separate
  from CI's `apt-jammy-base-`. Worth keeping separate even though `patchelf`
  turns out to be preinstalled on the runner and downloads nothing.
- **The mirror degraded mid-run and the retry caught it**, unplanned. Two
  120s attempts at `apt-get update` timed out, the third got through at
  `Fetched 257 kB in 38s (6695 B/s)`, and the build went green with nobody
  watching. Cold path cost 6m24s. That is the whole point of the change,
  observed rather than argued.

Two things worth carrying forward:

- **Seed the apt cache after `apt-get update`, never before.** The first
  version seeded first and silently re-downloaded all 124 MB — an
  `APT::Update::Post-Invoke` hook can empty `/var/cache/apt/archives`. Caught
  only because the warm-cache run was actually executed rather than reasoned
  about.
- **`apt-get update` degrades too.** Every one of the five logged incidents
  sat in `apt-get install`, and the entry above says so — but the release run
  stalled in `update` instead, at 6.7 kB/s. The pattern held across five
  samples and still was not the rule. `update` is wrapped in the same retry
  on general principle, and that is the only reason that run passed.

Next:

- Watch whether a stall ever recurs on a *cold* cache. That is the only path
  still exposed, and it is now bounded at three 5-minute attempts rather than
  open-ended.

Blocked:

- `Acquire::ForceIPv4` is a hypothesis, not a measurement. Constant
  size-independent per-request latency is what a failed IPv6 connect followed
  by IPv4 fallback looks like, but the runner logs do not say so outright. It
  is harmless if wrong, and the cache does not depend on it being right.
  The release run degraded straight through it, so whatever it does, it is
  not a cure on its own — the cache and the retry are what carry this.

## 2026-08-18 (later) — Completion

Shipped, on branch `lsp-completion`, all six planned tasks:

- `LspService.requestFor` / `capabilitiesFor` — the request door. Diagnostics
  arrive by push; everything else in v0.4 has to ask, and `#running` was
  private. Hover, go-to-definition and rename reuse this.
- `src/core/lsp-completion.ts` — items to CodeMirror completions, pure.
- `src/editor/completion.ts` — the source, and the DOM half of lazy docs.
- Wired through a compartment the pane reconfigures, keyed off `currentId`.

Verified:

- `npm test` — 1031 passed, 53 files. `npm run check` — 415 files, 0 errors.
- Four guards mutation-checked rather than trusted: the `textEdit` range,
  `filterText`, the `context.aborted` check, and `isIncomplete` suppressing
  `validFor`. Each fails its own test when removed.
- Against a real server: `s.` returns members with kinds, and **none of the
  items carry documentation** — asserted, because that is what makes
  `completionItem/resolve` load-bearing rather than an optimisation.

Two things worth carrying forward:

- **`npm run check` exits 0 even when it reports errors.** A
  `check && test && commit` chain therefore does not gate on it. One commit
  went in with a type error before this was noticed; grep the output for
  `0 ERRORS` instead of trusting the exit code.
- That error was real and reshaped the design: `CompletionInfo` is
  `Node | null | {dom}`, never a string, so lazy documentation cannot return
  text. `core/` stays DOM-free and the editor layer owns the callback.

Next:

- **The picker has never been seen.** Same gap as the squiggle before it: the
  wire behaviour is proven and the rendering is not. A tag build and a human.
- Then hover, which is the smallest feature left on the door this opened.

Blocked:

- Nothing. Not pushed.

Confidence:

- High on the conversion and the source — mutation-checked, and the real
  server contradicted nothing this time.
- Unverified: the picker itself, and the compartment actually delivering the
  source into a live view. The test proves the compartment exists in a built
  state, not that a keystroke reaches the server.

---

## 2026-08-18 — A real server, and what it changed

Shipped:

- `tests/lsp-integration.test.ts` — drives `typescript-language-server` 5.3.0
  through the same adapter the fake server uses, now extracted to
  `tests/support/lsp-child.ts` so a difference between fake and real cannot be
  a difference in the harness. Runs in CI, ~10s.
- `src-tauri/src/lsp.rs` — a Windows `.cmd` fallback via `cmd /C`.

Verified, and two of these contradict what the spec assumed:

- **tsserver sends no `version` on `publishDiagnostics`.** The field is
  optional and it omits it, so `LspService`'s stale-batch check never fires for
  the primary server. The range clamp in `editor/lsp.ts` is the only safeguard
  actually carrying the feature. Recorded as an assertion, so a future tsserver
  that starts sending one is a test failure someone reads.
- **tsserver advertises `textDocumentSync: 2` (incremental) and accepts a
  full-document change anyway**, clearing the diagnostic when the error is
  fixed. Full-text sync costs nothing against it. Mutation-checked: a change
  that does not fix the error leaves the diagnostic and fails the test.
- URI round-trips exactly, `c%3A` percent-encoding included.
- `npm test` — 979 passed, 50 files. `npm run check` — 410 files, 0 errors.
  CI green on all five jobs.

Smoke-tested on real hardware, from the `v0.4.1-lsp-test1` tag build:

- Nox spawned the server through the fallback and the process tree proved it:
  `Nox.exe -> cmd.exe "/C typescript-language-server --stdio" -> node.exe`.
  Both untested paths — `lsp.rs` supervision and the Windows `.cmd` fallback —
  confirmed working, not merely compiling.
- Same server pid for 40s, so the handshake completed; a failed one restarts at
  1s/2s/4s and then stays down.
- A real window close (WM_CLOSE, not a kill) stopped the server with **no
  orphans**. The one process that first appeared to be an orphan was the
  PowerShell command doing the searching — its own command line contained the
  search string.
- The fallback was then widened: it retried only on `NotFound`, which covers a
  bare command on PATH but not an absolute path to a `.cmd`, where
  `CreateProcess` fails with a different error. Someone writing a full path
  into `servers.json` is at least as likely.

Second build (`v0.4.1-lsp-test2`), after Francesco reported an empty console
window appearing on reload:

- **Windows gives a console-subsystem child its own window when the parent is
  a GUI app.** The `cmd` shim and the server are both console apps, so an empty
  console sat in front of the editor for the session — empty because the output
  is piped to Nox, permanent because the server is meant to keep running.
  Fixed with `CREATE_NO_WINDOW` on both spawn attempts.
- The first check for the fix was wrong and nearly reported a failure:
  `conhost.exe` is still created under the shim, because `CREATE_NO_WINDOW`
  hides the console rather than preventing one. The right measurement is window
  *visibility* — `EnumWindows` + `IsWindowVisible` finds no window belonging to
  the `cmd` or `conhost`, and no `ConsoleWindowClass` visible anywhere.
- Server stable for 25s afterwards, so the flag did not break the pipes.
- **`agent.rs` has the identical defect** and was left alone to keep the PR
  scoped. Spun off as its own task.

Third build (`v0.4.1-lsp-test3`) — **the squiggle is confirmed on real
hardware**, on the right buffer, with the server connected in the status bar.

Two bugs found by looking at a screen, both invisible to every test here:

- **A console window on every reload.** Windows gives a console-subsystem
  child its own window when the parent is a GUI app. Fixed with
  `CREATE_NO_WINDOW`; see the second build's entry.
- **The squiggle for `x.ts` appeared inside `servers.json`.** `EditorPane`
  holds one view and re-points it per tab, routing transactions to
  `workspace.applyTransaction(currentId, …)`. The app painted from a
  `workspace.activeId` subscription, which fires synchronously, while the pane
  swaps state in an effect, which runs later — so the newly-active buffer's
  diagnostics were dispatched while the *previous* buffer's state was loaded,
  and recorded against it permanently. Two owners of "which buffer is this
  view showing"; now one, the pane. **The tests added with the fix do not
  reproduce the race** — restoring the old paint leaves them green, because
  the harness drives effects through `flushSync`. Said out loud in the file.

Also confirmed, and not a bug: the squiggle sits under the *variable name*,
not the offending literal. `tsc --noEmit` reports `x.ts(1,7)` for
`const n: number = "x";` — column 7 is the `n`. TypeScript reports an
assignability error at the declaration, and Nox renders the range faithfully.

The setup that finally worked, worth writing down: a **global**
`typescript-language-server` needs a **global `typescript@6`** beside it.
`npm install -g typescript` now installs TypeScript 7, which no longer ships
`lib/tsserver.js`, and the server refuses to start without it.

Debt, deliberate:

- ~~**The squiggle has never been seen.**~~ Seen, on the right buffer. Kept
  below for the record of what it cost to get there.
- **The squiggle had never been seen** when the first two builds shipped. The UI could not be driven this
  session, so "diagnostics appear" is proved as far as the server running and
  the pipes connecting, and no further. The console-window bug is a reminder
  that a process tree is not a screen: it was invisible to every check made
  here and obvious the moment a human looked.

Confidence:

- High on the protocol layer — it has met a real server and been contradicted
  by it, which is worth more than the tests that agreed with me.
- High on supervision and Windows launching, now that the process tree has
  been read directly.
- Unverified: the rendering itself.

---

## 2026-08-17 — LSP client and diagnostics, all 16 tasks

Shipped:

- `src/services/search.ts:331` — `previewReplacement` resolves capture groups
  with a sticky match at the match's own column and returns `null` unless the
  result reproduces exactly what search reported. It previously fell through to
  the raw template, so a project-search row previewed a literal `$1` while the
  write substituted the capture. Branch `fix-replace-preview-groups`.
- Deleted the two merged preserve-case plan docs. Branch
  `retire-preserve-case-plans`.
- The LSP client, on branch `lsp-client`, all sixteen tasks of
  `docs/superpowers/plans/2026-08-17-lsp-client.md`:
  `src/core/uri.ts`, `src/core/lsp-position.ts`, the `LanguageServerProcess`
  boundary, `src-tauri/src/lsp.rs` (framing + supervision + four commands),
  `src/services/lsp/{transport,session,documents,registry,index}.ts`,
  `src/editor/lsp.ts`, `src/ui/{lsp-status,problems}.ts`,
  `src/ui/ProblemsPanel.svelte`, and the `app.ts` wiring with **Configure
  Language Servers**, **Reload Language Servers** and **Show Problems**.

Verified:

- `npm test` — 971 passed, 49 files. `npm run check` — 408 files, 0 errors.
  Baseline at session start was 855 / 37 and 385 files.
- The replace bug was reproduced in node before any code changed: window lead
  143, match column 60, rescan lands on 56/63/70, never 60.
- Four load-bearing tests were mutation-checked rather than trusted — the
  pre-initialize queue, the document version, the stale-diagnostic drop, and
  the preview fix itself. Each fails when its production line is removed.
- `tests/lsp-session.test.ts` runs a real Node child speaking genuine
  `Content-Length` framing, including a non-ASCII payload.

Next:

- **A desktop smoke test.** Push a throwaway `v0.4.1-lsp-test1` tag, let CI
  build the Windows installer, install it, and open a `.ts` file with an error
  in a workspace with `servers.json` configured. That exercises the two things
  no test here can: `lsp.rs`'s supervision, and whether a squiggle actually
  appears. It is also the only way to confirm the Windows `.cmd` fallback works
  rather than merely compiles.
- Then completion, the cheapest remaining v0.4 item
  (`@codemirror/autocomplete` is already a dependency).

Blocked / unverified:

- ~~`src-tauri/src/lsp.rs` has never been compiled.~~ **Resolved.** CI built
  it on Linux, macOS and Windows and ran all nine framing tests green (run
  32090362916). It did not compile on the first try: `push` was written before
  the crate's `Result<T>` alias existed and returned `Result<Vec<String>,
  String>`, which is E0107 against a one-argument alias. That is exactly the
  class of error the Python port could not catch, and exactly why the PR went
  up as a draft.
- ~~No real language server has ever talked to this.~~ **Mostly resolved.**
  `tests/lsp-integration.test.ts` drives `typescript-language-server` 5.3.0 and
  runs in CI on Node 20 and 22. It turned one design assumption around and
  confirmed another — see the entry below. What is *still* untested is
  `lsp.rs`'s own supervision (the integration test reaches the server through
  the Node adapter, not through Rust) and the UI end of it: squiggles actually
  painting, the panel actually rendering. Both need a desktop build.
- `lsp-client` is pushed as draft PR #28, CI green. The other two branches
  (`fix-replace-preview-groups`, `retire-preserve-case-plans`) are unpushed.

Confidence:

- High on the TypeScript: red-green watched on every task, four mutation
  checks, and the full suite green.
- High on `lsp.rs` now: compiled and tested on all three platforms by CI.
- Low on the end-to-end claim. "Diagnostics appear" is true of the code paths
  and untested against a real server.

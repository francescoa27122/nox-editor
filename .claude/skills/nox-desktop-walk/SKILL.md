---
name: nox-desktop-walk
description: Use when verifying Nox in the packaged desktop app rather than the browser: walking the UI, driving it with computer-use or screenshots, checking terminal/git/LSP/agent/native-dialog behaviour, resuming a walk that was interrupted, or deciding whether a browser observation is trustworthy.
---

# Walking the packaged Nox

## Overview

The browser target runs the same renderer against `WebPlatform`, where
`terminals`, `agentProcesses`, `languageServers`, `localModels`, `gitState`,
`nativeDialogs`, `externalFileDrop`, `revealInFileManager`,
`recoverableDelete`, `persistentStorage` and `selfUpdate` are all **false**. Six
sidebar panels and every native dialog are therefore unreachable there.

**A walk's job is the part `npm test` structurally cannot reach.** Anything a
headless test could assert should be a headless test instead. Walks are the
scarcest resource in this project and get spent on native chrome and
real subprocesses.

**Geometry inside the WebView no longer needs a walk.** The `editor` vitest
project (`npm run test:editor`) is real chromium with real layout, so anything
*drawn* can be measured and screenshotted there without a desktop at all.
`tests/browser/blame-gutter.test.ts` is the worked example.

**Nor does the terminal, as of 2026-08-30.** `e2e/specs/terminal.e2e.js` drives
a real pty in the packaged binary on all three platforms: the panel opens, a
command is typed, its output comes back, and the session survives the panel
being hidden. The in-window menu bar has had `e2e/specs/menu-bar.e2e.js` for
longer. Read `e2e/README.md` before walking either by hand.

What still needs the machine is what lives outside the WebView: **native
dialogs**, the **native macOS menu**, a **real git repository**, and how the
packaged bundle behaves on disk.

**One question the harness raised and cannot answer.** Under WebDriver every
character reaches xterm *twice*: typing `echo` produces `eecchhoo`. The palette
is clean under the same driver, and a probe shows the character arriving as an
`input` event on xterm's helper textarea, which is what `preventDefault` exists
to stop. That points at the driver rather than at Nox, and a synthetic-input
harness is the wrong instrument to settle it. So, on the walk: **type a few
words in the terminal and check each character appears once.** It costs ten
seconds and it closes the one thing the automated suite had to leave open.

Verify commands live in `CLAUDE.md`. Layer rules live in `ARCHITECTURE.md`. This
file covers only the walk itself.

## Launch recipe

```bash
npm test && npm run check && npm run build && npm run app:build
./src-tauri/target/release/bundle/macos/Nox.app/Contents/MacOS/nox \
  --geometry 1400x880+0+26
```

`--geometry WxH+X+Y` is in **logical points**. `+X+Y` is relative to the
monitor's *work area*, so `+0+0` is the top-left corner of usable space, not a
y the menu bar will swallow. Size and position are clamped to that area and to
the window minimums.

It then echoes `nox: geometry WxH+X+Y` on stdout, in **absolute screen
points**, the request after clamping, so it matches what an external tool
measures.
Anchor on that line; never on measurements taken from a screenshot.

It is arithmetic, not a read-back: `set_position` is asynchronous on macOS, so
querying the window straight afterwards returns the *old* position. If you need
the window's true bounds, take them from CoreGraphics.

To skip the native folder picker, point `rootPath` in
`~/Library/Application Support/dev.nox.editor/session.json` at your fixture
before launching. Back it up; restore it after.

## Durable facts

These follow from macOS and from Nox, and stay true as tooling changes.

| Fact | Consequence |
|---|---|
| `/Applications/Nox.app` shares bundle id `dev.nox.editor` | `open -a Nox` launches **that**, not your build. Always launch by executable path. |
| Three coordinate spaces exist at once | Physical pixels, logical points, and whatever size your screenshot tool hands back, all different. **Derive the ratio, never assume 2x.** Anchor on the `nox: geometry` line instead of measuring an image. |
| `scripts/window-id.swift` prints a window **number**, not bounds | It is a handle for `screencapture -l <id>`, not a measuring tape. It needs no accessibility permission, which is its value. |
| `devUrl` is hardcoded to port 1420 but `vite.config.ts` sets `strictPort: false` | A second `npm run dev` silently takes 1421 while `tauri dev` loads whatever already owns 1420, so you can drive one checkout's renderer believing it is another's. Kill stray vite processes before any walk. |
| The release bundle has no devtools | `Cargo.toml` declares `tauri = { features = [] }`. For exact layout numbers use `npm run app`, since debug enables devtools. It is the same `platform.id === 'tauri'` and CSS layout cannot differ by optimisation level. |
| AppleScript `set {position, size}` on one line returns `-10003` | Use `--geometry`. If you must use AppleScript, set position and size in separate calls. |
| Window geometry is never persisted | Every launch is `tauri.conf.json`'s size, centred. A walk that depends on last run's window is not repeatable. |
| macOS draws traffic lights over the overlay title bar | `TitleBar.svelte`'s inset is gated on `platform.id === 'tauri'`, which **no test and no browser session can ever produce**. Only a walk sees it. |

## Proving you are driving the build you just made

`__APP_VERSION__` comes from `package.json`, so two different checkouts report
the same version. It cannot tell builds apart. What can:

- `shasum -a 256` the executable after building; compare with the path
  `ps -p <pid> -o comm=` reports for the process you are actually driving.
- The `nox: geometry …` line. A Finder- or `open`-launched instance receives no
  argv and prints nothing, so seeing it proves this process took your flag.
- Never use the thing under test as the identity check.

## Harness quirks

Volatile. Verify before trusting, and prefer a durable workaround.

| Quirk | Workaround |
|---|---|
| Machine contention aborts computer-use batches | The dominant cause of abandoned walks. Checkpoint after every item (below). |
| Escape may not reach the app | Never use Escape as a verification input. A "no-op Escape" is harness noise, not a finding. |
| An agent window can swallow clicks in one screen region | Keep the Nox window clear of it, or drive from the command palette. |

## Drive by command id, not by pixel

Every user action is a `Command`. Open the palette, type the command's title,
confirm the palette opened **before typing**. If it did not, the keystrokes
land in the buffer and silently edit your fixture.

Prefer `commandId` and accessible names over coordinates: the chrome is under
active redesign and any coordinate you write down expires.

## Resumability

`.desktop-pass-report.md` records a real walk that ended **2 PASS, 3 PARTIAL,
12 UNSEEN**, abandoned mid-run with no way to resume. Prevent the repeat:

1. Write the checklist to a report file **before** starting, every item `UNSEEN`.
2. After each item, update that one line to `PASS` / `PARTIAL` / `FAIL` with the
   evidence: one sentence, and the screenshot if there is one.
3. On resume, read the file and start at the first `UNSEEN`.

A walk interrupted at item 4 of 17 must cost four items to redo, not seventeen.

## Common mistakes

| Mistake | Why it bites |
|---|---|
| Sizing the window past the display | The bottom rows fall off screen and read as missing UI. This produced a false "status bar is gone" finding that had to be retracted. `--geometry` clamps; hand-set sizes do not. |
| Reporting a browser observation as a desktop fact | Half the app is disabled there. Label it `BROWSER-ONLY` or drop it. |
| Trusting `npm test` green as evidence about a feature | It is evidence about the suite. Both classes of defect that shipped here were green on main. |
| Spending a walk on what a headless test could assert | Walks are scarce; convert the assertion into a test instead. |

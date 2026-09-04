# Driving the packaged app

WebDriver against the real Nox binary. Everything in `tests/` at the
repository root tests *source*; this is the only thing that launches the
thing users install.

## Why it exists

The desktop app had been verified exactly once, by hand, on macOS. That walk
(`.desktop-pass-report.md`) marked **12 of its 17 items UNSEEN** and reported
two defects that were later traced to the walk harness rather than to Nox —
an invisible window that swallowed clicks in a screen region it also hid from
its own screenshots, and **Escape eaten at the OS level** before any app could
see it. An instrument that silently drops inputs cannot answer "does the
packaged app work" in either direction.

Meanwhile Linux and Windows ship installers nobody has ever launched.

## Running it

Needs a Rust toolchain. The Windows development machine does not have one on
git-bash's PATH, which is why this harness was written to be verified in CI.
**It does run locally where a toolchain exists**: the whole suite was run that
way on 2026-08-30 in a Linux container, four spec files in twelve seconds,
which is a far shorter loop than a CI round trip. Check for `cargo` before
assuming it is absent. That assumption has been wrong here before.

```bash
npm ci                                        # at the repository root
npm run tauri build -- --debug --no-bundle --features wdio   # see below
cd e2e && npm ci && npm test
```

`--features wdio` is not optional: it is what compiles the WebDriver server
into the binary. Without it the app builds and runs perfectly well and nothing
can drive it. On Linux add `xvfb-run -a` before `npm test`, because a GTK
window still needs somewhere to draw. **No driver to install on any platform** —
that is the point of the embedded provider.

Set `NOX_E2E_BINARY` to point at the binary if the configured path is wrong.
Tauri names the built binary from `productName` and Cargo names it from
`package.name`, and those disagree here — `Nox` against `nox`. `--no-bundle`
stops before the rename, so it is the Cargo one.

## What belongs here

Existence, text, and state transitions. **Never geometry.** jsdom suites in
this repository are already forbidden from claiming anything positional
(`tests/support/jsdom-layout.ts` argues that at length), and a WebDriver suite
asserting on pixel positions would be the flakiest thing in CI for the least
return. If a question is "is it in the right place", it is not a question for
this harness.

Prefer assertions no other layer can make. `tests/` already covers services,
components and wiring against a fake disk far faster than a real window can.
What only this can reach is the packaged binary actually starting, the OS
delivering a keystroke, and the platforms that have no other coverage at all.

## Platforms

| | How |
|---|---|
| **Linux** | Green in CI. `xvfb` only — nothing else to install. |
| **Windows** | Green in CI. Nothing to install. |
| **macOS** | Green in CI. Nothing to install. |

All three run the same specs against the same embedded WebDriver server, in
well under a second each.

## The specs

| File | What only it can answer |
|---|---|
| `smoke.e2e.js` | The packaged binary starts and draws its chrome; the palette opens on its chord and closes on Escape, which the manual walk could never check because its own harness ate Escape at the OS level. |
| `menu-bar.e2e.js` | The in-window bar opens, switches between menus and closes. Guards `7389643`, where the click-away layer covered the titles and sliding between menus had never once worked. |
| `terminal.e2e.js` | A real pty, a real shell, a command typed and its output read back, and the session surviving a hidden panel. `MemoryPlatform.openTerminal` throws, so no suite under `tests/` can run a shell at all. |
| `walk.e2e.js` | Three items the 2026-08-20 hand walk marked UNSEEN: the destructive confirm's focus, the line-ending item, the sidebar chord. |
| `modal-focus.e2e.js` | Focus cannot reach the shell behind a modal, driven by `focus()` against a real focus implementation. jsdom implements `inert` as a property with none of its behaviour, so no suite under `tests/` can check the trap itself. |

## Typing into xterm

`browser.keys` and the Actions API both deliver **every character twice** to
xterm, and only to xterm. The palette's `<input>` is clean under the same
driver in the same session. `terminal.e2e.js` therefore types with `addValue`
on xterm's helper textarea, and its header sets out the evidence that this is
the driver ignoring `preventDefault` rather than a defect in Nox. Read that
before changing how anything here types.

## Why the external driver was abandoned (historical)

Everything up to the session works — `nox.exe` builds, the service detects
WebView2 `151.0.4129.86`, downloads the **exactly matching** msedgedriver, and
`tauri-driver` reports ready on 4444. Then `POST /session` waits sixty seconds
and returns `session not created: DevToolsActivePort file doesn't exist`:
msedgedriver launched the app and waited for a Chromium DevTools port that a
Tauri WebView2 window never opened. Version skew, the usual cause of exactly
that string, is ruled out by the exact match.

Not a configuration mistake here. [`Haprog/tauri-wdio-win-test`][h] exists to
do precisely this — Tauri 2, WebdriverIO, `tauri-driver`, `windows-latest` —
and its author reports "hard issues using the latest version of WebdriverIO …
I could not find any way to make it work", with only a downgrade to
WebdriverIO **v7** succeeding and the Actions integration still marked WIP.

[h]: https://github.com/Haprog/tauri-wdio-win-test

**Resolved by moving the server into the app**, which is what
`driverProvider: 'embedded'` and `src-tauri`'s `wdio` feature now do. Both
platforms went green on the same change, and macOS became reachable with it.
Kept here because the failure is not obvious from the outside — an exactly
matching driver that still cannot open a session looks like a configuration
mistake for a long time before it looks like a dead end.

## Solved: the ten seconds per command

The specs used to take **six minutes**. They now take **575 ms** on Linux and
**666 ms** on Windows. The `findElement` underneath had always taken 4 ms.

The cost was `TauriWorkerService.beforeCommand`, which runs
`ensureActiveWindowFocus` for `findElement`, `findElements`, `$`, `$$`,
`getTitle` and `elementClick` — everything a spec does. It asks the app for its
window states over `window.__TAURI__.core.invoke`, and Nox does not expose
`window.__TAURI__` at all: the renderer reaches Tauri through
`platform/tauri.ts`. So the lookup could not succeed, and it failed by *timing
out* rather than erroring — 5 s in the `before` hook and 5 s again per command.

`wdio.conf.js` now switches to the window handle it is already on, once. The
service reads any successful `switchToWindow` as the caller choosing a window
and stops second-guessing it for the rest of the session. That is correct as
well as fast: focus recovery is for apps with several windows, and
`tauri.conf.json` declares one.

**Rejected:** `withGlobalTauri: true` would also have made the lookup succeed,
by putting a working invoke bridge on `window` in the shipped app. That is a
security regression traded for test convenience.

The lesson worth keeping: the first diagnosis here was wrong — it blamed the
service waiting for a missing plugin, and predicted the embedded provider
would fix it. It did not (6m15s → 5m53s). Reading the log for what was
actually between a command and its result, rather than reasoning from the
symptom, is what found a 4 ms operation inside a ten-second wait.

## Required to merge

All three legs are in `main`'s required status checks as of 2026-08-24, so a
change that breaks the packaged app on any platform cannot land. That is the
whole point of the harness, and until it gated a merge it was only ever
advice.

The record it was promoted on, measured rather than asserted: **36 job runs,
zero flaky failures.** The single failure in that window was macOS's first
ever run, which caught two real defects — the specs assumed an in-window menu
bar that macOS correctly does not have, and `Ctrl` where macOS uses `⌘`. A
true positive, not noise.

Two things worth knowing about the shape of that gate:

- `main` is `strict`, so a branch must be up to date before merging. When main
  moves, `gh pr update-branch` and a second pass.
- `enforce_admins` is on, so a leg that *does* go flaky blocks everyone with
  no override. Removing one is the same call in reverse:

  ```bash
  gh api --method DELETE "repos/<owner>/nox-editor/branches/main/protection/required_status_checks/contexts" -f 'contexts[]=e2e (macos-latest)'
  ```

## Still to do

- **More specs.** Five is a smoke test, and the 2026-08-20 walk left twelve
  items UNSEEN. They are cheap now — a run is under a second, so the cost of a
  spec is writing it rather than waiting for it.

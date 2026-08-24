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

Needs a Rust toolchain, which the development machine does not have — this is
why the harness is verified in CI rather than locally.

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
| **Linux** | Running in CI, green. Embedded provider; `xvfb` only. |
| **Windows** | Running in CI, green. Embedded provider; no external driver. |
| **macOS** | Now a matrix entry away: the plugin it needed is registered. Untried. |

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

Four specs used to take **six minutes**. They now take **575 ms** on Linux and
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

## Still to do

- **Drop `webkit2gtk-driver`.** The embedded provider replaced
  WebKitWebDriver, so the package is dead weight. Kept deliberately through
  the provider swap and the fix above so each had exactly one variable.
- **macOS.** A matrix entry now that the plugin is registered; untried.
- **Promote into required checks**, once there is a flakiness record to
  justify it.

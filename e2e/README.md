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
npm run tauri build -- --debug --no-bundle    # the binary being driven
cd e2e && npm ci && npm test
```

On Linux add `xvfb-run -a` before `npm test`, and install `webkit2gtk-driver`
— that package *is* WebKitWebDriver, which is what actually drives the
webview. The service installs `tauri-driver` itself, and on Windows downloads
the Edge driver matching the installed WebView2, which is the usual cause of
a suite that hangs instead of failing.

Set `NOX_E2E_BINARY` to point at the binary if automatic detection picks the
wrong one. Tauri names the built binary from `productName` and Cargo names it
from `package.name`, and those disagree here — `Nox` against `nox`.

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
| **Linux** | Running in CI, green. `webkit2gtk-driver` + `xvfb`, no Rust change. |
| **Windows** | **Blocked**, and not on a matrix entry — see below. Attempted in [#118](https://github.com/francescoa27122/nox-editor/pull/118), left open. |
| **macOS** | Needs `tauri-plugin-wdio-webdriver` registered in debug builds — a source change, not a workflow one. Free; the paid CrabNebula driver is not required. |

## Windows: the external driver is a dead end

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

**The fix is the embedded provider**, which replaces `tauri-driver` and
msedgedriver with a WebDriver server inside the app
(`tauri-plugin-wdio-webdriver`, published alongside the npm package). It is
what the service now defaults to and the only way macOS is supported at all,
so one change buys both remaining platforms — and it may also remove the six
minutes below, which are spent waiting for that very plugin.

It wants its own change: it adds a **remote-control surface to Nox's own
crate**, so the dependency belongs behind a Cargo feature rather than only a
gated call site — not merely unregistered in a release build but not compiled
into one — plus `debug_assertions`, so the feature alone cannot arm it. And it
edits `src-tauri/src/lib.rs`, the application entry point, on a machine with
no `cargo`.

## Known: it is slower than it should be

Four assertions take **six minutes**. That is not the app being slow to start
— the session is established about two seconds in. The log shows a tight
`executeAsyncScript` poll returning `false` roughly every 50 ms, following the
service's `Waiting for Tauri plugin initialization…`. It is waiting for
`tauri-plugin-wdio-webdriver`, which this setup deliberately does not have,
and giving up slowly.

That cost is paid per session, so it does not grow much with more specs — but
it is six minutes of every pull request for nothing, and it is the first thing
to fix before this job is promoted into branch protection's required checks.
The service's log-capture and plugin-wait behaviour are configurable; the
option names want reading from its configuration reference rather than
guessing.

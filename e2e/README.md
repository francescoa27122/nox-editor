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
| **Linux** | Running in CI. `webkit2gtk-driver` + `xvfb`, no Rust change. |
| **Windows** | Next. A matrix entry; the service handles the Edge driver. |
| **macOS** | Needs `tauri-plugin-wdio-webdriver` registered in debug builds — a source change, not a workflow one. Free; the paid CrabNebula driver is not required. |

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

## Known: every command takes about ten seconds

Four assertions take **six minutes**, on both platforms.

The first guess here was wrong and is worth recording as such: this was
written up as the service's `Waiting for Tauri plugin initialization…` giving
up slowly, and the embedded provider was expected to remove it by supplying
the very plugin being waited for. It did not — 6m15s became 5m53s.

The real shape is one WebDriver command per ten seconds. Consecutive
`findElement` calls in `waitForBoot` land at `:43:52`, `:44:02`, `:44:12` —
a flat ten-second round trip each, not a retry loop, since WebdriverIO's own
poll interval is 500 ms. Roughly thirty-five commands across four specs is the
entire six minutes, which is also why the number barely moved when the
provider changed: it is per *command*, not per session, so **it will grow
linearly with every spec added.** That makes it the thing to fix before this
job is promoted into branch protection's required checks, and before the suite
grows much.

Ten seconds is a suspiciously round number — a default timeout being waited
out somewhere in the driver, rather than work being done. Worth starting from
the service's log-forwarding, which injects a script around commands, and from
whatever implicit-wait the embedded server applies.

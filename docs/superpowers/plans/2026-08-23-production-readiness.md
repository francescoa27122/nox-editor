# Production readiness — the five gaps, and the order to close them

Written 2026-08-23 against `8d08c25` (v0.8.3). The roadmap says **every 1.0
code row is done** and what remains is "a ritual and a purchase". That is true
about *features*. It is not true about *production*, and this plan is the
difference.

The five below are not a wish list. Each is a place where Nox makes a claim it
cannot currently back — which is the one category the operating manual puts
above everything else, because an untrustworthy claim poisons every decision
downstream of it.

---

## The evidence, first

Baseline taken this session, so the numbers below are measured rather than
remembered:

- `npm test` — **1926 passed, 132 files**, green.
- Release `v0.8.3` publishes **13 assets**: `.dmg` ×2, `x64-setup.exe`,
  `.deb`, `.rpm`, three `.app.tar.gz`, their `.sig` files and `latest.json`.
  Tauri updater signing works today.
- Rust production code holds **2** `unwrap()`/`expect()` calls total
  (`http.rs`, `lib.rs`); the other 157 are inside `#[cfg(test)]`. The Rust
  layer is not the risk.

---

## 1. The packaged app cannot be verified, and the one record we have contradicts the source

**Priority: highest.** This is the last named 1.0 gate — *"Nothing in the
release notes says 'unverified'"* — and it is in the worst state of anything
here.

### Why

`.desktop-pass-report.md` is the only walk on record. Its own verdict line:

> 2 PASS (A1, C3) · 3 PARTIAL (A2, A3, B2) · 0 FAIL · **12 UNSEEN** · 2 bugs

Twelve of seventeen items were never seen. The walk was aborted by machine
contention — "most computer-use batches aborted with *user interrupt*" — not
by a decision about what mattered.

Worse than the coverage is the one confirmed finding:

> BUG-1 CONFIRMED — Changes view cannot be dismissed. The "Close" header
> button renders a hover state but clicking does nothing (5+ attempts) …
> Escape does nothing … Only escape found: restart the app.

**The source says otherwise.** `src/ui/DiffView.svelte:178` binds Close to
`ui.diffOpen.set(false)`, and `src/services/ui.ts:404-408` dismisses the diff
on Escape and returns focus to the editor. `git log -S` puts both in `7302527`
(2026-08-19) — *the day before the walk*. So either the walk's clicks were
never landing (which the abort log makes plausible), or there is a real defect
the code reading cannot see. **Nobody can tell which**, and that file is
**tracked and public**: the repository currently asserts a confirmed defect
against the shipped product that may not exist.

The pattern is not one bad session. Three of the last four `WORKLOG.md`
entries end on the same line — *the desktop build is unverified for all of
this*. And four installers ship while **only macOS has ever been walked**.

The root cause is not diligence. It is that verification is a manual human
ritual: not repeatable, not cheap, not runnable unattended. Anything with that
shape gets skipped, and the record is what skipping looks like.

### The fix

Make the packaged app drivable by a test.

- **Phase 0 — settle BUG-1 (hours, do first).** Build the Windows app, open
  Changes, click Close, press Escape. Confirm or refute. Then correct
  `.desktop-pass-report.md` or delete it. A public file asserting a possibly
  false defect is itself the bug.
- **Phase 2 — a WebDriver harness.** `tauri-driver` + WebdriverIO. Verified
  this session against the Tauri v2 docs: driven directly, **Windows and Linux
  only** — "macOS has no WKWebView driver tool available". The WebdriverIO
  service's *embedded* WebDriver server claims macOS as well; treat that as a
  spike, not a premise, because CrabNebula's cross-platform fork wants a paid
  key for the macOS path and a purchase is the operator's call.
  - Windows first. It is the operator's own platform, it has never been
    walked, and it is where the freshest code lives (see §5).
  - Linux second, in CI, where it runs unattended forever.
  - Port the 17-item walk script into it, so the twelve UNSEEN rows become
    assertions rather than intentions.
- **macOS keeps a manual script**, but a short one — only the surface that is
  genuinely Mac-only: the native menu, the overlay title bar, and the
  first-launch Gatekeeper behaviour. Shrinking the ritual from seventeen items
  to four is what makes it actually get run.

**Risk:** a WebDriver harness against a real binary is the classic source of
flaky tests. Mitigation is scope — assert on text and state, never on
geometry, exactly as `tests/support/jsdom-layout.ts` already forbids.

---

## 2. When Nox fails in someone's hands, it leaves nothing behind

**Priority: high, and schedule it before §1's harness** — a walk that finds a
bug and produces no artifact is half a walk.

### Why

There is **no logging anywhere in the product**. `src-tauri/Cargo.toml` has no
`log`, no `tracing`, no `tauri-plugin-log`. No log file is written. The app's
own source admits the consequence at `src/app.ts:764`:

> There is no devtools console in the release webview, so without this those
> genuinely vanish.

"This" is the `unhandledrejection` backstop at `app.ts:779` — and it is only
half the pair. **There is no `window.onerror`**, verified by grep: nothing in
`src/` registers an `'error'` listener on the window. So a synchronous throw —
in a Svelte effect, an event handler, a CodeMirror extension — produces
*nothing at all*. No toast, no log, no console. The rejection half at least
shows "Something went wrong".

The eight `console.error` calls in the codebase write to a console no user
will ever open.

The consequence for a public repo publishing releases: a bug report can only
ever be prose. And it makes every other item here harder to close.

### The fix

- **Complete the backstop.** Add the `'error'` listener beside the
  `unhandledrejection` one in `#installRejectionBackstop`, sharing
  `#reportFailure` so the de-duplication by error identity still applies.
- **A log sink through `Platform`.** Not `@tauri-apps/*` from a service —
  rule 1 of `CLAUDE.md` is that `Platform` is the only door to the OS, so this
  is a new `Platform` method implemented in `tauri.ts` **and** `memory.ts`.
  Rolling file, capped size, in the OS app-log directory.
- **`Help: Copy Diagnostics`** — version, OS, configured servers, the last N
  log lines, assembled for pasting into an issue. **With redaction**: absolute
  paths are user data and this repo is public.
- **Rust side:** `tracing` on the failure paths that currently return an
  opaque `Err` to a toast — spawn, watcher, git.

**Design gate:** failure paths only. Nothing per-keystroke, per-scroll or
per-cursor. Logging is exactly the kind of well-meaning addition that
`CONTRIBUTING.md:65-69` exists to stop.

---

## 3. One LSP seam has zero callers, and four features wait on it

**Priority: high.** The worklog already named this "the highest-leverage piece
of LSP work left". Re-verified this session and it is still true.

### Why

`JsonRpcTransport.onRequest` is defined at
`src/services/lsp/transport.ts:97`. Its **only caller in the entire
repository** is `tests/lsp-transport.test.ts:124`. Nothing in `src/` ever
registers a handler.

`#answer` does the right thing with an unhandled request — it replies
MethodNotFound rather than letting the server stall, and says so in a comment.
That is correct, and it is also why this is invisible: the failure mode is
**silent degradation**, not a hang.

Four things sit behind that one seam:

| Waiting on it | What the user sees today |
|---|---|
| `workspace/executeCommand` → `workspace/applyEdit` | A code action that is a server *command* is listed and disabled. Honest, but it reads as Nox's limitation — which it is. |
| `workspace/configuration` | **pyright, gopls and rust-analyzer all ask at startup** and silently fall back to defaults. |
| `client/registerCapability` | Dynamic registration — how rust-analyzer and gopls ask to watch files. They never get to. |
| `$/progress` | rust-analyzer indexes for 30 s+ with no indication it is working. Looks hung. |

So the 1.0 bar **"Language intelligence is complete" — marked ✅ — is true for
tsserver and degrades for the three largest non-JavaScript ecosystems.** That
puts this in the same category as §1: a claim the product cannot back.

### The fix

Register the four handlers, in dependency order: `workspace/configuration` →
`client/registerCapability` → `applyEdit`/`executeCommand` → `$/progress`.

One decision has to be made rather than discovered, and the debt table already
flags it: **may a server-named command write to buffers unprompted?** The
answer consistent with what is already built is the rule code actions use —
reach is what decides, not trust. One file at the caret applies directly; more
than one file stages in the review panel. Using the same rule twice is the
argument for it.

---

## 4. "Fast" is the product's first word and nothing measures it

**Priority: medium-high.** Lower cost-of-error than the three above, but it
guards the one thing users notice most.

### Why

`CLAUDE.md` line 3 opens: *"A fast, dark, keyboard-first text editor."*

There are **1926 tests and zero benchmarks.** No `bench` script in
`package.json`; the only two `bench(` matches in the repo are fixture text
inside `src/platform/demo-workspace.ts`. The rule that protects the claim —
*nothing new on the typing path* — is enforced **by review alone**. Nothing
lints it and nothing measures it.

Two thresholds already in the code were chosen without a number behind them:

- `MAX_FILE_BYTES = 64 * 1024 * 1024` (`workspace.ts:93`). A 64 MB file
  crosses the IPC boundary **as a JSON string** and then becomes a CodeMirror
  document. Nobody has measured what that costs. The guard exists, which is
  the important half; whether 64 MB is the right number is unknown.
- `EXACT_DIRTY_LIMIT = 2_000_000` (`workspace.ts:90`), above which dirty
  tracking degrades to a change counter — and the known-debt table already
  records the visible consequence (undo-to-saved leaves the tab dirty).

The risk has a specific shape: **a typing-latency regression is invisible to
every test that exists and would ship.**

### The fix

- A `vitest bench` suite over the pure layers that *can* run headless — the
  diff engine, `computeReplacements`, the fold/symbol walk, `menu-placement`,
  search result assembly. These are where an accidental O(n²) actually lands,
  and they need no view.
- The typing path proper needs a real `EditorView`, so **that half is gated on
  §1's harness.** State the dependency rather than pretending a jsdom test
  covers it — `tests/support/jsdom-layout.ts` says plainly what zero geometry
  forbids claiming.
- Put a real number under the two thresholds above and either confirm or move
  them.
- **Do not gate CI on wall-clock.** Shared runners are too noisy for that to
  mean anything. Record, compare, and fail only on a large regression.

---

## 5. Four installers ship; three have never been run by anyone

**Priority: medium — and the expensive half is not mine to buy.**

### Why

Distribution works better than expected: `v0.8.3` carries all four platforms,
`latest.json`, and `.sig` files. **Tauri updater signing is done.**

What is not done is **OS** code signing, and the two are unrelated:

- **macOS** shows *"damaged"* on first launch and the fix is a terminal
  command (`xattr -dr`). The workflow half is built and merged in #105 — six
  secrets and a guard that refuses a half-present configuration, because
  signing without notarizing still stops at Gatekeeper while the release notes
  would claim otherwise. What remains is enrolment and the keychain.
- **Windows** shows SmartScreen. Deferred by decision, and correctly: an OV
  certificate buys nothing on day one because reputation accrues with
  downloads, and an EV one needs hardware key storage.

Both are **purchases, and therefore the operator's** — stop-list item 4. Not
mine to originate.

What *is* mine:

- Off macOS there is still **no native menu**: `menu.rs` early-returns
  `Ok(())`. The in-window bar that stands in for it is **three days old** and
  has already produced two defects — `7389643` (the click-away layer covering
  the bar's own titles) and `7c119cc` (the bar pushing the window controls out
  of a 560 px viewport). That is the freshest code in the product sitting on
  the least-verified platform.
- **Windows and Linux have never been walked at all.**
- Nobody has rehearsed an actual update — 0.8.3 → 0.8.4 — on any platform.

### The fix

Mostly §1's harness pointed at Windows and Linux. Specifically mine: a Windows
install-and-update rehearsal against a real published release, and hardening
the in-window menu bar now that it is load-bearing on two platforms. The
certificates stay with the operator.

---

## Order of work

Ties broken toward the smaller change; sequenced by what each unblocks.

| # | Work | Why here | Size |
|---|---|---|---|
| 0 | Adjudicate BUG-1; fix or delete the public report | An untrustworthy public claim, and it is hours | hours |
| 1 | Diagnostics: `window.onerror`, log sink via `Platform`, Copy Diagnostics | Every later phase produces evidence instead of prose | 1 session |
| 2 | WebDriver harness — Windows, then Linux in CI | Closes the last 1.0 gate and unblocks §4's other half | 2–3 sessions |
| 3 | The `onRequest` seam — four handlers | One seam, four features, and a ✅ that is currently overstated | 1–2 sessions |
| 4 | Benchmarks — pure layers now, typing path on the harness | Guards the product's first adjective | 1 session |
| 5 | Windows install/update rehearsal; menu-bar hardening | Rides on phase 2 | 1 session |

**Blocked and not mine:** the Apple and Windows certificates (stop-list 4 —
spending money), and the macOS leg of the WebDriver harness if it turns out to
need CrabNebula's paid key.

**What would change this order:** if BUG-1 reproduces in phase 0, it is a real
defect in shipped code and jumps the queue ahead of everything else. If the
WebdriverIO embedded server turns out to drive macOS for free, phase 2 grows a
third platform and phase 5 shrinks.

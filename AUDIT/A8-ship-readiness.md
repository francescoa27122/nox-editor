# A8 Ship Readiness

## Summary

Nox packages and ships better than most one-person Tauri projects: five bundle targets build in a four-leg release matrix, the updater is minisign-signed with a real key ceremony behind it (every v0.11.0 asset on the live release carries a `.sig` and a `latest.json`), the release gate refuses a tag whose four version sources disagree, and eleven required checks with `enforce_admins` are live on `main` (verified against the GitHub API, not the comments in `ci.yml`). The docs are unusually honest and the unit suite is behaviour-shaped rather than padding. The strongest finding is not in the tree but on the remote: a `v0.12.0` tag was pushed to the public repository at the audited commit while every version file reads `0.11.0`, its release run failed at the gate in 15 seconds, and the tag is still there, so `git describe` lies and the next 0.12.0 release is blocked until it is moved. Behind that: no host-side crash capture at all (a Rust panic in a release build aborts with nothing written anywhere), no `Open with` or command-line path so the installer registers nothing for a text editor to open, no security disclosure route, and no third-party licence attribution in a bundle that ships CodeMirror, xterm, Svelte and about a hundred crates. Sub-score 5 / 8: a stranger hits friction installing (the `xattr` command, SmartScreen) and gets nothing back when the host crashes.

## Sub-score

5 / 8

Justification: the rubric's 6 to 7 band names unsigned builds and missing crash reporting as the gaps of a shippable beta, and both are present (A8-002, and the unsigned state the README already admits). What pulls it below that band is the dangling broken tag on the public remote (A8-001), an editor that cannot be handed a file by the OS or a shell (A8-003), no disclosure contact for a product whose security argument is a chapter of ARCHITECTURE.md (A8-004), and bundles that ship MIT dependencies without their notices (A8-005). What keeps it from 4: installers are correct and driven on all three platforms on every PR, the updater is signed and verified end to end, the privacy claim is true, and the docs are accurate almost everywhere they were spot-checked.

## Findings

```
ID:          A8-001
Lane:        Ship readiness
Severity:    P1
Title:       A v0.12.0 tag is on the public remote at a commit whose version files say 0.11.0, and its release run failed at the gate
Location:    .github/workflows/release.yml:33-58; src-tauri/tauri.conf.json:4; package.json:3; src-tauri/Cargo.toml:3
Evidence:    `git for-each-ref refs/tags/v0.12.0` prints `v0.12.0 2026-08-29 16:31:27 -0500 commit`, a lightweight
             tag on 54cece6e, the audited SHA. `git ls-remote --tags origin` lists
             `54cece6e... refs/tags/v0.12.0`, so it is published. `git show v0.12.0:package.json` and
             `:src-tauri/tauri.conf.json` both read `"version": "0.11.0"`. `gh run list --workflow=release.yml`
             shows `completed failure ... Release v0.12.0 push 33278252801 15s 2026-08-29T22:18:22Z`, which is
             the gate step at release.yml:50-58 exiting 1 ("Tag $GITHUB_REF_NAME does not match the configured
             version"). There is no `## [0.12.0]` section in CHANGELOG.md (sections end at `## [0.11.0]`,
             CHANGELOG.md:29) and README §Status opens `**v0.11.**` (README.md:260). `gh release list` shows no
             0.12.0 release. WORKLOG.md has no entry mentioning 0.12.0 at all; its newest entry (2026-08-29)
             records only 0.11.0 being tagged "on the operator's word".
Impact:      Anyone cloning the public repo gets `git describe` = `v0.12.0` for a tree that builds 0.11.0, and the
             Actions tab shows a failed Release run as the newest thing. When 0.12.0 is really cut, pushing the
             tag does nothing (it already exists) and the fix is to delete and re-push a published tag, which the
             operating manual's "never force-push over published history" line makes a stated exception rather
             than a routine step. The gate did its job; the residue is the tag.
Fix sketch:  Delete the remote tag (`git push origin :refs/tags/v0.12.0`) and the local one, and record in
             WORKLOG.md that it was pushed by mistake and why. Consider a gate step that, on failure, prints the
             exact delete command so the residue is never left.
Confidence:  Confirmed
Risk class:  Gated (touches a published ref; operator's call under the manual's history rule)
```

```
ID:          A8-002
Lane:        Ship readiness
Severity:    P2
Title:       A Rust-side panic in a release build aborts the process and writes nothing anywhere
Location:    src-tauri/Cargo.toml:78-84; src-tauri/src/main.rs:1-6; src-tauri/src/lib.rs:24-183; src/services/diagnostics.ts:1-16; src/app.ts:269-275
Evidence:    `[profile.release]` sets `panic = "abort"` and `strip = true` (Cargo.toml:82-83). `main.rs:2` is
             `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`, so a release build on Windows
             has no stderr. `grep -n "set_hook\|tracing\|env_logger\|plugin_log" src-tauri/src/*.rs` returns
             nothing; `lib.rs` registers `dialog`, `updater` and `process` plugins only (lib.rs:118-120) and the
             only diagnostic output in the crate is four `eprintln!` calls for `--geometry`. The renderer's
             `diagnostics.log` is fed solely from notifications: `app.ts:275`
             `this.diagnostics.record(notification.kind, notification.message, notification.detail)`, and
             diagnostics.ts:11-15 says so ("recording is driven by notifications"). The updater, watcher, PTY,
             LSP supervisor, git and search all run in this process.
Impact:      A panic in `watcher.rs`, `pty.rs`, `lsp.rs` or a Tauri internal takes the window down instantly. The
             user sees the app vanish; `diagnostics.log` holds nothing because the renderer died with it; Copy
             Diagnostics on relaunch reports "(nothing recorded)". A bug report for the single worst failure class
             can only be prose, which is the exact gap diagnostics.ts:5-9 says the file was created to close for
             the renderer. If the WebView process (WebView2, WebKitGTK) dies rather than the host, nothing handles
             that either: no `on_window_event` or webview-crash hook is registered (Speculative on that half; the
             hook absence is Confirmed).
Fix sketch:  Install `std::panic::set_hook` in `run()` before the builder that appends the panic message and
             location to `<app_config_dir>/diagnostics.log` (or a sibling `host.log`) using the same 400-line cap,
             then aborts. Have `DiagnosticsService.start()` carry those lines like it carries earlier sessions.
             Optionally switch release to `panic = "unwind"` only if the hook needs it; the hook runs before abort
             either way.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A8-003
Lane:        Ship readiness
Severity:    P2
Title:       The app cannot be handed a file: no argv path, no Open With, no file associations in any installer
Location:    src-tauri/src/lib.rs:57-59; src-tauri/src/geometry.rs:79-96; src-tauri/tauri.conf.json:45-58
Evidence:    The only reading of `std::env::args()` in the crate is `geometry::geometry_from_args(std::env::args())`
             (lib.rs:58), and that function scans for `--geometry` only and returns `None` for everything else
             (geometry.rs:84-95). `grep -rn "fileAssociations\|plugin-cli\|deep-link\|single-instance" src-tauri/`
             returns nothing; the `bundle` block in tauri.conf.json:45-58 declares no `fileAssociations`. The
             `dragDropEnabled: true` window flag (tauri.conf.json:26) is the only OS-to-editor file path.
             ROADMAP.md does not list file associations or a command-line entry anywhere (grep for
             "file association", "command line", "open with", "argv" returns nothing outside the git row).
Impact:      `nox notes.txt` from a shell opens the last session and ignores the argument. Right-click, Open With,
             Nox on any platform launches the editor and the file never appears. Double-clicking a `.md` cannot
             pick Nox because no installer registers it. A second launch opens a second instance writing the same
             `session.json` (the e2e config at e2e/wdio.conf.js:98-101 already notes two instances would be two
             editors writing one session). For a text editor this is the first thing a stranger tries after
             installing.
Fix sketch:  Parse positional args in `run()` (and macOS `RunEvent::Opened` for Finder drops) and emit them to
             the renderer as `file.open` after boot; add `bundle.fileAssociations` for the extensions in
             `core/languages.ts`; add `tauri-plugin-single-instance` so a second launch forwards its argv.
Confidence:  Confirmed
Risk class:  Gated (installer behaviour and a new IPC event)
```

```
ID:          A8-004
Lane:        Ship readiness
Severity:    P2
Title:       No SECURITY.md, no disclosure contact, no issue templates, for a product whose pitch is a security boundary
Location:    repository root; .github/ (only actions/linux-build-deps, workflows/ci.yml, workflows/release.yml); README.md:261-264
Evidence:    `ls SECURITY.md CODE_OF_CONDUCT.md .github/ISSUE_TEMPLATE .github/dependabot.yml` reports every one
             missing. `find .github -type f` lists exactly three files. README.md:261-262 tells users to "Open an
             issue if you hit one" with no template; nothing anywhere says where to send a vulnerability rather
             than a bug. The README's central claim (README.md:109-127) is that agents cannot touch files and the
             loopback rule "lives in the part of the app a web page has no way to reach"; ARCHITECTURE.md argues
             the HTTP redirect policy, the CSP and the permission model at length. A reader who finds a hole in
             any of that has only a public issue tracker to report it to.
Impact:      A responsible reporter either posts an exploit publicly or gives up. GitHub's private vulnerability
             reporting is off by default and its presence is not verifiable from the tree. Issue reports arrive
             without the Copy Diagnostics output the README asks for because nothing prompts for it.
Fix sketch:  Add `SECURITY.md` naming a contact (a noreply-routed address or GitHub private reporting), the
             supported versions (latest release only), and what is in scope (the loopback boundary, plugin and
             agent permission enforcement). Add one bug-report issue template whose first field is the Copy
             Diagnostics paste.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A8-005
Lane:        Ship readiness
Severity:    P2
Title:       Third-party licences are not attributed anywhere in the app or the bundles
Location:    src-tauri/tauri.conf.json:45-58; package.json:32-60; src-tauri/Cargo.toml:16-60; src/services/menu.ts:83
Evidence:    The bundle block declares no `licenseFile` and no `resources`; `ls src-tauri/LICENSE* THIRD* NOTICE*`
             finds nothing; `grep -rn -i "third.party\|licen[cs]es" src/` matches only comments about LSP servers
             and plugins. The About entry is macOS's predefined item (`predefined('about', 'About Nox')`,
             menu.ts:83) with no custom text. The shipped bundle contains `@codemirror/*` (MIT), `@xterm/xterm`
             (MIT), Svelte (MIT), `@tauri-apps/api` (MIT/Apache-2.0), `@lezer/*` (MIT) and the Rust dependency
             graph (`encoding_rs` Apache/MIT, `notify` CC0/Artistic-2.0, `portable-pty` MIT, `reqwest` MIT/Apache,
             `ignore` MIT/Unlicense, `trash` MIT). MIT's one condition is that the copyright and permission
             notice "shall be included in all copies or substantial portions of the Software"; a minified
             `editor-engine-*.js` is a substantial portion of CodeMirror.
Impact:      Every release from v0.1.0 has distributed MIT-licensed code without its notices. Low practical risk
             from the upstream authors; real risk if Nox is ever packaged by a distribution (Debian and Fedora
             both check), and it is the first thing a corporate user's compliance scan flags.
Fix sketch:  Generate `THIRD-PARTY-NOTICES.md` at build time (`license-checker` for npm, `cargo about` or
             `cargo license` for crates), include it via `bundle.resources`, point `bundle.licenseFile` at
             `LICENSE` so the NSIS installer shows it, and surface it from a Settings footer link or an
             `app.showLicenses` command.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A8-006
Lane:        Ship readiness
Severity:    P2
Title:       minimumSystemVersion 10.15 declares support for a WebKit that drops twenty of the app's colour declarations
Location:    src-tauri/tauri.conf.json:55-57; src/ui/DiffView.svelte:372-381; src/ui/ReviewPanel.svelte:252-257; src/ui/SearchPanel.svelte:755-756,1035-1052; src/ui/ConfirmDialog.svelte:180; src/ui/Toasts.svelte:111; src/styles/base.css:236-241; src/ui/Welcome.svelte:128-134
Evidence:    `"macOS": { "minimumSystemVersion": "10.15" }` (tauri.conf.json:56). `grep -rn "color-mix(" src/`
             returns 20 declarations, all `color-mix(in srgb, var(--nox-...) N%, transparent)`. Every one is the
             whole value of a `background`, `border`, `border-color` or `text-decoration-color` property, so an
             engine that does not parse `color-mix()` drops the entire declaration. `color-mix()` shipped in
             Safari 16.2, and the newest Safari on macOS 10.15 is 15.6.1 (stable general knowledge, not
             re-derived from the tree). `vite.config.ts:50` targets `es2022`, which Safari 15 handles, so the JS
             side is fine; only the CSS degrades.
Impact:      On macOS 10.15, 11 and 12 (Catalina through Monterey) the diff view's added and removed line
             backgrounds vanish (DiffView.svelte:372-376), the review panel's hunk colouring vanishes
             (ReviewPanel.svelte:252-257), search-and-replace previews lose their before/after tint
             (SearchPanel.svelte:1035-1052), the destructive button in confirm dialogs loses its red wash
             (ConfirmDialog.svelte:180, base.css:236-241), and the error toast loses its border. The review
             panel is the product's headline feature (README.md:104-115), and on those systems it draws a diff
             with no colour distinguishing add from remove.
Fix sketch:  Either raise `minimumSystemVersion` to `13.0` and say so in README's Try it section, or keep 10.15
             and give each `color-mix()` a preceding solid-colour fallback declaration (or a pre-mixed token in
             `tokens.css`, which is where tokens.css:115 already discusses writing one).
Confidence:  Likely (the WebKit version boundary is general knowledge; the declaration shapes are Confirmed)
Risk class:  Safe
```

```
ID:          A8-007
Lane:        Ship readiness
Severity:    P3
Title:       README does not state the one outbound network call the app makes by default, and one sentence contradicts it
Location:    README.md:121-127; src/services/updates.ts:28,66-78; src/services/config/schema.ts:149-154; src-tauri/tauri.conf.json:37-45
Evidence:    README.md:122 says "no account, no API key, and no telemetry" and README.md:124 says "Nox will only
             talk to your own machine." Both sit under "Setting up a model", but the second is stated about Nox,
             not the model. `updates.ts:73-77` fires `checkNow()` 10 s after launch when
             `workbench.checkForUpdates` is true, and schema.ts:149 defaults it to `true`. The request goes to
             `https://github.com/francescoa27122/nox-editor/releases/latest/download/latest.json`
             (tauri.conf.json:41). The only place this is described as the app's sole network call is a design
             spec (docs/superpowers/specs/2026-08-19-auto-updater-design.md:66-68: "no version pings beyond the
             one JSON fetch the check itself is"), which no user reads. The README's Status paragraph mentions
             "Nox can update itself" (README.md:280) without saying it checks on launch.
             What is good about the call: the endpoint URL is static, so the request carries no version or
             target in the URL; the loopback-only `reqwest` client in `http.rs` is a separate client and the
             updater's own headers were not re-derived here (inference, not verified).
Impact:      A privacy-conscious user reading "will only talk to your own machine" is told something false;
             their firewall shows a connection to github.com ten seconds after first launch. The statement that
             is true (no telemetry) is undermined by the one that is not.
Fix sketch:  Add three sentences to README under Try it or Status: Nox makes one network request, to GitHub's
             release feed, ten seconds after launch, to learn whether a newer version exists; it sends nothing
             about you; turn it off with Check for Updates on Launch in Settings. Reword README.md:124 to "the
             model integration will only talk to your own machine."
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A8-008
Lane:        Ship readiness
Severity:    P3
Title:       v0.9.1 was never published; it sits as a draft while CHANGELOG records it as released
Location:    CHANGELOG.md:262-274; WORKLOG.md:2017
Evidence:    `gh release list` prints `Nox v0.9.1  Draft  v0.9.1  2026-08-24T08:10:01Z` between published
             v0.10.0 and v0.9.0. `gh run list --workflow=release.yml` shows the v0.9.1 run succeeded
             (`33228687044` is 0.11.0; the 0.9.1 run is `32678927050 success`). CHANGELOG.md:262 reads
             `## [0.9.1] - 2026-08-24` with a dated Fixed entry. WORKLOG.md:2017 says "Next: the operator
             publishes the 0.9.1 draft", and no later entry records it happening.
Impact:      Users on 0.9.0 never received 0.9.1's fix through the updater (the draft is invisible to
             `releases/latest`); they got it with 0.10.0 two days later, so the practical cost was small. The
             changelog and the releases page disagree about what shipped, and the dangling draft is a second
             piece of release-page residue beside A8-001.
Fix sketch:  Either publish the draft as a historical release or delete it and annotate the CHANGELOG entry
             "(folded into 0.10.0; never published on its own)".
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A8-009
Lane:        Ship readiness
Severity:    P3
Title:       The release workflow never checks Cargo.lock, so a tag off main can ship from a silently rewritten lockfile
Location:    .github/workflows/release.yml:124-126,328-347; .github/workflows/ci.yml:242-245
Evidence:    The gate runs `npm ci`, `npm run check`, `npm test` (release.yml:124-126) and no cargo command. The
             build step is `tauri-apps/tauri-action@v1` with `args: ${{ matrix.args }} ...` (release.yml:347),
             which passes no `--locked`. The CI job has the check ("Check the lockfile is current",
             ci.yml:242-245, `cargo metadata --format-version 1 --locked`) and its comment records that the
             lock was stale for weeks without anything failing. The release workflow triggers on any `v*` tag
             push (release.yml:3-5), not only on tags reachable from `main`.
Impact:      Every release so far was tagged on a merged main commit that CI had already locked-checked, so the
             hole is unexercised. A tag on a branch commit, or on main after a dependency bump merged without
             a lock change, builds four installers from a resolution nobody committed.
Fix sketch:  Add the same `cargo metadata --format-version 1 --locked` step to the gate (it needs the stable
             toolchain, ten seconds), and pass `--locked` through to the build via `args`.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A8-010
Lane:        Ship readiness
Severity:    P3
Title:       README understates the download size and e2e/README.md is stale on two facts
Location:    README.md:26,340; e2e/README.md:22-24,68-69; e2e/wdio.conf.js:15-16
Evidence:    README.md:26 "It is also about 4 MB" and README.md:340 "a distributable, ~4 MB on macOS". The live
             v0.11.0 assets (GitHub API): `Nox_0.11.0_aarch64.dmg` 5,194,825 bytes, `Nox_0.11.0_x64.dmg`
             5,380,572, `Nox_0.11.0_amd64.deb` 5,364,762, `Nox_0.11.0_x64-setup.exe` 4,431,942. Only the
             Windows installer rounds to 4 MB. e2e/README.md:22-23 says the harness "Needs a Rust toolchain,
             which the development machine does not have", and wdio.conf.js:15 repeats it; CLAUDE.md and the
             memory file both record cargo installed on this PC since 2026-08-29, and `cargo test` ran for the
             orientation. e2e/README.md:68 says "All three run the same four specs"; `e2e/specs/` holds three
             files with eight `it()` blocks.
Impact:      Small: a reader doing the arithmetic finds the README off by a third, and a contributor reads that
             they cannot run the e2e suite locally when they can.
Fix sketch:  Change "about 4 MB" to "about 5 MB" and re-read it at the next tag as part of the Cutting a release
             checklist; rewrite e2e/README.md:22-24 to "Needs a Rust toolchain" and update the spec count.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A8-011
Lane:        Ship readiness
Severity:    P3
Title:       CI hygiene gaps: no permissions block, actions pinned by major tag, no dependency bot, MSRV never built
Location:    .github/workflows/ci.yml:1-14,43-49; src-tauri/Cargo.toml:6; .github/ (no dependabot.yml)
Evidence:    `ci.yml` has no top-level or job-level `permissions:` (release.yml:8-9 does), so the `GITHUB_TOKEN`
             on a `pull_request` run gets the repository's default scope. Every action is `@v7`, `@v6`, `@v2`,
             `@stable`, `@v1` (ci.yml:43,45,126,217,219; release.yml:23,24,209,228,232,328), none by commit SHA.
             `.github/dependabot.yml` and `renovate.json` are absent. `Cargo.toml:6` declares
             `rust-version = "1.77"` but both workflows install `dtolnay/rust-toolchain@stable` only, so the
             MSRV claim is never compiled. No coverage tool is configured, which matches CONTRIBUTING.md:143
             ("Coverage percentage is not a goal") and is not counted against it.
Impact:      A compromised or force-moved action tag runs arbitrary code with whatever the default token
             allows on every PR. The `rust-version` line is a promise no build has checked. Dependency drift
             (`npm audit` already shows three moderate dev-dep advisories per the orientation) is found only
             when someone looks.
Fix sketch:  Add `permissions: contents: read` at the top of ci.yml; pin actions to SHAs with a version
             comment; add a minimal dependabot.yml for npm, cargo and github-actions on a monthly cadence; either
             add a `cargo +1.77 check` leg or drop the `rust-version` line.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A8-012
Lane:        Ship readiness
Severity:    P3
Title:       bundle.copyright is an empty string, so every installer and Info.plist ships with no copyright line
Location:    src-tauri/tauri.conf.json:51; LICENSE:3
Evidence:    `"copyright": ""` (tauri.conf.json:51). LICENSE:3 is `Copyright (c) 2026 Francesco Assalone`.
             Tauri writes this field to `NSHumanReadableCopyright` in the macOS Info.plist, the `LegalCopyright`
             version-info resource on Windows, and the deb/rpm control metadata.
Impact:      Get Info on the .app and Properties on nox.exe show a blank copyright; the rpm's `%license` and
             the deb's `copyright` file are as empty as the field. Cosmetic, but it is the field a user checks
             when an unsigned binary asks them to trust it.
Fix sketch:  Set it to the LICENSE line, and add `bundle.licenseFile: "../LICENSE"` so the NSIS installer shows
             the licence page.
Confidence:  Confirmed
Risk class:  Safe
```

### Known-debt rows assessed

- **"Diagnostic redaction is case-sensitive"** (ARCHITECTURE.md:2678). Accurate, and the severity is right: `redactHome` (diagnostics.ts:63-77) does exactly what the row says, and `#environment()` (app.ts:1003-1012) adds no path to the header, so the only leak route is a hand-typed path of differing case.
- **"The packaged app is verified, but not its native chrome"** (ARCHITECTURE.md:2657). Accurate. `.desktop-pass-report.md` records three Windows walks of the release bundle on 2026-08-29 (behaviour from disk, then pixels over CDP), the e2e matrix drives the packaged binary on all three platforms, and the remainder named in the row (menu bar, native dialogs, terminal, real repo) is exactly what neither can reach. Linux has no verification beyond the e2e job; that is worth one more word in the row.

## What is good

- **The release gate refuses the right things and did so on its first real use.** `release.yml:33-64` holds three version files to each other and to the tag; `:75-93` refuses a README whose Status series is stale; `:100-122` refuses a tag with no CHANGELOG section and makes that section the release body. WORKLOG.md:238-250 records the README gate catching a real stale paragraph at 0.11.0, and the failed v0.12.0 run (A8-001) is the gate working, not failing.
- **Signed updates are real, not configured-and-hoped.** The v0.11.0 release carries `latest.json` (17,984 bytes) and a `.sig` beside every installer; the pubkey in `tauri.conf.json:39` decodes to minisign key `A40CD806C398B1A7`, the id WORKLOG.md:3358 records from the ceremony. `release.yml:244-262` refuses a build where the private key is set and the pubkey is empty.
- **Consent around updates is exact.** `updates.ts:7-15` states the rule (the background path is a check whose only output is a toast; download, install and restart hang off one labelled button), and `update-service.test.ts:34-60` pins the delay, the opt-out read at fire time, and cancellation. The install flushes session and settings before the platform moves anything (`updates.ts:163-168`), so the Windows installer closing the app cannot cost a keystroke.
- **The Apple signing guard learned from a real failure.** `release.yml:171-193` explains why the six `APPLE_*` secrets are not job-level env (an empty-but-defined secret put every macOS build into signing mode and both died on `security import`), and `:275-326` refuses signing without notarization because that ships a Gatekeeper stop the release notes would deny.
- **Renderer failure capture is thorough and tested against its own history.** `app.ts:1031-1101` covers both `unhandledrejection` and synchronous `error`, filters the ResizeObserver notice on `error == null` after a `=== undefined` bug that shipped a red toast on first launch for a release, and `tests/failure-reporting.test.ts:171-223` dispatches a real `ErrorEvent` so the test cannot pass on a synthetic shape again.
- **`diagnostics.log` is bounded, redacted on the way in, and never a second failure.** `diagnostics.ts:38` caps at 400 lines; `:118-141` reads the home directory before anything is recorded; `:198-214` swallows its own write failure with the reason stated. Copy Diagnostics (`app.ts:4511-4527`) puts version, target, user agent, server count and workspace state above the log.
- **Config-directory write failures are surfaced, not swallowed.** `tests/write-failures.test.ts` drives settings, keybindings and session writes against a platform that throws "disk is full" and asserts each publishes on `error`, the value stays live, and a backup that did not land is retried on the next save. The README's "does not lose your work" claim is tested at its weakest point.
- **First run is guided.** `Welcome.svelte:38-51` builds the Start list from workspace state so the primary action is Open folder with nothing open and Go to file with a folder open; recent folders are listed; the keyboard column shows live chords from the keymap rather than hardcoded strings. `config_path` (fs.rs:421-436) creates the config directory on first touch, and `config.load()` (config/index.ts:229-252), `session.#read()` (session.ts:439-448) and `diagnostics.start()` all tolerate its absence or unreadability without refusing to boot.
- **The e2e suite drives what nothing else can.** `smoke.e2e.js:121-130` asserts Escape closes the palette in the packaged app, a keystroke the manual walk provably could not deliver; `walk.e2e.js:72-99` asserts focus lands on a safe choice in the destructive confirm; `menu-bar.e2e.js:77-95` pins the click-away-layer regression by `aria-expanded` rather than geometry. All three legs are required checks (verified via the branch-protection API: 11 contexts, `strict: true`, `enforce_admins: true`).
- **Unit tests assert behaviour.** Ten sampled files (`diagnostics`, `update-service`, `failure-reporting`, `write-failures`, `welcome`, `fileops`, `encoding-round-trip`, `settings-version`, `complexity`, `session-backups`) have 128 `it()` blocks and 269 `expect()` calls, five weak assertions in total, no snapshots, no `.skip`, `.todo` or `.only` anywhere under `tests/` (the one `this.skip()` is the macOS branch of the menu-bar e2e spec, which is correct). `npm test` at the audited SHA: 169 files, 2439 passed, 0 skipped, 18.0 s.
- **Rust coverage is where it matters.** `fs.rs` has 12 tests including `replaces_an_existing_file`, `config_writes_replace_atomically_and_leave_no_litter` and `preserves_permissions`, and the CI rust matrix runs them on Windows so the rename-over-existing path is exercised there. `git.rs` has 29 tests against real repositories including the argv-fixed refusal paths; `encoding.rs` 17; `http.rs` has `only_loopback_hosts_are_allowed`, `only_http_schemes_are_allowed` and a tokio test that stands up a redirecting server and asserts the body is not replayed to it.
- **The README's checkable claims check.** All eleven rows of the keybinding table (README.md:222-234) match `app.ts:4545-4583`; the test count floor is held by `tests/release-readme.test.ts:121-127`; the Status series line is read by `scripts/readme-series.mjs` and mirrored in a unit test; the CHANGELOG runs unbroken from `[0.1.0]` to `[0.11.0]` with an `[Unreleased]` section. The README is honest about being unsigned on both platforms and gives the exact workaround.
- **CONTRIBUTING.md is sufficient for a stranger.** Setup, the three verification commands, the five rules with the reason for each, where tests go, what not to test, and a Cutting a release checklist that names the gate's limits.

## Not checked

- **Whether the updater's HTTP request carries identifying headers.** The endpoint URL is static, so nothing about the installed version is in the URL; what `tauri-plugin-updater` puts in `User-Agent` or `Accept` was not re-derived from the crate source. Labelled as inference in A8-007.
- **"Starts instantly."** No cold-start measurement was taken on the packaged app; the browser build was not timed either.
- **Linux beyond CI.** No record in WORKLOG.md or `.desktop-pass-report.md` of the `.deb` or `.rpm` being installed on a real machine; the e2e job drives a `--no-bundle` debug binary under xvfb, not the installed package. The deb's dependency list was not extracted from the artifact; Tauri's bundler default (`libwebkit2gtk-4.1-0`, `libgtk-3-0`) is assumed from general knowledge.
- **The NSIS installer's per-user default.** Not read from the built installer; inferred from the absence of `bundle.windows.nsis.installMode` and from `.desktop-pass-report.md:134`, which found the installed 0.10.0 under `%LOCALAPPDATA%\nox\`, the per-user location.
- **`npm run test:editor` and `npm run test:stories`.** Not run in this lane; the orientation and the web CI leg cover them.
- **`cargo audit`.** Not installed on this machine, per the orientation.
- **The `latest.json` cross-matrix merge on a partial release.** With `fail-fast: false` and `releaseDraft: true`, a failed leg leaves that platform out of `latest.json`, which the updater maps to "no update" (`tauri.ts:363-370`). Reasoned from the workflow and the platform code; no partial release has happened to observe.

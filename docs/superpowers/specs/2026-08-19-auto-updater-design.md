# Auto-updater — design

The free half of the 1.0 "Installs like software" row: the app tells you
when a newer one exists, and installing it never needs the `xattr -dr`
ritual again. This is the first feature that replaces the running program
and the first that owns a signing key, so the spec leads with what it
will never do, and the build waits for a human read of exactly that
section.

Status: proposed 2026-08-19, **not yet built**. Everything named here was
read in the file it names before being written down. The Tauri specifics
come from three named sources: the Tauri v2 updater guide
(https://v2.tauri.app/plugin/updater/ — config keys, `tauri signer
generate`, the signing env vars, the JS API, the `latest.json` shape, the
capability permissions), the plugin's own error source
(`tauri-plugin-updater` `error.rs` on docs.rs — a `latest.json` missing
the current platform's key is an **error** from `check()`, not a null),
and the `tauri-apps/tauri-action` README (`uploadUpdaterJson` defaults to
true when the updater is configured).

## 0. The envelope — read this section first

1. **The private key never exists here.** It is not generated into the
   repo, never committed, never printed to a log — and never on this
   machine's checkout at all. It is born in the operator's own key
   ceremony (§8) and lives in two GitHub Actions secrets
   (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
   No task in the plan touches it; nothing in CI echoes it. Only the
   *public* key is committed, in `tauri.conf.json`, where it belongs.
2. **Nothing downloads or installs without a click.** The background
   work is a *check* — metadata only, one small JSON fetch. Its entire
   output is a notification whose action button says what it does:
   **Install and Restart**. That one click is the consent, and it covers
   download, signature verification, install and relaunch — which is why
   the label names all of it. There is no auto-install setting, and none
   arrives later.
3. **The renderer never talks to the network.** The updater lives behind
   the Platform seam (`src/platform/types.ts`): the renderer sees
   `UpdateInfo | null`, and the HTTP, the minisign verification and the
   file replacement all happen in the Rust plugin. The web and memory
   platforms report updates unavailable, so the browser target and the
   test suite are untouched by any of this.
4. **Absence is absence, never an error.** No signing key in CI → the
   release workflow builds installers and skips updater artifacts → no
   `latest.json` on the release → `check()` fails → the platform maps
   *every* check failure to null. A background check that finds nothing
   says nothing. A manual check says "No update found" — worded to cover
   both "you are current" and "the feed was unreachable", because the
   platform genuinely cannot tell them apart and the UI does not pretend
   to.
5. **Nothing blocks the typing path.** The launch check waits
   `UPDATE_CHECK_DELAY_MS` (10 s) after start, runs async, and its only
   UI is a toast. The download runs as a job (`jobs.ts`), off the main
   path like every other long-running thing.
6. **No work is lost.** Before install — not before relaunch, because on
   Windows the NSIS installer closes the app as part of installing — the
   service flushes what quit flushes: notes, settings, session. The
   session records unsaved work and restores it on next launch, the same
   no-prompt philosophy `app.ts`'s close handler documents. The restart
   is part of the one consented click, and it cannot cost you a keystroke.
7. **Verification is never weakened.** The plugin verifies each artifact
   against the committed public key before installing; there is no flag,
   setting or code path that skips it. If verification fails, the update
   fails, with the error shown.

Deliberately absent, permanently: delta updates, release channels or
beta tracks, and telemetry of any kind — no install counts, no version
pings beyond the one JSON fetch the check itself is.

## 1. What it is

- **A launch check**, behind `workbench.checkForUpdates` (boolean,
  default on), firing once, 10 s after start. Finding an update raises a
  sticky info toast — "Nox 0.5.0 is available" — with one action button,
  **Install and Restart** (`notifications.ts` supports action buttons;
  the toast is sticky via `timeout: 0` so a burst of routine toasts
  cannot evict it).
- **Check for Updates…** in the command palette (`app.checkForUpdates`,
  category **Application**), enabled once the service has started. A
  manual check that finds nothing answers with an info toast; one that
  finds an update raises the same toast as the launch check (dismissing
  the earlier copy first, so they never stack).
- **Install and Restart** flushes notes/settings/session, downloads and
  installs through a job titled "Updating to Nox 0.5.0" (progress in
  bytes when the feed declares a length), flushes again, and relaunches.
  A failure at any point is an error notification carrying the real
  message, and the update stays available for another try.
- **The version, visible at last.** Verified against
  `src/ui/SettingsPanel.svelte`: no current-version display exists
  anywhere in the renderer today (no `getVersion`, no version string
  outside `package.json`). It belongs in the Settings footer — "Nox
  0.4.3" beside the existing links — fed by a build-time
  `__APP_VERSION__` define from `package.json`, whose value the release
  gate already holds equal to `tauri.conf.json` and `Cargo.toml`.

## 2. How an update is offered — the release side

`.github/workflows/release.yml` today: a `gate` job holds the tag to the
three version files, then four matrix builds publish a **draft** release
through `tauri-apps/tauri-action@v1`. The updater fits into that shape
rather than replacing it:

- `bundle.createUpdaterArtifacts` is **not** set in `tauri.conf.json`.
  With it set, `tauri build` *fails* when `TAURI_SIGNING_PRIVATE_KEY` is
  absent — and a contributor's local build, and a keyless CI run, must
  keep producing installers. It lives in `src-tauri/updater.conf.json`,
  a two-line config the workflow merges in with `--config` **only when
  the secret is present**. Key absent → same release as today, plus
  nothing.
- With the key present, each platform build produces its updater
  artifact and signature, and `tauri-action` (its `uploadUpdaterJson`
  default) assembles and uploads `latest.json` onto the release,
  merging each matrix job's platform entry into it.
- The workflow also refuses the half-configured state: key present but
  `plugins.updater.pubkey` empty fails the build with instructions,
  because half a keypair signs updates nothing can verify.
- The endpoint is
  `https://github.com/francescoa27122/nox-editor/releases/latest/download/latest.json`
  — GitHub's alias for the newest **published, non-prerelease** release.
  The workflow drafts releases on purpose, and that habit becomes the
  offer mechanism for free: an update is offered to users at the moment
  the human publishes the draft, and never before.

Per platform, honestly:

| Platform | Updater artifact | What an update feels like |
|---|---|---|
| macOS | `.app.tar.gz` + `.sig` (from the `app` bundle target, already in `bundle.targets`) | The app replaces itself and relaunches. No quarantine flag — the download is the app's own, not a browser's — so **no `xattr` ritual on updates**. First installs keep it until the Developer ID arrives (§9). |
| Windows | `-setup.exe` + `.sig` (NSIS, already in `bundle.targets`), `installMode: "passive"` | The installer runs with a progress bar and no questions; it closes Nox itself, which is why the flush precedes install. No SmartScreen on updates — no mark-of-the-web on a file the app fetched itself. |
| Linux | **None.** The plugin updates AppImages, and Nox ships `.deb`/`.rpm` deliberately ("There is no AppImage" — the release notes' own words). | `latest.json` carries no `linux-x86_64` key, `check()` returns its `TargetNotFound` error, the platform maps it to null, and Linux users keep updating through their package file. Honest absence, not a broken button. |

## 3. The endpoint data

`latest.json`, the plugin's static-file format, generated by
`tauri-action` — never written by hand:

```json
{
  "version": "0.5.0",
  "notes": "…",
  "pub_date": "2026-08-20T00:00:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "…", "url": "…/Nox_0.5.0_aarch64.app.tar.gz" },
    "darwin-x86_64":  { "signature": "…", "url": "…/Nox_0.5.0_x64.app.tar.gz" },
    "windows-x86_64": { "signature": "…", "url": "…/Nox_0.5.0_x64-setup.exe" }
  }
}
```

The plugin compares `version` against the running app's and only offers
strictly newer; the platform layer never re-implements that comparison.

## 4. The Platform boundary

Three methods and one capability, in the boundary's style — thin, named,
no generic "fetch":

```ts
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  /** Release notes from the manifest, when it carries any. */
  notes: string | null;
}

export type UpdateProgress =
  | { phase: 'started'; totalBytes: number | null }
  | { phase: 'progress'; chunkBytes: number }
  | { phase: 'finished' };

/** In PlatformCapabilities: */
selfUpdate: boolean;

checkForUpdate(): Promise<UpdateInfo | null>;
installUpdate(onProgress?: (event: UpdateProgress) => void): Promise<void>;
relaunch(): Promise<void>;
```

- `checkForUpdate` **never rejects**: null is the answer to everything
  that is not an installable newer version — no manifest, endpoint
  unreachable, this platform absent from `platforms`, already current
  (envelope §4, the `gitFileBase` argument re-applied).
- `installUpdate` installs the update the last successful check found;
  `TauriPlatform` keeps the plugin's `Update` handle privately between
  the two calls. With nothing in hand it throws
  `PlatformError('not-found')`, and a download or verification failure
  is a real thrown error — the user asked, so failure must say why.
- `relaunch` is `@tauri-apps/plugin-process`'s, exposed here because
  `ui/` and `services/` may not import `@tauri-apps/*`.
- `MemoryPlatform` grows the small honest model: `seedUpdate(info)`
  makes `checkForUpdate` return it; `installUpdate` replays a
  started/progress/finished sequence and records the version in
  `installedUpdate`; `relaunch` sets `relaunched`. Capability false on
  memory and web — a browser tab cannot replace itself, and the flag is
  what `app.ts` consults; tests start the service directly, the
  language-server pattern the git features already use.

## 5. The service — `src/services/updates.ts`

`UpdateService(platform, config, notifications, jobs, flush)`, where
`flush` is a callback `app.ts` fills with the same three writes its
close handler makes: `notes.flush()`, `config.flush()`,
`session.save()`.

- `phase: Signal<'idle' | 'checking' | 'available' | 'installing' |
  'installed'>` and `available: Signal<UpdateInfo | null>`.
- `start()` schedules the one launch check; the setting is read at fire
  time, not schedule time, so it cannot race the config load. `stop()`
  cancels it (called from `app.dispose()`).
- `checkNow({ manual })` — single-flight: a second call while one runs
  joins it. Failures from the platform are swallowed into null
  defensively, though `checkForUpdate` already promises never to throw.
  Found → the sticky toast (dismissing any previous update toast by id
  first). Not found → manual gets "No update found", background gets
  silence.
- `install()` — flush, then the job wrapping
  `platform.installUpdate(onProgress)`, then flush again, then
  `platform.relaunch()`. Failure → error notification with the message,
  `phase` back to `'available'`. A call with nothing available is a
  no-op.

`app.ts`: constructed beside the other services, started behind the
capability exactly as `GitService` is
(`if (platform.capabilities.selfUpdate) this.updates.start();`).

## 6. The desktop wiring

- `Cargo.toml`: `tauri-plugin-updater = "2"`, `tauri-plugin-process =
  "2"`. `lib.rs`: `.plugin(tauri_plugin_updater::Builder::new().build())`
  and `.plugin(tauri_plugin_process::init())` beside
  `tauri_plugin_dialog`. No `nox_*` command — the plugins carry their
  own IPC.
- `capabilities/default.json`: `updater:default`,
  `process:allow-restart` (restart only; nothing here needs
  `allow-exit`).
- `tauri.conf.json` gains `plugins.updater` — the endpoint above,
  `windows.installMode: "passive"`, and `pubkey: ""` until the key
  ceremony fills it. An empty pubkey never breaks a build (the pubkey is
  a runtime value) and never breaks the app (with no key there is no
  `latest.json` to check against; every check is null). One open risk,
  named because cargo does not run on the dev machine: whether the
  plugin's *init* tolerates an empty pubkey string is confirmed by the
  first CI build, and if it does not, the fallback is registering the
  plugin only when the config carries a non-empty pubkey.
- No CSP change: the renderer's updater traffic is IPC, not `fetch`.

## 7. What is tested, and how

- `tests/update-platform.test.ts` (node): the memory model — capability
  false; unseeded check is null; seeded check returns the seed; unseeded
  install refuses with `not-found`; seeded install emits
  started/progress/finished in order and records the version; relaunch
  records.
- `tests/update-service.test.ts` (node, fake timers): the launch check
  fires after 10 s and not before; the setting turns it off; background
  nothing is silent; background something raises the sticky toast with
  the Install and Restart action; manual nothing says "No update found";
  a throwing platform is still absence; single-flight; a re-check
  replaces the toast rather than stacking; install flushes **before**
  the platform installs and again before relaunch (order asserted);
  install failure notifies with the message and returns to
  `'available'`; install with nothing available does nothing.
- `tests/update-command.test.ts` (node): over a real `NoxApp` +
  `MemoryPlatform` — command registered, disabled until the service
  starts, and the full seeded path: execute → toast → run the action →
  the platform records the install and the relaunch.
- `tests/settings-version.test.ts` (jsdom): the footer shows
  `Nox {__APP_VERSION__}`.
- Rust: nothing unit-testable was added — two plugin registrations. CI's
  `cargo build` is the first thing to compile them, and the plan says so
  rather than pretending otherwise.
- The workflow cannot be executed here; it is YAML-parse-checked and
  then verified by the first tagged release, key absent (installers,
  no `latest.json`) and key present (updater artifacts, `latest.json`,
  an in-app offer).
- Mutation checks recorded in docblocks, as the git rows did.

## 8. The operator's key ceremony — human hands only

Run once, on the operator's machine, never by an agent and never in CI
(envelope §1). Three commands and one paste:

```bash
# 1. Generate the keypair OUTSIDE any repository. Choose a real password.
npm run tauri signer generate -- -w ~/.tauri/nox-updater.key

# 2. Hand both halves the private key needs to CI, without them touching disk here.
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo francescoa27122/nox-editor < ~/.tauri/nox-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo francescoa27122/nox-editor
# (paste the password at the prompt)

# 3. Paste the PUBLIC key — printed by step 1, also in
#    ~/.tauri/nox-updater.key.pub — into plugins.updater.pubkey in
#    src-tauri/tauri.conf.json, and commit that. The public key is the
#    only half that belongs in the repo.
```

Then keep `~/.tauri/nox-updater.key` backed up somewhere that is not
this repo: losing it means future releases cannot be verified by
already-shipped builds, and Tauri's guide is blunt that there is no
recovery. After the first signed release, update `releaseBody` in
`release.yml` to stop teaching the `xattr` ritual as the only path —
updates now skip it.

## 9. What changes when the OS certificates arrive

Bought separately, by the operator, out of scope here — but the seams
are already right:

- **Apple Developer ID**: signing identity + notarization env vars land
  in the release workflow's build step; the first-install quarantine
  ritual disappears; the `releaseBody` loses its `xattr` paragraph. The
  updater does not change — its minisign key is independent of Apple's
  signature, and the `.app.tar.gz` artifact is simply built from the
  now-notarized app.
- **Windows code-signing certificate**: `signCommand`/certificate config
  in the bundler; SmartScreen's "Run anyway" disappears from first
  installs. NSIS updates keep working exactly as before, now signed.
- Nothing in `latest.json`, the Platform seam, the service or the UI
  moves. The two key systems answer different questions — the OS certs
  prove *who ships this app*, the updater key proves *this update came
  from whoever cut the last one* — and neither replaces the other.

## 10. Not in this

- Delta/differential updates, release channels, beta tracks, rollback
  UI, telemetry (envelope, permanently).
- Linux self-update — arrives only if an AppImage ever ships, as its own
  decision with its own release-notes implications.
- An "About" dialog. The Settings footer line is the version display;
  a dialog is ceremony without information.
- Update-on-quit, scheduled re-checks, nagging. One check per launch,
  one manual command, one toast.
- The OS certificates themselves (§9 — the operator's purchase).

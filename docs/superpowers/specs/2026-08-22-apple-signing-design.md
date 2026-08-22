# Signing for macOS — design and ceremony

The last code row of *"Installs like software"*. The workflow half is built and
merged; the rest is a purchase and a keychain, and both are the operator's.

Status: workflow merged 2026-08-22, waiting on enrolment. Windows deferred by
decision the same day.

## 1. What this buys, and what it does not

Nox is **ad-hoc signed** today, so a downloaded copy is quarantined and macOS
says *"Nox is damaged and can't be opened"* — which reads as a corrupt
download and is not one. `README.md:48` tells people to run `xattr -dr
com.apple.quarantine`, and most people will not.

A **Developer ID Application** certificate plus **notarization** removes that
entirely: double-click, drag, run.

It does not touch Windows. SmartScreen still shows *"Windows protected your
PC"*, and that is a separate certificate and a separate decision — see §7.

**This is not the updater key.** The minisign keypair from the 2026-08-20
ceremony (`A40CD806C398B1A7`) signs update *payloads*, so a running Nox can
verify an update came from us. It does nothing for a first install. Two keys,
two jobs, neither substitutes for the other.

## 2. One thing to know before enrolling

**An individual Developer ID puts your legal name in every binary you ship.**
The certificate's common name is `Developer ID Application: <your name>
(<team id>)`, and anyone can read it back out of a downloaded app with
`codesign -dv --verbose=4 /Applications/Nox.app`. Enrolling as an
*organization* shows the organisation's name instead, but needs a D-U-N-S
number.

Said once, here, because it is a decision made at enrolment and is awkward to
undo afterwards — not because it is necessarily the wrong trade.

## 3. The ceremony — human hands only

Steps 1–6 happen on the Mac. Nothing here goes in the repository.

1. **Enrol** at <https://developer.apple.com/programs/> — the Apple Developer
   Program, about $99/year. Individual or organization; see §2.

2. **Make a certificate signing request.** Keychain Access → *Keychain
   Access* menu → *Certificate Assistant* → *Request a Certificate From a
   Certificate Authority*. Enter your Apple ID email, leave the CA email
   blank, choose *Saved to disk*.

3. **Create the certificate.** <https://developer.apple.com/account/resources/certificates>
   → **+** → **Developer ID Application** → upload the CSR → download the
   `.cer` → double-click it to install into the login keychain.

4. **Find the identity string** and keep it:

   ```bash
   security find-identity -v -p codesigning
   ```

   The line reading `Developer ID Application: … (…)` is
   `APPLE_SIGNING_IDENTITY`, quotes excluded.

5. **Export the certificate.** Keychain Access → *My Certificates* → the
   Developer ID Application entry → right-click → *Export* → `.p12`. It must
   be exported from the row that has the private key nested under it, or the
   export is useless. Give it a strong password; that is
   `APPLE_CERTIFICATE_PASSWORD`.

   ```bash
   openssl base64 -A -in Certificates.p12 -out cert-base64.txt
   ```

   `-A` matters: without it the output is wrapped and the secret is a
   multi-line string the runner reads differently.

6. **Make an app-specific password** at <https://account.apple.com> →
   *Sign-In and Security* → *App-Specific Passwords*. That is
   `APPLE_PASSWORD` — never the real Apple ID password. Your **Team ID** is on
   <https://developer.apple.com/account> under *Membership details*.

7. **Set the six secrets.** From the Mac:

   ```bash
   gh secret set APPLE_CERTIFICATE < cert-base64.txt
   ```

   From the Windows PC, PowerShell has no `<` redirection — the same trap the
   updater ceremony hit — so it is:

   ```powershell
   Get-Content -Raw cert-base64.txt | gh secret set APPLE_CERTIFICATE
   ```

   The rest are short enough to set interactively: `APPLE_CERTIFICATE_PASSWORD`,
   `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.

8. **Delete `cert-base64.txt` and the `.p12`** from anywhere inside the
   repository. The updater ceremony created a literal `~` directory *inside a
   public repo* by pasting a bash path into PowerShell; nothing was exposed,
   and the lesson was cheap only because it was caught.

## 4. The dry run, which is the point of doing it in this order

Nothing here can be tested before the secrets exist — the release workflow
runs only on a tag, and no local build has a certificate. The first tagged
release is the first test, exactly as it was for the updater.

So make the first one a **prerelease**, which the gate already allows
(`v0.9.0-rc1` against version `0.9.0`, `release.yml:45`):

1. Set the secrets.
2. Tag `v<version>-rc1` and push it.
3. Watch the macOS jobs. *Check the Apple signing configuration is whole* says
   which of the two paths it took, in words, before anything expensive runs.
4. Download the `.dmg` **from the draft release, in a browser**, not from the
   build output — the quarantine flag is applied by the *download*, so a file
   copied off the runner cannot reproduce the failure this is meant to fix.
5. Drag to Applications and double-click. No dialog is the pass.
6. Confirm the chain rather than the absence of a dialog:

   ```bash
   codesign -dv --verbose=4 /Applications/Nox.app
   spctl -a -vvv -t install /Applications/Nox.app
   xcrun stapler validate /Applications/Nox.app
   ```

   `spctl` should say *accepted* and *source=Notarized Developer ID*.

7. Only then do §5, and tag the real release.

## 5. Three places that will be wrong the moment this works

Each currently promises the terminal command. They are deliberately **not**
changed in advance — the same call 0.5.1 made, which softened the macOS
paragraph only once a signed release existed:

- `README.md:38-53` — the install section.
- `.github/workflows/release.yml`, `releaseBody` — the macOS paragraph.
- `ROADMAP.md`, the *Installs like software* row.

## 6. What the workflow does, and what it refuses

The bundler imports the certificate itself from `APPLE_CERTIFICATE` and
`APPLE_CERTIFICATE_PASSWORD` — verified in `tauri-bundler`'s
`macos/sign.rs`, whose `keychain()` reads both and delegates to
`tauri_macos_sign::Keychain::with_certificate`. So there is **no
`security create-keychain` step here**, unlike the manual example in Tauri's
own CI docs, and `KEYCHAIN_PASSWORD` is not used.

Hardened runtime is on: `bundle.macOS.hardenedRuntime` defaults to `true`, and
notarization requires it. It is not set explicitly in `tauri.conf.json`
because an unknown key there would fail at tag time and nothing local would
catch it; the default is the safer place to stand.

The guard refuses a **half-present** configuration, mirroring the updater's.
Signing without notarizing is the trap it exists for: Gatekeeper still stops
the app — a milder dialog than *"damaged"*, but still a click-through — so the
release notes would promise something untrue and nothing would say so. Apple
requires notarization for a Developer ID Application certificate.

Its four states were exercised by running the script rather than reading it:
nothing set → passes, builds ad-hoc; certificate only → fails, names all five;
certificate and identity but no notarization → fails, names the three; all six
→ passes. Empty strings count as absent, which is what an unset GitHub secret
becomes.

## 7. Windows, deferred

Decided 2026-08-22: Apple first, Windows later or never.

The macOS failure is the worse one — *"damaged"* reads as a broken download,
and the fix is a terminal command most people will not run. Windows offers a
click-through. And an *OV* certificate would not remove even that immediately:
SmartScreen reputation accrues with downloads, so only an *EV* certificate
buys silence on day one, at roughly twice the price. Since mid-2023 the key
must also live on FIPS 140-2 Level 2 hardware, so CI needs a cloud signing
service rather than a `.pfx` in a secret — Azure Trusted Signing is the cheap
option worth pricing first if this is ever revisited.

## 8. Expiry

The membership is annual; the certificate lasts five years. A **lapsed**
membership does not break already-notarized builds — signatures carry a secure
timestamp and notarization tickets do not expire — but no new build can be
notarized until it is renewed. A **revoked** certificate is different and does
break installed apps, which is a reason not to revoke one casually.

# A6 Security and Memory Safety

Audited at commit `54cece6e`. Read-only pass over the 52 `nox_*` commands, the Tauri configuration and capabilities, the renderer's injection sinks, the trust boundaries around cloned repositories, plugins, agents, language servers and the local model endpoint, the updater, secrets, dependencies and data at rest. Two suspected Rust defects were reproduced in a scratch crate (deleted afterwards); one git behaviour was reproduced against git 2.54.

## Summary

The security model is coherent and, unusually for a WebView app, mostly enforced where it claims to be: the CSP is `default-src 'self'` with no script relaxations, there is no `{@html}`, `innerHTML`, `eval` or `new Function` anywhere in `src/` apart from one escaped boot-failure message, LSP hover goes through `textContent`, the HTTP client is loopback-only with redirects and proxies disabled in Rust, git is always argv-fixed with `--literal-pathspecs` and `--`, and workspace settings are an eight-key allowlist that cannot name a program, path or address. Worker plugins are genuinely contained: the CSP denies them the network and Tauri's per-instance invoke key denies them the IPC.

The design decision that shapes everything is that the renderer is fully trusted: every path command accepts any path the user can reach, and `nox_agent_spawn`, `nox_pty_open` and `nox_lsp_start` run whatever command string the renderer sends. That is a legitimate choice for an editor and the code is honest about it, but it means renderer-injection resistance is the only wall, and the Known-debt framing "trusted code you chose to install" is doing more work than the README's "you can check what happened rather than trust it" admits.

The strongest finding is a process abort reachable from a hostile or buggy language server: a `Content-Length` near `usize::MAX` makes `MessageStream::push` slice out of range, and the release profile is `panic = "abort"`, so the whole editor dies (A6-001, Confirmed by repro). The second is that opening a folder that arrived with an attacker-written `.git/config` runs `core.fsmonitor` through the `git status` Nox issues automatically (A6-002, Confirmed by repro; requires a tarball or shared-drive delivery, not a clone).

Sub-score 11 / 16: a sound model with two meaningful weaknesses and a handful of hardening gaps, none of which is a code-execution path from a plain `git clone` or from an opened file.

## Sub-score

11 / 16

Justification: A6-001 costs the most, because it is a crash reachable from a third-party process on a normal path and the crate deliberately aborts on panic. A6-002 is a real execution path from an untrusted repository, capped at P2 only because the precondition is a `.git/config` the attacker wrote, which `git clone` never produces. A6-003 is a documentation overclaim on the audit trail that a public product should not carry. The P3s (drive-relative config names on Windows, `localhost` resolved by the system resolver, umask-default file modes, a workspace key that hides files, the `cmd /C` fallback, no `cargo audit` in CI) are hardening rather than holes.

## Findings

```
ID:          A6-001
Lane:        Security
Severity:    P1
Title:       A language server can abort the whole editor with one Content-Length header
Location:    src-tauri/src/lsp.rs:116-121, src-tauri/Cargo.toml:80-85
Evidence:    `MessageStream::push` parses Content-Length as `usize` (lsp.rs:100-105)
             and then does unchecked arithmetic on it:

                 let body_start = header_end + 4;
                 if self.buffer.len() < body_start + length {
                     return Ok(out); // Body still arriving.
                 }
                 let body = &self.buffer[body_start..body_start + length];

             Cargo.toml:80-85 sets `[profile.release]` ... `panic = "abort"`.
             Reproduced in a scratch crate with the function copied verbatim
             (release profile, panic = "abort"), fed
             `Content-Length: 18446744073709551615\r\n\r\n{}`:

                 thread '<unnamed>' panicked at src\main.rs:25:36:
                 slice index starts at 40 but ends at 39
                 exit code: -1073740791

             In release, overflow checks are off, so `body_start + length`
             wraps to `body_start - 1`, the length test passes, and the slice
             panics. In debug the addition itself panics. Either way the panic
             is on the stdout reader thread spawned at lsp.rs:244, which is
             outside Tauri's command catch, and `panic = "abort"` turns it into
             process termination.
Impact:      A hostile server configured in `servers.json`, or a buggy one that
             emits a corrupt header, kills Nox with no dialog. Unsaved work is
             bounded by the session backup debounce, not zero.
Fix sketch:  Use `body_start.checked_add(length)` and treat `None` (or a
             length above a sane cap, say 64 MiB) as the same framing error the
             function already returns for a missing header. Add the
             `usize::MAX` case to the `MessageStream` tests beside
             `errors_on_an_unparseable_length`.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A6-002
Lane:        Security
Severity:    P2
Title:       Opening a folder runs the repository's own core.fsmonitor command via the automatic git status
Location:    src-tauri/src/git.rs:75-83, src-tauri/src/git.rs:202-208, src/services/git.ts:386, src/services/git.ts:411, src/app.ts:3569
Evidence:    `run_git` (git.rs:75-83) runs `git -C <root> <args>` with only
             `GIT_OPTIONAL_LOCKS=0` in the environment. No `-c` override
             disables `core.fsmonitor`, `core.hooksPath` or `gpg.program`.
             `nox_git_status` (git.rs:202-208) issues
             `status --porcelain=v2 --branch -z`. The renderer calls it without
             user action: on buffer activation (git.ts:386,
             `void this.refreshStatus()`), on every `.git` meta-watch event
             (git.ts:411) and on folder open (app.ts:3569).

             Reproduced against git 2.54.0.windows.1: a repo with
             `fsmonitor = touch '<marker>'` in `.git/config`, then the exact
             invocation `GIT_OPTIONAL_LOCKS=0 git status --porcelain=v2
             --branch -z`:

                 status exit 0
                 MARKER CREATED: core.fsmonitor command ran during git status

             `git blame` (git.rs:474-549) and `git commit` (git.rs:263-315)
             additionally honour `blame.ignoreRevsFile` (a read) and
             `gpg.program` with `commit.gpgsign` (an execution, on commit).
Impact:      A repository delivered as an archive, on removable media or on a
             shared drive carries its own `.git/config`. Opening it in Nox, or
             merely clicking a file in it, executes the configured command with
             the user's privileges. A plain `git clone` does not carry
             `.git/config`, and git's `safe.directory` check does not fire
             because the user owns the files, so this is the same exposure
             VS Code and most git GUIs have. It is still an execution path
             from untrusted repository contents with no prompt.
Fix sketch:  Pass `-c core.fsmonitor=false` on every read (`run_git`,
             `nox_git_blame`), and consider `-c core.hooksPath=` plus
             `-c gpg.program=` refusal only for reads, leaving `commit` to run
             hooks as documented. Record the residual (`commit` runs hooks and
             `gpg.program` from repo-local config) in the Known debt table.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A6-003
Lane:        Security
Severity:    P2
Title:       README and the permission prompt promise an audit trail that process-backed principals bypass by construction
Location:    README.md:114-115, src/app.ts:1115-1121, ARCHITECTURE.md:2658, ARCHITECTURE.md:2667, src/services/plugin/discover.ts:109-116, src-tauri/src/agent.rs:61-108
Evidence:    README.md:114-115: "Everything it read, everything it ran, and
             everything it was refused shows up in the Agents panel. You can
             check what happened rather than trust it."

             app.ts:1115 names every plugin principal the same way regardless
             of transport: `const who = request.principal.kind === 'agent' ?
             request.principal.label : 'A plugin';` and the prompt reads
             "A plugin wants to write files".

             A `process` plugin (discover.ts:109-116) and every stdio agent
             (agent.rs:74-108) is an ordinary child process with Nox's
             privileges, inheriting Nox's environment and, for agents, being
             handed `NOX_CONFIG_DIR` (agent.rs:94-96). Nothing it does with
             `std::fs` or a socket passes through `PermissionService` or the
             context reader's `record` calls (context.ts:342, 357), so nothing
             it does on its own is in the panel.

             The Known-debt rows at ARCHITECTURE.md:2658 and :2667 say this
             accurately ("the permission model governs what a plugin may ask
             Nox to do, not what its own process can reach"). The user-facing
             surfaces do not.
Impact:      A user installs a third-party stdio plugin or agent, sees a
             permission dialog and an audit panel, and reasonably concludes
             that a denial or an empty log means nothing happened. For a
             `worker` plugin that conclusion is correct (see What is good). For
             a `process` plugin or a stdio agent it is false, and the product
             gives no cue which kind they installed.
Fix sketch:  Qualify README.md:115 ("everything it did through Nox"); show the
             entry kind in the plugin list and the first-run notice, and word
             the prompt for process principals as "may also act on its own";
             consider requiring an explicit first-run acknowledgement for
             `process` plugins the way the debt row's own analogy (a shell
             plugin) implies. The debt rows' descriptions are accurate and
             their severity is right for the design; the gap is that the
             caveat lives only there.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A6-004
Lane:        Security
Severity:    P3
Title:       config_path rejects separators but not a Windows drive-relative name, so a config "name" can leave the config directory
Location:    src-tauri/src/fs.rs:421-436
Evidence:    fs.rs:422 rejects `name` when it `contains('/') ||
             contains('\\') || contains("..")`, then fs.rs:435 does
             `Ok(dir.join(name))`. On Windows, `Path::join` replaces the base
             when the argument carries a drive prefix, even without a
             separator. Reproduced with the same predicate and join:

                 name="C:evil.json" rejected=false joined=C:evil.json
                 name="C:" rejected=false joined=C:

             `C:evil.json` resolves relative to the process's current
             directory on drive C, not to the config directory. Every current
             caller passes a fixed literal or an internally generated name
             (`unsaved-N.txt`, session.ts:385; notes bodies via notes.ts:581),
             so no untrusted input reaches it today.
Impact:      Defence in depth only: a compromised renderer already has
             `nox_write_text_file` on any path. The comment on fs.rs:419-420
             promises a traversal guard that is incomplete on the platform the
             project is developed on.
Fix sketch:  Reject any `name` whose `Path::new(name).components()` yields
             anything but a single `Component::Normal`, or check
             `dir.join(name).starts_with(&dir)` after the join.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A6-005
Lane:        Security
Severity:    P3
Title:       The loopback check accepts the literal "localhost" and lets the system resolver decide where it goes
Location:    src-tauri/src/http.rs:42-50, src-tauri/src/http.rs:67-77
Evidence:    `is_loopback` matches `host_str()` against
             `"localhost" | "127.0.0.1" | "[::1]"` (http.rs:49). The client
             at http.rs:70-73 sets `redirect(Policy::none())` and
             `.no_proxy()` but does not pin `localhost` with
             `Client::builder().resolve(...)`, so the name goes to
             `getaddrinfo`. `0.0.0.0`, `127.0.0.2`, `127.1`, `[::ffff:127.0.0.1]`
             and `localhost.evil.com` are all correctly refused; `localhost`
             is the one spelling whose meaning is not decided by this code.
Impact:      An attacker who controls the hosts file or the DNS search path
             can make "loopback-only" requests, which carry the prompt and
             therefore the user's file contents, leave the machine. That
             attacker already has a lot; this is the one gap in an otherwise
             careful check and it costs one line.
Fix sketch:  `.resolve("localhost", SocketAddr::from(([127, 0, 0, 1], 0)))` on
             the client builder, or drop `localhost` from the allowlist and
             rewrite it to `127.0.0.1` before the request.
Confidence:  Likely
Risk class:  Safe
```

```
ID:          A6-006
Lane:        Security
Severity:    P3
Title:       Files Nox creates get umask-default modes: unsaved-buffer backups are readable by other local users, and a 0600 file is briefly 0644 during save
Location:    src-tauri/src/fs.rs:178-195, src-tauri/src/fs.rs:466-482, src-tauri/src/fs.rs:426-433, src/services/session.ts:385
Evidence:    `write_then_rename` (fs.rs:182) does `fs::File::create(temp)`,
             writes all bytes (fs.rs:183), syncs, and only then
             `copy_permissions(target, temp)` (fs.rs:192). `File::create`
             yields `0666 & ~umask`, typically 0644, so for the window between
             183 and 192 the new contents of a 0600 target sit in a 0644
             sibling. `write_config_atomically` (fs.rs:466-482) uses the same
             path for config files, whose targets have no restrictive mode to
             copy, and `config_path` creates the directory with
             `create_dir_all` (fs.rs:432), typically 0755. session.ts:385
             writes each dirty buffer's full text to `unsaved-N.txt` in that
             directory, beside `agents.json` and `servers.json`.
Impact:      On a Linux machine where `~/.config` is traversable (0755 is
             common on shared hosts), another local account can read every
             unsaved buffer, the agent and server command lines, and
             `diagnostics.log`. On macOS `~/Library` is 0700 and on Windows
             `%APPDATA%` is per-user, so the exposure is Linux-only. The
             transient 0644 window on a 0600 file is real but milliseconds
             long. The Known-debt rows on plaintext config files
             (ARCHITECTURE.md:2651) cover the content, not the mode.
Fix sketch:  On unix, open the temp with
             `OpenOptions::new().mode(0o600).create_new(true)`, then copy the
             target's mode after writing (fs.rs) and create the config
             directory with `DirBuilder::new().mode(0o700)`. Windows needs
             nothing.
Confidence:  Likely
Risk class:  Safe
```

```
ID:          A6-007
Lane:        Security
Severity:    P3
Title:       files.excludeFromExplorer is workspace-scoped, so a repository can hide its own entries from the explorer
Location:    src/services/config/schema.ts:321-326, src/services/config/schema.ts:414-423, src/services/filetree.ts:104-112, src/services/filetree.ts:215
Evidence:    schema.ts:321-326 declares `'files.excludeFromExplorer'` as a
             string with `workspace: true`. `coerceWorkspace` (schema.ts:414-
             423) admits it from `.nox/settings.json` with no bound on the
             list. filetree.ts:104 `setExcludes` splits it into names and
             filetree.ts:215 skips any entry whose name matches, at every
             depth. The other seven workspace keys (tabSize, insertSpaces,
             wordWrap, autoIndent, trimTrailingWhitespace, insertFinalNewline,
             formatOnSave) only shape editing. The design comment at
             schema.ts:21-28 says workspace keys must be "facts about the
             code", and a hide list arguably is one, so this is a decision to
             assess rather than a bug.
Impact:      A repository can make `.github/workflows/`, a `postinstall`
             script or its own `.nox/` invisible to someone reviewing it in
             Nox's explorer. Project search still finds the files
             (search.rs:305 searches hidden entries), so the deception is
             partial, and no execution follows from it inside Nox.
Fix sketch:  Either drop `workspace: true` from this key, or show a status-bar
             or explorer-header indicator ("N names hidden by this project")
             whenever the workspace layer supplies it, the way
             `workspaceScope` already tells the Settings panel which rows a
             project owns.
Confidence:  Confirmed
Risk class:  Gated
```

```
ID:          A6-008
Lane:        Security
Severity:    P3
Title:       The Windows language-server fallback routes the configured command line through cmd.exe
Location:    src-tauri/src/lsp.rs:194-203
Evidence:    When the direct spawn fails for any reason, lsp.rs:196-198
             builds `vec!["/C", command, ...args]` and spawns `cmd`. `command`
             and `args` come from `servers.json` (registry.ts:73-99), which
             is user-scope only. Rust's BatBadBut quoting applies when the
             program itself is a `.bat`/`.cmd`, not when the program is `cmd`
             with `/C`, so `&`, `|` and `%VAR%` in an argument are
             interpreted by the shell.
Impact:      Only the user's own configuration reaches this, so there is no
             attacker today. It contradicts the crate-wide rule stated in
             git.rs:31 and fs.rs:376-377 ("never through a shell"), and it is
             the one place a future workspace-scoped or downloaded server
             configuration would become shell injection.
Fix sketch:  Resolve `.cmd` shims explicitly (look up `<command>.cmd` on PATH
             and spawn it as the program, letting std apply its quoting)
             instead of delegating to `cmd /C`, or restrict the fallback to
             commands that resolve to a `.cmd`/`.bat` file.
Confidence:  Confirmed
Risk class:  Safe
```

```
ID:          A6-009
Lane:        Security
Severity:    P3
Title:       No Rust dependency audit runs anywhere in CI
Location:    .github/workflows/ci.yml, .github/workflows/release.yml, src-tauri/Cargo.lock
Evidence:    Neither workflow mentions `cargo audit` or `cargo deny` (grep over
             `.github/workflows/*.yml` returns nothing). `npm audit` is at
             least run by hand (orientation: 0 production vulnerabilities).
             Pinned versions from Cargo.lock: tauri 2.11.5, wry 0.55.1,
             tao 0.35.3, reqwest 0.12.28 (and a second 0.13.4 pulled
             transitively), tokio 1.53.1, hyper 1.11.0, rustls 0.23.43,
             notify 8.2.0, portable-pty 0.9.0, ignore 0.4.33, regex 1.13.1,
             trash 5.2.6, encoding_rs 0.8.35, url 2.5.8, idna 1.1.0,
             tauri-plugin-updater 2.10.1, minisign-verify 0.2.5, zip 4.6.1,
             time 0.3.55. Against the RustSec advisories I know of, none of
             these versions is affected (the notable historical ones, idna
             below 1.0 and zip 0.x, are well behind these pins). That is
             knowledge with a cutoff, not a scan.
Impact:      A future advisory against wry, tauri or reqwest reaches users
             through the auto-updater without anything in the pipeline
             noticing.
Fix sketch:  Add `rustsec/audit-check` or `EmbarkStudios/cargo-deny-action` to
             the rust matrix in ci.yml, non-blocking at first, and `npm audit
             --omit=dev --audit-level=high` beside it.
Confidence:  Likely
Risk class:  Safe
```

## What is good

- **The CSP is strict where it matters.** `tauri.conf.json:31` is `default-src 'self'` with `worker-src 'self' blob:`; there is no `'unsafe-inline'` or `'unsafe-eval'` for scripts and no `connect-src`. `style-src 'unsafe-inline'` is required by CodeMirror's style injection and cannot exfiltrate because every fetching directive falls back to `'self'`. The `asset:` and `http://asset.localhost` entries in `img-src` are dead (the asset protocol is not enabled), which is harmless. `withGlobalTauri` and `dangerousRemoteDomainIpcAccess` are unset, and `devtools` is not in the crate's feature list (Cargo.toml:17), so release builds carry no inspector.
- **No injection sink in the renderer.** A grep over `src/` for `{@html`, `innerHTML`, `insertAdjacentHTML`, `outerHTML`, `new Function`, `eval(`, `srcdoc` and `document.write` finds one hit, `src/main.ts:28`, which renders a boot-failure string through `escapeHtml` (main.ts:38-44). LSP hover builds DOM with `textContent` only (`src/editor/hover.ts:37-48`) and says why. Plugin panels are rows through `PluginPanelStore` (host.ts:693-695). The terminal loads only `@xterm/addon-fit` (TerminalPanel.svelte:107, package.json:53); there is no web-links addon.
- **Worker plugins are actually contained.** `startPluginWorker` (tauri.ts:542-616) builds a blob-URL module worker with a shim that exposes only `onRequest`/`send` over `postMessage`. The worker inherits the document CSP, so it cannot fetch anywhere but `'self'`, and it cannot reach the IPC: Tauri's protocol handler requires a `Tauri-Invoke-Key` header (vendored `tauri-2.11.5/src/ipc/protocol.rs:480-485`) that `webview/mod.rs:1746-1748` compares against a per-instance secret injected only into the main window's initialization script. The host's `#serve` (host.ts:608-750) exposes exactly the read verbs plus `command.execute`, and `command.execute` goes through the same `CommandRegistry.execute` with a plugin principal that the palette uses (host.ts:640-644). This is the half of the plugin story the docs should lead with.
- **git is argv-fixed and the option-injection cases are closed.** Every invocation is `Command::new("git")` with `-C` (git.rs:76-77); pathspecs are made repo-relative and placed after `--` with `--literal-pathspecs` (git.rs:225, 250, 490); `nox_git_unstage` refuses an empty list rather than issuing a bare `git reset --` (git.rs:246-248); the commit message goes on stdin (git.rs:271). `nox_git_switch` validates through `check-ref-format --branch` first (git.rs:324), and I confirmed against git 2.54 that `-foo`, `--normalize`, `-h`, `@{-1}` and `a b` all exit 128 there, so nothing beginning with a dash reaches `switch`.
- **The loopback HTTP client is defended in Rust, with the redirect and proxy holes closed and tested.** `is_loopback` parses the host rather than prefix-matching (http.rs:42-50), the client is built once with `Policy::none()` and `no_proxy()` (http.rs:67-77), and `redirects_are_never_followed` (http.rs:252-302) proves it with a real attacker listener. Only the `localhost` resolution gap (A6-005) remains.
- **The workspace settings allowlist does what it claims.** `coerceWorkspace` (schema.ts:414-423) iterates `WORKSPACE_SETTING_KEYS` and nothing else; the eight keys are all `editor.*`/`files.*` scalars; `terminal.shell`, `editor.fontFamily` and `workbench.theme` are user-scope only. `agents.json`, `servers.json`, `snippets.json`, `plugin-settings.json`, themes and plugins are all read through `readConfigFile` or `configDir()` (agent/config.ts:122, registry.ts:115, snippets.ts:57, themes.ts:198-199, discover.ts:47-50); nothing is discovered from the workspace.
- **A hostile language server cannot push edits.** `workspace/applyEdit` is only advertised when a handler is supplied (session.ts:316) and `app.ts` never passes `applyWorkspaceEdit` to `LspService`, so a server-initiated edit request is refused. Formatting edits are only applied in reply to a request Nox made.
- **The updater is consent-gated, HTTPS, signed, and cannot downgrade.** The endpoint is `https://github.com/.../latest.json` (tauri.conf.json:37-39) with a minisign pubkey (line 36); `UpdateService` only ever checks in the background and installs from the toast's single action (updates.ts:137-145, 148-217); `tauri-plugin-updater` 2.10.1 installs only when the remote version is greater. The signing key reaches the release workflow as a repository secret and is never echoed (release.yml:162-169); the guard at release.yml:244-262 refuses a half-configured keypair. Windows uses `installMode: passive` (tauri.conf.json:41).
- **No secrets in the tree.** Greps for private-key headers, `ghp_`, `sk-`, `AKIA`, Slack tokens and `TAURI_SIGNING_PRIVATE_KEY` hit only the workflow's `${{ secrets.* }}` references and design docs describing the ceremony. There is no `.env` file. The pubkey in `tauri.conf.json` is public by design.
- **Zero `unsafe`, and the byte-boundary slicing is careful everywhere except A6-001.** `relative_to_root` guards with `is_char_boundary` (git.rs:117-119); `preview_for` slices at regex match offsets, which are char boundaries by construction (search.rs:152-178); `Utf8Stream` and `LineStream` hold back split characters (pty.rs:65-109, agent.rs:266-304); `parse_saved` refuses non-finite and non-positive geometry (geometry.rs:151-167). Search uses the linear-time `regex` crate (Cargo.toml:43), not `fancy-regex`, and an invalid pattern is an error rather than a panic (search.rs:128, tested at 676-678).
- **The e2e WebDriver server is double-gated out of release builds** (Cargo.toml feature `wdio` plus `debug_assertions` in lib.rs:45-46), with the reasoning written down.
- **`diagnostics.log` is redacted on the way in**, with the home directory replaced under three separator spellings (`diagnostics.ts:63-77`) before any line is stored.

## Not checked

- I did not run the packaged app, so the worker-plugin IPC containment (What is good, item 3) rests on reading Tauri's vendored source rather than on attempting `fetch('http://ipc.localhost/...')` from inside a plugin worker. The invoke-key comparison and the header requirement are both in the crate; what I did not verify empirically is that Tauri's CSP patching leaves `connect-src` closed to a blob worker as well as to the document.
- Tauri and wry advisories after my knowledge cutoff. A6-009 is the honest form of that gap.
- Panics in `notify`'s or `portable-pty`'s own threads, which are outside this crate; under `panic = "abort"` any of them would also take the process down. I read only Nox's spawned threads (pty.rs:223-273, agent.rs:123-182, lsp.rs:244-334, search.rs:239, 343).
- `nox_read_dir` reports a symlinked directory as a file (`file_type().is_dir()` is false for the link, fs.rs:237-242) and every read follows the link. I did not assess whether a repository symlink pointing outside the workspace can reach an agent's `context.workspaceTree` or `bufferText` in a way that leaks a file the user did not open; that is A7/agent-platform territory and the read-only door already logs every read.
- The Ollama provider's prompt-injection surface (a malicious file steering a local model into `command.execute`). The permission model gates it and "running commands" is unbuilt per ROADMAP, so I left it to the agent lane.
- The macOS `trash` `NsFileManager` path and the `open -R` / `xdg-open` reveal spawns were read, not executed; the path is passed as its own argument on all three platforms (fs.rs:385-410).

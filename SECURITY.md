# Security

Nox's pitch rests on a boundary: an agent reads your code through a read-only
door and cannot write, a plugin gets only the capabilities it declared, and the
model client will only talk to loopback. If you find a way through any of
that, this is how to say so without handing it to everyone at once.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:

<https://github.com/francescoa27122/nox-editor/security/advisories/new>

That opens a draft advisory only the maintainer can see. Do not open a public
issue for anything you believe is exploitable; an issue is public the moment
it exists.

Include what you would put in a bug report (see the issue templates), plus
what the hole lets an attacker do that the design says they cannot. A
proof of concept is welcome. The output of **Copy Diagnostics** (run it from
the command palette) is useful here too; it strips your home directory from
the paths before it reaches the clipboard.

This is a one-person project with no bounty. You will get a reply, a fix or a
reason, and credit in the changelog if you want it.

## What counts

Anything that crosses a line `ARCHITECTURE.md` says cannot be crossed. In
particular:

- An agent or plugin reaching a file, a command or a network endpoint that
  its declared capabilities do not grant, or writing to the workspace without
  going through review.
- The HTTP client in `src-tauri/src/http.rs` being made to talk to anything
  other than loopback, including by redirect.
- A page in the webview reaching the Rust side through something other than
  the `nox_*` commands, or those commands accepting a path outside where they
  say they operate (the config directory, the workspace).
- The updater accepting an artifact whose signature does not verify against
  the key in `src-tauri/tauri.conf.json`.
- Anything that gets a secret out of `servers.json` or `agents.json` that
  the Known debt table in `ARCHITECTURE.md` does not already say is plaintext.

Agent and plugin processes are not sandboxed: they run with Nox's privileges,
and the Known debt table records that. A report that an agent *you configured*
can do what your user account can do is not a vulnerability; a report that it
can do so through Nox despite a capability it was refused is.

## Supported versions

Only the latest release, as listed at
<https://github.com/francescoa27122/nox-editor/releases/latest>. Fixes ship
as a new release, which the app's own update check (on by default) will
offer; there are no backports.

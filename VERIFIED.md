# Verification notes

Findings on this branch whose fix has a part no test can reach, and how that
part was verified instead. Everything else on the branch ships with a test.

## A7-009

What the test covers: `agent::tests::kill_all_ends_a_child_that_would_not_end_on_its_own`
in `src-tauri/src/agent.rs` spawns a child that ignores its stdin and would run
for thirty seconds, registers it, calls `AgentState::kill_all`, and asserts the
child is reaped within five seconds and the registry is empty. `cargo test` on
the Windows 11 build machine: 125 unit tests passed, both integration files
passed, exit 0. `cargo clippy --all-targets -- -D warnings`: exit 0.

What it cannot cover: the `RunEvent::Exit` handler in `src-tauri/src/lib.rs`
needs a running Tauri event loop, which a unit test does not have. Verified by
reading, and by the compiler: `tauri::Builder::build` returns an `App`,
`App::run` takes `FnMut(&AppHandle, RunEvent)`, `RunEvent::Exit` is emitted
once the loop ends, and `Manager::state` hands back the same `AgentState`,
`LspState` and `PtyState` the `nox_*_all` commands use, so the hook and the
commands cannot kill different registries. Not run in the packaged app: a
desktop walk that quits Nox with an agent, a terminal and a language server
running and then checks the process table is the check that would close this.

Not done, and why: a kill-on-close job object on Windows and
`PR_SET_PDEATHSIG` on Linux, which are what would cover a host crash.
`std::process` and `portable-pty` expose neither. Each needs Win32 or libc
calls through `unsafe` FFI, either hand-declared or through `windows-sys` or
`libc` as a direct dependency (both are transitive today, neither is direct).
The crate has no `unsafe` block at all, and adding its first, or a new direct
dependency, is a decision for the lead rather than a fix agent. The Known debt
row for agent sandboxing now says the lifetime gap out loud.

## A7-010

Prose only, in `README.md`, `ROADMAP.md` and the `agents.json` template in
`src/services/agent/config.ts`. Verified by re-reading each edited sentence
against the code it describes: the Ollama provider's vocabulary
(`src/services/agent/ollama.ts`) has no `command.execute`, the wire protocol
(`src/services/agent/protocol.ts`) does, the prompter is invoked for
programmatic callers only (`src/services/permissions.ts`), and a stdio agent
is a plain child process (`src-tauri/src/agent.rs`). The template still parses
into both example agents: `tests/agent-config.test.ts` asserts that, and the
added `note` key is ignored by the loader, which reads only `agents`.

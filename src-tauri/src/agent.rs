//! Supervision of external agent processes.
//!
//! Nox talks to an agent over its stdin and stdout, one JSON object per line.
//! This module owns nothing about the protocol itself — it moves lines, starts
//! processes and stops them. What those lines mean is decided in the renderer,
//! in `services/agent/`, which is where it can be unit-tested against a fake
//! process instead of a real one.
//!
//! Line-delimited JSON rather than a length-prefixed framing like LSP's: an
//! agent is very often a script someone wrote in an afternoon, and `print(...)`
//! in a loop should be enough to speak it.
//!
//! Starting a process is the single most powerful thing Nox can do on someone's
//! behalf. It is deliberately not reachable from the agent protocol — an agent
//! cannot spawn another agent. Only the user, through configuration, can.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::ops::ControlFlow;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::pty::Utf8Stream;

/// Suppresses the console window Windows would otherwise give a
/// console-subsystem child of a GUI process. `winbase.h`'s value; not worth a
/// dependency on the `windows` crate for one constant.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub type Result<T> = std::result::Result<T, String>;

#[derive(Default)]
pub struct AgentState(Mutex<HashMap<String, Running>>);

struct Running {
    child: Arc<Mutex<Child>>,
    stdin: ChildStdin,
}

#[derive(Clone, Serialize)]
struct LinePayload {
    id: String,
    line: String,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    id: String,
    code: Option<i32>,
}

/// Start an agent. `id` is chosen by the renderer so replies can be matched
/// without a round trip to learn what the process was called.
#[tauri::command]
pub fn nox_agent_spawn(
    app: AppHandle,
    state: State<'_, AgentState>,
    id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<()> {
    if state.0.lock().map_err(poisoned)?.contains_key(&id) {
        return Err(format!("exists: an agent with id {id} is already running"));
    }

    let mut builder = Command::new(&command);
    builder
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(directory) = cwd {
        builder.current_dir(directory);
    }

    // Where Nox keeps `session.json` and `settings.json`, handed to the agent
    // so anything it persists can sit beside them rather than in a directory
    // of its own invention. Nox is the only party that knows this path — it is
    // per-platform and derived from the bundle identifier — and an agent that
    // recomputed it would be duplicating a contract that can drift.
    //
    // It grants nothing: the protocol still has no verb that stores anything,
    // and an agent could always write wherever it liked. This is an address,
    // not a capability. Absent on failure rather than fatal, since an agent
    // that does not persist anything must still start.
    if let Ok(directory) = app.path().app_config_dir() {
        builder.env("NOX_CONFIG_DIR", &directory);
    }

    // Windows gives a console-subsystem child its own window when the parent
    // is a GUI app, and an agent is one. Without this an empty console sits in
    // front of the editor for as long as the agent runs — empty because its
    // output is piped here, and never closing on its own. Observed for
    // language servers first; this module spawns the same way.
    #[cfg(windows)]
    builder.creation_flags(CREATE_NO_WINDOW);

    let mut child = builder
        .spawn()
        .map_err(|e| format!("spawn: could not start {command} ({e})"))?;

    let streams = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let (Some(stdin), Some(stdout), Some(stderr)) = streams else {
        let _ = child.kill();
        return Err(format!("spawn: {command} did not give Nox its pipes"));
    };

    let child = Arc::new(Mutex::new(child));

    // stdout: one line, one message.
    {
        let app = app.clone();
        let id = id.clone();
        let child = Arc::clone(&child);
        std::thread::spawn(move || {
            // Read through `read_lines` rather than `BufRead::lines()`,
            // because that turns one non-UTF-8 byte into the end of the
            // conversation.
            read_lines(stdout, |line| {
                if !worth_emitting(&line) {
                    return ControlFlow::Continue(());
                }
                // A failed emit means the window is gone; nothing to recover,
                // and no reason to go on reading.
                if emit_line(&app, "nox://agent-line", &id, line) {
                    ControlFlow::Continue(())
                } else {
                    ControlFlow::Break(())
                }
            });

            // stdout closing is the earliest reliable sign the agent is done.
            // Reaping here also stops the child becoming a zombie when nobody
            // calls `kill`.
            let code = child
                .lock()
                .ok()
                .and_then(|mut child| child.wait().ok())
                .and_then(|status| status.code());

            // Forget it, or the id stays registered for the life of the app
            // and spawning under it again is refused as "already running" —
            // which is exactly what happens after the window reloads and the
            // renderer's counter starts over.
            if let Some(state) = app.try_state::<AgentState>() {
                if let Ok(mut agents) = state.0.lock() {
                    agents.remove(&id);
                }
            }

            let _ = app.emit("nox://agent-exit", ExitPayload { id, code });
        });
    }

    // stderr is diagnostics, not protocol. It is forwarded under its own event
    // so a crashing agent says *why* instead of just disappearing.
    {
        let app = app.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            // Same decoding as stdout, and for a sharper reason: mojibake in
            // a traceback is exactly the kind of thing that reaches stderr,
            // and dropping the rest of it would lose the only explanation a
            // crashed agent ever gives (`stdio.ts#died` reports these lines).
            //
            // Read to the end whatever the emits do: unlike stdout, a dead
            // window is not a reason to stop draining the pipe, because an
            // agent that fills stderr and is never read blocks on the write.
            read_lines(stderr, |line| {
                emit_line(&app, "nox://agent-stderr", &id, line);
                ControlFlow::Continue(())
            });
        });
    }

    state
        .0
        .lock()
        .map_err(poisoned)?
        .insert(id, Running { child, stdin });
    Ok(())
}

/// Send one line to an agent's stdin. The newline is added here so a caller
/// cannot half-send a message by forgetting it.
///
/// Stays a plain `#[tauri::command]` on purpose, with `nox_lsp_send` and
/// `nox_pty_write`. A sync body runs to completion before the next IPC
/// message is read, so two sends issued back to back reach the agent in that
/// order whether or not the caller awaited the first. `stdio.ts` does await
/// each one today; the guarantee is kept here so a caller that stops doing so
/// cannot swap two lines. Under `(async)` each send would be its own pool
/// task racing for the registry lock.
#[tauri::command]
pub fn nox_agent_send(state: State<'_, AgentState>, id: String, line: String) -> Result<()> {
    let mut agents = state.0.lock().map_err(poisoned)?;
    let Some(agent) = agents.get_mut(&id) else {
        return Err(format!("not-found: no agent {id}"));
    };

    agent
        .stdin
        .write_all(line.as_bytes())
        .and_then(|_| agent.stdin.write_all(b"\n"))
        .and_then(|_| agent.stdin.flush())
        .map_err(|e| format!("io: could not write to agent {id} ({e})"))
}

/// Stop an agent and forget it. Safe to call on one that has already exited.
#[tauri::command]
pub fn nox_agent_kill(state: State<'_, AgentState>, id: String) -> Result<()> {
    let Some(agent) = state.0.lock().map_err(poisoned)?.remove(&id) else {
        return Ok(());
    };

    // Dropping stdin closes it, which is how a well-behaved agent is asked to
    // stop. The kill is for the ones that are not.
    drop(agent.stdin);
    if let Ok(mut child) = agent.child.lock() {
        let _ = child.kill();
    }
    Ok(())
}

/// Stop every agent. Called when the window goes away, so a reload does not
/// leave orphans running with nothing left to talk to them.
#[tauri::command]
pub fn nox_agent_kill_all(state: State<'_, AgentState>) -> Result<()> {
    let agents: Vec<Running> = state
        .0
        .lock()
        .map_err(poisoned)?
        .drain()
        .map(|(_, agent)| agent)
        .collect();

    for agent in agents {
        drop(agent.stdin);
        if let Ok(mut child) = agent.child.lock() {
            let _ = child.kill();
        }
    }
    Ok(())
}

/// Splits a child process's output into lines, surviving bytes that are not
/// UTF-8. The decoding half of `read_lines`, which is the only way in.
///
/// `BufRead::lines()`, which this module used, cannot do the job: it yields
/// `Err(InvalidData)` for a chunk that is not valid UTF-8, so **one** stray
/// byte ended the reader loop while the agent went on running. Nothing then
/// arrived again — not another line, and not the exit event either, because
/// the `child.wait()` after the loop blocks on a process that is still alive.
/// The session sat on "Working…" until Nox was restarted. A Python agent
/// under a cp1252 console needs one accented character to produce this.
///
/// The decoding is `pty::Utf8Stream` rather than a second implementation of
/// the same idea: it already holds back a character a read boundary cut in
/// half and substitutes for bytes that can never become valid, and it is the
/// tested one. What is added here is the line splitting, which a terminal
/// does not need and an agent cannot work without.
///
/// Bytes still sitting in the decoder when the stream ends — a character
/// truncated by the agent dying mid-write — are dropped rather than
/// substituted, which is what happened before too.
#[derive(Default)]
struct LineStream {
    decoder: Utf8Stream,
    /// The tail of a line whose newline has not arrived yet.
    partial: String,
}

impl LineStream {
    /// Every complete line in this chunk. A trailing partial line is held
    /// back for the next call, so half a JSON object never reaches the
    /// renderer's parser.
    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.partial.push_str(&self.decoder.push(bytes));

        let mut lines = Vec::new();
        // `find` returns the byte index of a one-byte character, so the
        // inclusive drain always lands on a character boundary.
        while let Some(end) = self.partial.find('\n') {
            let mut line: String = self.partial.drain(..=end).collect();
            line.pop();
            trim_carriage_return(&mut line);
            lines.push(line);
        }
        lines
    }

    /// Whatever never got its newline. An agent that forgets the last one, or
    /// is killed mid-message, still gets that message delivered — as it did
    /// under `BufRead::lines()`.
    fn finish(&mut self) -> Option<String> {
        let mut line = std::mem::take(&mut self.partial);
        trim_carriage_return(&mut line);
        if line.is_empty() {
            None
        } else {
            Some(line)
        }
    }
}

/// Read `source` to its end, handing over one line at a time.
///
/// The one reader behind every piped stream Nox supervises: an agent's stdout
/// and stderr here, and a language server's stderr in `lsp.rs`. Raw byte reads
/// through `LineStream` rather than `BufRead::lines()`, which all three used
/// until it was found to yield `Err(InvalidData)` for a chunk that is not
/// valid UTF-8 — one stray byte ended the thread, and everything the process
/// said afterwards was lost. Sharing the reader is what keeps a server and an
/// agent garbling a line the same way, rather than the fix landing on one of
/// them and not the other.
///
/// `on_line` returns `Break` when there is nowhere left to put a line — the
/// window is gone — and reading stops there. Returning `Continue` throughout
/// drains the stream whatever the emits do, which is what a stderr reader
/// wants: a pipe nobody empties eventually blocks the process filling it.
///
/// A free function taking `impl Read` rather than a loop written out in each
/// thread, so the reading can be driven by a test: a `ChildStdout` cannot be
/// handed the bytes a test needs it to carry.
pub fn read_lines(mut source: impl Read, mut on_line: impl FnMut(String) -> ControlFlow<()>) {
    let mut stream = LineStream::default();
    let mut buffer = [0u8; 8192];

    loop {
        match source.read(&mut buffer) {
            // EOF: the process closed the stream, so it has nothing left to
            // say on it.
            Ok(0) => break,
            Ok(count) => {
                for line in stream.push(&buffer[..count]) {
                    // `Break` means there is nowhere left to put a line, so
                    // the tail of the stream is abandoned rather than drained
                    // — including the partial line below.
                    if on_line(line).is_break() {
                        return;
                    }
                }
            }
            Err(_) => break,
        }
    }

    // A process killed mid-write still gets its last line delivered, as it
    // did under `BufRead::lines()`.
    if let Some(line) = stream.finish() {
        let _ = on_line(line);
    }
}

/// A Windows agent's `print` writes CRLF, and the carriage return is framing
/// rather than content. `BufRead::lines()` stripped it for free; once the
/// splitting is done here it has to be stripped by hand.
fn trim_carriage_return(line: &mut String) {
    if line.ends_with('\r') {
        line.pop();
    }
}

/// Whether a line is a message at all. An agent that prints a blank line
/// between objects is not sending anything, and the renderer's parser would
/// refuse it as "not JSON".
fn worth_emitting(line: &str) -> bool {
    !line.trim().is_empty()
}

/// Emit one line under `event`. `false` means the window is gone, so there is
/// nothing left to emit to and the caller should stop reading.
fn emit_line(app: &AppHandle, event: &str, id: &str, line: String) -> bool {
    app.emit(
        event,
        LinePayload {
            id: id.to_string(),
            line,
        },
    )
    .is_ok()
}

fn poisoned<T>(_: T) -> String {
    "io: agent registry is poisoned".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// The failure this prevents: one byte that is not UTF-8 on an agent's
    /// stdout ending the reader loop for good. `BufRead::lines()` — what this
    /// module used — yields `Err(InvalidData)` for such a chunk, so the loop
    /// stopped while the agent went on running, and neither another line nor
    /// the exit event ever arrived. The panel sat on "Working…" for the life
    /// of the app. A Python agent under a cp1252 console produces this with a
    /// single accented character.
    #[test]
    fn survives_a_byte_that_can_never_be_valid() {
        let mut stream = LineStream::default();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"{\"type\":\"hello\",\"version\":1}\n");
        bytes.extend_from_slice(&[0x7B, 0xE9, 0x7D]);
        bytes.push(b'\n');
        bytes.extend_from_slice(b"{\"type\":\"done\"}\n");

        assert_eq!(
            stream.push(&bytes),
            vec![
                "{\"type\":\"hello\",\"version\":1}".to_string(),
                "{\u{FFFD}}".to_string(),
                "{\"type\":\"done\"}".to_string(),
            ],
            "the lines after the bad byte must still be delivered"
        );
    }

    /// The failure this prevents: reading on after the window it was reading
    /// *for* has gone. An agent's stdout emit fails once the webview is torn
    /// down, and a chatty agent would otherwise keep a thread spinning
    /// through megabytes with nowhere to put them, for as long as the process
    /// lives.
    #[test]
    fn stops_reading_when_the_caller_breaks() {
        let mut seen = Vec::new();
        read_lines(Cursor::new(b"first\nsecond\nthird\n"), |line| {
            let stop = line == "second";
            seen.push(line);
            if stop {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }
        });

        assert_eq!(
            seen,
            vec!["first".to_string(), "second".to_string()],
            "nothing after the break should be read"
        );
    }

    /// A read boundary falls wherever the kernel put it, including inside a
    /// character. Delegated to `pty::Utf8Stream`, which holds the incomplete
    /// tail back; this asserts the delegation actually happens rather than
    /// each half being decoded on its own into two replacement glyphs.
    #[test]
    fn carries_a_character_split_across_reads() {
        let text = "{\"note\":\"caf\u{e9}\"}\n";
        let bytes = text.as_bytes();
        // Split between the two bytes of 'é'.
        let split = text.find('\u{e9}').unwrap() + 1;

        let mut stream = LineStream::default();
        assert_eq!(stream.push(&bytes[..split]), Vec::<String>::new());
        assert_eq!(stream.push(&bytes[split..]), vec!["{\"note\":\"caf\u{e9}\"}".to_string()]);
    }

    /// A line arriving in pieces must not be emitted until its newline does,
    /// or half a JSON object reaches the renderer's parser.
    #[test]
    fn holds_a_line_back_until_its_newline_arrives() {
        let mut stream = LineStream::default();

        assert_eq!(stream.push(b"{\"type\":"), Vec::<String>::new());
        assert_eq!(stream.push(b"\"done\"}"), Vec::<String>::new());
        assert_eq!(stream.push(b"\n"), vec!["{\"type\":\"done\"}".to_string()]);
    }

    /// The failure this prevents: a Windows agent whose `print` writes CRLF
    /// having the carriage return carried into the JSON parser. Free with
    /// `BufRead::lines()`, which strips it; not free once the splitting is
    /// done here.
    #[test]
    fn strips_the_carriage_return_of_a_crlf_agent() {
        let mut stream = LineStream::default();

        assert_eq!(
            stream.push(b"{\"type\":\"done\"}\r\n"),
            vec!["{\"type\":\"done\"}".to_string()]
        );
    }

    /// An agent that writes its last message without a trailing newline, or
    /// is killed mid-write, still gets that message delivered.
    #[test]
    fn delivers_a_final_line_that_never_got_its_newline() {
        let mut stream = LineStream::default();
        stream.push(b"{\"type\":\"done\"}");

        assert_eq!(stream.finish(), Some("{\"type\":\"done\"}".to_string()));
        assert_eq!(stream.finish(), None, "there is nothing left the second time");
    }

    /// Blank lines are not messages — an agent that prints an extra newline
    /// between objects is not sending anything, and the renderer's parser
    /// would refuse it as "not JSON".
    #[test]
    fn treats_a_blank_line_as_nothing_to_send() {
        assert!(!worth_emitting(""));
        assert!(!worth_emitting("   "));
        assert!(worth_emitting("{}"));
    }
}

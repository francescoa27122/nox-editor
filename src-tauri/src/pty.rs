//! Pseudo-terminal sessions.
//!
//! A terminal is not a pipe. `agent.rs` hands a child process piped stdio,
//! which is right for a program that speaks a protocol — but a shell given
//! pipes sees `isatty` return false and turns itself off: no prompt, no
//! colour, no line editing, and `vim` or `less` refuse to run at all. A pty
//! makes the kernel present a real terminal, which is the only way those
//! programs behave normally.
//!
//! Two consequences shape this module.
//!
//! **Output is a byte stream, not lines.** A prompt — `$ ` — has no trailing
//! newline. Line-buffered reads, as in `agent.rs`, would hold it back until
//! the user typed something, so the terminal would look frozen at the moment
//! it is actually ready. A chunk that follows a quiet spell is forwarded the
//! instant it arrives; a burst is batched, and `coalesce` says how.
//!
//! **A read boundary falls anywhere, including mid-character.** A UTF-8
//! sequence split across two reads must not arrive as two broken ones, so
//! `Utf8Stream` holds the incomplete tail back for the next chunk.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::ops::ControlFlow;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::agent::wait_unlocked;

pub type Result<T> = std::result::Result<T, String>;

#[derive(Default)]
pub struct PtyState(Mutex<HashMap<String, Session>>);

struct Session {
    /// Kept for resize: the pty size is a property of the master, and a
    /// program only learns the window changed because the kernel sends it
    /// SIGWINCH when this is set.
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

#[derive(Clone, Serialize)]
struct DataPayload {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    id: String,
    code: Option<i32>,
}

/// Reassembles UTF-8 across read boundaries.
///
/// Separate from the reading so it can be tested without a terminal: a
/// character split by a chunk boundary is near impossible to provoke on
/// purpose against a real shell, and trivial to write down here.
#[derive(Default)]
pub struct Utf8Stream {
    carry: Vec<u8>,
}

impl Utf8Stream {
    /// Decode everything complete. Bytes belonging to a character the read
    /// boundary cut in half are held for the next call.
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.carry.extend_from_slice(bytes);
        let mut out = String::new();

        loop {
            match std::str::from_utf8(&self.carry) {
                Ok(text) => {
                    out.push_str(text);
                    self.carry.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    if valid > 0 {
                        // Validity checked immediately above.
                        match std::str::from_utf8(&self.carry[..valid]) {
                            Ok(text) => out.push_str(text),
                            Err(_) => break,
                        }
                    }
                    match error.error_len() {
                        // Genuinely malformed — a binary file catted into the
                        // terminal, say. Substitute and move on; carrying it
                        // would stall every later byte behind bytes that can
                        // never become valid.
                        Some(len) => {
                            out.push('\u{FFFD}');
                            self.carry.drain(..valid + len);
                        }
                        // Truncated by the boundary: wait for the rest.
                        None => {
                            self.carry.drain(..valid);
                            break;
                        }
                    }
                }
            }
        }

        out
    }
}

/// Once an event has gone out, hold what arrives next for at most this long
/// before the next one. One frame: a burst costs the webview at most sixty
/// events a second per session, and typing never notices, because a
/// keystroke's echo arrives long after the previous event went out.
pub const COALESCE_INTERVAL: Duration = Duration::from_millis(16);
/// ...or send the batch as soon as this much is pending, whichever is first,
/// so a firehose becomes a stream of bounded events rather than one huge one.
pub const COALESCE_BYTES: usize = 64 * 1024;

/// Turn a stream of chunks into one event per burst.
///
/// The reader threads used to `emit` every chunk the instant it was read.
/// Each emit serialises JSON and posts a script evaluation to the webview's
/// main thread, and nothing throttled it, so `cat` of a large file or a
/// verbose build queued tens of thousands of main-thread hops and the editor
/// stopped responding until they drained. `search.rs` batches for the same
/// reason; this is the same idea for the streaming processes.
///
/// The rule is a rate limit, not a delay. The first chunk after a quiet spell
/// goes out at once, so a prompt or a keystroke's echo pays nothing. A chunk
/// arriving within `COALESCE_INTERVAL` of the last event is held, joined with
/// whatever else arrives before the interval is up or `COALESCE_BYTES` is
/// pending, and sent as one event. Order is the channel's order. When the
/// sender goes away, whatever is held goes out and the function returns, so
/// the caller can emit its exit event knowing it follows the last data.
///
/// `emit` returns `Break` when there is nowhere left to put an event, the
/// window being gone, and the loop ends there. Dropping the receiver is what
/// then tells the reader thread to stop: its next `send` fails.
///
/// Generic over the chunk so `agent.rs` can batch lines with the same code,
/// with `size_of` supplying the byte count the cap is measured in.
pub fn coalesce<T>(
    source: Receiver<T>,
    size_of: impl Fn(&T) -> usize,
    mut emit: impl FnMut(Vec<T>) -> ControlFlow<()>,
) {
    let mut last_emit: Option<Instant> = None;
    loop {
        let Ok(first) = source.recv() else { return };
        let mut pending = size_of(&first);
        let mut batch = vec![first];
        let mut disconnected = false;

        if let Some(last) = last_emit {
            let deadline = last + COALESCE_INTERVAL;
            while pending < COALESCE_BYTES {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                match source.recv_timeout(deadline - now) {
                    Ok(chunk) => {
                        pending += size_of(&chunk);
                        batch.push(chunk);
                    }
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => {
                        disconnected = true;
                        break;
                    }
                }
            }
        }

        if emit(batch).is_break() || disconnected {
            return;
        }
        last_emit = Some(Instant::now());
    }
}

/// What to start, and how big the window is.
pub struct Spec {
    /// Defaults to the user's login shell.
    pub shell: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

/// Open a pty and start a program in it.
///
/// Deliberately free of `AppHandle` so the tests below can drive a real
/// terminal without a Tauri application around it.
fn open(spec: &Spec) -> Result<(Session, Box<dyn Read + Send>)> {
    let pair = native_pty_system()
        .openpty(PtySize {
            // A zero-sized terminal makes curses programs divide by zero.
            rows: spec.rows.max(1),
            cols: spec.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty: could not open a terminal ({e})"))?;

    let program = spec.shell.clone().unwrap_or_else(default_shell);
    let mut command = CommandBuilder::new(&program);
    command.args(&spec.args);
    if let Some(directory) = &spec.cwd {
        command.cwd(directory);
    }
    // Without TERM a program cannot discover what the terminal can do and
    // assumes the worst: no colour, no cursor addressing.
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| format!("spawn: could not start {program} ({e})"))?;

    // The slave handle must go now. While any handle to it remains open the
    // master never reaches EOF, so the reader below would block for ever
    // after the shell exits and the session would never report as finished.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty: could not read the terminal ({e})"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty: could not write to the terminal ({e})"))?;

    Ok((
        Session {
            master: pair.master,
            writer,
            child: Arc::new(Mutex::new(child)),
        },
        reader,
    ))
}

fn default_shell() -> String {
    #[cfg(unix)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
    #[cfg(windows)]
    {
        std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string())
    }
}

/// Open a terminal. `id` is chosen by the renderer, as for agents, so output
/// can be routed without a round trip to learn what the session was called.
// Eight parameters, and the shape is not ours to choose: a `#[tauri::command]`
// takes its arguments by name from the renderer's call, so the list *is* the
// IPC contract. `app` and `state` are injected by Tauri and never appear on
// the wire, which leaves the six the caller actually passes. Collapsing the
// rest into a struct would nest them under one key on the JavaScript side and
// break every existing caller to satisfy a count.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn nox_pty_open(
    app: AppHandle,
    state: State<'_, PtyState>,
    id: String,
    shell: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<()> {
    if state.0.lock().map_err(poisoned)?.contains_key(&id) {
        return Err(format!("exists: a terminal with id {id} is already open"));
    }

    let (session, mut reader) = open(&Spec {
        shell,
        args: args.unwrap_or_default(),
        cwd,
        cols,
        rows,
    })?;

    let child = Arc::clone(&session.child);
    // Two threads per terminal. The reader does nothing but read and decode,
    // so it is never the one waiting on the webview; the emitter turns what
    // the reader produced into one event per burst (`coalesce` says why) and
    // reaps the child once the reader is done, which keeps the exit event
    // behind the last of the data.
    let (sender, receiver) = channel::<String>();
    std::thread::spawn(move || {
        let mut decoder = Utf8Stream::default();
        let mut buffer = [0u8; 8192];

        loop {
            match reader.read(&mut buffer) {
                // EOF: the last handle to the slave closed, so the program
                // is gone.
                Ok(0) => break,
                Ok(count) => {
                    let data = decoder.push(&buffer[..count]);
                    if data.is_empty() {
                        continue;
                    }
                    // A failed send means the emitter has stopped, which
                    // means the window is gone.
                    if sender.send(data).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    {
        let app = app.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            coalesce(
                receiver,
                |data| data.len(),
                |batch| {
                    let payload = DataPayload {
                        id: id.clone(),
                        data: batch.concat(),
                    };
                    // A failed emit means the window is gone.
                    if app.emit("nox://pty-data", payload).is_ok() {
                        ControlFlow::Continue(())
                    } else {
                        ControlFlow::Break(())
                    }
                },
            );

            // Reaping here stops the child becoming a zombie when nobody calls
            // close, exactly as in `agent.rs`, and with the same reaper: a
            // shell that closed the pty but left a background job running
            // must not hold the lock `close` needs.
            let code = wait_unlocked(&child, |child| child.try_wait())
                .map(|status| status.exit_code() as i32);

            // Forget it: the entry is stale now the child is gone. Left in place,
            // a later `close` for this id would act on a dead child, `close_all` would
            // iterate it, and the registry would grow by one for every terminal that
            // ever ran. A reload cannot collide on the id, whatever this comment
            // once said: `platform/tauri.ts` puts a per-load token in every id, so
            // a fresh renderer never reuses one.
            if let Some(state) = app.try_state::<PtyState>() {
                if let Ok(mut sessions) = state.0.lock() {
                    sessions.remove(&id);
                }
            }

            let _ = app.emit("nox://pty-exit", ExitPayload { id, code });
        });
    }

    state.0.lock().map_err(poisoned)?.insert(id, session);
    Ok(())
}

/// Write to a terminal.
///
/// Raw, with no newline added — unlike `nox_agent_send`. Keystrokes are what
/// arrives here, and a terminal distinguishes Return from Ctrl-C from an
/// arrow key by the exact bytes it is given.
///
/// Stays a plain `#[tauri::command]` on purpose. Keystrokes are sent without
/// being awaited, and a sync body runs to completion before the next IPC
/// message is read, so they reach the shell in the order they were typed.
/// Under `(async)` each would be its own pool task and two could swap.
#[tauri::command]
pub fn nox_pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<()> {
    let mut sessions = state.0.lock().map_err(poisoned)?;
    let Some(session) = sessions.get_mut(&id) else {
        return Err(format!("not-found: no terminal {id}"));
    };

    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|e| format!("io: could not write to terminal {id} ({e})"))
}

/// Tell a terminal its window changed size.
///
/// Not cosmetic: the size is how a program knows where to wrap and redraw, so
/// without this a resized window leaves the shell writing to the old geometry.
#[tauri::command]
pub fn nox_pty_resize(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<()> {
    let sessions = state.0.lock().map_err(poisoned)?;
    let Some(session) = sessions.get(&id) else {
        return Err(format!("not-found: no terminal {id}"));
    };

    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty: could not resize terminal {id} ({e})"))
}

/// Close a terminal and forget it. Safe on one that has already exited.
#[tauri::command]
pub fn nox_pty_close(state: State<'_, PtyState>, id: String) -> Result<()> {
    let Some(session) = state.0.lock().map_err(poisoned)?.remove(&id) else {
        return Ok(());
    };
    stop(session);
    Ok(())
}

/// Close every terminal. Called when the window goes away, so a reload does
/// not leave orphaned shells running with nothing attached to them.
#[tauri::command]
pub fn nox_pty_close_all(state: State<'_, PtyState>) -> Result<()> {
    let sessions: Vec<Session> = state
        .0
        .lock()
        .map_err(poisoned)?
        .drain()
        .map(|(_, session)| session)
        .collect();

    for session in sessions {
        stop(session);
    }
    Ok(())
}

fn stop(session: Session) {
    // Dropping the writer closes the master, which sends the foreground
    // program EOF — how a well-behaved shell is asked to leave. The kill is
    // for the ones that will not.
    drop(session.writer);
    if let Ok(mut child) = session.child.lock() {
        let _ = child.kill();
    }
}

fn poisoned<T>(_: T) -> String {
    "io: terminal registry is poisoned".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    /// The failure this prevents: one webview event per read. `cat` of a
    /// large file or a verbose build produced tens of thousands of
    /// main-thread emits and the editor stopped responding until they had
    /// drained. A burst has to arrive as a few events, in order, with nothing
    /// dropped and the tail delivered once the sender is gone.
    ///
    /// What it does not catch: how the webview copes with the events it does
    /// get. There is still no acknowledgement from xterm back to Rust.
    #[test]
    fn joins_a_burst_into_fewer_events_without_reordering() {
        let (sender, receiver) = channel();
        let chunks: Vec<String> = (0..200).map(|i| format!("chunk-{i};")).collect();
        let expected = chunks.concat();
        std::thread::spawn(move || {
            for chunk in chunks {
                sender.send(chunk).expect("the emitter is still listening");
            }
        });

        let mut events = Vec::new();
        coalesce(
            receiver,
            |chunk: &String| chunk.len(),
            |batch| {
                events.push(batch.concat());
                ControlFlow::Continue(())
            },
        );

        assert_eq!(events.concat(), expected, "every byte, in the order it was read");
        assert!(events.len() < 200, "200 chunks became {} events", events.len());
    }

    /// A batch stops growing at the byte budget, so a firehose becomes a
    /// stream of bounded events rather than one enormous one the webview
    /// parses in a single go. Everything is queued before the loop starts,
    /// which makes the split deterministic: the first chunk goes out alone
    /// (nothing has been emitted yet), then pairs up to the cap, then the
    /// remainder.
    #[test]
    fn caps_a_batch_at_the_byte_budget() {
        let (sender, receiver) = channel();
        let chunk = "x".repeat(COALESCE_BYTES / 2 + 1);
        for _ in 0..6 {
            sender.send(chunk.clone()).expect("the emitter is still listening");
        }
        drop(sender);

        let mut sizes = Vec::new();
        coalesce(
            receiver,
            |chunk: &String| chunk.len(),
            |batch| {
                sizes.push(batch.concat().len());
                ControlFlow::Continue(())
            },
        );

        let c = chunk.len();
        assert_eq!(sizes, vec![c, 2 * c, 2 * c, c]);
    }

    /// The first chunk after a quiet spell goes out at once. A prompt has no
    /// trailing newline and nothing follows it until the user types, so a
    /// coalescer that waited for company would show a terminal that looks
    /// frozen at the moment it is ready, the failure the module comment warns
    /// about.
    #[test]
    fn a_lone_chunk_is_not_held_back_for_company() {
        let (sender, receiver) = channel();
        let (seen_sender, seen) = channel();
        let emitter = std::thread::spawn(move || {
            coalesce(
                receiver,
                |chunk: &String| chunk.len(),
                |batch| {
                    seen_sender.send(batch.concat()).expect("the test is still waiting");
                    ControlFlow::Continue(())
                },
            );
        });

        sender.send("$ ".to_string()).expect("the emitter is running");
        let prompt = seen
            .recv_timeout(Duration::from_secs(5))
            .expect("the prompt must arrive while the sender is still open");
        assert_eq!(prompt, "$ ");

        drop(sender);
        emitter.join().expect("emitter thread");
    }

    /// `Break` from the emitter is the window going away. The loop ends, and
    /// dropping the receiver is what stops the reader thread: its next send
    /// fails, so it does not spin through megabytes with nowhere to put them.
    #[test]
    fn stops_reading_when_the_emitter_breaks() {
        let (sender, receiver) = channel();
        sender.send("a".to_string()).expect("the emitter is listening");

        let mut events = 0;
        coalesce(
            receiver,
            |chunk: &String| chunk.len(),
            |_| {
                events += 1;
                ControlFlow::Break(())
            },
        );

        assert_eq!(events, 1);
        assert!(
            sender.send("b".to_string()).is_err(),
            "the receiver must be gone once the emitter broke"
        );
    }

    #[test]
    fn decodes_plain_text_in_one_piece() {
        let mut stream = Utf8Stream::default();
        assert_eq!(stream.push(b"hello"), "hello");
    }

    /// The failure this prevents: a chunk boundary landing inside a multi-byte
    /// character and each half being decoded separately, which turns one
    /// character into two replacement glyphs. Real terminals hit this as soon
    /// as output is non-English or contains box-drawing characters.
    #[test]
    fn carries_a_character_split_across_reads() {
        let text = "héllo";
        let bytes = text.as_bytes();
        // 'é' is two bytes; split between them.
        let split = 2;

        let mut stream = Utf8Stream::default();
        let first = stream.push(&bytes[..split]);
        let second = stream.push(&bytes[split..]);

        assert_eq!(first, "h", "the incomplete character must be held back");
        assert_eq!(format!("{first}{second}"), text);
    }

    /// Same, for a four-byte character split three ways — an emoji arriving
    /// one byte at a time is what a slow pipe actually looks like.
    #[test]
    fn carries_a_character_split_many_ways() {
        let text = "a🎉b";
        let mut stream = Utf8Stream::default();

        let mut out = String::new();
        for byte in text.as_bytes() {
            out.push_str(&stream.push(&[*byte]));
        }

        assert_eq!(out, text);
    }

    /// The failure this prevents: holding malformed bytes back for ever,
    /// which would stall every valid byte queued behind them. `cat`ting a
    /// binary is enough to produce these.
    #[test]
    fn replaces_bytes_that_can_never_be_valid() {
        let mut stream = Utf8Stream::default();
        let out = stream.push(&[0x68, 0xFF, 0x69]);

        assert_eq!(out, "h\u{FFFD}i");
    }

    /// Reads until `marker` shows up or the deadline passes, so a broken
    /// terminal fails the test instead of hanging CI for ever.
    #[cfg(unix)]
    fn read_until(mut reader: Box<dyn Read + Send>, marker: &str) -> String {
        let seen = Arc::new(Mutex::new(String::new()));
        let collected = Arc::clone(&seen);

        std::thread::spawn(move || {
            let mut decoder = Utf8Stream::default();
            let mut buffer = [0u8; 1024];
            while let Ok(count) = reader.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                let text = decoder.push(&buffer[..count]);
                if let Ok(mut seen) = collected.lock() {
                    seen.push_str(&text);
                }
            }
        });

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(seen) = seen.lock() {
                if seen.contains(marker) {
                    return seen.clone();
                }
            }
            if Instant::now() > deadline {
                return seen.lock().map(|s| s.clone()).unwrap_or_default();
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(unix)]
    #[test]
    fn runs_a_command_in_a_real_terminal() {
        let (session, reader) = open(&Spec {
            shell: Some("/bin/sh".into()),
            args: vec!["-c".into(), "echo hello-from-nox".into()],
            cwd: None,
            cols: 80,
            rows: 24,
        })
        .expect("open a pty");

        let output = read_until(reader, "hello-from-nox");
        stop(session);

        assert!(
            output.contains("hello-from-nox"),
            "expected the command's output, got {output:?}"
        );
    }

    /// The whole reason this module exists rather than reusing `agent.rs`.
    /// Under piped stdio `test -t 1` is false and programs disable colour and
    /// interactivity; under a pty it is true. If this ever fails, Nox is
    /// running a pipe and calling it a terminal.
    #[cfg(unix)]
    #[test]
    fn the_program_sees_an_actual_terminal() {
        let (session, reader) = open(&Spec {
            shell: Some("/bin/sh".into()),
            args: vec![
                "-c".into(),
                "test -t 1 && echo IS-A-TTY || echo NOT-A-TTY".into(),
            ],
            cwd: None,
            cols: 80,
            rows: 24,
        })
        .expect("open a pty");

        let output = read_until(reader, "-A-TTY");
        stop(session);

        assert!(
            output.contains("IS-A-TTY"),
            "the child must see a terminal on stdout, got {output:?}"
        );
    }

    /// The size is passed through to the kernel, not just remembered by Nox —
    /// `stty size` asks the terminal itself.
    #[cfg(unix)]
    #[test]
    fn the_terminal_has_the_size_it_was_opened_with() {
        let (session, reader) = open(&Spec {
            shell: Some("/bin/sh".into()),
            args: vec!["-c".into(), "stty size".into()],
            cwd: None,
            cols: 100,
            rows: 30,
        })
        .expect("open a pty");

        let output = read_until(reader, "30");
        stop(session);

        assert!(
            output.contains("30 100"),
            "expected rows and columns from stty, got {output:?}"
        );
    }

    /// The failure this prevents: a terminal started in the wrong directory,
    /// which is what happens if `cwd` is accepted and quietly dropped.
    #[cfg(unix)]
    #[test]
    fn starts_in_the_directory_it_was_given() {
        let directory = std::env::temp_dir();
        let (session, reader) = open(&Spec {
            shell: Some("/bin/sh".into()),
            args: vec!["-c".into(), "pwd".into()],
            cwd: Some(directory.to_string_lossy().into_owned()),
            cols: 80,
            rows: 24,
        })
        .expect("open a pty");

        let output = read_until(reader, "/");
        stop(session);

        // macOS reports /private/var/... for /var/..., so compare the tail.
        let expected = directory.to_string_lossy().trim_end_matches('/').to_string();
        let leaf = expected.rsplit('/').next().unwrap_or(&expected);
        assert!(
            output.contains(leaf),
            "expected the terminal's cwd to contain {leaf:?}, got {output:?}"
        );
    }
}

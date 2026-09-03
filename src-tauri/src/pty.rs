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
//! it is actually ready. Chunks are forwarded the instant they arrive.
//!
//! **A read boundary falls anywhere, including mid-character.** A UTF-8
//! sequence split across two reads must not arrive as two broken ones, so
//! `Utf8Stream` holds the incomplete tail back for the next chunk.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

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
    {
        let app = app.clone();
        let id = id.clone();
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
                        // A failed emit means the window is gone.
                        if app
                            .emit(
                                "nox://pty-data",
                                DataPayload {
                                    id: id.clone(),
                                    data,
                                },
                            )
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }

            // Reaping here stops the child becoming a zombie when nobody calls
            // close, exactly as in `agent.rs`.
            let code = child
                .lock()
                .ok()
                .and_then(|mut child| child.wait().ok())
                .map(|status| status.exit_code() as i32);

            // Forget it, or the id stays registered for the life of the app and
            // opening under it again is refused as "already open" — which is
            // what happens after a reload restarts the renderer's counter.
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
    state.close_all()
}

impl PtyState {
    /// Close every terminal. Also the exit hook's call in `lib.rs`, for the
    /// same reason as `AgentState::kill_all`: a quit that skips the
    /// renderer's `beforeunload` must not leave shells behind.
    pub fn close_all(&self) -> Result<()> {
        let sessions: Vec<Session> = self
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
    // Only `read_until` uses these, and it is `#[cfg(unix)]` — the pty tests
    // that need a real shell do not run on Windows. Ungated, this import was
    // dead on the Windows leg: `cargo test` printed the warning and passed
    // anyway, so it sat there until Clippy's `-D warnings` made it a failure.
    #[cfg(unix)]
    use std::time::{Duration, Instant};

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

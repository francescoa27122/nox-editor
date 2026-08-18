//! Language server supervision.
//!
//! `agent.rs` moves lines; this moves length-prefixed messages. The difference
//! is not cosmetic. An LSP body carries no trailing newline, so a line-buffered
//! reader holds every message until the *next* one arrives — the handshake
//! appears to hang, and all traffic afterwards runs one message late.
//!
//! The framing lives here rather than in the renderer because `Content-Length`
//! counts **bytes**, while everything across the IPC boundary is a decoded
//! string whose length is in UTF-16 code units. A body of
//! `{"label":"café — naïve"}` is 4 bytes longer than it is characters long, so
//! framing computed on the far side desynchronises on the first accented hover
//! string and never recovers.
//!
//! What a message *means* is decided in the renderer, in `services/lsp/`,
//! where it can be unit-tested against a fake server instead of a real one.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Suppresses the console window Windows would otherwise give a
/// console-subsystem child of a GUI process. `winbase.h`'s value; not worth a
/// dependency on the `windows` crate for one constant.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub type Result<T> = std::result::Result<T, String>;

#[derive(Default)]
pub struct LspState(Mutex<HashMap<String, Running>>);

struct Running {
    child: Arc<Mutex<Child>>,
    stdin: ChildStdin,
}

#[derive(Clone, Serialize)]
struct MessagePayload {
    id: String,
    message: String,
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

/// Reassembles `Content-Length`-framed messages across read boundaries.
///
/// Separate from the reading so it can be tested without a server, exactly as
/// `pty.rs` separates `Utf8Stream`: a read boundary falling inside a header is
/// near impossible to provoke on purpose against a real server, and trivial to
/// write down here.
#[derive(Default)]
pub struct MessageStream {
    buffer: Vec<u8>,
}

impl MessageStream {
    /// Take some bytes; return every complete message they finished.
    ///
    /// Decoding happens only once a whole body is in hand, which is the whole
    /// point: the length is a byte count, so it cannot be applied to text.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>> {
        self.buffer.extend_from_slice(bytes);
        let mut out = Vec::new();

        loop {
            let Some(header_end) = find(&self.buffer, b"\r\n\r\n") else {
                return Ok(out);
            };

            let header = std::str::from_utf8(&self.buffer[..header_end])
                .map_err(|_| "lsp: header was not utf-8".to_string())?;

            let mut length: Option<usize> = None;
            for line in header.split("\r\n") {
                let Some((name, value)) = line.split_once(':') else {
                    continue;
                };
                if name.eq_ignore_ascii_case("content-length") {
                    length = Some(
                        value
                            .trim()
                            .parse()
                            .map_err(|_| format!("lsp: bad Content-Length {value:?}"))?,
                    );
                }
            }

            // A stream that has lost its framing cannot be recovered by
            // guessing where the next message starts, so this is an error
            // rather than a resync.
            let Some(length) = length else {
                return Err("lsp: message with no Content-Length".to_string());
            };

            let body_start = header_end + 4;
            if self.buffer.len() < body_start + length {
                return Ok(out); // Body still arriving.
            }

            let body = &self.buffer[body_start..body_start + length];
            let message = String::from_utf8(body.to_vec())
                .map_err(|_| "lsp: body was not utf-8".to_string())?;
            out.push(message);

            self.buffer.drain(..body_start + length);
        }
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.len() > haystack.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Frame one message for writing.
///
/// `message.len()` is a byte count here because this is Rust and `str::len`
/// counts bytes — the same expression in the renderer would count UTF-16 code
/// units and be wrong.
pub fn frame(message: &str) -> Vec<u8> {
    let mut out = format!("Content-Length: {}\r\n\r\n", message.len()).into_bytes();
    out.extend_from_slice(message.as_bytes());
    out
}

/// Start the server process, with the pipes it needs.
///
/// On Windows a second attempt goes through `cmd /C`. Most language servers
/// are installed by npm, which puts a `.cmd` shim on `PATH` rather than an
/// executable — `typescript-language-server` is one, and it is the command the
/// `servers.json` template ships. `CreateProcess`, which `Command` uses, runs
/// `.exe` and not `.cmd`, so the direct attempt fails with "program not found"
/// for exactly the configuration Nox recommends.
///
/// Direct first, so a real executable never goes through a shell: `cmd /C`
/// re-splits its command line on spaces, and a server installed under
/// `C:\Program Files` would break in a way that reports the wrong cause.
fn spawn_server(command: &str, args: &[String], cwd: Option<&str>) -> std::io::Result<Child> {
    fn build(program: &str, args: &[String], cwd: Option<&str>) -> Command {
        let mut builder = Command::new(program);
        builder
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(directory) = cwd {
            builder.current_dir(directory);
        }

        // Windows gives a console-subsystem child its own window when the
        // parent is a GUI app. A language server is one, and so is the `cmd`
        // that launches a `.cmd` shim — so without this an empty console sits
        // in front of the editor for the whole session, looking like something
        // hung. It is empty because the server's output is piped here, and it
        // never closes because the server is meant to keep running.
        #[cfg(windows)]
        builder.creation_flags(CREATE_NO_WINDOW);

        builder
    }

    let direct = build(command, args, cwd).spawn();

    // Any failure retries, not only `NotFound`. A bare command that PATH only
    // resolves to a `.cmd` fails as NotFound, but an *absolute* path to one
    // that exists fails differently — `CreateProcess` rejects it as not a
    // valid executable — and someone writing a full path into `servers.json`
    // is at least as likely as someone relying on PATH.
    #[cfg(windows)]
    if direct.is_err() {
        let mut shell_args = vec!["/C".to_string(), command.to_string()];
        shell_args.extend_from_slice(args);
        if let Ok(child) = build("cmd", &shell_args, cwd).spawn() {
            return Ok(child);
        }
        // The shell could not start it either, so the first error is the one
        // worth reporting: it names the command the user actually wrote.
    }

    direct
}

/// Start a language server. `id` is chosen by the renderer so replies can be
/// matched without a round trip to learn what the process was called.
#[tauri::command]
pub fn nox_lsp_start(
    app: AppHandle,
    state: State<'_, LspState>,
    id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<()> {
    if state.0.lock().map_err(poisoned)?.contains_key(&id) {
        return Err(format!("exists: a language server with id {id} is already running"));
    }

    let mut child = match spawn_server(&command, &args, cwd.as_deref()) {
        Ok(child) => child,
        Err(e) => return Err(format!("spawn: could not start {command} ({e})")),
    };

    let streams = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let (Some(stdin), Some(mut stdout), Some(stderr)) = streams else {
        let _ = child.kill();
        return Err(format!("spawn: {command} did not give Nox its pipes"));
    };

    let child = Arc::new(Mutex::new(child));

    // stdout: bytes in, whole messages out. Reading into a fixed buffer rather
    // than by line is the entire difference from `agent.rs` — an LSP body has
    // no trailing newline, so a line reader would hold every message until the
    // next one arrived.
    {
        let app = app.clone();
        let id = id.clone();
        let child = Arc::clone(&child);
        std::thread::spawn(move || {
            let mut stream = MessageStream::default();
            let mut chunk = [0u8; 8192];

            loop {
                let read = match stdout.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };

                let messages = match stream.push(&chunk[..read]) {
                    Ok(messages) => messages,
                    Err(error) => {
                        // Framing is lost and cannot be guessed back. Say so on
                        // the channel built for saying so, and stop rather than
                        // emit garbage the renderer would try to parse.
                        let _ = app.emit(
                            "nox://lsp-stderr",
                            LinePayload {
                                id: id.clone(),
                                line: error,
                            },
                        );
                        break;
                    }
                };

                let mut window_gone = false;
                for message in messages {
                    // A failed emit means the window is gone; nothing to recover.
                    if app
                        .emit(
                            "nox://lsp-message",
                            MessagePayload {
                                id: id.clone(),
                                message,
                            },
                        )
                        .is_err()
                    {
                        window_gone = true;
                        break;
                    }
                }
                if window_gone {
                    break;
                }
            }

            // stdout closing is the earliest reliable sign the server is done.
            // Reaping here also stops the child becoming a zombie when nobody
            // calls `stop`.
            let code = child
                .lock()
                .ok()
                .and_then(|mut child| child.wait().ok())
                .and_then(|status| status.code());

            // Forget it, or the id stays registered for the life of the app and
            // starting under it again is refused as "already running" — which
            // is exactly what happens after the window reloads and the
            // renderer's counter starts over.
            if let Some(state) = app.try_state::<LspState>() {
                if let Ok(mut servers) = state.0.lock() {
                    servers.remove(&id);
                }
            }

            let _ = app.emit("nox://lsp-exit", ExitPayload { id, code });
        });
    }

    // stderr is diagnostics about the server, never protocol. Forwarded under
    // its own event so a server that dies during its handshake says why
    // instead of just disappearing.
    {
        let app = app.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                let _ = app.emit(
                    "nox://lsp-stderr",
                    LinePayload {
                        id: id.clone(),
                        line,
                    },
                );
            }
        });
    }

    state
        .0
        .lock()
        .map_err(poisoned)?
        .insert(id, Running { child, stdin });
    Ok(())
}

/// Send one message. The framing is added here so a caller cannot half-send a
/// message by computing its length on the wrong side of the encoding.
#[tauri::command]
pub fn nox_lsp_send(state: State<'_, LspState>, id: String, message: String) -> Result<()> {
    let mut servers = state.0.lock().map_err(poisoned)?;
    let Some(server) = servers.get_mut(&id) else {
        return Err(format!("not-found: no language server {id}"));
    };

    server
        .stdin
        .write_all(&frame(&message))
        .and_then(|_| server.stdin.flush())
        .map_err(|e| format!("io: could not write to language server {id} ({e})"))
}

/// Stop one server and forget it. Safe to call on one that has already exited.
#[tauri::command]
pub fn nox_lsp_stop(state: State<'_, LspState>, id: String) -> Result<()> {
    let Some(server) = state.0.lock().map_err(poisoned)?.remove(&id) else {
        return Ok(());
    };
    stop(server);
    Ok(())
}

/// Stop every server. Called when the window goes away, so a reload does not
/// leave orphans running with nothing left to talk to them.
#[tauri::command]
pub fn nox_lsp_stop_all(state: State<'_, LspState>) -> Result<()> {
    let servers: Vec<Running> = state
        .0
        .lock()
        .map_err(poisoned)?
        .drain()
        .map(|(_, server)| server)
        .collect();

    for server in servers {
        stop(server);
    }
    Ok(())
}

/// Dropping stdin closes it, which is how a well-behaved server is asked to
/// stop once it has had its `exit` notification. The kill is for the others.
fn stop(server: Running) {
    drop(server.stdin);
    if let Ok(mut child) = server.child.lock() {
        let _ = child.kill();
    }
}

fn poisoned<T>(_: T) -> String {
    "io: language server registry is poisoned".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_one_message_in_one_push() {
        let mut stream = MessageStream::default();
        assert_eq!(
            stream.push(&frame(r#"{"a":1}"#)).unwrap(),
            vec![r#"{"a":1}"#.to_string()]
        );
    }

    #[test]
    fn holds_a_message_split_inside_its_header() {
        let mut stream = MessageStream::default();
        let bytes = frame(r#"{"a":1}"#);
        assert!(stream.push(&bytes[..8]).unwrap().is_empty());
        assert_eq!(
            stream.push(&bytes[8..]).unwrap(),
            vec![r#"{"a":1}"#.to_string()]
        );
    }

    #[test]
    fn holds_a_message_split_inside_its_body() {
        let mut stream = MessageStream::default();
        let bytes = frame(r#"{"a":1}"#);
        let cut = bytes.len() - 3;
        assert!(stream.push(&bytes[..cut]).unwrap().is_empty());
        assert_eq!(
            stream.push(&bytes[cut..]).unwrap(),
            vec![r#"{"a":1}"#.to_string()]
        );
    }

    #[test]
    fn reads_two_messages_from_one_push() {
        let mut stream = MessageStream::default();
        let mut bytes = frame(r#"{"a":1}"#);
        bytes.extend_from_slice(&frame(r#"{"b":2}"#));
        assert_eq!(
            stream.push(&bytes).unwrap(),
            vec![r#"{"a":1}"#.to_string(), r#"{"b":2}"#.to_string()]
        );
    }

    #[test]
    fn a_blank_line_inside_a_string_is_body_not_a_header_break() {
        // The length is authoritative. Scanning for the separator alone would
        // cut this message in half and resynchronise onto garbage.
        let body = r#"{"a":"x\r\n\r\ny"}"#;
        let mut stream = MessageStream::default();
        assert_eq!(stream.push(&frame(body)).unwrap(), vec![body.to_string()]);
    }

    #[test]
    fn counts_bytes_rather_than_characters() {
        // The case the whole design turns on: this body is longer in bytes
        // than in characters, so a length applied to text truncates it.
        let body = r#"{"label":"café — naïve"}"#;
        assert!(body.len() > body.chars().count());

        let mut stream = MessageStream::default();
        assert_eq!(stream.push(&frame(body)).unwrap(), vec![body.to_string()]);
    }

    #[test]
    fn errors_on_a_header_with_no_length_rather_than_hanging() {
        let mut stream = MessageStream::default();
        assert!(stream.push(b"Content-Type: x\r\n\r\n{}").is_err());
    }

    #[test]
    fn errors_on_an_unparseable_length() {
        let mut stream = MessageStream::default();
        assert!(stream.push(b"Content-Length: abc\r\n\r\n{}").is_err());
    }

    #[test]
    fn tolerates_a_content_type_header_beside_the_length() {
        // Servers are permitted to send one, and several do.
        let body = r#"{"a":1}"#;
        let mut bytes =
            format!("Content-Length: {}\r\nContent-Type: application/vscode-jsonrpc\r\n\r\n", body.len())
                .into_bytes();
        bytes.extend_from_slice(body.as_bytes());

        let mut stream = MessageStream::default();
        assert_eq!(stream.push(&bytes).unwrap(), vec![body.to_string()]);
    }
}

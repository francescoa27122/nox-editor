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
use std::io::{Read, Write};
use std::ops::ControlFlow;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::agent::{read_lines, wait_unlocked};

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

/// The largest body `MessageStream` will wait for: 256 MiB.
///
/// A `Content-Length` is a promise about bytes that have not arrived yet, so
/// without a ceiling one corrupt or hostile header parks the reader waiting
/// for gigabytes that never come, and nothing reports it. The number is far
/// above anything the protocol produces (a full-workspace diagnostics push
/// or a large completion list is single-digit megabytes) and far below the
/// range where the offset arithmetic could wrap.
pub const MAX_BODY_BYTES: usize = 256 * 1024 * 1024;

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

            if length > MAX_BODY_BYTES {
                return Err(format!("lsp: Content-Length {length} is above the {MAX_BODY_BYTES} byte limit"));
            }

            // `checked_add`, not `+`: a length near `usize::MAX` parses, and
            // in release the sum wrapped to a small number, the check below
            // passed on it, and the slice panicked on a thread outside any
            // Tauri catch. With `panic = "abort"` that was the whole editor.
            // The cap above makes this unreachable today; it stays because
            // the cap is a policy and this is the arithmetic.
            let body_start = header_end + 4;
            let Some(body_end) = body_start.checked_add(length) else {
                return Err(format!("lsp: Content-Length {length} out of range"));
            };
            if self.buffer.len() < body_end {
                return Ok(out); // Body still arriving.
            }

            let body = &self.buffer[body_start..body_end];
            let message = String::from_utf8(body.to_vec())
                .map_err(|_| "lsp: body was not utf-8".to_string())?;
            out.push(message);

            self.buffer.drain(..body_end);
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
/// On Windows a second attempt resolves the command to a file. Most language
/// servers are installed by npm, which puts a `.cmd` shim on `PATH` rather
/// than an executable: `typescript-language-server` is one, and it is the
/// command the `servers.json` template ships. `Command` looks for `.exe` and
/// not `.cmd`, so the direct attempt fails with "program not found" for
/// exactly the configuration Nox recommends.
///
/// The second attempt used to be `cmd /C <command> <args...>`, and `cmd`
/// re-parses that line: `&`, `|` and `%VAR%` inside an argument were shell
/// syntax, which contradicted the crate-wide rule that nothing goes through
/// a shell. Now `resolve_shim` finds the file the shell would have found and
/// it is spawned as the program. A `.cmd` still cannot run without
/// `cmd.exe`, but the standard library owns that step: given a program
/// ending in `.bat` or `.cmd` it builds the `cmd.exe /c` line itself, quoting
/// every argument on its own and refusing any it cannot make safe (its
/// BatBadBut mitigation). Nothing here concatenates user text.
///
/// Direct first, so a real executable never goes near `cmd.exe` at all.
fn spawn_server(command: &str, args: &[String], cwd: Option<&str>) -> std::io::Result<Child> {
    fn build(program: impl AsRef<std::ffi::OsStr>, args: &[String], cwd: Option<&str>) -> Command {
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

    // Any failure retries, not only `NotFound`: the resolver decides whether
    // there is a file worth a second attempt, and returns nothing for a
    // command that already names its extension.
    #[cfg(windows)]
    if direct.is_err() {
        let path: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default();
        if let Some(shim) = resolve_shim(command, &path, cwd.map(Path::new)) {
            if let Ok(child) = build(&shim, args, cwd).spawn() {
                return Ok(child);
            }
        }
        // The shim could not start either, so the first error is the one
        // worth reporting: it names the command the user actually wrote.
    }

    direct
}

/// The file the old `cmd /C` fallback would have run for `command`, or
/// `None`. `<command>.exe`, `.cmd` and `.bat` are tried in that order, beside
/// the name when it carries a directory (a relative one against the server's
/// `cwd`, which is where a `node_modules/.bin/...` entry in `servers.json`
/// points), and on each entry of `path` when it is bare.
///
/// Two deliberate differences from the shell. A command that already has an
/// extension gets nothing: the direct spawn tried exactly that file, and
/// `Command` runs a `.cmd` named in full on its own. And a bare name is
/// never taken from the working directory, which `cmd` searches first: the
/// working directory is the workspace, and a repository must not be able to
/// supply the language server for itself by shipping
/// `typescript-language-server.cmd` at its root.
#[cfg(windows)]
fn resolve_shim(command: &str, path: &[PathBuf], cwd: Option<&Path>) -> Option<PathBuf> {
    let given = Path::new(command);
    if given.extension().is_some() {
        return None;
    }

    let has_directory = given.parent().is_some_and(|p| !p.as_os_str().is_empty());
    let bases: Vec<PathBuf> = if has_directory {
        let base = match cwd {
            Some(cwd) if given.is_relative() => cwd.join(given),
            _ => given.to_path_buf(),
        };
        vec![base]
    } else {
        path.iter().map(|dir| dir.join(given)).collect()
    };

    for base in bases {
        for extension in ["exe", "cmd", "bat"] {
            let candidate = base.with_extension(extension);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
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
            // calls `stop`. Polled with the lock released between polls, so a
            // `stop` for a server that closed stdout and kept running does not
            // block behind this; `wait_unlocked` says why.
            let code =
                wait_unlocked(&child, |child| child.try_wait()).and_then(|status| status.code());

            // Forget it: the entry is stale now the child is gone. Left in place,
            // a later `stop` for this id would act on a dead child, `stop_all` would
            // iterate it, and the registry would grow by one for every server that
            // ever ran. A reload cannot collide on the id, whatever this comment
            // once said: `platform/tauri.ts` puts a per-load token in every id, so
            // a fresh renderer never reuses one.
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
            read_lines(stderr, |line| {
                let _ = app.emit(
                    "nox://lsp-stderr",
                    LinePayload {
                        id: id.clone(),
                        line,
                    },
                );
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

/// Send one message. The framing is added here so a caller cannot half-send a
/// message by computing its length on the wrong side of the encoding.
///
/// Stays a plain `#[tauri::command]` on purpose. `didChange` notifications are
/// fired without being awaited, and a sync body runs to completion before the
/// next IPC message is read, which is what keeps their versions in order.
/// Under `(async)` two sends would race for the registry lock and a version
/// could go backwards at the server.
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
    use std::io::Cursor;

    /// The failure this prevents: one byte that is not UTF-8 on a language
    /// server's stderr ending the reader thread for good. `BufRead::lines()`
    /// — what this module used — yields `Err(InvalidData)` for such a chunk,
    /// so the loop stopped while the server went on running, and every later
    /// diagnostic was lost in silence. stdout is byte-framed by
    /// `MessageStream` and was never affected, which is exactly why this went
    /// unnoticed: the editor kept working, and only the one channel that
    /// explains a misbehaving server went quiet.
    ///
    /// One accented character in a path is enough — `rust-analyzer` logging a
    /// cp1252 filename, or a server that writes a raw byte offset into its
    /// own log line.
    #[test]
    fn stderr_survives_a_byte_that_can_never_be_valid() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice("[Error] loading caf\u{e9}/main.rs\n".as_bytes());
        bytes.extend_from_slice(&[0x7B, 0xE9, 0x7D]);
        bytes.push(b'\n');
        bytes.extend_from_slice(b"[Error] server exited with status 101\n");

        let mut lines = Vec::new();
        read_lines(Cursor::new(bytes), |line| {
            lines.push(line);
            ControlFlow::Continue(())
        });

        assert_eq!(
            lines,
            vec![
                "[Error] loading caf\u{e9}/main.rs".to_string(),
                "{\u{FFFD}}".to_string(),
                "[Error] server exited with status 101".to_string(),
            ],
            "the diagnostics after the bad byte must still be delivered"
        );
    }

    /// A server killed mid-write leaves its last diagnostic without a
    /// newline, and that line is usually the one that says why it died.
    /// `BufRead::lines()` delivered it for free; the byte-reading loop only
    /// does so because it drains the stream on the way out.
    #[test]
    fn stderr_delivers_a_last_line_that_never_got_its_newline() {
        let mut lines = Vec::new();
        read_lines(
            Cursor::new(b"[Error] panicked at 'index out of bounds'"),
            |line| {
                lines.push(line);
                ControlFlow::Continue(())
            },
        );

        assert_eq!(
            lines,
            vec!["[Error] panicked at 'index out of bounds'".to_string()]
        );
    }

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

    /// Guards A6-001: a length that parses but cannot be added to the body
    /// offset. In release `body_start + length` wrapped, the "still arriving"
    /// test passed on the wrapped value, and the slice panicked; the reader
    /// thread is outside any Tauri catch and the release profile is
    /// `panic = "abort"`, so one header from a language server took the
    /// whole editor down. `Err` is the framing-lost path the reader already
    /// reports and stops on. This catches the header alone; it does not
    /// exercise the thread that would have died.
    #[test]
    fn errors_on_a_length_that_overflows_the_body_offset() {
        let mut stream = MessageStream::default();
        let header = format!("Content-Length: {}\r\n\r\n{{}}", usize::MAX);
        assert!(stream.push(header.as_bytes()).is_err());
    }

    /// The other edge of the same band. This header is 40 bytes, so a length
    /// of `usize::MAX - 39` is the smallest value whose sum with the body
    /// offset wraps to exactly zero, and one less than it merely waits for a
    /// body that never comes. Pinned separately because an off-by-one in the
    /// guard would let this one through while the `usize::MAX` case passed.
    #[test]
    fn errors_on_a_length_that_overflows_by_exactly_one() {
        let mut stream = MessageStream::default();
        let header = format!("Content-Length: {}\r\n\r\n{{}}", usize::MAX - 39);
        assert_eq!(header.find("{}"), Some(40), "the test assumes a 40-byte header");
        assert!(stream.push(header.as_bytes()).is_err());
    }

    /// A length that does not overflow but could never be satisfied. Before
    /// the cap this returned `Ok(empty)` and the reader waited forever for
    /// gigabytes that were never coming; a corrupt header now ends the
    /// session with a reason instead of a silent hang.
    #[test]
    fn errors_on_a_length_above_the_body_cap() {
        let mut stream = MessageStream::default();
        let header = format!("Content-Length: {}\r\n\r\n", MAX_BODY_BYTES + 1);
        assert!(stream.push(header.as_bytes()).is_err());
    }

    /// The cap is inclusive: a body exactly at the limit is still a body
    /// worth waiting for, so the boundary is a wait rather than an error.
    #[test]
    fn a_length_at_the_body_cap_still_waits_for_its_body() {
        let mut stream = MessageStream::default();
        let header = format!("Content-Length: {}\r\n\r\n", MAX_BODY_BYTES);
        assert!(stream.push(header.as_bytes()).unwrap().is_empty());
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

    /// A scratch directory that removes itself, the same shape `fs.rs` and
    /// `git.rs` hand-roll.
    #[cfg(windows)]
    struct Scratch(PathBuf);

    #[cfg(windows)]
    impl Scratch {
        fn new(name: &str) -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!("nox-{name}-{stamp}"));
            std::fs::create_dir_all(&dir).expect("scratch dir");
            Self(dir)
        }
    }

    #[cfg(windows)]
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Guards A6-008: the resolver stands in for `cmd /C`'s own lookup, so
    /// it must find what the shell found (a `.cmd` beside a
    /// directory-qualified command, or on PATH for a bare one) and nothing
    /// the shell should not have (the working directory, which a repository
    /// controls).
    #[cfg(windows)]
    #[test]
    fn resolves_a_shim_the_way_the_shell_would_minus_the_working_directory() {
        let scratch = Scratch::new("lsp-resolve");
        let bin = scratch.0.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("tsserver.cmd"), "@echo off\r\n").unwrap();
        std::fs::write(bin.join("both.exe"), "").unwrap();
        std::fs::write(bin.join("both.cmd"), "@echo off\r\n").unwrap();
        let workspace = scratch.0.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("tsserver.cmd"), "@echo off\r\n").unwrap();

        let path = vec![bin.clone()];
        // Bare, on PATH.
        assert_eq!(
            resolve_shim("tsserver", &path, Some(&workspace)),
            Some(bin.join("tsserver.cmd"))
        );
        // The executable wins over the shim beside it.
        assert_eq!(resolve_shim("both", &path, Some(&workspace)), Some(bin.join("both.exe")));
        // Directory-qualified: looked up beside the name, not on PATH.
        assert_eq!(
            resolve_shim(&bin.join("tsserver").to_string_lossy(), &[], None),
            Some(bin.join("tsserver.cmd"))
        );
        // Relative and directory-qualified: against the server's cwd.
        assert_eq!(
            resolve_shim("bin\\tsserver", &[], Some(&scratch.0)),
            Some(bin.join("tsserver.cmd"))
        );
        // An extension means the direct spawn already tried that exact file.
        assert_eq!(resolve_shim("tsserver.cmd", &path, Some(&workspace)), None);
        // A bare name is never taken from the working directory: PATH only.
        assert_eq!(resolve_shim("tsserver", &[], Some(&workspace)), None);
    }

    /// Guards A6-008 end to end: the old fallback was `cmd /C <command>
    /// <args...>`, and `cmd` re-parses that line, so `&` in an argument ran
    /// a second command. The shim is now spawned as the program itself, and
    /// the standard library's batch-file quoting (its BatBadBut mitigation)
    /// carries every argument through intact. What this does not cover is
    /// an argument the library refuses to quote at all, which surfaces as a
    /// spawn error rather than a shell command, and that is the point.
    #[cfg(windows)]
    #[test]
    fn a_cmd_shim_receives_its_arguments_verbatim() {
        let scratch = Scratch::new("lsp-shim");
        std::fs::write(scratch.0.join("shim.cmd"), "@echo off\r\necho %1 %2\r\n").unwrap();
        let command = scratch.0.join("shim").to_string_lossy().into_owned();

        let child = spawn_server(&command, &["a&b".to_string(), "c d".to_string()], None)
            .expect("the shim spawns");
        let output = child.wait_with_output().expect("the shim finishes");

        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("a&b") && stdout.contains("c d"), "got {stdout:?}");
        assert!(
            output.stderr.is_empty(),
            "stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

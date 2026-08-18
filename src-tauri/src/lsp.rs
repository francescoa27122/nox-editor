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
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, String> {
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

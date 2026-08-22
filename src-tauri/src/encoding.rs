//! Reading and writing text that is not UTF-8.
//!
//! Nox refused any file that was not valid UTF-8, which is the right refusal —
//! guessing and then saving would corrupt the file — but it means a text
//! editor that cannot open a text file.
//!
//! **This lives in Rust because it has to.** The webview's `TextDecoder`
//! decodes legacy charsets, but `TextEncoder` only ever produces UTF-8. A
//! decoder in the renderer could therefore open a windows-1252 file and then
//! be structurally incapable of writing it back as one — the file would be
//! silently converted the first time it was saved.
//!
//! Detection is deliberately not clever. A BOM is a fact; valid UTF-8 is a
//! fact; everything else is a guess, and a guess that is wrong produces
//! mojibake that the next save makes permanent. So this reports what it knows
//! and refuses what it does not, and the choice goes to the person who can
//! actually tell.

use encoding_rs::{Encoding, SHIFT_JIS, UTF_16BE, UTF_16LE, UTF_8, WINDOWS_1252};

/// The label crossing the IPC boundary. Kept as a string rather than an enum
/// because the renderer's `Encoding` union is the same set of names, and one
/// spelling in both places is what stops them drifting.
pub type Label = String;

const UTF8: &str = "utf-8";
const UTF8_BOM: &str = "utf-8-bom";
const UTF16LE: &str = "utf-16le";
const UTF16BE: &str = "utf-16be";
const WIN1252: &str = "windows-1252";
const SJIS: &str = "shift_jis";

/// What a file's first bytes prove about its encoding.
///
/// Only two things are provable without guessing: a byte-order mark, and
/// whether the whole file is valid UTF-8.
pub fn detect(bytes: &[u8]) -> Option<Label> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Some(UTF8_BOM.to_string());
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Some(UTF16LE.to_string());
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Some(UTF16BE.to_string());
    }
    // No mark. Valid UTF-8 is still a fact rather than a guess, and pure
    // ASCII is valid UTF-8 — which is why an ASCII windows-1252 file opens
    // as UTF-8 and round-trips byte-identical anyway.
    if std::str::from_utf8(bytes).is_ok() {
        return Some(UTF8.to_string());
    }
    None
}

fn encoding_for(label: &str) -> Option<&'static Encoding> {
    match label {
        UTF8 | UTF8_BOM => Some(UTF_8),
        UTF16LE => Some(UTF_16LE),
        UTF16BE => Some(UTF_16BE),
        WIN1252 => Some(WINDOWS_1252),
        SJIS => Some(SHIFT_JIS),
        _ => None,
    }
}

/// Decode `bytes` as `label`.
///
/// The UTF-8 BOM is **kept** in the returned string as `U+FEFF`.
/// `encoding_rs` strips BOMs by default, but `WorkspaceService` has always
/// received it and strips it itself, recording that the file had one so the
/// save can put it back. Swallowing it here would silently drop the mark from
/// every such file on its next save.
pub fn decode(bytes: &[u8], label: &str) -> Result<String, String> {
    let encoding = encoding_for(label).ok_or_else(|| format!("encoding: unknown charset {label}"))?;

    let (text, _, had_errors) = encoding.decode(bytes);
    if had_errors {
        return Err(format!(
            "not-text: this file is not valid {label} — its bytes do not decode"
        ));
    }

    if label == UTF8_BOM {
        return Ok(format!("\u{FEFF}{text}"));
    }
    Ok(text.into_owned())
}

/// Encode `text` as `label`, refusing rather than corrupting.
///
/// A character the charset cannot represent is an **error**, not a
/// substitution. `encoding_rs` would otherwise write an HTML numeric
/// reference — typing an emoji into a Shift_JIS file would silently save the
/// literal text `&#128512;`, and the next read would show that instead of the
/// character. Refusing lets the caller offer "save as UTF-8" instead, which
/// is a choice the user can actually make.
pub fn encode(text: &str, label: &str) -> Result<Vec<u8>, String> {
    let encoding = encoding_for(label).ok_or_else(|| format!("encoding: unknown charset {label}"))?;

    if label == UTF8 || label == UTF8_BOM {
        // `WorkspaceService` puts the `U+FEFF` back on the front for a
        // `utf-8-bom` file, so its UTF-8 bytes are already the mark.
        return Ok(text.as_bytes().to_vec());
    }

    let (bytes, _, had_unmappable) = encoding.encode(text);
    if had_unmappable {
        return Err(format!(
            "unmappable: this text cannot be written as {label}"
        ));
    }
    Ok(bytes.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_a_utf8_bom() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"hello");
        assert_eq!(detect(&bytes).as_deref(), Some(UTF8_BOM));
    }

    #[test]
    fn detects_both_utf16_marks() {
        assert_eq!(detect(&[0xFF, 0xFE, 0x68, 0x00]).as_deref(), Some(UTF16LE));
        assert_eq!(detect(&[0xFE, 0xFF, 0x00, 0x68]).as_deref(), Some(UTF16BE));
    }

    #[test]
    fn calls_plain_ascii_utf8() {
        assert_eq!(detect(b"plain text").as_deref(), Some(UTF8));
    }

    /// The whole point of the refusal: a guess that is wrong produces
    /// mojibake, and the next save makes it permanent. Nothing here guesses.
    #[test]
    fn refuses_to_guess_at_bytes_with_no_mark() {
        // 0xE9 is `é` in windows-1252 and invalid alone in UTF-8. There is no
        // way to tell it from any other single-byte charset.
        assert_eq!(detect(&[0x63, 0x61, 0x66, 0xE9]), None);
    }

    #[test]
    fn decodes_utf16le() {
        let bytes = [0xFF, 0xFE, 0x68, 0x00, 0x69, 0x00];
        assert_eq!(decode(&bytes, UTF16LE).unwrap(), "hi");
    }

    /// The BOM survives into the string. `WorkspaceService` strips it and
    /// remembers, so that a file that had one still has one after a save;
    /// swallowing it here would drop the mark from every such file.
    #[test]
    fn keeps_a_utf8_bom_in_the_string() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"hello");
        assert_eq!(decode(&bytes, UTF8_BOM).unwrap(), "\u{FEFF}hello");
    }

    #[test]
    fn round_trips_windows_1252() {
        let bytes = [0x63, 0x61, 0x66, 0xE9];
        let text = decode(&bytes, WIN1252).unwrap();
        assert_eq!(text, "caf\u{e9}");
        assert_eq!(encode(&text, WIN1252).unwrap(), bytes);
    }

    /// The failure this prevents: `encoding_rs` writes an HTML numeric
    /// reference for a character the charset has no room for. Typing an emoji
    /// into a Shift_JIS file would save the literal text `&#128512;`, and the
    /// next read would show that rather than the character — corruption that
    /// looks like a successful save.
    #[test]
    fn refuses_text_the_charset_cannot_hold() {
        let problem = encode("hello 😀", SJIS).unwrap_err();
        assert!(problem.starts_with("unmappable:"), "{problem}");
    }

    #[test]
    fn refuses_a_charset_it_does_not_know() {
        assert!(decode(b"x", "ebcdic").unwrap_err().starts_with("encoding:"));
        assert!(encode("x", "ebcdic").unwrap_err().starts_with("encoding:"));
    }

    /// Bytes that are not valid in the charset they are claimed to be are an
    /// error rather than a string full of replacement characters, which would
    /// otherwise be saved back over the original.
    #[test]
    fn refuses_bytes_that_do_not_decode() {
        // Lone high surrogate half, invalid as UTF-8.
        assert!(decode(&[0xC3, 0x28], UTF8).unwrap_err().starts_with("not-text:"));
    }
}

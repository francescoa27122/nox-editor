//! Where a host-side panic goes.
//!
//! A release build sets `panic = "abort"` and, on Windows, has no console at
//! all (`main.rs`), so before this existed a panic in the watcher, the PTY,
//! the LSP supervisor or a Tauri internal took the window down and left
//! nothing behind: `diagnostics.log` is written by the renderer, and the
//! renderer died with the process. Copy Diagnostics on relaunch said
//! "(nothing recorded)" about the single worst failure class there is.
//!
//! The hook appends one entry to `panic.log` beside `diagnostics.log`, then
//! hands over to whatever hook was there before (the default one, which
//! prints to stderr for the debug builds that have one). It runs *before*
//! the abort, so the profile can stay as it is: nothing here needs unwinding.
//!
//! Everything in this file must be safe to run while the process is already
//! failing. That means no allocation it cannot afford to lose, no error it
//! cannot swallow, and no second panic: a panic inside a panic hook aborts
//! without running the hook again, which would turn a logged crash back into
//! a silent one.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Beside `diagnostics.log`, in the app config directory. The renderer's
/// `DiagnosticsService` reads it by this name.
pub(crate) const FILE: &str = "panic.log";

/// Same cap as the renderer's `diagnostics.log`, for the same reason:
/// nothing rotates this file, so the cap is the only thing bounding it.
const MAX_LINES: usize = 400;

/// Install the hook. `dir` is where `panic.log` lives; `home` is what gets
/// redacted out of the message and the location, the way the renderer's
/// `redactHome` treats its own log.
///
/// Called from `setup` rather than from the top of `run()`, because the app
/// config directory is resolved through the app handle and does not exist
/// as a value before then. A panic between the builder and `setup` is a
/// Tauri initialisation failure with no window to lose yet.
pub(crate) fn install(dir: PathBuf, home: Option<PathBuf>) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // The payload is whatever `panic!` was given: a `&str` for a literal,
        // a `String` for a formatted one. Anything else is some crate
        // panicking with its own type, and naming that is still worth more
        // than nothing.
        let payload = info.payload();
        let message = match payload.downcast_ref::<&str>() {
            Some(text) => (*text).to_string(),
            None => match payload.downcast_ref::<String>() {
                Some(text) => text.clone(),
                None => "(non-string panic payload)".to_string(),
            },
        };
        let location = info
            .location()
            .map(|at| (at.file().to_string(), at.line(), at.column()));
        let entry = format_entry(
            &message,
            location.as_ref().map(|(file, line, column)| (file.as_str(), *line, *column)),
            now_secs(),
            home.as_deref(),
        );
        append(&dir.join(FILE), &entry);
        previous(info);
    }));
}

/// One entry, in the shape `diagnostics.log` uses so the two read as one
/// list when pasted together: a timestamp, a kind column, the message, and
/// the location indented onto a continuation line.
pub(crate) fn format_entry(
    message: &str,
    location: Option<(&str, u32, u32)>,
    epoch_secs: u64,
    home: Option<&Path>,
) -> String {
    let head = format!(
        "{}  panic    {}",
        iso8601(epoch_secs),
        redact_home(message, home)
    );
    match location {
        Some((file, line, column)) => {
            format!("{head}\n    at {}:{line}:{column}", redact_home(file, home))
        }
        None => head,
    }
}

/// The renderer's `redactHome`, in Rust: the home directory becomes `~`, in
/// both separator spellings, because a path that has been through a URI or a
/// config file may come back with the other one. Case-sensitive, for the
/// same reason the renderer's is and with the same debt row.
pub(crate) fn redact_home(text: &str, home: Option<&Path>) -> String {
    let Some(home) = home else {
        return text.to_string();
    };
    let home = home.to_string_lossy();
    let trimmed = home.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return text.to_string();
    }
    let mut out = text.to_string();
    let variants = [
        trimmed.to_string(),
        trimmed.replace('\\', "/"),
        trimmed.replace('/', "\\"),
    ];
    for variant in &variants {
        out = out.replace(variant.as_str(), "~");
    }
    out
}

/// Append `entry`, keeping the file to `MAX_LINES`. Every failure is
/// swallowed: this runs inside a panic hook, where there is nobody to tell.
fn append(path: &Path, entry: &str) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let existing = fs::read_to_string(path).unwrap_or_default();
    let mut lines: Vec<&str> = existing.lines().filter(|l| !l.trim().is_empty()).collect();
    lines.extend(entry.lines());
    let keep = lines.len().saturating_sub(MAX_LINES);
    let mut body = lines[keep..].join("\n");
    body.push('\n');
    let _ = fs::write(path, body);
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `YYYY-MM-DDTHH:MM:SSZ` from Unix seconds, without a date crate: the one
/// timestamp this file needs is not worth a dependency, and a dependency
/// that could fail to format inside a panic hook would be worse than none.
pub(crate) fn iso8601(epoch_secs: u64) -> String {
    let days = epoch_secs / 86_400;
    let rem = epoch_secs % 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Days since 1970-01-01 to a proleptic Gregorian date. Howard Hinnant's
/// algorithm, which is the one `chrono` and the C++ standard library use.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory that removes itself.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!("nox-panic-{name}-{stamp}"));
            fs::create_dir_all(&dir).expect("scratch dir");
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn iso8601_matches_known_instants() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(1_700_000_000), "2023-11-14T22:13:20Z");
        // A leap day, because the day-of-year arithmetic is where a hand
        // written calendar goes wrong.
        assert_eq!(iso8601(1_709_164_800), "2024-02-29T00:00:00Z");
        assert_eq!(iso8601(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn an_entry_carries_the_message_the_location_and_the_time() {
        let entry = format_entry(
            "index out of bounds",
            Some(("src/watcher.rs", 42, 7)),
            1_700_000_000,
            None,
        );
        assert_eq!(
            entry,
            "2023-11-14T22:13:20Z  panic    index out of bounds\n    at src/watcher.rs:42:7"
        );
        assert_eq!(
            format_entry("no location", None, 0, None),
            "1970-01-01T00:00:00Z  panic    no location"
        );
    }

    /// The location is where the home directory shows up in practice: a
    /// dependency compiled from `~/.cargo/registry/...` panics with that
    /// absolute path as its file. Both separator spellings redact.
    #[test]
    fn the_home_directory_is_redacted_from_message_and_location() {
        let home = PathBuf::from("C:\\Users\\ada");
        let entry = format_entry(
            "could not read C:/Users/ada/notes.txt",
            Some(("C:\\Users\\ada\\.cargo\\registry\\x.rs", 1, 1)),
            0,
            Some(&home),
        );
        assert!(!entry.contains("ada"), "{entry}");
        assert!(entry.contains("~/notes.txt"), "{entry}");
        assert!(entry.contains("at ~\\.cargo\\registry\\x.rs:1:1"), "{entry}");

        assert_eq!(redact_home("/home/ada/x", Some(Path::new("/home/ada/"))), "~/x");
        assert_eq!(redact_home("/home/ada/x", Some(Path::new(""))), "/home/ada/x");
        assert_eq!(redact_home("/home/ada/x", None), "/home/ada/x");
    }

    #[test]
    fn the_file_is_bounded_by_lines() {
        let scratch = Scratch::new("bounded");
        let path = scratch.0.join(FILE);
        for i in 0..(MAX_LINES + 20) {
            append(&path, &format!("line {i}"));
        }
        let body = fs::read_to_string(&path).expect("log");
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), MAX_LINES);
        assert_eq!(lines[0], "line 20");
        assert_eq!(lines[MAX_LINES - 1], &format!("line {}", MAX_LINES + 19));
    }

    /// The hook end to end: a real panic on another thread lands in the
    /// file. This guards the wiring inside `install`; it does not prove the
    /// hook is installed by `run()` (that is in `VERIFIED.md`), and it runs
    /// under the test profile's `panic = "unwind"`, so it says nothing about
    /// the abort that follows in a release build.
    #[test]
    fn a_panic_lands_in_the_file() {
        let scratch = Scratch::new("hook");
        install(scratch.0.clone(), Some(PathBuf::from("/home/ada")));

        let outcome = std::thread::spawn(|| {
            panic!("watcher thread gave up on /home/ada/project");
        })
        .join();
        assert!(outcome.is_err());

        // Put the default hook back before the scratch directory goes, so a
        // later panicking test in this binary does not recreate it.
        let _ = std::panic::take_hook();

        let body = fs::read_to_string(scratch.0.join(FILE)).expect("panic.log was written");
        assert!(body.contains("panic    watcher thread gave up on ~/project"), "{body}");
        assert!(body.contains("\n    at "), "{body}");
        assert!(!body.contains("ada"), "{body}");
    }
}

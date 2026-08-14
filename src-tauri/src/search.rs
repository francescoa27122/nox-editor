//! Project-wide search.
//!
//! This is the one place the Rust side genuinely earns its keep: a parallel,
//! gitignore-aware walk over a whole repository, streaming matches to the
//! renderer as they are found. Doing it in the webview would either block the
//! main thread or require shipping the tree through IPC file by file.
//!
//! Results stream in batches rather than arriving at the end, so a search over
//! a large repo paints its first hits in milliseconds. The renderer decides
//! how to display them; this module only finds them.

use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use ignore::overrides::OverrideBuilder;
use ignore::{WalkBuilder, WalkState};
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

/// Directories never worth searching, applied even when gitignore is off.
const ALWAYS_EXCLUDE: &[&str] = &[
    "**/.git/**",
    "**/node_modules/**",
    "**/target/**",
    "**/dist/**",
    "**/.svelte-kit/**",
    "**/.next/**",
    "**/__pycache__/**",
    "**/.venv/**",
];

/// Flush a batch at least this often so results feel live.
const BATCH_INTERVAL: Duration = Duration::from_millis(90);
/// …or as soon as this many files have hits, whichever comes first.
const BATCH_FILES: usize = 40;
/// A line longer than this is truncated in the preview; the match still counts.
const PREVIEW_BUDGET: usize = 320;
/// Context kept before the match when a long line has to be trimmed.
const PREVIEW_LEAD: usize = 60;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub root: String,
    pub query: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regexp: bool,
    pub includes: Vec<String>,
    pub excludes: Vec<String>,
    pub respect_git_ignore: bool,
    pub max_results: usize,
    pub max_file_size: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SearchMatch {
    /// 1-based.
    line: u32,
    /// 0-based offset into `preview`, in UTF-16 units to match JS string indexing.
    column: u32,
    length: u32,
    preview: String,
    /// UTF-16 units trimmed from the start of the line to build `preview`.
    preview_offset: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileResult {
    path: String,
    matches: Vec<SearchMatch>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SearchBatch {
    id: u64,
    files: Vec<FileResult>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SearchDone {
    id: u64,
    total_matches: usize,
    total_files: usize,
    truncated: bool,
    cancelled: bool,
    error: Option<String>,
    elapsed_ms: u64,
}

#[derive(Default)]
pub struct SearchState {
    next_id: AtomicU64,
    current: Mutex<Option<Arc<AtomicBool>>>,
}

/// Translate the user's query into a regex.
///
/// Non-regex queries are escaped so `a.b` means what it looks like. Word
/// boundaries wrap the *whole* pattern rather than each alternative, which is
/// the behaviour every editor's "whole word" toggle actually has.
fn build_matcher(request: &SearchRequest) -> Result<Regex, String> {
    let base = if request.regexp {
        request.query.clone()
    } else {
        regex::escape(&request.query)
    };

    let bounded = if request.whole_word {
        format!(r"\b(?:{base})\b")
    } else {
        base
    };

    let pattern = if request.case_sensitive {
        bounded
    } else {
        format!("(?i){bounded}")
    };

    Regex::new(&pattern).map_err(|e| format!("io: invalid pattern ({e})"))
}

/// Read a file as text, or None when it is binary or unreadable.
fn read_text(path: &std::path::Path, limit: u64) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    if meta.len() > limit {
        return None;
    }

    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(limit).read_to_end(&mut bytes).ok()?;

    // A NUL in the first 8 KB means this is not source code. Same heuristic
    // the editor uses when opening a file, so the two agree.
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return None;
    }

    String::from_utf8(bytes).ok()
}

/// Build the preview window for a match on `line`.
fn preview_for(line: &str, match_start: usize, match_end: usize) -> (String, u32, u32) {
    let start_u16 = line[..match_start].encode_utf16().count();
    let len_u16 = line[match_start..match_end].encode_utf16().count();
    let total_u16 = line.encode_utf16().count();

    if total_u16 <= PREVIEW_BUDGET {
        return (line.to_string(), start_u16 as u32, len_u16 as u32);
    }

    // Long line: keep a window around the match rather than the first 320
    // characters, which for a minified file would never contain the hit.
    let lead = start_u16.saturating_sub(PREVIEW_LEAD);
    let mut taken = String::new();
    let mut seen = 0usize;
    for ch in line.chars() {
        let width = ch.len_utf16();
        if seen >= lead && taken.encode_utf16().count() + width <= PREVIEW_BUDGET {
            taken.push(ch);
        }
        seen += width;
        if seen >= lead && taken.encode_utf16().count() >= PREVIEW_BUDGET {
            break;
        }
    }

    (taken, (start_u16 - lead) as u32, len_u16 as u32)
}

fn search_file(path: &std::path::Path, matcher: &Regex, limit: u64) -> Option<FileResult> {
    let contents = read_text(path, limit)?;
    let mut matches = Vec::new();

    for (index, line) in contents.lines().enumerate() {
        for found in matcher.find_iter(line) {
            // A zero-width match (e.g. the pattern `x*`) would otherwise loop
            // the renderer's highlighting forever.
            if found.start() == found.end() {
                continue;
            }
            let (preview, column, length) = preview_for(line, found.start(), found.end());
            let offset = line[..found.start()].encode_utf16().count() as u32 - column;
            matches.push(SearchMatch {
                line: index as u32 + 1,
                column,
                length,
                preview,
                preview_offset: offset,
            });
        }
    }

    if matches.is_empty() {
        return None;
    }

    Some(FileResult {
        path: path.to_string_lossy().into_owned(),
        matches,
    })
}

#[tauri::command]
pub fn nox_search_start(
    app: AppHandle,
    state: State<'_, SearchState>,
    request: SearchRequest,
) -> Result<u64, String> {
    if request.query.is_empty() {
        return Err("io: empty query".into());
    }

    let matcher = build_matcher(&request)?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let cancel = Arc::new(AtomicBool::new(false));

    {
        // Starting a search cancels the one before it; the renderer only ever
        // displays the newest, so finishing the old one is wasted work.
        let mut current = state
            .current
            .lock()
            .map_err(|_| "io: search lock poisoned".to_string())?;
        if let Some(previous) = current.replace(Arc::clone(&cancel)) {
            previous.store(true, Ordering::Relaxed);
        }
    }

    std::thread::spawn(move || run_search(app, id, request, matcher, cancel));
    Ok(id)
}

fn run_search(
    app: AppHandle,
    id: u64,
    request: SearchRequest,
    matcher: Regex,
    cancel: Arc<AtomicBool>,
) {
    let started = Instant::now();
    let root = request.root.clone();
    let max_file_size = request.max_file_size;

    let mut overrides = OverrideBuilder::new(&root);
    let mut override_error = None;
    for glob in ALWAYS_EXCLUDE {
        let _ = overrides.add(&format!("!{glob}"));
    }
    for glob in &request.excludes {
        if let Err(error) = overrides.add(&format!("!{glob}")) {
            override_error = Some(format!("Invalid exclude pattern: {error}"));
        }
    }
    for glob in &request.includes {
        if let Err(error) = overrides.add(glob) {
            override_error = Some(format!("Invalid include pattern: {error}"));
        }
    }

    let built = match overrides.build() {
        Ok(built) => built,
        Err(error) => {
            emit_done(&app, id, 0, 0, false, false, Some(error.to_string()), started);
            return;
        }
    };

    let mut builder = WalkBuilder::new(&root);
    builder
        .overrides(built)
        .git_ignore(request.respect_git_ignore)
        .git_global(request.respect_git_ignore)
        .git_exclude(request.respect_git_ignore)
        .parents(request.respect_git_ignore)
        // Without this, `ignore` only applies .gitignore inside an actual git
        // repository — so opening a plain folder that has a .gitignore would
        // silently search everything it lists. A .gitignore is the user's
        // stated intent whether or not `git init` has been run.
        .require_git(false)
        .follow_links(false)
        .max_filesize(Some(max_file_size));

    let (tx, rx) = mpsc::channel::<FileResult>();
    let walk_cancel = Arc::clone(&cancel);
    let walker = builder.build_parallel();

    let walk = std::thread::spawn(move || {
        walker.run(|| {
            let tx = tx.clone();
            let matcher = matcher.clone();
            let cancel = Arc::clone(&walk_cancel);

            Box::new(move |entry| {
                if cancel.load(Ordering::Relaxed) {
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else {
                    return WalkState::Continue;
                };
                if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    return WalkState::Continue;
                }
                if let Some(result) = search_file(entry.path(), &matcher, max_file_size) {
                    // A closed channel means the collector gave up; stop.
                    if tx.send(result).is_err() {
                        return WalkState::Quit;
                    }
                }
                WalkState::Continue
            })
        });
    });

    let mut batch: Vec<FileResult> = Vec::new();
    let mut total_matches = 0usize;
    let mut total_files = 0usize;
    let mut truncated = false;
    let mut last_flush = Instant::now();

    loop {
        match rx.recv_timeout(Duration::from_millis(60)) {
            Ok(result) => {
                total_matches += result.matches.len();
                total_files += 1;
                batch.push(result);

                if total_matches >= request.max_results {
                    truncated = true;
                    cancel.store(true, Ordering::Relaxed);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }

        let due = last_flush.elapsed() >= BATCH_INTERVAL || batch.len() >= BATCH_FILES;
        if !batch.is_empty() && due {
            let _ = app.emit(
                "nox://search-batch",
                SearchBatch {
                    id,
                    files: std::mem::take(&mut batch),
                },
            );
            last_flush = Instant::now();
        }

        if truncated {
            break;
        }
    }

    if !batch.is_empty() {
        let _ = app.emit("nox://search-batch", SearchBatch { id, files: batch });
    }

    let cancelled = cancel.load(Ordering::Relaxed) && !truncated;
    let _ = walk.join();

    emit_done(
        &app,
        id,
        total_matches,
        total_files,
        truncated,
        cancelled,
        override_error,
        started,
    );
}

#[allow(clippy::too_many_arguments)]
fn emit_done(
    app: &AppHandle,
    id: u64,
    total_matches: usize,
    total_files: usize,
    truncated: bool,
    cancelled: bool,
    error: Option<String>,
    started: Instant,
) {
    let _ = app.emit(
        "nox://search-done",
        SearchDone {
            id,
            total_matches,
            total_files,
            truncated,
            cancelled,
            error,
            elapsed_ms: started.elapsed().as_millis() as u64,
        },
    );
}

#[tauri::command]
pub fn nox_search_cancel(state: State<'_, SearchState>) -> Result<(), String> {
    let mut current = state
        .current
        .lock()
        .map_err(|_| "io: search lock poisoned".to_string())?;
    if let Some(flag) = current.take() {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(query: &str, regexp: bool, whole_word: bool, case_sensitive: bool) -> SearchRequest {
        SearchRequest {
            root: String::new(),
            query: query.into(),
            case_sensitive,
            whole_word,
            regexp,
            includes: Vec::new(),
            excludes: Vec::new(),
            respect_git_ignore: true,
            max_results: 1000,
            max_file_size: 1024 * 1024,
        }
    }

    #[test]
    fn plain_queries_are_escaped() {
        let matcher = build_matcher(&request("a.c", false, false, true)).unwrap();
        assert!(matcher.is_match("a.c"));
        assert!(!matcher.is_match("abc"), "the dot must be literal");
    }

    #[test]
    fn regex_queries_are_not_escaped() {
        let matcher = build_matcher(&request("a.c", true, false, true)).unwrap();
        assert!(matcher.is_match("abc"));
    }

    #[test]
    fn case_insensitive_by_default() {
        let matcher = build_matcher(&request("hello", false, false, false)).unwrap();
        assert!(matcher.is_match("HELLO"));

        let sensitive = build_matcher(&request("hello", false, false, true)).unwrap();
        assert!(!sensitive.is_match("HELLO"));
    }

    #[test]
    fn whole_word_wraps_the_entire_pattern() {
        let matcher = build_matcher(&request("cat|dog", true, true, true)).unwrap();
        assert!(matcher.is_match("a cat sat"));
        assert!(!matcher.is_match("concatenate"), "must not match inside a word");
    }

    #[test]
    fn an_invalid_regex_is_reported_not_panicked() {
        assert!(build_matcher(&request("(unclosed", true, false, true)).is_err());
    }

    #[test]
    fn preview_keeps_short_lines_intact() {
        let line = "let value = compute();";
        let (preview, column, length) = preview_for(line, 12, 19);
        assert_eq!(preview, line);
        assert_eq!(column, 12);
        assert_eq!(length, 7);
    }

    #[test]
    fn preview_windows_around_a_match_on_a_long_line() {
        let line = format!("{}NEEDLE{}", "x".repeat(2000), "y".repeat(2000));
        let start = 2000;
        let (preview, column, length) = preview_for(&line, start, start + 6);

        assert!(preview.encode_utf16().count() <= PREVIEW_BUDGET);
        assert_eq!(length, 6);
        // The match must actually be inside the window we hand the renderer.
        let chars: Vec<char> = preview.chars().collect();
        let slice: String = chars[column as usize..column as usize + 6].iter().collect();
        assert_eq!(slice, "NEEDLE");
    }

    #[test]
    fn columns_are_utf16_units_so_javascript_agrees() {
        // An emoji is two UTF-16 units but one char; JS string indexing uses
        // the former, and the renderer highlights with JS indices.
        let line = "😀 needle";
        let start = line.find("needle").unwrap();
        let (_, column, _) = preview_for(line, start, start + 6);
        assert_eq!(column, 3, "emoji (2) + space (1)");
    }
}

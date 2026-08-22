//! Filesystem commands.
//!
//! Every function here is a thin, total wrapper over `std::fs`: no caching, no
//! business logic, no opinions. The renderer's `Platform` interface is the
//! contract, and this module is one of its two implementations.
//!
//! Errors are returned as `"<code>: <message>"` so the renderer can branch on
//! the cause without parsing prose. See `platform/tauri.ts`.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::Manager;

pub type Result<T> = std::result::Result<T, String>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    path: String,
    is_directory: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    size: u64,
    /// Epoch milliseconds, or 0 when the platform cannot report it.
    modified: u64,
    is_directory: bool,
}

/// Map an io error onto the renderer's error vocabulary.
fn describe(error: &std::io::Error, path: &Path) -> String {
    let code = match error.kind() {
        ErrorKind::NotFound => "not-found",
        ErrorKind::PermissionDenied => "permission",
        ErrorKind::AlreadyExists => "exists",
        ErrorKind::InvalidData => "not-text",
        _ => "io",
    };
    format!("{code}: {} ({})", error, path.display())
}

#[tauri::command]
pub fn nox_home_dir() -> Option<String> {
    dirs_home().map(|p| p.to_string_lossy().into_owned())
}

/// `$HOME` on unix, `%USERPROFILE%` on Windows. Avoids a `dirs` dependency
/// for the one thing we actually need from it.
fn dirs_home() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// A file's text and the charset it was read as. The charset comes back
/// because the caller has to write it again with the same one.
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EncodedText {
    pub text: String,
    pub encoding: String,
}

#[tauri::command]
pub fn nox_read_text_file(path: String) -> Result<String> {
    let target = Path::new(&path);
    let bytes = fs::read(target).map_err(|e| describe(&e, target))?;
    String::from_utf8(bytes)
        .map_err(|_| format!("not-text: {path} is not valid UTF-8"))
}

/// Read a file that may not be UTF-8.
///
/// `encoding` names the charset to use; omit it and only what can be *proved*
/// is accepted — a byte-order mark, or the whole file being valid UTF-8.
/// Anything else is refused with `not-text:`, exactly as before, because the
/// alternative is guessing and then saving the guess.
///
/// `nox_read_text_file` above is deliberately left strict. It is what config,
/// workspace settings and git read through, and those are Nox's own files:
/// UTF-8 or nothing is correct there.
#[tauri::command]
pub fn nox_read_encoded_file(path: String, encoding: Option<String>) -> Result<EncodedText> {
    let target = Path::new(&path);
    let bytes = fs::read(target).map_err(|e| describe(&e, target))?;

    let label = match encoding {
        Some(label) => label,
        None => crate::encoding::detect(&bytes).ok_or_else(|| {
            format!("not-text: {path} is not valid UTF-8 and has no byte-order mark")
        })?,
    };

    let text = crate::encoding::decode(&bytes, &label)?;
    Ok(EncodedText { text, encoding: label })
}

/// Write a file back in the charset it was read as.
///
/// Refuses rather than substitutes when the text will not fit the charset —
/// see `encoding::encode`. The refusal happens before the file is touched, so
/// a save that cannot be done faithfully leaves the original alone.
#[tauri::command]
pub fn nox_write_encoded_file(path: String, contents: String, encoding: String) -> Result<()> {
    let bytes = crate::encoding::encode(&contents, &encoding)?;
    write_atomic(&path, &bytes)
}

/// Write a file so that a failure part-way through cannot destroy it.
///
/// `fs::write` truncates first and then fills, so a crash, a power cut or a
/// full disk in the middle leaves the file empty or half-written — the old
/// contents gone and the new ones never arrived. Instead the bytes go to a
/// temp file beside the target, get flushed to the device, and are then
/// *renamed* over it. Rename within a directory is atomic on every filesystem
/// Nox targets, so a reader sees either the whole old file or the whole new
/// one, never a torn one.
///
/// The temp file lives in the target's own directory rather than the system
/// temp dir, because rename across filesystems is not a rename — it is a copy,
/// which would put the truncation risk straight back.
#[tauri::command]
pub fn nox_write_text_file(path: String, contents: String) -> Result<()> {
    write_atomic(&path, contents.as_bytes())
}

/// The body of `nox_write_text_file`, taking bytes.
///
/// Shared with `nox_write_encoded_file` rather than copied: the temp-sibling,
/// `sync_all`, permission-carrying and symlink-canonicalising behaviour above
/// is the part that must not be got wrong twice, and sharing it means the
/// existing `fs.rs` tests cover the encoded path too.
fn write_atomic(path: &str, bytes: &[u8]) -> Result<()> {
    let requested = Path::new(path);
    if let Some(parent) = requested.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| describe(&e, parent))?;
        }
    }

    // Follow a symlink to write the file it points at. Renaming over the link
    // itself would silently replace it with a regular file and detach whatever
    // else pointed there — a dotfile managed by a symlink farm, typically.
    let target = fs::canonicalize(requested).unwrap_or_else(|_| requested.to_path_buf());

    let has_directory = target
        .parent()
        .is_some_and(|parent| !parent.as_os_str().is_empty());
    if !has_directory {
        // A bare filename with no directory to put a sibling in. Nothing to be
        // clever with, and a direct write is still better than refusing.
        return fs::write(&target, bytes).map_err(|e| describe(&e, &target));
    }

    let temp = temp_path_for(&target);
    let outcome = write_then_rename(&temp, &target, bytes);

    if outcome.is_err() {
        // Never leave litter next to the user's file.
        let _ = fs::remove_file(&temp);
    }
    outcome
}

/// The actual write-flush-rename, split out so the caller can clean up.
fn write_then_rename(temp: &Path, target: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;

    {
        let mut file = fs::File::create(temp).map_err(|e| describe(&e, temp))?;
        file.write_all(bytes).map_err(|e| describe(&e, temp))?;
        // Without this the rename can land before the data does, and a crash
        // in that window leaves a file that exists but is empty.
        file.sync_all().map_err(|e| describe(&e, temp))?;
    }

    // A fresh file gets default permissions; the target may be executable, or
    // deliberately read-only for its group. Carry the old mode across so
    // saving does not quietly change it.
    copy_permissions(target, temp);

    fs::rename(temp, target).map_err(|e| describe(&e, target))
}

/// A sibling of `target` that no other save will collide with.
fn temp_path_for(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());

    // The counter makes two saves of the same file in the same millisecond
    // pick different names; the pid separates two instances of Nox.
    let stamp = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let ordinal = TEMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    let mut temp = target.to_path_buf();
    temp.set_file_name(format!(
        ".{name}.nox-{pid}-{stamp}-{ordinal}.tmp",
        pid = std::process::id()
    ));
    temp
}

static TEMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Copy `from`'s permissions onto `to`, if `from` exists. Best effort.
fn copy_permissions(from: &Path, to: &Path) {
    if let Ok(metadata) = fs::metadata(from) {
        let _ = fs::set_permissions(to, metadata.permissions());
    }
}

#[tauri::command]
pub fn nox_read_dir(path: String) -> Result<Vec<DirEntry>> {
    let target = Path::new(&path);
    let mut entries = Vec::new();

    for entry in fs::read_dir(target).map_err(|e| describe(&e, target))? {
        // One unreadable entry must not fail the whole listing.
        let Ok(entry) = entry else { continue };
        let file_type = entry.file_type().ok();

        entries.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_directory: file_type.map(|t| t.is_dir()).unwrap_or(false),
        });
    }

    Ok(entries)
}

#[tauri::command]
pub fn nox_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
pub fn nox_stat(path: String) -> Result<FileStat> {
    let target = Path::new(&path);
    let metadata = fs::metadata(target).map_err(|e| describe(&e, target))?;

    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    Ok(FileStat {
        size: metadata.len(),
        modified,
        is_directory: metadata.is_dir(),
    })
}

#[tauri::command]
pub fn nox_create_dir(path: String) -> Result<()> {
    let target = Path::new(&path);
    fs::create_dir_all(target).map_err(|e| describe(&e, target))
}

#[tauri::command]
pub fn nox_create_file(path: String) -> Result<()> {
    let target = Path::new(&path);
    if target.exists() {
        return Err(format!("exists: {path} already exists"));
    }
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| describe(&e, parent))?;
        }
    }
    fs::write(target, "").map_err(|e| describe(&e, target))
}

#[tauri::command]
pub fn nox_rename(from: String, to: String) -> Result<()> {
    let source = Path::new(&from);
    let target = Path::new(&to);

    if !source.exists() {
        return Err(format!("not-found: {from} does not exist"));
    }
    // `fs::rename` silently replaces the destination on unix. Refusing is the
    // only safe default: the explorer must never clobber a file the user
    // cannot see from the rename prompt.
    if target.exists() && !same_file(source, target) {
        return Err(format!("exists: {to} already exists"));
    }
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| describe(&e, parent))?;
        }
    }

    fs::rename(source, target).map_err(|e| describe(&e, source))
}

/// True when both paths refer to the same entry — a case-only rename on a
/// case-insensitive filesystem, which must be allowed through.
fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// Move a file or directory to the OS trash. Recoverable by design.
///
/// On macOS the `trash` crate defaults to driving Finder over AppleScript,
/// which round-trips through another process: it blocks for **two minutes**
/// and then fails outright when Finder is busy or unavailable. `NsFileManager`
/// is the native API — no interprocess call, returns immediately, and works
/// when nobody is logged into a desktop session.
///
/// The tradeoff is that `NsFileManager` does not record Finder's "Put Back"
/// metadata, so a trashed file restores to the Trash folder rather than
/// hopping home. That is a fair price for a delete that cannot hang.
#[tauri::command]
pub fn nox_trash(path: String) -> Result<()> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("not-found: {path} does not exist"));
    }

    #[cfg(target_os = "macos")]
    let outcome = {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut context = trash::TrashContext::default();
        context.set_delete_method(DeleteMethod::NsFileManager);
        context.delete(target)
    };

    #[cfg(not(target_os = "macos"))]
    let outcome = trash::delete(target);

    outcome.map_err(|e| format!("io: could not move {path} to trash ({e})"))
}

#[tauri::command]
pub fn nox_copy_file(from: String, to: String) -> Result<()> {
    let source = Path::new(&from);
    let target = Path::new(&to);

    if target.exists() {
        return Err(format!("exists: {to} already exists"));
    }
    if source.is_dir() {
        return Err(format!("io: {from} is a directory"));
    }
    fs::copy(source, target)
        .map(|_| ())
        .map_err(|e| describe(&e, source))
}

/// Show the item in the OS file manager.
///
/// Spawned directly rather than through the opener plugin: it is three
/// platform arms and no new dependency. The path is passed as its own
/// argument and never through a shell, so it cannot be interpreted as syntax.
#[tauri::command]
pub fn nox_reveal(path: String) -> Result<()> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("not-found: {path} does not exist"));
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = std::process::Command::new("open");
        c.arg("-R").arg(target);
        c
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = std::process::Command::new("explorer");
        c.arg(format!("/select,{}", target.display()));
        c
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        // No portable "select the file" on Linux; open the containing folder.
        let folder = if target.is_dir() {
            target
        } else {
            target.parent().unwrap_or(target)
        };
        let mut c = std::process::Command::new("xdg-open");
        c.arg(folder);
        c
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("io: could not reveal {path} ({e})"))
}

/// Resolve `<app config dir>/<name>`, creating the directory on demand.
/// `name` is rejected if it contains separators — config keys are bare
/// filenames, and treating them otherwise would be a path-traversal hole.
pub(crate) fn config_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("io: invalid config name {name}"));
    }

    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("io: no config directory ({e})"))?;

    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| describe(&e, &dir))?;
    }

    Ok(dir.join(name))
}

/// Where settings, session and `agents.json` live.
///
/// Exposed so a command can *open* one of those files in the editor rather
/// than describing where it is and leaving the user to find it.
#[tauri::command]
pub fn nox_config_dir(app: tauri::AppHandle) -> Result<String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("io: no config directory ({e})"))?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| describe(&e, &dir))?;
    }
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn nox_read_config(app: tauri::AppHandle, name: String) -> Result<Option<String>> {
    let path = config_path(&app, &name)?;
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(describe(&error, &path)),
    }
}

/// The write itself, split from the command so it can be tested without an
/// `AppHandle`.
pub(crate) fn write_config_atomically(path: &Path, contents: &str) -> Result<()> {
    // Same reasoning as a file save: truncate-then-write leaves a window where
    // a crash costs the whole file. A config path always has a parent
    // directory, so the sibling temp always has somewhere to live.
    //
    // Follow a symlink first, exactly as `nox_write_text_file` does: renaming
    // over the link itself would silently replace it with a regular file and
    // detach whatever else pointed there — someone symlinking
    // `~/.config/nox/settings.json` into a dotfiles repo, typically.
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let temp = temp_path_for(&target);
    let outcome = write_then_rename(&temp, &target, contents.as_bytes());
    if outcome.is_err() {
        let _ = fs::remove_file(&temp);
    }
    outcome
}

#[tauri::command]
pub fn nox_write_config(app: tauri::AppHandle, name: String, contents: String) -> Result<()> {
    let path = config_path(&app, &name)?;
    write_config_atomically(&path, &contents)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory that removes itself.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!("nox-{name}-{stamp}"));
            fs::create_dir_all(&dir).expect("scratch dir");
            Self(dir)
        }

        fn join(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }

        /// Entries left in the directory, sorted.
        fn entries(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(&self.0)
                .expect("read scratch")
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn writes_a_new_file() {
        let scratch = Scratch::new("write-new");
        let path = scratch.join("a.txt");

        nox_write_text_file(path.to_string_lossy().into_owned(), "hello\n".into()).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "hello\n");
    }

    #[test]
    fn replaces_an_existing_file() {
        let scratch = Scratch::new("write-replace");
        let path = scratch.join("a.txt");
        fs::write(&path, "old contents that are longer\n").unwrap();

        nox_write_text_file(path.to_string_lossy().into_owned(), "new\n".into()).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new\n");
    }

    #[test]
    fn leaves_no_temp_file_behind() {
        let scratch = Scratch::new("write-tidy");
        let path = scratch.join("a.txt");

        nox_write_text_file(path.to_string_lossy().into_owned(), "hello\n".into()).unwrap();

        // The temp file is the whole mechanism; leaving one next to the user's
        // source would be a visible cost of an invisible safety property.
        assert_eq!(scratch.entries(), vec!["a.txt".to_string()]);
    }

    #[test]
    fn creates_missing_parent_directories() {
        let scratch = Scratch::new("write-mkdir");
        let path = scratch.join("nested/deeper/a.txt");

        nox_write_text_file(path.to_string_lossy().into_owned(), "hi\n".into()).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "hi\n");
    }

    #[test]
    fn a_failed_write_reports_it_and_cleans_up() {
        let scratch = Scratch::new("write-fail");

        // A non-empty directory where the file should be. The temp file is
        // written fine and the *rename* is what fails, which is the one step
        // that can fail after bytes have been committed to disk.
        let blocked = scratch.join("blocked");
        fs::create_dir_all(blocked.join("inner")).unwrap();
        let result = nox_write_text_file(blocked.to_string_lossy().into_owned(), "new\n".into());

        assert!(result.is_err(), "writing over a directory should fail");
        // The failure path is the one that most easily strands a temp file,
        // because it is the path nobody exercises by hand.
        let left: Vec<String> = scratch
            .entries()
            .into_iter()
            .filter(|name| name.contains("nox-"))
            .collect();
        assert!(left.is_empty(), "temp files left behind: {left:?}");
    }

    /// The failure this prevents: a save that cannot be done faithfully
    /// destroying the file it could not write. `encoding::encode` refuses
    /// text the charset has no room for, and that refusal has to happen
    /// *before* the atomic write starts — otherwise the original is already
    /// gone by the time anyone finds out.
    #[test]
    fn an_unmappable_save_leaves_the_original_untouched() {
        let scratch = Scratch::new("write-unmappable");
        let path = scratch.join("notes.txt");
        let original = [0x63, 0x61, 0x66, 0xE9];
        fs::write(&path, original).unwrap();

        let problem = nox_write_encoded_file(
            path.to_string_lossy().into_owned(),
            "caf\u{e9} \u{1F600}".to_string(),
            "windows-1252".to_string(),
        )
        .unwrap_err();

        assert!(problem.starts_with("unmappable:"), "{problem}");
        assert_eq!(fs::read(&path).unwrap(), original, "the file was written anyway");
    }

    /// Round trip through the two commands, which is what a save actually is.
    #[test]
    fn reads_back_what_it_wrote_in_a_legacy_charset() {
        let scratch = Scratch::new("write-1252");
        let path = scratch.join("caf.txt");
        let name = path.to_string_lossy().into_owned();

        nox_write_encoded_file(name.clone(), "caf\u{e9}".to_string(), "windows-1252".to_string())
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), [0x63, 0x61, 0x66, 0xE9]);

        let back = nox_read_encoded_file(name, Some("windows-1252".to_string())).unwrap();
        assert_eq!(back.text, "caf\u{e9}");
        assert_eq!(back.encoding, "windows-1252");
    }

    /// Without a charset, only what can be proved is accepted — the same
    /// refusal `nox_read_text_file` has always given, which is what sends the
    /// user to the picker rather than to mojibake.
    #[test]
    fn refuses_an_unmarked_legacy_file_until_told_what_it_is() {
        let scratch = Scratch::new("read-unmarked");
        let path = scratch.join("caf.txt");
        fs::write(&path, [0x63, 0x61, 0x66, 0xE9]).unwrap();

        let problem = nox_read_encoded_file(path.to_string_lossy().into_owned(), None).unwrap_err();
        assert!(problem.starts_with("not-text:"), "{problem}");
    }

    #[cfg(unix)]
    #[test]
    fn preserves_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let scratch = Scratch::new("write-perms");
        let path = scratch.join("script.sh");
        fs::write(&path, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();

        nox_write_text_file(path.to_string_lossy().into_owned(), "#!/bin/sh\necho hi\n".into())
            .unwrap();

        // A fresh temp file is 0644. Renaming it over an executable without
        // carrying the mode across would quietly break the script.
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755, "mode was {mode:o}");
    }

    #[cfg(unix)]
    #[test]
    fn writes_through_a_symlink() {
        let scratch = Scratch::new("write-symlink");
        let real = scratch.join("real.txt");
        let link = scratch.join("link.txt");
        fs::write(&real, "original\n").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();

        nox_write_text_file(link.to_string_lossy().into_owned(), "updated\n".into()).unwrap();

        // Renaming over the link itself would replace it with a regular file
        // and detach whatever else pointed at the target.
        assert_eq!(fs::read_to_string(&real).unwrap(), "updated\n");
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    }

    /// The failure this prevents: `fs::write` truncates the target before it
    /// writes, so a crash mid-write leaves a half-written config file. Session
    /// and notes both keep their index there, and a truncated index reads as
    /// "you have no notes".
    #[test]
    fn config_writes_replace_atomically_and_leave_no_litter() {
        let scratch = Scratch::new("config-atomic");
        let path = scratch.0.join("notes.json");

        write_config_atomically(&path, r#"{"version":1}"#).expect("first write");
        write_config_atomically(&path, r#"{"version":2}"#).expect("overwrite");

        assert_eq!(fs::read_to_string(&path).expect("read"), r#"{"version":2}"#);

        // A `.tmp` sibling left behind would sit in the user's config
        // directory forever: there is no cleanup pass, and the config API
        // lists nothing, so nothing would ever notice it.
        let strays: Vec<String> = fs::read_dir(&scratch.0)
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name != "notes.json")
            .collect();
        assert!(strays.is_empty(), "left behind: {strays:?}");
    }

    /// The failure this prevents: a config file symlinked into a dotfiles
    /// repo (a normal thing for this audience) getting silently replaced by
    /// a regular file on the first settings change, detaching the symlink
    /// from whatever managed it. Before atomic config writes, `fs::write`
    /// wrote *through* the link; the rename-based path has to earn that back
    /// by resolving the link before it picks a temp path, the same as
    /// `nox_write_text_file` does for file saves.
    #[cfg(unix)]
    #[test]
    fn config_writes_go_through_a_symlink() {
        let scratch = Scratch::new("config-symlink");
        let real = scratch.join("real-settings.json");
        let link = scratch.join("settings.json");
        fs::write(&real, r#"{"version":1}"#).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();

        write_config_atomically(&link, r#"{"version":2}"#).expect("write through symlink");

        assert_eq!(fs::read_to_string(&real).unwrap(), r#"{"version":2}"#);
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    }
}

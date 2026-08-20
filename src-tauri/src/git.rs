//! Git file bases.
//!
//! One command: fetch the version of a file the git index holds (`:0:` —
//! what `git add` would leave alone). The index rather than HEAD because the
//! gutter's question is "what have I changed that git doesn't hold yet", and
//! for anyone not mid-staging the index *is* HEAD anyway.
//!
//! `None` is the answer to everything that isn't content: no repo, untracked
//! file, git not installed, non-UTF-8 blob. A missing gutter is the correct
//! degraded state, so no failure here may become a dialog — `Err` is reserved
//! for what the fs.rs convention reserves it for and is not expected in
//! practice.
//!
//! No timeout on `output()`. `git show` against a local repo does not hang in
//! practice, and if it ever did the cost is a gutter that never arrives —
//! never a blocked save or keystroke, because every caller is async and
//! nothing on a critical path awaits this.

use std::path::Path;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Suppresses the console window Windows would otherwise give a
/// console-subsystem child of a GUI process. `winbase.h`'s value; not worth a
/// dependency on the `windows` crate for one constant. Same as `lsp.rs` —
/// `git.exe` is console-subsystem and would flash a window without it.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub type Result<T> = std::result::Result<T, String>;

/// Run git in `dir` and capture the result. `None` when git could not even be
/// spawned (not installed, not on PATH) — to the caller that is the same
/// non-answer as any other failure. Direct spawn only, no `cmd /C` fallback:
/// git is a real `.exe`, and the shell route re-splits paths with spaces.
fn run_git(dir: &Path, args: &[&str]) -> Option<std::process::Output> {
    let mut command = Command::new("git");
    command.arg("-C").arg(dir).args(args);

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command.output().ok()
}

/// The file's path in the form git prints paths: absolute, resolved, and
/// comparable to `--show-toplevel` output once separators are normalized.
///
/// Canonicalized, because the path the renderer holds and the root git
/// prints can name the same place differently: on macOS the temp tree is
/// reached via the `/var` → `/private/var` symlink and git prints the
/// resolved side; on Windows a path may arrive in 8.3 short form
/// (`RUNNER~1`) while git prints the long one. `fs::canonicalize` resolves
/// both — and on Windows returns a `\\?\C:\...` verbatim path, so that one
/// known prefix is stripped. A `\\?\UNC\` share path is left as it is and
/// simply fails the later prefix match: a repository on a network share is
/// out of scope, and "no gutter" is the designed answer to out of scope.
fn plain_canonical(path: &Path) -> Option<String> {
    let canonical = std::fs::canonicalize(path).ok()?;
    let text = canonical.to_str()?.to_string();
    #[cfg(windows)]
    let text = text.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(text);
    Some(text)
}

/// The file's path relative to the repo root, forward-slashed.
///
/// A textual prefix match over two absolute paths that both come out of the
/// filesystem's own vocabulary: `file` has been through `plain_canonical`
/// and `root` is what git itself printed (`--show-toplevel` speaks `/` even
/// on Windows). On Windows the match is case-insensitive because git and
/// the OS may disagree on the case of the drive letter or any segment;
/// ASCII-insensitive is enough for the divergences that actually occur.
fn relative_to_root(root: &str, file: &str) -> Option<String> {
    let file = file.replace('\\', "/");
    let root = root.trim_end_matches('/');

    if !file.is_char_boundary(root.len()) {
        return None;
    }
    let (head, tail) = file.split_at(root.len());

    let head_matches = if cfg!(windows) {
        head.eq_ignore_ascii_case(root)
    } else {
        head == root
    };
    if !head_matches {
        return None;
    }

    let relative = tail.strip_prefix('/')?;
    if relative.is_empty() {
        return None;
    }
    Some(relative.to_string())
}

/// The index's version of the file, or `None` when there isn't one.
#[tauri::command]
pub fn nox_git_file_base(path: String) -> Result<Option<String>> {
    // Resolved before anything else: the relpath computation below compares
    // this against the root git prints, and git prints resolved paths.
    let Some(file) = plain_canonical(Path::new(&path)) else {
        return Ok(None);
    };
    let Some(parent) = Path::new(&file).parent() else {
        return Ok(None);
    };

    let Some(output) = run_git(parent, &["rev-parse", "--show-toplevel"]) else {
        return Ok(None);
    };
    if !output.status.success() {
        // Not a repo. rev-parse says so on stderr; the gutter doesn't care.
        return Ok(None);
    }
    let Ok(root) = String::from_utf8(output.stdout) else {
        return Ok(None);
    };
    let root = root.trim_end_matches(['\r', '\n']);
    if root.is_empty() {
        return Ok(None);
    }

    let Some(relpath) = relative_to_root(root, &file) else {
        return Ok(None);
    };

    // `--literal-pathspecs` so a `*` or `:` in a real filename is a filename,
    // not a glob or magic pathspec.
    let spec = format!(":0:{relpath}");
    let Some(output) = run_git(Path::new(root), &["--literal-pathspecs", "show", &spec]) else {
        return Ok(None);
    };
    if !output.status.success() {
        // Untracked, or otherwise not in the index.
        return Ok(None);
    }
    match String::from_utf8(output.stdout) {
        Ok(text) => Ok(Some(text)),
        // A binary blob is not a base to diff against.
        Err(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::fs;
    use std::path::PathBuf;
    use std::time::UNIX_EPOCH;

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
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Run git in `dir` and insist it worked — a broken git is a broken test
    /// environment, not a pass. The inline `-c` config supplies an identity
    /// and disables commit signing so nothing depends on the runner's global
    /// git configuration.
    fn git_in(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn as_string(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn staged_content_comes_back() {
        let scratch = Scratch::new("git-staged");
        git_in(&scratch.0, &["init"]);
        let file = scratch.join("a.txt");
        fs::write(&file, "one\ntwo\n").unwrap();
        git_in(&scratch.0, &["add", "a.txt"]);
        // Diverge the working tree so the test can only pass by reading the
        // index, not the file.
        fs::write(&file, "three\nfour\nfive\n").unwrap();

        let base = nox_git_file_base(as_string(&file)).unwrap();

        assert_eq!(base.as_deref(), Some("one\ntwo\n"));
    }

    #[test]
    fn untracked_is_none() {
        let scratch = Scratch::new("git-untracked");
        git_in(&scratch.0, &["init"]);
        let file = scratch.join("loose.txt");
        fs::write(&file, "never added\n").unwrap();

        assert_eq!(nox_git_file_base(as_string(&file)).unwrap(), None);
    }

    #[test]
    fn outside_a_repo_is_none() {
        let scratch = Scratch::new("git-norepo");
        let file = scratch.join("plain.txt");
        fs::write(&file, "no repo here\n").unwrap();

        // Guard: if the machine's temp dir itself sits inside some parent
        // repo, "outside a repo" is not a state this test can construct, and
        // asserting would test that machine's home layout rather than this
        // module. CI temp dirs are not inside repos, so there the assertion
        // always runs. This is the one acceptable conditional in these tests.
        if let Some(probe) = run_git(&scratch.0, &["rev-parse", "--show-toplevel"]) {
            if probe.status.success() {
                return;
            }
        }

        assert_eq!(nox_git_file_base(as_string(&file)).unwrap(), None);
    }

    #[test]
    fn subdirectory_paths_resolve() {
        let scratch = Scratch::new("git-subdir");
        git_in(&scratch.0, &["init"]);
        fs::create_dir_all(scratch.join("sub/dir")).unwrap();
        let file = scratch.join("sub/dir/b.txt");
        fs::write(&file, "alpha\nbeta\n").unwrap();
        git_in(&scratch.0, &["add", "sub/dir/b.txt"]);

        // The full native path — backslashed on Windows — which is what the
        // renderer sends; this is the test that catches relpath slashing.
        let base = nox_git_file_base(as_string(&file)).unwrap();

        assert_eq!(base.as_deref(), Some("alpha\nbeta\n"));
    }
}

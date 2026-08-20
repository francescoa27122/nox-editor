//! Git file bases, and the stage/commit/branch commands.
//!
//! `nox_git_file_base` fetches the version of a file the git index holds
//! (`:0:` — what `git add` would leave alone). The index rather than HEAD
//! because the gutter's question is "what have I changed that git doesn't
//! hold yet", and for anyone not mid-staging the index *is* HEAD anyway.
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
//!
//! The remaining six commands are argv-fixed writes and reads for the
//! stage/commit/branch panel: `nox_git_status`, `nox_git_branches`,
//! `nox_git_stage`, `nox_git_unstage`, `nox_git_commit`, `nox_git_switch`.
//! Every one runs `git -C <root>` with no shell involved, `--literal-pathspecs`
//! wherever pathspecs are given, and stops short of anything that leaves the
//! machine (no push/pull/fetch), rewrites history (no amend/rebase/force), or
//! destroys working-tree work (no discard, no `checkout --`, no stash). A
//! refusal from git travels back verbatim: stderr, falling back to stdout
//! when stderr is empty (git's "nothing to commit" lands on stdout).

use std::io::Write;
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
///
/// `GIT_OPTIONAL_LOCKS=0`: without it, even a read like `git status` takes and
/// releases `.git/index.lock` (git's "opportunistic update" of the index's
/// stat-cache). The meta watch (`watcher.rs`) sees that lock file's
/// create-and-rename and fires a change event, which debounce-triggers
/// `refreshStatus`, which runs `git status`, which fires the event again —
/// a self-sustaining loop that drags `refreshAll` (a `git show` per open
/// buffer) along every ~300 ms, forever, on a panel nobody touched. Watching
/// only `HEAD` and `index` (not the whole `.git`) is still correct with the
/// env var set: a write that actually changes something — `add`, `commit`,
/// `switch` — renames the real `index` (or `HEAD`) into place regardless of
/// optional locks, so those events still arrive; only the lock-file churn a
/// pure read leaves behind is suppressed. Verified live: a non-recursive
/// `notify` watch on `.git` sees `index.lock` create+remove on every
/// `git status --porcelain=v2 --branch -z` without this env var, and sees
/// nothing from repeated `git status` calls with it set (see the
/// `status_alone_does_not_touch_the_meta_watch` test below).
fn run_git(dir: &Path, args: &[&str]) -> Option<std::process::Output> {
    let mut command = Command::new("git");
    command.arg("-C").arg(dir).args(args).env("GIT_OPTIONAL_LOCKS", "0");

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

/// The `io:`-prefixed message for a failed git invocation: git's own words,
/// stderr first, stdout when stderr is empty (git prints "nothing to commit"
/// on stdout). Shared by `run_git_ok` and `nox_git_commit` — the latter
/// builds its own `Command` for stdin piping and so cannot go through
/// `run_git`, but the failure-reporting rule is the same either way. The
/// `io:` prefix is the fs.rs error convention; `platform/tauri.ts` strips it,
/// so what the renderer sees is git verbatim.
fn git_error(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    format!("io: {}", if stderr.is_empty() { stdout } else { stderr })
}

/// Run git and insist on success. Unlike `run_git`'s callers in the gutter
/// path — where every failure is an honest `None` — a failed *write* must say
/// why: see `git_error`.
fn run_git_ok(dir: &Path, args: &[&str]) -> Result<std::process::Output> {
    let output = run_git(dir, args).ok_or_else(|| "io: git could not be run".to_string())?;
    if output.status.success() {
        return Ok(output);
    }
    Err(git_error(&output))
}

/// The repository toplevel for `root`, in git's own vocabulary.
fn repo_toplevel(root: &Path) -> Result<String> {
    let output = run_git_ok(root, &["rev-parse", "--show-toplevel"])?;
    let top = String::from_utf8_lossy(&output.stdout).trim_end_matches(['\r', '\n']).to_string();
    if top.is_empty() {
        return Err("io: fatal: not a git repository".to_string());
    }
    Ok(top)
}

/// A path made repo-relative by the same canonicalize-and-strip route
/// `nox_git_file_base` uses. A deleted file cannot canonicalize, so the
/// fallback resolves its parent and re-appends the name — staging a deletion
/// is a first-class action in the panel.
fn repo_relative(toplevel: &str, path: &str) -> Result<String> {
    let p = Path::new(path);
    let full = plain_canonical(p)
        .or_else(|| {
            let parent = plain_canonical(p.parent()?)?;
            let name = p.file_name()?.to_str()?;
            Some(format!("{parent}/{name}"))
        })
        .ok_or_else(|| format!("io: cannot resolve {path}"))?;
    relative_to_root(toplevel, &full)
        .ok_or_else(|| format!("io: {path} is not inside the repository"))
}

/// Raw porcelain v2 status, prefixed with one synthetic record of our own:
/// `# git.toplevel <path>\0`, ahead of everything git itself prints. The
/// panel joins status paths (toplevel-relative, per porcelain) onto this
/// rather than the workspace root, because the two differ whenever a
/// workspace is opened below the repo root — joining onto the wrong one
/// silently targets a same-named file elsewhere in the tree. `-z` because
/// filenames contain anything; parsing (including this prefix) lives in
/// TypeScript where it is testable without a repo.
///
/// `from_utf8_lossy`, not `from_utf8`: one non-UTF-8 filename anywhere in a
/// large status must not fail the whole call and blank the panel — a
/// replacement character in one row is the correct degraded state, the same
/// principle `git_error` already applies to failure messages.
#[tauri::command]
pub fn nox_git_status(root: String) -> Result<String> {
    let top = repo_toplevel(Path::new(&root))?;
    let output = run_git_ok(Path::new(&root), &["status", "--porcelain=v2", "--branch", "-z"])?;
    let raw = String::from_utf8_lossy(&output.stdout);
    Ok(format!("# git.toplevel {top}\0{raw}"))
}

/// Raw local branch list, one short refname per line.
#[tauri::command]
pub fn nox_git_branches(root: String) -> Result<String> {
    let output = run_git_ok(
        Path::new(&root),
        &["branch", "--list", "--format=%(refname:short)"],
    )?;
    String::from_utf8(output.stdout).map_err(|_| "io: git branch output was not utf-8".to_string())
}

/// `git add`. Argv-fixed; `--literal-pathspecs` so a `*` or `:` in a real
/// filename is a filename, and `--` so nothing is ever read as an option.
#[tauri::command]
pub fn nox_git_stage(root: String, paths: Vec<String>) -> Result<()> {
    let top = repo_toplevel(Path::new(&root))?;
    let mut args: Vec<String> = vec!["--literal-pathspecs".into(), "add".into(), "--".into()];
    for path in &paths {
        args.push(repo_relative(&top, path)?);
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git_ok(Path::new(&top), &refs)?;
    Ok(())
}

/// `git reset -- <pathspec>` (never `--hard`, never a ref beyond the
/// implicit `HEAD`): the index only, the working tree untouchable by
/// construction. Not `git restore --staged` — verified live, that command
/// fails with "fatal: could not resolve HEAD" on a repo with no commits yet
/// (an unborn branch, e.g. right after `git init`), while pathspec-limited
/// `reset` handles that case cleanly.
#[tauri::command]
pub fn nox_git_unstage(root: String, paths: Vec<String>) -> Result<()> {
    // An empty pathspec list after `--` is not "nothing to do" to git — it is
    // `git reset --`, bare, which resets the *entire* index to HEAD. A caller
    // passing `[]` (a stage/unstage-all bug, an empty selection) must not
    // silently escalate into a full unstage.
    if paths.is_empty() {
        return Ok(());
    }
    let top = repo_toplevel(Path::new(&root))?;
    let mut args: Vec<String> = vec!["--literal-pathspecs".into(), "reset".into(), "--".into()];
    for path in &paths {
        args.push(repo_relative(&top, path)?);
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git_ok(Path::new(&top), &refs)?;
    Ok(())
}

/// `git commit --file=-`, the message on stdin — never argv: messages
/// contain quotes, dashes, anything. Never `-a`, never pathspecs: what you
/// staged is what lands. Hooks and signing run because git runs them; a
/// refusal is surfaced verbatim.
#[tauri::command]
pub fn nox_git_commit(root: String, message: String) -> Result<String> {
    use std::process::Stdio;

    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(&root)
        .args(["commit", "--file=-"])
        // Same reasoning as `run_git`'s doc comment: this command builds its
        // own `Command` (for stdin piping) rather than going through
        // `run_git`, so it needs its own copy of the env var. A commit is a
        // real write regardless — `GIT_OPTIONAL_LOCKS` only suppresses the
        // lock churn a pure *read* would otherwise leave for the meta watch
        // to see; it does not stop the real `index`/`HEAD` rename a commit
        // performs, which is what the watch is meant to catch.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command.spawn().map_err(|e| format!("io: git could not be run ({e})"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "io: no stdin handle".to_string())?
        .write_all(message.as_bytes())
        .map_err(|e| format!("io: could not write the message ({e})"))?;
    let output = child
        .wait_with_output()
        .map_err(|e| format!("io: git did not finish ({e})"))?;

    if !output.status.success() {
        return Err(git_error(&output));
    }

    let log = run_git_ok(Path::new(&root), &["log", "-1", "--format=%h %s"])?;
    Ok(String::from_utf8_lossy(&log.stdout).trim().to_string())
}

/// `git switch`, the name validated first with `check-ref-format --branch`
/// (a read) so the only strings reaching the write are ones git itself
/// blessed. Never `-f`: a refusal over dirty files is git's to make and
/// ours to show.
#[tauri::command]
pub fn nox_git_switch(root: String, name: String, create: bool) -> Result<()> {
    let dir = Path::new(&root);
    run_git_ok(dir, &["check-ref-format", "--branch", &name])?;
    if create {
        run_git_ok(dir, &["switch", "-c", &name])?;
    } else {
        run_git_ok(dir, &["switch", &name])?;
    }
    Ok(())
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

    /// Read stdout of a git command that must succeed — for assertions.
    fn git_out(dir: &Path, args: &[&str]) -> String {
        let output = run_git(dir, args).expect("git runs");
        assert!(output.status.success(), "git {args:?} failed");
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    #[test]
    fn stage_and_unstage_round_trip_in_porcelain() {
        let scratch = Scratch::new("git-stage");
        git_in(&scratch.0, &["init"]);
        let file = scratch.join("a.txt");
        fs::write(&file, "one\n").unwrap();

        nox_git_stage(as_string(&scratch.0), vec![as_string(&file)]).unwrap();
        assert!(git_out(&scratch.0, &["status", "--porcelain"]).starts_with("A  a.txt"));

        nox_git_unstage(as_string(&scratch.0), vec![as_string(&file)]).unwrap();
        assert!(git_out(&scratch.0, &["status", "--porcelain"]).starts_with("?? a.txt"));
        // The working tree was never touched.
        assert_eq!(fs::read_to_string(&file).unwrap(), "one\n");
    }

    #[test]
    fn staging_a_deleted_file_records_the_deletion() {
        let scratch = Scratch::new("git-stage-del");
        git_in(&scratch.0, &["init"]);
        let file = scratch.join("a.txt");
        fs::write(&file, "one\n").unwrap();
        git_in(&scratch.0, &["add", "a.txt"]);
        git_in(&scratch.0, &["commit", "-m", "base"]);
        fs::remove_file(&file).unwrap();

        // The path no longer exists, so canonicalize-and-strip must fall
        // back to the parent — the case this test pins.
        nox_git_stage(as_string(&scratch.0), vec![as_string(&file)]).unwrap();
        assert!(git_out(&scratch.0, &["status", "--porcelain"]).starts_with("D  a.txt"));
    }

    #[test]
    fn commit_lands_the_exact_multiline_message_and_only_one_commit() {
        let scratch = Scratch::new("git-commit");
        git_in(&scratch.0, &["init"]);
        // `nox_git_commit` runs plain `git commit` — no inline `-c` identity
        // like `git_in` carries — so the repo itself must hold one, exactly
        // as a user's repo would. CI runners have no global identity.
        git_in(&scratch.0, &["config", "user.email", "t@t"]);
        git_in(&scratch.0, &["config", "user.name", "t"]);
        git_in(&scratch.0, &["config", "commit.gpgsign", "false"]);
        fs::write(scratch.join("a.txt"), "one\n").unwrap();
        git_in(&scratch.0, &["add", "a.txt"]);

        // Quotes, a lone `--`, a second paragraph: stdin makes them all safe.
        let message = "Say \"hello\" -- carefully\n\nBody with 'quotes' and -- dashes.\n";
        let result = nox_git_commit(as_string(&scratch.0), message.to_string()).unwrap();
        assert!(result.ends_with("Say \"hello\" -- carefully"), "got {result:?}");

        assert_eq!(git_out(&scratch.0, &["rev-list", "--count", "HEAD"]).trim(), "1");
        assert_eq!(git_out(&scratch.0, &["log", "-1", "--format=%B"]).trim_end(), message.trim_end());
    }

    #[test]
    fn commit_with_nothing_staged_fails_with_gits_words() {
        let scratch = Scratch::new("git-commit-clean");
        git_in(&scratch.0, &["init"]);
        git_in(&scratch.0, &["config", "user.email", "t@t"]);
        git_in(&scratch.0, &["config", "user.name", "t"]);
        git_in(&scratch.0, &["config", "commit.gpgsign", "false"]);
        git_in(&scratch.0, &["commit", "--allow-empty", "-m", "root"]);

        let error = nox_git_commit(as_string(&scratch.0), "message".to_string()).unwrap_err();
        // Git says this on stdout, which is why the helper falls back to it.
        assert!(error.contains("nothing to commit"), "got {error:?}");
    }

    #[test]
    fn switch_refuses_a_dirty_conflict_and_the_tree_is_byte_identical() {
        let scratch = Scratch::new("git-switch-dirty");
        git_in(&scratch.0, &["init", "-b", "main"]);
        let file = scratch.join("f.txt");
        fs::write(&file, "v1\n").unwrap();
        git_in(&scratch.0, &["add", "f.txt"]);
        git_in(&scratch.0, &["commit", "-m", "one"]);
        git_in(&scratch.0, &["switch", "-c", "other"]);
        fs::write(&file, "v2\n").unwrap();
        git_in(&scratch.0, &["add", "f.txt"]);
        git_in(&scratch.0, &["commit", "-m", "two"]);
        git_in(&scratch.0, &["switch", "main"]);
        fs::write(&file, "dirty\n").unwrap();

        let error = nox_git_switch(as_string(&scratch.0), "other".to_string(), false).unwrap_err();
        // The phrase the MemoryPlatform fake mirrors — this assertion is the
        // tripwire that keeps fake and real from drifting apart.
        assert!(
            error.contains("Your local changes to the following files would be overwritten"),
            "got {error:?}"
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "dirty\n");
        assert_eq!(git_out(&scratch.0, &["branch", "--show-current"]).trim(), "main");
    }

    #[test]
    fn created_branch_appears_in_the_list() {
        let scratch = Scratch::new("git-branch-create");
        git_in(&scratch.0, &["init", "-b", "main"]);
        git_in(&scratch.0, &["commit", "--allow-empty", "-m", "root"]);

        nox_git_switch(as_string(&scratch.0), "feature/x".to_string(), true).unwrap();
        let branches = nox_git_branches(as_string(&scratch.0)).unwrap();
        assert!(branches.lines().any(|l| l == "feature/x"), "got {branches:?}");
        assert!(branches.lines().any(|l| l == "main"));
    }

    #[test]
    fn invalid_branch_name_is_refused_by_the_validation_read() {
        let scratch = Scratch::new("git-branch-bad");
        git_in(&scratch.0, &["init", "-b", "main"]);
        git_in(&scratch.0, &["commit", "--allow-empty", "-m", "root"]);

        let error = nox_git_switch(as_string(&scratch.0), "bad name".to_string(), true).unwrap_err();
        assert!(error.contains("not a valid branch name"), "got {error:?}");
        // The write never ran: no such branch exists.
        let branches = nox_git_branches(as_string(&scratch.0)).unwrap();
        assert!(!branches.contains("bad"), "got {branches:?}");
    }

    #[test]
    fn status_carries_branch_and_entries_nul_terminated() {
        let scratch = Scratch::new("git-status");
        git_in(&scratch.0, &["init", "-b", "main"]);
        fs::write(scratch.join("a.txt"), "one\n").unwrap();

        let raw = nox_git_status(as_string(&scratch.0)).unwrap();
        assert!(raw.contains("# branch.head main"));
        assert!(raw.contains("? a.txt\u{0}"), "got {raw:?}");
    }

    #[test]
    fn status_leads_with_the_repo_toplevel_record() {
        let scratch = Scratch::new("git-status-top");
        git_in(&scratch.0, &["init", "-b", "main"]);
        fs::create_dir_all(scratch.join("sub")).unwrap();
        fs::write(scratch.join("sub/a.txt"), "one\n").unwrap();

        // Called from a subdirectory, the way a workspace opened below the
        // repo root would: the toplevel record must still name the repo
        // root, not the directory `-C` was given.
        let raw = nox_git_status(as_string(&scratch.join("sub"))).unwrap();
        let top = plain_canonical(&scratch.0).unwrap();
        assert!(
            raw.starts_with(&format!("# git.toplevel {top}\u{0}")),
            "got {raw:?}"
        );
    }

    #[test]
    fn unstage_of_an_empty_path_list_touches_nothing() {
        let scratch = Scratch::new("git-unstage-empty");
        git_in(&scratch.0, &["init", "-b", "main"]);
        let file = scratch.join("a.txt");
        fs::write(&file, "one\n").unwrap();
        git_in(&scratch.0, &["add", "a.txt"]);

        // Bare `git reset --` would unstage everything; an empty selection
        // must be a no-op instead, never an escalation to "unstage all".
        nox_git_unstage(as_string(&scratch.0), vec![]).unwrap();

        assert!(git_out(&scratch.0, &["status", "--porcelain"]).starts_with("A  a.txt"));
    }

    /// The Critical-1 probe: reproduces the reviewer's scenario directly —
    /// a real, non-recursive `notify` watch on `.git` (the same shape
    /// `nox_git_meta_watch` installs) sitting through repeated
    /// `nox_git_status` calls. Without `GIT_OPTIONAL_LOCKS=0` a plain
    /// `git status` still takes and releases `.git/index.lock`, which a
    /// meta watch sees as a rename event — the self-sustaining refresh loop
    /// this fix closes. `nox_git_status` (via `run_git`) now sets the env
    /// var, so a steady-state status must fire nothing at all.
    #[test]
    fn status_alone_does_not_touch_the_meta_watch() {
        use notify::{RecursiveMode, Watcher};
        use std::sync::mpsc;
        use std::time::Duration;

        let scratch = Scratch::new("git-status-quiet");
        git_in(&scratch.0, &["init", "-b", "main"]);
        git_in(&scratch.0, &["commit", "--allow-empty", "-m", "root"]);
        fs::write(scratch.join("a.txt"), "one\n").unwrap();

        let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                let Ok(event) = result else { return };
                use notify::EventKind;
                // Same filter nox_git_meta_watch applies: only HEAD/index
                // (and their .lock shadows) count.
                let relevant: Vec<PathBuf> = event
                    .paths
                    .iter()
                    .filter(|p| {
                        matches!(
                            p.file_name().and_then(|n| n.to_str()),
                            Some("HEAD" | "index" | "HEAD.lock" | "index.lock")
                        )
                    })
                    .cloned()
                    .collect();
                if relevant.is_empty() {
                    return;
                }
                if matches!(event.kind, EventKind::Access(_)) {
                    return;
                }
                let _ = tx.send(relevant);
            })
            .expect("create watcher");
        watcher
            .watch(&scratch.join(".git"), RecursiveMode::NonRecursive)
            .expect("watch .git");

        // Steady state: a handful of reads, the way the debounced refresh
        // loop would run them back to back.
        for _ in 0..5 {
            let status = nox_git_status(as_string(&scratch.0)).unwrap();
            assert!(status.contains("# git.toplevel"));
        }

        // No event should have arrived — give the watcher a beat to prove a
        // negative, then check nothing landed.
        let saw = rx.recv_timeout(Duration::from_millis(800));
        drop(watcher);

        assert!(
            saw.is_err(),
            "expected no meta-watch events from repeated status alone, got {saw:?}"
        );
    }
}


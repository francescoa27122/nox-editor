//! Git file bases, and the stage/commit/branch commands.
//!
//! `nox_git_file_base` fetches the version of a file the git index holds
//! (`:0:` — what `git add` would leave alone). The index rather than HEAD
//! because the gutter's question is "what have I changed that git doesn't
//! hold yet", and for anyone not mid-staging the index *is* HEAD anyway.
//! Mid-merge there is no stage 0 and the lookup walks `INDEX_STAGES`
//! instead; that constant carries the reasoning.
//!
//! `None` is the answer to everything that isn't content: no repo, untracked
//! file, git not installed, non-UTF-8 blob. A missing gutter is the correct
//! degraded state, so no failure here may become a dialog — `Err` is reserved
//! for what the fs.rs convention reserves it for and is not expected in
//! practice.
//!
//! `nox_git_blame` shares that contract and that opening, since both reach a
//! file through `repo_and_relpath`, and differs in one way that matters: it is
//! the crate's only `#[tauri::command(async)]`, because it is the only git
//! read here whose cost scales with a file's *history* rather than with one
//! blob, and a sync command body runs on the thread that must also draw the
//! window. Its own doc comment carries the argument.
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
    let mut stdin = child.stdin.take().ok_or_else(|| "io: no stdin handle".to_string())?;

    // A broken pipe here is not a failure worth reporting: it means git exited
    // before it read the message, which is exactly what it does when it
    // refuses the commit — unmerged files, nothing staged, a failing hook.
    // Returning the pipe error would replace git's own explanation with a
    // plumbing detail, and whether the write loses that race is a matter of
    // pipe buffering, so the same refusal produced git's words on macOS and
    // "Broken pipe (os error 32)" on Linux. Fall through and let git speak.
    match stdin.write_all(message.as_bytes()) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => {}
        Err(error) => return Err(format!("io: could not write the message ({error})")),
    }
    // Explicit, because git waits for EOF on `--file=-` and the borrow above
    // would otherwise hold the pipe open until the end of the function.
    drop(stdin);
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

/// The index stages `nox_git_file_base` will read, in the order it reads them.
///
/// Stage 0 is the ordinary index entry and the only one a path outside a
/// merge has. Mid-merge it does not exist at all: `git show :0:<path>` on an
/// unmerged path exits non-zero with "is in the index, but not at stage 0",
/// which read as "untracked" for as long as this was a single lookup — so a
/// conflicted file lost its gutter, and the diff view told the user the file
/// was untracked or outside a repository while they were staring at conflict
/// markers inside a tracked file in a repository.
///
/// **2 before 1** is the substantive decision. Stage 2 is *ours* — the
/// content HEAD held before the merge started — and stage 1 is the merge
/// base. The gutter's question is "what have I changed that git does not
/// hold yet", and for anyone not mid-staging the index is HEAD anyway; the
/// mid-merge analogue of that is HEAD's own side, so diffing against stage 2
/// marks exactly the lines the merge is proposing to add to the file. Stage 1
/// would instead mark the user's *already committed* work as unheld, which is
/// the wrong answer to the gutter's question. Stage 1 is still the second
/// fallback because a modify/delete conflict where our side deleted the file
/// has stages 1 and 3 only, and the merge base is then the sole content git
/// has for the path.
///
/// Stage 3 (*theirs*) is deliberately absent: it is the one side the working
/// tree is not, so a diff against it would describe neither what the user
/// wrote nor what they had.
const INDEX_STAGES: [u8; 3] = [0, 2, 1];

/// The index's version of the file, or `None` when there isn't one.
#[tauri::command]
pub fn nox_git_file_base(path: String) -> Result<Option<String>> {
    let Some((root, relpath)) = repo_and_relpath(&path) else {
        return Ok(None);
    };

    // Stage 0 first — the ordinary case, and the only stage that exists for
    // a path that is not mid-merge. `2` and `1` are the unmerged fallbacks;
    // see `INDEX_STAGES` for why in that order.
    for stage in INDEX_STAGES {
        // `--literal-pathspecs` so a `*` or `:` in a real filename is a
        // filename, not a glob or magic pathspec.
        let spec = format!(":{stage}:{relpath}");
        let Some(output) = run_git(Path::new(&root), &["--literal-pathspecs", "show", &spec]) else {
            return Ok(None);
        };
        if !output.status.success() {
            // This stage does not exist. For stage 0 that is the ordinary
            // "untracked, or not in the index" — but it is *also* what git
            // says about every tracked file mid-merge, so the loop tries the
            // unmerged stages before giving up rather than reporting a
            // conflicted file as untracked.
            continue;
        }
        return match String::from_utf8(output.stdout) {
            Ok(text) => Ok(Some(text)),
            // A binary blob is not a base to diff against.
            Err(_) => Ok(None),
        };
    }
    Ok(None)
}

/// The repository root for `path`, and `path` relative to it: the shared
/// opening of every per-file read here. `None` for everything that is not a
/// tracked place: no git, no repository, an unresolvable path.
///
/// Factored out of `nox_git_file_base` when blame arrived rather than
/// copied: the two must agree about what "inside this repository" means, or
/// a file could have a gutter and no blame for reasons neither one states.
fn repo_and_relpath(path: &str) -> Option<(String, String)> {
    // Resolved before anything else: the relpath computation compares this
    // against the root git prints, and git prints resolved paths.
    let file = plain_canonical(Path::new(path))?;
    let parent = Path::new(&file).parent()?;

    let output = run_git(parent, &["rev-parse", "--show-toplevel"])?;
    if !output.status.success() {
        // Not a repo. rev-parse says so on stderr; the callers don't care.
        return None;
    }
    let root = String::from_utf8(output.stdout).ok()?;
    let root = root.trim_end_matches(['\r', '\n']);
    if root.is_empty() {
        return None;
    }

    let relpath = relative_to_root(root, &file)?;
    Some((root.to_string(), relpath))
}

/// Raw `git blame --porcelain` output for `contents` as the current text of
/// `path`, or `None`.
///
/// **The buffer's text is blamed, not the file on disk, and that is the
/// whole design.** `git blame <path>` describes what is saved; the gutter
/// draws beside what is *open*. Whenever those differ, on any unsaved edit,
/// blaming the saved file misaligns every annotation after the first
/// inserted or deleted line, and a blame gutter that attributes a line to
/// someone who did not write it is worse than no gutter at all. `--contents`
/// is git's own answer to exactly this: it blames the text it is given
/// against the path's history, attributing lines that are in the text but in
/// no commit to the all-zero object name. So alignment is exact by
/// construction, and "not committed yet" becomes a fact git computed rather
/// than one the renderer inferred.
///
/// **The one `#[tauri::command(async)]` in the crate, and it is deliberate.**
/// A sync command body runs inline on the thread that handles the IPC
/// message, which is the main thread, so its duration is the window's
/// duration. For
/// every other git read here that is a non-issue: `git show :0:<path>` and
/// `git status` cost one blob and one index scan. Blame is the first git read
/// in this codebase whose cost scales with a file's *history* rather than
/// with one blob: it walks every commit that ever touched the path, and on an
/// old file in a large repository that is seconds, not milliseconds.
/// `(async)` on a sync function makes Tauri run the body on the async runtime
/// instead (`sync_threadpool`, in the macro's own vocabulary), which is what
/// keeps a slow blame from freezing the window it was invoked from. The
/// function itself stays `pub fn`, because there is nothing to await and
/// nothing to
/// cancel, so the reason the rest of the crate avoids `async fn` does not
/// apply.
///
/// `--porcelain`, not `--line-porcelain`: the line variant repeats a commit's
/// whole header block for every line it owns, which multiplies the payload
/// crossing the boundary by the size of each group for no extra fact. Parsing
/// lives in `core/git-blame.ts`, where it is testable without a repo: the
/// same split `nox_git_status` makes.
///
/// `None` is the answer to everything that is not blame output: no
/// repository, an untracked file, git not installed. The gutter's degraded
/// state is absence, exactly as it is for `nox_git_file_base`, so no failure
/// here may become a dialog.
///
/// `from_utf8_lossy` rather than a strict decode, and the choice is load
/// bearing in the opposite direction from `nox_git_file_base`'s. Porcelain
/// output interleaves the *file's own content*, one tab-prefixed line per
/// blamed line, with the headers, so one line of Latin-1 in an otherwise
/// ordinary source file would fail a strict decode and blank the blame for
/// the whole file. The parser reads only the header fields and drops every
/// content line, so a replacement character can only ever land somewhere
/// nothing reads. Where a strict decode would be right, on a blob that *is*
/// the answer, `nox_git_file_base` still uses one.
#[tauri::command(async)]
pub fn nox_git_blame(path: String, contents: String) -> Result<Option<String>> {
    use std::process::Stdio;

    let Some((root, relpath)) = repo_and_relpath(&path) else {
        return Ok(None);
    };

    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(&root)
        // `--literal-pathspecs` so a `*` or `:` in a real filename is a
        // filename, and `--` so nothing after it is ever read as an option.
        // A read, like every argument here: nothing that writes, leaves the
        // machine, or rewrites history.
        .args(["--literal-pathspecs", "blame", "--porcelain", "--contents", "-", "--", &relpath])
        // Same reasoning as `run_git`'s doc comment; this command builds its
        // own `Command` for stdin piping and so needs its own copy.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let Ok(mut child) = command.spawn() else {
        // git is not installed. Absence, like every other non-answer here.
        return Ok(None);
    };
    let Some(mut stdin) = child.stdin.take() else {
        return Ok(None);
    };

    // **The write runs on its own thread.** Unlike `nox_git_commit`, whose
    // message always fits in a pipe buffer, the text here is a whole
    // document and the output is larger still, so a sequential
    // write-everything-then-read would deadlock the moment git's stdout
    // buffer filled: git blocked writing output nobody is draining, this
    // thread blocked writing input git has stopped reading.
    //
    // Measured, not assumed, and the measurement says the opposite of what
    // the paragraph above fears: git 2.43 consumes the whole of
    // `--contents -` before emitting anything, so 440 KB of input completes
    // a sequential write with nothing draining stdout. The thread stays
    // because that is a property of git's *buffering*, not of its interface,
    // and nothing in `git blame`'s contract promises it. The cost of being
    // wrong is a hung thread in the runtime pool and a blame that never
    // arrives; the cost of the thread is one spawn per invocation.
    //
    // A broken pipe is not a failure worth reporting. It means git exited
    // before reading the text, which is what it does when it refuses the
    // path, so the writer swallows its error and lets git's own exit status
    // below decide.
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(contents.as_bytes());
        // Explicit, because git waits for EOF on `--contents -`.
        drop(stdin);
    });

    let output = child.wait_with_output();
    let _ = writer.join();

    let Ok(output) = output else {
        return Ok(None);
    };
    if !output.status.success() {
        // Untracked, outside the repository, or a path git will not blame.
        // All of them are "no blame for this file", which is what absence
        // means to the caller.
        return Ok(None);
    }

    Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()))
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

    /// Run git in `dir` and tolerate a refusal — for the one command a test
    /// *wants* to fail. `git merge` over a conflicting change exits non-zero
    /// by design, so `git_in`'s assertion would fail the test on the very
    /// state it is trying to construct.
    fn git_try(dir: &Path, args: &[&str]) {
        let _ = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .expect("git runs");
    }

    /// Leave `dir` mid-merge with `name` unmerged, both sides having edited
    /// it: the `u UU` state, index stages 1, 2 and 3, no stage 0.
    fn conflict_both_modified(dir: &Path, name: &str) {
        git_in(dir, &["init", "-b", "main"]);
        fs::write(dir.join(name), "base line\ncommon\n").unwrap();
        git_in(dir, &["add", name]);
        git_in(dir, &["commit", "-m", "base"]);
        git_in(dir, &["switch", "-c", "theirs"]);
        fs::write(dir.join(name), "their line\ncommon\n").unwrap();
        git_in(dir, &["commit", "-am", "theirs"]);
        git_in(dir, &["switch", "main"]);
        fs::write(dir.join(name), "our line\ncommon\n").unwrap();
        git_in(dir, &["commit", "-am", "ours"]);
        git_try(dir, &["merge", "theirs"]);
    }

    /// Guard: the scenario builders above are worthless if the merge did not
    /// actually conflict, so every unmerged-path test asserts the state it
    /// depends on before asserting the behaviour.
    fn assert_unmerged(dir: &Path, name: &str) {
        let status = git_out(dir, &["status", "--porcelain=v2"]);
        assert!(
            status.lines().any(|l| l.starts_with("u ") && l.ends_with(name)),
            "expected {name} unmerged, got {status:?}"
        );
        let stage_zero = run_git(dir, &["--literal-pathspecs", "show", &format!(":0:{name}")])
            .expect("git runs");
        assert!(
            !stage_zero.status.success(),
            "expected no stage 0 for an unmerged path; git printed {:?}",
            String::from_utf8_lossy(&stage_zero.stdout)
        );
    }

    /// Guards the defect: `git show :0:<path>` *fails* on an unmerged path —
    /// stage 0 does not exist mid-merge — and treating that failure as
    /// "not in the index" left a conflicted file with no gutter at all,
    /// while the diff view told the user it was untracked or outside a
    /// repository. Stage 2 ("ours") is the pre-merge HEAD content, which is
    /// the base that answers the gutter's actual question mid-merge: what is
    /// this merge proposing to do to my file.
    #[test]
    fn an_unmerged_path_falls_back_to_ours() {
        let scratch = Scratch::new("git-unmerged-ours");
        conflict_both_modified(&scratch.0, "app.ts");
        assert_unmerged(&scratch.0, "app.ts");

        let base = nox_git_file_base(as_string(&scratch.join("app.ts"))).unwrap();

        assert_eq!(base.as_deref(), Some("our line\ncommon\n"));
    }

    /// The other half of the fallback. When *our* side deleted the file and
    /// theirs edited it, the index carries stages 1 and 3 but no stage 2, so
    /// "ours" is not available and the merge base is the only content git
    /// has. Without this rung the modify/delete conflict — the one whose
    /// resolution is hardest to reason about — would still show no gutter.
    #[test]
    fn an_unmerged_path_without_ours_falls_back_to_the_merge_base() {
        let scratch = Scratch::new("git-unmerged-base");
        git_in(&scratch.0, &["init", "-b", "main"]);
        fs::write(scratch.join("d.txt"), "base\n").unwrap();
        git_in(&scratch.0, &["add", "d.txt"]);
        git_in(&scratch.0, &["commit", "-m", "base"]);
        git_in(&scratch.0, &["switch", "-c", "theirs"]);
        fs::write(scratch.join("d.txt"), "theirs edit\n").unwrap();
        git_in(&scratch.0, &["commit", "-am", "theirs"]);
        git_in(&scratch.0, &["switch", "main"]);
        git_in(&scratch.0, &["rm", "d.txt"]);
        git_in(&scratch.0, &["commit", "-m", "ours deletes"]);
        git_try(&scratch.0, &["merge", "theirs"]);
        assert_unmerged(&scratch.0, "d.txt");

        let base = nox_git_file_base(as_string(&scratch.join("d.txt"))).unwrap();

        assert_eq!(base.as_deref(), Some("base\n"));
    }

    /// The tripwire that keeps the `MemoryPlatform` fake honest about what a
    /// commit does mid-merge. An unmerged path has no stage 0, so a fake that
    /// snapshots its index into HEAD would quietly drop the conflicted file;
    /// real git refuses instead, and the fake mirrors this phrase.
    #[test]
    fn a_commit_with_unmerged_files_is_refused_with_gits_words() {
        let scratch = Scratch::new("git-commit-unmerged");
        conflict_both_modified(&scratch.0, "app.ts");
        assert_unmerged(&scratch.0, "app.ts");
        git_in(&scratch.0, &["config", "user.email", "t@t"]);
        git_in(&scratch.0, &["config", "user.name", "t"]);
        git_in(&scratch.0, &["config", "commit.gpgsign", "false"]);

        let error = nox_git_commit(as_string(&scratch.0), "message".to_string()).unwrap_err();

        assert!(
            error.contains("Committing is not possible because you have unmerged files"),
            "got {error:?}"
        );
        assert!(error.contains("Exiting because of an unresolved conflict"), "got {error:?}");
    }

    /// The fallback must not turn "untracked" into a base. An unmerged path
    /// is the only reason to look past stage 0; a file git has never heard
    /// of has no stage 1, 2 or 3 either, and `None` stays the answer.
    #[test]
    fn the_unmerged_fallback_does_not_invent_a_base_for_an_untracked_file() {
        let scratch = Scratch::new("git-unmerged-untracked");
        conflict_both_modified(&scratch.0, "app.ts");
        let loose = scratch.join("loose.txt");
        fs::write(&loose, "never added\n").unwrap();

        assert_eq!(nox_git_file_base(as_string(&loose)).unwrap(), None);
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

    /// Real git names a *directory* in status whenever one is untracked
    /// (`? fresh/`), and `git add -- fresh` on that row adds every file
    /// beneath it. This pins the production behaviour the `MemoryPlatform`
    /// fake mirrors: the fake used to throw "did not match any files" for a
    /// directory pathspec, so the Git panel's directory row could not be
    /// exercised at all and its broken open/diff affordances went unnoticed.
    #[test]
    fn staging_a_directory_adds_every_file_beneath_it() {
        let scratch = Scratch::new("git-stage-dir");
        git_in(&scratch.0, &["init", "-b", "main"]);
        git_in(&scratch.0, &["commit", "--allow-empty", "-m", "root"]);
        fs::create_dir_all(scratch.join("fresh/inner")).unwrap();
        fs::write(scratch.join("fresh/m.txt"), "m\n").unwrap();
        fs::write(scratch.join("fresh/inner/n.txt"), "n\n").unwrap();

        // git collapses the whole thing into one record before staging.
        let before = git_out(&scratch.0, &["status", "--porcelain"]);
        assert_eq!(before.trim(), "?? fresh/", "got {before:?}");

        nox_git_stage(as_string(&scratch.0), vec![as_string(&scratch.join("fresh"))]).unwrap();

        let after = git_out(&scratch.0, &["status", "--porcelain"]);
        assert!(after.contains("A  fresh/m.txt"), "got {after:?}");
        assert!(after.contains("A  fresh/inner/n.txt"), "got {after:?}");
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
        // `plain_canonical` speaks the OS's own separators (backslashed on
        // Windows); `# git.toplevel` speaks git's `--show-toplevel`
        // vocabulary (forward-slashed everywhere, per the doc comment on
        // `plain_canonical` above) — the same normalization `relative_to_root`
        // applies before comparing the two. Elsewhere (macOS, Linux) this is
        // a no-op: there are no backslashes in those paths to begin with.
        let top = plain_canonical(&scratch.0).unwrap().replace('\\', "/");
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
    /// Run `work` with a non-recursive watch on `.git` and return whatever
    /// meta-watch-relevant event arrived first, if any.
    ///
    /// Extracted when blame arrived so both reads can be held to the same
    /// promise. The filter is `nox_git_meta_watch`'s own: only `HEAD` and
    /// `index` (and their `.lock` shadows) count.
    fn meta_events_while(dir: &Path, work: impl Fn()) -> Option<Vec<PathBuf>> {
        use notify::{RecursiveMode, Watcher};
        use std::sync::mpsc;
        use std::time::Duration;

        let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                let Ok(event) = result else { return };
                use notify::EventKind;
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
        watcher.watch(&dir.join(".git"), RecursiveMode::NonRecursive).expect("watch .git");

        work();

        // Give the watcher a beat, because the assertion is a negative.
        let saw = rx.recv_timeout(Duration::from_millis(800)).ok();
        drop(watcher);
        saw
    }

    /// `GIT_OPTIONAL_LOCKS=0` earns its place here. Without it even a read
    /// takes and releases `.git/index.lock`, the meta watch sees the
    /// create-and-rename, and the debounced refresh it triggers runs the
    /// read again: a loop that never settles.
    #[test]
    fn status_alone_does_not_touch_the_meta_watch() {
        let scratch = Scratch::new("git-status-quiet");
        git_in(&scratch.0, &["init", "-b", "main"]);
        git_in(&scratch.0, &["commit", "--allow-empty", "-m", "root"]);
        fs::write(scratch.join("a.txt"), "one\n").unwrap();

        // Steady state: a handful of reads, the way the debounced refresh
        // loop would run them back to back.
        let saw = meta_events_while(&scratch.0, || {
            for _ in 0..5 {
                let status = nox_git_status(as_string(&scratch.0)).unwrap();
                assert!(status.contains("# git.toplevel"));
            }
        });

        assert!(
            saw.is_none(),
            "expected no meta-watch events from repeated status alone, got {saw:?}"
        );
    }

    /// The same promise for blame, and it matters more here. A meta-watch
    /// event makes `GitService` run `refreshAll`, which re-blames every
    /// buffer blame is on for, so a blame that disturbed the index would
    /// feed the watch that triggered it, and each turn of that loop spawns a
    /// process per open file.
    ///
    /// **This does not prove `GIT_OPTIONAL_LOCKS=0` is what keeps it quiet,
    /// and it is worth knowing that before assuming otherwise.** Probed by
    /// deleting the env var from `nox_git_blame`: the test still passes, so
    /// `git blame --contents -` simply does not take `index.lock` the way
    /// `git status` does. The env var stays, because it is the module's rule for
    /// every git invocation, and "today's git does not happen to need it" is
    /// not a reason to be the one command without it, but what this test
    /// defends is the *property*, not that line.
    #[test]
    fn blame_does_not_touch_the_meta_watch_either() {
        let scratch = blame_scratch("git-blame-quiet");
        let file = scratch.join("app.ts");

        let saw = meta_events_while(&scratch.0, || {
            for _ in 0..5 {
                let raw = blame_saved(&file).unwrap().expect("blame answers");
                assert!(raw.lines().any(is_blame_header));
            }
        });

        assert!(saw.is_none(), "expected no meta-watch events from repeated blame, got {saw:?}");
    }
    /// True for a `--porcelain` per-line header: an object name, then the
    /// original and final line numbers, and on a group's first line a count.
    /// Written by hand rather than with a regex because the crate has no
    /// regex dependency, and hex-width-agnostic because a SHA-256 repository
    /// prints 64 characters where this one prints 40.
    fn is_blame_header(line: &str) -> bool {
        let mut parts = line.split(' ');
        let Some(hash) = parts.next() else { return false };
        if hash.len() < 40 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return false;
        }
        let numbers = parts.clone().count();
        (2..=3).contains(&numbers) && parts.all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
    }

    /// A repository whose one file was committed twice, the second commit
    /// touching only the middle line. That leaves the first commit owning
    /// two *separate* groups with another commit's group between them, which
    /// is the shape the header test below needs.
    /// Blame `file` with its own on-disk text, which is what the renderer
    /// sends for a buffer with no unsaved edits.
    fn blame_saved(file: &Path) -> Result<Option<String>> {
        let contents = fs::read_to_string(file).expect("the file is readable");
        nox_git_blame(as_string(file), contents)
    }

    fn blame_scratch(name: &str) -> Scratch {
        let scratch = Scratch::new(name);
        git_in(&scratch.0, &["init", "-b", "main"]);
        fs::write(scratch.join("app.ts"), "alpha\nbravo\ncharlie\n").unwrap();
        git_in(&scratch.0, &["add", "app.ts"]);
        git_in(&scratch.0, &["commit", "-m", "first"]);
        fs::write(scratch.join("app.ts"), "alpha\nBRAVO\ncharlie\n").unwrap();
        git_in(&scratch.0, &["commit", "-am", "second"]);
        scratch
    }

    #[test]
    fn blames_every_line_of_a_committed_file() {
        let scratch = blame_scratch("git-blame-lines");
        let raw = blame_saved(&scratch.join("app.ts"))
            .expect("blame does not error")
            .expect("a tracked file in a repository has blame");

        let headers: Vec<&str> = raw.lines().filter(|l| is_blame_header(l)).collect();
        assert_eq!(headers.len(), 3, "one header per line, got {headers:?}");
        // The final-line number is the third field, and it is what the
        // renderer indexes by; 1, 2, 3 in order for an unmoved file.
        let finals: Vec<&str> =
            headers.iter().map(|h| h.split(' ').nth(2).unwrap()).collect();
        assert_eq!(finals, ["1", "2", "3"]);
        assert!(raw.contains("\nsummary first\n"), "missing first summary: {raw}");
        assert!(raw.contains("\nsummary second\n"), "missing second summary: {raw}");
    }

    /// Guards the assumption `core/git-blame.ts` is built on: `--porcelain`
    /// emits a commit's metadata block **once**, and every later group from
    /// that same commit carries only the short per-line header. A parser that
    /// expected the block on every group would read those lines as having a
    /// blank author, and nothing in the TypeScript suite could catch it,
    /// because its fixtures are written to whatever shape the parser expects.
    /// This is the only place the real format is asserted.
    #[test]
    fn porcelain_states_a_commit_once_and_repeats_only_the_line_header() {
        let scratch = blame_scratch("git-blame-porcelain");
        let raw = blame_saved(&scratch.join("app.ts"))
            .expect("blame does not error")
            .expect("a tracked file in a repository has blame");

        let headers = raw.lines().filter(|l| is_blame_header(l)).count();
        // `author ` with the space: `author-mail`, `author-time` and
        // `author-tz` share the prefix and would triple the count.
        let authors = raw.lines().filter(|l| l.starts_with("author ")).count();
        assert_eq!(headers, 3, "three lines, so three headers");
        assert_eq!(authors, 2, "two commits, so two metadata blocks: {raw}");

        // And the repeat is a real repeat: line 3 is the first commit again,
        // after line 2 moved to the second. Without that the count above
        // would pass on output that never revisited a commit at all.
        let hashes: Vec<&str> = raw
            .lines()
            .filter(|l| is_blame_header(l))
            .map(|l| l.split(' ').next().unwrap())
            .collect();
        assert_eq!(hashes[0], hashes[2], "line 3 belongs to the first commit");
        assert_ne!(hashes[0], hashes[1], "line 2 belongs to the second");
    }

    /// A line edited but not committed is attributed to the all-zero object
    /// name. That sentinel is the whole basis of `BlameCommit.uncommitted`,
    /// and it is git's, not ours. Asserted here against real git so the
    /// memory platform's fake cannot quietly invent a different one.
    #[test]
    fn an_uncommitted_line_gets_the_all_zero_hash() {
        let scratch = blame_scratch("git-blame-uncommitted");
        fs::write(scratch.join("app.ts"), "alpha\nBRAVO\ncharlie\ndelta\n").unwrap();

        let raw = blame_saved(&scratch.join("app.ts"))
            .expect("blame does not error")
            .expect("a tracked file with a dirty worktree still has blame");

        let last = raw
            .lines()
            .filter(|l| is_blame_header(l))
            .last()
            .expect("a header for the added line");
        let hash = last.split(' ').next().unwrap();
        assert!(
            hash.chars().all(|c| c == '0'),
            "an uncommitted line should carry the zero object name, got {hash}"
        );
    }

    /// Absence, not an error: the same degraded state `nox_git_file_base`
    /// promises. A dialog here would fire on every file opened outside a
    /// repository.
    #[test]
    fn blame_outside_a_repository_is_none() {
        let scratch = Scratch::new("git-blame-no-repo");
        fs::write(scratch.join("loose.txt"), "alpha\n").unwrap();
        assert_eq!(blame_saved(&scratch.join("loose.txt")), Ok(None));
    }

    #[test]
    fn blame_of_an_untracked_file_is_none() {
        let scratch = blame_scratch("git-blame-untracked");
        fs::write(scratch.join("new.txt"), "alpha\n").unwrap();
        assert_eq!(blame_saved(&scratch.join("new.txt")), Ok(None));
    }

    /// The refactor that gave blame and the gutter a shared opening has to
    /// keep working for a workspace opened *below* the repository root: the
    /// case where the file's parent is not the toplevel and the relpath has
    /// more than one segment.
    #[test]
    fn blames_a_file_in_a_subdirectory() {
        let scratch = Scratch::new("git-blame-subdir");
        git_in(&scratch.0, &["init", "-b", "main"]);
        fs::create_dir_all(scratch.join("src")).unwrap();
        fs::write(scratch.join("src").join("app.ts"), "alpha\n").unwrap();
        git_in(&scratch.0, &["add", "src/app.ts"]);
        git_in(&scratch.0, &["commit", "-m", "first"]);

        let raw = blame_saved(&scratch.join("src").join("app.ts"))
            .expect("blame does not error")
            .expect("a tracked file below the root has blame");
        assert!(raw.contains("filename src/app.ts"), "missing relpath: {raw}");
    }
    /// The reason `--contents` exists in the argv at all. A buffer with an
    /// unsaved line inserted at the top is blamed *as the buffer*: the new
    /// line carries the all-zero object name at the position it actually
    /// occupies, and every line after it keeps its own commit at its shifted
    /// number. Blaming the saved file instead would attribute each of those
    /// lines to whoever wrote the one above it. An annotation naming the
    /// wrong person, which is worse than no annotation.
    #[test]
    fn an_unsaved_insertion_shifts_blame_instead_of_misattributing_it() {
        let scratch = blame_scratch("git-blame-unsaved");
        let buffer = "INSERTED\nalpha\nBRAVO\ncharlie\n".to_string();

        let raw = nox_git_blame(as_string(&scratch.join("app.ts")), buffer)
            .expect("blame does not error")
            .expect("a tracked file has blame for edited contents");

        let hashes: Vec<&str> = raw
            .lines()
            .filter(|l| is_blame_header(l))
            .map(|l| l.split(' ').next().unwrap())
            .collect();
        assert_eq!(hashes.len(), 4, "four lines in the buffer, four headers");
        assert!(
            hashes[0].chars().all(|c| c == '0'),
            "the inserted line is in no commit, got {}",
            hashes[0]
        );
        // Lines 2 and 4 are the first commit's, line 3 the second's: the
        // same attribution as before the insertion, one line further down.
        assert_eq!(hashes[1], hashes[3], "alpha and charlie share a commit");
        assert_ne!(hashes[1], hashes[2], "BRAVO belongs to the second commit");
        assert!(!hashes[1].chars().all(|c| c == '0'), "alpha is committed");
    }

    /// A document far larger than a pipe buffer round-trips. This is the
    /// case the writer thread exists for: 20,000 lines in, more than that
    /// back out, with neither side able to finish before the other starts.
    #[test]
    fn a_document_larger_than_a_pipe_buffer_round_trips() {
        let scratch = Scratch::new("git-blame-large");
        git_in(&scratch.0, &["init", "-b", "main"]);
        let body: String = (0..20_000).map(|i| format!("line {i} of the file\n")).collect();
        fs::write(scratch.join("big.txt"), &body).unwrap();
        git_in(&scratch.0, &["add", "big.txt"]);
        git_in(&scratch.0, &["commit", "-m", "first"]);

        let raw = nox_git_blame(as_string(&scratch.join("big.txt")), body)
            .expect("blame does not error")
            .expect("a large tracked file has blame");
        assert_eq!(
            raw.lines().filter(|l| is_blame_header(l)).count(),
            20_000,
            "one header per line, all the way through"
        );
    }
}

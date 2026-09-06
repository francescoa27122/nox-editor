//! Tying a child's lifetime to Nox's, for the death no hook can see.
//!
//! `RunEvent::Exit` in `lib.rs` and the renderer's `beforeunload` kill every
//! agent, language server and terminal on a clean quit, and the desktop walk
//! of 2026-09-06 watched the shell go with the app. A crash runs neither
//! hook, and a child then outlived Nox with nobody reading its pipes
//! (A7-009, the other half). The two calls here ask the OS to do the killing
//! instead, so the guarantee no longer depends on Nox being alive to keep it.
//!
//! **This is the crate's first `unsafe`**, decided on 2026-09-06 after the
//! audit left it as a question. It stays as small as the mechanisms allow:
//! one `prctl` on Linux, one job object on Windows, both behind safe
//! functions that callers cannot misuse, and both no-ops elsewhere. macOS
//! has no equivalent primitive; a shell in a pty still dies there because the
//! kernel closes the pty master with the process and the shell gets `SIGHUP`,
//! but an agent or a language server on pipes does not, and that remains a
//! Known-debt row rather than something this file pretends to cover.
//!
//! Held by `tests/child_lifetime.rs`, which stages a real parent death on
//! Linux and Windows: a middle process starts a grandchild through these two
//! calls, is killed with no chance to run a hook, and the grandchild must be
//! gone within seconds.

use std::process::{Child, Command};

/// Arrange, before the spawn, for the child to die when Nox does.
///
/// Linux: `PR_SET_PDEATHSIG` with `SIGKILL`, set in the child between fork
/// and exec. Two things about it are easy to get wrong and are handled here.
/// The signal is armed against the *thread* that forked, not the process, so
/// this must only ever be called from a thread that lives as long as Nox
/// does; every caller is a synchronous `#[tauri::command]`, which Tauri runs
/// on the main thread. And a parent that dies between the fork and the
/// `prctl` never arms it at all, which is why the child checks its parent
/// afterwards and kills itself if the parent is already gone.
///
/// Windows and macOS: nothing to do before the spawn. See `adopt`.
pub fn guard(command: &mut Command) {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;

        // SAFETY: `getpid` has no preconditions and no side effects.
        let parent = unsafe { libc::getpid() };

        // SAFETY: the closure runs in the forked child before `exec`, where
        // only async-signal-safe calls are allowed. `prctl`, `getppid` and
        // `raise` are all on that list, and the closure allocates nothing
        // and takes no locks.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // Armed too late: the parent is already someone else, so the
                // signal will never come. Behave as if it had.
                if libc::getppid() != parent {
                    libc::raise(libc::SIGKILL);
                }
                Ok(())
            });
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = command;
    }
}

/// Tie an already-spawned child to Nox's lifetime.
///
/// Windows: the child joins a job object created once per process with
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The job's handle is deliberately
/// never closed by Nox: the kernel closes every handle a dying process holds,
/// and closing this one is what kills the job's members. A crash is therefore
/// exactly the path that works, with no code of Nox's needing to run.
///
/// Linux and macOS: nothing to do after the spawn. See `guard`.
pub fn adopt(child: &Child) {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        job::assign(child.as_raw_handle().cast());
    }
    #[cfg(not(windows))]
    {
        let _ = child;
    }
}

/// `adopt`, for a child known only by its process id: a terminal's shell,
/// which `portable-pty` spawns and hands back without a `Child`.
///
/// Windows only, as `adopt` is. On Linux and macOS a shell in a pty needs no
/// help: the kernel closes the pty master when Nox dies and the shell reads
/// that as a hangup.
pub fn adopt_pid(pid: u32) {
    #[cfg(windows)]
    {
        job::assign_pid(pid);
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
    }
}

#[cfg(windows)]
mod job {
    use std::ffi::c_void;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    /// The one job object, as an integer because a raw pointer is not `Sync`
    /// and the handle is only ever passed straight back to the API. Zero
    /// means creation failed, in which case every assignment is skipped and
    /// children are exactly as unprotected as they were before this module.
    static JOB: OnceLock<usize> = OnceLock::new();

    fn handle() -> HANDLE {
        let raw = *JOB.get_or_init(|| {
            // SAFETY: plain Win32 calls with valid arguments. A null security
            // descriptor and a null name are the documented defaults, the
            // limit struct is fully initialised (zeroed, then one field set)
            // and its size is passed with it, and a job that cannot be
            // configured is closed rather than leaked.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return 0;
                }
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let set = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if set == 0 {
                    CloseHandle(job);
                    return 0;
                }
                job as usize
            }
        });
        raw as HANDLE
    }

    /// Put a process into the job. Best effort: a process already in a job
    /// that forbids nesting, or one that has exited, is left alone.
    pub fn assign(process: HANDLE) {
        let job = handle();
        if job.is_null() || process.is_null() {
            return;
        }
        // SAFETY: both handles are valid for the duration of the call; the
        // child's is owned by the `Child` the caller still holds.
        unsafe {
            AssignProcessToJobObject(job, process);
        }
    }

    pub fn assign_pid(pid: u32) {
        // SAFETY: `OpenProcess` with the two rights `AssignProcessToJobObject`
        // requires; a null result is checked, and the handle this opens is
        // closed here, on every path.
        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                return;
            }
            assign(process);
            CloseHandle(process);
        }
    }
}

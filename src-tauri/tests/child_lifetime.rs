//! A child Nox started must not outlive a Nox that dies without warning.
//!
//! `RunEvent::Exit` and the renderer's `beforeunload` both kill every agent,
//! language server and terminal on a clean quit, and the desktop walk of
//! 2026-09-06 saw the shell go with the app. Neither hook runs on a crash,
//! and a crashed Nox used to leave its children running with nobody
//! listening (A7-009, the other half). This is the test that only a real
//! parent death can answer, so it stages one.
//!
//! Three processes. This test spawns a **middle** process, which is this same
//! test binary re-entered on the ignored `middle_process` case below. The
//! middle process starts a **grandchild** through `nox_lib::lifetime`, exactly
//! as `agent.rs` and `lsp.rs` do, prints the grandchild's pid, and then hangs.
//! This test then kills the middle process the hard way, with no chance to
//! run a hook, and asserts the grandchild is gone within a few seconds.
//!
//! Linux and Windows only: those are the two platforms with a mechanism
//! (`PR_SET_PDEATHSIG` and a kill-on-close job object). macOS has neither, and
//! a test that can only ever fail there would teach people to ignore it.
//! CI's Linux and Windows legs are where this runs; on a Mac it compiles to
//! nothing.
#![cfg(any(target_os = "linux", windows))]

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

/// Whether a process with this id exists and is not a corpse waiting to be
/// reaped. Asked through the OS's own tools rather than a raw syscall so the
/// test's answer does not share a mechanism with the code under test.
fn alive(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        // A zombie still has a /proc entry; its state field reads `Z`. The
        // grandchild is reparented to init once the middle process dies, and
        // init reaps promptly, but "promptly" is not "already".
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => {
                let after_comm = stat.rsplit(')').next().unwrap_or("");
                !after_comm.trim_start().starts_with('Z')
            }
            Err(_) => false,
        }
    }
    #[cfg(windows)]
    {
        let output = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .expect("tasklist runs on every Windows");
        String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
    }
}

#[test]
fn a_guarded_child_dies_with_the_process_that_started_it() {
    let exe = std::env::current_exe().expect("the test binary knows its own path");
    let mut middle = Command::new(exe)
        .args(["--exact", "middle_process", "--ignored", "--nocapture"])
        .env("NOX_LIFETIME_ROLE", "middle")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the test binary re-enters as the middle process");

    let stdout = middle.stdout.take().expect("piped");
    let mut lines = BufReader::new(stdout).lines();
    let grandchild: u32 = loop {
        let line = lines
            .next()
            .expect("the middle process prints the grandchild's pid before it hangs")
            .expect("readable");
        if let Some(rest) = line.strip_prefix("grandchild=") {
            break rest.trim().parse().expect("a pid");
        }
    };
    assert!(alive(grandchild), "the grandchild should be running before the parent dies");

    // `kill` is SIGKILL on unix and TerminateProcess on Windows: no signal
    // handler, no atexit, no drop. That is what a crash looks like from the
    // outside, and it is the case the exit hooks cannot cover.
    middle.kill().expect("the middle process can be killed");
    let _ = middle.wait();

    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(grandchild) && Instant::now() < deadline {
        sleep(Duration::from_millis(100));
    }
    assert!(
        !alive(grandchild),
        "grandchild {grandchild} outlived the process that started it"
    );
}

/// The middle process. Never runs as a test on its own: it is `#[ignore]`d
/// and returns at once without the role variable, and is only ever reached by
/// the case above re-invoking this binary with `--ignored`.
#[test]
#[ignore]
fn middle_process() {
    if std::env::var("NOX_LIFETIME_ROLE").as_deref() != Ok("middle") {
        return;
    }

    let mut command = Command::new(if cfg!(windows) { "ping" } else { "sleep" });
    if cfg!(windows) {
        command.args(["-n", "600", "127.0.0.1"]);
    } else {
        command.arg("600");
    }
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());

    // The two calls under test, in the order the app makes them.
    nox_lib::lifetime::guard(&mut command);
    let mut child = command.spawn().expect("sleep or ping exists everywhere");
    nox_lib::lifetime::adopt(&child);

    println!("grandchild={}", child.id());

    // Wait on the grandchild, which is ten minutes of sleep: the parent is
    // alive and idle, then killed mid-wait. Waiting rather than looping is
    // also what clippy's `zombie_processes` asks for.
    let _ = child.wait();
}

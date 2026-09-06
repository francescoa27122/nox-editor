//! Tying a child's lifetime to Nox's, for the death no hook can see.
//!
//! `RunEvent::Exit` in `lib.rs` and the renderer's `beforeunload` kill every
//! agent, language server and terminal on a clean quit. A crash runs
//! neither, and a child then outlived Nox with nobody reading its pipes
//! (A7-009). The two functions here ask the OS to do the killing instead, so
//! the guarantee no longer depends on Nox being alive to keep it.
//!
//! Nothing here is implemented yet: both calls are no-ops, and
//! `tests/child_lifetime.rs` is the failing test that says so.

use std::process::{Child, Command};

/// Arrange, before the spawn, for the child to die when Nox does.
pub fn guard(command: &mut Command) {
    let _ = command;
}

/// Tie an already-spawned child to Nox's lifetime.
pub fn adopt(child: &Child) {
    let _ = child;
}

/// `adopt`, for a child known only by its process id.
pub fn adopt_pid(pid: u32) {
    let _ = pid;
}

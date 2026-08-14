//! Supervision of external agent processes.
//!
//! Nox talks to an agent over its stdin and stdout, one JSON object per line.
//! This module owns nothing about the protocol itself — it moves lines, starts
//! processes and stops them. What those lines mean is decided in the renderer,
//! in `services/agent/`, which is where it can be unit-tested against a fake
//! process instead of a real one.
//!
//! Line-delimited JSON rather than a length-prefixed framing like LSP's: an
//! agent is very often a script someone wrote in an afternoon, and `print(...)`
//! in a loop should be enough to speak it.
//!
//! Starting a process is the single most powerful thing Nox can do on someone's
//! behalf. It is deliberately not reachable from the agent protocol — an agent
//! cannot spawn another agent. Only the user, through configuration, can.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

pub type Result<T> = std::result::Result<T, String>;

#[derive(Default)]
pub struct AgentState(Mutex<HashMap<String, Running>>);

struct Running {
    child: Arc<Mutex<Child>>,
    stdin: ChildStdin,
}

#[derive(Clone, Serialize)]
struct LinePayload {
    id: String,
    line: String,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    id: String,
    code: Option<i32>,
}

/// Start an agent. `id` is chosen by the renderer so replies can be matched
/// without a round trip to learn what the process was called.
#[tauri::command]
pub fn nox_agent_spawn(
    app: AppHandle,
    state: State<'_, AgentState>,
    id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<()> {
    if state.0.lock().map_err(poisoned)?.contains_key(&id) {
        return Err(format!("exists: an agent with id {id} is already running"));
    }

    let mut builder = Command::new(&command);
    builder
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(directory) = cwd {
        builder.current_dir(directory);
    }

    let mut child = builder
        .spawn()
        .map_err(|e| format!("spawn: could not start {command} ({e})"))?;

    let streams = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let (Some(stdin), Some(stdout), Some(stderr)) = streams else {
        let _ = child.kill();
        return Err(format!("spawn: {command} did not give Nox its pipes"));
    };

    let child = Arc::new(Mutex::new(child));

    // stdout: one line, one message.
    {
        let app = app.clone();
        let id = id.clone();
        let child = Arc::clone(&child);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                // A failed emit means the window is gone; nothing to recover.
                if app
                    .emit(
                        "nox://agent-line",
                        LinePayload {
                            id: id.clone(),
                            line,
                        },
                    )
                    .is_err()
                {
                    break;
                }
            }

            // stdout closing is the earliest reliable sign the agent is done.
            // Reaping here also stops the child becoming a zombie when nobody
            // calls `kill`.
            let code = child
                .lock()
                .ok()
                .and_then(|mut child| child.wait().ok())
                .and_then(|status| status.code());

            // Forget it, or the id stays registered for the life of the app
            // and spawning under it again is refused as "already running" —
            // which is exactly what happens after the window reloads and the
            // renderer's counter starts over.
            if let Some(state) = app.try_state::<AgentState>() {
                if let Ok(mut agents) = state.0.lock() {
                    agents.remove(&id);
                }
            }

            let _ = app.emit("nox://agent-exit", ExitPayload { id, code });
        });
    }

    // stderr is diagnostics, not protocol. It is forwarded under its own event
    // so a crashing agent says *why* instead of just disappearing.
    {
        let app = app.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                let _ = app.emit(
                    "nox://agent-stderr",
                    LinePayload {
                        id: id.clone(),
                        line,
                    },
                );
            }
        });
    }

    state
        .0
        .lock()
        .map_err(poisoned)?
        .insert(id, Running { child, stdin });
    Ok(())
}

/// Send one line to an agent's stdin. The newline is added here so a caller
/// cannot half-send a message by forgetting it.
#[tauri::command]
pub fn nox_agent_send(state: State<'_, AgentState>, id: String, line: String) -> Result<()> {
    let mut agents = state.0.lock().map_err(poisoned)?;
    let Some(agent) = agents.get_mut(&id) else {
        return Err(format!("not-found: no agent {id}"));
    };

    agent
        .stdin
        .write_all(line.as_bytes())
        .and_then(|_| agent.stdin.write_all(b"\n"))
        .and_then(|_| agent.stdin.flush())
        .map_err(|e| format!("io: could not write to agent {id} ({e})"))
}

/// Stop an agent and forget it. Safe to call on one that has already exited.
#[tauri::command]
pub fn nox_agent_kill(state: State<'_, AgentState>, id: String) -> Result<()> {
    let Some(agent) = state.0.lock().map_err(poisoned)?.remove(&id) else {
        return Ok(());
    };

    // Dropping stdin closes it, which is how a well-behaved agent is asked to
    // stop. The kill is for the ones that are not.
    drop(agent.stdin);
    if let Ok(mut child) = agent.child.lock() {
        let _ = child.kill();
    }
    Ok(())
}

/// Stop every agent. Called when the window goes away, so a reload does not
/// leave orphans running with nothing left to talk to them.
#[tauri::command]
pub fn nox_agent_kill_all(state: State<'_, AgentState>) -> Result<()> {
    let agents: Vec<Running> = state
        .0
        .lock()
        .map_err(poisoned)?
        .drain()
        .map(|(_, agent)| agent)
        .collect();

    for agent in agents {
        drop(agent.stdin);
        if let Ok(mut child) = agent.child.lock() {
            let _ = child.kill();
        }
    }
    Ok(())
}

fn poisoned<T>(_: T) -> String {
    "io: agent registry is poisoned".to_string()
}

#!/usr/bin/env node
/**
 * A Nox agent that delegates its thinking to something else.
 *
 * `examples/uppercase-agent.mjs` is the protocol with no brain behind it.
 * This one is the opposite: no task of its own, and a seam where an external
 * brain plugs in — an MCP server, a coding CLI run as a subprocess, a hosted
 * API, a shell script. Nox does not care which, because none of them are
 * visible from here: the whole of it lives behind `think()`.
 *
 *   node examples/orchestrator-agent.mjs                     # nothing wired
 *   node examples/orchestrator-agent.mjs ./my-orchestrator.mjs
 *
 * The module named on the command line default-exports
 * `(instruction, context, opened, read) => plan`.
 *
 * The thing worth reading is not the delegation, it is the boundary. An
 * orchestrator built to drive a coding agent expects to hold the pen — it
 * writes files, runs git, spawns workers. Under Nox it does none of that. It
 * reads through `context.*`, and everything it wants changed comes back as a
 * proposal the user applies themselves. An adapter that shells out to write a
 * file instead has stepped around the permission model, the transaction log
 * and the one-button undo, and the session record it leaves behind is a lie.
 *
 * Register it in `agents.json` (Configure Agents opens it):
 *
 *   { "id": "orchestrator", "label": "Orchestrator", "command": "node",
 *     "args": ["/absolute/path/to/examples/orchestrator-agent.mjs",
 *              "/absolute/path/to/my-orchestrator.mjs"] }
 */

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const PROTOCOL_VERSION = 1;

const say = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
/** stderr is for the human; Nox keeps the last lines to explain a crash. */
const log = (text) => process.stderr.write(`[orchestrator] ${text}\n`);

// --- Request/response plumbing ---------------------------------------------

let nextId = 1;
const waiting = new Map();

function ask(method, params) {
  const id = nextId++;
  say({ type: 'request', request: params === undefined ? { id, method } : { id, method, params } });
  return new Promise((resolve) => waiting.set(id, resolve));
}

/** Throws on a refusal, so the happy path below reads as a straight line. */
async function demand(method, params) {
  const response = await ask(method, params);
  if (!response.ok) throw new Error(`${method}: ${response.error.code} — ${response.error.message}`);
  return response.result;
}

/** What an orchestrator is handed: reads, and the one verb with no effect. */
const READ_PREFIX = 'context.';
const READ_ALSO = new Set(['session.note']);

/**
 * The orchestrator's view of the protocol. Handing it `demand` itself would
 * make the boundary this file is about a matter of politeness — `demand`
 * takes any method, `command.execute` included. Refusing here is what makes
 * "it reads, and returns a plan" a fact rather than a comment.
 */
async function reading(method, params) {
  if (!method.startsWith(READ_PREFIX) && !READ_ALSO.has(method)) {
    throw new Error(`the orchestrator may not call ${method} — it reads, and returns a plan`);
  }
  return demand(method, params);
}

// --- The seam ---------------------------------------------------------------

/**
 * Load the orchestrator named on the command line, or a stub that proposes
 * nothing. The stub is not a placeholder to be embarrassed about: an agent
 * that reaches the end with nothing to say is a real outcome, and it is the
 * one this file produces until somebody wires a brain in.
 */
async function loadThink() {
  const target = process.argv[2];
  if (!target) {
    return async () => ({
      edits: [],
      summary: 'No orchestrator is wired in, so there was nothing to propose.',
    });
  }
  const module = await import(pathToFileURL(target).href);
  const think = module.default;
  if (typeof think !== 'function') throw new Error(`${target} does not default-export a function`);
  return think;
}

// --- The run ----------------------------------------------------------------

async function run(instruction, context, think) {
  await demand('session.note', { text: 'Handing the task to the orchestrator' });

  // One listing, taken up front, and its revisions are what the proposal
  // declares. An orchestrator that thinks for thirty seconds thinks against
  // this snapshot while the user goes on typing, and Nox refusing the stage
  // as `stale` is the correct end to that — not something to route around by
  // re-reading until it passes. It is handed to `think` rather than left for
  // it to fetch: offsets computed against a second, fresher listing while
  // this one is declared would describe a check nobody made.
  const opened = await demand('context.openBuffers');
  const revisions = new Map(opened.map((buffer) => [buffer.id, buffer.revision]));

  const plan = await think(instruction, context, opened, reading);
  const edits = plan?.edits ?? [];

  if (edits.length === 0) {
    await demand('session.summary', { text: plan?.summary ?? 'The orchestrator proposed nothing.' });
    return;
  }

  // Declare revisions only for the buffers this plan touches. A spare entry
  // is not free — `workspace.apply` checks every one of them, so naming a
  // buffer nothing edits turns an unrelated keystroke into a refusal of work
  // that was still good.
  const baseRevisions = {};
  for (const edit of edits) {
    if (!revisions.has(edit.bufferId)) {
      throw new Error(`the orchestrator named a buffer that is not open: ${edit.bufferId}`);
    }
    baseRevisions[edit.bufferId] = revisions.get(edit.bufferId);
  }

  await demand('proposal.stage', {
    description: plan.description ?? instruction,
    edits,
    baseRevisions,
  });

  await demand('session.summary', {
    text: plan.summary ?? `${edits.length} edit(s) proposed. Review them and apply what you want.`,
  });
}

// --- Wire up ----------------------------------------------------------------

const thinking = loadThink();

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    log(`ignoring a line that is not JSON: ${line.slice(0, 80)}`);
    return;
  }

  switch (message.type) {
    case 'run':
      thinking
        .then((think) => run(message.instruction, message.context, think))
        .catch((error) => {
          log(`failed: ${error.message}`);
          say({
            type: 'request',
            request: { id: nextId++, method: 'session.note', params: { text: `Failed: ${error.message}` } },
          });
        })
        // `done` is how a well-behaved agent ends a run. Exiting also works,
        // but saying so lets Nox stop waiting immediately.
        .finally(() => say({ type: 'done' }));
      return;

    case 'response': {
      const resolve = waiting.get(message.response.id);
      if (resolve) {
        waiting.delete(message.response.id);
        resolve(message.response);
      }
      return;
    }

    case 'cancel':
      log('cancelled');
      process.exit(0);
      return;

    default:
      log(`unknown message type "${message.type}"`);
  }
});

// Introduce ourselves first; Nox will not send `run` until we do.
say({ type: 'hello', version: PROTOCOL_VERSION, label: 'Orchestrator' });
log('ready');

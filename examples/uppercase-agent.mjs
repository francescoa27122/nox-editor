#!/usr/bin/env node
/**
 * A worked example of a Nox agent.
 *
 * It is a plain program. It reads JSON lines on stdin, writes JSON lines on
 * stdout, and never touches the filesystem — everything it wants changed goes
 * back as a proposal for the user to review. That is the whole contract; there
 * is no SDK to install and no model involved.
 *
 * What it does: finds the active file, reads its first line, and proposes
 * uppercasing it. Deliberately trivial, so what you are reading is the
 * protocol rather than the task.
 *
 *   node examples/uppercase-agent.mjs
 *
 * Register it by putting this in `agents.json` (Configure Agents opens it):
 *
 *   { "id": "uppercase", "label": "Uppercase", "command": "node",
 *     "args": ["/absolute/path/to/examples/uppercase-agent.mjs"] }
 */

import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = 1;

const say = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
/** stderr is for the human; Nox keeps the last lines to explain a crash. */
const log = (text) => process.stderr.write(`[uppercase] ${text}\n`);

// --- Request/response plumbing ---------------------------------------------

let nextId = 1;
const waiting = new Map();

/** Send a request and resolve with the response Nox sends back. */
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

// --- The work itself --------------------------------------------------------

async function run(instruction, context) {
  log(`instruction: ${instruction}`);
  log(`context:\n${context}`);

  await demand('session.note', { text: 'Looking for the file you are in' });

  const buffers = await demand('context.openBuffers');
  const target = buffers.find((buffer) => buffer.isActive) ?? buffers[0];
  if (!target) {
    await demand('session.summary', { text: 'Nothing is open, so there was nothing to do.' });
    return;
  }

  // Read *then* decide: the response to each request comes back before the
  // next one is sent, which is the point of the protocol being two-way.
  const firstLine = await demand('context.bufferText', {
    bufferId: target.id,
    lines: { from: 1, to: 1 },
  });

  if (firstLine.trim().length === 0 || firstLine === firstLine.toUpperCase()) {
    await demand('session.summary', {
      text: `The first line of ${target.name} is already uppercase — nothing proposed.`,
    });
    return;
  }

  await demand('session.note', { text: `Proposing a change to ${target.name}` });

  // Offsets are into the document, and the first line starts at 0.
  await demand('proposal.stage', {
    description: `Uppercase the first line of ${target.name}`,
    edits: [
      {
        bufferId: target.id,
        changes: { from: 0, to: firstLine.length, insert: firstLine.toUpperCase() },
      },
    ],
  });

  await demand('session.summary', {
    text: `Proposed uppercasing line 1 of ${target.name}. Review it and apply what you want.`,
  });
}

// --- Wire up ----------------------------------------------------------------

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
      run(message.instruction, message.context)
        .catch((error) => {
          log(`failed: ${error.message}`);
          say({ type: 'request', request: { id: nextId++, method: 'session.note', params: { text: `Failed: ${error.message}` } } });
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
say({ type: 'hello', version: PROTOCOL_VERSION, label: 'Uppercase' });
log('ready');

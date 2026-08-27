/**
 * Decorations: marks in the editor, and the one event a plugin gets.
 *
 * Copy this folder into `<config>/plugins/` and run **Reload Plugins**. Then
 * open a file with a `TODO` in it and run **TODOs: Mark TODOs in This File**.
 * Each `TODO` gets a wavy underline; hover one for the message.
 *
 * **A plugin does not choose how a mark looks.** It picks a `kind` — `error`,
 * `warning`, `info` or `highlight` — and Nox decides what that is drawn as.
 * The same split makes panels rows rather than markup: a plugin says what it
 * *means*, and the editor stays the editor's.
 *
 * **Then the interesting part.** Once a plugin has decorated a buffer, Nox
 * sends `document.changed` for that buffer — debounced, after the typing
 * stops, and only for buffers this plugin has already decorated. It is the
 * only event a plugin gets, and it is deliberately not a keystroke feed: a
 * plugin woken on every character is the thing out-of-process exists to
 * prevent. So the loop is: decorate, get told it changed, decorate again.
 *
 * Offsets are into the buffer's text, and they can go stale between reading
 * and sending. Nox clamps anything past the end rather than throwing, and
 * carries existing marks forward through edits, so a mark stays over its text
 * while you type and is corrected on the next pass.
 */

const PROTOCOL_VERSION = 1;
const PATTERN = /TODO|FIXME|XXX/g;

let nextId = 1;
const waiting = new Map();

function ask(method, params) {
  const id = nextId++;
  nox.send(params === undefined ? { id, method } : { id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

/** Find the markers in one buffer and ask for a mark over each. */
async function markTodos(bufferId) {
  const answer = await ask('context.bufferText', { bufferId });
  const text = answer.ok ? answer.result : '';

  const ranges = [];
  PATTERN.lastIndex = 0;
  for (let match = PATTERN.exec(text); match !== null; match = PATTERN.exec(text)) {
    ranges.push({
      from: match.index,
      to: match.index + match[0].length,
      kind: 'warning',
      message: `${match[0]} left in the code`,
    });
  }

  // An empty list is how a plugin takes its own marks back, so this both
  // adds and clears without needing two paths.
  await ask('editor.decorate', { bufferId, ranges });
}

/** The buffer the user is looking at, or null. */
async function activeBuffer() {
  const answer = await ask('context.openBuffers');
  return (answer.result ?? [])[0]?.id ?? null;
}

nox.onRequest(async (message) => {
  if ('ok' in message) {
    const resolve = waiting.get(message.id);
    if (resolve) {
      waiting.delete(message.id);
      resolve(message);
    }
    return;
  }

  // The buffer changed and has been quiet since. Re-scan it, which is what
  // keeps the marks true rather than merely carried forward.
  if (message.method === 'document.changed') {
    await markTodos(message.params.bufferId);
    nox.send({ id: message.id, ok: true });
    return;
  }

  if (message.method === 'command.invoke' && message.params.name === 'mark') {
    const bufferId = await activeBuffer();
    if (bufferId) await markTodos(bufferId);
    nox.send({ id: message.id, ok: true });
    return;
  }

  nox.send({
    id: message.id,
    ok: false,
    error: { code: 'unknown-method', message: 'not something this plugin does' },
  });
});

nox.send({ id: 0, method: 'hello', params: { version: PROTOCOL_VERSION, label: 'TODOs' } });
